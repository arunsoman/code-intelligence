//! F06 / WP-05: code-health metrics from the head revision's AST, computed in the worker so the
//! host never parses source. Every signal is reported separately (never only one "health score"),
//! the decision tables are per language and versioned, and the same formula version is echoed back
//! with the result so stored reports can say exactly how they were measured.
//!
//! Function length is lines of the body span; cyclomatic complexity is 1 + decision points
//! (`if`/loop/`case`/`catch`/`&&`/`||`/`??`/ternary) with the node kinds listed per language below;
//! nesting depth is the deepest chain of blocks inside the function; parameters are counted
//! positionally (self/receiver excluded). Binary operators are matched by the node's operator text,
//! so `&&` inside a comment or string literal does not count. Closures are not measured separately
//! (version 1): their decision points are part of the enclosing function's count.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tree_sitter::{Node, Parser};

/// Versioned with the tables below; stored with every report.
pub const METRICS_VERSION: u32 = 1;

const MAX_FILES: usize = 400;
const MAX_FUNCTIONS_PER_FILE: usize = 200;
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct FnMetrics {
    pub name: String,
    pub start_line: usize,
    pub end_line: usize,
    pub complexity: usize,
    pub nesting: usize,
    pub params: usize,
}

struct Tables {
    /// function-like node kinds (measured individually)
    funcs: &'static [&'static str],
    /// decision node kinds counted once each
    decisions: &'static [&'static str],
    /// node kinds whose operator child text decides (`&&`, `||`, `??`…)
    binary: &'static [&'static str],
    operators: &'static [&'static str],
    /// block-ish node kinds that build nesting depth
    blocks: &'static [&'static str],
    /// kinds that carry exactly one parameter (listed as direct children of the parameter list)
    param_items: &'static [&'static str],
    declaration_kinds: &'static [&'static str],
}

const TS_DECLARATIONS: &[&str] = &["function_declaration", "method_definition", "class_declaration", "abstract_class_declaration", "variable_declarator", "type_declaration", "interface_declaration"];

const TS: Tables = Tables {
    funcs: &["function_declaration", "method_definition", "generator_function_declaration", "function_signature", "abstract_method_signature"],
    decisions: &["if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_case", "catch_clause", "ternary_expression"],
    binary: &["binary_expression"],
    operators: &["&&", "||", "??"],
    blocks: &["statement_block"],
    param_items: &["required_parameter", "optional_parameter"],
    declaration_kinds: TS_DECLARATIONS,
};

const RUST: Tables = Tables {
    funcs: &["function_item"],
    decisions: &["if_expression", "while_expression", "for_expression", "loop_expression", "match_arm", "try_expression"],
    binary: &["binary_expression"],
    operators: &["&&", "||"],
    blocks: &["block"],
    param_items: &["parameter", "self_parameter", "reference_pattern", "mut_pattern"],
    declaration_kinds: &["function_item", "impl_item", "struct_item", "enum_item", "trait_item", "type_item"],
};

const JAVA: Tables = Tables {
    funcs: &["method_declaration", "constructor_declaration"],
    decisions: &["if_statement", "for_statement", "enhanced_for_statement", "while_statement", "do_statement", "switch_block_statement_group", "catch_clause", "ternary_expression"],
    binary: &["binary_expression"],
    operators: &["&&", "||"],
    blocks: &["block"],
    param_items: &["formal_parameter", "spread_parameter"],
    declaration_kinds: &["method_declaration", "constructor_declaration", "class_declaration", "interface_declaration", "enum_declaration", "record_declaration"],
};

const GO: Tables = Tables {
    funcs: &["function_declaration", "method_declaration"],
    decisions: &["if_statement", "for_statement", "range_clause", "expression_case", "communication_case"],
    binary: &["binary_expression"],
    operators: &["&&", "||"],
    blocks: &["block"],
    param_items: &["parameter_declaration", "variadic_parameter_declaration"],
    declaration_kinds: &["function_declaration", "method_declaration", "type_declaration", "struct_type", "interface_type"],
};

const PYTHON: Tables = Tables {
    funcs: &["function_definition"],
    decisions: &["if_statement", "for_statement", "while_statement", "except_clause", "conditional_expression"],
    binary: &["binary_operator", "boolean_operator"],
    operators: &["and", "or"],
    blocks: &["block"],
    param_items: &["identifier", "typed_parameter", "default_parameter", "typed_default_parameter", "list_splat_pattern", "dictionary_splat_pattern"],
    declaration_kinds: &["function_definition", "class_definition", "decorated_definition"],
};

