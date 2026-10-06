//! Spring Cloud Gateway framework metadata extractor.
//!
//! Detects:
//!   - `RouteLocator` bean methods using the fluent DSL (`route(...)`, `path(...)`, `filters(...)`)
//!   - custom classes implementing `GatewayFilter`
//!   - YAML / properties config under `spring.cloud.gateway.routes`
//!
//! Cross-file resolution and graph construction are left to `index.rs`.
use crate::frameworks::{FrameworkContext, FrameworkEntityKind, FrameworkExtension, RawFrameworkMetadata};
use crate::language::RawFile;
use serde_json::json;
use std::collections::HashMap;
use tree_sitter::{Node, Tree};

pub struct SpringCloudGatewayExtension;

impl FrameworkExtension for SpringCloudGatewayExtension {
    fn framework(&self) -> &'static str { "spring-cloud-gateway" }

    fn matches(&self, rel: &str) -> bool { rel.ends_with(".java") || rel.ends_with(".yml") || rel.ends_with(".yaml") || rel.ends_with(".properties") }

    fn extract(&self, ctx: FrameworkContext, raw: &mut RawFile) {
        if ctx.rel.ends_with(".java") {
            if let Some(tree) = parse_java(ctx.src) {
                let mut w = GatewayWalker { src: ctx.src.as_bytes(), rel: ctx.rel, raw, class_stack: Vec::new() };
                w.visit(tree.root_node());
            }
        } else if ctx.rel.ends_with(".yml") || ctx.rel.ends_with(".yaml") {
            parse_yml(ctx.rel, ctx.src, raw);
        } else if ctx.rel.ends_with(".properties") {
            parse_properties(ctx.rel, ctx.src, raw);
        }
    }
}

fn parse_java(src: &str) -> Option<Tree> {
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_java::LANGUAGE.into()).ok()?;
    parser.parse(src, None)
}

struct GatewayWalker<'a> {
    src: &'a [u8],
    rel: &'a str,
    raw: &'a mut RawFile,
    class_stack: Vec<String>,
}

impl<'a> GatewayWalker<'a> {
    fn text(&self, n: Node) -> String {
        n.utf8_text(self.src).unwrap_or("").to_string()
    }

    fn simple_type(&self, n: Node) -> String {
        self.text(n).split('<').next().unwrap_or("").rsplit('.').next().unwrap_or("").trim().to_string()
    }

    fn string_arg(&self, n: Node) -> Option<String> {
        let mut stack = vec![n];
        while let Some(x) = stack.pop() {
            if x.kind() == "string_literal" {
                let t = self.text(x);
                return Some(t.trim_matches(|c| c == '"' || c == '\'').to_string());
            }
            let mut c = x.walk();
            stack.extend(x.named_children(&mut c));
        }
        None
    }

    fn first_string_arg(&self, args: Option<Node>) -> Option<String> {
        let args = args?;
        let mut c = args.walk();
        for a in args.named_children(&mut c) {
            if let Some(s) = self.string_arg(a) { return Some(s); }
        }
        None
    }

    fn callee_name(&self, n: Node) -> Option<String> {
        // tree-sitter-java represents method_invocation with named children "object" and "name".
        if let Some(name) = n.child_by_field_name("name") {
            return Some(self.text(name));
        }
        // Other grammars (TS/JS) use a "function" field.
        let f = n.child_by_field_name("function")?;
        match f.kind() {
            "identifier" => Some(self.text(f)),
            "member_access" | "field_access" => f.child_by_field_name("field").or_else(|| f.child_by_field_name("name")).map(|p| self.text(p)),
            "member_expression" => f.child_by_field_name("property").map(|p| self.text(p)),
            _ => None,
        }
    }

    fn is_route_locator_return(&self, n: Node) -> bool {
        n.child_by_field_name("type").map(|t| self.simple_type(t) == "RouteLocator").unwrap_or(false)
    }

