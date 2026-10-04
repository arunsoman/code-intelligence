//! Syntax-level extraction with tree-sitter (C05 analyzeSyntax). Everything here is PARSED;
//! resolution happens later in index.rs and never upgrades dynamic calls.
use tree_sitter::{Node, Parser};

#[derive(Debug, Clone)]
pub struct RawSymbol {
    pub kind: &'static str,
    pub qualified: String,
    pub start: usize,
    pub end: usize,
    pub exported: bool,
}

#[derive(Debug, Clone)]
pub struct RawImport {
    pub module: String,
    /// Local binding name ("*" prefix for namespace, "default" imported name for default imports).
    pub local: String,
    pub imported: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone)]
pub struct RawCall {
    /// Index into `symbols` of the enclosing function/method, if any.
    pub caller: Option<usize>,
    pub callee: String,
    /// Receiver text for member calls (`this`, `obj`, ...).
    pub receiver: Option<String>,
    /// Declared type of the receiver when the language states it (Java fields and parameters, Go receivers, annotated Python parameters).
    pub recv_type: Option<String>,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone)]
pub struct RawThrow {
    pub caller: Option<usize>,
    /// Constructor name for `throw new X(...)`, otherwise "<expression>".
    pub error_class: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone)]
pub struct RawChannel {
    pub caller: Option<usize>,
    /// "publish" or "subscribe".
    pub role: &'static str,
    pub topic: String,
    /// Identifier passed as handler (`subscribe("t", handler)`), if any.
    pub handler: Option<String>,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone)]
pub struct RawWrite {
    pub caller: Option<usize>,
    pub field: String,
    /// The object the field is written on (`account.balance` → "account"), when statically present.
    pub receiver: Option<String>,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone)]
pub struct RawRead {
    pub caller: Option<usize>,
    pub field: String,
    pub receiver: Option<String>,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone)]
pub struct RawTx {
    pub caller: Option<usize>,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone)]
pub struct RawDeclarationReference {
    pub kind: String,
    pub target: String,
    pub property: String,
}

#[derive(Debug, Clone)]
pub struct RawDeclaration {
    pub kind: String,
    pub name: String,
    pub macro_name: Option<String>,
    pub properties: serde_json::Value,
    pub references: Vec<RawDeclarationReference>,
    pub symbol_index: usize,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone)]
pub struct RawLock {
    pub caller: Option<usize>,
    /// The lock object this call locks (receiver text, or the function name for bare helpers like `withLock(fn)`).
    pub object: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Default, Clone)]
pub struct RawFile {
    pub semantic: Vec<RawSemantic>,
    pub symbols: Vec<RawSymbol>,
    pub imports: Vec<RawImport>,
    pub calls: Vec<RawCall>,
    pub throws: Vec<RawThrow>,
    pub channels: Vec<RawChannel>,
    pub writes: Vec<RawWrite>,
    pub reads: Vec<RawRead>,
    pub txs: Vec<RawTx>,
    pub locks: Vec<RawLock>,
    pub declarations: Vec<RawDeclaration>,
    pub had_errors: bool,
}

#[derive(Debug, Clone)]
pub struct RawSemantic {
    pub caller: Option<usize>,
    pub value: serde_json::Value,
    pub start: usize,
    pub end: usize,
}

