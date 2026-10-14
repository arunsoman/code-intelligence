//! Program dependence graphs, folded from the stored semantic IR (plan §0.5 → §IR).
//!
//! This is the Rust port of `packages/core/src/concept-hierarchy/pdg.ts`'s `IrPdgBuilder`: the
//! TypeScript version stays as the reference (and the hermetic fallback when no worker binary
//! exists), while the per-repository batch — the heavy lifting: JSON-parsing every function's
//! `irDump` and folding statement-grain graphs with flow/data/guard edges — runs here, one process
//! per build (`worker irPdgs <entities.json>`), exactly like the motif batch one-shot. The fold
//! must match the TS builder occurrence-for-occurrence because the parity fixtures pin both runtimes.
//!
//! Input semantics (the contract the TS side keeps):
//!   - each entity carries its `irDump` (the worker's own IrSer JSON: refs carry slot + local name,
//!     calls their callee and arguments, operators their `op:`/`un:` tags),
//!   - locals are identified by SLOT, so "same local" is exact and scopes need no re-derivation,
//!   - guard edges come from branch/loop tree nesting, data edges from slot def-use (last def wins),
//!   - statement grain: compound `+=` folds onto the assign (self-fed without an explicit op tag
//!     counts as an add, the convention `+=` implies), `x++`-style tagged unknowns synthesize the
//!     self-assignment, nested functions are skipped (they are their own symbols).
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrPdgEntity {
    pub entity_id: String,
    pub file: String,
    pub ir_hash: Option<String>,
    pub ir_dump: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrPdgRequest {
    /// Statement budget per function (concept-config's `pdgMaxStatements`).
    pub max_statements: u32,
    pub entities: Vec<IrPdgEntity>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IrPdgResult {
    pub entity_id: String,
    pub pdg: Option<PdgOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdgOut {
    pub entity_id: String,
    pub file: String,
    pub body_hash: String,
    pub graph_hash: String,
    pub nodes: Vec<OutNode>,
    pub edges: Vec<OutEdge>,
    pub locals: Vec<String>,
    pub truncated: bool,
    pub statements: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(Debug)]
pub struct OutNode {
    pub id: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<&'static str>,
    #[serde(skip_serializing_if = "dw_absent")]
    pub dynamic_write: bool,
    pub at: u32,
}

fn dw_absent(b: &bool) -> bool {
    !*b
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(Debug)]
pub struct OutEdge {
    pub from: String,
    pub to: String,
    pub kind: &'static str,
}

const ACQUIRE: [&str; 6] = ["open", "acquire", "connect", "lock", "begin", "allocate"];
const RELEASE: [&str; 7] = ["close", "release", "unlock", "end", "dispose", "free", "commit"];
const ASSERT: [&str; 7] = ["assert", "assertThat", "assertEqual", "assertEqualss", "expect", "invariant", "check"];

fn classify_call(name: Option<&str>) -> &'static str {
    match name {
        Some(n) if ASSERT.contains(&n) || n == "assertEquals" => "assert",
        Some(n) if ACQUIRE.contains(&n) => "acquire",
        Some(n) if RELEASE.contains(&n) => "release",
        _ => "call",
    }
}

const IR_OP: [(&str, &str); 5] = [("op:+", "op:add"), ("op:-", "op:sub"), ("op:*", "op:mul"), ("op:/", "op:div"), ("op://", "op:div")];

struct Folder {
    limit: u32,
    at: u32,
    truncated: bool,
    nodes: Vec<OutNode>,
    edges: Vec<OutEdge>,
    locals: Vec<String>,
    defs: std::collections::HashMap<u32, String>,
    guards: Vec<String>,
}

impl Folder {
    fn emit(&mut self, kind: &'static str, name: Option<String>, op: Option<&'static str>, dynamic_write: bool, flow: bool, feeds: &[String]) -> Option<String> {
        if self.at >= self.limit {
            self.truncated = true;
            return None;
        }
        let id = format!("n{}", self.at);
        self.nodes.push(OutNode { id: id.clone(), kind, name, op, dynamic_write, at: self.at });
        self.at += 1;
        if flow {
            if let Some(prev) = self.nodes.len().checked_sub(2).map(|i| self.nodes[i].id.clone()) {
                self.push_edge(&prev, &id, "flow");
            }
        }
        for f in feeds {
            if f != &id {
                self.push_edge(f, &id, "data");
            }
        }
        let guards = self.guards.clone();
        for g in guards {
            if g != id {
                self.push_edge(&g, &id, "guard");
            }
        }
        Some(id)
    }

    fn push_edge(&mut self, from: &str, to: &str, kind: &'static str) {
        self.edges.push(OutEdge { from: from.to_string(), to: to.to_string(), kind });
    }

    /// A read of a local: the use node gets its data edge from that slot's current def.
    fn read_ref(&mut self, node: &Value, wired_to: Option<&str>) -> Option<String> {
        let slot = node.get("slot").and_then(Value::as_u64).unwrap_or(0) as u32;
        let name = node.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("#local{slot}"));
        if !self.locals.contains(&name) {
            self.locals.push(name.clone());
        }
        let u = self.emit("use", Some(name), None, false, true, &[])?;
        if let Some(d) = self.defs.get(&slot).cloned() {
            self.push_edge(&d, &u, "data");
        }
        if let Some(w) = wired_to {
            if w != u {
                self.push_edge(&u, w, "data");
            }
        }
        Some(u)
    }

    /// Define a target (local slot or property attr) from its value expression.
    fn define(&mut self, target: &Value, value: Option<&Value>, self_fed: bool) {
        let dynamic = kind_of(target) == Some("attr")
            && target.get("name").and_then(Value::as_str).map(str::is_empty).unwrap_or(true);
        let name = match kind_of(target) {
            Some("attr") => target.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| "[dynamic]".to_string()),
            _ => target.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("#local{}", target.get("slot").and_then(Value::as_u64).unwrap_or(0))),
        };
        if !self.locals.contains(&name) {
            self.locals.push(name.clone());
        }
        // The value's own operator tag carries `x = a - b`; a self-fed assign whose tree folded the
        // operator away (`+=`, `++`) is conventionally an add.
        let op_tag = value
            .filter(|v| kind_of(v) == Some("unknown"))
            .and_then(|v| v.get("tag").and_then(Value::as_str))
            .and_then(|t| IR_OP.iter().find(|(k, _)| *k == t).map(|(_, v)| *v));
        let mut feeds: Vec<String> = Vec::new();
        if let Some(v) = value {
            for _a in awaits_of(v, 0) {
                if let Some(aid) = self.emit("await", None, None, false, true, &[]) {
                    feeds.push(aid);
                }
            }
            for c in calls_of(v) {
                let cn = ir_name_of(c.get("callee"));
                if let Some(cid) = self.emit(classify_call(cn.as_deref()), cn, None, false, true, &[]) {
                    feeds.push(cid);
                }
            }
            for r in refs_of(v) {
                if let Some(u) = self.read_ref(r, None) {
                    feeds.push(u);
                }
            }
            let self_slot = target.get("slot").and_then(Value::as_u64).map(|s| s as u32);
            if let Some(slot) = self_slot {
                if let Some(d) = self.defs.get(&slot).cloned() {
                    if let Some(self_id) = self.emit("use", Some(name.clone()), None, false, true, &[]) {
                        self.push_edge(&d, &self_id, "data");
                        feeds.push(self_id);
                    }
                }
            }
        }
        let id = self.emit("def", Some(name), op_tag.or(if self_fed { Some("op:add") } else { None }), dynamic, true, &feeds);
        if let Some(id) = id {
            let slot = target.get("slot").and_then(Value::as_u64).map(|s| s as u32).unwrap_or(u32::MAX);
            self.defs.insert(slot, id);
        }
    }

    fn statement(&mut self, n: &Value) {
        if self.truncated {
            return;
        }
        match kind_of(n) {
            Some("fn") => { /* nested functions are their own symbols */ }
            Some("decl") => {
                // A decl's children are the target then the initializer (`decl → [ref, call]`);
                // a multi-declarator statement arrives as several decl siblings handled upstream.
                let ks = kids(n);
                match ks.first() {
                    Some(t) if matches!(kind_of(t), Some("ref") | Some("attr")) => {
                        self.define(t, ks.get(1).copied(), false);
                    }
                    Some(t) => self.statement(t),
                    None => { /* empty declarator */ }
                }
            }
            Some("assign") => {
                let ks = kids(n);
                match ks.first().map(|t| (t, kind_of(t))) {
                    Some((t, Some("ref"))) => {
                        let value = ks.get(1).copied();
                        let slot = t.get("slot").and_then(Value::as_u64).unwrap_or(u64::MAX);
                        let aug = n.get("aug").and_then(Value::as_bool).unwrap_or(false);
                        let self_fed = aug
                            || value.and_then(|v| refs_of(v).into_iter().find(|r| r.get("slot").and_then(Value::as_u64) == Some(slot))).is_some();
                        self.define(t, value, self_fed);
                    }
                    Some((t, Some("attr"))) => self.define(t, ks.get(1).copied(), false),
                    _ => {
                        for k in ks {
                            self.statement(k);
                        }
                    }
                }
            }
            Some("loop") | Some("branch") => {
                // children[0], when it is an expression, is the condition; the rest is the guarded body.
                let ks = kids(n);
                let cond = ks.first().filter(|c| !is_ir_block(c));
                let mut branch_id: Option<String> = None;
                if let Some(cond) = cond {
                    let mut feeds: Vec<String> = Vec::new();
                    for _a in awaits_of(cond, 0) {
                        if let Some(aid) = self.emit("await", None, None, false, true, &[]) {
                            feeds.push(aid);
                        }
                    }
                    for c in calls_of(cond) {
                        let cn = ir_name_of(c.get("callee"));
                        if let Some(cid) = self.emit(classify_call(cn.as_deref()), cn, None, false, true, &[]) {
                            feeds.push(cid);
                        }
                    }
                    for r in refs_of(cond) {
                        if let Some(u) = self.read_ref(r, None) {
                            feeds.push(u);
                        }
                    }
                    branch_id = self.emit("branch", first_ident(cond), None, false, false, &feeds);
                }
                let outer = self.guards.clone();
                if let Some(b) = &branch_id {
                    self.guards.push(b.clone());
                }
                for k in ks.iter().skip(if cond.is_some() { 1 } else { 0 }) {
                    if is_ir_statement_list(k) {
                        for s in kids(k) {
                            self.statement(s);
                        }
                    } else {
                        self.statement(k);
                    }
                }
                self.guards = outer;
            }
            Some("ret") => {
                let ks = kids(n);
                let empty = Value::Null;
                let expr = ks.first().copied().unwrap_or(&empty);
                let mut feeds: Vec<String> = Vec::new();
                for _a in awaits_of(expr, 0) {
                    if let Some(aid) = self.emit("await", None, None, false, true, &[]) {
                        feeds.push(aid);
                    }
                }
                for c in calls_of(expr) {
                    let cn = ir_name_of(c.get("callee"));
                    if let Some(cid) = self.emit(classify_call(cn.as_deref()), cn, None, false, true, &[]) {
                        feeds.push(cid);
                    }
                }
                for r in refs_of(expr) {
                    if let Some(u) = self.read_ref(r, None) {
                        feeds.push(u);
                    }
                }
                self.emit("return", None, None, false, true, &feeds);
            }
            Some("unknown") => {
                let tag = n.get("tag").and_then(Value::as_str).unwrap_or("");
                if tag == "throw_statement" {
                    let empty = Value::Null;
                    let inner = kids(n).first().copied().unwrap_or(&empty);
                    let mut feeds: Vec<String> = Vec::new();
                    for _a in awaits_of(inner, 0) {
                        if let Some(aid) = self.emit("await", None, None, false, true, &[]) {
                            feeds.push(aid);
                        }
                    }
                    for c in calls_of(inner) {
                        let cn = ir_name_of(c.get("callee"));
                        if let Some(cid) = self.emit(classify_call(cn.as_deref()), cn, None, false, true, &[]) {
                            feeds.push(cid);
                        }
                    }
                    for r in refs_of(inner) {
                        if let Some(u) = self.read_ref(r, None) {
                            feeds.push(u);
                        }
                    }
                    self.emit("throw", None, None, false, true, &feeds);
                    return;
                }
                if tag == "expression_statement" {
                    let irkids_keep = kids(n);
                    let inner = irkids_keep.first();
                    if inner.map(|i| kind_of(i)) == Some(Some("call")) {
                        let i = inner.unwrap();
                        let cn = ir_name_of(i.get("callee"));
                        let cid = self.emit(classify_call(cn.as_deref()), cn, None, false, true, &[]);
                        if let Some(c) = cid {
                            for r in refs_of(i) {
                                self.read_ref(r, Some(&c));
                            }
                        }
                        return;
                    }
                    let tagged = inner
                        .and_then(|i| i.get("tag")).and_then(Value::as_str)
                        .map_or(false, |t| t == "update_expression" || t == "inc_dec_statement" || t.starts_with("un:"));
                    if tagged {
                        let i = inner.unwrap();
                        let rs = refs_of(i);
                        if rs.len() == 1 && calls_of(i).is_empty() {
                            // `x++` / `--x` folded to a tagged unknown: synthesize the self-assignment.
                            self.define(rs[0], Some(i), true);
                        } else {
                            for r in refs_of(i) {
                                self.read_ref(r, None);
                            }
                        }
                        return;
                    }
                    for k in kids(n) {
                        self.statement(k);
                    }
                    return;
                }
                // A block, a try, a switch body, a pair, a declarator chain: fold into its parts.
                let ks = kids(n);
                let declarator = tag == "variable_declarator"
                    && ks.len() >= 2
                    && matches!(kind_of(ks[0]), Some("ref") | Some("attr"));
                if declarator {
                    self.define(ks[0], ks.get(1).copied(), false);
                    return;
                }
                for k in ks {
                    if is_ir_statement_list(k) {
                        for s in kids(k) {
                            self.statement(s);
                        }
                    } else {
                        self.statement(k);
                    }
                }
            }
            Some("call") => {
                let cn = ir_name_of(n.get("callee"));
                let cid = self.emit(classify_call(cn.as_deref()), cn, None, false, true, &[]);
                if let Some(c) = cid {
                    for r in refs_of(n) {
                        self.read_ref(r, Some(&c));
                    }
                }
            }
            _ => {
                for k in kids(n) {
                    self.statement(k);
                }
            }
        }
    }
}

