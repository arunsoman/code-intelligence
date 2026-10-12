//! Concept-hierarchy motif matching, offloaded from TypeScript (plan §0.6).
//!
//! The reference implementation is `packages/core/src/concept-hierarchy/motifs.ts`; this port must
//! match it occurrence-for-occurrence — order of matches, order of nodes in evidence, bound variable
//! names — because the fixture vectors (shared by `cargo test` and `node --test`) pin both runtimes,
//! exactly as the canon module does. The three JS quirks the port preserves deliberately:
//!   1. every lookup/`find` walks arrays in insertion order (edges first-seen wins),
//!   2. `n.name ?? "resource"` keeps an empty-string name (nullish, not falsy), while truthiness
//!      checks (`!n.name`) skip empty names,
//!   3. `t.at > pdg.nodes.length / 2` compares against a *float* half.
//! The TypeScript compiler stays authoritative for building the graphs themselves (pdg.ts); the
//! worker consumes their JSON and does the per-function, per-pattern scans for the whole repo.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdgNode {
    pub id: String,
    pub kind: String,
    pub name: Option<String>,
    pub op: Option<String>,
    #[serde(default)]
    pub dynamic_write: bool,
    pub at: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdgEdge {
    pub from: String,
    pub to: String,
    pub kind: String,
}

/// Only the graph fields matter to the matchers; the TS side keeps entityId authority.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pdg {
    pub entity_id: String,
    pub graph_hash: Option<String>,
    pub nodes: Vec<PdgNode>,
    pub edges: Vec<PdgEdge>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct MotifMatch {
    pub motif: &'static str,
    pub nodes: Vec<String>,
    pub binds: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdgMatches {
    pub entity_id: String,
    pub matches: Vec<MotifMatch>,
}

#[derive(Serialize)]
pub struct MotifBatch {
    pub results: Vec<PdgMatches>,
}

/// Compile-once matchers state: id → node index maps, and prebuilt regexes.
struct Ctx<'a> {
    nodes: &'a [PdgNode],
    edges: &'a [PdgEdge],
    by_id: HashMap<&'a str, usize>,
    in_edges: HashMap<&'a str, Vec<usize>>,
    out_edges: HashMap<&'a str, Vec<usize>>,
    retry_re: regex::Regex,
    flag_re: regex::Regex,
}

impl<'a> Ctx<'a> {
    fn new(nodes: &'a [PdgNode], edges: &'a [PdgEdge]) -> Self {
        let mut by_id = HashMap::with_capacity(nodes.len());
        let mut in_edges: HashMap<&str, Vec<usize>> = HashMap::new();
        let mut out_edges: HashMap<&str, Vec<usize>> = HashMap::new();
        for (i, n) in nodes.iter().enumerate() {
            by_id.insert(n.id.as_str(), i);
        }
        for (i, e) in edges.iter().enumerate() {
            out_edges.entry(e.from.as_str()).or_default().push(i);
            in_edges.entry(e.to.as_str()).or_default().push(i);
        }
        Ctx {
            nodes,
            edges,
            by_id,
            in_edges,
            out_edges,
            retry_re: regex::Regex::new("(?i)(retr|attempt|tries|attempt)").unwrap(),
            flag_re: regex::Regex::new("^(is|has|should|can|needs)[A-Z_]").unwrap(),
        }
    }

    fn node(&self, id: &str) -> Option<&'a PdgNode> {
        self.by_id.get(id).map(|&i| &self.nodes[i])
    }

    /// Guard sources feeding a node, in edge insertion order (JS `guardedBy`).
    fn guards(&self, id: &str) -> Vec<&'a str> {
        self.in_edges
            .get(id)
            .map(|idxs| {
                idxs.iter()
                    .filter(|&&ei| self.edges[ei].kind == "guard")
                    .map(|&ei| self.edges[ei].from.as_str())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Incoming `data` edges in insertion order.
    fn data_inputs(&self, id: &str) -> Vec<&'a PdgEdge> {
        self.in_edges
            .get(id)
            .map(|idxs| {
                idxs.iter()
                    .filter(|&&ei| self.edges[ei].kind == "data")
                    .map(|&ei| &self.edges[ei])
                    .collect()
            })
            .unwrap_or_default()
    }

    /// TS `resolveDef`: a use resolves to the def that feeds it (one hop, first data edge wins); a def resolves to itself.
    fn resolve_def(&self, id: &str) -> Option<&'a PdgNode> {
        let n = self.node(id)?;
        if n.kind == "def" {
            return Some(n);
        }
        if n.kind == "use" {
            let feed = self.edges.iter().find(|e| e.kind == "data" && e.to == id)?;
            return self.node(&feed.from);
        }
        None
    }
}