#[derive(Clone, Copy, PartialEq)]
enum Lang { Ts, Tsx, Rust, Java, Go, Python }

fn lang_name(lang: Lang) -> &'static str {
    match lang { Lang::Ts => "typescript", Lang::Tsx => "tsx", Lang::Rust => "rust", Lang::Java => "java", Lang::Go => "go", Lang::Python => "python" }
}

fn lang_for(rel: &str) -> Option<Lang> {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".ts") { return Some(Lang::Ts); }
    if lower.ends_with(".tsx") { return Some(Lang::Tsx); }
    if lower.ends_with(".js") || lower.ends_with(".cjs") || lower.ends_with(".mjs") { return Some(Lang::Ts); }
    if lower.ends_with(".jsx") { return Some(Lang::Tsx); }
    if lower.ends_with(".rs") || lower.ends_with(".nir") { return Some(Lang::Rust); }
    if lower.ends_with(".java") { return Some(Lang::Java); }
    if lower.ends_with(".go") { return Some(Lang::Go); }
    if lower.ends_with(".py") || lower.ends_with(".pyi") { return Some(Lang::Python); }
    None
}

fn tables(lang: Lang) -> &'static Tables {
    match lang {
        Lang::Ts | Lang::Tsx => &TS,
        Lang::Rust => &RUST,
        Lang::Java => &JAVA,
        Lang::Go => &GO,
        Lang::Python => &PYTHON,
    }
}

fn parser_for(lang: Lang) -> Parser {
    let mut p = Parser::new();
    let l = match lang {
        Lang::Ts => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
        Lang::Java => tree_sitter_java::LANGUAGE.into(),
        Lang::Go => tree_sitter_go::LANGUAGE.into(),
        Lang::Python => tree_sitter_python::LANGUAGE.into(),
    };
    p.set_language(&l).expect("load grammar");
    p
}

fn text<'a>(node: Node<'a>, src: &'a [u8]) -> &'a str { node.utf8_text(src).unwrap_or("") }

fn collect_functions<'a>(node: Node<'a>, t: &'static Tables, out: &mut Vec<(Node<'a>, bool)>, depth: usize) {
    if depth > 400 || out.len() >= MAX_FUNCTIONS_PER_FILE * 2 { return; }
    let expr_form = node.kind() == "arrow_function";
    if t.funcs.contains(&node.kind()) || expr_form {
        out.push((node, expr_form));
    }
    let mut w = node.walk();
    for ch in node.children(&mut w) {
        collect_functions(ch, t, out, depth + 1);
    }
}

/// Name of the function node. Expression forms (`const f = () => …`, `handle: function(){…}`)
/// take the name from the declarator above them; a lone anonymous one stays `<anonymous>`.
fn fn_name<'a>(node: Node<'a>, src: &'a [u8], lang: Lang) -> String {
    let mut cur = node;
    for _ in 0..4 {
        let named = {
            let mut w = cur.walk();
            let found = cur.children(&mut w).find(|c| {
                matches!(c.kind(), "identifier" | "property_identifier" | "field_identifier" | "shorthand_property_identifier")
            });
            found.map(|c| text(c, src).to_string())
        };
        if let Some(n) = named { return n; }
        let Some(parent) = cur.parent() else { break };
        match parent.kind() {
            // `const f = () => …`, `f = function(){…}`, `x: function(){…}`
            "variable_declarator" | "assignment_expression" | "pair" | "property" | "assignment" => {
                let Some(sibling) = named_sibling_of(parent, cur) else { break };
                return sibling;
            }
            "call_expression" | "call" if lang == Lang::Python => { cur = parent; }
            _ => break,
        }
        cur = parent;
    }
    match node.kind() {
        "method_declaration" | "function_item" | "method_definition" | "function_definition" => {
            let mut w = node.walk();
            let found = node.children(&mut w).find(|c| matches!(c.kind(), "identifier" | "property_identifier" | "field_identifier"));
            found.map(|c| text(c, src).to_string()).unwrap_or_else(|| "<anonymous>".into())
        }
        _ => "<anonymous>".to_string(),
    }
}