fn kind_of(v: &Value) -> Option<&str> {
    v.get("kind").and_then(Value::as_str)
}

/// Serde children in the exact shape `irKids` walks in TypeScript: a call contributes its callee and
/// arguments, an attr its object, a not its single child, everything else its `children`.
fn kids(n: &Value) -> Vec<&Value> {
    match kind_of(n) {
        Some("call") => {
            let mut out = Vec::new();
            if let Some(c) = n.get("callee") {
                out.push(c);
            }
            if let Some(a) = n.get("args").and_then(Value::as_array) {
                out.extend(a);
            }
            out
        }
        Some("attr") => n.get("object").map(|o| vec![o]).unwrap_or_default(),
        Some("not") => n.get("child").map(|c| vec![c]).unwrap_or_default(),
        _ => n.get("children").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default(),
    }
}

/// The displayed name of an identifier-ish node: external `name.of`, property `attr.name`, locals by
/// their slot placeholder (call sites that need the real local read the slot themselves).
fn ir_name_of(n: Option<&Value>) -> Option<String> {
    match n.and_then(kind_of) {
        Some("name") => n.and_then(|n| n.get("of")).and_then(Value::as_str).map(str::to_string),
        Some("attr") => n.and_then(|n| n.get("name")).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
        Some("ref") => n.and_then(|n| n.get("slot")).and_then(Value::as_u64).map(|s| format!("#local{s}")),
        _ => None,
    }
}