fn m(motif: &'static str, nodes: Vec<String>, binds: &[(&str, String)]) -> MotifMatch {
    MotifMatch {
        motif,
        nodes,
        binds: binds
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect(),
    }
}

fn name_of(n: &PdgNode) -> Option<&str> {
    match &n.name {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    }
}

/// 1. guarded-write: a variable is written inside a conditional region.
fn guarded_write(c: &Ctx) -> Vec<MotifMatch> {
    let mut out = Vec::new();
    for n in c.nodes {
        let name = match name_of(n) {
            Some(v) if n.kind == "def" => v,
            _ => continue,
        };
        // first guard edge whose source is a branch (edge order)
        if let Some(g) = c.edges.iter().find(|e| {
            e.to == n.id
                && e.kind == "guard"
                && c.node(&e.from).map(|x| x.kind == "branch").unwrap_or(false)
        }) {
            out.push(m(
                "guarded-write",
                vec![g.from.clone(), n.id.clone()],
                &[("var", name.to_string())],
            ));
        }
    }
    out
}

/// 2. loop-accumulate: a variable's own value feeds its next value.
fn loop_accumulate(c: &Ctx) -> Vec<MotifMatch> {
    let mut out = Vec::new();
    for n in c.nodes {
        let name = match name_of(n) {
            Some(v) if n.kind == "def" && n.op.is_some() => v,
            _ => continue,
        };
        let self_fed = c.data_inputs(&n.id).iter().any(|e| {
            c.node(&e.from)
                .map(|f| f.kind == "use" && f.name.as_deref() == Some(name))
                .unwrap_or(false)
        });
        if self_fed {
            out.push(m(
                "loop-accumulate",
                vec![n.id.clone()],
                &[("var", name.to_string())],
            ));
        }
    }
    out
}

/// 3. resource-acquire-release: an acquire lexicon call with a release lexicon call after it.
fn resource_acquire_release(c: &Ctx) -> Vec<MotifMatch> {
    let acq: Vec<&PdgNode> = c.nodes.iter().filter(|n| n.kind == "acquire").collect();
    let rel: Vec<&PdgNode> = c.nodes.iter().filter(|n| n.kind == "release").collect();
    let mut out = Vec::new();
    for a in acq {
        if let Some(after) = rel.iter().find(|r| r.at > a.at) {
            let resource = a.name.clone().unwrap_or_else(|| "resource".to_string()); // `??`, keeps ""
            out.push(m(
                "resource-acquire-release",
                vec![a.id.clone(), after.id.clone()],
                &[("resource", resource)],
            ));
        }
    }
    out
}

/// 4. retry-loop: a self-fed counter named like an attempt counter, with a call under the same guard.
fn retry_loop(c: &Ctx) -> Vec<MotifMatch> {
    let mut out = Vec::new();
    for n in c.nodes {
        let name = match name_of(n) {
            Some(v) if n.kind == "def" => v,
            _ => continue,
        };
        if !c.retry_re.is_match(name) {
            continue;
        }
        let self_fed = c.data_inputs(&n.id).iter().any(|e| {
            c.node(&e.from)
                .map(|f| f.kind == "use" && f.name.as_deref() == Some(name))
                .unwrap_or(false)
        });
        if !self_fed {
            continue;
        }
        let guards = c.guards(&n.id);
        let has_call = c.nodes.iter().any(|call| {
            call.kind == "call" && c.guards(&call.id).iter().any(|g| guards.contains(g))
        });
        if has_call {
            out.push(m(
                "retry-loop",
                vec![n.id.clone()],
                &[("var", name.to_string())],
            ));
        }
    }
    out
}

/// 5. early-exit-guard: a branch guarding a return or throw in the first half of the function.
fn early_exit_guard(c: &Ctx) -> Vec<MotifMatch> {
    let mut out = Vec::new();
    let half = c.nodes.len() as f64 / 2.0;
    for t in c.nodes {
        if t.kind != "return" && t.kind != "throw" {
            continue;
        }
        if t.at > half {
            continue;
        }
        if let Some(g) = c.edges.iter().find(|e| {
            e.to == t.id
                && e.kind == "guard"
                && c.node(&e.from).map(|x| x.kind == "branch").unwrap_or(false)
        }) {
            out.push(m(
                "early-exit-guard",
                vec![g.from.clone(), t.id.clone()],
                &[],
            ));
        }
    }
    out
}

