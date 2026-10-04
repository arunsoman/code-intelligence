//! Java (Spring Boot), Go and Python syntax extraction. Same contract as the TypeScript and Rust walkers: everything here is PARSED,
//! resolution happens later in index.rs, and a call whose target cannot be named statically stays unknown. Where the language states a
//! receiver's type (a Java field or parameter, a Go receiver, an annotated Python parameter) the type is recorded with the call, so
//! `paymentService.charge()` can be tied to `PaymentService.charge`; where it does not, the call stays fog.
use crate::language::{lockish, RawCall, RawChannel, RawFile, RawImport, RawLock, RawRead, RawSymbol, RawThrow, RawTx, RawWrite};
use std::collections::HashMap;
use tree_sitter::{Node, Parser};

#[derive(Clone, Copy, PartialEq)]
enum Lang { Java, Go, Python }

const PUBLISH: &[&str] = &["publish", "emit", "enqueue", "send", "dispatch", "convertandsend", "produce"];
const SUBSCRIBE: &[&str] = &["subscribe", "consume", "listen", "on"];
const TX_CALLS: &[&str] = &["transaction", "transact", "withtransaction", "begintransaction", "begintx", "begin", "withtx", "runintransaction", "atomic"];
const LOCK_CALLS: &[&str] = &["lock", "rlock", "acquire", "readlock", "writelock", "trylock", "synchronized"];
const LISTENERS: &[&str] = &["KafkaListener", "RabbitListener", "JmsListener", "SqsListener", "StreamListener", "EventListener"];

pub fn parse_java(src: &str, rel: &str) -> RawFile { parse(src, rel, Lang::Java) }
pub fn parse_go(src: &str, rel: &str) -> RawFile { parse(src, rel, Lang::Go) }
pub fn parse_python(src: &str, rel: &str) -> RawFile { parse(src, rel, Lang::Python) }

fn parse(src: &str, rel: &str, lang: Lang) -> RawFile {
    let mut parser = Parser::new();
    let l = match lang { Lang::Java => tree_sitter_java::LANGUAGE.into(), Lang::Go => tree_sitter_go::LANGUAGE.into(), Lang::Python => tree_sitter_python::LANGUAGE.into() };
    parser.set_language(&l).expect("load grammar");
    let mut out = RawFile::default();
    let Some(tree) = parser.parse(src, None) else { out.had_errors = true; return out };
    out.had_errors = tree.root_node().has_error();
    let test_file = match lang {
        Lang::Go => rel.ends_with("_test.go"),
        Lang::Python => { let n = rel.rsplit('/').next().unwrap_or(rel); n.starts_with("test_") || n.ends_with("_test.py") || rel.contains("/tests/") }
        Lang::Java => rel.contains("/test/") || rel.ends_with("Test.java") || rel.ends_with("Tests.java"),
    };
    let mut w = Poly { lang, src: src.as_bytes(), out: &mut out, test_file, fields: HashMap::new(), locals: HashMap::new(), struct_fields: HashMap::new(), class_tx: false };
    if lang == Lang::Go { w.collect_go_structs(tree.root_node()); }
    w.visit(tree.root_node(), None, None);
    out
}

struct Poly<'a> {
    lang: Lang,
    src: &'a [u8],
    out: &'a mut RawFile,
    test_file: bool,
    /// Field name → declared type of the class being walked (Java).
    fields: HashMap<String, String>,
    /// Parameter / receiver name → declared type of the function being walked.
    locals: HashMap<String, String>,
    /// Go: struct name → field name → type.
    struct_fields: HashMap<String, HashMap<String, String>>,
    class_tx: bool,
}

/// Go keeps the package qualifier (`ledger.Ledger`), because the type may live in an imported package.
fn qual_type(t: &str) -> String {
    let t = t.trim().trim_start_matches('*').trim_start_matches('&').trim_start_matches("[]");
    t.split('[').next().unwrap_or(t).trim().to_string()
}
fn simple_type(t: &str) -> String {
    let t = t.trim().trim_start_matches('*').trim_start_matches('&').trim_start_matches("[]");
    let t = t.split('<').next().unwrap_or(t).split('[').next().unwrap_or(t);
    t.rsplit('.').next().unwrap_or(t).trim().to_string()
}