const MAX_DEPTH: usize = 24;

fn refs_of<'a>(n: &'a Value) -> Vec<&'a Value> {
    refs_at(n, 0)
}

fn refs_at<'a>(n: &'a Value, depth: usize) -> Vec<&'a Value> {
    if depth > MAX_DEPTH {
        return vec![];
    }
    let mut out = Vec::new();
    if kind_of(n) == Some("ref") {
        out.push(n);
    }
    for k in kids(n) {
        out.extend(refs_at(k, depth + 1));
    }
    out
}

fn calls_of<'a>(n: &'a Value) -> Vec<&'a Value> {
    calls_at(n, 0)
}

/// `await` wrappers the fold turns into await nodes (an awaited def's guard demotes downstream).
fn awaits_of<'a>(n: &'a Value, depth: usize) -> Vec<&'a Value> {
    if depth > MAX_DEPTH {
        return vec![];
    }
    let mut out: Vec<&'a Value> = Vec::new();
    for k in kids(n) {
        out.extend(awaits_of(k, depth + 1));
    }
    let tagged = kind_of(n) == Some("unknown")
        && n.get("tag").and_then(Value::as_str).map_or(false, |t| t.contains("await"));
    if tagged {
        out.push(n);
    }
    out
}

fn calls_at<'a>(n: &'a Value, depth: usize) -> Vec<&'a Value> {
    if depth > MAX_DEPTH {
        return vec![];
    }
    let mut out: Vec<&'a Value> = Vec::new();
    for k in kids(n) {
        out.extend(calls_at(k, depth + 1));
    }
    if kind_of(n) == Some("call") {
        out.push(n);
    }
    out
}

