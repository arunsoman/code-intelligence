//! A semantic IR per symbol (plan: "Semantic IR"). The grammar-shape hash (shape.rs) blanks all
//! identifiers only by construction (it never reads text); the byte-text digest C08's registry used
//! broke whenever a *local* was renamed. The IR fills both gaps:
//!
//! - it is lowered from the same tree-sitter trees the walkers already visit (no extra parse),
//! - every *locally bound* identifier (parameters, `let`/`const`/`var`, `:=`, plain Python targets)
//!   and the symbol's own short name are blanked, so a rename that also renames locals or reflows
//!   whitespace/comments/literals does not change the hash,
//! - external names (calls, fields, types) are kept, so two functions "do the same thing to different
//!   collaborators" still hash apart,
//! - idioms normalize to one node: `a += b` and `a = a + b` are one `Assign`, `/` `//` `%` `&&` `||` `!`
//!   have dedicated nodes, `for`/`while`/`do` are one `Loop`, and parenthesized expressions vanish.
//!
//! The hash (`ir_hash`) is stored unconditionally on every symbol and threads onto `Entity` next to
//! `shape_hash`. The serialized IR tree itself rides along in memory (`IrDigest`): the tree is
//! persisted by default (set `CIE_IR_DUMP=0` to trade inspection for artifact size) while the
//! kind sequence used for near-duplicate shingling stays a process-local table, so nothing
//! beyond the hash and the dump ever needs to be re-derived from source.
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock, RwLock};
use tree_sitter::Node;

/// Which grammar a symbol came from: the lowering tables are per language.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Lang {
    Ts,
    Rust,
    Java,
    Go,
    Python,
}

/// A semantic-IR node. The variants the plan names are all here (`Unknown` is the escape hatch —
/// lowering never fails, it just tags what it did not classify). `Call` and `Attr` are two extras
/// the listed set is missing: a call's callee and a member access's field name are the parts of the
/// IR most worth keeping (external names), and nothing else can express "applied to arguments".
#[derive(Clone, Debug, PartialEq)]
pub enum Ir {
    /// A function-like root or nested function literal: parameters and body.
    Function(Vec<Ir>),
    /// A local declaration with its (lowered) initializer.
    VarDecl(Vec<Ir>),
    /// An assignment (`=`, `+=`, … all normalize to one node). `aug` records that the source was a
    /// compound or incrementing form (the old value is read) — used only by the serialized dump so
    /// consumers can rebuild the self-fed data edge; the hash text deliberately carries no mention
    /// of it, since `a += b` and `a = a + b` must stay one node.
    Assign { kids: Vec<Ir>, aug: bool },
    /// Any loop (for/while/do/foreach).
    Loop(Vec<Ir>),
    /// Any branch (if, ternary, switch/match).
    Conditional(Vec<Ir>),
    Return(Vec<Ir>),
    IntDiv(Box<Ir>, Box<Ir>),
    FloatDiv(Box<Ir>, Box<Ir>),
    Mod(Box<Ir>, Box<Ir>),
    And(Box<Ir>, Box<Ir>),
    Or(Box<Ir>, Box<Ir>),
    Not(Box<Ir>),
    /// A call: callee expression and lowered arguments.
    Call(Box<Ir>, Vec<Ir>),
    /// A member access: receiver expression and field name. An empty name means the field was
    /// blanked (it named the symbol itself).
    Attr(Box<Ir>, Box<str>),
    /// A literal (number, string, bool, null) — the value is blanked, only the coarse type is kept.
    Lit(&'static str),
    /// An externally bound identifier, kept by name.
    Named(Box<str>),
    /// A locally bound identifier: blanked in the hash (this is the node C08's old text digest was
    /// missing). The slot numbers which local it belongs to — assigned per unique local name on the
    /// first occurrence in the deterministic lowering walk — but the hash text never prints it, so
    /// a rename (which keeps every slot) and the hash values are exactly what they were before
    /// slots existed. The serialized dump (`IrSer`) does print slot and resolved name, which is
    /// what lets downstream consumers rebuild def-use chains from the stored tree.
    Ref(u16),
    /// Anything not classified, tagged with why (a grammar kind, or an operator tag); children lowered.
    Unknown(Box<str>, Vec<Ir>),
}

const FN: &str = "fn";
const DECL: &str = "decl";
const ASSIGN: &str = "assign";
const LOOP: &str = "loop";
const COND: &str = "branch";
const RET: &str = "ret";
const CALL: &str = "call";
const ATTR: &str = "attr";
const LIT: &str = "lit";
const REF: &str = "ref";
const NAME: &str = "name";
/// Operator tokens that read the assigned value (`+=`, `++`-family, bit shifts): any unnamed child
/// carrying one marks the assign as augmented. `=` and `:=` never appear here.
const COMPOUND_OPS: &[&str] = &[
    "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "÷=", "&^=", "<<=", "+:", "-:", "*:", "/:", "%:", "&:", "|:", "^:", "<<:", ">>:",
];

impl Ir {
    /// Stable, compact serialization — the input to the semantic hash. Names of external identifiers
    /// and kept operator tags appear; locals do not.
    fn write(&self, out: &mut String) {
        match self {
            Ir::Function(cs) => push("f", cs, out),
            Ir::VarDecl(cs) => push("d", cs, out),
            Ir::Assign { kids: cs, aug: _ } => push("a", cs, out),
            Ir::Loop(cs) => push("L", cs, out),
            Ir::Conditional(cs) => push("C", cs, out),
            Ir::Return(cs) => push("R", cs, out),
            Ir::IntDiv(a, b) => push_bin("N", a, b, out),
            Ir::FloatDiv(a, b) => push_bin("Q", a, b, out),
            Ir::Mod(a, b) => push_bin("M", a, b, out),
            Ir::And(a, b) => push_bin("&", a, b, out),
            Ir::Or(a, b) => push_bin("|", a, b, out),
            Ir::Not(a) => {
                out.push('!');
                a.write(out);
            }
            Ir::Call(callee, args) => {
                out.push('k');
                out.push('[');
                callee.write(out);
                out.push('|');
                for a in args {
                    a.write(out);
                }
                out.push(']');
            }
            Ir::Attr(o, name) => {
                out.push('.');
                out.push(if name.is_empty() { '~' } else { '#' });
                if !name.is_empty() {
                    out.push_str(name);
                }
                o.write(out);
            }
            Ir::Lit(t) => {
                out.push('l');
                out.push(':');
                out.push_str(t);
            }
            Ir::Named(n) => {
                out.push('n');
                out.push(':');
                out.push_str(n);
            }
            Ir::Ref(_) => out.push('v'),
            Ir::Unknown(tag, cs) => {
                out.push('u');
                out.push(':');
                out.push_str(tag);
                push("", cs, out);
            }
        }
    }

    /// A short, stable label per kind — the token of the kind sequence used for near-duplicate
    /// shingling and structural-diff summaries. External names are blanked here on purpose: the
    /// comparison is about structure, not collaborators.
    pub fn label(&self) -> &'static str {
        match self {
            Ir::Function(_) => FN,
            Ir::VarDecl(_) => DECL,
            Ir::Assign { .. } => ASSIGN,
            Ir::Loop(_) => LOOP,
            Ir::Conditional(_) => COND,
            Ir::Return(_) => RET,
            Ir::IntDiv(..) => "int-div",
            Ir::FloatDiv(..) => "float-div",
            Ir::Mod(..) => "mod",
            Ir::And(..) => "and",
            Ir::Or(..) => "or",
            Ir::Not(_) => "not",
            Ir::Call(..) => CALL,
            Ir::Attr(..) => ATTR,
            Ir::Lit(_) => LIT,
            Ir::Named(_) => NAME,
            Ir::Ref(_) => REF,
            Ir::Unknown(..) => "unknown",
        }
    }

