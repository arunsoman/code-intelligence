//! Renders stored semantic IR (`irDump`) as compact pseudocode for model consumption.
//!
//! The IR-first plan (dlta UC validation) says models should *read* structure, not raw JSON: this
//! printer walks the same IrSer JSON the PDG fold parses and emits a deterministic, indented
//! pseudocode — `call:`, `when:`/`loop:` guards, `$str` for blanked literals, `[?]` for computed
//! member access, locals by their stored names. Deterministic (pure walk of the dumped tree), and
//! strictly cheaper to trust than re-parsing source. One-shot: `worker irRender <entities.json>`
//! where the file holds `{maxLines?, entities:[{entityId, irDump}]}` and the reply is
//! `{"results":[{entityId, render|null}]}` — `irDump` absent/unparsable renders as null.
//!
//! Notation legend (printed as the first line of every render):
//!   - `v3`           a local the dump could not name (slot 3); names otherwise ride the dump
//!   - `$str $num`    literals with their VALUE blanked (privacy by construction)
//!   - `x.[?]`        computed/dynamic member access (the field is an expression, not a name)
//!   - `x += y`       a compound/incrementing write (the old value is read — self-fed)
//!   - `when: loop:`  guards and loops; nested functions are their own lines

use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_LINES: usize = 160;
const MAX_COLS: usize = 110;
const LEGEND: &str = "# IR pseudocode: $t = blanked literal, x.[?] = computed member, `when`/`loop` = guards, v2 = unnamed local";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrRenderEntity {
    pub entity_id: String,
    #[serde(default)]
    pub ir_dump: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrRenderRequest {
    #[serde(default)]
    pub max_lines: Option<u32>,
    pub entities: Vec<IrRenderEntity>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IrRenderResult {
    pub entity_id: String,
    pub render: Option<String>,
}

fn kind(n: &Value) -> Option<&str> {
    n.get("kind").and_then(Value::as_str)
}

fn tag(n: &Value) -> Option<&str> {
    n.get("tag").and_then(Value::as_str)
}

fn named<'a>(n: &'a Value, key: &str) -> Option<&'a Value> {
    n.get(key)
}

fn kids_of(n: &Value) -> Vec<&Value> {
    // Structural nodes hold their children under "children"; calls under "callee"/"args".
    let mut v: Vec<&Value> = match kind(n) {
        Some("call") => n.get("callee").into_iter().collect(),
        _ => Vec::new(),
    };
    if let Some(arr) = n.get("children").and_then(Value::as_array) {
        v.extend(arr.iter());
    }
    if kind(n) == Some("call") {
        if let Some(arr) = n.get("args").and_then(Value::as_array) {
            v.extend(arr.iter());
        }
    }
    v
}

/// Is this node statement-shaped (owns one or more lines) rather than an inline expression?
fn is_block(n: &Value) -> bool {
    matches!(kind(n), Some("fn" | "decl" | "loop" | "branch" | "ret" | "assign"))
}

/// Pure container tags: a statement wrapper whose only job is grouping renders transparently.
fn is_wrapper(t: &str) -> bool {
    matches!(t, "block" | "statement_block" | "expression_statement" | "block_statement")
}

/// Type/container tags whose only payload is type info or per-language wrapping: invisible to
/// pseudocode, which names bindings, not types.
fn is_typeish(n: &Value) -> bool {
    let t = tag(n).unwrap_or("");
    let k = kind(n).unwrap_or("");
    k.contains("type") || k == "modifiers" || t.contains("type") || t == "modifiers" || t == "index_signature"
}

/// Comment nodes carry no text in the dump (values are blanked) — nothing to render.
fn is_comment(n: &Value) -> bool {
    kind(n) == Some("unknown") && tag(n).is_some_and(|t| t.contains("comment"))
}