/// 6. fan-out-dispatch: one branch guarding calls to two or more distinct callees.
fn fan_out_dispatch(c: &Ctx) -> Vec<MotifMatch> {
    let mut out = Vec::new();
    for b in c.nodes {
        if b.kind != "branch" {
            continue;
        }
        let guarded: Vec<&PdgNode> = c
            .nodes
            .iter()
            .filter(|n| n.kind == "call" && c.guards(&n.id).contains(&b.id.as_str()))
            .collect();
        let names: HashSet<&str> = guarded
            .iter()
            .map(|x| x.name.as_deref().unwrap_or("?"))
            .collect();
        if names.len() >= 2 {
            out.push(m(
                "fan-out-dispatch",
                std::iter::once(b.id.clone())
                    .chain(guarded.iter().map(|x| x.id.clone()))
                    .collect(),
                &[],
            ));
        }
    }
    out
}

/// 7. collect-and-return: a local's value reaches the returned value.
fn collect_and_return(c: &Ctx) -> Vec<MotifMatch> {
    let mut out = Vec::new();
    for r in c.nodes {
        if r.kind != "return" {
            continue;
        }
        for f in c.data_inputs(&r.id) {
            if let Some(d) = c.resolve_def(&f.from) {
                if let Some(name) = name_of(d).filter(|_| d.kind == "def") {
                    out.push(m(
                        "collect-and-return",
                        vec![d.id.clone(), r.id.clone()],
                        &[("var", name.to_string())],
                    ));
                }
            }
        }
    }
    out
}

/// 8. wrap-rethrow: a throw whose value is built by a call.
fn wrap_rethrow(c: &Ctx) -> Vec<MotifMatch> {
    let mut out = Vec::new();
    for t in c.nodes {
        if t.kind != "throw" {
            continue;
        }
        if let Some(f) = c
            .data_inputs(&t.id)
            .iter()
            .map(|e| c.node(&e.from))
            .find(|n| n.map(|x| x.kind == "call").unwrap_or(false))
            .flatten()
        {
            let wrapper = f.name.clone().unwrap_or_else(|| "error".to_string());
            out.push(m(
                "wrap-rethrow",
                vec![f.id.clone(), t.id.clone()],
                &[("wrapper", wrapper)],
            ));
        }
    }
    out
}

/// 9. flag-guard: a boolean-named local is written, and a branch appears later in the function.
fn flag_guard(c: &Ctx) -> Vec<MotifMatch> {
    let mut out = Vec::new();
    let flags: Vec<&PdgNode> = c
        .nodes
        .iter()
        .filter(|n| n.kind == "def" && c.flag_re.is_match(name_of(n).unwrap_or("")))
        .collect();
    for f in flags {
        let fname = name_of(f).unwrap_or("");
        if let Some(later) = c.nodes.iter().find(|n| n.kind == "branch" && n.at > f.at) {
            out.push(m(
                "flag-guard",
                vec![f.id.clone(), later.id.clone()],
                &[("var", fname.to_string())],
            ));
        }
    }
    out
}

/// 10. null-check-fallback: a branch on a call-derived variable, with a different variable written under it.
fn null_check_fallback(c: &Ctx) -> Vec<MotifMatch> {
    let mut out = Vec::new();
    for b in c.nodes {
        if b.kind != "branch" {
            continue;
        }
        let bname = match name_of(b) {
            Some(v) => v,
            None => continue,
        };
        let from_call = c
            .data_inputs(&b.id)
            .iter()
            .any(|e| match c.resolve_def(&e.from) {
                Some(d) if d.kind == "def" => c
                    .data_inputs(&d.id)
                    .iter()
                    .any(|e2| c.node(&e2.from).map(|x| x.kind == "call").unwrap_or(false)),
                _ => false,
            });
        if !from_call {
            continue;
        }
        if let Some(def) = c.nodes.iter().find(|n| {
            n.kind == "def"
                && name_of(n).map(|v| v != bname).unwrap_or(false)
                && c.guards(&n.id).contains(&b.id.as_str())
        }) {
            out.push(m(
                "null-check-fallback",
                vec![b.id.clone(), def.id.clone()],
                &[
                    ("checked", bname.to_string()),
                    ("fallback", name_of(def).unwrap_or("").to_string()),
                ],
            ));
        }
    }
    out
}