    fn child_labels<'a>(&'a self) -> Option<&'a [Ir]> {
        match self {
            Ir::Function(cs) | Ir::VarDecl(cs) | Ir::Assign { kids: cs, aug: _ } | Ir::Loop(cs)
            | Ir::Conditional(cs) | Ir::Return(cs) | Ir::Unknown(_, cs) => Some(cs),
            _ => None,
        }
    }

    /// Unknown tags carry the grammar kind or operator text (`op:?=`) — that is exactly the
    /// vocabulary in which a structural difference between two near-duplicates is spelled out.
    pub fn unknown_tag(&self) -> Option<&str> {
        match self {
            Ir::Unknown(tag, _) => Some(tag),
            _ => None,
        }
    }
}

fn push(head: &str, children: &[Ir], out: &mut String) {
    out.push_str(head);
    out.push('[');
    for c in children {
        c.write(out);
    }
    out.push(']');
}
fn push_bin(head: &str, a: &Ir, b: &Ir, out: &mut String) {
    out.push_str(head);
    out.push('[');
    a.write(out);
    out.push(',');
    b.write(out);
    out.push(']');
}

/// Everything that is still true about one lowered symbol: the hash, node counts (the zero-cost
/// summary the chart compilers consume as facts) and the kind sequence for near-duplicate shingling.
#[derive(Clone, Debug, Default)]
pub struct IrDigest {
    pub hash: String,
    pub nodes: u32,
    pub loops: u32,
    pub branches: u32,
    pub returns: u32,
    pub kind_seq: Vec<u16>,
    /// Serialized IR tree; persisted by default, `None` when the parse ran with CIE_IR_DUMP=0.
    pub dump: Option<String>,
    /// Deterministic structural embedding of the tree (see `ir_vec`): sparse (dim, value) pairs,
    /// L2-normalized and quantized ×100. Cosine over these compares two symbols' structure without
    /// any model call — the exact-match companion to `hash`.
    pub vec: Vec<(u16, i8)>,
}

/// The lowered IR of one symbol plus everything index.rs's clustering and fact emission need from it.
/// Empty when the symbol could not be lowered at all (no tree) — never an error.
impl IrDigest {
    fn count(&mut self, root: &Ir) {
        let (nodes, loops, branches, returns) = count_of(root);
        self.nodes = nodes;
        self.loops = loops;
        self.branches = branches;
        self.returns = returns;
    }
}

fn count_of(root: &Ir) -> (u32, u32, u32, u32) {
    let mut nodes = 0u32;
    let mut loops = 0u32;
    let mut branches = 0u32;
    let mut returns = 0u32;
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        nodes += 1;
        match n {
            Ir::Loop(_) => loops += 1,
            Ir::Conditional(_) => branches += 1,
            Ir::Return(_) => returns += 1,
            _ => {}
        }
        match n {
            Ir::Function(cs) | Ir::VarDecl(cs) | Ir::Loop(cs)
            | Ir::Conditional(cs) | Ir::Return(cs) | Ir::Unknown(_, cs) => {
                stack.extend(cs.iter())
            }
            Ir::Assign { kids: cs, aug: _ } => stack.extend(cs.iter()),
            Ir::IntDiv(a, b) | Ir::FloatDiv(a, b) | Ir::Mod(a, b) | Ir::And(a, b) | Ir::Or(a, b) => {
                stack.push(a);
                stack.push(b);
            }
            Ir::Not(a) => stack.push(a),
            Ir::Call(callee, args) => {
                stack.push(callee);
                stack.extend(args.iter());
            }
            Ir::Attr(o, _) => stack.push(o),
            Ir::Lit(_) | Ir::Named(_) | Ir::Ref(_) => {}
        }
    }
    (nodes, loops, branches, returns)
}

// ---------------------------------------------------------------- kind sequence
// The kind sequence compares symbols by IR structure. Kinds are interned in a process-local table:
// the near-duplicate clustering only ever compares sequences inside one index run, so ids only have
// to be consistent within that run — re-deriving them from the labels keeps it that way.

struct Interner {
    map: HashMap<&'static str, u16>,
    labels: Vec<&'static str>,
}
static INTERNER: OnceLock<Mutex<Interner>> = OnceLock::new();

fn interner() -> &'static Mutex<Interner> {
    INTERNER.get_or_init(|| Mutex::new(Interner { map: HashMap::new(), labels: vec![] }))
}

fn intern(label: &'static str) -> u16 {
    #[allow(clippy::significant_drop_tightening)]
    let mut g = interner().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(&id) = g.map.get(label) {
        return id;
    }
    let id = g.labels.len() as u16;
    g.map.insert(label, id);
    g.labels.push(label);
    id
}

/// The static-vocabulary labels every lowering can produce; calling `label` at load time pins their
/// ids so a symbol's sequence is comparable against any other symbol's (not order-dependent).
fn pin_labels() {
    for l in [
        FN, DECL, ASSIGN, LOOP, COND, RET, CALL, ATTR, LIT, REF, NAME, "int-div", "float-div",
        "mod", "and", "or", "not",
    ] {
        intern(l);
    }
}

fn label_of_id(id: u16) -> &'static str {
    #[allow(clippy::significant_drop_tightening)]
    let g = interner().lock().unwrap_or_else(|e| e.into_inner());
    g.labels[id as usize].clone() as &'static str
}

// ---------------------------------------------------------------- lowering tables

const TS_IDENTS: &[&str] = &[
    "identifier",
    "property_identifier",
    "shorthand_property_identifier",
    "shorthand_property_identifier_pattern",
    "member_identifier",
    "type_identifier",
];
const RUST_IDENTS: &[&str] = &["identifier", "field_identifier", "macro_identifier", "type_identifier"];
const JAVA_IDENTS: &[&str] = &["identifier", "type_identifier"];
const GO_IDENTS: &[&str] = &["identifier", "field_identifier"];
const PY_IDENTS: &[&str] = &["identifier"];

const TS_FUNCS: &[&str] = &[
    "function_declaration",
    "generator_function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
];
const RUST_FUNCS: &[&str] = &["function_item"];
const JAVA_FUNCS: &[&str] = &["method_declaration", "constructor_declaration"];
const GO_FUNCS: &[&str] = &["function_declaration", "method_declaration", "function_literal"];
const PY_FUNCS: &[&str] = &["function_definition"];

const TS_LOOPS: &[&str] = &[
    "for_statement", "for_in_statement", "while_statement", "do_statement",
];
const RUST_LOOPS: &[&str] =
    &["for_expression", "while_expression", "while_let_expression", "loop_expression"];
const JAVA_LOOPS: &[&str] =
    &["for_statement", "enhanced_for_statement", "while_statement", "do_statement"];
const GO_LOOPS: &[&str] = &["for_statement"];
const PY_LOOPS: &[&str] = &["for_statement", "while_statement"];

const TS_CONDS: &[&str] = &[
    "if_statement", "ternary_expression", "switch_statement", "conditional_expression",
];
const RUST_CONDS: &[&str] =
    &["if_expression", "if_let_expression", "match_expression", "match_block"];
const JAVA_CONDS: &[&str] = &["if_statement", "ternary_expression", "switch_statement", "switch_expression"];
const GO_CONDS: &[&str] = &["if_statement", "switch_statement", "type_switch_statement"];
const PY_CONDS: &[&str] = &["if_statement", "conditional_expression"];

const TS_VARDECLS: &[&str] = &["variable_declarator"];
const RUST_VARDECLS: &[&str] = &["let_declaration"];
const JAVA_VARDECLS: &[&str] = &["local_variable_declaration"];
const GO_VARDECLS: &[&str] = &["var_spec"];
const PY_VARDECLS: &[&str] = &[];

const TS_ASSIGNS: &[&str] = &["assignment_expression", "augmented_assignment_expression"];
const RUST_ASSIGNS: &[&str] = &["assignment_expression", "compound_assignment_expr"];
const JAVA_ASSIGNS: &[&str] = &["assignment_expression"];
const GO_ASSIGNS: &[&str] = &["assignment_statement", "short_var_declaration"];
const PY_ASSIGNS: &[&str] = &["assignment", "augmented_assignment"];

