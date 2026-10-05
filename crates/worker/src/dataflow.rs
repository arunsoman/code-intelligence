//! F03 — deterministic data-flow and taint analysis (extraction = C05, solver = C25).
//!
//! Ownership (guide §3, F03 §18/D3): semantic extraction and graph semantics live in this worker; Node
//! orchestrates, stores and publishes. Two RPC ops in `main.rs` reach the entry points here:
//!   `extractDataFlow {repoPath, budget}` — the versioned facts artifact only (CFG + def-use + call facts);
//!   `runTaint {repoPath, rulePack, budget}` — extract + solve: findings with bounded witness paths.
//!
//! Honesty rules implemented here (spec F03 §1.2, §18): every finding carries a witness path whose steps are
//! bound to exact file spans; an unresolved call becomes a recorded boundary step, never a sanitization boundary;
//! a validated sanitizer yields no finding — sanitizers that exist but don't prevent the flow are listed as
//! "considered" with an outcome, not silently dropped. This is a per-repo, intra- plus interprocedural *may*
//! analysis with documented blind spots (spec §2.2).

use serde::Serialize;
use walkdir::WalkDir;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use tree_sitter::{Node, Parser};

pub const FACTS_SCHEMA: &str = "cie.dataflow-facts/1";
pub const SOLVER_VERSION: &str = "scc-summary-ts@0.1";

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
fn sha(s: &[u8]) -> String { hex(&Sha256::digest(s)) }

/// Directory subtree skips (aligned with index.rs's SKIP_DIRS).
const SKIP_DIRS: &[&str] = &["node_modules", ".git", "dist", "build", "target", "out", "coverage", "vendor", "testdata"];

pub const SKIP_TOO_LARGE: &str = "tooLarge";
pub const SKIP_UNSUPPORTED: &str = "unsupportedConstruct";
pub const SKIP_PARSE_ERROR: &str = "parseError";
pub const SKIP_BUDGET: &str = "budget";

const MAX_BLOCKS_PER_FN: usize = 2000; // aligned with the CFG cap in defect-semantics.ts (spec §7.6)
const MAX_BODY_BYTES: usize = 200_000;
const MAX_TREES_PER_FN: usize = 20_000;
const MAX_OCCS: usize = 300_000;

// -------------------------------------------------------------------------- facts artifact types