/// Versioned syntactic facts; lexical containment is not promoted to alias or effect resolution.
pub fn semantic_event(node: Node, caller: Option<usize>, src: &[u8]) -> Option<RawSemantic> {
    let kind = match node.kind() {
        "await_expression" | "await" => "AWAIT",
        "for_statement" | "for_in_statement" | "while_statement" | "do_statement" | "for_expression" | "while_expression" | "loop_expression" | "enhanced_for_statement" => "LOOP",
        "if_statement" | "if_expression" => "BRANCH",
        "call_expression" | "method_invocation" | "call" => "CALL",
        _ => return None,
    };
    let mut loops = Vec::new();
    let mut conditions = Vec::new();
    let mut parent = node.parent();
    while let Some(p) = parent {
        if matches!(p.kind(), "function_declaration" | "function_item" | "arrow_function" | "function_expression" | "method_definition" | "closure_expression" | "method_declaration" | "function_definition" | "func_literal" | "lambda_expression" | "lambda" | "constructor_declaration") { break; }
        if matches!(p.kind(), "for_statement" | "for_in_statement" | "while_statement" | "do_statement" | "for_expression" | "while_expression" | "loop_expression" | "enhanced_for_statement") { loops.push(p.start_byte()); }
        if matches!(p.kind(), "if_statement" | "if_expression") {
            if let Some(c) = p.child_by_field_name("condition") { conditions.push(c.utf8_text(src).unwrap_or("").to_owned()); }
        }
        parent = p.parent();
    }
    let callee = node.child_by_field_name("function").or_else(|| node.child_by_field_name("name")).map(|f| f.utf8_text(src).unwrap_or("").to_owned());
    Some(RawSemantic { caller, start: node.start_byte(), end: node.end_byte(), value: serde_json::json!({
        "schemaId": "defect.semantic-event.v1", "schemaVersion": 1,
        "value": { "kind": kind, "callee": callee, "enclosingLoops": loops, "pathConditions": conditions,
          "effectResolution": "UNKNOWN", "aliasResolution": "UNKNOWN", "controlFlowResolution": "LEXICAL_ONLY" }
    }) })
}

const PUBLISH: &[&str] = &["publish", "emit", "enqueue", "send", "dispatch"];
const SUBSCRIBE: &[&str] = &["subscribe", "on", "consume", "process", "listen"];
const WRITERS: &[&str] = &["update", "set", "save", "insert", "upsert", "exec", "create", "increment", "decrement"];
const TX: &[&str] = &["transaction", "withTransaction", "beginTransaction", "runInTransaction", "$transaction"];
const TEST_FNS: &[&str] = &["it", "test", "describe"];
const LOCK_FNS: &[&str] = &["lock", "acquire", "readLock", "writeLock", "rLock", "withLock", "with_lock", "synchronized", "try_lock"];
pub fn lockish(s: &str) -> bool { let l = s.to_ascii_lowercase(); l.contains("lock") || l.contains("mutex") || l.contains("semaphore") || l.contains("atomic") }

pub fn parse_ts(src: &str, tsx: bool) -> RawFile {
    let mut parser = Parser::new();
    let lang = if tsx {
        tree_sitter_typescript::LANGUAGE_TSX
    } else {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT
    };
    parser.set_language(&lang.into()).expect("load grammar");
    let mut out = RawFile::default();
    let Some(tree) = parser.parse(src, None) else {
        out.had_errors = true;
        return out;
    };
    let root = tree.root_node();
    out.had_errors = root.has_error();
    let mut w = Walker { src: src.as_bytes(), out: &mut out };
    w.visit(root, None, None, false);
    out
}

struct Walker<'a> {
    src: &'a [u8],
    out: &'a mut RawFile,
}

impl<'a> Walker<'a> {
    fn text(&self, n: Node) -> String {
        n.utf8_text(self.src).unwrap_or("").to_string()
    }

    fn push_symbol(
        &mut self,
        kind: &'static str,
        name: String,
        class: Option<&str>,
        node: Node,
        exported: bool,
    ) -> usize {
        let qualified = match class {
            Some(c) => format!("{c}.{name}"),
            None => name.clone(),
        };
        self.out.symbols.push(RawSymbol {
            kind,
            qualified,
            start: node.start_byte(),
            end: node.end_byte(),
            exported,
        });
        self.out.symbols.len() - 1
    }