/// Argument/scope containers a call's arguments get wrapped in per language — unwrapped at call
/// sites so `f(x, y)` stays one line (`argument_list` in Java/TS, `parenthesized_expression`…).
fn is_arg_wrap(n: &Value) -> bool {
    kind(n) == Some("unknown")
        && matches!(tag(n), Some("argument_list" | "argument" | "args" | "parenthesized_expression"))
}

fn arg_kids_owned(n: &Value) -> Vec<Value> {
    if is_arg_wrap(n) {
        kids_of(n).into_iter().flat_map(arg_kids_owned).collect()
    } else {
        vec![n.clone()]
    }
}

fn is_parameter(n: &Value) -> bool {
    kind(n) == Some("unknown") && tag(n).is_some_and(|t| t.contains("parameter"))
}

/// `variable_declarator(x, init)` wrappers inside declarations: their kids stand in for theirs.
fn is_declarator(n: &Value) -> bool {
    kind(n) == Some("unknown") && matches!(tag(n), Some("variable_declarator" | "declarator"))
}

/// Declaration containers per language: they wrap declarators (and type payloads) that the `let`
/// rendering must see through (`local_variable_declaration`, `lexical_declaration`, …).
fn is_decl_container(n: &Value) -> bool {
    kind(n) == Some("unknown")
        && matches!(
            tag(n),
            Some(
                "local_variable_declaration"
                    | "lexical_declaration"
                    | "variable_declaration"
                    | "variable_declarator"
                    | "declarator"
                    | "field_declaration"
            )
        )
}

/// Flatten declarator/container wrappers, drop type payloads — including primitive types, which
/// lower to literals in some grammars (Java `long` → `Lit(num)`): a LEADING literal only rides as
/// a type when a declarator or name follows it.
fn decl_kids(n: &Value) -> Vec<Value> {
    let mut flat: Vec<Value> = kids_of(n)
        .into_iter()
        .filter(|c| !is_typeish(c) && !is_parameter(c))
        .flat_map(|c| {
            if is_declarator(c) || is_decl_container(c) {
                decl_kids(c)
            } else {
                vec![c.clone()]
            }
        })
        .collect();
    while flat.len() > 1
        && kind(&flat[0]) == Some("lit")
        && (is_declarator(&flat[1])
            || matches!(kind(&flat[1]), Some("ref" | "name"))
            || flat.iter().skip(1).any(|k| is_decl_container(k) || is_declarator(k)))
    {
        flat.remove(0);
    }
    flat
}

struct Out {
    lines: Vec<String>,
    max_lines: usize,
}

impl Out {
    fn push(&mut self, depth: usize, text: &str) -> bool {
        // False once the line budget is exhausted; the caller stops descending and marks it.
        if self.lines.len() >= self.max_lines {
            return false;
        }
        let owned = text.to_string();
        if owned.chars().count() > MAX_COLS {
            let cut: String = owned.chars().take(MAX_COLS).collect();
            self.lines.push(format!("{}{} …", "  ".repeat(depth), cut));
        } else {
            self.lines.push(format!("{}{}", "  ".repeat(depth), owned));
        }
        true
    }
}