/// One expression-tree node. `k`: 0 = leaf identifier chain (taint-capable), 1 = call, 2 = operator node,
/// 3 = opaque (unmodelled sub-expression; the solver may still scan its text for source roots), 4 = constant.
#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EN {
    pub k: u8,
    #[serde(default)]
    pub t: String,
    pub at: usize,
    pub end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub a: Option<String>, // resolved callee entity id (k=1)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub m: Option<String>, // external module of an unresolvable binding (k=1)
    #[serde(default)]
    pub d: bool, // dynamic / computed callee (k=1)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sh: Option<bool>, // raw call text contains `shell: true` (spawn-style sinks)
    #[serde(default)]
    pub kids: Vec<usize>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FlowStmt {
    pub block: usize,
    pub at: usize,
    pub end: usize,
    pub trees: Vec<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rets: Option<usize>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FlowBlock { #[serde(default)] pub stmts: Vec<usize> }

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CondEdge {
    pub from: usize,
    pub to: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cond: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<bool>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Unsup { pub construct: String, pub at: usize, pub end: usize }

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fn_id: Option<String>,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub construct: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<usize>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FlowFn {
    pub id: String,
    pub file: String,
    pub name: String,
    pub kind: String, // "function" | "method" | "closure"
    pub class: Option<String>,
    pub start: usize,
    pub end: usize,
    pub params: Vec<String>,
    pub entry: usize,
    pub exit: usize,
    pub blocks: Vec<FlowBlock>,
    pub stmts: Vec<FlowStmt>,
    pub edges: Vec<CondEdge>,
    pub trees: Vec<EN>,
    pub unsupported: Vec<Unsup>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FlowFacts {
    pub schema_id: String,
    pub schema_version: u32,
    pub analyzer_version: String,
    pub language: String,
    pub files_total: usize,
    pub files_analysed: usize,
    pub functions: Vec<FlowFn>,
    pub skipped: Vec<Skipped>,
    pub stopped_by: Option<String>,
    #[serde(default)]
    pub artifact_hash: String,
}
impl FlowFacts {
    /// The hash covers everything except the hash itself, serialized canonically (fixed field order from the
    /// struct): identical code + analyzer version → identical artifact bytes → identical hashes.
    pub fn hash_of(&self) -> String {
        let mut clone = self.clone();
        clone.artifact_hash = String::new();
        let bytes = serde_json::to_vec(&clone).unwrap_or_default();
        sha(&bytes)
    }
    pub fn with_hash(mut self) -> Self { let h = self.hash_of(); self.artifact_hash = h; self }
}

// -------------------------------------------------------------------------- rule pack reader
// Node owns JSON-schema validation (spec D7: unknown rule fields rejected in Node). The worker reads
// tolerantly: absent sections are empty, so a minimal pack still runs end to end.

#[derive(Debug, Clone, Default)]
pub struct Pack {
    pub pack_id: String,
    pub version: u32,
    pub classes: Vec<PackClass>,
    pub sources: Vec<PackSource>,
    pub sinks: Vec<PackSink>,
    pub sanitizers: Vec<PackSanitizer>,
    pub structural: Vec<PackStructural>,
    pub known_safe: Vec<PackSafe>,
    pub guards: Vec<PackGuard>,
}
#[derive(Debug, Clone)]
pub struct PackClass { pub id: String, pub cwe: u32, pub title: String, pub rule_id: String, pub severity: String }
#[derive(Debug, Clone)]
pub struct PackSource { pub id: String, pub pattern: String, pub param: Option<String>, pub label: String }
#[derive(Debug, Clone)]
pub struct PackSink { pub id: String, pub class: String, pub pattern: String, pub sensitive_args: Vec<usize>, pub label: String, pub shell_true: bool }
#[derive(Debug, Clone)]
pub struct PackSanitizer { pub id: String, pub classes: Vec<String>, pub pattern: String }
#[derive(Debug, Clone)]
pub struct PackStructural { pub id: String, pub classes: Vec<String>, pub pattern: String, pub arg_index: usize }
#[derive(Debug, Clone)]
pub struct PackSafe { pub pattern: String, pub classes: Vec<String> }
#[derive(Debug, Clone)]
pub struct PackGuard { pub pattern: String, pub classes: Vec<String>, pub description: String }

pub fn pack_from_json(v: &Value) -> Pack {
    let s = |p: &Value, k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let strs = |p: &Value, k: &str| -> Vec<String> {
        p.get(k).and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default()
    };
    let mut pack = Pack { pack_id: s(v, "packId"), version: v.get("version").and_then(Value::as_u64).unwrap_or(0) as u32, ..Default::default() };
    for c in v.get("classes").and_then(Value::as_array).unwrap_or(&vec![]) {
        pack.classes.push(PackClass {
            id: s(c, "id"), cwe: c.get("cwe").and_then(Value::as_u64).unwrap_or(0) as u32, title: s(c, "title"),
            rule_id: s(c, "ruleId"), severity: s(c, "severity"),
        });
    }
    for x in v.get("sources").and_then(Value::as_array).unwrap_or(&vec![]) {
        pack.sources.push(PackSource { id: s(x, "id"), pattern: s(x, "match"), param: x.get("param").and_then(Value::as_str).map(String::from), label: s(x, "label") });
    }
    for x in v.get("sinks").and_then(Value::as_array).unwrap_or(&vec![]) {
        let mut sensitive_args = x.get("sensitiveArgs").and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_u64).map(|n| n as usize).collect::<Vec<_>>());
        if sensitive_args.as_ref().map(|v| v.is_empty()).unwrap_or(false) { sensitive_args = None; }
        pack.sinks.push(PackSink { id: s(x, "id"), class: s(x, "class"), pattern: s(x, "match"), sensitive_args: sensitive_args.unwrap_or_else(|| vec![0]), label: s(x, "label"), shell_true: s(x, "requireShellTrue") == "true" });
    }
    for x in v.get("sanitizers").and_then(Value::as_array).unwrap_or(&vec![]) {
        if s(x, "kind") == "structural" {
            pack.structural.push(PackStructural { id: s(x, "id"), classes: strs(x, "classes"), pattern: s(x, "match"), arg_index: x.get("argIndex").and_then(Value::as_u64).unwrap_or(1) as usize });
        } else {
            pack.sanitizers.push(PackSanitizer { id: s(x, "id"), classes: strs(x, "classes"), pattern: s(x, "match") });
        }
    }
    for x in v.get("knownSafeCalls").and_then(Value::as_array).unwrap_or(&vec![]) {
        pack.known_safe.push(PackSafe { pattern: s(x, "match"), classes: strs(x, "classes") });
    }
    for x in v.get("guards").and_then(Value::as_array).unwrap_or(&vec![]) {
        pack.guards.push(PackGuard { pattern: s(x, "match"), classes: strs(x, "classes"), description: x.get("description").and_then(Value::as_str).unwrap_or("").to_string() });
    }
    pack
}

impl Pack {
    fn class_index(&self, id: &str) -> Option<u16> { self.classes.iter().position(|c| c.id == id).map(|i| i as u16) }
    fn class_of(&self, i: u16) -> Option<&PackClass> { self.classes.get(i as usize) }
    fn sink_class_index(&self, sink: &PackSink) -> Option<u16> { self.class_index(&sink.class) }
}

// -------------------------------------------------------------------------- budget

#[derive(Debug, Clone)]
pub struct Budget {
    pub max_functions: usize,
    pub max_files: usize,
    pub wall_ms: u64,
    pub summary_max_passes: usize,
    pub max_findings: usize,
    pub max_paths: usize,
    pub max_path_steps: usize,
    pub max_alts: usize,
}


#[derive(Clone, Debug, PartialEq, Eq)]
enum Origin {
    Param(usize, usize),
    Src(u32),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct VEnt { san: BTreeSet<u16>, heads: Vec<u32> }

type Val = BTreeMap<Origin, VEnt>;

#[derive(Debug, Clone)]
struct InE {
    from: usize,
    cond: Option<(String, Option<bool>)>,
}

type Cont = Vec<InE>;

const ENTRY: usize = 0;
const EXIT: usize = 1;
/// Sentinel for "no catch handler" in the catch stack.
const DEFAULT_USIZE: usize = usize::MAX;
pub const STOP_WALL_TIME: &str = "wallTimeBudget";
pub const STOP_FUNCTION_BUDGET: &str = "functionBudget";

/// A statement falls through to this block id: the continuation every non-jumping statement hands back.
fn fallthrough(id: usize) -> Cont { vec![InE::plain(id)] }
/// The block ids a continuation points at (for joining branches into a merge block).
fn blk_ids(c: Cont) -> Vec<usize> { c.into_iter().map(|e| e.from).collect() }
/// The CFG builder starts with no incoming edges.
fn entry_cont() -> Cont { vec![] }

fn bget(v: &Value, key: &str) -> Option<u64> { v.get(key).and_then(|x| x.as_f64()).map(|n| n.max(0.0) as u64) }

impl Default for Budget {
    fn default() -> Self {
        Budget {
            max_functions: 20_000, max_files: 5_000, wall_ms: 300_000, summary_max_passes: 3,
            max_findings: 200, max_paths: 400, max_path_steps: 60, max_alts: 12,
        }
    }
}

pub fn budget_from_json(v: Option<&Value>) -> Budget {
    let mut b = Budget::default();
    if let Some(v) = v {
        if let Some(n) = bget(v, "maxFunctions") { b.max_functions = n.max(1) as usize; }
        if let Some(n) = bget(v, "maxFiles") { b.max_files = n.max(1) as usize; }
        if let Some(n) = bget(v, "wallMs") { b.wall_ms = n.max(1); }
        if let Some(n) = bget(v, "summaryMaxPasses") { b.summary_max_passes = n.max(1) as usize; }
        if let Some(n) = bget(v, "maxFindings") { b.max_findings = n.max(1) as usize; }
        if let Some(n) = bget(v, "maxPaths") { b.max_paths = n.max(1) as usize; }
        if let Some(n) = bget(v, "maxPathSteps") { b.max_path_steps = n.max(1) as usize; }
    }
    b
}

// -------------------------------------------------------------------------- chain normalisation & matching

/// Strip whitespace and optional chaining from a written chain, keeping bracket segments (`argv[2]`).
pub fn normalise_chain(t: &str) -> String {
    let no_ws: String = t.chars().filter(|c| !c.is_whitespace()).collect();
    let s = no_ws.trim_start_matches("await ").to_string();
    s.replace("?.", ".").replace(",.", ".")
}

pub fn chain_segments(norm: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut cur = String::new();
    let mut depth = 0usize;
    for c in norm.chars() {
        match c {
            '[' | '(' | '{' => { depth += 1; cur.push(c); }
            ']' | ')' | '}' => { depth = depth.saturating_sub(1); cur.push(c); if depth == 0 { out.push(std::mem::take(&mut cur)); } }
            '.' if depth == 0 => { if !cur.is_empty() { out.push(std::mem::take(&mut cur)); } }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() { out.push(cur); }
    out.into_iter().filter(|s| !s.is_empty()).collect()
}
pub fn norm_segments(t: &str) -> Vec<String> { chain_segments(&normalise_chain(t)) }

/// A sink/sanitizer match is `name(arg0)` or `[recv.]name(arg0)`; a leading `$` makes the receiver a wildcard:
/// `$db.query` matches `db.query`, `this.db.query`, `conn.db.query`.
fn parse_match_pattern(m: &str) -> Vec<String> {
    let head = m.split('(').next().unwrap_or("");
    let chain = head.trim();
    if chain.starts_with('$') && !chain.starts_with("$.") {
        let mut segs = norm_segments(&format!("$x.{}", &chain[1..]));
        segs[0] = "$".into();
        segs
    } else {
        norm_segments(chain)
    }
}
fn chain_matches(pattern: &[String], chain: &[String]) -> bool {
    if pattern.is_empty() || chain.is_empty() { return false; }
    if pattern[0] == "$" {
        let tail = &pattern[1..];
        return chain.len() >= tail.len() && chain[chain.len() - tail.len()..] == *tail;
    }
    pattern == chain
}

/// A source pattern is a member chain ending in `*` (consumes ≥ 1 remaining segments, including a bracket
/// segment such as `argv[2]`) or an exact property chain of ≥ 2 segments (`req.body`).
fn leaf_matches_source(pattern: &str, leaf: &str) -> bool {
    let p = norm_segments(pattern);
    let l = norm_segments(leaf);
    let wildcard = p.last().map(|s| s == "*" || s == "[*]").unwrap_or(false);
    if !wildcard { return p.len() >= 2 && p.len() == l.len() && p == l; }
    if l.len() < p.len() { return false; }
    for i in 0..p.len() - 1 { if l[i] != p[i] { return false; } }
    true
}

// -------------------------------------------------------------------------- per-file extraction walk

#[derive(Debug, Clone, Default)]
struct RSym {
    kind: &'static str,
    qualified: String,
    start: usize,
    end: usize,
    fn_start: Option<usize>, // index into facts.functions (None for non-function symbols)
    id: String,
}

#[derive(Debug, Clone, Default)]
struct RImp { module: String, local: String, imported: String }

struct FileX<'a> {
    src: &'a str,
    file: String,
    fns: Vec<FlowFn>,
    syms: Vec<RSym>,
    imports: Vec<RImp>,
    class_stack: Vec<String>,
    skips: Vec<Skipped>,
}

impl<'a> FileX<'a> {
    fn new(file: String, src: &'a str) -> Self {
        FileX { src, file, fns: vec![], syms: vec![], imports: vec![], class_stack: vec![], skips: vec![] }
    }
    fn text(&self, n: Node) -> String { n.utf8_text(self.src.as_bytes()).unwrap_or("").to_string() }

    /// Walk order mirrors language.rs's `visit` so symbol ids (kind:rel#qual, duplicates `@start`) line up
    /// with the store's entities.
    fn walk(&mut self, node: Node) {
        match node.kind() {
            "import_statement" => self.import(node),
            "export_statement" => { for ch in children(node) { self.walk(ch); } }
            "function_declaration" | "generator_function_declaration" => {
                if let Some(nm) = node.child_by_field_name("name") {
                    let fn_ix = self.fns.len();
                    self.push_sym("function", self.text(nm), node, Some(fn_ix));
                    self.extract_fn(node, "function", self.text(nm));
                }
            }
            "class_declaration" | "abstract_class_declaration" => {
                if let Some(nm) = node.child_by_field_name("name") {
                    let cname = self.text(nm);
                    self.push_sym("class", cname.clone(), node, None);
                    self.class_stack.push(cname);
                    for ch in children(node) { self.walk(ch); }
                    self.class_stack.pop();
                }
            }
            "interface_declaration" => { if let Some(nm) = node.child_by_field_name("name") { self.push_sym("interface", self.text(nm), node, None); } }
            "type_alias_declaration" => { if let Some(nm) = node.child_by_field_name("name") { self.push_sym("type", self.text(nm), node, None); } }
            "enum_declaration" => { if let Some(nm) = node.child_by_field_name("name") { self.push_sym("enum", self.text(nm), node, None); } }
            "method_definition" => {
                if let Some(nm) = node.child_by_field_name("name") {
                    let name = self.text(nm);
                    let qualified = match self.class_stack.last() { Some(c) => format!("{c}.{name}"), None => name.clone() };
                    let fn_ix = self.fns.len();
                    self.push_sym("method", qualified.clone(), node, Some(fn_ix));
                    self.extract_fn(node, "method", qualified);
                }
            }
            "lexical_declaration" | "variable_declaration" => {
                for decl in children(node).into_iter().filter(|d| d.kind() == "variable_declarator") {
                    let name = decl.child_by_field_name("name").map(|n| self.text(n));
                    let val = decl.child_by_field_name("value");
                    if let (Some(name), Some(v)) = (name, val) {
                        if matches!(v.kind(), "arrow_function" | "function_expression" | "function") {
                            let fn_ix = self.fns.len();
                            self.push_sym("function", name.clone(), v, Some(fn_ix));
                            self.extract_fn(v, "function", name);
                        } else if matches!(v.kind(), "class_declaration" | "class") {
                            self.walk(v);
                        }
                    }
                }
            }
            "comment" => {}
            _ => { for ch in children(node) { self.walk(ch); } }
        }
    }

    fn push_sym(&mut self, kind: &'static str, qualified: String, node: Node, fn_start: Option<usize>) {
        self.syms.push(RSym { kind, qualified, start: node.start_byte(), end: node.end_byte(), fn_start, id: String::new() });
    }

    fn import(&mut self, node: Node) {
        let Some(srcn) = node.child_by_field_name("source") else { return };
        let module = self.text(srcn).trim_matches(|c| c == '"' || c == '\'').to_string();
        for part in children(node) {
            match part.kind() {
                "identifier" => self.imports.push(RImp { module: module.clone(), local: self.text(part), imported: "default".into() }),
                "namespace_import" => { if let Some(id) = children(part).into_iter().find(|n| n.kind() == "identifier") { self.imports.push(RImp { module: module.clone(), local: self.text(id), imported: "*".into() }); } }
                "named_imports" => {
                    for spec in children(part).into_iter().filter(|n| n.kind() == "import_specifier") {
                        let name = spec.child_by_field_name("name").map(|n| self.text(n));
                        let alias = spec.child_by_field_name("alias").map(|n| self.text(n));
                        if let Some(name) = name {
                            self.imports.push(RImp { module: module.clone(), local: alias.unwrap_or_else(|| name.clone()), imported: name });
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn extract_fn(&mut self, fnnode: Node, kind: &'static str, qualified: String) {
        if fnnode.end_byte() - fnnode.start_byte() > MAX_BODY_BYTES {
            self.skips.push(Skipped { file: self.file.clone(), reason: SKIP_TOO_LARGE.into(), at: Some(fnnode.start_byte()), end: Some(fnnode.end_byte()), ..Default::default() });
            return;
        }
        let params = parameters_of(fnnode, self.src);
        let body = fnnode.child_by_field_name("body");
        self.fns.push(FlowFn {
            id: String::new(),
            file: self.file.clone(),
            name: qualified.clone(),
            kind: kind.to_string(),
            class: self.class_stack.last().cloned(),
            start: fnnode.start_byte(),
            end: fnnode.end_byte(),
            params: params.clone(),
            ..Default::default()
        });
        let ix = self.fns.len() - 1;
        let mut b = FnBuild::new(self.src);
        match body {
            Some(body) if body.kind() == "statement_block" => { let _ = b.stmt_seq(body, entry_cont()); }
            Some(body) => {
                // expression-bodied arrow: implicit return
                let t = b.expr(body);
                b.blocks[ENTRY].stmts.push(b.stmts.len());
                b.stmts.push(FlowStmt { block: ENTRY, at: body.start_byte(), end: body.end_byte(), trees: vec![t], rets: Some(t) });
                b.link(ENTRY, EXIT, None);
            }
            None => {}
        }
        let (blocks, stmts, edges, trees, unsupported, toomany, nested) = b.into_parts();
        if toomany || trees.len() > MAX_TREES_PER_FN {
            self.fns.pop();
            self.syms.pop();
            self.skips.push(Skipped { file: self.file.clone(), reason: SKIP_TOO_LARGE.into(), at: Some(fnnode.start_byte()), end: Some(fnnode.end_byte()), ..Default::default() });
            return;
        }
        self.fns[ix].entry = ENTRY;
        self.fns[ix].exit = EXIT;
        self.fns[ix].blocks = blocks;
        self.fns[ix].stmts = stmts;
        self.fns[ix].edges = edges;
        self.fns[ix].trees = trees;
        self.fns[ix].unsupported = unsupported;
        // nested closures/functions extracted AFTER the enclosing symbol (same order as language.rs's walk)
        for (node, kind, qualified) in nested {
            self.extract_fn(node, kind, qualified);
        }
    }

}

fn children(n: Node) -> Vec<Node> { n.named_children(&mut n.walk()).collect() }

fn parameters_of(node: Node, src: &str) -> Vec<String> {
    let Some(pl) = node.child_by_field_name("parameters") else { return vec![] };
    let mut out = vec![];
    for p in pl.named_children(&mut pl.walk()) {
        match p.kind() {
            "required_parameter" | "optional_parameter" => {
                if let Some(pat) = p.child_by_field_name("pattern") {
                    out.push(param_name(&pat.utf8_text(src.as_bytes()).unwrap_or("")));
                }
            }
            "identifier" | "pattern" => out.push(param_name(&p.utf8_text(src.as_bytes()).unwrap_or(""))),
            "rest_pattern" | "object_pattern" | "array_pattern" => out.push(param_name(&p.utf8_text(src.as_bytes()).unwrap_or(""))),
            _ => {}
        }
    }
    out
}
fn param_name(t: &str) -> String {
    let t = t.trim_start_matches("...");
    let t = t.split('?').next().unwrap_or(t);
    let t = t.split(':').next().unwrap_or(t);
    let mut t = t.split('=').next().unwrap_or(t).trim();
    if t.len() >= 2 && (t.starts_with('"') || t.starts_with('\'')) { t = &t[1..t.len() - 1]; }
    normalise_identifier(t)
}
fn normalise_identifier(t: &str) -> String { normalise_chain(t) }

// -------------------------------------------------------------------------- CFG builder for one function

#[derive(Debug, Clone)]

struct FnBuild<'a, 't> {
    src: &'a str,
    blocks: Vec<FlowBlock>,
    stmts: Vec<FlowStmt>,
    edges: Vec<CondEdge>,
    trees: Vec<EN>,
    unsupported: Vec<Unsup>,
    catch_stack: Vec<usize>, // catch entry blocks, innermost last
    brk_stack: Vec<usize>,
    cont_stack: Vec<usize>,
    toomany: bool,
    nested: Vec<(Node<'t>, &'static str, String)>, // function-like nodes to extract after this one
}

impl<'a, 't> FnBuild<'a, 't> {
    fn new(src: &'a str) -> Self {
        FnBuild {
            src,
            blocks: vec![FlowBlock::default(), FlowBlock::default()], // ENTRY=0, EXIT=1
            stmts: vec![], edges: vec![], trees: vec![], unsupported: vec![],
            catch_stack: vec![], brk_stack: vec![], cont_stack: vec![], toomany: false, nested: vec![],
        }
    }
    fn text(&self, n: Node) -> String { n.utf8_text(self.src.as_bytes()).unwrap_or("").to_string() }

    fn link(&mut self, from: usize, to: usize, cond: Option<(String, Option<bool>)>) {
        if from == to || from >= self.blocks.len() || to >= self.blocks.len() { return; }
        let (c, p) = cond.map(|(t, b)| (Some(t), b)).unwrap_or((None, None));
        self.edges.push(CondEdge { from, to, cond: c, pos: p });
    }

    /// Create a block for the next statement and link all incoming edges into it.
    fn nb(&mut self, incoming: Cont) -> usize {
        let id = self.blocks.len();
        self.blocks.push(FlowBlock::default());
        for InE { from, cond } in incoming { self.link(from, id, cond); }
        if self.blocks.len() > MAX_BLOCKS_PER_FN { self.toomany = true; }
        id
    }

    /// Record one statement (trees pre-lowered) in a fresh block.
    fn add_stmt(&mut self, node: Node, trees: Vec<usize>, incoming: Cont) -> usize {
        let id = self.nb(incoming);
        self.blocks[id].stmts.push(self.stmts.len());
        self.stmts.push(FlowStmt { block: id, at: node.start_byte(), end: node.end_byte(), trees, rets: None });
        id
    }

    fn stmt_seq(&mut self, list: Node<'t>, mut incoming: Cont) -> Cont {
        for ch in stmt_kids(list) {
            if self.toomany { return vec![]; }
            incoming = self.one_stmt(ch, incoming);
        }
        incoming
    }

    fn one_stmt(&mut self, node: Node<'t>, incoming: Cont) -> Cont {
        if self.toomany { return vec![]; }
        match node.kind() {
            "comment" | "empty_statement" | "import_statement" | "export_statement" | "debugger_statement" => incoming,
            "function_declaration" | "generator_function_declaration" => {
                if let Some(nm) = node.child_by_field_name("name") {
                    self.nested.push((node, "function", self.text(nm)));
                }
                incoming
            }
            "class_declaration" | "abstract_class_declaration" => {
                if let Some(nm) = node.child_by_field_name("name") {
                    self.nested.push((node, "class-ignored", self.text(nm)));
                }
                incoming
            }
            "lexical_declaration" | "variable_declaration" => {
                let mut trees = vec![];
                for decl in children(node).into_iter().filter(|d| d.kind() == "variable_declarator") {
                    match (decl.child_by_field_name("name"), decl.child_by_field_name("value")) {
                        (Some(name), Some(value)) => {
                            if matches!(name.kind(), "object_pattern" | "array_pattern") {
                                self.pattern_defs(name, self.text(value), matches!(value.kind(), "string" | "number"), decl.start_byte(), decl.end_byte(), &mut trees);
                            } else if matches!(value.kind(), "arrow_function" | "function_expression" | "function") {
                                self.nested.push((value, "closure", self.text(name)));
                            } else {
                                trees.push(self.def_tree(&self.text(name), value));
                            }
                        }
                        (Some(name), None) => { trees.push(self.expr(name)); }
                        _ => {}
                    }
                }
                let id = self.add_stmt(node, trees, incoming);
                fallthrough(id)
            }
            "expression_statement" => {
                let mut trees = vec![];
                for ch in children(node) {
                    match ch.kind() {
                        "assignment_expression" | "augmented_assignment_expression" => trees.push(self.assign_tree(ch)),
                        "arrow_function" | "function_expression" | "function" => { self.nested.push((ch, "closure", String::new())); }
                        _ => trees.push(self.expr(ch)),
                    }
                }
                let id = self.add_stmt(node, trees, incoming);
                fallthrough(id)
            }
            "return_statement" => {
                let mut trees = vec![];
                if let Some(v) = children(node).into_iter().next() { trees.push(self.expr(v)); }
                let id = self.add_stmt(node, trees, incoming);
                let rets = self.stmts.last().map(|s| s.trees.first().copied()).flatten();
                if let Some(r) = rets { self.stmts.last_mut().unwrap().rets = Some(r); }
                self.link(id, EXIT, None);
                vec![]
            }
            "break_statement" => {
                let id = self.add_stmt(node, vec![], incoming);
                if let Some(&t) = self.brk_stack.last() { self.link(id, t, None); }
                vec![]
            }
            "continue_statement" => {
                let id = self.add_stmt(node, vec![], incoming);
                if let Some(&t) = self.cont_stack.last() { self.link(id, t, None); }
                vec![]
            }
            "throw_statement" => {
                let mut trees = vec![];
                if let Some(first) = children(node).into_iter().next() { trees.push(self.expr(first)); }
                let id = self.add_stmt(node, trees, incoming);
                if let Some(&ce) = self.catch_stack.last() {
                    if ce != DEFAULT_USIZE { self.link(id, ce, Some(("throw".into(), None))); }
                }
                vec![]
            }
            "if_statement" => {
                let cond_node = node.child_by_field_name("condition");
                let cond_text = cond_node.map(|c| self.text(c)).unwrap_or_default();
                let cb = self.nb(incoming);
                let cond_tree = cond_node.map(|c| self.expr(c));
                self.blocks[cb].stmts.push(self.stmts.len());
                self.stmts.push(FlowStmt { block: cb, at: node.start_byte(), end: cond_node.map(|c| c.end_byte()).unwrap_or(node.end_byte()), trees: cond_tree.into_iter().collect(), rets: None });
                if let Some(Some(cond_tree)) = cond_tree.map(Some) { let _ = cond_tree; }
                let mut t_in = vec![InE { from: cb, cond: Some((cond_text.clone(), Some(true))) }];
                let mut f_in = vec![InE { from: cb, cond: Some((cond_text, Some(false))) }];
                let mut tails = vec![];
                match node.child_by_field_name("consequence") {
                    Some(b) => tails.extend(blk_ids(self.stmt_seq(b, std::mem::take(&mut t_in)))),
                    None => tails.extend(std::mem::take(&mut t_in).into_iter().map(|e| e.from)),
                }
                match node.child_by_field_name("alternative") {
                    Some(a) => tails.extend(blk_ids(self.stmt_seq(a, std::mem::take(&mut f_in)))),
                    None => tails.extend(std::mem::take(&mut f_in).into_iter().map(|e| e.from)),
                }
                let merge = self.nb(tails.into_iter().map(InE::plain).collect());
                fallthrough(merge)
            }
            "while_statement" => self.loop_stmt(node, incoming),
            "for_statement" | "for_in_statement" | "for_of_statement" => self.loop_for(node, incoming),
            "do_statement" => self.do_stmt(node, incoming),
            "switch_statement" => self.switch_stmt(node, incoming),
            "try_statement" => self.try_stmt(node, incoming),
            "statement_block" => self.stmt_seq(node, incoming),
            "labeled_statement" => {
                if let Some(inner) = children(node).into_iter().last() { return self.one_stmt(inner, incoming); }
                incoming
            }
            other => {
                let _ = other;
                let mut trees = vec![];
                for ch in children(node) { trees.push(self.expr(ch)); }
                let id = self.add_stmt(node, trees, incoming);
                fallthrough(id)
            }
        }
    }

    fn loop_stmt(&mut self, node: Node<'t>, incoming: Cont) -> Cont {
        let mut incoming = incoming;
        // `for (let i = 0; …)`: the initializer runs once, before the first header evaluation
        if let Some(init) = node.child_by_field_name("init") {
            if matches!(init.kind(), "lexical_declaration" | "variable_declaration") {
                let mut trees = vec![];
                for decl in children(init).into_iter().filter(|d| d.kind() == "variable_declarator") {
                    if let (Some(name), Some(value)) = (decl.child_by_field_name("name"), decl.child_by_field_name("value")) {
                        if matches!(name.kind(), "object_pattern" | "array_pattern") {
                            self.pattern_defs(name, self.text(value), matches!(value.kind(), "string" | "number"), init.start_byte(), init.end_byte(), &mut trees);
                        } else {
                            trees.push(self.def_tree(&self.text(name), value));
                        }
                    }
                }
                let ib = self.add_stmt(init, trees, std::mem::take(&mut incoming));
                incoming = fallthrough(ib);
            } else if init.kind() != "empty_statement" {
                let t = self.expr(init);
                let ib = self.add_stmt(init, vec![t], std::mem::take(&mut incoming));
                incoming = fallthrough(ib);
            }
        }
        let merge = self.nb(vec![]);
        let h = self.nb(incoming);
        let mut cond_trees = vec![];
        let mut cond_text: Option<String> = None;
        if let Some(c) = node.child_by_field_name("condition") {
            cond_trees.push(self.expr(c));
            cond_text = Some(self.text(c));
        }
        self.blocks[h].stmts.push(self.stmts.len());
        self.stmts.push(FlowStmt { block: h, at: node.start_byte(), end: node.end_byte(), trees: cond_trees, rets: None });
        self.link(h, merge, cond_text.clone().map(|c| (c, Some(false))));
        self.brk_stack.push(merge);
        self.cont_stack.push(h);
        let body_in = vec![InE { from: h, cond: cond_text.map(|c| (c, Some(true))) }];
        let body = node.child_by_field_name("body");
        let mut body_cont = match body { Some(b) => self.stmt_seq(b, body_in.clone()), None => body_in };
        self.brk_stack.pop();
        self.cont_stack.pop();
        // `for` update runs after each pass, then returns to the header
        let has_update = node.child_by_field_name("update");
        if let Some(u) = has_update {
            let ub = self.nb(blk_ids(std::mem::take(&mut body_cont)).into_iter().map(InE::plain).collect());
            let _ = self.expr(u);
            self.blocks[ub].stmts.push(self.stmts.len());
            self.stmts.push(FlowStmt { block: ub, at: u.start_byte(), end: u.end_byte(), trees: vec![], rets: None });
            self.link(ub, h, None);
        } else {
            for b in blk_ids(std::mem::take(&mut body_cont)) { self.link(b, h, None); }
        }
        fallthrough(merge)
    }

    fn loop_for(&mut self, node: Node<'t>, incoming: Cont) -> Cont {
        if node.kind() == "for_statement" && node.child_by_field_name("condition").is_some() {
            return self.loop_stmt(node, incoming);
        }
        // for-in / for-of / condition-less for: the header block defines the iteration variable
        let merge = self.nb(vec![]);
        let hb = self.nb(incoming);
        let mut trees = vec![];
        if let Some(init) = node.child_by_field_name("init") {
            if matches!(init.kind(), "lexical_declaration" | "variable_declaration") {
                for decl in children(init).into_iter().filter(|d| d.kind() == "variable_declarator") {
                    if let (Some(name), Some(value)) = (decl.child_by_field_name("name"), decl.child_by_field_name("value")) {
                        if matches!(name.kind(), "object_pattern" | "array_pattern") {
                            self.pattern_defs(name, self.text(value), false, init.start_byte(), init.end_byte(), &mut trees);
                        } else {
                            trees.push(self.def_tree(&self.text(name), value));
                        }
                    }
                }
            } else if init.kind() != "empty_statement" {
                trees.push(self.expr(init));
            }
        }
        if matches!(node.kind(), "for_in_statement" | "for_of_statement") {
            if let (Some(left), Some(right)) = (node.child_by_field_name("left"), node.child_by_field_name("right")) {
                let r = self.text(right);
                for item in pattern_items(left) {
                    trees.push(self.def_leaf(&item, &format!("{r}[*]"), left.start_byte(), right.end_byte()));
                }
            }
        }
        self.blocks[hb].stmts.push(self.stmts.len());
        self.stmts.push(FlowStmt { block: hb, at: node.start_byte(), end: node.end_byte(), trees, rets: None });
        self.link(hb, merge, Some(("iteration".into(), Some(false))));
        let body = node.child_by_field_name("body");
        self.brk_stack.push(merge);
        self.cont_stack.push(hb);
        let body_cont = match body {
            Some(b) => self.stmt_seq(b, vec![InE { from: hb, cond: Some(("iteration".into(), Some(true))) }]),
            None => vec![InE { from: hb, cond: Some(("iteration".into(), Some(true))) }],
        };
        self.brk_stack.pop();
        self.cont_stack.pop();
        for b in blk_ids(body_cont) { self.link(b, hb, None); }
        fallthrough(merge)
    }

    fn do_stmt(&mut self, node: Node<'t>, incoming: Cont) -> Cont {
        let merge = self.nb(vec![]);
        let h = self.nb(vec![]); // condition block, pre-created so `continue` can target it
        let snap = self.blocks.len();
        self.brk_stack.push(merge);
        self.cont_stack.push(h);
        let body = node.child_by_field_name("body");
        let body_cont = match body { Some(b) => self.stmt_seq(b, incoming), None => incoming };
        self.brk_stack.pop();
        self.cont_stack.pop();
        for b in blk_ids(body_cont) { self.link(b, h, None); }
        if let Some(c) = node.child_by_field_name("condition") {
            let t = self.expr(c);
            self.blocks[h].stmts.push(self.stmts.len());
            self.stmts.push(FlowStmt { block: h, at: c.start_byte(), end: c.end_byte(), trees: vec![t], rets: None });
            let cond_text = self.text(c);
            self.link(h, merge, Some((cond_text.clone(), Some(false))));
            self.link(h, snap, Some((cond_text, Some(true)))); // back edge into the body's first block
        } else {
            self.link(h, merge, None);
        }
        fallthrough(merge)
    }
    fn switch_stmt(&mut self, node: Node<'t>, incoming: Cont) -> Cont {
        let cblk = self.nb(incoming);
        if let Some(d) = node.child_by_field_name("discriminant") {
            let t = self.expr(d);
            self.blocks[cblk].stmts.push(self.stmts.len());
            self.stmts.push(FlowStmt { block: cblk, at: node.start_byte(), end: node.end_byte(), trees: vec![t], rets: None });
        }
        let body = node.child_by_field_name("body");
        let cases: Vec<Node> = match body { Some(b) => children(b).into_iter().filter(|x| matches!(x.kind(), "switch_case" | "switch_default")).collect(), None => vec![] };
        let merge = self.nb(vec![]);
        self.brk_stack.push(merge);
        let mut prev_tails: Vec<usize> = vec![];
        for case in cases {
            let is_default = case.kind() == "switch_default";
            let cond_text = if is_default { "default".to_string() } else { case.child_by_field_name("value").map(|v| self.text(v)).unwrap_or_default() };
            let mut case_in: Cont = vec![InE { from: cblk, cond: Some((if is_default { "default".into() } else { format!("case {cond_text}") }, None)) }];
            for t in prev_tails.drain(..) { case_in.push(InE { from: t, cond: None }); } // fall-through
            let case_body = case.child_by_field_name("body");
            let out = match case_body {
                Some(b) => self.stmt_seq(b, case_in),
                None => case_in,
            };
            prev_tails = blk_ids(out);
        }
        self.brk_stack.pop();
        for t in prev_tails { self.link(t, merge, None); }
        fallthrough(merge)
    }

    fn try_stmt(&mut self, node: Node<'t>, incoming: Cont) -> Cont {
        let has_handler = node.child_by_field_name("handler").is_some();
        let has_finalizer = node.child_by_field_name("finalizer").is_some();
        let ce = if has_handler { let b = self.nb(vec![]); Some(b) } else { None };
        let fe = if has_finalizer { let b = self.nb(vec![]); Some(b) } else { None };
        let snap = self.blocks.len();
        let saved = self.catch_stack.clone();
        if let Some(ce) = ce { self.catch_stack.push(ce); } else { self.catch_stack.push(DEFAULT_USIZE); }
        let body = node.child_by_field_name("body");
        let body_cont = match body { Some(b) => self.stmt_seq(b, incoming), None => incoming };
        self.catch_stack = saved;
        // exception edges from every statement block created inside the try body
        for b in snap..self.blocks.len() {
            if !self.blocks[b].stmts.is_empty() {
                if let Some(ce) = ce { self.link(b, ce, Some(("exception (may throw)".into(), None))); }
            }
        }
        let mut tails = blk_ids(body_cont);
        if let Some(handler) = node.child_by_field_name("handler") {
            let cb = handler.child_by_field_name("body");
            let c_cont = match cb { Some(b) => self.stmt_seq(b, vec![InE { from: ce.unwrap_or(DEFAULT_USIZE), cond: None }]), None => vec![] };
            tails.extend(blk_ids(c_cont));
        }
        match fe {
            Some(f) => {
                for t in &tails { self.link(*t, f, None); }
                match node.child_by_field_name("finalizer") {
                    Some(b) => self.stmt_seq(b, vec![InE { from: f, cond: None }]),
                    None => vec![InE { from: f, cond: None }],
                }
            }
            None => tails.into_iter().map(InE::plain).collect(),
        }
    }

    // ------------------------------------------------------------------ expression lowering

    fn expr(&mut self, n: Node<'t>) -> usize {
        let at = n.start_byte();
        let end = n.end_byte();
        match n.kind() {
            "identifier" | "this" | "shorthand_property_identifier" | "property_identifier" | "private_property_identifier" => {
                self.push_en(EN { k: 0, t: normalise_chain(&self.text(n)), at, end, ..Default::default() })
            }
            "string" | "number" | "true" | "false" | "null" | "undefined" | "no_template_literal" | "regex_pattern" | "string_fragment" | "escape_sequence" => {
                self.push_en(EN { k: 4, t: self.text(n), at, end, ..Default::default() })
            }
            "parenthesized_expression" | "as_expression" | "type_assertion" | "non_null_expression" | "satisfies_expression" => {
                match children(n).into_iter().next() {
                    Some(inner) => self.expr(inner),
                    None => self.push_en(EN { k: 4, t: String::new(), at, end, ..Default::default() }),
                }
            }
            "member_expression" => {
                let (Some(obj), Some(prop)) = (n.child_by_field_name("object"), n.child_by_field_name("property")) else {
                    return self.push_en(EN { k: 3, t: normalise_chain(&self.text(n)), at, end, ..Default::default() });
                };
                if is_pure_chain(obj) {
                    let t = normalise_chain(&format!("{}.{}", self.text(obj), self.text(prop)));
                    self.push_en(EN { k: 0, t, at, end, ..Default::default() })
                } else {
                    let ok = self.expr(obj);
                    let pk = self.push_en(EN { k: 0, t: normalise_chain(&self.text(prop)), at: prop.start_byte(), end: prop.end_byte(), ..Default::default() });
                    self.push_en(EN { k: 2, t: "member".into(), at, end, kids: vec![ok, pk], ..Default::default() })
                }
            }
            "subscript_expression" => {
                let (Some(obj), Some(idx)) = (n.child_by_field_name("object"), n.child_by_field_name("index")) else {
                    return self.push_en(EN { k: 3, t: normalise_chain(&self.text(n)), at, end, ..Default::default() });
                };
                let is_lit = matches!(idx.kind(), "string" | "number");
                if is_pure_chain(obj) && is_lit {
                    let idxt = self.text(idx);
                    let lit = normalise_chain(&idxt).trim_matches(|c| c == '"' || c == '\'').to_string();
                    let t = if idxt.trim().parse::<usize>().is_ok() {
                        format!("{}[{}]", normalise_chain(&self.text(obj)), idxt.replace(' ', ""))
                    } else {
                        format!("{}.{}", normalise_chain(&self.text(obj)), lit)
                    };
                    self.push_en(EN { k: 0, t, at, end, ..Default::default() })
                } else {
                    let ok = self.expr(obj);
                    let ik = self.expr(idx);
                    self.push_en(EN { k: 2, t: "index".into(), at, end, kids: vec![ok, ik], ..Default::default() })
                }
            }
            "call_expression" | "new_expression" => {
                let callee = n.child_by_field_name("function").or_else(|| n.child_by_field_name("constructor"));
                let args = n.child_by_field_name("arguments");
                // argument expressions lower first so their source reads register before the call's effects
                let kids: Vec<usize> = match args { Some(a) => children(a).into_iter().map(|x| self.expr(x)).collect(), None => vec![] };
                let mut dyn_ = false;
                let chain = match callee {
                    None => { dyn_ = true; "<computed>".to_string() }
                    Some(c) => match c.kind() {
                        "identifier" | "this" => normalise_chain(&self.text(c)),
                        "member_expression" if is_pure_chain(c) => normalise_chain(&self.text(c)),
                        "member_expression" => {
                            // computed receiver or property: lower the parts, keep the written text
                            dyn_ = true;
                            let _ = self.expr(c.child_by_field_name("object").unwrap_or(c));
                            if let Some(p) = c.child_by_field_name("property") {
                                if p.kind() != "property_identifier" { let _ = self.expr(p); }
                            }
                            normalise_chain(&self.text(c))
                        }
                        _ => { dyn_ = true; normalise_chain(&self.text(c)) }
                    },
                };
                let raw = n.utf8_text(self.src.as_bytes()).unwrap_or("").to_lowercase().replace(' ', "");
                let shell_true = raw.contains("shell:true");
                let t = if n.kind() == "new_expression" { format!("new {chain}") } else { chain };
                self.push_en(EN { k: 1, t, at, end, a: None, m: None, d: dyn_, sh: if shell_true { Some(true) } else { None }, kids })
            }
            "binary_expression" => {
                let op = normalise_chain(&self.text(op_of(n)));
                let k1 = self.expr(n.child_by_field_name("left").unwrap_or(n));
                let k2 = self.expr(n.child_by_field_name("right").unwrap_or(n));
                let t = match op.as_str() { "+" | "+=" | "-=" => "add".into(), "&&" => "and".into(), "||" => "or".into(), "??" => "coalesce".into(), o => o.to_string() };
                self.push_en(EN { k: 2, t, at, end, kids: vec![k1, k2], ..Default::default() })
            }
            "template_string" => {
                let mut kids = vec![];
                for ch in children(n) {
                    if ch.kind() == "template_substitution" {
                        if let Some(e) = children(ch).into_iter().next() { kids.push(self.expr(e)); }
                    }
                }
                self.push_en(EN { k: 2, t: "template".into(), at, end, kids, ..Default::default() })
            }
            "template_substitution" => {
                let inner = children(n).into_iter().next().unwrap_or(n);
                self.expr(inner)
            }
            "ternary_expression" => {
                let k1 = self.expr(n.child_by_field_name("condition").unwrap_or(n));
                let k2 = self.expr(n.child_by_field_name("consequence").unwrap_or(n));
                let k3 = self.expr(n.child_by_field_name("alternative").unwrap_or(n));
                self.push_en(EN { k: 2, t: "ternary".into(), at, end, kids: vec![k1, k2, k3], ..Default::default() })
            }
            "await_expression" | "yield_expression" => {
                let k = self.expr(n.child(0).unwrap_or(n));
                self.push_en(EN { k: 2, t: "await".into(), at, end, kids: vec![k], ..Default::default() })
            }
            "unary_expression" | "typeof_expression" => {
                let k = self.expr(n.child_by_field_name("argument").unwrap_or(n.child(0).unwrap_or(n)));
                self.push_en(EN { k: 2, t: "unop".into(), at, end, kids: vec![k], ..Default::default() })
            }
            "update_expression" => {
                let k = self.expr(n.child_by_field_name("argument").unwrap_or(n));
                self.push_en(EN { k: 2, t: "update".into(), at, end, kids: vec![k], ..Default::default() })
            }
            "spread_element" => {
                let k = self.expr(children(n).into_iter().next().unwrap_or(n));
                self.push_en(EN { k: 2, t: "spread".into(), at, end, kids: vec![k], ..Default::default() })
            }
            "object" | "object_pattern" | "array" | "array_pattern" => {
                let mut kids = vec![];
                for ch in children(n) {
                    match ch.kind() {
                        "pair" => { if let Some(v) = ch.child_by_field_name("value") { kids.push(self.expr(v)); } }
                        "spread_element" => { kids.push(self.expr(ch)); }
                        _ => { kids.push(self.expr(ch)); }
                    }
                }
                self.push_en(EN { k: 2, t: "shape".into(), at, end, kids, ..Default::default() })
            }
            "pair" => {
                let v = n.child_by_field_name("value").unwrap_or(n);
                self.expr(v)
            }
            "arrow_function" | "function_expression" | "function" | "generator_function" => {
                self.nested.push((n, "closure", String::new()));
                self.push_en(EN { k: 2, t: "closure".into(), at, end, ..Default::default() })
            }
            _ => {
                let mut kids = vec![];
                for ch in children(n) { kids.push(self.expr(ch)); }
                let t = normalise_chain(&self.text(n));
                self.push_en(EN { k: 3, t, at, end, kids, ..Default::default() })
            }
        }
    }

    /// `x = value` / `x += value`: the target stays a leaf (locals and pure field chains) so the solver can
    /// distinguish scalar defs from field defs; computed targets keep the general lowering.
    fn assign_tree(&mut self, n: Node<'t>) -> usize {
        let left = n.child_by_field_name("left").unwrap_or(n);
        let right = n.child_by_field_name("right");
        let at = n.start_byte();
        let end = n.end_byte();
        let is_member_write = left.kind() == "member_expression" && left.child_by_field_name("object").map_or(false, is_pure_chain);
        let is_subscript_write = left.kind() == "subscript_expression"
            && left.child_by_field_name("object").map_or(false, is_pure_chain)
            && left.child_by_field_name("index").map_or(false, |i| matches!(i.kind(), "string" | "number"));
        let is_plain = is_member_write || is_subscript_write || matches!(left.kind(), "identifier" | "this");
        if is_plain {
            let tl = self.push_en(EN { k: 0, t: normalise_chain(&self.text(left)), at: left.start_byte(), end: left.end_byte(), ..Default::default() });
            let vk = right.map(|r| self.expr(r)).unwrap_or(self.push_en(EN { k: 4, t: String::new(), at, end, ..Default::default() }));
            let op = if n.kind() == "augmented_assignment_expression" { normalise_chain(&self.text(op_of(n))) } else { String::new() };
            self.push_en(EN { k: 2, t: if op.is_empty() { "assign".into() } else { format!("augassign:{op}") }, at, end, kids: vec![tl, vk], ..Default::default() })
        } else {
            // computed target (`a[b] = v`): record, mark the construct, keep both sides lowerable
            self.unsupported.push(Unsup { construct: "computed-property-write".into(), at, end });
            let tk = self.expr(left);
            let vk = right.map(|r| self.expr(r)).unwrap_or(self.push_en(EN { k: 4, t: String::new(), at, end, ..Default::default() }));
            self.push_en(EN { k: 2, t: "assign-computed".into(), at, end, kids: vec![tk, vk], ..Default::default() })
        }
    }

    fn def_tree(&mut self, name: &str, value: Node<'t>) -> usize {
        if matches!(name, "object_pattern" | "array_pattern") { // unreachable; patterns handled by pattern_defs
            return self.expr(value);
        }
        let nt = self.push_en(EN { k: 0, t: normalise_chain(name), ..Default::default() });
        let vk = self.expr(value);
        self.push_en(EN { k: 2, t: "assign".into(), at: value.start_byte(), end: value.end_byte(), kids: vec![nt, vk], ..Default::default() })
    }
    fn def_leaf(&mut self, name: &str, leaf_text: &str, at: usize, end: usize) -> usize {
        let nt = self.push_en(EN { k: 0, t: normalise_chain(name), ..Default::default() });
        let vk = self.push_en(EN { k: 0, t: normalise_chain(leaf_text), ..Default::default() });
        self.trees.push(EN { k: 2, t: "assign".into(), at, end, kids: vec![nt, vk], ..Default::default() });
        self.trees.len() - 1
    }

    /// Destructuring definitions: each pattern binding gets its own assign tree with a dotted leaf chain
    /// (`const { id } = req.body` → `id = req.body.id`), keeping source matching per binding. `value_text` is
    /// the written right-hand side (a prefix is passed when destructuring nests).
    fn pattern_defs(&mut self, pattern: Node, value_text: String, literal: bool, at: usize, end: usize, trees: &mut Vec<usize>) {
        match pattern.kind() {
            "object_pattern" => {
                for ch in children(pattern) {
                    match ch.kind() {
                        "shorthand_property_identifier" | "identifier" => {
                            let prop = normalise_chain(&self.text(ch));
                            let leaf_text = if literal { value_text.trim_matches(|c| c == '"' || c == '\'').to_string() } else { format!("{value_text}.{prop}") };
                            trees.push(self.def_leaf(&prop, &leaf_text, at, end));
                        }
                        "pair" => {
                            let (Some(key), Some(val)) = (ch.child_by_field_name("key"), ch.child_by_field_name("value")) else { continue };
                            let key_text = normalise_chain(&self.text(key)).trim_matches(|c| c == '"' || c == '\'').to_string();
                            if matches!(val.kind(), "object_pattern" | "array_pattern") {
                                self.pattern_defs(val, format!("{value_text}.{key_text}"), false, ch.start_byte(), ch.end_byte(), trees);
                            } else {
                                let leaf_text = format!("{value_text}.{key_text}");
                                trees.push(self.def_leaf(&self.text(val), &leaf_text, ch.start_byte(), ch.end_byte()));
                            }
                        }
                        "rest_pattern" => {}
                        _ => { self.unsupported.push(Unsup { construct: "computed-property-key".into(), at: ch.start_byte(), end: ch.end_byte() }); }
                    }
                }
            }
            "array_pattern" => {
                for (i, ch) in children(pattern).into_iter().enumerate() {
                    if ch.kind() == "identifier" {
                        let leaf_text = format!("{value_text}[{i}]");
                        trees.push(self.def_leaf(&self.text(ch), &leaf_text, ch.start_byte(), ch.end_byte()));
                    }
                }
            }
            _ => {}
        }
    }

    fn push_en(&mut self, e: EN) -> usize { self.trees.push(e); self.trees.len() - 1 }

    fn into_parts(self) -> (Vec<FlowBlock>, Vec<FlowStmt>, Vec<CondEdge>, Vec<EN>, Vec<Unsup>, bool, Vec<(Node<'t>, &'static str, String)>) {
        (self.blocks, self.stmts, self.edges, self.trees, self.unsupported, self.toomany, self.nested)
    }
}

impl InE {
    fn plain(from: usize) -> Self { InE { from, cond: None } }
}

fn is_pure_chain(n: Node) -> bool {
    match n.kind() {
        "identifier" | "this" => true,
        "member_expression" => {
            let (Some(o), Some(p)) = (n.child_by_field_name("object"), n.child_by_field_name("property")) else { return false };
            p.kind() == "property_identifier" && is_pure_chain(o)
        }
        _ => false,
    }
}

fn op_of(n: Node) -> Node {
    n.children(&mut n.walk()).find(|ch| !ch.is_named()).unwrap_or_else(|| n.child(1).unwrap_or(n))
}

// -------------------------------------------------------------------------- statement classification

fn is_stmt_kind(kind: &str) -> bool {
    matches!(kind,
        "expression_statement" | "lexical_declaration" | "variable_declaration" | "return_statement"
        | "break_statement" | "continue_statement" | "throw_statement" | "if_statement"
        | "while_statement" | "do_statement" | "for_statement" | "for_in_statement" | "for_of_statement"
        | "switch_statement" | "try_statement" | "function_declaration" | "generator_function_declaration"
        | "class_declaration" | "abstract_class_declaration" | "labeled_statement" | "statement_block"
        | "empty_statement" | "debugger_statement" | "import_statement" | "export_statement" | "comment")
}

fn stmt_kids(n: Node) -> Vec<Node> {
    let mut c = n.walk();
    n.named_children(&mut c).filter(|ch| is_stmt_kind(ch.kind())).collect()
}

/// Patterns of a destructure left side reduce to their written binding names.
fn pattern_items(pattern: Node) -> Vec<String> {
    let mut out = vec![];
    for ch in children(pattern) {
        let t = ch.utf8_text(&[]).unwrap_or("").to_string();
        out.push(param_name(&t));
    }
    out
}

// -------------------------------------------------------------------------- per-run entry: walk + ids + resolution

pub fn extract(repo_path: &str, budget: &Budget, deadline: Option<std::time::Instant>) -> Result<FlowFacts, String> {
    let dir = Path::new(repo_path);
    if !dir.is_dir() { return Err(format!("not a directory: {repo_path}")); }
    let mut files: Vec<(String, String)> = vec![];
    for entry in WalkDir::new(dir)
        .into_iter()
        .filter_entry(|e| {
            !(e.path().is_dir() && e.file_name().to_str().map_or(false, |n| SKIP_DIRS.contains(&n)))
        })
    {
        if files.len() >= budget.max_files { break; }
        let e = match entry { Ok(e) => e, Err(_) => continue };
        if !e.file_type().is_file() { continue; }
        let path = e.path();
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if !matches!(ext, "ts" | "tsx") { continue; }
        let Ok(rel) = path.strip_prefix(dir) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if rel.ends_with(".d.ts") { continue; }
        if rel.starts_with("tests/") || rel.starts_with("test/") || rel.split('/').any(|c| c == "__tests__") || rel.split('/').any(|c| c == "fixtures") { continue; }
        let Ok(src) = std::fs::read_to_string(path) else { continue };
        files.push((rel, src));
    }
    files.sort();

    let mut facts = FlowFacts {
        schema_id: FACTS_SCHEMA.into(),
        schema_version: 1,
        analyzer_version: format!("worker/ts@{}", SOLVER_VERSION),
        language: "ts".into(),
        files_total: files.len(),
        ..Default::default()
    };
    let mut per_file: Vec<(Vec<RSym>, Vec<RImp>)> = vec![];
    for (rel, src) in files.iter() {
        if let Some(dl) = deadline {
            if std::time::Instant::now() >= dl {
                facts.stopped_by = Some(STOP_WALL_TIME.into());
                facts.skipped.push(Skipped { file: rel.clone(), reason: SKIP_BUDGET.into(), ..Default::default() });
                continue;
            }
        }
        let mut parser = Parser::new();
        let lang = if rel.ends_with(".tsx") { tree_sitter_typescript::LANGUAGE_TSX } else { tree_sitter_typescript::LANGUAGE_TYPESCRIPT };
        if parser.set_language(&lang.into()).is_err() { continue; }
        let tree = match parser.parse(src.as_bytes(), None) {
            Some(t) => t,
            None => {
                facts.skipped.push(Skipped { file: rel.clone(), reason: SKIP_PARSE_ERROR.into(), ..Default::default() });
                continue;
            }
        };
        if tree.root_node().has_error() {
            facts.skipped.push(Skipped { file: rel.clone(), reason: SKIP_PARSE_ERROR.into(), ..Default::default() });
            continue;
        }
        let mut fx = FileX::new(rel.clone(), src.as_str());
        fx.walk(tree.root_node());
        facts.files_analysed += 1;
        // assign entity ids (index.rs's scheme; duplicates get `@<start>`, first occurrence keeps the plain id)
        let before = facts.functions.len();
        let mut seen: HashSet<String> = HashSet::new();
        for (si, sym) in fx.syms.iter_mut().enumerate() {
            let base = format!("{}:{rel}#{}", sym.kind, sym.qualified);
            if seen.insert(base.clone()) {
                sym.id = base.clone();
            } else {
                sym.id = format!("{base}@{}", sym.start);
            }
            let _ = si;
        }
        for sym in fx.syms.iter() {
            if let Some(fs) = sym.fn_start {
                if let Some(f) = facts.functions.get_mut(before + fs) { f.id = sym.id.clone(); f.kind = sym.kind.to_string(); }
                else { break; }
            }
        }
        facts.functions.extend(fx.fns);
        facts.skipped.extend(fx.skips);
        // closures and local helpers got FlowFn entries without syms: give them ids so the solver can map them
        for f in facts.functions[before..].iter_mut() {
            if f.id.is_empty() {
                let suffix = sha(format!("{}:{}:{}", f.file, f.name, f.start).as_bytes())[..8].to_string();
                f.id = format!("closure:{rel}#{}@{suffix}", f.name);
            }
        }
        per_file.push((fx.syms, fx.imports));
        if facts.functions.len() >= budget.max_functions && facts.stopped_by.is_none() {
            facts.stopped_by = Some(STOP_FUNCTION_BUDGET.into());
        }
    }
    if facts.stopped_by == Some(STOP_FUNCTION_BUDGET.into()) {
        let budgeted: Vec<Skipped> = facts.functions[budget.max_functions.min(facts.functions.len())..]
            .iter()
            .map(|f| Skipped { file: f.file.clone(), fn_id: Some(f.id.clone()), reason: SKIP_BUDGET.into(), ..Default::default() })
            .collect();
        facts.skipped.extend(budgeted);
        facts.functions.truncate(budget.max_functions);
    }
    resolve_calls(&mut facts, files, per_file);
    Ok(facts.with_hash())
}

fn resolve_module_spec(spec: &str) -> (bool, String) {
    if spec.starts_with('.') { (true, spec.to_string()) } else { (false, format!("@npm:{spec}")) }
}

/// Relative repo path an import specifier points at, joined onto the importing file's directory.
fn module_to_rel(from_file: &str, spec: &str, known: &HashSet<String>) -> Option<String> {
    let (relative, spec) = resolve_module_spec(spec);
    if !relative { return None; }
    let mut parts: Vec<String> = Vec::new();
    let comps: Vec<&str> = from_file.split('/').collect();
    for comp in comps[..comps.len() - 1].iter() { parts.push((*comp).to_string()); }
    for seg in spec.split('/') {
        match seg {
            "." | "" => {}
            ".." => { parts.pop(); }
            s => parts.push(s.to_string()),
        }
    }
    let base = parts.join("/");
    for cand in [format!("{base}.ts"), format!("{base}.tsx"), format!("{base}/index.ts"), format!("{base}/index.tsx")] {
        if known.contains(&cand) { return Some(cand); }
    }
    None
}

fn find_symbol_id(syms: &[RSym], qualified: &str) -> Option<String> {
    syms.iter().find(|s| s.fn_start.is_some() && s.qualified == qualified).map(|s| s.id.clone())
}

fn resolve_calls(facts: &mut FlowFacts, files: Vec<(String, String)>, per_file: Vec<(Vec<RSym>, Vec<RImp>)>) {
    let known: HashSet<String> = files.iter().map(|(rel, _)| rel.clone()).collect();
    let by_file: HashMap<String, (Vec<RSym>, Vec<RImp>)> = files.iter().zip(per_file.into_iter()).map(|((rel, _), pf)| (rel.clone(), pf)).collect();
    for f in facts.functions.iter_mut() {
        let sym_syms = by_file.get(&f.file).map(|(s, _)| s.clone()).unwrap_or_default();
        let imports = by_file.get(&f.file).map(|(_, i)| i.clone()).unwrap_or_default();
        let class_name = f.class.clone();
        let file_key = f.file.clone();
        for t in f.trees.iter_mut() {
            if t.k != 1 || t.d { continue; }
            let segs = norm_segments(&t.t);
            if segs.is_empty() { continue; }
            let text = normalise_chain(&t.t);
            if segs.len() == 1 && !text.contains('.') {
                let name = &segs[0];
                if let Some(b) = imports.iter().find(|i| i.local == *name) {
                    match module_to_rel(&file_key, &b.module, &known) {
                        Some(target) => {
                            if let Some((syms, _)) = by_file.get(&target) {
                                if let Some(id) = find_symbol_id(syms, &b.imported) {
                                    t.a = Some(id); continue;
                                }
                            }
                            t.m = Some(target);
                        }
                        None => { t.m = Some(spec_module(&b.module)); }
                    }
                } else if let Some(id) = find_symbol_id(&sym_syms, name) {
                    t.a = Some(id);
                }
            } else if segs[0] == "this" || segs[0] == "self" {
                if let Some(cn) = &class_name {
                    let qual = format!("{cn}.{}", segs[segs.len() - 1]);
                    if let Some(id) = find_symbol_id(&sym_syms, &qual) { t.a = Some(id); }
                }
            } else if let Some(ns) = imports.iter().find(|i| i.local == segs[0] && i.imported == "*") {
                match module_to_rel(&file_key, &ns.module, &known) {
                    Some(target) => {
                        let tail = segs[1..].join(".");
                        if let Some((syms, _)) = by_file.get(&target) {
                            if let Some(id) = find_symbol_id(syms, &tail) { t.a = Some(id); continue; }
                        }
                        t.m = Some(target);
                    }
                    None => { t.m = Some(spec_module(&ns.module)); }
                }
            }
        }
    }
}

fn spec_module(spec: &str) -> String { format!("@npm:{spec}") }