/// The catalogue, in the TS module's order. Order matters only for display; all matchers run.
pub fn match_motifs(pdg: &Pdg) -> Vec<MotifMatch> {
    let c = Ctx::new(&pdg.nodes, &pdg.edges);
    let mut out = Vec::new();
    out.extend(guarded_write(&c));
    out.extend(loop_accumulate(&c));
    out.extend(resource_acquire_release(&c));
    out.extend(retry_loop(&c));
    out.extend(early_exit_guard(&c));
    out.extend(fan_out_dispatch(&c));
    out.extend(collect_and_return(&c));
    out.extend(wrap_rethrow(&c));
    out.extend(flag_guard(&c));
    out.extend(null_check_fallback(&c));
    out
}

/// One batch over a whole repository's graphs, preserving input order.
pub fn match_motif_batch(pdgs: &[Pdg]) -> MotifBatch {
    MotifBatch {
        results: pdgs
            .iter()
            .map(|p| PdgMatches {
                entity_id: p.entity_id.clone(),
                matches: match_motifs(p),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, kind: &str, name: Option<&str>, at: f64) -> PdgNode {
        PdgNode {
            id: id.into(),
            kind: kind.into(),
            name: name.map(|s| s.into()),
            op: None,
            dynamic_write: false,
            at,
        }
    }
    fn edge(from: &str, to: &str, kind: &str) -> PdgEdge {
        PdgEdge {
            from: from.into(),
            to: to.into(),
            kind: kind.into(),
        }
    }
    fn empty(pdg: &Pdg) -> bool {
        match_motifs(pdg).is_empty()
    }

    #[test]
    fn guarded_write_binds_the_variable_and_cites_the_branch() {
        let pdg = Pdg {
            entity_id: "fn:a".into(),
            graph_hash: None,
            nodes: vec![
                node("b1", "branch", Some("over"), 0.0),
                node("d1", "def", Some("balance"), 1.0),
                node("u1", "use", Some("x"), 2.0),
            ],
            edges: vec![edge("b1", "d1", "guard"), edge("u1", "d1", "data")],
        };
        assert_eq!(
            match_motifs(&pdg),
            vec![MotifMatch {
                motif: "guarded-write",
                nodes: vec!["b1".into(), "d1".into()],
                binds: BTreeMap::from([("var".into(), "balance".into())]),
            }]
        );
    }

    #[test]
    fn empty_and_absent_names_are_skipped_like_js_truthiness_but_kept_by_nullish() {
        // "" is falsy in the guarded-write truthiness check...
        let pdg = Pdg {
            entity_id: "fn:b".into(),
            graph_hash: None,
            nodes: vec![
                node("b1", "branch", Some("if"), 0.0),
                node("d1", "def", Some(""), 1.0),
            ],
            edges: vec![edge("b1", "d1", "guard")],
        };
        assert!(empty(&pdg), "empty name must not match guarded-write");
        // ...but an acquire-release pair without names still binds via ?? "resource".
        let pdg2 = Pdg {
            entity_id: "fn:c".into(),
            graph_hash: None,
            nodes: vec![
                node("a1", "acquire", None, 0.0),
                node("r1", "release", None, 1.0),
            ],
            edges: vec![],
        };
        assert_eq!(
            match_motifs(&pdg2)[0]
                .binds
                .get("resource")
                .map(String::as_str),
            Some("resource")
        );
    }

    #[test]
    fn early_exit_uses_a_float_half_of_the_node_count() {
        // 3 nodes → half = 1.5; a throw at ordinal 1 qualifies, at 2 does not.
        let pdg = Pdg {
            entity_id: "fn:d".into(),
            graph_hash: None,
            nodes: vec![
                node("b1", "branch", None, 0.0),
                node("t1", "throw", None, 1.0),
                node("d1", "def", Some("v"), 2.0),
            ],
            edges: vec![edge("b1", "t1", "guard")],
        };
        assert_eq!(match_motifs(&pdg)[0].motif, "early-exit-guard");
        let mut pdg2 = pdg.clone();
        pdg2.nodes[1].at = 2.0;
        assert!(empty(&pdg2));
    }
}
