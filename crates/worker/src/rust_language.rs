//! Rust and Nirdosha v2 (`.nir`) syntax extraction.
//!
//! Current Nirdosha source is deliberately a Rust dialect: `.nir` files are
//! valid Rust parsed by `syn` in nirdosha-rt. We use the Rust tree-sitter
//! grammar here and add only Nirdosha-aware macro classification; the retired
//! native Nirdosha language is intentionally unsupported.
use crate::language::{RawCall, RawFile, RawImport, RawRead, RawSymbol, RawThrow, RawTx, RawWrite};
use tree_sitter::{Node, Parser};

const WRITERS: &[&str] = &["update", "set", "save", "insert", "upsert", "create", "increment", "decrement", "write"];
const TX: &[&str] = &["transaction", "transact", "with_transaction", "begin_transaction"];
const FAILURE_MACROS: &[&str] = &["panic", "todo", "unimplemented", "unreachable", "bail"];
const SCREEN_MACROS: &[&str] = &[
    "crud_screens", "wizard", "dashboard", "login_screen", "app_shell", "app_shell_from_toml",
    "approval_inbox", "detail_screen", "list_screen", "form_screen", "screen",
];

pub fn parse_rust(src: &str, nirdosha: bool) -> RawFile {
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_rust::LANGUAGE.into()).expect("load Rust grammar");
    let mut out = RawFile::default();
    let Some(tree) = parser.parse(src, None) else {
        out.had_errors = true;
        return out;
    };
    out.had_errors = tree.root_node().has_error();
    let mut walker = RustWalker { src: src.as_bytes(), out: &mut out, nirdosha };
    walker.visit(tree.root_node(), None, None);
    collect_path_modules(src, &mut out);
    out
}

struct RustWalker<'a> {
    src: &'a [u8],
    out: &'a mut RawFile,
    nirdosha: bool,
}

impl<'a> RustWalker<'a> {
    fn text(&self, node: Node) -> String { node.utf8_text(self.src).unwrap_or("").to_string() }

    fn push_symbol(&mut self, kind: &'static str, name: String, owner: Option<&str>, node: Node, exported: bool) -> usize {
        let qualified = owner.map_or_else(|| name.clone(), |o| format!("{o}.{name}"));
        self.out.symbols.push(RawSymbol { kind, qualified, start: node.start_byte(), end: node.end_byte(), exported });
        self.out.symbols.len() - 1
    }

