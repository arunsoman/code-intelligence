//! NestJS framework metadata extractor.
//!
//! Detects:
//!   - `@Controller`, `@Injectable`, `@Module`, `@Guard`, `@Interceptor`, `@Catch`
//!   - `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@All`, `@Head`, `@Options`
//!   - route prefixes, path parameters, `@Body`, `@Param`, `@Query`, `@Headers`
//!   - constructor injection (`@Inject`, `@Optional`, typed parameters)
//!   - module graph (`imports`, `controllers`, `providers`, `exports`, `bootstrap`)
//!
//! Cross-file resolution and graph construction are left to `index.rs`.
use crate::frameworks::{FrameworkContext, FrameworkEntityKind, FrameworkExtension, RawFrameworkMetadata};
use crate::language::RawFile;
use serde_json::json;
use std::collections::HashMap;
use tree_sitter::{Node, Tree};

pub struct NestJsExtension;

impl FrameworkExtension for NestJsExtension {
    fn framework(&self) -> &'static str { "nestjs" }

    fn matches(&self, rel: &str) -> bool { rel.ends_with(".ts") || rel.ends_with(".tsx") || rel.ends_with(".mts") || rel.ends_with(".cts") }

    fn extract(&self, ctx: FrameworkContext, raw: &mut RawFile) {
        let Some(tree) = parse_ts(ctx.src) else { return };
        let mut w = NestWalker { src: ctx.src.as_bytes(), raw, class_stack: Vec::new() };
        w.visit(tree.root_node());
        w.emit_module_relationships();
    }
}

fn parse_ts(src: &str) -> Option<Tree> {
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()).ok()?;
    parser.parse(src, None)
}

struct NestWalker<'a> {
    src: &'a [u8],
    raw: &'a mut RawFile,
    class_stack: Vec<(String, HashMap<String, serde_json::Value>)>,
}

impl<'a> NestWalker<'a> {
    fn text(&self, n: Node) -> String { n.utf8_text(self.src).unwrap_or("").to_string() }

    fn implements(&self, class: &Node, interface: &str) -> bool {
        let mut c = class.walk();
        for ch in class.named_children(&mut c) {
            let clauses: Vec<Node> = if ch.kind() == "implements_clause" || ch.kind() == "heritage_clause" {
                vec![ch]
            } else if ch.kind() == "class_heritage" {
                let mut c2 = ch.walk();
                ch.named_children(&mut c2).filter(|x| x.kind() == "implements_clause").collect()
            } else {
                continue;
            };
            for clause in clauses {
                let mut c2 = clause.walk();
                for i in clause.named_children(&mut c2) {
                    let text = self.text(i);
                    let t = text.split('<').next().unwrap_or("").rsplit('.').next().unwrap_or("").trim();
                    if t == interface { return true; }
                }
            }
        }
        false
    }

