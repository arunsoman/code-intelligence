//! Next.js framework metadata extractor.
//!
//! Detects:
//!   - App Router file-system routes: `app/**/page.tsx`, `app/**/route.ts`, `app/**/layout.tsx`
//!   - Pages Router file-system routes: `pages/**/index.tsx`, `pages/**/*.tsx`, `pages/api/**/*.ts`
//!   - Server actions exported from `actions.ts` or `actions/*.ts`
//!   - Route handlers with named HTTP exports (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`)
//!
//! Cross-file resolution is left to `index.rs`.
use crate::frameworks::{FrameworkContext, FrameworkEntityKind, FrameworkExtension, RawFrameworkMetadata};
use crate::language::RawFile;
use serde_json::json;
use std::path::{Component, Path};
use tree_sitter::{Node, Tree};

pub struct NextJsExtension;

const HTTP_EXPORTS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

impl FrameworkExtension for NextJsExtension {
    fn framework(&self) -> &'static str { "nextjs" }

    fn matches(&self, rel: &str) -> bool {
        rel.ends_with(".ts") || rel.ends_with(".tsx") || rel.ends_with(".js") || rel.ends_with(".jsx") || rel.ends_with(".mjs")
    }

    fn extract(&self, ctx: FrameworkContext, raw: &mut RawFile) {
        let app_route = infer_next_route(ctx.rel, "app/");
        let pages_route = infer_next_route(ctx.rel, "pages/");
        let route_path = app_route.clone().or(pages_route.clone());

        if let Some(path) = &route_path {
            let method = http_method_for_file(ctx.rel);
            let kind = route_kind(ctx.rel);
            let name = format!("{} {}", method, path);
            // Use the file length as the generic route span so it does not collide with
            // exported HTTP-method handlers (GET/POST/...) that have real byte spans.
            let start = ctx.src.len();
            let end = ctx.src.len();
            raw.framework_metadata.push(RawFrameworkMetadata {
                framework: "nextjs",
                kind: FrameworkEntityKind::Route,
                name: name.clone(),
                subject_symbol: None,
                start,
                end,
                properties: json!({
                    "method": method,
                    "path": path,
                    "router": if app_route.is_some() { "app" } else { "pages" },
                    "kind": kind,
                    "file": ctx.rel,
                }),
                parent: None,
            });

            // For API route handlers, also emit a row per exported HTTP method if we can find it.
            if kind == "api_route" {
                if let Some(tree) = parse_ts(ctx.src) {
                    for (m, span) in exported_http_methods(tree.root_node(), ctx.src) {
                        raw.framework_metadata.push(RawFrameworkMetadata {
                            framework: "nextjs",
                            kind: FrameworkEntityKind::Route,
                            name: format!("{} {}", m, path),
                            subject_symbol: None,
                            start: span.0,
                            end: span.1,
                            properties: json!({"method": m, "path": path, "router": "pages", "kind": "api_handler"}),
                            parent: Some(name.clone()),
                        });
                    }
                }
            }
        }

        // Server actions: any exported async function in a file named actions.ts or under actions/.
        if is_actions_file(ctx.rel) {
            if let Some(tree) = parse_ts(ctx.src) {
                for (name, span) in exported_async_functions(tree.root_node(), ctx.src) {
                    raw.framework_metadata.push(RawFrameworkMetadata {
                        framework: "nextjs",
                        kind: FrameworkEntityKind::Route,
                        name: format!("ACTION {}", name),
                        subject_symbol: None,
                        start: span.0,
                        end: span.1,
                        properties: json!({"method": "ACTION", "path": name, "kind": "server_action"}),
                        parent: None,
                    });
                }
            }
        }
    }
}

fn parse_ts(src: &str) -> Option<Tree> {
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()).ok()?;
    parser.parse(src, None)
}

fn infer_next_route(rel: &str, prefix: &str) -> Option<String> {
    if !rel.starts_with(prefix) { return None; }
    let p = Path::new(&rel[prefix.len()..]);
    let mut segs: Vec<String> = Vec::new();
    for c in p.components() {
        if let Component::Normal(os) = c {
            let s = os.to_string_lossy().to_string();
            if s == "page.tsx" || s == "page.ts" || s == "page.jsx" || s == "page.js" ||
               s == "route.ts" || s == "route.js" ||
               s == "index.tsx" || s == "index.ts" || s == "index.jsx" || s == "index.js" ||
               s == "layout.tsx" || s == "layout.ts" || s == "layout.jsx" || s == "layout.js" {
                continue;
            }
            let stem = s.rsplit_once('.').map(|(a, _)| a).unwrap_or(&s);
            if stem == "index" { continue; }
            let seg = normalize_segment(stem);
            segs.push(seg);
        }
    }
    Some(if segs.is_empty() { "/".to_string() } else { format!("/{}", segs.join("/")) })
}

