//! Spring Boot / Spring Cloud Gateway framework metadata extractor.
//!
//! This plugin observes the language-level `RawFile` produced by the Java walker
//! and turns Spring annotations / DSL patterns into structured framework metadata.
//! Cross-file resolution and graph construction are left to `index.rs`.
use crate::frameworks::{FrameworkContext, FrameworkEntityKind, FrameworkExtension, RawFrameworkMetadata};
use crate::language::RawFile;
use serde_json::json;
use tree_sitter::{Node, Tree};

pub struct SpringExtension;

impl FrameworkExtension for SpringExtension {
    fn framework(&self) -> &'static str { "spring" }

    fn matches(&self, rel: &str) -> bool { rel.ends_with(".java") }

    fn extract(&self, ctx: FrameworkContext, raw: &mut RawFile) {
        let Some(tree) = parse(ctx.src) else { return };
        let mut w = SpringWalker {
            src: ctx.src.as_bytes(),
            rel: ctx.rel,
            raw,
            class_stack: Vec::new(),
        };
        w.visit(tree.root_node());
    }
}

fn parse(src: &str) -> Option<Tree> {
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_java::LANGUAGE.into()).ok()?;
    parser.parse(src, None)
}

struct SpringWalker<'a> {
    src: &'a [u8],
    rel: &'a str,
    raw: &'a mut RawFile,
    class_stack: Vec<ClassFrame>,
}

#[derive(Debug, Clone)]
struct ClassFrame {
    name: String,
    has_tx: bool,
    symbol_index: Option<usize>,
}

#[derive(Debug, Clone, Default)]
struct Annotation {
    name: String,
    args: Vec<(String, serde_json::Value)>,
    start: usize,
    end: usize,
}

const SECURITY_ANNOTATIONS: &[&str] = &["PreAuthorize", "Secured", "RolesAllowed", "PostAuthorize"];

impl<'a> SpringWalker<'a> {
    fn text(&self, n: Node) -> String {
        n.utf8_text(self.src).unwrap_or("").to_string()
    }

    fn simple_name(&self, n: Node) -> String {
        self.text(n).split('<').next().unwrap_or("").split('[').next().unwrap_or("").rsplit('.').next().unwrap_or("").trim().to_string()
    }

    fn annotations(&self, n: Node) -> Vec<Annotation> {
        let mut out = Vec::new();
        let mut c = n.walk();
        for ch in n.named_children(&mut c) {
            if ch.kind() == "modifiers" {
                let mut mc = ch.walk();
                for a in ch.named_children(&mut mc) {
                    if matches!(a.kind(), "annotation" | "marker_annotation") {
                        out.push(self.annotation(a));
                    }
                }
            }
        }
        out
    }

    fn annotation(&self, a: Node) -> Annotation {
        let name = a.child_by_field_name("name").map(|n| self.simple_name(n)).unwrap_or_default();
        let mut args = Vec::new();
        if let Some(al) = a.child_by_field_name("arguments") {
            let mut ac = al.walk();
            for arg in al.named_children(&mut ac) {
                let (k, v) = match arg.kind() {
                    "string_literal" => ("value".into(), json!(self.string_literal(&arg))),
                    "assignment_expression" => {
                        let key = arg.child_by_field_name("left").map(|k| self.text(k)).unwrap_or_default();
                        let val = self.expr_value(arg.child_by_field_name("right"));
                        (key, val)
                    }
                    _ => ("value".into(), self.expr_value(Some(arg))),
                };
                args.push((k, v));
            }
        }
        Annotation { name, args, start: a.start_byte(), end: a.end_byte() }
    }

    fn string_literal(&self, n: &Node) -> String {
        self.text(*n).trim_matches(|c| c == '"' || c == '\'').to_string()
    }