impl<'a> Poly<'a> {
    fn text(&self, n: Node) -> String { n.utf8_text(self.src).unwrap_or("").to_string() }
    fn push(&mut self, kind: &'static str, name: String, owner: Option<&str>, n: Node, exported: bool) -> usize {
        let qualified = owner.map_or_else(|| name.clone(), |o| format!("{o}.{name}"));
        self.out.symbols.push(RawSymbol { kind, qualified, start: n.start_byte(), end: n.end_byte(), exported });
        self.out.symbols.len() - 1
    }
    fn kids(&mut self, n: Node, enc: Option<usize>, owner: Option<String>) {
        let mut c = n.walk();
        for ch in n.named_children(&mut c) { self.visit(ch, enc, owner.clone()); }
    }
    fn first_string(&self, n: Node) -> Option<String> {
        // The first literal string among a call's or annotation's arguments.
        let mut stack = vec![n];
        while let Some(x) = stack.pop() {
            if matches!(x.kind(), "string_literal" | "string" | "interpreted_string_literal" | "raw_string_literal") {
                let t = self.text(x);
                let t = t.trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string();
                if !t.contains("${") && !t.contains('{') { return Some(t); }
                return None;
            }
            let mut c = x.walk();
            let mut kids: Vec<Node> = x.named_children(&mut c).collect();
            kids.reverse();
            stack.extend(kids);
        }
        None
    }

    fn visit(&mut self, n: Node, enc: Option<usize>, owner: Option<String>) {
        if let Some(ev) = crate::language::semantic_event(n, enc, self.src) { self.out.semantic.push(ev); }
        match self.lang {
            Lang::Java => if self.java(n, enc, &owner) { return },
            Lang::Go => if self.go(n, enc, &owner) { return },
            Lang::Python => if self.python(n, enc, &owner) { return },
        }
        self.kids(n, enc, owner);
    }