const TS_CALLS: &[&str] = &["call_expression", "new_expression"];
const RUST_CALLS: &[&str] = &["call_expression", "macro_invocation"];
const JAVA_CALLS: &[&str] = &["method_invocation", "object_creation_expression", "explicit_constructor_invocation"];
const GO_CALLS: &[&str] = &["call_expression"];
const PY_CALLS: &[&str] = &["call"];

const TS_MEMBERS: &[&str] = &["member_expression", "subscript_expression"];
const RUST_MEMBERS: &[&str] = &["field_expression", "index_expression"];
const JAVA_MEMBERS: &[&str] = &["field_access", "array_access", "element_access", "method_invocation"];
const GO_MEMBERS: &[&str] = &["selector_expression", "index_expression"];
const PY_MEMBERS: &[&str] = &["attribute", "subscript"];

const PARENS: &[&str] = &["parenthesized_expression"];

fn idents_of(lang: Lang) -> &'static [&'static str] {
    match lang {
        Lang::Ts => TS_IDENTS,
        Lang::Rust => RUST_IDENTS,
        Lang::Java => JAVA_IDENTS,
        Lang::Go => GO_IDENTS,
        Lang::Python => PY_IDENTS,
    }
}
fn funcs_of(lang: Lang) -> &'static [&'static str] {
    match lang {
        Lang::Ts => TS_FUNCS,
        Lang::Rust => RUST_FUNCS,
        Lang::Java => JAVA_FUNCS,
        Lang::Go => GO_FUNCS,
        Lang::Python => PY_FUNCS,
    }
}
fn loops_of(lang: Lang) -> &'static [&'static str] {
    match lang {
        Lang::Ts => TS_LOOPS,
        Lang::Rust => RUST_LOOPS,
        Lang::Java => JAVA_LOOPS,
        Lang::Go => GO_LOOPS,
        Lang::Python => PY_LOOPS,
    }
}
fn conds_of(lang: Lang) -> &'static [&'static str] {
    match lang {
        Lang::Ts => TS_CONDS,
        Lang::Rust => RUST_CONDS,
        Lang::Java => JAVA_CONDS,
        Lang::Go => GO_CONDS,
        Lang::Python => PY_CONDS,
    }
}
fn vardecls_of(lang: Lang) -> &'static [&'static str] {
    match lang {
        Lang::Ts => TS_VARDECLS,
        Lang::Rust => RUST_VARDECLS,
        Lang::Java => JAVA_VARDECLS,
        Lang::Go => GO_VARDECLS,
        Lang::Python => PY_VARDECLS,
    }
}
fn assigns_of(lang: Lang) -> &'static [&'static str] {
    match lang {
        Lang::Ts => TS_ASSIGNS,
        Lang::Rust => RUST_ASSIGNS,
        Lang::Java => JAVA_ASSIGNS,
        Lang::Go => GO_ASSIGNS,
        Lang::Python => PY_ASSIGNS,
    }
}
fn calls_of(lang: Lang) -> &'static [&'static str] {
    match lang {
        Lang::Ts => TS_CALLS,
        Lang::Rust => RUST_CALLS,
        Lang::Java => JAVA_CALLS,
        Lang::Go => GO_CALLS,
        Lang::Python => PY_CALLS,
    }
}
fn members_of(lang: Lang) -> &'static [&'static str] {
    match lang {
        Lang::Ts => TS_MEMBERS,
        Lang::Rust => RUST_MEMBERS,
        Lang::Java => JAVA_MEMBERS,
        Lang::Go => GO_MEMBERS,
        Lang::Python => PY_MEMBERS,
    }
}

/// Embedding dimensions for `ir_vec`. Small enough that every entity carries it; large enough that
/// two unrelated bodies rarely collide on all their mass.
pub const IR_VEC_DIMS: usize = 128;

/// FNV-1a — the deterministic feature-bucket hash (no randomness anywhere: the same tree always
/// lands on the same dims, across processes, platforms and language tables).
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// A structural embedding of one lowered IR tree, built with the hashing trick: every node votes
/// for a dimension from stable feature strings, signed by a second bit, so unrelated bodies wash
/// out and repeated structures pile up. Features: node kinds, kind-at-depth (position profile),
/// external names and field accesses (what the body ACTS ON), call arities, operator tags, literal
/// types — everything the semantic hash keeps, minus the identifier blanking (locals contribute
/// structurally, not by name, exactly as the hash does). L2-normalized then quantized ×100 to i8,
/// returned sparse and dim-sorted: `[dim, value, dim, value, …]`. The exact-match companion to the
/// semantic hash: equal structures → equal vectors; cosine over two vectors approximates how much
/// structure two symbols share before any exact compare.
pub fn ir_vec(root: &Ir) -> Vec<(u16, i8)> {
    let mut counts = vec![0f32; IR_VEC_DIMS];
    fn bump(counts: &mut [f32], feat: &str) {
        let h = fnv1a(feat);
        let dim = (h % crate::ir::IR_VEC_DIMS as u64) as usize;
        let sign = ((h >> 32) & 1) as f32 * 2.0 - 1.0;
        counts[dim] += sign;
    }
    fn walk(n: &Ir, depth: usize, counts: &mut [f32]) {
        let d = depth.min(8);
        match n {
            Ir::Function(cs) => {
                bump(counts, "k:fn");
                bump(counts, &format!("k@{d}:fn"));
                for c in cs {
                    walk(c, depth + 1, counts);
                }
            }
            Ir::VarDecl(cs) => {
                bump(counts, "k:decl");
                bump(counts, &format!("k@{d}:decl"));
                for c in cs {
                    walk(c, depth + 1, counts);
                }
            }
            Ir::Assign { kids, aug } => {
                bump(counts, "k:assign");
                bump(counts, &format!("k@{d}:assign"));
                if *aug {
                    bump(counts, "aug");
                }
                for c in kids {
                    walk(c, depth + 1, counts);
                }
            }
            Ir::Loop(cs) => {
                bump(counts, "k:loop");
                bump(counts, &format!("k@{d}:loop"));
                for c in cs {
                    walk(c, depth + 1, counts);
                }
            }
            Ir::Conditional(cs) => {
                bump(counts, "k:branch");
                bump(counts, &format!("k@{d}:branch"));
                for c in cs {
                    walk(c, depth + 1, counts);
                }
            }
            Ir::Return(cs) => {
                bump(counts, "k:ret");
                bump(counts, &format!("k@{d}:ret"));
                for c in cs {
                    walk(c, depth + 1, counts);
                }
            }
            Ir::IntDiv(a, b) | Ir::FloatDiv(a, b) | Ir::Mod(a, b) | Ir::And(a, b) | Ir::Or(a, b) => {
                bump(counts, &format!("k:{}", n.label()));
                bump(counts, &format!("k@{}:{}", d, n.label()));
                walk(a, depth + 1, counts);
                walk(b, depth + 1, counts);
            }
            Ir::Not(a) => {
                bump(counts, "k:not");
                walk(a, depth + 1, counts);
            }
            Ir::Call(callee, args) => {
                bump(counts, "k:call");
                bump(counts, &format!("call:{}", args.len()));
                walk(callee, depth + 1, counts);
                for c in args {
                    walk(c, depth + 1, counts);
                }
            }
            Ir::Attr(o, name) => {
                bump(counts, "k:attr");
                if !name.is_empty() {
                    bump(counts, &format!("a:{name}"));
                }
                walk(o, depth + 1, counts);
            }
            Ir::Lit(t) => {
                bump(counts, "k:lit");
                bump(counts, &format!("lit:{t}"));
            }
            Ir::Named(x) => {
                bump(counts, "k:name");
                bump(counts, &format!("n:{x}"));
            }
            Ir::Ref(_) => {
                bump(counts, "k:ref");
            }
            Ir::Unknown(tag, cs) => {
                if !tag.is_empty() {
                    bump(counts, &format!("u:{tag}"));
                }
                for c in cs {
                    walk(c, depth + 1, counts);
                }
            }
        }
    }
    walk(root, 0, &mut counts);
    let norm = counts.iter().map(|c| c * c).sum::<f32>().sqrt();
    if norm <= 0.0 {
        return vec![];
    }
    let mut out: Vec<(u16, i8)> = counts
        .iter()
        .enumerate()
        .filter(|(_, c)| **c > 1e-6)
        .map(|(dim, c)| (dim as u16, ((c / norm) * 100.0).round().clamp(-127.0, 127.0) as i8))
        .filter(|(_, v)| *v != 0)
        .collect();
    out.sort_by_key(|(d, _)| *d);
    out.dedup_by_key(|(d, _)| *d);
    out
}


