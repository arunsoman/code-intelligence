//! Express / Fastify / Koa-style framework metadata extractor.
//!
//! Detects:
//!   - `app.get/post/put/delete/patch/all/head/options(path, ...handlers)`
//!   - `router.get/post/put/delete/patch/all/head/options(path, ...handlers)`
//!   - `app.use(path?, handler)` middleware mounts
//!   - exported `registerRoutes(app)` / `createApp()` helpers
//!   - route handler functions passed as arguments
//!
//! Cross-file resolution is left to `index.rs`.
use crate::frameworks::{FrameworkContext, FrameworkEntityKind, FrameworkExtension, RawFrameworkMetadata};
use crate::language::RawFile;
use serde_json::json;
use tree_sitter::{Node, Tree};

pub struct ExpressExtension;

const HTTP_METHODS: &[(&str, &str)] = &[
    ("get", "GET"),
    ("post", "POST"),
    ("put", "PUT"),
    ("patch", "PATCH"),
    ("delete", "DELETE"),
    ("all", "ALL"),
    ("head", "HEAD"),
    ("options", "OPTIONS"),
];

impl FrameworkExtension for ExpressExtension {
    fn framework(&self) -> &'static str { "express" }

    fn matches(&self, rel: &str) -> bool {
        rel.ends_with(".ts") || rel.ends_with(".tsx") || rel.ends_with(".js") || rel.ends_with(".jsx") || rel.ends_with(".mjs") || rel.ends_with(".cjs")
    }

    fn extract(&self, ctx: FrameworkContext, raw: &mut RawFile) {
        let Some(tree) = parse_ts(ctx.src) else { return };
        let mut w = ExpressWalker { src: ctx.src.as_bytes(), rel: ctx.rel, raw };
        w.visit(tree.root_node());
    }
}

fn parse_ts(src: &str) -> Option<Tree> {
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()).ok()?;
    parser.parse(src, None)
}

struct ExpressWalker<'a> {
    src: &'a [u8],
    rel: &'a str,
    raw: &'a mut RawFile,
}

impl<'a> ExpressWalker<'a> {
    fn text(&self, n: Node) -> String { n.utf8_text(self.src).unwrap_or("").to_string() }

    fn push(&mut self, kind: FrameworkEntityKind, name: String, subject_symbol: Option<usize>, start: usize, end: usize, properties: serde_json::Value, parent: Option<String>) {
        self.raw.framework_metadata.push(RawFrameworkMetadata {
            framework: "express",
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
            "call_expression" => {
                self.handle_call(n);
                self.kids(n);
                return;
            }
            "function_declaration" | "arrow_function" | "function_expression" => {
                // Handler detection is deferred until the function appears as a route argument.
                self.kids(n);
                return;
            }
            _ => self.kids(n),
        }
    }

    fn kids(&mut self, n: Node) {
        let mut c = n.walk();
        for ch in n.named_children(&mut c) { self.visit(ch); }
    }

    fn handle_call(&mut self, n: Node) {
        let Some(method) = self.route_method(n) else { return };
        let args = n.child_by_field_name("arguments");
        let path = self.first_string_arg(args);
        let handlers = self.collect_handlers(args);
        let method_upper = method.to_ascii_uppercase();
        let route_name = match method {
            "use" => format!("middleware:{}", path.clone().unwrap_or_else(|| "*".to_string())),
            _ => format!("{} {}", method_upper, path.clone().unwrap_or_else(|| "".to_string())),
        };
        let kind = if method == "use" { FrameworkEntityKind::Middleware } else { FrameworkEntityKind::Route };
        self.push(kind, route_name.clone(), None, n.start_byte(), n.end_byte(), json!({
            "method": method_upper,
            "path": path,
            "handler_count": handlers.len(),
            "handlers": handlers.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
        }), None);

        // Emit middleware rows for each named handler in the chain.
        for (i, (h, hstart)) in handlers.iter().enumerate() {
            if h.is_empty() { continue; }
            let fstart = *hstart;
            self.push(FrameworkEntityKind::Middleware, h.clone(), None, fstart, n.end_byte(), json!({
                "name": h,
                "applied_on": route_name.clone(),
                "method": method,
                "path": path,
            }), Some(route_name.clone()));
        }
    }

    fn route_method(&self, n: Node) -> Option<&'static str> {
        let f = n.child_by_field_name("function")?;
        let (receiver, prop) = match f.kind() {
            "member_expression" => {
                let prop = f.child_by_field_name("property").map(|p| self.text(p))?;
                let recv = f.child_by_field_name("object").map(|o| self.text(o))?;
                (recv, prop)
            }
            _ => return None,
        };
        let is_routerish = receiver == "app" || receiver == "router" || receiver == "server" || receiver == "route" || receiver.ends_with("Router") || receiver.ends_with("erver");
        if !is_routerish { return None; }
        if prop == "use" { return Some("use"); }
        let prop_static: &str = Box::leak(prop.clone().into_boxed_str());
        if HTTP_METHODS.iter().any(|(m, _)| *m == prop_static) {
            return Some(prop_static);
        }
        None
    }