    // ------------------------------------------------------------------------------------------------ Java
    fn annotations(&self, n: Node) -> Vec<(String, Option<String>, (usize, usize))> {
        let mut out = vec![];
        let mut c = n.walk();
        for ch in n.named_children(&mut c) {
            if ch.kind() == "modifiers" {
                let mut mc = ch.walk();
                for a in ch.named_children(&mut mc) {
                    if matches!(a.kind(), "annotation" | "marker_annotation") {
                        let name = a.child_by_field_name("name").map(|x| self.text(x)).unwrap_or_default();
                        out.push((simple_type(&name), self.first_string(a), (a.start_byte(), a.end_byte())));
                    }
                }
            }
        }
        out
    }
    fn java(&mut self, n: Node, enc: Option<usize>, owner: &Option<String>) -> bool {
        match n.kind() {
            "class_declaration" | "interface_declaration" | "enum_declaration" | "record_declaration" => {
                let Some(name) = n.child_by_field_name("name") else { return false };
                let kind = if n.kind() == "interface_declaration" { "interface" } else { "class" };
                let public = self.text(n).trim_start().starts_with("public") || self.text(n).contains("public ");
                let nm = self.text(name);
                self.push(kind, nm.clone(), owner.as_deref(), n, public);
                let q = owner.as_ref().map_or(nm.clone(), |o| format!("{o}.{nm}"));
                let saved = std::mem::take(&mut self.fields);
                let saved_tx = self.class_tx;
                self.class_tx = self.annotations(n).iter().any(|(a, _, _)| a == "Transactional");
                if let Some(body) = n.child_by_field_name("body") {
                    let mut c = body.walk();
                    for m in body.named_children(&mut c) {
                        if m.kind() == "field_declaration" {
                            if let (Some(t), Some(d)) = (m.child_by_field_name("type"), m.child_by_field_name("declarator")) {
                                if let Some(dn) = d.child_by_field_name("name") { self.fields.insert(self.text(dn), simple_type(&self.text(t))); }
                            }
                        }
                    }
                }
                self.kids(n, enc, Some(q));
                self.fields = saved; self.class_tx = saved_tx;
                true
            }
            "method_declaration" | "constructor_declaration" => {
                let Some(name) = n.child_by_field_name("name") else { return false };
                let anns = self.annotations(n);
                let is_test = anns.iter().any(|(a, _, _)| a == "Test" || a == "ParameterizedTest" || a == "RepeatedTest");
                let nm = self.text(name);
                let kind = if is_test { "test" } else { "method" };
                let public = self.text(n).trim_start().starts_with("public") || anns.iter().any(|(a, _, _)| a.ends_with("Mapping"));
                let idx = self.push(kind, nm, owner.as_deref(), n, public);
                if self.class_tx || anns.iter().any(|(a, _, _)| a == "Transactional") {
                    let (ts, te) = anns.iter().find(|(a, _, _)| a == "Transactional").map(|(_, _, r)| *r).unwrap_or((n.start_byte(), n.end_byte()));
                    self.out.txs.push(RawTx { caller: Some(idx), start: ts, end: te });
                }
                for (a, topic, (ns, ne)) in &anns {
                    if LISTENERS.contains(&a.as_str()) { if let Some(t) = topic { self.out.channels.push(RawChannel { caller: Some(idx), role: "subscribe", topic: t.clone(), handler: None, start: *ns, end: *ne }); } }
                }
                let saved = std::mem::take(&mut self.locals);
                if let Some(ps) = n.child_by_field_name("parameters") {
                    let mut c = ps.walk();
                    for p in ps.named_children(&mut c) {
                        if let (Some(t), Some(nm)) = (p.child_by_field_name("type"), p.child_by_field_name("name")) { self.locals.insert(self.text(nm), simple_type(&self.text(t))); }
                    }
                }
                self.kids(n, Some(idx), owner.clone());
                self.locals = saved;
                true
            }
            "import_declaration" => {
                let t = self.text(n);
                let body = t.trim().trim_start_matches("import").trim().trim_end_matches(';').trim();
                if body.starts_with("static ") || body.ends_with(".*") { return false; }
                let local = body.rsplit('.').next().unwrap_or(body).to_string();
                self.out.imports.push(RawImport { module: format!("java:{body}"), local, imported: "*".into(), start: n.start_byte(), end: n.end_byte() });
                false
            }
            "method_invocation" => {
                let Some(name) = n.child_by_field_name("name") else { return false };
                let callee = self.text(name);
                let recv = n.child_by_field_name("object").map(|o| self.text(o));
                let (receiver, recv_type) = match recv.as_deref() {
                    None => (Some("this".to_string()), None),
                    Some("this") => (Some("this".to_string()), None),
                    Some(r) => {
                        let key = r.strip_prefix("this.").unwrap_or(r);
                        let ty = self.locals.get(key).or_else(|| self.fields.get(key)).cloned()
                            .or_else(|| key.chars().next().filter(|c| c.is_uppercase()).map(|_| simple_type(key)));
                        (Some(r.to_string()), ty)
                    }
                };
                self.call_common(n, enc, callee, receiver, recv_type);
                false
            }
            "throw_statement" => {
                let mut c = n.walk();
                let class = n.named_children(&mut c).next().and_then(|e| if e.kind() == "object_creation_expression" { e.child_by_field_name("type").map(|t| simple_type(&self.text(t))) } else { None }).unwrap_or_else(|| "<expression>".into());
                self.out.throws.push(RawThrow { caller: enc, error_class: class, start: n.start_byte(), end: n.end_byte() });
                false
            }
            "assignment_expression" => { self.assign(n, enc, "left"); false }
            "field_access" => { self.read(n, enc, "object", "field"); false }
            "synchronized_statement" => {
                let obj = n.named_child(0).map(|x| self.text(x)).unwrap_or_else(|| "this".into());
                self.out.locks.push(RawLock { caller: enc, object: obj.trim_matches(|c| c == '(' || c == ')').to_string(), start: n.start_byte(), end: n.end_byte() });
                false
            }
            _ => false,
        }
    }