/// One grammar node kind. Used as the `Unknown` tag and in structural-diff labels.
fn kind_tag(k: &str) -> Box<str> {
    let t = k.rsplit("::").next().unwrap_or(k);
    t.into()
}

fn is_in(kind: &str, table: &[&str]) -> bool {
    table.contains(&kind)
}

fn is_literal_kind(kind: &str) -> Option<&'static str> {
    let tag = if kind.contains("string") || kind == "regex" || kind == "character" {
        "str"
    } else if kind.contains("int") || kind.contains("float") || kind.contains("number") || kind.contains("imaginary") {
        "num"
    } else if matches!(kind, "true" | "false" | "boolean_literal") {
        "bool"
    } else if matches!(kind, "null" | "none" | "nil" | "null_literal" | "undefined" | "void") {
        "null"
    } else {
        return None;
    };
    Some(tag)
}

/// The operator token of a binary/unary node: the unnamed child between the (named) operands.
fn operator_of<'a>(node: Node<'a>, src: &[u8]) -> String {
    let mut op = String::new();
    let mut c = node.walk();
    for ch in node.children(&mut c) {
        if !ch.is_named() {
            let t = ch.utf8_text(src).unwrap_or("").trim();
            if !t.is_empty() && t.len() <= 4 || t == "not" || t == "and" || t == "or" {
                op.push_str(t);
            }
        }
    }
    if op.is_empty() {
        op.push_str("\u{1}");
    }
    op
}

fn map_operator(op: &str, a: Ir, b: Ir) -> Ir {
    match op {
        "/" => Ir::FloatDiv(Box::new(a), Box::new(b)),
        "//" => Ir::IntDiv(Box::new(a), Box::new(b)),
        "%" => Ir::Mod(Box::new(a), Box::new(b)),
        "&&" | "and" => Ir::And(Box::new(a), Box::new(b)),
        "||" | "or" => Ir::Or(Box::new(a), Box::new(b)),
        other => Ir::Unknown(format!("op:{other}").into_boxed_str(), vec![a, b]),
    }
}

fn map_unary(op: &str, a: Ir) -> Ir {
    match op {
        "!" | "not" => Ir::Not(Box::new(a)),
        other => Ir::Unknown(format!("un:{other}").into_boxed_str(), vec![a]),
    }
}

/// Identifiers that name a *type* keep their name in the IR (type names are external facts — copies
/// of one function may differ in annotations but those are stable under a local rename).
fn is_type_ident(kind: &str) -> bool {
    matches!(kind, "type_identifier" | "type_fragment")
}

/// Comment and shebang nodes: named, but never code — they must not reach the IR (C08's old byte
/// digest broke whenever a comment mentioned the symbol's name).
pub fn is_comment_kind(kind: &str) -> bool {
    matches!(kind, "comment" | "line_comment" | "block_comment" | "documentation_comment" | "doc_comment" | "hash_bang_line" | "shebang_line" | "multiline_comment" | "html_comment")
}

/// Local-identifier slotting: which blanked use belongs to which local. The blank set stays the
/// pre-collected authority on what is local; the slot map orders it — a name gets the next free slot
/// the first time the lowering walk meets it, so slots depend only on traversal order, never on the
/// names themselves. Rename a local and the dump's names change while every slot stays put.
struct SlotTable<'a> {
    blank: &'a HashSet<String>,
    map: HashMap<String, u16>,
    names: Vec<String>,
}

impl<'a> SlotTable<'a> {
    fn is_local(&self, text: &str) -> bool {
        self.blank.contains(text)
    }

    fn slot(&mut self, text: &str) -> u16 {
        if let Some(&s) = self.map.get(text) {
            return s;
        }
        let s = self.names.len() as u16;
        self.names.push(text.to_string());
        self.map.insert(text.to_string(), s);
        s
    }
}

fn lower_children(node: Node, src: &[u8], lang: Lang, st: &mut SlotTable) -> Vec<Ir> {
    let mut c = node.walk();
    let mut out = Vec::new();
    for ch in node.named_children(&mut c) {
        if is_comment_kind(ch.kind()) {
            continue;
        }
        out.push(lower(ch, src, lang, st));
    }
    out
}

/// Lower one node. Dispatches per language's tables; anything unclassified still lowers (Unknown)
/// with its children lowered, so the IR covers every byte of the symbol without ever failing.
fn lower(node: Node, src: &[u8], lang: Lang, st: &mut SlotTable) -> Ir {
    let kind = node.kind();
    if is_comment_kind(kind) {
        // Lowered to nothing: the callers of `lower_children` already filter comments; this arm only
        // covers a comment passed as a classified node's field child.
        return Ir::Unknown("comment".into(), vec![]);
    }
    // An object-literal entry: the key is a member name (external, kept — a local rename must not
    // blank it), the value lowered. Shorthand `{ amount }` is a variable *use* and stays blankable.
    if matches!(kind, "pair" | "pair_pattern" | "key_value_pair") {
        let key = node
            .child_by_field_name("key")
            .map(|k| Ir::Named(k.utf8_text(src).unwrap_or("").trim_matches(|c| c == '"' || c == '\'').to_string().into_boxed_str()))
            .unwrap_or(Ir::Unknown("key".into(), vec![]));
        let value = node
            .child_by_field_name("value")
            .map(|v| lower(v, src, lang, st))
            .unwrap_or(Ir::Unknown("value".into(), vec![]));
        return Ir::Unknown("pair".into(), vec![key, value]);
    }
    if is_in(kind, loops_of(lang)) {
        return Ir::Loop(lower_children(node, src, lang, st));
    }
    if is_in(kind, conds_of(lang)) {
        return Ir::Conditional(lower_children(node, src, lang, st));
    }
    if matches!(kind, "return_statement" | "return_expression") {
        return Ir::Return(lower_children(node, src, lang, st));
    }
    if is_in(kind, vardecls_of(lang)) {
        return Ir::VarDecl(lower_children(node, src, lang, st));
    }
    if is_in(kind, assigns_of(lang)) {
        // Compound forms (`+=`, `-=`, `++=…`) read the old value; the operator token is an anonymous
        // child, so scan the node's tokens. `=` and `:=` are not in the set and stay plain assigns.
        let mut aug = matches!(kind, "augmented_assignment_expression" | "compound_assignment_expr" | "augmented_assignment");
        let mut c = node.walk();
        for i in 0..node.child_count() {
            if let Some(ch) = node.child(i) {
                if ch.is_named() {
                    continue;
                }
                let t = ch.utf8_text(src).unwrap_or("");
                if COMPOUND_OPS.contains(&t) {
                    aug = true;
                }
            }
        }
        let _ = c;
        return Ir::Assign { kids: lower_children(node, src, lang, st), aug };
    }
    if is_in(kind, calls_of(lang)) {
        return lower_call(node, src, lang, st);
    }
    if is_in(kind, members_of(lang)) {
        return lower_member(node, src, lang, st);
    }
    if is_in(kind, PARENS) {
        // Parens are grammar noise: flatten to the parenthesized expression itself.
        return match node.named_child(0) {
            Some(ch) => lower(ch, src, lang, st),
            None => Ir::Unknown(kind_tag(kind), vec![]),
        };
    }
    if let Some(tag) = is_literal_kind(kind) {
        return Ir::Lit(tag);
    }
    if is_in(kind, idents_of(lang)) && !is_type_ident(kind) {
        let text = node.utf8_text(src).unwrap_or("");
        if st.is_local(text) {
            // A locally bound use (or the symbol's own name): blanked to its slot. The slot orders
            // unique local names by first occurrence, so it is rename-stable; also blank a field
            // access that names the symbol itself (`this.signToken()` in a renamed method).
            return Ir::Ref(st.slot(text));
        }
        return Ir::Named(text.into());
    }
    // Operators that matter to a copy-paste diff get their own nodes; everything else is one Unknown.
    if matches!(kind, "binary_expression" | "binary_operator" | "boolean_operator" | "comparison_operator") {
        let mut c = node.walk();
        let kids: Vec<Node> = node.named_children(&mut c).collect();
        let op = operator_of(node, src);
        if kids.len() == 2 {
            return map_operator(&op, lower(kids[0], src, lang, st), lower(kids[1], src, lang, st));
        }
        return Ir::Unknown(format!("op:{op}").into_boxed_str(), kids.iter().map(|k| lower(*k, src, lang, st)).collect());
    }
    if matches!(kind, "unary_expression" | "unary_operator") {
        let mut c = node.walk();
        let kids: Vec<Node> = node.named_children(&mut c).collect();
        let op = operator_of(node, src);
        if let [only] = kids[..] {
            return map_unary(&op, lower(only, src, lang, st));
        }
        return Ir::Unknown(format!("un:{op}").into_boxed_str(), kids.iter().map(|k| lower(*k, src, lang, st)).collect());
    }
    // Comment nodes and other trivia never reach here: they are unnamed children and the walk only
    // takes named ones, so comments cannot break the hash (C08's old byte digest broke on them).
    Ir::Unknown(kind_tag(kind), lower_children(node, src, lang, st))
}

