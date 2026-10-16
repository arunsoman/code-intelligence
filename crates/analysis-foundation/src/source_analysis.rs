//! Bounded structural analysis over validated semantic IR. No contract or runtime proof.
use crate::{semantic_ir::*, Completion, Effect};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
pub const VERSION: &str = "cie.source-analysis.v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    pub max_functions: usize,
    pub max_nodes_per_function: usize,
    pub max_steps: usize,
    pub max_dependencies: usize,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            max_functions: 10000,
            max_nodes_per_function: 4096,
            max_steps: 1_000_000,
            max_dependencies: 100_000,
        }
    }
}
struct Work {
    limit: usize,
    steps: usize,
    exhausted: bool,
}
impl Work {
    fn step(&mut self) -> bool {
        if self.steps >= self.limit {
            self.exhausted = true;
            false
        } else {
            self.steps += 1;
            true
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub source: Span,
    pub kind: String,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Flow {
    Normal,
    True,
    False,
    Exceptional,
    Unknown,
    Exit,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub kind: Flow,
}
#[derive(Clone, Debug, Serialize)]
pub struct Graph {
    pub entry: String,
    pub exit: String,
    pub nodes: BTreeMap<String, Node>,
    pub edges: BTreeSet<Edge>,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Dependency {
    pub from: String,
    pub to: String,
    pub kind: String,
    pub subject: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Summary {
    /// Potential represented effects, with per-effect source/call evidence sites.
    #[serde(serialize_with = "serialize_effects")]
    pub effects: BTreeMap<Effect, BTreeSet<String>>,
    pub gaps: BTreeSet<String>,
    /// Not computed; None must not be interpreted as an empty set of must-effects.
    pub must_effects: Option<BTreeSet<Effect>>,
    pub normal_exit_reachable: bool,
    pub exceptional_exit_reachable: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct ReturnSite {
    pub site: String,
    pub value: Option<ValueId>,
    pub structural_controls: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionAnalysis {
    pub graph: Option<Graph>,
    pub immediate_dominators: BTreeMap<String, Option<String>>,
    pub immediate_postdominators: BTreeMap<String, Option<String>>,
    pub dependencies: BTreeSet<Dependency>,
    pub returns: Vec<ReturnSite>,
    pub summary: Summary,
    pub completion: Completion,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub schema: &'static str,
    pub revision: String,
    pub input_digest: String,
    pub steps: usize,
    pub completion: Completion,
    pub functions: BTreeMap<FunctionId, FunctionAnalysis>,
    pub call_sccs: Vec<Vec<FunctionId>>,
}
fn site(f: &FunctionId, kind: &str, b: Option<&BlockId>, member: Option<&str>) -> String {
    serde_json::to_string(&(&f.0, kind, b.map(|b| &b.0), member)).unwrap()
}
fn first(f: &FunctionId, id: &BlockId, b: &Block) -> String {
    b.instructions
        .first()
        .map(|i| site(f, "instruction", Some(id), Some(&i.id.0)))
        .unwrap_or_else(|| site(f, "terminator", Some(id), None))
}
fn add(graph: &mut Graph, from: &str, to: String, kind: Flow) {
    graph.edges.insert(Edge {
        from: from.into(),
        to,
        kind,
    });
}
fn graph(id: &FunctionId, f: &Function) -> Graph {
    let entry = site(id, "entry", None, None);
    let exit = site(id, "exit", None, None);
    let normal = site(id, "normal-exit", None, None);
    let exceptional = site(id, "exceptional-exit", None, None);
    let unknown = site(id, "unknown-exit", None, None);
    let mut g = Graph {
        entry: entry.clone(),
        exit: exit.clone(),
        nodes: BTreeMap::new(),
        edges: BTreeSet::new(),
    };
    for (name, kind) in [
        (&entry, "entry"),
        (&exit, "exit"),
        (&normal, "normal-exit"),
        (&exceptional, "exceptional-exit"),
        (&unknown, "unknown-exit"),
    ] {
        g.nodes.insert(
            name.clone(),
            Node {
                source: f.source.clone(),
                kind: kind.into(),
            },
        );
    }
    let target = |b: &BlockId| first(id, b, &f.blocks[b]);
    let exception = |e: &ExceptionalExit| match e {
        ExceptionalExit::Propagate => exceptional.clone(),
        ExceptionalExit::Block { target: b } => target(b),
    };
    add(&mut g, &entry, target(&f.entry), Flow::Normal);
    for (bid, b) in &f.blocks {
        let term = site(id, "terminator", Some(bid), None);
        g.nodes.insert(
            term.clone(),
            Node {
                source: b.source.clone(),
                kind: "terminator".into(),
            },
        );
        for (index, i) in b.instructions.iter().enumerate() {
            let location = site(id, "instruction", Some(bid), Some(&i.id.0));
            g.nodes.insert(
                location.clone(),
                Node {
                    source: i.source.clone(),
                    kind: "instruction".into(),
                },
            );
            let next = b
                .instructions
                .get(index + 1)
                .map(|n| site(id, "instruction", Some(bid), Some(&n.id.0)))
                .unwrap_or_else(|| term.clone());
            add(&mut g, &location, next, Flow::Normal);
            if let Some(e) = &i.exceptional {
                add(&mut g, &location, exception(e), Flow::Exceptional);
            }
        }
        match &b.terminator {
            Terminator::Goto { target: b } => add(&mut g, &term, target(b), Flow::Normal),
            Terminator::Branch {
                then_block,
                else_block,
                ..
            } => {
                add(&mut g, &term, target(then_block), Flow::True);
                add(&mut g, &term, target(else_block), Flow::False);
            }
            Terminator::Return { .. } => add(&mut g, &term, normal.clone(), Flow::Normal),
            Terminator::Raise { .. } => add(&mut g, &term, exceptional.clone(), Flow::Exceptional),
            Terminator::Invoke {
                normal: n,
                exceptional: e,
                ..
            } => {
                add(&mut g, &term, target(n), Flow::Normal);
                add(&mut g, &term, exception(e), Flow::Exceptional);
            }
            Terminator::Opaque { successors, .. } => {
                for b in successors {
                    add(&mut g, &term, target(b), Flow::Unknown);
                }
                add(&mut g, &term, unknown.clone(), Flow::Unknown);
            }
        }
    }
    for terminal in [normal, exceptional, unknown] {
        add(&mut g, &terminal, exit.clone(), Flow::Exit);
    }
    g
}
fn adjacency(g: &Graph, reverse: bool) -> BTreeMap<String, BTreeSet<String>> {
    let mut map: BTreeMap<_, BTreeSet<_>> = g
        .nodes
        .keys()
        .map(|id| (id.clone(), BTreeSet::new()))
        .collect();
    for edge in &g.edges {
        let (a, b) = if reverse {
            (&edge.to, &edge.from)
        } else {
            (&edge.from, &edge.to)
        };
        map.get_mut(a).unwrap().insert(b.clone());
    }
    map
}
fn reachable(
    map: &BTreeMap<String, BTreeSet<String>>,
    root: &str,
    work: &mut Work,
) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut stack = vec![root.to_owned()];
    while let Some(n) = stack.pop() {
        if !work.step() {
            break;
        }
        if seen.insert(n.clone()) {
            stack.extend(map[&n].iter().cloned());
        }
    }
    seen
}
/// Cooper-style immediate dominator iteration over reverse postorder, without dense sets.
fn dominators(
    g: &Graph,
    reverse: bool,
    allowed: &BTreeSet<String>,
    work: &mut Work,
) -> BTreeMap<String, Option<String>> {
    let root = if reverse { &g.exit } else { &g.entry };
    if !allowed.contains(root) {
        return BTreeMap::new();
    }
    let successors = adjacency(g, reverse);
    let predecessors = adjacency(g, !reverse);
    let mut seen = BTreeSet::new();
    let mut postorder = vec![];
    let mut stack = vec![(root.clone(), false)];
    while let Some((n, visited)) = stack.pop() {
        if !work.step() {
            return BTreeMap::new();
        }
        if visited {
            postorder.push(n);
            continue;
        }
        if !allowed.contains(&n) || !seen.insert(n.clone()) {
            continue;
        }
        stack.push((n.clone(), true));
        for child in successors[&n].iter().rev() {
            stack.push((child.clone(), false));
        }
    }
    postorder.reverse();
    let order: BTreeMap<_, _> = postorder
        .iter()
        .enumerate()
        .map(|(i, n)| (n.clone(), i))
        .collect();
    let mut parents = BTreeMap::from([(root.clone(), root.clone())]);
    let mut changed = true;
    while changed {
        changed = false;
        for n in postorder.iter().skip(1) {
            if !work.step() {
                return parents
                    .into_iter()
                    .map(|(n, p)| (n.clone(), (n != p).then_some(p)))
                    .collect();
            }
            let mut incoming = predecessors[n].iter().filter(|p| parents.contains_key(*p));
            let Some(first) = incoming.next() else {
                continue;
            };
            let mut common = first.clone();
            for next in incoming {
                let mut other = next.clone();
                while common != other {
                    if !work.step() {
                        return BTreeMap::new();
                    }
                    if order[&common] > order[&other] {
                        common = parents[&common].clone();
                    } else {
                        other = parents[&other].clone();
                    }
                }
            }
            if parents.get(n) != Some(&common) {
                parents.insert(n.clone(), common);
                changed = true;
            }
        }
    }
    parents
        .into_iter()
        .map(|(n, p)| (n.clone(), (n != p).then_some(p)))
        .collect()
}
fn dominates(
    a: &str,
    b: &str,
    parents: &BTreeMap<String, Option<String>>,
    work: &mut Work,
) -> bool {
    let mut node = b;
    loop {
        if !work.step() {
            return false;
        }
        if a == node {
            return true;
        }
        let Some(Some(parent)) = parents.get(node) else {
            return false;
        };
        node = parent;
    }
}
fn uses(action: &Action) -> Vec<&ValueId> {
    match action {
        Action::Copy { operand, .. } | Action::Unary { operand, .. } => vec![operand],
        Action::Binary { left, right, .. } => vec![left, right],
        Action::Write { value, .. } => vec![value],
        Action::Opaque { inputs, .. } => inputs.iter().collect(),
        _ => vec![],
    }
}
fn outputs(action: &Action) -> Vec<&ValueId> {
    match action {
        Action::Constant { result, .. }
        | Action::Copy { result, .. }
        | Action::Unary { result, .. }
        | Action::Binary { result, .. }
        | Action::Read { result, .. } => vec![result],
        Action::Opaque { outputs, .. } => outputs.iter().collect(),
        _ => vec![],
    }
}
fn term_uses(term: &Terminator) -> Vec<&ValueId> {
    match term {
        Terminator::Branch { condition, .. } => vec![condition],
        Terminator::Return { value } | Terminator::Raise { value } => value.iter().collect(),
        Terminator::Invoke { call, .. } => call.arguments.iter().collect(),
        Terminator::Opaque { inputs, .. } => inputs.iter().collect(),
        _ => vec![],
    }
}
fn dependency(result: &mut FunctionAnalysis, edge: Dependency, budget: &Budget, work: &mut Work) {
    if result.dependencies.len() >= budget.max_dependencies {
        work.exhausted = true;
        return;
    }
    result.dependencies.insert(edge);
}
fn project(
    id: &FunctionId,
    f: &Function,
    document: &Document,
    budget: &Budget,
    work: &mut Work,
) -> FunctionAnalysis {
    let mut result = FunctionAnalysis {
        graph: None,
        immediate_dominators: BTreeMap::new(),
        immediate_postdominators: BTreeMap::new(),
        dependencies: BTreeSet::new(),
        returns: vec![],
        summary: Summary {
            effects: BTreeMap::new(),
            gaps: document
                .gaps
                .iter()
                .map(|g| format!("{}:{}: {}", document.path, g.source.start_byte, g.reason))
                .collect(),
            must_effects: None,
            normal_exit_reachable: false,
            exceptional_exit_reachable: false,
        },
        completion: Completion::Partial,
    };
    let count = f
        .blocks
        .values()
        .map(|b| b.instructions.len() + 1)
        .sum::<usize>()
        + 5;
    if count > budget.max_nodes_per_function || !work.step() {
        work.exhausted = true;
        result
            .summary
            .gaps
            .insert("projection node/work budget exhausted".into());
        result.completion = Completion::BudgetExhausted;
        return result;
    }
    let g = graph(id, f);
    let succ = adjacency(&g, false);
    let reached = reachable(&succ, &g.entry, work);
    result.immediate_dominators = dominators(&g, false, &reached, work);
    result.immediate_postdominators = dominators(&g, true, &reached, work);
    if reached
        .iter()
        .any(|n| !result.immediate_postdominators.contains_key(n))
    {
        result
            .summary
            .gaps
            .insert("some regions have no modeled exit path; no liveness conclusion".into());
    }
    result.summary.normal_exit_reachable = reached.contains(&site(id, "normal-exit", None, None));
    result.summary.exceptional_exit_reachable =
        reached.contains(&site(id, "exceptional-exit", None, None));
    let mut defs: BTreeMap<ValueId, (String, Option<String>)> = f
        .parameters
        .iter()
        .map(|v| (v.clone(), (g.entry.clone(), None)))
        .collect();
    for (bid, b) in &f.blocks {
        for i in &b.instructions {
            for v in outputs(&i.action) {
                defs.insert(
                    v.clone(),
                    (site(id, "instruction", Some(bid), Some(&i.id.0)), None),
                );
            }
        }
        if let Terminator::Invoke {
            result: Some(v),
            normal,
            ..
        } = &b.terminator
        {
            defs.insert(
                v.clone(),
                (
                    site(id, "terminator", Some(bid), None),
                    Some(first(id, normal, &f.blocks[normal])),
                ),
            );
        }
    }
    let mut reads = vec![];
    let mut writes = vec![];
    let mut all_uses = vec![];
    for (bid, b) in &f.blocks {
        let term = site(id, "terminator", Some(bid), None);
        for i in &b.instructions {
            let location = site(id, "instruction", Some(bid), Some(&i.id.0));
            if !reached.contains(&location) {
                continue;
            }
            all_uses.extend(uses(&i.action).into_iter().map(|v| (v, location.clone())));
            let effect = match &i.action {
                Action::Read { resource, .. } => {
                    reads.push(location.clone());
                    Some(Effect::Read(resource.0.clone()))
                }
                Action::Write { resource, .. } => {
                    writes.push(location.clone());
                    Some(Effect::Write(resource.0.clone()))
                }
                Action::Opaque { reason, .. } => {
                    result.summary.gaps.insert(format!("{location}: {reason}"));
                    None
                }
                _ => None,
            };
            if let Some(effect) = effect {
                result
                    .summary
                    .effects
                    .entry(effect)
                    .or_default()
                    .insert(location);
            }
        }
        if !reached.contains(&term) {
            continue;
        }
        all_uses.extend(
            term_uses(&b.terminator)
                .into_iter()
                .map(|v| (v, term.clone())),
        );
        match &b.terminator {
            Terminator::Return { value } => result.returns.push(ReturnSite {
                site: term.clone(),
                value: value.clone(),
                structural_controls: BTreeSet::new(),
            }),
            Terminator::Raise { .. } => {
                result
                    .summary
                    .effects
                    .entry(Effect::Raise)
                    .or_default()
                    .insert(term.clone());
            }
            Terminator::Opaque { reason, .. } => {
                result.summary.gaps.insert(format!("{term}: {reason}"));
            }
            Terminator::Invoke {
                call:
                    CallSite {
                        binding: Binding::Unresolved { reason, .. },
                        ..
                    },
                ..
            } => {
                result.summary.gaps.insert(format!("{term}: {reason}"));
            }
            _ => {}
        }
    }
    for (value, to) in all_uses {
        if !work.step() {
            break;
        }
        let (from, available) = &defs[value];
        if !dominates(
            available.as_deref().unwrap_or(from),
            &to,
            &result.immediate_dominators,
            work,
        ) {
            result.summary.gaps.insert(format!(
                "value {} availability/dominance not established at {to}",
                value.0
            ));
        }
        dependency(
            &mut result,
            Dependency {
                from: from.clone(),
                to,
                kind: "value".into(),
                subject: value.0.clone(),
            },
            budget,
            work,
        );
    }
    if !reads.is_empty() || !writes.is_empty() {
        result.summary.gaps.insert("memory aliasing is conservatively all-resources; resource names do not establish independence".into());
    }
    for write in &writes {
        for read in &reads {
            if !work.step() {
                break;
            }
            dependency(
                &mut result,
                Dependency {
                    from: write.clone(),
                    to: read.clone(),
                    kind: "may-alias".into(),
                    subject: "all-resources".into(),
                },
                budget,
                work,
            );
        }
    }
    for edge in &g.edges {
        if !reached.contains(&edge.from) || !reached.contains(&edge.to) {
            continue;
        }
        let Some(stop) = result.immediate_postdominators.get(&edge.from).cloned() else {
            continue;
        };
        let mut runner = Some(edge.to.clone());
        let mut visited = BTreeSet::new();
        while runner.as_ref() != stop.as_ref() {
            if !work.step() {
                break;
            }
            let Some(node) = runner else {
                break;
            };
            if !visited.insert(node.clone()) {
                break;
            }
            dependency(
                &mut result,
                Dependency {
                    from: edge.from.clone(),
                    to: node.clone(),
                    kind: "control".into(),
                    subject: format!("{:?}", edge.kind),
                },
                budget,
                work,
            );
            runner = result
                .immediate_postdominators
                .get(&node)
                .cloned()
                .flatten();
        }
    }
    for ret in &mut result.returns {
        ret.structural_controls = result
            .dependencies
            .iter()
            .filter(|d| d.kind == "control" && d.to == ret.site)
            .map(|d| d.from.clone())
            .collect();
    }
    result.graph = Some(g);
    result
}

pub fn analyze(snapshot: &Snapshot, sources: &Sources, budget: &Budget) -> Result<Report, String> {
    let ir_digest = snapshot.checked_digest(sources)?;
    if snapshot.functions.len() > budget.max_functions {
        return Err("source analysis function budget exceeded".into());
    }
    let mut work = Work {
        limit: budget.max_steps,
        steps: 0,
        exhausted: false,
    };
    let mut functions = BTreeMap::new();
    for (id, f) in &snapshot.functions {
        functions.insert(
            id.clone(),
            project(
                id,
                f,
                &snapshot.documents[&f.source.document],
                budget,
                &mut work,
            ),
        );
    }
    let mut calls = BTreeMap::<FunctionId, BTreeSet<FunctionId>>::new();
    let mut reverse = BTreeMap::<FunctionId, BTreeSet<FunctionId>>::new();
    let mut links = BTreeMap::<FunctionId, Vec<(FunctionId, String)>>::new();
    for (id, f) in &snapshot.functions {
        calls.entry(id.clone()).or_default();
        for (bid, b) in &f.blocks {
            if let Terminator::Invoke {
                call:
                    CallSite {
                        binding: Binding::Resolved { targets, .. },
                        ..
                    },
                ..
            } = &b.terminator
            {
                for target in targets {
                    calls.entry(id.clone()).or_default().insert(target.clone());
                    reverse
                        .entry(target.clone())
                        .or_default()
                        .insert(id.clone());
                    let callsite = site(id, "terminator", Some(bid), None);
                    if functions[id].immediate_dominators.contains_key(&callsite) {
                        links
                            .entry(id.clone())
                            .or_default()
                            .push((target.clone(), callsite));
                    }
                }
            }
        }
    }
    let mut queue: BTreeSet<_> = snapshot.functions.keys().cloned().collect();
    while let Some(id) = queue.pop_first() {
        if !work.step() {
            break;
        }
        let mut next = functions[&id].summary.clone();
        for (target, callsite) in links.get(&id).into_iter().flatten() {
            let callee = &functions[target].summary;
            next.gaps.extend(callee.gaps.iter().cloned());
            for (effect, evidence) in &callee.effects {
                let sites = next.effects.entry(effect.clone()).or_default();
                sites.extend(evidence.iter().cloned());
                sites.insert(callsite.clone());
            }
        }
        if next != functions[&id].summary {
            functions.get_mut(&id).unwrap().summary = next;
            queue.extend(reverse.get(&id).into_iter().flatten().cloned());
        }
    }
    let call_sccs = sccs(&calls, &reverse, &mut work);
    for f in functions.values_mut() {
        f.completion = if work.exhausted {
            Completion::BudgetExhausted
        } else if f.summary.gaps.is_empty() {
            Completion::CompleteWithinModel
        } else {
            Completion::Partial
        };
    }
    let completion = if work.exhausted {
        Completion::BudgetExhausted
    } else if functions.values().all(|f| f.summary.gaps.is_empty()) {
        Completion::CompleteWithinModel
    } else {
        Completion::Partial
    };
    let input_digest = source_digest(&serde_json::to_vec(&(VERSION, ir_digest, budget)).unwrap());
    Ok(Report {
        schema: VERSION,
        revision: snapshot.revision.clone(),
        input_digest,
        steps: work.steps,
        completion,
        functions,
        call_sccs,
    })
}
fn sccs(
    graph: &BTreeMap<FunctionId, BTreeSet<FunctionId>>,
    reverse: &BTreeMap<FunctionId, BTreeSet<FunctionId>>,
    work: &mut Work,
) -> Vec<Vec<FunctionId>> {
    let mut seen = BTreeSet::new();
    let mut order = vec![];
    for root in graph.keys() {
        let mut stack = vec![(root.clone(), false)];
        while let Some((node, done)) = stack.pop() {
            if !work.step() {
                return vec![];
            }
            if done {
                order.push(node);
                continue;
            }
            if !seen.insert(node.clone()) {
                continue;
            }
            stack.push((node.clone(), true));
            stack.extend(graph[&node].iter().map(|n| (n.clone(), false)));
        }
    }
    seen.clear();
    let mut result = vec![];
    for root in order.into_iter().rev() {
        if seen.contains(&root) {
            continue;
        }
        let mut group = vec![];
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            if !work.step() {
                return result;
            }
            if !seen.insert(node.clone()) {
                continue;
            }
            group.push(node.clone());
            stack.extend(reverse.get(&node).into_iter().flatten().cloned());
        }
        group.sort();
        result.push(group);
    }
    result.sort();
    result
}
#[derive(Debug, Serialize)]
pub struct Slice {
    pub sites: BTreeSet<String>,
    pub gaps: BTreeSet<String>,
    pub truncated: bool,
}
pub fn slice(
    function: &FunctionAnalysis,
    seed: &str,
    backward: bool,
    max_sites: usize,
) -> Result<Slice, String> {
    let g = function.graph.as_ref().ok_or("projection unavailable")?;
    if !g.nodes.contains_key(seed) {
        return Err("unknown slice seed".into());
    }
    let mut adjacency = BTreeMap::<String, BTreeSet<String>>::new();
    for d in &function.dependencies {
        let (a, b) = if backward {
            (&d.to, &d.from)
        } else {
            (&d.from, &d.to)
        };
        adjacency.entry(a.clone()).or_default().insert(b.clone());
    }
    let mut sites = BTreeSet::new();
    let mut queue = VecDeque::from([seed.to_owned()]);
    let mut truncated = false;
    while let Some(node) = queue.pop_front() {
        if sites.contains(&node) {
            continue;
        }
        if sites.len() >= max_sites {
            truncated = true;
            break;
        }
        sites.insert(node.clone());
        queue.extend(adjacency.get(&node).into_iter().flatten().cloned());
    }
    if function.completion == Completion::BudgetExhausted {
        truncated = true;
    }
    Ok(Slice {
        sites,
        gaps: function.summary.gaps.clone(),
        truncated,
    })
}

fn serialize_effects<S: serde::Serializer>(
    effects: &BTreeMap<Effect, BTreeSet<String>>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    effects
        .iter()
        .map(|(effect, evidence)| serde_json::json!({"effect":effect,"evidence":evidence}))
        .collect::<Vec<_>>()
        .serialize(serializer)
}