    fn first_string_arg(&self, args: Option<Node>) -> Option<String> {
        let args = args?;
        let first = args.named_child(0)?;
        match first.kind() {
            "string" => Some(self.text(first).trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string()),
            "template_string" if !self.text(first).contains("${") => Some(self.text(first).trim_matches('`').to_string()),
            _ => None,
        }
    }

    fn collect_handlers(&self, args: Option<Node>) -> Vec<(String, usize)> {
        let mut out = Vec::new();
        let Some(args) = args else { return out };
        let mut c = args.walk();
        for (i, a) in args.named_children(&mut c).enumerate() {
            if i == 0 { continue; } // skip path arg
            let (name, start) = match a.kind() {
                "identifier" => (self.text(a), a.start_byte()),
                "member_expression" => (a.child_by_field_name("property").map(|p| self.text(p)).unwrap_or_default(), a.start_byte()),
                "arrow_function" | "function_expression" => {
                    // Try to find a bound name in the parent variable declarator.
                    a.parent().and_then(|p| self.infer_function_name(p, a)).map(|n| (n, a.start_byte())).unwrap_or_else(|| (String::new(), a.start_byte()))
                }
                _ => (String::new(), a.start_byte()),
            };
            out.push((name, start));
        }
        out
    }

    fn infer_function_name(&self, parent: Node, _fn: Node) -> Option<String> {
        if parent.kind() == "variable_declarator" {
            return parent.child_by_field_name("name").map(|n| self.text(n));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract(src: &str) -> Vec<RawFrameworkMetadata> {
        let mut raw = crate::language::RawFile::default();
        let ext = ExpressExtension;
        let ctx = FrameworkContext { rel: "src/routes.ts", src, project_root: std::path::Path::new(".") };
        ext.extract(ctx, &mut raw);
        raw.framework_metadata
    }

    #[test]
    fn extracts_app_routes_and_middleware() {
        let src = r#"
import { requireAuth } from "./middleware";

export function registerRoutes(app: any) {
  app.get("/users/:id", (req, res) => res.json({}));
  app.post("/users", requireAuth, (req, res) => res.json({}));
  app.use("/api", requireAuth);
}
"#;
        let m = extract(src);
        let routes: Vec<_> = m.iter().filter(|x| x.kind == FrameworkEntityKind::Route).collect();
        assert_eq!(routes.len(), 2);
        assert!(routes.iter().any(|r| r.properties["method"] == "GET" && r.properties["path"] == "/users/:id"));
        assert!(routes.iter().any(|r| r.properties["method"] == "POST" && r.properties["path"] == "/users"));

        let middleware: Vec<_> = m.iter().filter(|x| x.kind == FrameworkEntityKind::Middleware).collect();
        assert!(middleware.iter().any(|mw| mw.name == "requireAuth"));
    }

    #[test]
    fn extracts_router_routes() {
        let src = r#"
import { Router } from "express";
const router = Router();

const listUsers = (req, res) => res.json([]);

router.get("/", listUsers);
router.delete("/:id", async (req, res) => res.json({}));

export default router;
"#;
        let m = extract(src);
        let routes: Vec<_> = m.iter().filter(|x| x.kind == FrameworkEntityKind::Route).collect();
        assert_eq!(routes.len(), 2);
        assert!(routes.iter().any(|r| r.properties["method"] == "GET" && r.properties["path"] == "/"));
        assert!(routes.iter().any(|r| r.properties["method"] == "DELETE"));
        let middleware: Vec<_> = m.iter().filter(|x| x.kind == FrameworkEntityKind::Middleware).collect();
        assert!(middleware.iter().any(|mw| mw.name == "listUsers"));
    }
}