fn lower_call(node: Node, src: &[u8], lang: Lang, st: &mut SlotTable) -> Ir {
    // A `new X(...)` expression is a call of X's constructor; `macro_invocation` keeps its name.
    let callee = match node.kind() {
        "method_invocation" => {
            let name = node.child_by_field_name("name").map(|n| n.utf8_text(src).unwrap_or("").to_string()).unwrap_or_default();
            match node.child_by_field_name("object") {
                Some(o) => Ir::Attr(Box::new(lower(o, src, lang, st)), name.into()),
                None => Ir::Named(name.into_boxed_str()),
            }
        }
        "object_creation_expression" => {
            let t = node.child_by_field_name("type").map(|t| kind_of_type(&t.utf8_text(src).unwrap_or("")));
            Ir::Named(t.unwrap_or_default().to_string().into_boxed_str())
        }
        "new_expression" => node
            .child_by_field_name("constructor")
            .map(|c| lower(c, src, lang, st))
            .unwrap_or(Ir::Unknown("new".into(), vec![])),
        "macro_invocation" => {
            let text = node.utf8_text(src).unwrap_or("");
            let name = text.split('!').next().unwrap_or("").trim();
            let name = name.rsplit("::").next().unwrap_or(name);
            return Ir::Unknown(format!("macro:{name}").into_boxed_str(), lower_children(node, src, lang, st));
        }
        _ => match node.child_by_field_name("function").or_else(|| node.named_child(0)) {
            Some(f) => lower(f, src, lang, st),
            None => Ir::Unknown("call".into(), vec![]),
        },
    };
    let args = node
        .child_by_field_name("arguments")
        .map(|a| lower(a, src, lang, st))
        .unwrap_or(Ir::Unknown("args".into(), vec![]));
    Ir::Call(Box::new(callee), vec![args])
}

/// The short name of a constructed type: `Money`, `new Money(…)` calls match; qualifiers and type
/// arguments are dropped (they differ by file and by copy anyway).
fn kind_of_type(t: &str) -> &str {
    let base = t.trim().split('<').next().unwrap_or(t).trim();
    base.rsplit(|c| c == '.' || c == ':' || c == '&').next().unwrap_or(base).trim()
}

/// Grammar kinds whose "member access" is computed (`a[k]`, `list[i]`, `dict[key]`): the trailing
/// child is an index expression, not a field name, so lowering must not keep one.
fn is_computed_kind(kind: &str) -> bool {
    matches!(kind, "element_access_expression" | "index_expression" | "indexing_expression" | "array_access" | "subscript" | "subscript_expression" | "computed_property_name")
}

fn lower_member(node: Node, src: &[u8], lang: Lang, st: &mut SlotTable) -> Ir {
    let mut named: Vec<(Option<&str>, Node)> = {
        let mut c = node.walk();
        node.named_children(&mut c).map(|n| (None, n)).collect()
    };
    // Object child: TS/Java/Rust call it object, Go operand.
    let obj_node = node
        .child_by_field_name("object")
        .or_else(|| node.child_by_field_name("operand"))
        .or_else(|| node.named_child(0));
    let field_node = node
        .child_by_field_name("property")
        .or_else(|| node.child_by_field_name("field"))
        .or_else(|| node.child_by_field_name("attribute"))
        .or_else(|| if named.len() >= 2 { let (_, n) = named.remove(named.len() - 1); Some(n) } else { None });
    let obj = obj_node
        .map(|o| lower(o, src, lang, st))
        .unwrap_or(Ir::Unknown("member".into(), vec![]));
    let field_node = match field_node {
        Some(f) => f,
        // Computed member access (`a[k]`) has no field child: keep the inner expression.
        None => return Ir::Attr(Box::new(obj), Box::<str>::default()),
    };
    let field = if matches!(field_node.kind(), "identifier" | "property_identifier" | "attribute" | "field_identifier") {
        field_node.utf8_text(src).unwrap_or("").to_string()
    } else {
        return Ir::Attr(Box::new(obj), Box::<str>::default());
    };
    if is_computed_kind(node.kind()) {
        // An index is not a name: the fold downstream treats Attr-with-no-name as a dynamic write.
        return Ir::Attr(Box::new(obj), Box::<str>::default());
    }
    let field = if st.is_local(&field) { Box::<str>::default() } else { field.into_boxed_str() };
    Ir::Attr(Box::new(obj), field)
}

// ---------------------------------------------------------------- locals collection

/// Identifier-like kinds that *bind or use* a local value. `property_identifier` is deliberately not
/// here: it is a destructuring key or a member name — source text, not a binding.
fn value_ident_kind(kind: &str) -> bool {
    matches!(kind, "identifier" | "shorthand_property_identifier_pattern")
}

/// The identifier names *bound* inside one binding-pattern/declaration node: a destructuring key is
/// source text (its value side binds), so keys are skipped where the grammar separates them.
fn pattern_ids(node: Node, src: &[u8], out: &mut HashSet<String>) {
    match node.kind() {
        "pair_pattern" | "assignment_pattern" | "key_value_pair" => {
            if let Some(v) = node.child_by_field_name("value") {
                pattern_ids(v, src, out);
            }
            let mut c = node.walk();
            for ch in node.named_children(&mut c) {
                if ch.kind() == "shorthand_property_identifier_pattern" {
                    pattern_ids(ch, src, out);
                }
            }
        }
        "property_identifier" | "type_identifier" => {}
        _ => {
            if value_ident_kind(node.kind()) {
                let t = node.utf8_text(src).unwrap_or("");
                if !t.is_empty() {
                    out.insert(t.to_string());
                }
                return;
            }
            let mut c = node.walk();
            for ch in node.named_children(&mut c) {
                pattern_ids(ch, src, out);
            }
        }
    }
}