/// First local or external identifier the expression touches, in pre-order (branch naming). Locals
/// resolve to their dump name — the fold carries real names, and invariants quote them.
fn first_ident(n: &Value) -> Option<String> {
    fn find(v: &Value, depth: usize) -> Option<String> {
        if depth > 6 {
            return None;
        }
        match kind_of(v) {
            Some("name") => return v.get("of").and_then(Value::as_str).map(str::to_string),
            Some("ref") => {
                return Some(
                    v.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
                        .unwrap_or_else(|| format!("#local{}", v.get("slot").and_then(Value::as_u64).unwrap_or(0))),
                );
            }
            _ => {}
        }
        for k in kids(v) {
            if let Some(f) = find(k, depth + 1) {
                return Some(f);
            }
        }
        None
    }
    find(n, 0)
}

fn is_ir_block(n: &Value) -> bool {
    match kind_of(n) {
        Some("fn") | Some("loop") | Some("branch") => true,
        Some("unknown") => {
            let tag = n.get("tag").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
            ["block", "switch_body", "case_clause", "match_arm", "brace", "body"].iter().any(|p| tag.contains(p))
        }
        _ => false,
    }
}

fn is_ir_statement_list(n: &Value) -> bool {
    kind_of(n) == Some("unknown") && {
        let tag = n.get("tag").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
        tag.contains("block") || tag.contains("switch_body")
    }
}