    fn expr_value(&self, n: Option<Node>) -> serde_json::Value {
        let Some(n) = n else { return serde_json::Value::Null };
        match n.kind() {
            "string_literal" => json!(self.string_literal(&n)),
            "true" | "false" => json!(self.text(n) == "true"),
            "identifier" => json!(self.text(n)),
            _ => {
                // Try to collect a simple string array: {"a", "b"}
                let mut stack = vec![n];
                let mut strings = Vec::new();
                while let Some(x) = stack.pop() {
                    if x.kind() == "string_literal" {
                        strings.push(self.string_literal(&x));
                    }
                    let mut c = x.walk();
                    stack.extend(x.named_children(&mut c));
                }
                if !strings.is_empty() { json!(strings) } else { serde_json::Value::Null }
            }
        }
    }

    fn annotation_named<'b>(&self, anns: &'b [Annotation], name: &str) -> Option<&'b Annotation> {
        anns.iter().find(|a| a.name == name || a.name.ends_with(&format!(".{}", name)))
    }

    fn has_annotation(&self, anns: &[Annotation], name: &str) -> bool {
        self.annotation_named(anns, name).is_some()
    }

    fn is_stereotype(&self, anns: &[Annotation]) -> bool {
        ["Component", "Service", "Repository", "Controller", "RestController"].iter()
            .any(|n| self.has_annotation(anns, n))
    }

    fn symbol_index(&self, qualified: &str) -> Option<usize> {
        self.raw.symbols.iter().position(|s| s.qualified == qualified)
    }

    fn push_meta(&mut self, kind: FrameworkEntityKind, name: String, subject_symbol: Option<usize>, start: usize, end: usize, properties: serde_json::Value, parent: Option<String>) {
        self.raw.framework_metadata.push(RawFrameworkMetadata {
            framework: "spring",
            kind,
            name,
            subject_symbol,
            start,
            end,
            properties,
            parent,
        });
    }

    fn visit(&mut self, n: Node) {
        match n.kind() {
            "class_declaration" | "interface_declaration" | "enum_declaration" | "record_declaration" => {
                let Some(name_node) = n.child_by_field_name("name") else { return self.kids(n); };
                let nm = self.text(name_node);
                let anns = self.annotations(n);
                let tx = self.has_annotation(&anns, "Transactional");
                let idx = self.symbol_index(&nm);
                if self.has_annotation(&anns, "Controller") || self.has_annotation(&anns, "RestController") {
                    let prefix = route_prefix(&anns);
                    self.push_meta(FrameworkEntityKind::Controller, nm.clone(), idx, n.start_byte(), n.end_byte(), json!({"pathPrefix": prefix}), None);
                }
                if self.is_stereotype(&anns) {
                    self.push_meta(FrameworkEntityKind::Provider, nm.clone(), idx, n.start_byte(), n.end_byte(), json!({"stereotypes": stereotype_names(&anns)}), None);
                }
                self.class_stack.push(ClassFrame { name: nm.clone(), has_tx: tx, symbol_index: idx });
                self.kids(n);
                self.class_stack.pop();
                return;
            }
            "method_declaration" | "constructor_declaration" => {
                let anns = self.annotations(n);
                self.visit_executable(n, &anns);
                return;
            }
            _ => self.kids(n),
        }
    }

    fn visit_executable(&mut self, n: Node, anns: &[Annotation]) {
        let Some(name_node) = n.child_by_field_name("name") else { return; };
        let nm = self.text(name_node);
        let is_constructor = n.kind() == "constructor_declaration";
        let Some(class) = self.class_stack.last().cloned() else { return; };

        let symbol_q = if is_constructor { class.name.clone() } else { format!("{}.{}", class.name, nm) };
        let symbol_idx = self.symbol_index(&symbol_q).or(class.symbol_index);

        // Transaction boundaries
        let tx_from_class = class.has_tx;
        let tx_from_method = self.has_annotation(anns, "Transactional");
        if tx_from_class || tx_from_method {
            let span = self.annotation_named(anns, "Transactional").map(|a| (a.start, a.end)).unwrap_or((n.start_byte(), n.end_byte()));
            self.push_meta(FrameworkEntityKind::Transaction, format!("{}.{}", class.name, nm), symbol_idx, span.0, span.1, json!({
                "source": if tx_from_method { "method" } else { "class" },
                "constructor": is_constructor,
            }), Some(class.name.clone()));
        }

        // Security annotations on a method make it a guard (it can refuse the request).
        let is_guard = anns.iter().any(|a| SECURITY_ANNOTATIONS.contains(&a.name.as_str()));
        if is_guard {
            self.push_meta(FrameworkEntityKind::Guard, format!("{}.{}", class.name, nm), symbol_idx, n.start_byte(), n.end_byte(), json!({"annotation": anns.iter().find(|a| SECURITY_ANNOTATIONS.contains(&a.name.as_str())).map(|a| a.name.clone()).unwrap_or_default()}), Some(class.name.clone()));
        }

        // Routes from @*Mapping annotations
        if let Some((method, paths, params)) = mapping_info(anns) {
            let path = merge_paths(class_path_prefix(&self.raw.framework_metadata, &class.name), &paths);
            self.push_meta(FrameworkEntityKind::Route, format!("{} {}.{}", method, class.name, nm), symbol_idx, n.start_byte(), n.end_byte(), json!({
                "method": method,
                "paths": paths,
                "path": path,
                "params": params,
                "handler": format!("{}.{}", class.name, nm),
            }), Some(class.name.clone()));
        }

        // Injection points: constructor parameters, method parameters, fields
        self.visit_injection(n, &class, is_constructor, anns);

        // Message listeners already produce RawChannel in polyglot.rs; we mirror them here as framework metadata
        for ann in anns {
            if ["KafkaListener", "RabbitListener", "JmsListener", "SqsListener", "StreamListener", "EventListener"].contains(&ann.name.as_str()) {
                if let Some(topics) = ann.args.iter().find(|(k, _)| k == "topics" || k == "topic" || k == "value" || k == "queues").map(|(_, v)| v.clone()) {
                    self.push_meta(FrameworkEntityKind::MessageListener, format!("{}.{}", class.name, nm), symbol_idx, ann.start, ann.end, json!({
                        "topics": topics,
                        "annotation": ann.name,
                        "handler": format!("{}.{}", class.name, nm),
                    }), Some(class.name.clone()));
                }
            }
        }
    }

    fn visit_injection(&mut self, n: Node, class: &ClassFrame, is_constructor: bool, anns: &[Annotation]) {
        // Field injection
        if n.kind() == "field_declaration" {
            let field_anns = self.annotations(n);
            let autowired = self.has_annotation(&field_anns, "Autowired");
            if autowired {
                let ty = n.child_by_field_name("type").map(|x| self.simple_name(x));
                let mut c = n.walk();
                for child in n.named_children(&mut c) {
                    if child.kind() == "variable_declarator" {
                        let name = child.child_by_field_name("name").map(|x| self.text(x));
                        let qualifier = qualifier_value(&field_anns);
                        if let (Some(name), Some(t)) = (name, ty.clone()) {
                            self.push_meta(FrameworkEntityKind::Inject, format!("{}.{}", class.name, name), class.symbol_index, n.start_byte(), n.end_byte(), json!({
                                "target": name,
                                "type": t,
                                "qualifier": qualifier,
                                "kind": "field",
                            }), Some(class.name.clone()));
                        }
                    }
                }
            }
            return;
        }

        // Constructor / method parameter injection: only explicit @Autowired / @Inject is
        // modelled as an injection point. (Spring 4.2+ implicit constructor injection is a
        // future enhancement; without @Autowired we cannot reliably distinguish a bean ctor
        // from an ordinary value object.)
        let autowired = self.has_annotation(anns, "Autowired") || self.has_annotation(anns, "Inject");
        if !autowired { return; }
        let executable_name = n.child_by_field_name("name").map(|x| self.text(x)).unwrap_or_default();
        let Some(params) = n.child_by_field_name("parameters") else { return; };
        let mut pc = params.walk();
        for (i, p) in params.named_children(&mut pc).enumerate() {
            let ty = p.child_by_field_name("type").map(|x| self.simple_name(x));
            let name = p.child_by_field_name("name").map(|x| self.text(x));
            let param_anns = self.annotations(p);
            let qualifier = qualifier_value(&param_anns);
            let value_key = self.annotation_named(&param_anns, "Value").and_then(|a| a.args.iter().find(|(k, _)| k == "value").map(|(_, v)| v.clone()));
            if let (Some(name), Some(t)) = (name, ty) {
                let label = nm_or_index(&executable_name, i);
                self.push_meta(FrameworkEntityKind::Inject, format!("{}({}):{}", class.name, label, name), self.symbol_index(&format!("{}.{}", class.name, label)), p.start_byte(), p.end_byte(), json!({
                    "target": name,
                    "type": t,
                    "qualifier": qualifier,
                    "kind": if is_constructor { "constructor" } else { "method" },
                    "index": i,
                    "value": value_key,
                }), Some(class.name.clone()));
            }
        }
    }

    fn kids(&mut self, n: Node) {
        let mut c = n.walk();
        for ch in n.named_children(&mut c) { self.visit(ch); }
    }
}