    // ------------------------------------------------------------------------------------------------ shared
    fn call_common(&mut self, n: Node, enc: Option<usize>, callee: String, receiver: Option<String>, recv_type: Option<String>) {
        if callee.is_empty() { return; }
        let (s, e) = (n.start_byte(), n.end_byte());
        let low = callee.to_ascii_lowercase();
        self.out.calls.push(RawCall { caller: enc, callee: callee.clone(), receiver: receiver.clone(), recv_type, start: s, end: e });
        if TX_CALLS.contains(&low.as_str()) { self.out.txs.push(RawTx { caller: enc, start: s, end: e }); }
        if LOCK_CALLS.contains(&low.as_str()) {
            let r = receiver.clone().unwrap_or_default();
            if r.is_empty() || lockish(&r) { self.out.locks.push(RawLock { caller: enc, object: if r.is_empty() { callee.clone() } else { r }, start: s, end: e }); }
        }
        if receiver.as_deref().map_or(false, |r| r != "this" && r != "self") {
            if let Some(topic) = n.child_by_field_name("arguments").and_then(|a| a.named_child(0)).and_then(|a| self.first_string(a).filter(|_| matches!(a.kind(), "string_literal" | "string" | "interpreted_string_literal" | "raw_string_literal"))) {
                let role = if PUBLISH.contains(&low.as_str()) { Some("publish") } else if SUBSCRIBE.contains(&low.as_str()) { Some("subscribe") } else { None };
                if let Some(role) = role {
                    let handler = n.child_by_field_name("arguments").and_then(|a| a.named_child(1)).filter(|h| h.kind() == "identifier").map(|h| self.text(h));
                    self.out.channels.push(RawChannel { caller: enc, role, topic, handler, start: s, end: e });
                }
            }
        }
    }
    fn assign(&mut self, n: Node, enc: Option<usize>, left_field: &str) {
        let Some(l) = n.child_by_field_name(left_field) else { return };
        let (recv, field) = match l.kind() {
            "field_access" => (l.child_by_field_name("object").map(|o| self.text(o)), l.child_by_field_name("field").map(|f| self.text(f))),
            "attribute" => (l.child_by_field_name("object").map(|o| self.text(o)), l.child_by_field_name("attribute").map(|f| self.text(f))),
            "selector_expression" => (l.child_by_field_name("operand").map(|o| self.text(o)), l.child_by_field_name("field").map(|f| self.text(f))),
            _ => (None, None),
        };
        if let Some(field) = field { self.out.writes.push(RawWrite { caller: enc, field, receiver: recv, start: n.start_byte(), end: n.end_byte() }); }
    }
    fn read(&mut self, n: Node, enc: Option<usize>, obj: &str, field: &str) {
        let Some(p) = n.parent() else { return };
        // A field on the left of an assignment, or the function of a call, is not a read.
        let is_target = p.child_by_field_name("left").map_or(false, |l| l.id() == n.id());
        let is_callee = matches!(p.kind(), "call_expression" | "call") && p.child_by_field_name("function").map_or(false, |f| f.id() == n.id());
        if is_target || is_callee { return; }
        let (Some(o), Some(f)) = (n.child_by_field_name(obj), n.child_by_field_name(field)) else { return };
        self.out.reads.push(RawRead { caller: enc, field: self.text(f), receiver: Some(self.text(o)), start: n.start_byte(), end: n.end_byte() });
    }