fn named_sibling_of(parent: Node, child: Node) -> Option<String> {
    let mut w = parent.walk();
    for c in parent.children(&mut w) {
        if c.id() == child.id() { break; }
        if matches!(c.kind(), "identifier" | "property_identifier") { return Some(c.utf8_text(&[]).unwrap_or("").to_string()); }
    }
    None
}

fn binary_operator_text(n: Node, src: &[u8]) -> String {
    let mut w = n.walk();
    for c in n.children(&mut w) {
        if c.child_count() > 0 { continue; }
        let t = text(c, src);
        if ["&&", "||", "??", "and", "or"].iter().any(|o| t.eq_ignore_ascii_case(o)) { return t.to_ascii_lowercase(); }
    }
    String::new()
}
/// The function's own parameter list: a direct child of a list kind, or (single-paren-less arrows,
/// TS) one direct identifier child. Rust/Python drops a leading self; methods' `self` is not a smell.
fn param_count(fn_node: Node, src: &[u8], lang: Lang, t: &'static Tables) -> usize {
    let list_kinds: &[&str] = match lang {
        Lang::Ts | Lang::Tsx => &["formal_parameters"],
        Lang::Rust => &["parameters"],
        Lang::Java => &["formal_parameters"],
        Lang::Go => &["parameter_list"],
        Lang::Python => &["parameters"],
    };
    let mut w = fn_node.walk();
    let items: Vec<Node> = fn_node.children(&mut w)
        .find(|c| list_kinds.contains(&c.kind()))
        .map(|list| {
            let mut lw = list.walk();
            list.children(&mut lw).filter(|c| t.param_items.contains(&c.kind())).collect()
        })
        .unwrap_or_else(|| {
            if lang == Lang::Ts || lang == Lang::Tsx {
                let mut fw = fn_node.walk();
                fn_node.children(&mut fw).filter(|c| c.kind() == "identifier").take(1).collect()
            } else { vec![] }
        });
    let mut n = items.len();
    if lang == Lang::Python && !items.is_empty() {
        let first = text(items[0], src);
        if first == "self" || first == "cls" { n = n.saturating_sub(1); }
    }
    n
}

fn measure(fn_node: Node, src: &[u8], lang: Lang, t: &'static Tables) -> FnMetrics {
    let mut complexity = 1usize;
    // Nesting counts blocks strictly inside the function body: a straight-line body is 0,
    // one `if` wrapping its body is 1, and so on.
    let mut nesting = 0usize;
    // The function body's own block sits at nesting depth 0: the seed −1 is the function node itself.
    let mut stack: Vec<(Node, i32)> = vec![(fn_node, -1i32)];
    while let Some((n, depth)) = stack.pop() {
        let k = n.kind();
        if n.id() != fn_node.id() && (t.funcs.contains(&k) || k == "arrow_function") {
            continue; // a nested function is measured separately; its decisions are its own
        }
        if t.decisions.contains(&k) {
            complexity += 1;
        }
        if t.binary.contains(&k) {
            let op = binary_operator_text(n, src);
            if t.operators.iter().any(|o| op.eq_ignore_ascii_case(o)) { complexity += 1; }
        }
        if depth > 0 && t.blocks.contains(&k) {
            nesting = nesting.max(depth as usize);
        }
        let mut w = n.walk();
        for ch in n.children(&mut w) {
            stack.push((ch, depth + i32::from(t.blocks.contains(&ch.kind()))));
        }
    }
    let start = fn_node.start_position().row + 1;
    let end = fn_node.end_position().row + 1;
    FnMetrics {
        name: fn_name(fn_node, src, lang),
        start_line: start,
        end_line: end,
        complexity,
        nesting: nesting.max(1),
        params: param_count(fn_node, src, lang, t),
    }
}

fn count_symbols(node: Node, t: &'static Tables, out: &mut usize) {
    if t.declaration_kinds.contains(&node.kind()) {
        *out += 1;
    }
    let mut w = node.walk();
    for c in node.children(&mut w) {
        count_symbols(c, t, out);
    }
}

struct FileResult { lines: usize, symbols: usize, had_errors: bool, functions: Vec<FnMetrics> }