fn normalize_segment(s: &str) -> String {
    if s.starts_with("[[...") && s.ends_with("]]") {
        format!("...{}", &s[4..s.len()-2])
    } else if s.starts_with("[...") && s.ends_with(']') {
        format!("...{}", &s[4..s.len()-1])
    } else if s.starts_with('[') && s.ends_with(']') {
        format!(":{}", &s[1..s.len()-1])
    } else {
        s.to_string()
    }
}

fn route_kind(rel: &str) -> &'static str {
    if rel.contains("/api/") || rel.starts_with("pages/api/") { "api_route" }
    else if rel.contains("/app/") { "page" }
    else { "page" }
}

fn http_method_for_file(rel: &str) -> String {
    if rel.contains("/api/") || rel.starts_with("pages/api/") {
        "API".to_string()
    } else {
        "GET".to_string()
    }
}

fn is_actions_file(rel: &str) -> bool {
    let file = Path::new(rel).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    file == "actions.ts" || file == "actions.js" || rel.contains("/actions/")
}

fn exported_http_methods(root: Node, src: &str) -> Vec<(String, (usize, usize))> {
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        if n.kind() == "export_statement" || n.kind() == "export_named_declaration" {
            let name = if let Some(name_node) = n.child_by_field_name("name") {
                Some(text(name_node, src.as_bytes()))
            } else {
                find_export_name(n, src)
            };
            if let Some(name) = name {
                if HTTP_EXPORTS.contains(&name.as_str()) {
                    out.push((name, (n.start_byte(), n.end_byte())));
                }
            }
        }
        let mut c = n.walk();
        for ch in n.named_children(&mut c) { stack.push(ch); }
    }
    out
}

fn exported_async_functions(root: Node, src: &str) -> Vec<(String, (usize, usize))> {
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        let is_exported = n.kind() == "export_statement" || n.kind() == "export_named_declaration";
        match n.kind() {
            "function_declaration" | "export_statement" | "export_named_declaration" => {
                if let Some(decl) = n.child_by_field_name("declaration") {
                    if decl.kind() == "function_declaration" {
                        if is_async_function(decl, src) {
                            if let Some(name) = decl.child_by_field_name("name").map(|x| text(x, src.as_bytes())) {
                                out.push((name, (decl.start_byte(), decl.end_byte())));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        let mut c = n.walk();
        for ch in n.named_children(&mut c) { stack.push(ch); }
    }
    out
}

fn is_async_function(n: Node, src: &str) -> bool {
    let head: String = n.utf8_text(src.as_bytes()).unwrap_or("").chars().take(20).collect();
    head.contains("async ")
}

fn find_export_name(n: Node, src: &str) -> Option<String> {
    let text = |n: Node| n.utf8_text(src.as_bytes()).unwrap_or("").to_string();
    if let Some(name) = n.child_by_field_name("name") {
        return Some(text(name));
    }
    if let Some(decl) = n.child_by_field_name("declaration") {
        return decl.child_by_field_name("name").map(text);
    }
    let mut c = n.walk();
    for ch in n.named_children(&mut c) {
        if ch.kind() == "identifier" {
            return Some(text(ch));
        }
        if ch.kind() == "function_declaration" || ch.kind() == "variable_declarator" {
            return ch.child_by_field_name("name").map(text);
        }
    }
    None
}

fn text(n: Node, src: &[u8]) -> String {
    n.utf8_text(src).unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract(rel: &str, src: &str) -> Vec<RawFrameworkMetadata> {
        let mut raw = crate::language::RawFile::default();
        let ext = NextJsExtension;
        let ctx = FrameworkContext { rel, src, project_root: std::path::Path::new(".") };
        ext.extract(ctx, &mut raw);
        raw.framework_metadata
    }

    #[test]
    fn infers_app_router_routes() {
        let m = extract("app/users/[id]/page.tsx", "export default function Page() { return null; }");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].properties["path"], "/users/:id");
        assert_eq!(m[0].properties["method"], "GET");
    }

    #[test]
    fn infers_api_routes_with_http_exports() {
        let src = r#"
export async function GET(request: Request) { return Response.json({}); }
export async function POST(request: Request) { return Response.json({}); }
"#;
        let m = extract("app/api/users/route.ts", src);
        let paths: Vec<&str> = m.iter().filter(|x| x.kind == FrameworkEntityKind::Route).map(|x| x.properties["method"].as_str().unwrap()).collect();
        assert!(paths.contains(&"GET"));
        assert!(paths.contains(&"POST"));
        assert!(paths.contains(&"API"));
    }

    #[test]
    fn infers_pages_router_routes() {
        let m = extract("pages/blog/[slug].tsx", "export default function Post() { return null; }");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].properties["path"], "/blog/:slug");
    }

    #[test]
    fn extracts_server_actions() {
        let src = r#"
"use server";
export async function createUser(formData: FormData) { return null; }
"#;
        let m = extract("app/actions.ts", src);
        assert!(m.iter().any(|x| x.kind == FrameworkEntityKind::Route && x.properties["kind"] == "server_action"));
    }
}