fn nm_or_index(nm: &str, i: usize) -> String {
    if nm.is_empty() || nm == "<init>" { format!("arg{}", i) } else { nm.to_string() }
}

fn route_prefix(anns: &[Annotation]) -> Option<String> {
    anns.iter().find(|a| a.name == "RequestMapping")
        .and_then(|a| a.args.iter().find(|(k, _)| k == "value" || k == "path").map(|(_, v)| v.clone()))
        .map(|v| if v.is_string() { v.as_str().unwrap_or("").to_string() } else { "".to_string() })
}

fn class_path_prefix(metas: &[RawFrameworkMetadata], class: &str) -> Option<String> {
    metas.iter()
        .find(|m| m.kind == FrameworkEntityKind::Controller && m.name == class)
        .and_then(|m| m.properties.get("pathPrefix").and_then(|v| v.as_str().map(String::from)))
}

fn merge_paths(prefix: Option<String>, paths: &[String]) -> String {
    let prefix = prefix.unwrap_or_default();
    let p = prefix.trim_end_matches('/');
    if paths.is_empty() {
        return if p.is_empty() { "/".to_string() } else { p.to_string() };
    }
    paths.iter().map(|path| {
        let path = path.trim_start_matches('/');
        if p.is_empty() { format!("/{}", path) } else { format!("{}/{}", p, path) }
    }).next().unwrap_or_else(|| "/".to_string())
}

