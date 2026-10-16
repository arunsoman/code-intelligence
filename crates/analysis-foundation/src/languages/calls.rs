//! Deliberately narrow binding resolution: unique same-class private static Java
//! methods only. ECMAScript names, receivers, imports and overloads stay unresolved.
use super::*;

#[derive(Clone)]
pub(super) struct ResolvedCall {
    pub target: FunctionId,
    pub parameters: Vec<Type>,
    pub return_type: Type,
    pub evidence: Span,
}
pub(super) type Resolutions = BTreeMap<(usize, usize), ResolvedCall>;

pub(super) fn resolve(
    adapter: &TreeAdapter,
    root: Node<'_>,
    source: &str,
    path: &str,
) -> Resolutions {
    let mut result = Resolutions::new();
    if !matches!(adapter.profile, Profile::Java) || root.has_error() {
        return result;
    }
    let mut methods = vec![];
    let mut calls = vec![];
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        if n.kind() == "method_declaration" {
            methods.push(n);
        }
        if n.kind() == "method_invocation" {
            calls.push(n);
        }
        stack.extend(children(n));
    }
    let mut index = BTreeMap::new();
    for method in methods {
        if let (Some(owner), Some(name)) = (owner(method), method.child_by_field_name("name")) {
            index
                .entry((owner, raw(name, source)))
                .or_insert_with(Vec::new)
                .push(method);
        }
    }
    for call in calls {
        if call.child_by_field_name("object").is_some()
            || call.child_by_field_name("type_arguments").is_some()
        {
            continue;
        }
        let Some(name) = call.child_by_field_name("name") else {
            continue;
        };
        let mut parent = call.parent();
        let mut caller = None;
        while let Some(p) = parent {
            if p.kind() == "method_declaration" {
                caller = Some(p);
                break;
            }
            if matches!(p.kind(), "lambda_expression" | "class_body") {
                break;
            }
            parent = p.parent();
        }
        let Some(owner) = caller.and_then(owner) else {
            continue;
        };
        let Some(candidates) = index.get(&(owner, raw(name, source))) else {
            continue;
        };
        if candidates.len() != 1 {
            continue;
        }
        let target = candidates[0];
        let Some(body) = target.child_by_field_name("body") else {
            continue;
        };
        let prefix = &source[target.start_byte()..body.start_byte()];
        let words: Vec<_> = prefix.split(|c: char| !c.is_alphanumeric()).collect();
        if !words.contains(&"private") || !words.contains(&"static") || prefix.contains(['@', '<'])
        {
            continue;
        }
        let Some(return_type) = target
            .child_by_field_name("type")
            .and_then(|n| type_name(raw(n, source)))
        else {
            continue;
        };
        let Some(params) = target.child_by_field_name("parameters") else {
            continue;
        };
        let parameters: Option<Vec<_>> = children(params)
            .iter()
            .map(|p| {
                if p.kind() != "formal_parameter" {
                    return None;
                }
                p.child_by_field_name("type")
                    .and_then(|n| type_name(raw(n, source)))
            })
            .collect();
        let Some(parameters) = parameters else {
            continue;
        };
        let Some(args) = call.child_by_field_name("arguments") else {
            continue;
        };
        if children(args).len() != parameters.len() {
            continue;
        }
        result.insert(
            (call.start_byte(), call.end_byte()),
            ResolvedCall {
                target: FunctionId(format!("{path}@{}:method_declaration", target.start_byte())),
                parameters,
                return_type,
                evidence: span(call),
            },
        );
    }
    result
}
fn owner(method: Node<'_>) -> Option<usize> {
    let parent = method.parent()?;
    if parent.kind() != "class_body" {
        return None;
    }
    let class = parent.parent()?;
    (class.kind() == "class_declaration").then_some(class.start_byte())
}