    fn visit(&mut self, node: Node, enclosing: Option<usize>, class: Option<String>, exported: bool) {
        if let Some(event) = semantic_event(node, enclosing, self.src) { self.out.semantic.push(event); }
        match node.kind() {
            "export_statement" => {
                let mut c = node.walk();
                for ch in node.named_children(&mut c) {
                    self.visit(ch, enclosing, class.clone(), true);
                }
                return;
            }
            "import_statement" => {
                self.import(node);
                return;
            }
            "function_declaration" | "generator_function_declaration" => {
                if let Some(n) = node.child_by_field_name("name") {
                    let name = self.text(n);
                    let idx = self.push_symbol("function", name, None, node, exported);
                    self.children(node, Some(idx), class);
                    return;
                }
            }
            "class_declaration" | "abstract_class_declaration" => {
                if let Some(n) = node.child_by_field_name("name") {
                    let name = self.text(n);
                    self.push_symbol("class", name.clone(), None, node, exported);
                    self.children(node, enclosing, Some(name));
                    return;
                }
            }
            "interface_declaration" => {
                if let Some(n) = node.child_by_field_name("name") {
                    let name = self.text(n);
                    self.push_symbol("interface", name, None, node, exported);
                    return;
                }
            }
            "type_alias_declaration" => {
                if let Some(n) = node.child_by_field_name("name") {
                    let name = self.text(n);
                    self.push_symbol("type", name, None, node, exported);
                    return;
                }
            }
            "method_definition" => {
                if let Some(n) = node.child_by_field_name("name") {
                    let name = self.text(n);
                    let idx = self.push_symbol("method", name, class.as_deref(), node, false);
                    self.children(node, Some(idx), class);
                    return;
                }
            }
            "variable_declarator" if enclosing.is_none() => {
                let name = node.child_by_field_name("name");
                let value = node.child_by_field_name("value");
                if let (Some(n), Some(v)) = (name, value) {
                    if matches!(v.kind(), "arrow_function" | "function_expression" | "function") && n.kind() == "identifier" {
                        let name = self.text(n);
                        let idx = self.push_symbol("function", name, None, node, exported);
                        self.children(v, Some(idx), class);
                        return;
                    }
                }
            }
            "throw_statement" => {
                let class = node
                    .named_child(0)
                    .filter(|n| n.kind() == "new_expression")
                    .and_then(|n| n.child_by_field_name("constructor"))
                    .map(|n| self.text(n))
                    .unwrap_or_else(|| "<expression>".into());
                self.out.throws.push(RawThrow { caller: enclosing, error_class: class, start: node.start_byte(), end: node.end_byte() });
            }
            "assignment_expression" | "augmented_assignment_expression" => {
                if let Some(l) = node.child_by_field_name("left") {
                    if l.kind() == "member_expression" {
                        if let Some(p) = l.child_by_field_name("property") {
                            let receiver = l.child_by_field_name("object").filter(|o| matches!(o.kind(), "identifier" | "member_expression" | "this")).map(|o| self.text(o));
                            self.out.writes.push(RawWrite { caller: enclosing, field: self.text(p), receiver, start: node.start_byte(), end: node.end_byte() });
                        }
                    }
                }
            }
            "member_expression" => {
                // A property access that is neither being assigned to nor being called is a read of that field.
                if let (Some(p), Some(parent)) = (node.child_by_field_name("property"), node.parent()) {
                    let assigned = matches!(parent.kind(), "assignment_expression" | "augmented_assignment_expression") && parent.child_by_field_name("left").map_or(false, |l| l.id() == node.id());
                    let called = parent.kind() == "call_expression" && parent.child_by_field_name("function").map_or(false, |f| f.id() == node.id());
                    if !assigned && !called {
                        let receiver = node.child_by_field_name("object").filter(|o| matches!(o.kind(), "identifier" | "member_expression" | "this")).map(|o| self.text(o));
                        self.out.reads.push(RawRead { caller: enclosing, field: self.text(p), receiver, start: node.start_byte(), end: node.end_byte() });
                    }
                }
            }
            "call_expression" => {
                if let Some(idx) = self.test_call(node, enclosing) {
                    // Calls made inside a test body belong to the test symbol.
                    self.children(node, Some(idx), class);
                    return;
                }
                self.call(node, enclosing);
                self.channel_write_tx(node, enclosing);
            }
            _ => {}
        }
        self.children(node, enclosing, class);
        let _ = exported;
    }

    fn children(&mut self, node: Node, enclosing: Option<usize>, class: Option<String>) {
        let mut c = node.walk();
        for ch in node.named_children(&mut c) {
            self.visit(ch, enclosing, class.clone(), false);
        }
    }