fn mapping_info(anns: &[Annotation]) -> Option<(String, Vec<String>, Vec<String>)> {
    let methods: &[(&str, &str)] = &[
        ("GetMapping", "GET"),
        ("PostMapping", "POST"),
        ("PutMapping", "PUT"),
        ("DeleteMapping", "DELETE"),
        ("PatchMapping", "PATCH"),
        ("RequestMapping", "REQUEST"),
    ];
    for (ann_name, http_method) in methods {
        if let Some(ann) = anns.iter().find(|a| a.name == *ann_name || a.name.ends_with(&format!(".{}", ann_name))) {
            let paths = ann.args.iter()
                .find(|(k, _)| k == "value" || k == "path")
                .map(|(_, v)| strings_or_singleton(v))
                .unwrap_or_else(|| vec!["/".to_string()]);
            let params = ann.args.iter()
                .find(|(k, _)| k == "params")
                .map(|(_, v)| strings_or_singleton(v))
                .unwrap_or_default();
            return Some((http_method.to_string(), paths, params));
        }
    }
    None
}

fn strings_or_singleton(v: &serde_json::Value) -> Vec<String> {
    match v {
        serde_json::Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        serde_json::Value::String(s) => vec![s.clone()],
        _ => Vec::new(),
    }
}

fn stereotype_names(anns: &[Annotation]) -> Vec<String> {
    anns.iter().filter(|a| ["Component", "Service", "Repository", "Controller", "RestController"].contains(&a.name.as_str()))
        .map(|a| a.name.clone()).collect()
}