/// sha256 over the byte-identical text `JSON.stringify({n, e: sorted, l})` produces in TypeScript:
/// the edges sort by their `Array.prototype.toString` form (`from,to,kind`); the object keys stay in
/// JS's `{n, e, l}` order. Structural copies must hash equal across both runtimes.
fn graph_hash(nodes: &[OutNode], edges: &[OutEdge], locals: &[String]) -> String {
    let enc = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let mut text = String::with_capacity(256);
    text.push_str("{\"n\":[");
    let mut sep = "";
    for x in nodes {
        text.push_str(sep);
        text.push_str(&serde_json::to_string(&(x.kind, x.name.as_deref().unwrap_or(""), x.op.unwrap_or(""))).unwrap_or_default());
        sep = ",";
    }
    text.push_str("],\"e\":[");
    let mut keyed: Vec<(String, String)> = edges
        .iter()
        .map(|e| (format!("{},{},{}", e.from, e.to, e.kind), format!("[{},{},{}]", enc(&e.from), enc(&e.to), enc(e.kind))))
        .collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    sep = "";
    for (_, p) in &keyed {
        text.push_str(sep);
        text.push_str(p);
        sep = ",";
    }
    text.push_str("],\"l\":[");
    let mut sorted_locals: Vec<&String> = locals.iter().collect();
    sorted_locals.sort();
    sep = "";
    for l in sorted_locals {
        text.push_str(sep);
        text.push_str(&enc(l));
        sep = ",";
    }
    text.push_str("]}");
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()
}

/// Fold one entity's `irDump` into its PDG, or None for dumpless/unfoldable bodies.
pub fn fold(e: &IrPdgEntity, max_statements: u32) -> Option<PdgOut> {
    let root: Value = serde_json::from_str(&e.ir_dump).ok()?;
    let kids = kids(&root);
    let first_statement = kids.iter().position(|k| {
        !(kind_of(k) == Some("unknown")
            && k.get("tag").and_then(Value::as_str).map_or(false, |t| t.contains("parameter")))
    });
    let mut f = Folder {
        limit: max_statements,
        at: 0,
        truncated: false,
        nodes: vec![],
        edges: vec![],
        locals: vec![],
        defs: std::collections::HashMap::new(),
        guards: vec![],
    };
    for k in kids.iter().skip(first_statement.unwrap_or(usize::MAX)) {
        f.statement(k);
    }
    if f.at == 0 {
        return None;
    }
    let mut locals = f.locals.clone();
    locals.sort();
    let graph_hash = graph_hash(&f.nodes, &f.edges, &locals);
    let body_hash = e.ir_hash.clone().unwrap_or_else(|| {
        let mut h = Sha256::new();
        h.update(e.ir_dump.as_bytes());
        h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()
    });
    Some(PdgOut {
        entity_id: e.entity_id.clone(),
        file: e.file.clone(),
        body_hash,
        graph_hash,
        nodes: f.nodes,
        edges: f.edges,
        locals,
        truncated: f.truncated,
        statements: f.at,
    })
}