    fn first_string_arg(&self, node: Node) -> Option<String> {
        let args = node.child_by_field_name("arguments")?;
        let first = args.named_child(0)?;
        match first.kind() {
            "string" => Some(self.text(first).trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string()),
            "template_string" if !self.text(first).contains("${") => Some(self.text(first).trim_matches('`').to_string()),
            _ => None,
        }
    }

    fn callee_name(&self, node: Node) -> Option<String> {
        let f = node.child_by_field_name("function")?;
        match f.kind() {
            "identifier" => Some(self.text(f)),
            "member_expression" => f.child_by_field_name("property").map(|p| self.text(p)),
            _ => None,
        }
    }

    /// `it("name", ...)`, `test(...)`, `describe(...)` become `test` symbols.
    fn test_call(&mut self, node: Node, _enclosing: Option<usize>) -> Option<usize> {
        let f = node.child_by_field_name("function")?;
        if f.kind() != "identifier" || !TEST_FNS.contains(&self.text(f).as_str()) {
            return None;
        }
        let name = self.first_string_arg(node)?;
        Some(self.push_symbol("test", name, None, node, false))
    }

    fn channel_write_tx(&mut self, node: Node, enclosing: Option<usize>) {
        let Some(name) = self.callee_name(node) else { return };
        let (s, e) = (node.start_byte(), node.end_byte());
        if TX.contains(&name.as_str()) {
            self.out.txs.push(RawTx { caller: enclosing, start: s, end: e });
        }
        // Lock acquisition: `x.lock()` / `x.acquire()` / `withLock(...)` where the receiver looks
        // like a lock. Recorded as a fact so the race-window view can honour them.
        let is_member = node.child_by_field_name("function").map_or(false, |f| f.kind() == "member_expression");
        let recv_name = if is_member {
            node.child_by_field_name("function")
                .and_then(|f| f.child_by_field_name("object"))
                .filter(|o| matches!(o.kind(), "identifier" | "member_expression"))
                .map(|o| self.text(o))
        } else { None };
        let bare_lock = !is_member && LOCK_FNS.contains(&name.as_str());
        let receiver = recv_name.unwrap_or_default();
        let looks_lockish = bare_lock || (LOCK_FNS.contains(&name.as_str()) && (receiver.is_empty() || lockish(&receiver)));
        if looks_lockish {
            let obj = if receiver.is_empty() { name.clone() } else { receiver };
            self.out.locks.push(RawLock { caller: enclosing, object: obj, start: s, end: e });
        }
        let is_member = node.child_by_field_name("function").map_or(false, |f| f.kind() == "member_expression");
        if is_member {
            if let Some(topic) = self.first_string_arg(node) {
                let role = if PUBLISH.contains(&name.as_str()) {
                    Some("publish")
                } else if SUBSCRIBE.contains(&name.as_str()) {
                    Some("subscribe")
                } else {
                    None
                };
                if let Some(role) = role {
                    let handler = node
                        .child_by_field_name("arguments")
                        .and_then(|a| a.named_child(1))
                        .filter(|h| h.kind() == "identifier")
                        .map(|h| self.text(h));
                    self.out.channels.push(RawChannel { caller: enclosing, role, topic, handler, start: s, end: e });
                }
            }
        }
        if WRITERS.contains(&name.as_str()) {
            if let Some(args) = node.child_by_field_name("arguments") {
                let mut c = args.walk();
                for a in args.named_children(&mut c) {
                    if a.kind() != "object" {
                        continue;
                    }
                    let mut oc = a.walk();
                    for pair in a.named_children(&mut oc) {
                        let key = match pair.kind() {
                            "pair" => pair.child_by_field_name("key").map(|k| self.text(k)),
                            "shorthand_property_identifier" => Some(self.text(pair)),
                            _ => None,
                        };
                        if let Some(k) = key {
                            // A literal write whose value is a member access inherits that receiver
                            // (`{ balance: account.balance }` writes account.balance, not a bare field).
                            let receiver = (pair.kind() == "pair")
                                .then(|| pair.child_by_field_name("value"))
                                .flatten()
                                .filter(|v| v.kind() == "member_expression")
                                .and_then(|v| v.child_by_field_name("object"))
                                .filter(|o| matches!(o.kind(), "identifier" | "member_expression"))
                                .map(|o| self.text(o));
                            self.out.writes.push(RawWrite { caller: enclosing, field: k.trim_matches(|c| c == '"' || c == '\'').to_string(), receiver, start: pair.start_byte(), end: pair.end_byte() });
                        }
                    }
                }
            }
        }
    }