fn qualifier_value(anns: &[Annotation]) -> Option<String> {
    anns.iter().find(|a| a.name == "Qualifier" || a.name.ends_with(".Qualifier"))
        .and_then(|a| a.args.iter().find(|(k, _)| k == "value").and_then(|(_, v)| v.as_str().map(String::from)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frameworks::FrameworkEntityKind;

    fn extract(src: &str) -> Vec<RawFrameworkMetadata> {
        use crate::polyglot::parse_java;
        let mut raw = parse_java(src, "src/Foo.java");
        let ext = SpringExtension;
        let ctx = FrameworkContext { rel: "src/Foo.java", src, project_root: std::path::Path::new(".") };
        ext.extract(ctx, &mut raw);
        raw.framework_metadata
    }

    #[test]
    fn extracts_controller_route_provider() {
        let src = r#"
@RestController
@RequestMapping("/users")
public class UserController {
    @GetMapping("/{id}")
    public User getUser(@PathVariable Long id) { return null; }
}
@Service
public class UserService {}
"#;
        let m = extract(src);
        assert!(m.iter().any(|x| x.kind == FrameworkEntityKind::Controller && x.name == "UserController"));
        let route = m.iter().find(|x| x.kind == FrameworkEntityKind::Route).unwrap();
        assert_eq!(route.properties["method"], "GET");
        assert_eq!(route.properties["path"], "/users/{id}");
        assert!(m.iter().any(|x| x.kind == FrameworkEntityKind::Provider && x.name == "UserService"));
    }

    #[test]
    fn extracts_constructor_injection() {
        let src = r#"
@Service
public class PaymentService {
    private final UserRepository users;
    @Autowired
    public PaymentService(UserRepository users) { this.users = users; }
}
"#;
        let m = extract(src);
        let inject = m.iter().find(|x| x.kind == FrameworkEntityKind::Inject && x.properties["kind"] == "constructor").unwrap();
        assert_eq!(inject.properties["target"], "users");
        assert_eq!(inject.properties["type"], "UserRepository");
    }

    #[test]
    fn does_not_treat_plain_constructors_as_injection() {
        let src = r#"
public class User {
    private final String name;
    public User(String name) { this.name = name; }
}
"#;
        let m = extract(src);
        assert!(!m.iter().any(|x| x.kind == FrameworkEntityKind::Inject));
    }

    #[test]
    fn fixture_payment_service_transaction() {
        let src = include_str!("../../../../fixtures/spring-repo/src/main/java/com/example/payments/service/PaymentService.java");
        let m = extract(src);
        let names: Vec<_> = m.iter().filter(|x| x.kind == FrameworkEntityKind::Transaction).map(|x| (x.name.clone(), x.properties.clone())).collect();
        assert!(names.iter().any(|(n, p)| n == "PaymentService.charge" && p["source"] == "method"), "tx names: {:?}", names);
    }

    #[test]
    fn extracts_method_level_transactional() {
        let src = r#"
@Service
public class PaymentService {
    @Transactional
    public void charge() {}
}
"#;
        let m = extract(src);
        let tx = m.iter().find(|x| x.kind == FrameworkEntityKind::Transaction && x.name == "PaymentService.charge").unwrap();
        assert_eq!(tx.properties["source"], "method");
    }

    #[test]
    fn extracts_transactional_constructor() {
        let src = r#"
@Service
public class PaymentService {
    @Transactional
    public PaymentService() {}
}
"#;
        let m = extract(src);
        let tx = m.iter().find(|x| x.kind == FrameworkEntityKind::Transaction).unwrap();
        assert_eq!(tx.properties["constructor"], true);
        assert_eq!(tx.properties["source"], "method");
    }

    #[test]
    fn inherits_class_level_transactional() {
        let src = r#"
@Transactional
@Service
public class PaymentService {
    public void charge() {}
}
"#;
        let m = extract(src);
        let tx = m.iter().find(|x| x.kind == FrameworkEntityKind::Transaction && x.name == "PaymentService.charge").unwrap();
        assert_eq!(tx.properties["source"], "class");
    }
}