    fn push_meta(&mut self, kind: FrameworkEntityKind, name: String, subject_symbol: Option<usize>, start: usize, end: usize, properties: serde_json::Value, parent: Option<String>) {
        self.raw.framework_metadata.push(crate::frameworks::RawFrameworkMetadata {
            framework: "spring-cloud-gateway",
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
            "class_declaration" => {
                if let Some(name) = n.child_by_field_name("name") {
                    let nm = self.text(name);
                    let is_filter = self.implements(&n, "GatewayFilter");
                    let is_filter_factory = self.implements(&n, "GatewayFilterFactory");
                    if is_filter || is_filter_factory {
                        let idx = self.symbol_index(&nm);
                        self.push_meta(FrameworkEntityKind::GatewayFilter, nm.clone(), idx, n.start_byte(), n.end_byte(), json!({"kind": if is_filter { "filter" } else { "filter_factory" }}), None);
                    }
                    self.class_stack.push(nm);
                    self.kids(n);
                    self.class_stack.pop();
                    return;
                }
            }
            "method_declaration" => {
                if self.is_route_locator_return(n) || self.has_route_calls(n) {
                    self.extract_route_dsl(n);
                }
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

    fn implements(&self, class: &Node, interface: &str) -> bool {
        class.child_by_field_name("interfaces").map(|ifs| {
            let mut c = ifs.walk();
            let list: Vec<_> = ifs.named_children(&mut c).collect();
            list.iter().any(|i| self.simple_type(*i) == interface)
        }).unwrap_or(false)
    }

    fn symbol_index(&self, qualified: &str) -> Option<usize> {
        self.raw.symbols.iter().position(|s| s.qualified == qualified)
    }

    fn has_route_calls(&self, method: Node) -> bool {
        let mut stack = vec![method];
        while let Some(n) = stack.pop() {
            if n.kind() == "method_invocation" {
                if self.callee_name(n).as_deref() == Some("route") {
                    return true;
                }
            }
            let mut c = n.walk();
            stack.extend(n.named_children(&mut c));
        }
        false
    }

    fn extract_route_dsl(&mut self, method: Node) {
        // Find all top-level .route(...) invocations in this method.
        let mut stack = vec![method];
        while let Some(n) = stack.pop() {
            if n.kind() == "method_invocation" {
                if let Some(name) = self.callee_name(n) {
                    if name == "route" {
                        self.extract_route(n);
                    }
                }
            }
            let mut c = n.walk();
            stack.extend(n.named_children(&mut c));
        }
    }

    fn extract_route(&mut self, route_call: Node) {
        let route_id = self.first_string_arg(route_call.child_by_field_name("arguments"));
        let route_span = (route_call.start_byte(), route_call.end_byte());
        let route_name = route_id.clone().unwrap_or_else(|| format!("route:{}", route_call.start_byte()));

        // Walk inside the route lambda / arguments, but do not descend into the
        // receiver chain (the `object` child) because that contains earlier routes.
        let mut predicates = Vec::new();
        let mut filters = Vec::new();
        let mut uri = None;

        let mut stack: Vec<Node> = route_call.child_by_field_name("arguments").into_iter().flat_map(|args| {
            let mut c = args.walk();
            args.named_children(&mut c).collect::<Vec<_>>().into_iter()
        }).collect();
        // Also visit the route name node (the span covers the .route method name).
        if let Some(name_node) = route_call.child_by_field_name("name") {
            stack.push(name_node);
        }

        while let Some(n) = stack.pop() {
            if n.kind() == "method_invocation" {
                if let Some(name) = self.callee_name(n) {
                    match name.as_str() {
                        "path" | "predicate" | "host" | "method" | "cookie" | "header" | "query" | "remoteAddr" => {
                            if let Some(arg) = self.first_string_arg(n.child_by_field_name("arguments")) {
                                predicates.push(json!({"kind": name, "value": arg}));
                            }
                        }
                        "uri" => {
                            uri = self.first_string_arg(n.child_by_field_name("arguments"));
                        }
                        "filters" => {
                            if let Some(args) = n.child_by_field_name("arguments") {
                                let mut c = args.walk();
                                for a in args.named_children(&mut c) {
                                    if a.kind() == "lambda_expression" {
                                        self.collect_filters(a, &mut filters);
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            // Descend into all children except the receiver chain of the route_call itself.
            let mut c = n.walk();
            for ch in n.named_children(&mut c) {
                if n == route_call && Some(ch) == route_call.child_by_field_name("object") {
                    continue;
                }
                stack.push(ch);
            }
        }

        self.push_meta(
            FrameworkEntityKind::GatewayRoute,
            route_name.clone(),
            None,
            route_span.0,
            route_span.1,
            json!({"id": route_id, "uri": uri, "predicates": predicates, "filters": filters}),
            None,
        );

        // Emit filter metadata rows that point back to this route as parent.
        for (i, f) in filters.iter().enumerate() {
            let fname = f["name"].as_str().unwrap_or("filter");
            let fstart = route_span.0 + i; // deterministic, evidence points at route span
            self.push_meta(
                FrameworkEntityKind::GatewayFilter,
                format!("{}.{}", route_name, fname),
                None,
                fstart,
                route_span.1,
                json!({"name": fname, "args": f.get("args").cloned().unwrap_or(serde_json::Value::Null)}),
                Some(route_name.clone()),
            );
        }
    }

    fn collect_filters(&self, n: Node, out: &mut Vec<serde_json::Value>) {
        // Collect method invocations that look like filter calls.
        if n.kind() == "method_invocation" {
            if let Some(name) = self.callee_name(n) {
                if is_filter_method(&name) {
                    out.push(json!({"name": name, "args": self.filter_args(n)}));
                }
            }
        }
        let mut c = n.walk();
        for ch in n.named_children(&mut c) {
            self.collect_filters(ch, out);
        }
    }

    fn filter_args(&self, n: Node) -> serde_json::Value {
        let mut args = Vec::new();
        if let Some(args_node) = n.child_by_field_name("arguments") {
            let mut c = args_node.walk();
            for a in args_node.named_children(&mut c) {
                if let Some(s) = self.string_arg(a) {
                    args.push(json!(s));
                } else if a.kind() == "integer_literal" || a.kind() == "decimal_integer_literal" {
                    args.push(json!(self.text(a).parse::<i64>().unwrap_or(0)));
                } else if a.kind() == "lambda_expression" {
                    // e.g. circuitBreaker(c -> c.setName(...))
                    // Collect nested method invocations as a map.
                    let mut map = HashMap::new();
                    let mut stack = vec![a];
                    while let Some(x) = stack.pop() {
                        if x.kind() == "method_invocation" {
                            if let Some(mname) = self.callee_name(x) {
                                if let Some(val) = self.first_string_arg(x.child_by_field_name("arguments")) {
                                    map.insert(mname, val);
                                }
                            }
                        }
                        let mut c = x.walk();
                        stack.extend(x.named_children(&mut c));
                    }
                    if !map.is_empty() {
                        args.push(serde_json::to_value(map).unwrap_or(serde_json::Value::Null));
                    }
                }
            }
        }
        json!(args)
    }
}

fn is_filter_method(name: &str) -> bool {
    matches!(name,
        "stripPrefix" | "addRequestHeader" | "addResponseHeader" | "addRequestParameter" | "addResponseParameter" |
        "circuitBreaker" | "retry" | "rewritePath" | "setPath" | "setStatus" | "requestRateLimiter" |
        "hystrix" | "prefixPath" | "removeRequestHeader" | "removeResponseHeader" | "removeRequestParameter" |
        "setRequestHeader" | "setResponseHeader" | "dedupeResponseHeader" | "setRequestSize" | "modifyRequestBody" |
        "modifyResponseBody" | "mapRequestHeader" | "mapResponseHeader" | "secureHeaders" | "setRequestHostHeader"
    )
}

fn parse_yml(_rel: &str, src: &str, raw: &mut RawFile) {
    let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(src) else { return };
    let routes = yaml
        .get("spring")
        .and_then(|v| v.get("cloud"))
        .and_then(|v| v.get("gateway"))
        .and_then(|v| v.get("routes"))
        .and_then(|v| v.as_sequence())
        .cloned()
        .unwrap_or_default();

    for route in routes {
        let Some(map) = route.as_mapping() else { continue };
        let id = map.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let uri = map.get("uri").and_then(|v| v.as_str()).map(String::from);
        let predicates: Vec<String> = map.get("predicates")
            .and_then(|v| v.as_sequence())
            .map(|seq| seq.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let filters: Vec<serde_json::Value> = map.get("filters")
            .and_then(|v| v.as_sequence())
            .map(|seq| {
                seq.iter().filter_map(|x| {
                    if let Some(s) = x.as_str() { Some(json!({"name": s.split('=').next().unwrap_or(s), "raw": s})) }
                    else if let Some(fmap) = x.as_mapping() {
                        let name = fmap.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let args = serde_json::to_value(fmap.get("args")).unwrap_or(serde_json::Value::Null);
                        Some(json!({"name": name, "args": args}))
                    } else { None }
                }).collect()
            })
            .unwrap_or_default();

        if id.is_empty() { continue; }
        let start = byte_pos(src, &id).unwrap_or(0);
        let end = start + id.len();

        raw.framework_metadata.push(crate::frameworks::RawFrameworkMetadata {
            framework: "spring-cloud-gateway",
            kind: FrameworkEntityKind::GatewayRoute,
            name: id.clone(),
            subject_symbol: None,
            start,
            end,
            properties: json!({"id": id, "uri": uri, "predicates": predicates, "filters": filters, "source": "yml"}),
            parent: None,
        });

        for (i, f) in filters.iter().enumerate() {
            let fname = f["name"].as_str().unwrap_or("filter").to_string();
            raw.framework_metadata.push(crate::frameworks::RawFrameworkMetadata {
                framework: "spring-cloud-gateway",
                kind: FrameworkEntityKind::GatewayFilter,
                name: format!("{}.{}", id, fname),
                subject_symbol: None,
                start: start + i,
                end,
                properties: json!({"name": fname, "args": f.get("args").cloned().unwrap_or(serde_json::Value::Null), "raw": f.get("raw").cloned()}),
                parent: Some(id.clone()),
            });
        }
    }
}

fn split_filters(s: &str) -> Vec<String> {
    // Split filter list on commas that start a new filter name (uppercase first letter).
    // This keeps commas inside filter arguments such as RewritePath=/a,/b together.
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == ',' {
            if chars.peek().map(|c| c.is_ascii_uppercase()).unwrap_or(false) {
                if !cur.is_empty() { out.push(cur.trim().to_string()); }
                cur.clear();
                continue;
            }
        }
        cur.push(ch);
    }
    if !cur.is_empty() { out.push(cur.trim().to_string()); }
    out
}

fn parse_properties(_rel: &str, src: &str, raw: &mut RawFile) {
    // Flatten spring.cloud.gateway.routes[N].* into per-route maps.
    let mut routes: HashMap<String, HashMap<String, String>> = HashMap::new();
    for line in src.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let Some((k, v)) = line.split_once('=') else { continue };
        let k = k.trim();
        let v = v.trim();
        if let Some(idx) = k.strip_prefix("spring.cloud.gateway.routes[") {
            if let Some((n, rest)) = idx.split_once("].") {
                routes.entry(n.to_string()).or_default().insert(rest.to_string(), v.to_string());
            }
        }
    }
    for (n, props) in routes {
        let id = props.get("id").cloned().unwrap_or_else(|| n.clone());
        let uri = props.get("uri").cloned();
        let predicates: Vec<String> = props.get("predicates")
            .map(|s| s.split(',').map(|x| x.trim().to_string()).collect())
            .unwrap_or_default();
        let filters: Vec<String> = props.get("filters")
            .map(|s| split_filters(s))
            .unwrap_or_default();

        let start = byte_pos(src, &id).unwrap_or(0);
        let end = start + id.len();

        raw.framework_metadata.push(crate::frameworks::RawFrameworkMetadata {
            framework: "spring-cloud-gateway",
            kind: FrameworkEntityKind::GatewayRoute,
            name: id.clone(),
            subject_symbol: None,
            start,
            end,
            properties: json!({"id": id, "uri": uri, "predicates": predicates, "filters": filters, "source": "properties"}),
            parent: None,
        });

        for (i, f) in filters.iter().enumerate() {
            let fname = f.split('=').next().unwrap_or(f.as_str()).to_string();
            raw.framework_metadata.push(crate::frameworks::RawFrameworkMetadata {
                framework: "spring-cloud-gateway",
                kind: FrameworkEntityKind::GatewayFilter,
                name: format!("{}.{}", id, fname),
                subject_symbol: None,
                start: start + i,
                end,
                properties: json!({"name": fname, "raw": f}),
                parent: Some(id.clone()),
            });
        }
    }
}

fn byte_pos(src: &str, needle: &str) -> Option<usize> {
    src.find(needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frameworks::FrameworkEntityKind;

    fn extract_java(src: &str) -> Vec<RawFrameworkMetadata> {
        let mut raw = crate::language::RawFile::default();
        let ext = SpringCloudGatewayExtension;
        let ctx = FrameworkContext { rel: "src/GatewayConfig.java", src, project_root: std::path::Path::new(".") };
        ext.extract(ctx, &mut raw);
        raw.framework_metadata
    }

    #[test]
    fn extracts_route_locator_dsl() {
        let src = r#"
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.route.builder.RouteLocatorBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class GatewayConfig {
    @Bean
    public RouteLocator customRouteLocator(RouteLocatorBuilder builder) {
        return builder.routes()
            .route("payments", r -> r.path("/api/payments/**")
                .filters(f -> f.stripPrefix(1).circuitBreaker(c -> c.setName("payments")))
                .uri("http://payments"))
            .build();
    }
}
"#;
        let m = extract_java(src);
        let route = m.iter().find(|x| x.kind == FrameworkEntityKind::GatewayRoute).unwrap();
        assert_eq!(route.name, "payments");
        assert_eq!(route.properties["uri"], "http://payments");
        let filters: Vec<String> = m.iter().filter(|x| x.kind == FrameworkEntityKind::GatewayFilter).map(|x| x.name.clone()).collect();
        assert!(filters.iter().any(|n| n.contains("stripPrefix")), "filters: {:?}", filters);
        assert!(filters.iter().any(|n| n.contains("circuitBreaker")), "filters: {:?}", filters);
    }

    #[test]
    fn extracts_fixture_gateway_config() {
        let src = include_str!("../../../../fixtures/spring-repo/src/main/java/com/example/gateway/GatewayConfig.java");
        let m = extract_java(src);
        assert!(m.iter().any(|x| x.kind == FrameworkEntityKind::GatewayRoute && x.name == "payments"));
        assert!(m.iter().any(|x| x.kind == FrameworkEntityKind::GatewayRoute && x.name == "orders"));
    }

    #[test]
    fn extracts_custom_gateway_filter_class() {
        let src = r#"
import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

public class AuthFilter implements GatewayFilter {
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) { return chain.filter(exchange); }
}
"#;
        let m = extract_java(src);
        let f = m.iter().find(|x| x.kind == FrameworkEntityKind::GatewayFilter).unwrap();
        assert_eq!(f.name, "AuthFilter");
    }

    #[test]
    fn extracts_routes_from_yml() {
        let src = r#"
spring:
  cloud:
    gateway:
      routes:
        - id: payments-route
          uri: http://payments
          predicates:
            - Path=/api/payments/**
          filters:
            - StripPrefix=1
            - name: CircuitBreaker
              args:
                name: payments
"#;
        let mut raw = crate::language::RawFile::default();
        parse_yml("application.yml", src, &mut raw);
        let routes: Vec<_> = raw.framework_metadata.iter().filter(|x| x.kind == FrameworkEntityKind::GatewayRoute).collect();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].name, "payments-route");
        let filters: Vec<_> = raw.framework_metadata.iter().filter(|x| x.kind == FrameworkEntityKind::GatewayFilter).collect();
        assert_eq!(filters.len(), 2);
    }

    #[test]
    fn extracts_routes_from_properties() {
        let src = r#"
spring.cloud.gateway.routes[0].id=orders-route
spring.cloud.gateway.routes[0].uri=http://orders
spring.cloud.gateway.routes[0].predicates=Path=/api/orders/**
spring.cloud.gateway.routes[0].filters=StripPrefix=1,RewritePath=/api/(?<segment>.*),/$\{segment}
"#;
        let mut raw = crate::language::RawFile::default();
        parse_properties("application.properties", src, &mut raw);
        let routes: Vec<_> = raw.framework_metadata.iter().filter(|x| x.kind == FrameworkEntityKind::GatewayRoute).collect();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].name, "orders-route");
        let filters: Vec<_> = raw.framework_metadata.iter().filter(|x| x.kind == FrameworkEntityKind::GatewayFilter).collect();
        assert_eq!(filters.len(), 2);
    }
}