fn collect(src: &str, lang: Lang) -> FileResult {
    let t = tables(lang);
    let bytes = src.as_bytes();
    let mut parser = parser_for(lang);
    let Some(tree) = parser.parse(bytes, None) else { return FileResult { lines: 0, symbols: 0, had_errors: true, functions: vec![] } };
    let root = tree.root_node();
    let mut symbols = 0usize;
    count_symbols(root, t, &mut symbols);
    let mut found: Vec<(Node, bool)> = Vec::new();
    collect_functions(root, t, &mut found, 0);
    let mut functions: Vec<FnMetrics> = found.into_iter().map(|(n, _)| measure(n, bytes, lang, t)).collect();
    functions.truncate(MAX_FUNCTIONS_PER_FILE);
    functions.reverse(); // source order: the walk above is depth-first but pop-order reversed; stable sort below restores reading order
    functions.sort_by_key(|m| m.start_line);
    // A file ending in `\n` has lines = countOf('\n'); an unterminated last line counts too.
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count();
    let lines = if bytes.is_empty() { 0 } else if *bytes.last().unwrap() == b'\n' { newlines } else { newlines + 1 };
    FileResult { lines, symbols, had_errors: root.has_error(), functions }
}

fn file_metrics(root: &Path, rel: &str) -> Value {
    let abs: PathBuf = root.join(rel);
    let bytes = match std::fs::read(&abs) {
        Ok(b) => b,
        Err(e) => { return json!({ "path": rel, "error": format!("unreadable: {e}") }); }
    };
    if bytes.len() > MAX_FILE_BYTES { return json!({ "path": rel, "error": "too-large" }); }
    let Some(lang) = lang_for(rel) else { return json!({ "path": rel, "language": "UNSUPPORTED" }) };
    let src = String::from_utf8_lossy(&bytes);
    let c = collect(&src, lang);
    let functions: Vec<Value> = c.functions.iter().map(|m| json!({
        "name": m.name,
        "startLine": m.start_line,
        "endLine": m.end_line,
        "length": m.end_line - m.start_line + 1,
        "complexity": m.complexity,
        "nesting": m.nesting,
        "params": m.params,
    })).collect();
    json!({
        "path": rel,
        "language": lang_name(lang),
        "lines": c.lines,
        "symbols": c.symbols,
        "hadErrors": c.had_errors,
        "functions": functions,
        "metricsVersion": METRICS_VERSION,
    })
}

/// Verify a metrics call: parse each requested file at `root`, bounded (§13).
pub fn metrics_verify(root: &Path, params: &Value) -> Result<Value, (&'static str, String)> {
    let files: Vec<String> = params.get("files")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .ok_or(("INVALID_SCHEMA", "params.files must be an array of paths".to_string()))?;
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(("RESOURCE_LIMIT", format!("metrics accepts 1..{MAX_FILES} files per call (got {})", files.len())));
    }
    for f in &files {
        if f.contains("..") { return Err(("INVALID_SCHEMA", "paths must stay inside the repository root".to_string())); }
    }
    let per_file: Vec<Value> = files.iter().map(|f| file_metrics(root, f)).collect();
    Ok(json!({ "files": per_file, "metricsVersion": METRICS_VERSION }))
}

#[cfg(test)]
mod tests {
    // These tests pin the per-language decision tables: they fail (with the concrete tree dumped)
    // when a grammar's node kinds change, which is the documented versioning of the tables.
    use super::*;
    use tree_sitter::Parser;