/// Inline expression text (no indentation, no newlines).
fn inline(n: &Value, depth: usize) -> String {
    let k = kind(n).unwrap_or("unknown");
    match k {
        "name" => n.get("of").and_then(Value::as_str).unwrap_or("?").to_string(),
        "ref" => {
            if let Some(nm) = n.get("name").and_then(Value::as_str) {
                nm.to_string()
            } else {
                format!("v{}", n.get("slot").and_then(Value::as_u64).unwrap_or(0))
            }
        }
        "lit" => format!("$ {}", n.get("of").and_then(Value::as_str).unwrap_or("val")),
        "attr" => {
            let obj = named(n, "object").map(|o| inline(o, depth + 1)).unwrap_or_else(|| "?".into());
            match n.get("name").and_then(Value::as_str) {
                Some(f) if !f.is_empty() => format!("{obj}.{f}"),
                _ => format!("{obj}.[?]"), // computed/dynamic member: the field is an expression
            }
        }
        "call" => {
            let callee = named(n, "callee").map(|c| inline(c, depth + 1)).unwrap_or_else(|| "?".into());
            let args = n
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().flat_map(arg_kids_owned).map(|x| inline(&x, depth + 1)).collect::<Vec<_>>())
                .unwrap_or_default();
            format!("{callee}({})", args.join(", "))
        }
        "int-div" | "float-div" => bin(n, depth, " / "),
        "mod" => bin(n, depth, " % "),
        "and" => bin(n, depth, " && "),
        "or" => bin(n, depth, " || "),
        "not" => {
            let c = n.get("child").map(|x| inline(x, depth + 1)).unwrap_or_else(|| "?".into());
            format!("!{c}")
        }
        "unknown" => {
            let t = tag(n).unwrap_or("");
            if let Some(op) = t.strip_prefix("un:") {
                // Unary: prefix operator text (`!x`, `-x`, `++x`).
                return kids_of(n)
                    .into_iter()
                    .map(|x| inline(x, depth + 1))
                    .fold(op.to_string(), |acc, s| acc + &s);
            }
            let kids = kids_of(n);
            if let Some(op) = t.strip_prefix("op:") {
                if kids.len() == 2 {
                    return format!("{} {} {}", inline(kids[0], depth + 1), op, inline(kids[1], depth + 1));
                }
                return kids.into_iter().map(|x| inline(x, depth + 1)).fold(format!("{op} "), |acc, s| {
                    if acc.ends_with(' ') { acc + &s } else { format!("{acc} {s}") }
                });
            }
            // Bare grammar tag: `tag(k1, k2, …)` — honest about what was not classified.
            let label = short_expr_tag(t);
            let visible: Vec<&Value> = kids.iter().filter(|x| !is_typeish(x)).copied().collect();
            let args = visible.iter().map(|x| inline(x, depth + 1)).collect::<Vec<_>>().join(", ");
            if visible.is_empty() {
                format!("{label}()")
            } else if depth > 5 {
                format!("{label}(…)") // deep nesting: bound the width, not the truth
            } else {
                format!("{label}({args})")
            }
        }
        _ => {
            // Structural kind in an inline position: show a label instead of inlining.
            let args = kids_of(n).iter().map(|x| inline(x, depth + 1)).collect::<Vec<_>>().join(", ");
            format!("{k}({args})")
        }
    }
}

/// Inline unknown labels: keep them short (`method_invocation` → `method`).
fn short_expr_tag(t: &str) -> String {
    let stem = t.split('_').next().unwrap_or(t).trim_end_matches('_').to_string();
    if stem.is_empty() { t.to_string() } else { stem }
}

fn bin(n: &Value, depth: usize, glyph: &str) -> String {
    let mut ks = kids_of(n).into_iter();
    let a = ks.next().map(|x| inline(x, depth + 1)).unwrap_or_else(|| "?".into());
    let b = ks.next().map(|x| inline(x, depth + 1)).unwrap_or_else(|| "?".into());
    format!("{a}{glyph}{b}")
}

fn body(out: &mut Out, nodes: &[&Value], depth: usize) {
    for n in nodes {
        if !stmt(out, n, depth) {
            out.lines.push(format!("{}… (+{} more)", "  ".repeat(depth), nodes.len()));
            return;
        }
    }
}