/// The one-shot batch: `worker irPdgs <entities.json>` → `{"results":[{entityId, pdg}...]}`.
pub fn fold_batch(req: &IrPdgRequest) -> Vec<IrPdgResult> {
    req.entities.iter().map(|e| IrPdgResult { entity_id: e.entity_id.clone(), pdg: fold(e, req.max_statements) }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(dumps: &[(&str, String)], max: u32) -> IrPdgRequest {
        IrPdgRequest {
            max_statements: max,
            entities: dumps
                .iter()
                .map(|(id, dump)| IrPdgEntity { entity_id: (*id).to_string(), file: "f.ts".into(), ir_hash: Some("abc".into()), ir_dump: dump.clone() })
                .collect(),
        }
    }

    fn dump_of(src: &str) -> String {
        use tree_sitter::Parser;
        let mut parser = Parser::new();
        parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()).expect("grammar");
        let tree = parser.parse(src, None).expect("parse");
        crate::ir::ir_hash(tree.root_node(), src.as_bytes(), crate::ir::Lang::Ts, "pay").dump.expect("dump persists by default")
    }

    #[test]
    fn folds_a_function_into_a_pdg_with_data_and_guard_edges() {
        let src = "function pay(account, amount) { let total = reserve(account, amount); if (total > 100) { throw new Reject(account); } return total; }";
        let r = fold_batch(&req(&[("e1", dump_of(src))], 200));
        let pdg = r[0].pdg.as_ref().expect("folds");
        let kinds: Vec<&str> = pdg.nodes.iter().map(|n| n.kind).collect();
        assert!(kinds.contains(&"def"), "decl defines total: {kinds:?}");
        assert!(kinds.contains(&"branch"), "the if folds to a branch: {kinds:?}");
        assert!(kinds.contains(&"throw"), "the throw folds: {kinds:?}");
        assert!(kinds.contains(&"return"), "the return folds: {kinds:?}");
        assert!(pdg.edges.iter().any(|e| e.kind == "guard"), "the branch guards the throw");
        assert!(pdg.edges.iter().any(|e| e.kind == "data"), "def-use chains link");
        assert!(pdg.locals.iter().any(|l| l == "total"), "the dump's local names survive: {:?}", pdg.locals);
        assert_eq!(pdg.body_hash, "abc", "the caller's ir hash is the reuse key");
    }

    #[test]
    fn renames_change_names_but_not_the_folded_structure() {
        let a = "function pay(account, amount) { let total = amount; return total; }";
        let b = "function pay(customer, quantity) { let grand = quantity; return grand; }";
        let r = fold_batch(&req(&[("a", dump_of(a)), ("b", dump_of(b))], 200));
        let (pa, pb) = (r[0].pdg.as_ref().unwrap(), r[1].pdg.as_ref().unwrap());
        let shape = |p: &PdgOut| -> Vec<(String, Option<String>)> { p.nodes.iter().map(|n| (n.kind.to_string(), n.op.map(str::to_string))).collect() };
        assert_eq!(shape(pa), shape(pb), "the graph shape is rename-stable: {:?} vs {:?}", shape(pa), shape(pb));
        assert_ne!(pa.locals, pb.locals, "but the names carry through to binds");
    }

    #[test]
    fn self_fed_compound_assignments_get_an_op() {
        let src = "function tick(count) { while (count < 10) { count += 1; } return count; }";
        let r = fold_batch(&req(&[("e", dump_of(src))], 200));
        let pdg = r[0].pdg.as_ref().unwrap();
        let def = pdg.nodes.iter().find(|n| n.kind == "def").expect("the increment defines");
        assert_eq!(def.op, Some("op:add"), "self-fed without an explicit tag counts as add: {:?}", def);
    }

    #[test]
    fn the_statement_budget_truncates() {
        let src = "function big(a) { let x=a; let y=x; let z=y; let w=z; let v=w; return v; }";
        let r = fold_batch(&req(&[("e", dump_of(src))], 3));
        let pdg = r[0].pdg.as_ref().expect("partial graphs still fold");
        assert!(pdg.truncated && pdg.statements == 3);
    }
}