    fn dump(src: &str, rel: &str) -> String {
        let lang = lang_for(rel).unwrap();
        let mut p = parser_for(lang);
        let tree = p.parse(src.as_bytes(), None).unwrap();
        let mut out = String::new();
        walk(tree.root_node(), 0, &mut out);
        out
    }
    fn walk<'a>(n: Node<'a>, d: usize, out: &mut String) {
        out.push_str(&" ".repeat(d * 2));
        out.push_str(n.kind());
        out.push('\n');
        let mut w = n.walk();
        for c in n.children(&mut w) { walk(c, d + 1, out); }
    }

    #[test]
    fn ts_tables_see_the_common_decision_kinds() {
        let src = "function f(a, b) {\n  if (a && b) { return 1; }\n  for (const x of a) { switch (x) { case 1: y(); } }\n  try { x(); } catch (e) { g(); }\n  return a ?? b ? f() : 0;\n}\nconst g = (x) => x;\nclass C { m(n) { const h = () => n > 0 && f(); h(); } }";
        let d = dump(src, "a.ts");
        for k in ["if_statement", "for_in_statement", "switch_case", "catch_clause", "binary_expression", "ternary_expression", "function_declaration", "method_definition", "arrow_function", "formal_parameters", "statement_block"] {
            assert!(d.contains(k), "missing {k} in TS tree\n{d}");
        }
    }

    #[test]
    fn rust_tables_see_the_common_decision_kinds() {
        let src = "fn f(a: i32) {\n  if a > 0 && a < 9 { return a?; }\n  for i in 0..a { match i { 0 => g(), _ => {} } }\n  while a > 0 { a -= 1; }\n}\nfn g() {}";
        let d = dump(src, "a.rs");
        for k in ["if_expression", "for_expression", "match_arm", "while_expression", "try_expression", "binary_expression", "function_item", "parameters", "block"] {
            assert!(d.contains(k), "missing {k} in Rust tree\n{d}");
        }
    }

    #[test]
    fn java_tables_see_the_common_decision_kinds() {
        let src = "class C {\n  int f(int a, boolean b) {\n    if (a > 0 && b) { return 1; }\n    for (int i = 0; i < a; i++) { while (a > 0) { a--; } }\n    try { g(); } catch (Exception e) { h(); }\n    return a > 0 ? a : 0;\n  }\n}";
        let d = dump(src, "C.java");
        for k in ["if_statement", "for_statement", "while_statement", "catch_clause", "ternary_expression", "binary_expression", "method_declaration", "formal_parameters", "block"] {
            assert!(d.contains(k), "missing {k} in Java tree\n{d}");
        }
    }

    #[test]
    fn go_tables_see_the_common_decision_kinds() {
        let src = "package m\n\nfunc F(a int) int {\n\tif a > 0 && a < 9 {\n\t\tfor i := range a {\n\t\t\tswitch i { case 1: g() }\n\t\t}\n\t\tselect { case <-ch: g(); default: }\n\t}\n\treturn a\n}\nfunc g() {\n\tch := make(chan int)\n\t_ = ch\n}";
        let d = dump(src, "a.go");
        for k in ["if_statement", "for_statement", "range_clause", "expression_case", "communication_case", "binary_expression", "function_declaration", "parameter_list", "block"] {
            assert!(d.contains(k), "missing {k} in Go tree\n{d}");
        }
    }

    #[test]
    fn python_tables_see_the_common_decision_kinds() {
        let src = "def f(a, b):\n    if a > 0 and b:\n        for i in a:\n            try: g()\n            except: pass\n    return a if a > 1 else b\ndef g(): pass";
        let d = dump(src, "a.py");
        for k in ["if_statement", "for_statement", "except_clause", "conditional_expression", "boolean_operator", "function_definition", "parameters", "block"] {
            assert!(d.contains(k), "missing {k} in Python tree\n{d}");
        }
    }

    #[test]
    fn metrics_of_a_sample_file() {
        let dir = std::env::temp_dir().join(format!("cie-metrics-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let src = "function f(a, b) {\n  if (a && b) {\n    while (a) { a -= 1; }\n  }\n  return b ? a : 0;\n}\nfunction g() { return 1; }\n";
        std::fs::write(dir.join("src/a.ts"), src).unwrap();
        let v = metrics_verify(&dir, &json!({ "files": ["src/a.ts"] })).unwrap();
        assert_eq!(v["metricsVersion"], METRICS_VERSION);
        let f = &v["files"][0];
        assert_eq!(f["lines"], u64::try_from(src.lines().count()).unwrap());
        let functions = f["functions"].as_array().unwrap();
        assert_eq!(functions.len(), 2, "functions: {functions:?}");
        let fm = &functions[0];
        assert_eq!(fm["name"], "f", "{functions:?}");
        // 1 + if + && + while(1) + ternary = 5; nesting = blocks strictly inside the body (2)
        assert_eq!(fm["complexity"], 5, "{functions:?}");
        assert_eq!(fm["nesting"], 2, "{functions:?}");
        assert_eq!(fm["params"], 2, "{functions:?}");
        assert_eq!(functions[1]["complexity"], 1, "{functions:?}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn bounded_and_rejecting() {
        let dir = std::env::temp_dir().join(format!("cie-metrics2-{}", std::process::id()));
        let err = metrics_verify(&dir, &json!({ "files": ["../outside.ts"] })).unwrap_err();
        assert_eq!(err.0, "INVALID_SCHEMA");
        let many = (0..MAX_FILES + 1).map(|i| format!("f{i}.ts")).collect::<Vec<_>>();
        let err2 = metrics_verify(&dir, &json!({ "files": many })).unwrap_err();
        assert_eq!(err2.0, "RESOURCE_LIMIT");
    }
}