/// One statement (or nested fn) as ≥1 line. Returns false when the line budget ran out.
fn stmt(out: &mut Out, n: &Value, depth: usize) -> bool {
    let k = kind(n).unwrap_or("unknown");
    match k {
        "fn" => {
            if !out.push(depth, "fn:") {
                return false;
            }
            let kids = kids_of(n).into_iter().filter(|c| !is_parameter(c)).collect::<Vec<_>>();
            body(out, &kids, depth + 1);
            true
        }
        "decl" => let_decl(out, decl_kids(n), depth),
        "assign" => {
            let kids = kids_of(n);
            let aug = n.get("aug").and_then(Value::as_bool) == Some(true);
            let lhs = inline(kids.first().copied().unwrap_or(n), depth + 1);
            let rhs = if kids.len() > 1 {
                kids[1..]
                    .iter()
                    .map(|x| inline(x, depth + 1))
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                "?".into()
            };
            let op = if aug { "+=" } else { "=" };
            out.push(depth, &format!("{lhs} {op} {rhs}"))
        }
        "loop" | "branch" => {
            let kids = kids_of(n).into_iter().filter(|c| !is_typeish(c) && !is_parameter(c)).collect::<Vec<_>>();
            let label = if k == "loop" { "loop" } else { "when" };
            match kids.as_slice() {
                [] => out.push(depth, &format!("{label}:")),
                [k0, k1, rest @ ..]
                    if k == "loop" && !is_block(k0) && !is_block(k1) =>
                {
                    // Enhanced-for / for-of shape: [var, iterable, body…] → `loop x of y:`.
                    let head = format!("{} of {}", inline(k0, depth + 1), inline(k1, depth + 1));
                    if out.push(depth, &format!("{label} {head}:")) {
                        body(out, rest, depth + 1);
                    }
                    true
                }
                [k0, rest @ ..] if !is_block(k0) => {
                    if out.push(depth, &format!("{label} {}:", inline(k0, depth + 1))) {
                        body(out, rest, depth + 1);
                    }
                    true
                }
                _ => {
                    // A statement-shaped first child (a for-init) heads the body instead.
                    if !out.push(depth, &format!("{label}:")) {
                        return false;
                    }
                    body(out, &kids, depth + 1);
                    true
                }
            }
        }
        "ret" => {
            let kids = kids_of(n);
            let text = if kids.is_empty() {
                "return".to_string()
            } else {
                format!("return {}", inline(kids[0], depth + 1))
            };
            out.push(depth, &text)
        }
        _ => {
            if is_parameter(n) || is_typeish(n) || is_comment(n) {
                return true; // parameters, types and bare comments are folded away, like the graph phase
            }
            if k == "unknown" {
                let t = tag(n).unwrap_or("");
                let kids = kids_of(n).into_iter().collect::<Vec<_>>();
                if is_wrapper(t) {
                    body(out, &kids, depth); // pure container: its innards in place
                    return true;
                }
                if is_decl_container(n) {
                    return let_decl(out, decl_kids(n), depth);
                }
                if t.starts_with("op:") || t.starts_with("un:") {
                    return out.push(depth, &inline(n, depth)); // bare operator statement
                }
                if kids.is_empty() {
                    return out.push(depth, &short_tag(t));
                }
                if !out.push(depth, &format!("{}:", short_tag(t))) {
                    return false;
                }
                body(out, &kids, depth + 1);
                return true;
            }
            out.push(depth, &inline(n, depth))
        }
    }
}

/// `let x = init` — the shared declaration renderer for `decl` nodes and their container wrappers.
fn let_decl(out: &mut Out, kids: Vec<Value>, depth: usize) -> bool {
    if kids.is_empty() {
        return out.push(depth, "let ?");
    }
    let head = format!("let {}", inline(&kids[0], depth + 1));
    let line = if kids.len() > 1 {
        format!("{head} = {}", kids[1..].iter().map(|x| inline(x, depth + 1)).collect::<Vec<_>>().join(", "))
    } else {
        head
    };
    if out.push(depth, &line) {
        for r in &kids[1..] {
            if is_block(r) {
                stmt(out, r, depth + 1);
            }
        }
    }
    true
}

/// Statement labels: the leading grammar section of an unknown tag (`catch_clause` → `catch`).
fn short_tag(t: &str) -> String {
    let stem = t.split('_').next().unwrap_or(t).trim_end_matches('_').to_string();
    if stem.is_empty() { t.to_string() } else { stem }
}