    fn children(&mut self, node: Node, enclosing: Option<usize>, owner: Option<String>) {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            self.visit(child, enclosing, owner.clone());
        }
    }

    fn visit(&mut self, node: Node, enclosing: Option<usize>, owner: Option<String>) {
        match node.kind() {
            "function_item" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let idx = self.push_symbol(if owner.is_some() { "method" } else { "function" }, self.text(name), owner.as_deref(), node, is_public(node, self.src));
                    self.children(node, Some(idx), owner);
                    return;
                }
            }
            "struct_item" | "enum_item" | "trait_item" | "type_item" | "const_item" | "static_item" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let kind = match node.kind() {
                        "struct_item" => "struct", "enum_item" => "enum", "trait_item" => "trait",
                        "type_item" => "type", "const_item" => "constant", _ => "static",
                    };
                    self.push_symbol(kind, self.text(name), owner.as_deref(), node, is_public(node, self.src));
                }
            }
            "impl_item" => {
                let target = node.child_by_field_name("type").map(|n| self.text(n)).or_else(|| impl_target(&self.text(node)));
                self.children(node, enclosing, target);
                return;
            }
            "mod_item" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let module = self.text(name);
                    self.push_symbol("module", module.clone(), owner.as_deref(), node, is_public(node, self.src));
                    if node.child_by_field_name("body").is_none() {
                        self.out.imports.push(RawImport {
                            module: format!("self::{module}"), local: module, imported: "*".into(),
                            start: node.start_byte(), end: node.end_byte(),
                        });
                    }
                }
            }
            "use_declaration" => self.use_decl(node),
            "call_expression" => self.call(node, enclosing),
            "macro_invocation" => self.macro_invocation(node, enclosing),
            "assignment_expression" | "compound_assignment_expr" => self.assignment(node, enclosing),
            "field_expression" => self.field_read(node, enclosing),
            _ => {}
        }
        self.children(node, enclosing, owner);
    }

    fn use_decl(&mut self, node: Node) {
        let text = self.text(node);
        let body = text.trim().trim_start_matches("pub ").trim_start_matches("use ").trim_end_matches(';').trim();
        for (module, local, imported) in expand_use(body) {
            self.out.imports.push(RawImport { module, local, imported, start: node.start_byte(), end: node.end_byte() });
        }
    }

    fn call(&mut self, node: Node, enclosing: Option<usize>) {
        let Some(fun) = node.child_by_field_name("function") else { return };
        let text = self.text(fun);
        let (receiver, callee) = split_call_target(&text);
        if callee.is_empty() { return; }
        self.out.calls.push(RawCall { caller: enclosing, callee: callee.clone(), receiver, start: node.start_byte(), end: node.end_byte() });
        if TX.contains(&callee.as_str()) {
            self.out.txs.push(RawTx { caller: enclosing, start: node.start_byte(), end: node.end_byte() });
        }
        if WRITERS.contains(&callee.as_str()) {
            collect_struct_keys(node, self.src, enclosing, &mut self.out.writes);
        }
    }

    fn macro_invocation(&mut self, node: Node, enclosing: Option<usize>) {
        let text = self.text(node);
        let head = text.split('!').next().unwrap_or("").trim();
        let name = head.rsplit("::").next().unwrap_or(head);
        if FAILURE_MACROS.contains(&name) {
            self.out.throws.push(RawThrow { caller: enclosing, error_class: format!("{name}!"), start: node.start_byte(), end: node.end_byte() });
        }
        if self.nirdosha && SCREEN_MACROS.contains(&name) {
            let unit = value_after_key(&text, "mount").unwrap_or_else(|| format!("{name}@{}", node.start_position().row + 1));
            self.push_symbol("screen", unit, None, node, true);
        }
    }

    fn assignment(&mut self, node: Node, enclosing: Option<usize>) {
        if let Some(left) = node.child_by_field_name("left") {
            if left.kind() == "field_expression" {
                if let Some(field) = left.child_by_field_name("field") {
                    self.out.writes.push(RawWrite { caller: enclosing, field: self.text(field), start: node.start_byte(), end: node.end_byte() });
                }
            }
        }
    }

    fn field_read(&mut self, node: Node, enclosing: Option<usize>) {
        let assigned = node.parent().map_or(false, |p| matches!(p.kind(), "assignment_expression" | "compound_assignment_expr") && p.child_by_field_name("left").map_or(false, |n| n.id() == node.id()));
        if assigned { return; }
        if let Some(field) = node.child_by_field_name("field") {
            self.out.reads.push(RawRead { caller: enclosing, field: self.text(field), start: node.start_byte(), end: node.end_byte() });
        }
    }
}

fn is_public(node: Node, src: &[u8]) -> bool {
    node.utf8_text(src).unwrap_or("").trim_start().starts_with("pub ")
}

fn impl_target(text: &str) -> Option<String> {
    let head = text.split('{').next()?.trim().strip_prefix("impl")?.trim();
    Some(head.rsplit(" for ").next().unwrap_or(head).split('<').next().unwrap_or(head).trim().to_string())
}

fn split_call_target(text: &str) -> (Option<String>, String) {
    let clean = text.trim();
    if let Some((recv, name)) = clean.rsplit_once('.') { return (Some(recv.trim().to_string()), name.trim().to_string()); }
    if let Some((recv, name)) = clean.rsplit_once("::") { return (Some(recv.trim().to_string()), name.trim().to_string()); }
    (None, clean.to_string())
}