/// Collect the names every *locally bound* identifier takes inside one symbol: its parameters plus
/// every local declaration (`let`/`const`/`var`/`:=`/plain assignment/loop binding). Fields, class
/// members and type names are deliberately not here: they are external facts that copies share.
fn collect_idents(node: Node, src: &[u8], lang: Lang, out: &mut HashSet<String>) {
    match node.kind() {
        // Function parameter lists: names bind, annotations and types stay external. Nested functions
        // bind their own names (they get their own symbols; blanking them in the enclosing body only
        // loosens the hash in the same way for every copy, and the diff text still sees the lengths).
        "formal_parameters" | "parameters" => {
            let mut c = node.walk();
            for p in node.named_children(&mut c) {
                match p.kind() {
                    // Rust parameter: the pattern binds, the type does not.
                    "parameter" | "self_parameter" => {
                        if p.kind() == "parameter" {
                            if let Some(pat) = p.child_by_field_name("pattern") {
                                pattern_ids(pat, src, out);
                            }
                        }
                    }
                    _ => pattern_ids(p, src, out),
                }
            }
        }
        "variable_declarator" => {
            if let Some(n) = node.child_by_field_name("name") {
                pattern_ids(n, src, out);
            }
        }
        "assignment_expression" | "augmented_assignment_expression" | "assignment" | "augmented_assignment" | "assignment_statement" | "short_var_declaration" => {
            if let Some(l) = node.child_by_field_name("left").or_else(|| node.named_child(0)) {
                // `self.x = 1` / `obj.f = 1` binds a field, not a local: keep the field name. Go's
                // `:=` keeps its names behind an expression_list.
                if matches!(l.kind(), "identifier" | "object_pattern" | "array_pattern" | "pattern_list" | "tuple_pattern" | "list_pattern" | "expression_list") {
                    pattern_ids(l, src, out);
                }
            }
        }
        "let_declaration" | "let_chain" => {
            if let Some(p) = node.child_by_field_name("pattern") {
                pattern_ids(p, src, out);
            }
        }
        // Rust's if-let/while-let: the newer grammar keeps the pattern inside a `let_condition`.
        "let_condition" | "if_let_expression" | "while_let_expression" => {
            if let Some(p) = node.child_by_field_name("pattern") {
                pattern_ids(p, src, out);
            }
        }
        "local_variable_declaration" => {
            let mut c = node.walk();
            for d in node.named_children(&mut c) {
                if d.kind() == "variable_declarator" {
                    if let Some(n) = d.child_by_field_name("name") {
                        pattern_ids(n, src, out);
                    }
                }
            }
        }
        "var_spec" => {
            let mut c = node.walk();
            for ch in node.named_children(&mut c) {
                if ch.kind() == "identifier" {
                    pattern_ids(ch, src, out);
                }
            }
        }
        "formal_parameter" | "spread_parameter" | "catch_formal_parameter" => pattern_ids(node, src, out),
        "parameter_declaration" => {
            let mut c = node.walk();
            for ch in node.named_children(&mut c) {
                if ch.kind() == "identifier" {
                    pattern_ids(ch, src, out);
                }
            }
        }
        "range_clause" => {
            if let Some(l) = node.child_by_field_name("left") {
                if l.kind() == "expression_list" {
                    let mut lc = l.walk();
                    for ch in l.named_children(&mut lc) {
                        if ch.kind() == "identifier" {
                            pattern_ids(ch, src, out);
                        }
                    }
                }
            }
        }
        // `for (const x of items)` (TS), `for (String x : xs)` (Java), `for o in orders:` and Rust's
        // `for p in iter`: the loop variable binds wherever the grammar puts it in the left slot.
        "for_in_statement" | "enhanced_for_statement" => {
            if let Some(l) = node.child_by_field_name("left").or_else(|| node.child_by_field_name("name")) {
                match l.kind() {
                    "identifier" | "object_pattern" | "array_pattern" => pattern_ids(l, src, out),
                    "variable_declarator" | "lexical_declaration" | "variable_declaration_list" => {
                        if l.kind() == "variable_declarator" {
                            if let Some(n) = l.child_by_field_name("name") {
                                pattern_ids(n, src, out);
                            }
                        } else {
                            let mut lc = l.walk();
                            for d in l.named_children(&mut lc) {
                                if d.kind() == "variable_declarator" {
                                    if let Some(n) = d.child_by_field_name("name") {
                                        pattern_ids(n, src, out);
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        "for_statement" | "for_expression" => {
            // Python's for has a left pattern; Go/TS for has clauses (handled by the loops above or
            // by their own declaration nodes inside the children); Rust's for expression's first
            // named child is the loop pattern.
            if let Some(l) = node.child_by_field_name("left").or_else(|| node.named_child(0)) {
                if matches!(l.kind(), "identifier" | "pattern_list" | "tuple_pattern" | "list_pattern" | "ref_pattern" | "mut_pattern") {
                    pattern_ids(l, src, out);
                }
            }
        }
        _ => {}
    }
    let _ = lang;
    let mut c = node.walk();
    for ch in node.named_children(&mut c) {
        if is_comment_kind(ch.kind()) {
            continue;
        }
        collect_idents(ch, src, lang, out);
    }
}

/// The whole collect_locals of one symbol: recursive, so declarations in nested lambdas also blank.
/// Over-blanking inside the same symbol's subtree is safe by construction: a blanked name is blanked
/// in every copy the same way, and a copy that differs in an external name still hashes apart.
fn collect_locals(node: Node, src: &[u8], lang: Lang) -> HashSet<String> {
    let mut out = HashSet::new();
    collect_idents(node, src, lang, &mut out);
    out
}

pub fn ir_hash(node: Node, src: &[u8], lang: Lang, own: &str) -> IrDigest {
    pin_labels();
    let mut blank = collect_locals(node, src, lang);
    blank.insert(own.to_string());
    let mut st = SlotTable { blank: &blank, map: HashMap::new(), names: Vec::new() };
    let root = lower_symbol_root(node, src, lang, &mut st);
    let mut d = IrDigest::default();
    d.count(&root);
    // Kind sequence, pre-order.
    let mut seq = Vec::with_capacity(d.nodes as usize);
    let mut stack = vec![root.clone()];
    while let Some(n) = stack.pop() {
        seq.push(intern(n.label()));
        match &n {
            Ir::Function(cs) | Ir::VarDecl(cs) | Ir::Loop(cs)
            | Ir::Conditional(cs) | Ir::Return(cs) | Ir::Unknown(_, cs) => {
                for c in cs.iter().rev() {
                    stack.push(c.clone());
                }
            }
            Ir::Assign { kids: cs, aug: _ } => {
                for c in cs.iter().rev() {
                    stack.push(c.clone());
                }
            }
            Ir::IntDiv(a, b) | Ir::FloatDiv(a, b) | Ir::Mod(a, b) | Ir::And(a, b) | Ir::Or(a, b) => {
                stack.push((**b).clone());
                stack.push((**a).clone());
            }
            Ir::Not(a) => stack.push((**a).clone()),
            Ir::Call(callee, args) => {
                for c in args.iter().rev() {
                    stack.push(c.clone());
                }
                stack.push((**callee).clone());
            }
            Ir::Attr(o, _) => stack.push((**o).clone()),
            Ir::Lit(_) | Ir::Named(_) | Ir::Ref(_) => {}
        }
    }
    d.kind_seq = seq;
    let mut buf = String::with_capacity(256);
    root.write(&mut buf);
    d.hash = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(buf.as_bytes());
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()[..16]
            .to_string()
    };
    // Persisted by default: the tree is purely for inspection and adds no query surface, so the
    // explicit opt-out (`CIE_IR_DUMP=0`) is there for artifact-size-sensitive deployments.
    if std::env::var_os("CIE_IR_DUMP").map_or(true, |v| v != "0") {
        d.dump = Some(serde_json::to_string(&IrSer(&root, &st.names)).unwrap_or_default());
    }
    d.vec = ir_vec(&root);
    d
}

/// A symbol's IR root: a `Function` node holding its parameters and body when the node is a
/// function-like declaration; otherwise the lowered node under one `Function` (classes lower their
/// members; their methods appear as their own `Function` nodes, exactly as copies compare them).
fn lower_symbol_root(node: Node, src: &[u8], lang: Lang, st: &mut SlotTable) -> Ir {
    let body = node.child_by_field_name("body");
    let params = node.child_by_field_name("parameters");
    if body.is_some() || params.is_some() {
        let mut kids = Vec::new();
        if let Some(p) = params {
            let mut c = p.walk();
            kids.extend(p.named_children(&mut c).map(|ch| lower(ch, src, lang, st)));
            let _ = c;
        }
        if let Some(b) = body {
            let mut c = b.walk();
            kids.extend(b.named_children(&mut c).map(|ch| lower(ch, src, lang, st)));
            let _ = c;
        }
        return Ir::Function(kids);
    }
    Ir::Function(vec![lower(node, src, lang, st)])
}

/// Serde view of the IR tree (persisted by default; `CIE_IR_DUMP=0` drops it). Carries the local
/// name table so each blanked ref can serialize its slot and the name it stands for — the dump is
/// the consumption surface (concept discovery reads it), while the hash stays name-free.
struct IrSer<'a>(&'a Ir, &'a [String]);

impl<'a> Serialize for IrSer<'a> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        match self.0 {
            Ir::Function(cs) => {
                let mut st = s.serialize_struct("Ir", 2)?;
                st.serialize_field("kind", FN)?;
                let kids: Vec<IrSer> = cs.iter().map(|c| IrSer(c, self.1)).collect();
                st.serialize_field("children", &kids)?;
                st.end()
            }
            Ir::VarDecl(cs) => {
                let mut st = s.serialize_struct("Ir", 2)?;
                st.serialize_field("kind", DECL)?;
                let kids: Vec<IrSer> = cs.iter().map(|c| IrSer(c, self.1)).collect();
                st.serialize_field("children", &kids)?;
                st.end()
            }
            Ir::Assign { kids: cs, aug } => {
                let mut st = s.serialize_struct("Ir", 3)?;
                st.serialize_field("kind", ASSIGN)?;
                if *aug {
                    st.serialize_field("aug", &true)?;
                }
                let kids: Vec<IrSer> = cs.iter().map(|c| IrSer(c, self.1)).collect();
                st.serialize_field("children", &kids)?;
                st.end()
            }
            Ir::Loop(cs) => {
                let mut st = s.serialize_struct("Ir", 2)?;
                st.serialize_field("kind", LOOP)?;
                let kids: Vec<IrSer> = cs.iter().map(|c| IrSer(c, self.1)).collect();
                st.serialize_field("children", &kids)?;
                st.end()
            }
            Ir::Conditional(cs) => {
                let mut st = s.serialize_struct("Ir", 2)?;
                st.serialize_field("kind", COND)?;
                let kids: Vec<IrSer> = cs.iter().map(|c| IrSer(c, self.1)).collect();
                st.serialize_field("children", &kids)?;
                st.end()
            }
            Ir::Return(cs) => {
                let mut st = s.serialize_struct("Ir", 2)?;
                st.serialize_field("kind", RET)?;
                let kids: Vec<IrSer> = cs.iter().map(|c| IrSer(c, self.1)).collect();
                st.serialize_field("children", &kids)?;
                st.end()
            }
            Ir::Unknown(tag, cs) => {
                let mut st = s.serialize_struct("Ir", 3)?;
                st.serialize_field("kind", "unknown")?;
                st.serialize_field("tag", tag)?;
                let kids: Vec<IrSer> = cs.iter().map(|c| IrSer(c, self.1)).collect();
                st.serialize_field("children", &kids)?;
                st.end()
            }
            Ir::IntDiv(a, b) | Ir::FloatDiv(a, b) => {
                let k = match self.0 {
                    Ir::IntDiv(..) => "int-div",
                    _ => "float-div",
                };
                let mut st = s.serialize_struct("Ir", 3)?;
                st.serialize_field("kind", k)?;
                st.serialize_field("tag", &Option::<&str>::None)?;
                st.serialize_field("children", &[IrSer(a, self.1), IrSer(b, self.1)])?;
                st.end()
            }
            Ir::Mod(a, b) => {
                let mut st = s.serialize_struct("Ir", 3)?;
                st.serialize_field("kind", "mod")?;
                st.serialize_field("tag", &Option::<&str>::None)?;
                st.serialize_field("children", &[IrSer(a, self.1), IrSer(b, self.1)])?;
                st.end()
            }
            Ir::And(a, b) => {
                let mut st = s.serialize_struct("Ir", 3)?;
                st.serialize_field("kind", "and")?;
                st.serialize_field("tag", &Option::<&str>::None)?;
                st.serialize_field("children", &[IrSer(a, self.1), IrSer(b, self.1)])?;
                st.end()
            }
            Ir::Or(a, b) => {
                let mut st = s.serialize_struct("Ir", 3)?;
                st.serialize_field("kind", "or")?;
                st.serialize_field("tag", &Option::<&str>::None)?;
                st.serialize_field("children", &[IrSer(a, self.1), IrSer(b, self.1)])?;
                st.end()
            }
            Ir::Not(a) => {
                let mut st = s.serialize_struct("Ir", 2)?;
                st.serialize_field("kind", "not")?;
                st.serialize_field("child", &IrSer(a, self.1))?;
                st.end()
            }
            Ir::Call(callee, args) => {
                let mut st = s.serialize_struct("Ir", 3)?;
                st.serialize_field("kind", "call")?;
                st.serialize_field("callee", &IrSer(callee, self.1))?;
                let kids: Vec<IrSer> = args.iter().map(|c| IrSer(c, self.1)).collect();
                st.serialize_field("args", &kids)?;
                st.end()
            }
            Ir::Attr(o, name) => {
                let mut st = s.serialize_struct("Ir", 3)?;
                st.serialize_field("kind", "attr")?;
                st.serialize_field("name", &if name.is_empty() { None } else { Some(name.to_string()) })?;
                st.serialize_field("object", &IrSer(o, self.1))?;
                st.end()
            }
            Ir::Lit(t) => {
                let mut st = s.serialize_struct("Ir", 2)?;
                st.serialize_field("kind", "lit")?;
                st.serialize_field("of", t)?;
                st.end()
            }
            Ir::Named(n) => {
                let mut st = s.serialize_struct("Ir", 2)?;
                st.serialize_field("kind", "name")?;
                st.serialize_field("of", &n.to_string())?;
                st.end()
            }
            Ir::Ref(slot) => {
                let mut st = s.serialize_struct("Ir", 3)?;
                st.serialize_field("kind", "ref")?;
                st.serialize_field("slot", slot)?;
                if let Some(name) = self.1.get(*slot as usize) {
                    st.serialize_field("name", name)?;
                }
                st.end()
            }
        }
    }
}

// ---------------------------------------------------------------- near-duplicate comparison

/// Jaccard similarity over 3-shingles of two kind sequences, and a short lockstep structural-diff
/// summary naming up to three differing node kinds. This is the evidence text the Identity tab
/// shows beside a near-duplicate pair.
pub fn compare(seq_a: &[u16], seq_b: &[u16]) -> (f64, String) {
    if seq_a == seq_b {
        return (1.0, "identical control flow".into());
    }
    let shingle = |s: &[u16]| -> Vec<u64> {
        s.windows(3).map(|w| u64::from(w[0]) | (u64::from(w[1]) << 21) | (u64::from(w[2]) << 42)).collect()
    };
    let (a, b) = (shingle(seq_a), shingle(seq_b));
    let (small, large) = if a.len() <= b.len() { (&a, &b) } else { (&b, &a) };
    let mut set: HashSet<u64> = large.iter().copied().collect();
    let mut shared = 0usize;
    for s in small {
        if set.remove(s) {
            shared += 1;
        }
    }
    let denom = a.len() + b.len() - shared;
    let sim = if denom == 0 { 0.0 } else { shared as f64 / denom as f64 };
    // Lockstep diff over the kind sequences (positions align only until the first structure change).
    let mut diffs: Vec<String> = Vec::new();
    let n = seq_a.len().min(seq_b.len());
    for i in 0..n {
        if seq_a[i] != seq_b[i] && diffs.len() < 3 {
            diffs.push(format!("{} vs {}", label_of_id(seq_a[i]), label_of_id(seq_b[i])));
        }
    }
    let length_note = if seq_a.len() != seq_b.len() {
        format!("lengths {} vs {}", seq_a.len(), seq_b.len())
    } else {
        "same length".to_string()
    };
    let diff = if diffs.is_empty() {
        format!("{length_note}")
    } else {
        format!("{}; {}", diffs.join(", "), length_note)
    };
    // Round to three decimals so a serialized similarity is byte-stable across runs.
    (format!("{sim:.3}").parse().unwrap_or(sim), diff)
}

/// Minimum IR node count a function must reach before it can join a near-duplicate cluster —
/// the gate that keeps the documented trivial-one-liner noise (shape.rs's measurement) out.
pub const MIN_IR_NODES: u32 = 24;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_renames_do_not_change_the_hash() {
        let a = "function send(user) { let tmp = user.name; if (tmp) { return send(tmp + 1); } return 0; }";
        let b = "function receive(account) { let scratch = account.name; if (scratch) { return receive(scratch + 1); } return 0; }";
        let ha = ir_for(Lang::Ts, a, "send");
        let hb = ir_for(Lang::Ts, b, "receive");
        assert_eq!(ha.hash, hb.hash, "renaming the function and its locals must not change the IR hash");
    }

    #[test]
    fn a_real_body_change_changes_the_hash() {
        let a = "function send(user) { let tmp = user.name; return tmp + 1; }";
        let b = "function send(user) { let tmp = user.name; return tmp / 1; }";
        assert_ne!(ir_for(Lang::Ts, a, "send").hash, ir_for(Lang::Ts, b, "send").hash);
    }

    #[test]
    fn operator_differences_are_named_in_the_diff() {
        let a = "def calc(orders):\n    total = sum(orders)\n    return total // 3\n";
        let b = "def calc(orders):\n    total = sum(orders)\n    return total / 3\n";
        let ia = ir_for(Lang::Python, a, "calc");
        let ib = ir_for(Lang::Python, b, "calc");
        let (_, diff) = compare(&ia.kind_seq, &ib.kind_seq);
        assert!(diff.contains("int-div vs float-div"), "diff must name the // vs / difference: {diff}");
    }

    #[test]
    fn same_code_in_two_names_ignores_the_own_name() {
        let a = "fn reserve(batch: &str) -> bool { if batch.is_empty() { return false; } true }";
        let b = "fn hold(batch: &str) -> bool { if batch.is_empty() { return false; } true }";
        assert_eq!(ir_for(Lang::Rust, a, "reserve").hash, ir_for(Lang::Rust, b, "hold").hash);
    }

    #[test]
    fn comments_and_whitespace_cannot_break_the_hash() {
        let a = "function scale(x) { return x * 2 + 1; }";
        let b = "function scale(x) {\n  // doubled with an offset\n  return x * 2 + 1;\n}";
        let ha = ir_for(Lang::Ts, a, "scale");
        let hb = ir_for(Lang::Ts, b, "scale");
        if ha.hash != hb.hash {
            eprintln!("A: {} B: {}", ha.hash, hb.hash);
            eprintln!("A nodes={} B nodes={}", ha.nodes, hb.nodes);
            eprintln!("A seq={:?} B seq={:?}", ha.kind_seq.iter().map(|i| label_of_id(*i)).collect::<Vec<_>>(), hb.kind_seq.iter().map(|i| label_of_id(*i)).collect::<Vec<_>>());
        }
        assert_eq!(ha.hash, hb.hash);
    }

    #[test]
    fn string_values_are_blanked_but_calls_are_kept() {
        let a = "def send(msg):\n    return client.post('/a', msg)\n";
        let b = "def send(msg):\n    return client.post('/b', msg)\n";
        assert_eq!(ir_for(Lang::Python, a, "send").hash, ir_for(Lang::Python, b, "send").hash, "string values are blanked");
        let c = "def send(msg):\n    return client.put('/a', msg)\n";
        assert_ne!(ir_for(Lang::Python, a, "send").hash, ir_for(Lang::Python, c, "send").hash, "the called field name is kept");
    }

    #[test]
    fn identical_control_flow_compares_equal_and_differs_in_kind_words() {
        let seq = vec![intern(FN), intern(RET), intern(LIT)];
        let (sim, diff) = compare(&seq, &seq);
        assert_eq!(sim, 1.0);
        assert!(diff.contains("identical"));
        let other = vec![intern(FN), intern(LOOP), intern(LIT)];
        let (sim2, diff2) = compare(&seq, &other);
        assert!(sim2 < 1.0 && diff2.contains("ret vs loop"));
    }

    #[test]
    fn trivial_one_liners_stay_below_the_cluster_threshold() {
        let a = "function get(x) { return x.name; }";
        assert!(ir_for(Lang::Ts, a, "get").nodes < MIN_IR_NODES);
    }

    #[test]
    fn the_dump_carries_slots_and_names_but_the_hash_stays_name_free() {
        let src = "function pay(account, amount) { let total = amount; reserve(account, total); return total; }";
        let _d = ir_for(Lang::Ts, src, "pay");
        let d = ir_for(Lang::Ts, src, "pay");
        let dump = d.dump.expect("the dump persists by default");
        // Params, the decl's initializer and the reserve argument all name their locals.
        assert!(dump.contains("\"name\":\"account\""), "the dump names the locals: {dump}");
        assert!(dump.contains("\"name\":\"total\""), "the dump names the locals: {dump}");
        // Same-local uses share one slot: `total` appears at its decl and at both later uses.
        let slots = dump.matches("\"name\":\"total\"").count();
        assert!(slots >= 3, "total should appear for decl + 2 uses: {dump}");
        // And the hash never saw any name (renames do not change it).
        let renamed = "function pay(customer, quantity) { let grand = quantity; reserve(customer, grand); return grand; }";
        assert_eq!(d.hash, ir_for(Lang::Ts, renamed, "pay").hash, "slots are positional, not name-derived");
    }

    #[test]
    #[test]
    fn the_vector_is_deterministic_rename_stable_and_tells_bodies_apart() {
        let a = "function pay(account, amount) { let total = reserve(account, amount); if (total > 100) { throw new Reject(account); } return total; }";
        let renamed = "function pay(customer, quantity) { let grand = reserve(customer, quantity); if (grand > 100) { throw new Reject(customer); } return grand; }";
        let changed = "function pay(account, amount) { let total = reserve(account, amount); return total; }";
        let (va, vr, vc) = (ir_for(Lang::Ts, a, "pay").vec, ir_for(Lang::Ts, renamed, "pay").vec, ir_for(Lang::Ts, changed, "pay").vec);
        assert_eq!(va, vr, "a rename changes no feature the vector keeps");
        assert_ne!(va, vc, "removing the guarded throw changes the vector");
        assert!(!va.is_empty() && va.len() < 64, "sparse: {} dims of {}", va.len(), IR_VEC_DIMS);
        let dims: Vec<u16> = va.iter().map(|(d, _)| *d).collect();
        assert!(dims.windows(2).all(|w| w[0] < w[1]), "dim-sorted, no duplicates");
        let norm: f64 = va.iter().map(|(_, v)| i32::from(*v).pow(2)).sum::<i32>() as f64;
        let l2 = norm.sqrt();
        assert!(l2 > 40.0 && l2 <= 105.0, "quantized L2 stays ≈ 100: {l2}");
    }

    fn slot_order_survives_a_rename() {
        let a = "function f(alpha, beta) { let t = alpha + beta; work(t); return t; }";
        let b = "function f(zz, yy) { let q = zz + yy; work(q); return q; }";
        let da = ir_for(Lang::Ts, a, "f").dump.unwrap();
        let db = ir_for(Lang::Ts, b, "f").dump.unwrap();
        let slots_of = |d: &String| -> usize {
            serde_json::from_str::<serde_json::Value>(d).unwrap().to_string()
                .matches("\"slot\":").count()
        };
        assert_eq!(slots_of(&da), slots_of(&db));
    }


    fn ir_for(lang: Lang, src: &str, name: &str) -> IrDigest {
        use tree_sitter::Parser;
        let mut parser = Parser::new();
        let g = match lang {
            Lang::Ts => tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
            Lang::Rust => tree_sitter_rust::LANGUAGE,
            Lang::Java => tree_sitter_java::LANGUAGE,
            Lang::Go => tree_sitter_go::LANGUAGE,
            Lang::Python => tree_sitter_python::LANGUAGE,
        };
        parser.set_language(&g.into()).expect("load grammar");
        let tree = parser.parse(src, None).expect("parse");
        assert!(!tree.root_node().has_error(), "test snippet must parse: {src}");
        ir_hash(tree.root_node(), src.as_bytes(), lang, name)
    }
}