/// Render one stored IR dump. `Some(text)` with a legend header, or `None` when the dump is
/// absent/unparsable. Deterministic in the dumped tree: same dump, same text, always.
pub fn render(entity_id: &str, dump: Option<&str>, max_lines: usize) -> IrRenderResult {
    IrRenderResult {
        entity_id: entity_id.to_string(),
        render: (match dump.and_then(|d| serde_json::from_str::<Value>(d).ok()) {
            Some(root) => {
                let mut out = Out { lines: Vec::new(), max_lines };
                out.push(0, LEGEND);
                let kids = kids_of(&root).into_iter().filter(|c| !is_parameter(c)).collect::<Vec<_>>();
                body(&mut out, &kids, 0);
                if out.lines.len() >= out.max_lines {
                    out.lines.push("… (truncated at the line budget)".into());
                }
                Some(out.lines.join("\n"))
            }
            None => None,
        }),
    }
}

pub fn render_batch(req: &IrRenderRequest) -> Vec<IrRenderResult> {
    let max_lines = req.max_lines.map(|m| m as usize).unwrap_or(MAX_LINES).clamp(8, 2000);
    req.entities.iter().map(|e| render(&e.entity_id, e.ir_dump.as_deref(), max_lines)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render_text(dump: &str) -> String {
        render("e1", Some(dump), MAX_LINES).render.unwrap()
    }

    fn body_lines(dump: &str) -> Vec<String> {
        render_text(dump).lines().skip(1).map(String::from).collect()
    }

    #[test]
    fn renders_calls_guards_and_blank_literals() {
        // `if (reserve(total, 100) > limit) { gateway.authorize(total) }` with refs by name.
        let dump = r#"{"kind":"fn","children":[
            {"kind":"branch","children":[
                {"kind":"unknown","tag":"op:>","children":[
                    {"kind":"call","callee":{"kind":"name","of":"reserve"},"args":[
                        {"kind":"ref","slot":0,"name":"total"},{"kind":"lit","of":"num"}]},
                    {"kind":"ref","slot":1,"name":"limit"}]},
                {"kind":"call","callee":{"kind":"attr","name":"authorize","object":{"kind":"name","of":"gateway"}},"args":[{"kind":"ref","slot":0,"name":"total"}]}]}]}"#;
        assert_eq!(body_lines(dump), vec!["when reserve(total, $ num) > limit:", "  gateway.authorize(total)"]);
    }

    #[test]
    fn decls_assigns_and_compound_writes() {
        let dump = r#"{"kind":"fn","children":[
            {"kind":"decl","children":[{"kind":"ref","slot":0,"name":"total"},{"kind":"lit","of":"num"}]},
            {"kind":"assign","aug":true,"children":[
                {"kind":"ref","slot":0,"name":"total"},
                {"kind":"unknown","tag":"op:+","children":[{"kind":"ref","slot":0,"name":"total"},{"kind":"ref","slot":1,"name":"fee"}]}]},
            {"kind":"ret","children":[{"kind":"ref","slot":0,"name":"total"}]}]}"#;
        assert_eq!(body_lines(dump), vec!["let total = $ num", "total += total + fee", "return total"]);
    }

    #[test]
    fn wrappers_declarators_argument_lists_and_types_are_transparent() {
        // The Java-shaped dump: types, declarators and argument lists must not reach the text.
        let dump = r#"{"kind":"fn","children":[
            {"kind":"unknown","tag":"try_statement","children":[
                {"kind":"unknown","tag":"block","children":[
                    {"kind":"unknown","tag":"local_variable_declaration","children":[
                        {"kind":"unknown","tag":"generic_type","children":[
                            {"kind":"unknown","tag":"type_identifier","children":[]},
                            {"kind":"unknown","tag":"type_arguments","children":[{"kind":"unknown","tag":"type_identifier","children":[]}]}]},
                        {"kind":"unknown","tag":"variable_declarator","children":[
                            {"kind":"ref","slot":0,"name":"rates"},
                            {"kind":"call","callee":{"kind":"attr","name":"queryForList","object":{"kind":"name","of":"db"}},"args":[{"kind":"unknown","tag":"argument_list","children":[{"kind":"lit","of":"str"}]}]}]}]}]},
                {"kind":"unknown","tag":"catch","children":[{"kind":"unknown","tag":"block","children":[]}]}]}]}"#;
        assert_eq!(body_lines(dump), vec!["try:", "  let rates = db.queryForList($ str)", "  catch:"]);
    }

    #[test]
    fn computed_member_access_and_unnamed_locals() {
        let dump = r#"{"kind":"fn","children":[
            {"kind":"assign","children":[
                {"kind":"attr","object":{"kind":"name","of":"obj"},"name":""},
                {"kind":"ref","slot":3}]}]}"#;
        assert_eq!(body_lines(dump), vec!["obj.[?] = v3"]);
    }

    #[test]
    fn loops_read_variants_and_fold_parameters() {
        let params = r#"{"kind":"unknown","tag":"formal_parameter","children":[{"kind":"ref","slot":0,"name":"x"}]}"#;
        // `for x of items`: [var, iterable, body] → `loop x of items:`
        let each = format!(
            r#"{{"kind":"fn","children":[{params},{{"kind":"loop","children":[{{"kind":"ref","slot":0,"name":"x"}},{{"kind":"ref","slot":1,"name":"items"}},{{"kind":"unknown","tag":"block","children":[{{"kind":"call","callee":{{"kind":"name","of":"tick"}},"args":[]}}]}}]}}]}}"#
        );
        let lines = body_lines(&each);
        assert_eq!(lines, vec!["loop x of items:", "  tick()"]);
        // Counted `for (i = 0; i < n; i++)`: 3 head kids → semicolon-joined head.
        let counted = r#"{"kind":"fn","children":[
            {"kind":"loop","children":[
                {"kind":"assign","children":[{"kind":"ref","slot":0,"name":"i"},{"kind":"lit","of":"num"}]},
                {"kind":"unknown","tag":"op:<","children":[{"kind":"ref","slot":0,"name":"i"},{"kind":"ref","slot":1,"name":"n"}]},
                {"kind":"assign","aug":true,"children":[{"kind":"ref","slot":0,"name":"i"},{"kind":"lit","of":"num"}]},
                {"kind":"call","callee":{"kind":"name","of":"tick"},"args":[]}]}]}"#;
        let l2 = body_lines(counted);
        // A statement-shaped first child (the for-init) heads the body instead of the loop line.
        assert_eq!(l2, vec!["loop:", "  i = $ num", "  i < n", "  i += $ num", "  tick()"]);
    }

    #[test]
    fn the_line_budget_bounds_the_output() {
        let params = r#"{"kind":"unknown","tag":"formal_parameter","children":[{"kind":"ref","slot":0,"name":"x"}]}"#;
        let mut kids = format!("\"children\":[{params},");
        for i in 0..200 {
            kids.push_str(&format!(r#"{{"kind":"call","callee":{{"kind":"name","of":"tick{i}"}},"args":[]}},"#));
        }
        kids.pop(); // drop the trailing comma
        kids.push(']'); // close the children array
        let dump = format!(r#"{{"kind":"fn",{kids}}}"#);
        let r = render("e", Some(&dump), 20).render.unwrap();
        assert!(r.lines().all(|l| !l.contains("formal_parameter")), "parameters are folded away");
        assert!(r.contains("… (+"), "over-budget renders are marked");
        assert!(r.lines().count() <= 21 + 2, "the budget bounds the output");
    }

    #[test]
    fn missing_or_broken_dumps_render_null() {
        assert!(render("e", None, MAX_LINES).render.is_none());
        assert!(render("e", Some("{not json"), MAX_LINES).render.is_none());
    }
}