fn expand_use(body: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    if let Some(open) = body.find("::{") {
        let base = &body[..open];
        let inner = body[open + 3..].trim_end_matches('}');
        for item in inner.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let (imported, local) = item.split_once(" as ").map_or((item, item), |(a, b)| (a.trim(), b.trim()));
            if imported == "self" { out.push((base.to_string(), base.rsplit("::").next().unwrap_or(base).to_string(), "*".into())); }
            else { out.push((base.to_string(), local.to_string(), imported.to_string())); }
        }
    } else {
        let (path, local) = body.split_once(" as ").map_or((body, None), |(a, b)| (a.trim(), Some(b.trim())));
        let (module, imported) = path.rsplit_once("::").map_or((path, "*"), |(m, i)| (m, i));
        out.push((module.to_string(), local.unwrap_or(imported).to_string(), imported.to_string()));
    }
    out
}

fn value_after_key(text: &str, key: &str) -> Option<String> {
    let rest = text.split_once(&format!("{key}:"))?.1.trim_start();
    let value = rest.split(|c: char| c == ',' || c.is_whitespace()).next()?.trim();
    (!value.is_empty()).then(|| value.trim_matches('"').to_string())
}

fn collect_path_modules(src: &str, out: &mut RawFile) {
    let mut offset = 0usize;
    let lines: Vec<&str> = src.split_inclusive('\n').collect();
    for (i, line) in lines.iter().enumerate() {
        let Some(path) = line.split("path").nth(1).and_then(|s| s.split('"').nth(1)) else { offset += line.len(); continue };
        let next = lines.get(i + 1).copied().unwrap_or("");
        let trimmed = next.trim().trim_start_matches("pub ");
        if let Some(name) = trimmed.strip_prefix("mod ").and_then(|s| s.split(';').next()) {
            out.imports.push(RawImport { module: format!("./{path}"), local: name.trim().into(), imported: "*".into(), start: offset, end: offset + line.len() + next.len() });
        }
        offset += line.len();
    }
}

fn collect_struct_keys(node: Node, src: &[u8], caller: Option<usize>, writes: &mut Vec<RawWrite>) {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() == "struct_expression" {
            let mut fields = child.walk();
            for field in child.named_children(&mut fields).filter(|n| n.kind() == "field_initializer") {
                if let Some(name) = field.child_by_field_name("field") {
                    writes.push(RawWrite { caller, field: name.utf8_text(src).unwrap_or("").into(), start: field.start_byte(), end: field.end_byte() });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_rust_symbols_calls_imports_and_state() {
        let src = r#"
use crate::auth::{verify as check, User};
pub struct Service { balance: i64 }
impl Service {
    pub fn charge(&mut self) { self.balance -= 1; check(); self.commit(); }
    fn commit(&self) { panic!("failed") }
}
"#;
        let f = parse_rust(src, false);
        let names: Vec<_> = f.symbols.iter().map(|s| s.qualified.as_str()).collect();
        assert!(names.contains(&"Service"));
        assert!(names.contains(&"Service.charge"));
        assert!(names.contains(&"Service.commit"));
        assert!(f.imports.iter().any(|i| i.module == "crate::auth" && i.local == "check" && i.imported == "verify"));
        assert!(f.calls.iter().any(|c| c.callee == "check"));
        assert!(f.writes.iter().any(|w| w.field == "balance"));
        assert!(f.throws.iter().any(|t| t.error_class == "panic!"));
        assert!(!f.had_errors);
    }

    #[test]
    fn extracts_nirdosha_screen_and_path_module() {
        let src = r#"
#[path = "screens/tasks.nir"]
pub mod tasks;
nirdosha_rt::crud_screens! {
    mount: mount_tasks,
    entity: Task,
    store: task_store,
    path: "/tasks",
}
"#;
        let f = parse_rust(src, true);
        assert!(f.symbols.iter().any(|s| s.kind == "screen" && s.qualified == "mount_tasks"));
        assert!(f.imports.iter().any(|i| i.module == "./screens/tasks.nir" && i.local == "tasks"));
        assert!(!f.had_errors);
    }

    #[test]
    fn extracts_out_of_line_rust_module() {
        let f = parse_rust("pub mod auth;", false);
        assert!(f.imports.iter().any(|i| i.module == "self::auth" && i.local == "auth"));
    }

    #[test]
    fn retired_native_nir_is_not_accepted() {
        let f = parse_rust("fn main() requires(public) { print(\"x\") }", true);
        assert!(f.had_errors, "v2 .nir support must remain Rust-dialect-only");
    }
}