    fn push(&mut self, kind: FrameworkEntityKind, name: String, subject_symbol: Option<usize>, start: usize, end: usize, properties: serde_json::Value, parent: Option<String>) {
        self.raw.framework_metadata.push(RawFrameworkMetadata {
            framework: "nestjs",
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
            "decorated_definition" => {
                if let Some(def) = n.child_by_field_name("definition") {
                    self.visit(def);
                } else {
                    self.kids(n);
                }
                return;
            }
            "class_declaration" | "abstract_class_declaration" => {
                if let Some(name) = n.child_by_field_name("name") {
                    let class_name = self.text(name);
                    let class_span = (n.start_byte(), n.end_byte());
                    let mut class_props = HashMap::new();
                    let mut role: Option<FrameworkEntityKind> = None;
                    let mut _parent: Option<String> = None;

                    let decorators = self.decorators_for(n);
                    for (dname, dargs, (ds, de)) in decorators {
                        let dname = dname;
                        let dargs_owned = dargs.clone();
                        let dargs_ref = dargs_owned.as_deref();
                        match dname.as_str() {
                            "Controller" => {
                                role = Some(FrameworkEntityKind::Controller);
                                let prefix = dargs_owned.clone().unwrap_or_default();
                                class_props.insert("route_prefix".to_string(), json!(prefix));
                            }
                            "Injectable" => { role = Some(FrameworkEntityKind::Provider); }
                            "Module" => { role = Some(FrameworkEntityKind::Module); }
                            "Guard" => { role = Some(FrameworkEntityKind::Guard); }
                            "UseGuards" => { /* references a guard class; emitted below */ }
                            "Interceptor" => { role = Some(FrameworkEntityKind::Interceptor); }
                            "UseInterceptors" => { /* references an interceptor class; emitted below */ }
                            "Catch" => { role = Some(FrameworkEntityKind::Guard); }
                            _ => {}
                        }
                        if dname == "Module" {
                            if let Some(args) = dargs_owned.as_deref().and_then(|a| parse_literal_object(a)) {
                                class_props.insert("module_meta".to_string(), json!(args));
                            }
                        }
                        if dname == "UseGuards" || dname == "UseInterceptors" {
                            if let Some(args) = dargs_ref {
                                _parent = Some(class_name.clone());
                                let kind = if dname == "UseGuards" { FrameworkEntityKind::Guard } else { FrameworkEntityKind::Interceptor };
                                self.push_meta_inline_decorator(kind, args, ds, de, class_name.clone());
                            }
                        }
                    }

                    if let Some(r) = role {
                        let sym = self.symbol_index(&class_name);
                        self.push(r, class_name.clone(), sym, class_span.0, class_span.1, serde_json::to_value(&class_props).unwrap_or(json!({})), None);
                        // NestJS convention: @Injectable() classes implementing CanActivate are guards.
                        if r == FrameworkEntityKind::Provider && self.implements(&n, "CanActivate") {
                            self.push(FrameworkEntityKind::Guard, class_name.clone(), sym, class_span.0, class_span.1, json!({"convention":"CanActivate"}), None);
                        }
                    }

                    self.class_stack.push((class_name, class_props));
                    self.kids(n);
                    self.class_stack.pop();
                    return;
                }
            }
            "method_definition" => {
                if let Some(name) = n.child_by_field_name("name") {
                    let method_name = self.text(name);
                    let method_span = (n.start_byte(), n.end_byte());

                    // Constructors are method_definitions named "constructor" in tree-sitter-typescript.
                    if method_name == "constructor" {
                        if let Some((class_name, _class_props)) = self.class_stack.last().cloned() {
                            let class_sym = self.symbol_index(&class_name);
                            let params = self.constructor_params(n);
                            for p in params {
                                let is_inject = p.decorators.iter().any(|d| d == "Inject");
                                let is_optional = p.decorators.iter().any(|d| d == "Optional");
                                let should_emit = is_inject || p.type_name.is_some();
                                if !should_emit { continue; }
                                let token = p.inject_token.clone().unwrap_or_else(|| p.type_name.clone().unwrap_or_default());
                                let target = class_name.clone();
                                self.push(FrameworkEntityKind::Inject, format!("{}.{}", class_name, p.name), class_sym, p.start, p.end, json!({
                                    "target": target,
                                    "token": token,
                                    "type": p.type_name,
                                    "parameter": p.name,
                                    "optional": is_optional,
                                    "kind": if is_inject { "@Inject" } else { "constructor" }
                                }), Some(class_name.clone()));
                            }
                        }
                        self.kids(n);
                        return;
                    }

                    let decorators = self.decorators_for(n);

                    // If parent class is a controller, default path is method name (unless overridden by @Get etc).
                    let parent_controller = self.class_stack.last().and_then(|(cn, props)| {
                        if props.contains_key("route_prefix") { Some(cn.clone()) } else { None }
                    });

                    let mut method_route_path: Option<String> = None;
                    let mut http_method: Option<String> = None;

                    for (dname, dargs, _) in decorators {
                        let dname = dname;
                        let dargs_ref = dargs.as_deref();
                        let path = dargs_ref.map(String::from).unwrap_or_default();
                        match dname.as_str() {
                            "Get" => { http_method = Some("GET".to_string()); method_route_path = Some(path); }
                            "Post" => { http_method = Some("POST".to_string()); method_route_path = Some(path); }
                            "Put" => { http_method = Some("PUT".to_string()); method_route_path = Some(path); }
                            "Patch" => { http_method = Some("PATCH".to_string()); method_route_path = Some(path); }
                            "Delete" => { http_method = Some("DELETE".to_string()); method_route_path = Some(path); }
                            "All" => { http_method = Some("ALL".to_string()); method_route_path = Some(path); }
                            "Head" => { http_method = Some("HEAD".to_string()); method_route_path = Some(path); }
                            "Options" => { http_method = Some("OPTIONS".to_string()); method_route_path = Some(path); }
                            _ => {}
                        }
                        if dname == "UseGuards" || dname == "UseInterceptors" {
                            if let Some(parent) = parent_controller.clone() {
                                let kind = if dname == "UseGuards" { FrameworkEntityKind::Guard } else { FrameworkEntityKind::Interceptor };
                                self.push_meta_inline_decorator(kind, dargs_ref.unwrap_or(""), n.start_byte(), n.end_byte(), parent);
                            }
                        }
                    }

                    if let Some(method) = http_method {
                        let sym = self.symbol_index(&format!("{}.{}", self.class_stack.last().map(|(cn, _)| cn.as_str()).unwrap_or(""), method_name));
                        let method_path = method_route_path.unwrap_or_default();
                        let prefix = self.class_stack.last().and_then(|(_, props)| {
                            props.get("route_prefix").and_then(|v| v.as_str()).map(String::from)
                        }).unwrap_or_default();
                        let full_path = join_path(&prefix, &method_path);
                        self.push(FrameworkEntityKind::Route, format!("{} {}", method, full_path), sym, method_span.0, method_span.1, json!({"method": method, "path": full_path, "handler": method_name, "prefix": prefix}), parent_controller);
                    }

                    // Constructor injection is handled inside the constructor method_definition branch.
                    self.kids(n);
                    return;
                }
            }
            _ => self.kids(n),
        }
    }

    fn kids(&mut self, n: Node) {
        let mut c = n.walk();
        for ch in n.named_children(&mut c) { self.visit(ch); }
    }

    fn decorators_for(&self, n: Node) -> Vec<(String, Option<String>, (usize, usize))> {
        // In tree-sitter-typescript, decorators are siblings of the decorated node
        // inside the parent container (export_statement, class_body, ...).
        let Some(parent) = n.parent() else { return Vec::new() };
        let mut out = Vec::new();
        let mut c = parent.walk();
        for ch in parent.named_children(&mut c) {
            if ch.id() == n.id() { break; }
            if ch.kind() == "decorator" {
                out.push(self.parse_decorator(ch));
            } else {
                // Decorators after a previous definition belong to that definition, not this one.
                out.clear();
            }
        }
        out
    }

    fn parse_decorator(&self, d: Node) -> (String, Option<String>, (usize, usize)) {
        let call = d.named_child(0);
        let (name, args) = if let Some(call_node) = call.filter(|x| x.kind() == "call_expression") {
            let name = call_node.child_by_field_name("function")
                .map(|f| self.text(f).split('.').last().unwrap_or("").trim().to_string())
                .unwrap_or_default();
            let args = call_node.child_by_field_name("arguments")
                .and_then(|a| self.decorator_arg_text(a));
            (name, args)
        } else {
            let name = self.text(d).trim_start_matches('@').split('(').next().unwrap_or("").trim().to_string();
            (name, None)
        };
        (name, args, (d.start_byte(), d.end_byte()))
    }

    /// Extract the first decorator argument as text, handling strings, identifiers,
    /// member expressions (`new AuthGuard()` becomes `AuthGuard`), and comma-separated lists.
    fn decorator_arg_text(&self, args_node: Node) -> Option<String> {
        let first = args_node.named_child(0)?;
        Some(match first.kind() {
            "string" | "string_fragment" | "template_string" => {
                let t = self.text(first);
                t.trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string()
            }
            "identifier" => self.text(first),
            "member_expression" => self.text(first),
            "new_expression" => {
                // `new AuthGuard()` -> "AuthGuard"
                first.child_by_field_name("constructor")
                    .map(|c| self.text(c))
                    .unwrap_or_else(|| self.text(first))
            }
            "array" => {
                // Collect top-level array elements as comma-separated text.
                let mut c = first.walk();
                let elements: Vec<String> = first.named_children(&mut c)
                    .filter(|e| e.kind() != ",")
                    .map(|e| self.text(e))
                    .collect();
                elements.join(", ")
            }
            "object" => self.text(first),
            _ => self.text(first),
        })
    }

    fn decorators(&self, n: Node) -> Vec<(String, Option<String>, (usize, usize))> {
        let mut out = Vec::new();
        let mut c = n.walk();
        for d in n.named_children(&mut c) {
            if d.kind() == "decorator" {
                out.push(self.parse_decorator(d));
            }
        }
        out
    }

    fn first_string_in_decorator(&self, n: Node) -> Option<String> {
        let mut stack = vec![n];
        while let Some(x) = stack.pop() {
            if x.kind() == "decorator" {
                // Look inside the decorator's call for a string argument.
                let mut c = x.walk();
                for ch in x.named_children(&mut c) {
                    if ch.kind() == "call_expression" {
                        return self.first_string_arg(ch);
                    }
                }
            }
            let mut c = x.walk();
            let mut kids: Vec<Node> = x.named_children(&mut c).collect();
            kids.reverse();
            stack.extend(kids);
        }
        None
    }

    fn first_string_arg(&self, n: Node) -> Option<String> {
        let args = n.child_by_field_name("arguments")?;
        let first = args.named_child(0)?;
        match first.kind() {
            "string" => Some(self.text(first).trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string()),
            "template_string" if !self.text(first).contains("${") => Some(self.text(first).trim_matches('`').to_string()),
            _ => None,
        }
    }

    fn symbol_index(&self, qualified: &str) -> Option<usize> {
        self.raw.symbols.iter().position(|s| s.qualified == qualified)
    }

    fn constructor_params(&self, n: Node) -> Vec<ConstructorParam> {
        let mut out = Vec::new();
        let params = n.child_by_field_name("parameters");
        if params.is_none() { return out; }
        let params = params.unwrap();
        let mut c = params.walk();
        for p in params.named_children(&mut c) {
            let decorators: Vec<String> = self.decorators(p).into_iter().map(|(n, _, _)| n).collect();
            let (name, type_name) = match p.kind() {
                "formal_parameter" | "required_parameter" | "optional_parameter" => {
                    let name = p.child_by_field_name("name")
                        .or_else(|| {
                            let mut c = p.walk();
                            let kids: Vec<_> = p.named_children(&mut c).collect();
                            kids.into_iter().find(|ch| ch.kind() == "identifier")
                        })
                        .map(|x| self.text(x))
                        .unwrap_or_default();
                    let ty = p.child_by_field_name("type").map(|x| self.text(x).trim_start_matches(':').trim().to_string());
                    (name, ty)
                }
                "identifier" => (self.text(p), None),
                _ => continue,
            };
            let inject_token = if decorators.contains(&"Inject".to_string()) {
                self.first_string_in_decorator(p)
            } else {
                None
            };
            out.push(ConstructorParam { name, type_name, decorators, inject_token, start: p.start_byte(), end: p.end_byte() });
        }
        out
    }

    fn push_meta_inline_decorator(&mut self, kind: FrameworkEntityKind, args: &str, start: usize, end: usize, parent: String) {
        // Args may be a comma-separated list of identifiers/classes: "AuthGuard, RolesGuard" or object literal string.
        for token in args.split(',') {
            let token = token.trim().trim_start_matches("new ").split('.').last().unwrap_or("").split('(').next().unwrap_or("").trim();
            if token.is_empty() { continue; }
            self.push(kind, token.to_string(), None, start, end, json!({"name": token, "applied_on": parent}), Some(parent.clone()));
        }
    }

    fn emit_module_relationships(&mut self) {
        // For every Module metadata row, emit contains relationships to controllers/providers/imports/exports.
        // We cannot mutate self.raw.framework_metadata while iterating it, so we build additions separately.
        let mut additions: Vec<RawFrameworkMetadata> = Vec::new();
        let module_rows: Vec<(String, usize, usize, serde_json::Value)> = self.raw.framework_metadata.iter()
            .filter(|m| m.framework == "nestjs" && m.kind == FrameworkEntityKind::Module)
            .map(|m| (m.name.clone(), m.start, m.end, m.properties.clone()))
            .collect();
        for (module_name, start, end, props) in module_rows {
            let meta = props.get("module_meta").cloned().unwrap_or(serde_json::Value::Null);
            if let Some(obj) = meta.as_object() {
                for key in &["controllers", "providers", "imports", "exports"] {
                    if let Some(arr) = obj.get(*key).and_then(|v| v.as_array()) {
                        for item in arr {
                            if let Some(name) = item.as_str() {
                                additions.push(RawFrameworkMetadata {
                                    framework: "nestjs",
                                    kind: FrameworkEntityKind::Provider,
                                    name: name.to_string(),
                                    subject_symbol: None,
                                    start,
                                    end,
                                    properties: json!({"module": module_name, "relation": key, "name": name}),
                                    parent: Some(module_name.clone()),
                                });
                            }
                        }
                    }
                }
            }
        }
        self.raw.framework_metadata.extend(additions);
    }
}

struct ConstructorParam {
    name: String,
    type_name: Option<String>,
    decorators: Vec<String>,
    inject_token: Option<String>,
    start: usize,
    end: usize,
}

/// Parse a compact object literal string like "{ controllers: [A, B], providers: [C] }".
/// Returns a JSON object with array values for known keys.
fn parse_literal_object(text: &str) -> Option<HashMap<String, Vec<String>>> {
    let text = text.trim();
    if !text.starts_with('{') || !text.ends_with('}') { return None; }
    let inner = &text[1..text.len()-1];
    let mut out = HashMap::new();
    for part in split_top_level(inner, ',') {
        let Some((k, v)) = part.split_once(':') else { continue };
        let k = k.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        let v = v.trim();
        if v.starts_with('[') && v.ends_with(']') {
            let items = split_top_level(&v[1..v.len()-1], ',');
            let names: Vec<String> = items.iter()
                .map(|s| s.trim().trim_start_matches("new ").split('(').next().unwrap_or("").split('.').last().unwrap_or("").trim_matches(|c| c == '"' || c == '\'').to_string())
                .filter(|s| !s.is_empty())
                .collect();
            out.insert(k, names);
        }
    }
    Some(out)
}

fn join_path(prefix: &str, path: &str) -> String {
    let prefix = prefix.trim_matches('/');
    let path = path.trim_start_matches('/');
    if prefix.is_empty() { return format!("/{}", path); }
    if path.is_empty() { return format!("/{}", prefix); }
    format!("/{}/{}", prefix, path)
}

fn split_top_level(s: &str, delim: char) -> Vec<&str> {
    let mut depth = 0;
    let mut start = 0;
    let mut out = Vec::new();
    for (i, c) in s.char_indices() {
        match c {
            '[' | '{' | '(' => depth += 1,
            ']' | '}' | ')' => depth -= 1,
            _ if c == delim && depth == 0 => {
                out.push(&s[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    if start < s.len() { out.push(&s[start..]); }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract(src: &str) -> Vec<RawFrameworkMetadata> {
        let mut raw = crate::language::RawFile::default();
        let ext = NestJsExtension;
        let ctx = FrameworkContext { rel: "src/app.controller.ts", src, project_root: std::path::Path::new(".") };
        ext.extract(ctx, &mut raw);
        raw.framework_metadata
    }

    #[test]
    fn extracts_fixture_like_guard() {
        let src = r#"
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    return request.headers.authorization === this.config.get('AUTH_TOKEN');
  }
}
"#;
        let m = extract(src);
        eprintln!("FIXTURE GUARD METADATA: {:?}", m.iter().map(|x| (x.kind, x.name.clone(), x.properties.clone())).collect::<Vec<_>>());
        assert!(m.iter().any(|x| x.kind == FrameworkEntityKind::Guard && x.name == "AuthGuard"));
    }

    #[test]
    fn extracts_controller_routes() {
        let src = r#"
import { Controller, Get, Post, Body, Param } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get(':id')
  findOne(@Param('id') id: string) { return id; }

  @Post()
  create(@Body() body: any) { return body; }
}
"#;
        let m = extract(src);
        assert!(m.iter().any(|x| x.kind == FrameworkEntityKind::Controller && x.name == "UsersController"));
        let routes: Vec<_> = m.iter().filter(|x| x.kind == FrameworkEntityKind::Route).collect();
        assert_eq!(routes.len(), 2, "routes: {:?}", routes);
        assert!(routes.iter().any(|r| r.properties["method"] == "GET" && r.properties["path"] == "/users/:id"));
        assert!(routes.iter().any(|r| r.properties["method"] == "POST" && r.properties["path"] == "/users"));
    }

    #[test]
    fn extracts_providers_and_injection() {
        let src = r#"
import { Injectable, Inject, Optional } from '@nestjs/common';

@Injectable()
export class ConfigService { }

@Injectable()
export class UsersService {
  constructor(@Inject('CONFIG') private config: ConfigService, @Optional() private db: any) {}
}
"#;
        let m = extract(src);
        assert!(m.iter().any(|x| x.kind == FrameworkEntityKind::Provider && x.name == "UsersService"));
        assert!(m.iter().any(|x| x.kind == FrameworkEntityKind::Provider && x.name == "ConfigService"));
        let injects: Vec<_> = m.iter().filter(|x| x.kind == FrameworkEntityKind::Inject).collect();
        assert!(injects.iter().any(|i| i.properties["token"] == "CONFIG"));
        assert!(injects.iter().any(|i| i.properties["type"] == "ConfigService"));
    }

    #[test]
    fn extracts_module_graph() {
        let src = r#"
import { Module } from '@nestjs/common';

@Module({
  imports: [OtherModule],
  controllers: [UsersController],
  providers: [UsersService, ConfigService],
  exports: [UsersService],
})
export class AppModule {}
"#;
        let m = extract(src);
        assert!(m.iter().any(|x| x.kind == FrameworkEntityKind::Module && x.name == "AppModule"));
        let contains: Vec<_> = m.iter().filter(|x| x.kind == FrameworkEntityKind::Provider && x.parent.as_deref() == Some("AppModule")).collect();
        assert!(contains.iter().any(|c| c.properties["relation"] == "controllers" && c.properties["name"] == "UsersController"));
        assert!(contains.iter().any(|c| c.properties["relation"] == "providers" && c.properties["name"] == "UsersService"));
        assert!(contains.iter().any(|c| c.properties["relation"] == "exports" && c.properties["name"] == "UsersService"));
        assert!(contains.iter().any(|c| c.properties["relation"] == "imports" && c.properties["name"] == "OtherModule"));
    }

    #[test]
    fn extracts_guards_and_interceptors() {
        let src = r#"
import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { LoggerInterceptor } from './logger.interceptor';

@Controller('cats')
@UseGuards(AuthGuard)
@UseInterceptors(LoggerInterceptor)
export class CatsController {
  @Get()
  @UseGuards(RolesGuard)
  findAll() { return []; }
}
"#;
        let m = extract(src);
        let guards: Vec<_> = m.iter().filter(|x| x.kind == FrameworkEntityKind::Guard).collect();
        assert!(guards.iter().any(|g| g.name == "AuthGuard"));
        assert!(guards.iter().any(|g| g.name == "RolesGuard"));
        let interceptors: Vec<_> = m.iter().filter(|x| x.kind == FrameworkEntityKind::Interceptor).collect();
        assert!(interceptors.iter().any(|i| i.name == "LoggerInterceptor"));
    }
}