    // ------------------------------------------------------------------------------------------------ Go
    fn collect_go_structs(&mut self, root: Node) {
        let mut stack = vec![root];
        while let Some(x) = stack.pop() {
            if x.kind() == "type_spec" {
                if let (Some(nm), Some(t)) = (x.child_by_field_name("name"), x.child_by_field_name("type")) {
                    if t.kind() == "struct_type" {
                        let mut fields = HashMap::new();
                        let mut c = t.walk();
                        for fl in t.named_children(&mut c) {
                            let mut c2 = fl.walk();
                            for fd in fl.named_children(&mut c2) {
                                if fd.kind() == "field_declaration" {
                                    if let (Some(ft), Some(fname)) = (fd.child_by_field_name("type"), fd.child_by_field_name("name")) { fields.insert(self.text(fname), qual_type(&self.text(ft))); }
                                }
                            }
                        }
                        self.struct_fields.insert(self.text(nm), fields);
                    }
                }
            }
            let mut c = x.walk();
            stack.extend(x.named_children(&mut c));
        }
    }
    fn go_params(&mut self, list: Node) {
        let mut c = list.walk();
        for p in list.named_children(&mut c) {
            if p.kind() == "parameter_declaration" {
                if let Some(t) = p.child_by_field_name("type") {
                    let ty = qual_type(&self.text(t));
                    let mut c2 = p.walk();
                    for nm in p.named_children(&mut c2) { if nm.kind() == "identifier" { self.locals.insert(self.text(nm), ty.clone()); } }
                }
            }
        }
    }
    fn go(&mut self, n: Node, enc: Option<usize>, owner: &Option<String>) -> bool {
        match n.kind() {
            "function_declaration" | "method_declaration" => {
                let Some(name) = n.child_by_field_name("name") else { return false };
                let nm = self.text(name);
                let mut own: Option<String> = None;
                let saved = std::mem::take(&mut self.locals);
                if n.kind() == "method_declaration" {
                    if let Some(r) = n.child_by_field_name("receiver") {
                        self.go_params(r);
                        let mut c = r.walk();
                        own = r.named_children(&mut c).find_map(|p| p.child_by_field_name("type").map(|t| simple_type(&self.text(t))));
                    }
                }
                if let Some(ps) = n.child_by_field_name("parameters") { self.go_params(ps); }
                let is_test = self.test_file && (nm.starts_with("Test") || nm.starts_with("Benchmark")) && own.is_none();
                let kind = if is_test { "test" } else if own.is_some() { "method" } else { "function" };
                let idx = self.push(kind, nm.clone(), own.as_deref().or(owner.as_deref()), n, nm.chars().next().map_or(false, |c| c.is_uppercase()));
                self.kids(n, Some(idx), owner.clone());
                self.locals = saved;
                true
            }
            "type_spec" => {
                if let (Some(nm), Some(t)) = (n.child_by_field_name("name"), n.child_by_field_name("type")) {
                    let kind = match t.kind() { "struct_type" => "struct", "interface_type" => "interface", _ => "type" };
                    let name = self.text(nm);
                    let exported = name.chars().next().map_or(false, |c| c.is_uppercase());
                    self.push(kind, name, None, n, exported);
                }
                false
            }
            "import_spec" => {
                if let Some(p) = n.child_by_field_name("path") {
                    let path = self.text(p).trim_matches('"').to_string();
                    let alias = n.child_by_field_name("name").map(|a| self.text(a));
                    let local = alias.clone().unwrap_or_else(|| path.rsplit('/').next().unwrap_or(&path).to_string());
                    if local != "_" && local != "." { self.out.imports.push(RawImport { module: format!("go:{path}"), local, imported: "*".into(), start: n.start_byte(), end: n.end_byte() }); }
                }
                false
            }
            "call_expression" => {
                let Some(f) = n.child_by_field_name("function") else { return false };
                match f.kind() {
                    "identifier" => {
                        let name = self.text(f);
                        if name == "panic" { self.out.throws.push(RawThrow { caller: enc, error_class: "panic".into(), start: n.start_byte(), end: n.end_byte() }); }
                        else { self.call_common(n, enc, name, None, None); }
                    }
                    "selector_expression" => {
                        let callee = f.child_by_field_name("field").map(|x| self.text(x)).unwrap_or_default();
                        let operand = f.child_by_field_name("operand").map(|o| self.text(o));
                        let ty = operand.as_deref().and_then(|o| {
                            let mut parts = o.split('.');
                            let first = parts.next()?;
                            let mut t = self.locals.get(first)?.clone();
                            for fld in parts { t = self.struct_fields.get(simple_type(&t).as_str())?.get(fld)?.clone(); }
                            Some(t)
                        });
                        self.call_common(n, enc, callee, operand, ty);
                    }
                    _ => self.call_common(n, enc, "<computed>".into(), None, None),
                }
                false
            }
            "short_var_declaration" => {
                // `s := &Server{}` or `s := Server{}`: the variable has that type from here on.
                if let (Some(l), Some(r)) = (n.child_by_field_name("left"), n.child_by_field_name("right")) {
                    let (lname, rn) = (l.named_child(0).map(|x| self.text(x)), r.named_child(0));
                    if let (Some(lname), Some(rn)) = (lname, rn) {
                        let lit = if rn.kind() == "unary_expression" { rn.named_child(0) } else { Some(rn) };
                        if let Some(lit) = lit.filter(|x| x.kind() == "composite_literal") { if let Some(t) = lit.child_by_field_name("type") { self.locals.insert(lname, qual_type(&self.text(t))); } }
                    }
                }
                false
            }
            "assignment_statement" => { self.assign(n, enc, "left"); false }
            "selector_expression" => { self.read(n, enc, "operand", "field"); false }
            _ => false,
        }
    }