    fn call(&mut self, node: Node, enclosing: Option<usize>) {
        let Some(f) = node.child_by_field_name("function") else { return };
        let (callee, receiver) = match f.kind() {
            "identifier" => (self.text(f), None),
            "member_expression" => {
                let prop = f.child_by_field_name("property").map(|p| self.text(p)).unwrap_or_default();
                let obj = f.child_by_field_name("object").map(|o| self.text(o));
                (prop, obj)
            }
            // Computed/IIFE/etc.: record as an explicit unknown rather than dropping it.
            _ => ("<computed>".to_string(), None),
        };
        if callee.is_empty() {
            return;
        }
        self.out.calls.push(RawCall {
            caller: enclosing,
            callee,
            receiver,
            recv_type: None,
            start: node.start_byte(),
            end: node.end_byte(),
        });
    }

    fn import(&mut self, node: Node) {
        let Some(srcn) = node.child_by_field_name("source") else { return };
        let module = self.text(srcn).trim_matches(|c| c == '"' || c == '\'').to_string();
        let (s, e) = (node.start_byte(), node.end_byte());
        let mut c = node.walk();
        for ch in node.named_children(&mut c) {
            if ch.kind() != "import_clause" {
                continue;
            }
            let mut cc = ch.walk();
            for part in ch.named_children(&mut cc) {
                match part.kind() {
                    "identifier" => self.out.imports.push(RawImport {
                        module: module.clone(),
                        local: self.text(part),
                        imported: "default".into(),
                        start: s,
                        end: e,
                    }),
                    "namespace_import" => {
                        let mut nc = part.walk();
                        if let Some(id) = part.named_children(&mut nc).find(|n| n.kind() == "identifier") {
                            self.out.imports.push(RawImport {
                                module: module.clone(),
                                local: self.text(id),
                                imported: "*".into(),
                                start: s,
                                end: e,
                            });
                        };
                    }
                    "named_imports" => {
                        let mut nc = part.walk();
                        for spec in part.named_children(&mut nc).filter(|n| n.kind() == "import_specifier") {
                            let name = spec.child_by_field_name("name").map(|n| self.text(n));
                            let alias = spec.child_by_field_name("alias").map(|n| self.text(n));
                            if let Some(name) = name {
                                self.out.imports.push(RawImport {
                                    module: module.clone(),
                                    local: alias.unwrap_or_else(|| name.clone()),
                                    imported: name,
                                    start: s,
                                    end: e,
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        // Side-effect imports (`import "x"`) have no clause; keep module-level edge.
        if !self.out.imports.iter().any(|i| i.module == module) {
            self.out.imports.push(RawImport {
                module,
                local: String::new(),
                imported: String::new(),
                start: s,
                end: e,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_symbols_imports_calls() {
        let src = r#"
import { verify as v } from "./token";
import def from "pkg";
export function login(u: string) { return v(u); }
export class Svc { run() { this.run(); helper(); } }
const helper = () => { dyn[x](); };
"#;
        let f = parse_ts(src, false);
        let names: Vec<_> = f.symbols.iter().map(|s| s.qualified.as_str()).collect();
        assert_eq!(names, ["login", "Svc", "Svc.run", "helper"]);
        assert!(f.symbols[0].exported && !f.symbols[3].exported);
        assert_eq!(f.imports.len(), 2);
        assert_eq!(f.imports[0].local, "v");
        assert_eq!(f.imports[0].imported, "verify");
        let callees: Vec<_> = f.calls.iter().map(|c| c.callee.as_str()).collect();
        assert_eq!(callees, ["v", "run", "helper", "<computed>"]); // dyn[x]() kept as unknown
        assert!(!f.had_errors);
    }
}