    // ------------------------------------------------------------------------------------------------ Python
    fn decorators(&self, n: Node) -> Vec<(String, Option<String>, (usize, usize))> {
        let mut out = vec![];
        let mut c = n.walk();
        for d in n.named_children(&mut c) {
            if d.kind() == "decorator" {
                let t = self.text(d);
                let name = t.trim_start_matches('@').split('(').next().unwrap_or("").trim().to_string();
                out.push((name, self.first_string(d), (d.start_byte(), d.end_byte())));
            }
        }
        out
    }
    fn python(&mut self, n: Node, enc: Option<usize>, owner: &Option<String>) -> bool {
        match n.kind() {
            "decorated_definition" => {
                let decs = self.decorators(n);
                if let Some(def) = n.child_by_field_name("definition") {
                    self.def_with(def, enc, owner, &decs);
                    return true;
                }
                false
            }
            "function_definition" | "class_definition" => { self.def_with(n, enc, owner, &[]); true }
            "import_statement" => {
                let mut c = n.walk();
                for ch in n.named_children(&mut c) {
                    let (name, alias) = match ch.kind() {
                        "dotted_name" => (self.text(ch), None),
                        "aliased_import" => (ch.child_by_field_name("name").map(|x| self.text(x)).unwrap_or_default(), ch.child_by_field_name("alias").map(|x| self.text(x))),
                        _ => continue,
                    };
                    let local = alias.unwrap_or_else(|| name.split('.').next().unwrap_or(&name).to_string());
                    // `import a.b` binds `a`; `import a.b as m` binds `m` to the module a.b.
                    let module = if self.text(ch).contains(" as ") || !name.contains('.') { name.clone() } else { name.split('.').next().unwrap_or(&name).to_string() };
                    self.out.imports.push(RawImport { module: format!("py:{module}"), local, imported: "*".into(), start: n.start_byte(), end: n.end_byte() });
                }
                false
            }
            "import_from_statement" => {
                let module = n.child_by_field_name("module_name").map(|m| self.text(m)).unwrap_or_default();
                let mut c = n.walk();
                let names: Vec<Node> = n.children_by_field_name("name", &mut c).collect();
                for nm in names {
                    let (imported, local) = if nm.kind() == "aliased_import" { (nm.child_by_field_name("name").map(|x| self.text(x)).unwrap_or_default(), nm.child_by_field_name("alias").map(|x| self.text(x)).unwrap_or_default()) } else { (self.text(nm), self.text(nm)) };
                    self.out.imports.push(RawImport { module: format!("py:{module}"), local, imported, start: n.start_byte(), end: n.end_byte() });
                }
                false
            }
            "call" => {
                let Some(f) = n.child_by_field_name("function") else { return false };
                match f.kind() {
                    "identifier" => { let nm = self.text(f); self.call_common(n, enc, nm, None, None); }
                    "attribute" => {
                        let callee = f.child_by_field_name("attribute").map(|x| self.text(x)).unwrap_or_default();
                        let obj = f.child_by_field_name("object").map(|o| self.text(o));
                        let ty = obj.as_deref().and_then(|o| self.locals.get(o).cloned().or_else(|| o.strip_prefix("self.").and_then(|a| self.fields.get(a).cloned())));
                        self.call_common(n, enc, callee, obj, ty);
                    }
                    _ => self.call_common(n, enc, "<computed>".into(), None, None),
                }
                false
            }
            "raise_statement" => {
                let mut c = n.walk();
                let class = n.named_children(&mut c).next().map(|e| { let t = self.text(e); if e.kind() == "call" { e.child_by_field_name("function").map(|f| simple_type(&self.text(f))).unwrap_or(t) } else if e.kind() == "identifier" && t.chars().next().map_or(false, |c| c.is_uppercase()) { t } else { "<expression>".into() } }).unwrap_or_else(|| "<expression>".into());
                self.out.throws.push(RawThrow { caller: enc, error_class: class, start: n.start_byte(), end: n.end_byte() });
                false
            }
            "assignment" | "augmented_assignment" => {
                // `self.ledger = ledger` where `ledger` is an annotated parameter: the attribute has that type.
                if let (Some(l), Some(r)) = (n.child_by_field_name("left"), n.child_by_field_name("right")) {
                    if l.kind() == "attribute" && l.child_by_field_name("object").map_or(false, |o| self.text(o) == "self") && r.kind() == "identifier" {
                        if let (Some(a), Some(t)) = (l.child_by_field_name("attribute"), self.locals.get(&self.text(r)).cloned()) { self.fields.insert(self.text(a), t); }
                    }
                }
                self.assign(n, enc, "left"); false
            }
            "attribute" => { self.read(n, enc, "object", "attribute"); false }
            "with_statement" => {
                let t = self.text(n);
                let head = t.lines().next().unwrap_or("").to_ascii_lowercase();
                if head.contains("transaction") || head.contains("atomic") { self.out.txs.push(RawTx { caller: enc, start: n.start_byte(), end: n.end_byte() }); }
                else if lockish(&head) { self.out.locks.push(RawLock { caller: enc, object: head.trim_start_matches("with ").trim_end_matches(':').trim().to_string(), start: n.start_byte(), end: n.end_byte() }); }
                false
            }
            _ => false,
        }
    }
    fn def_with(&mut self, n: Node, enc: Option<usize>, owner: &Option<String>, decs: &[(String, Option<String>, (usize, usize))]) {
        let Some(name) = n.child_by_field_name("name") else { return };
        let nm = self.text(name);
        if n.kind() == "class_definition" {
            self.push("class", nm.clone(), owner.as_deref(), n, !nm.starts_with('_'));
            let q = owner.as_ref().map_or(nm.clone(), |o| format!("{o}.{nm}"));
            let saved = std::mem::take(&mut self.fields);
            self.kids(n, enc, Some(q));
            self.fields = saved;
            return;
        }
        let is_method = owner.is_some() && enc.is_none();
        let is_test = self.test_file && (nm.starts_with("test") ) && (owner.is_none() || owner.as_deref().map_or(false, |o| o.starts_with("Test")));
        let kind = if is_test { "test" } else if is_method { "method" } else { "function" };
        let own = if enc.is_some() { None } else { owner.as_deref() };
        let idx = self.push(kind, nm.clone(), own, n, !nm.starts_with('_'));
        for (d, topic, (ds, de)) in decs {
            let low = d.to_ascii_lowercase();
            if low.contains("transaction") || low.contains("atomic") { self.out.txs.push(RawTx { caller: Some(idx), start: *ds, end: *de }); }
            if let Some(t) = topic { if low.ends_with(".subscribe") || low.ends_with(".consumer") || low.ends_with(".listener") || low.ends_with(".on") { self.out.channels.push(RawChannel { caller: Some(idx), role: "subscribe", topic: t.clone(), handler: None, start: *ds, end: *de }); } }
        }
        let saved = std::mem::take(&mut self.locals);
        if let Some(ps) = n.child_by_field_name("parameters") {
            let mut c = ps.walk();
            for p in ps.named_children(&mut c) {
                if p.kind() == "typed_parameter" || p.kind() == "typed_default_parameter" {
                    let nm = p.named_child(0).map(|x| self.text(x));
                    let ty = p.child_by_field_name("type").map(|t| simple_type(&self.text(t)));
                    if let (Some(nm), Some(ty)) = (nm, ty) { self.locals.insert(nm, ty); }
                }
            }
        }
        // Inner definitions are walked inside this function, so what they call is attributed to them, not to the file.
        let inner_owner = owner.clone();
        if let Some(b) = n.child_by_field_name("body") { let mut c = b.walk(); for ch in b.named_children(&mut c) { self.visit(ch, Some(idx), inner_owner.clone()); } }
        self.locals = saved;
    }
}
