//! Automatically discovered, capability-scoped source adapters. This does not replace
//! the existing worker indexer. Unsupported semantics remain explicit opaque regions.
mod expressions;

use crate::semantic_ir::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use tree_sitter::{Language, Node, Parser};

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub id: &'static str,
    pub extensions: &'static [&'static str],
    pub adapter_version: &'static str,
    pub semantics: &'static str,
    pub semantic_scope: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub path: String,
    pub source: String,
    pub revision: String,
    pub environment_digest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lowered {
    pub snapshot: Snapshot,
    pub sources: Sources,
    /// One entry for every named syntax node, including declarations and wrappers.
    pub constructs: Vec<Construct>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Construct {
    pub syntax: String,
    pub source: Span,
    pub disposition: Disposition,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Disposition {
    Represented,
    Opaque,
}

pub trait LanguageAdapter: Sync {
    fn metadata(&self) -> Metadata;
    fn lower(&self, request: &Request) -> Result<Lowered, String>;
}

include!(concat!(env!("OUT_DIR"), "/adapters.rs"));

pub struct Registry {
    adapters: Vec<&'static dyn LanguageAdapter>,
}
impl Registry {
    pub fn new(adapters: Vec<&'static dyn LanguageAdapter>) -> Result<Self, String> {
        let mut ids = BTreeSet::new();
        let mut extensions = BTreeSet::new();
        for adapter in &adapters {
            let m = adapter.metadata();
            if m.id.trim().is_empty()
                || m.adapter_version.trim().is_empty()
                || m.semantics.trim().is_empty()
                || m.semantic_scope.trim().is_empty()
                || m.extensions.is_empty()
                || !ids.insert(m.id)
            {
                return Err("invalid or duplicate adapter metadata".into());
            }
            for extension in m.extensions {
                if extension.is_empty()
                    || !extension
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                    || !extensions.insert(extension.to_ascii_lowercase())
                {
                    return Err("invalid or duplicate adapter extension".into());
                }
            }
        }
        Ok(Self { adapters })
    }
    pub fn builtins() -> Result<Self, String> {
        Self::new(builtin_adapters())
    }
    pub fn metadata(&self) -> Vec<Metadata> {
        self.adapters.iter().map(|a| a.metadata()).collect()
    }
    pub fn lower(&self, request: &Request) -> Result<Lowered, String> {
        let extension = std::path::Path::new(&request.path)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let adapter = self
            .adapters
            .iter()
            .find(|a| a.metadata().extensions.contains(&extension.as_str()))
            .ok_or("unsupported language extension")?;
        let result = adapter.lower(request)?;
        result.snapshot.validate(&result.sources)?;
        let metadata = adapter.metadata();
        let (document_id, document) = result
            .snapshot
            .documents
            .first_key_value()
            .ok_or("adapter omitted source document")?;
        if result.snapshot.documents.len() != 1
            || result.sources.len() != 1
            || result.sources.get(document_id).map(Vec::as_slice) != Some(request.source.as_bytes())
            || document.path != request.path
            || document.language != metadata.id
            || document.lowering_version != metadata.adapter_version
            || document.semantics_version != metadata.semantics
            || result.snapshot.revision != request.revision
            || result.snapshot.environment_digest != request.environment_digest
            || result.snapshot.producer_version != metadata.adapter_version
        {
            return Err("adapter output is not bound to request and advertised semantics".into());
        }
        for construct in &result.constructs {
            let start = usize::try_from(construct.source.start_byte)
                .map_err(|_| "audit offset overflow")?;
            let end =
                usize::try_from(construct.source.end_byte).map_err(|_| "audit offset overflow")?;
            if construct.syntax.is_empty()
                || &construct.source.document != document_id
                || start >= end
                || end > request.source.len()
                || !request.source.is_char_boundary(start)
                || !request.source.is_char_boundary(end)
            {
                return Err("invalid construct audit provenance".into());
            }
        }
        Ok(result)
    }
}

#[derive(Clone, Copy)]
pub enum Profile {
    Java,
    TypeScript,
    JavaScript,
}
pub struct TreeAdapter {
    pub metadata: Metadata,
    pub grammar: fn() -> Language,
    pub declarations: &'static [&'static str],
    pub profile: Profile,
}

fn span(n: Node<'_>) -> Span {
    Span {
        document: "source".into(),
        start_byte: n.start_byte() as u64,
        end_byte: n.end_byte() as u64,
    }
}
fn whole(source: &str) -> Span {
    Span {
        document: "source".into(),
        start_byte: 0,
        end_byte: source.len() as u64,
    }
}
fn raw<'a>(n: Node<'_>, source: &'a str) -> &'a str {
    &source[n.start_byte()..n.end_byte()]
}
fn children(n: Node<'_>) -> Vec<Node<'_>> {
    let mut cursor = n.walk();
    n.named_children(&mut cursor).collect()
}
fn opaque_type(reason: &str) -> Type {
    Type::Opaque {
        reason: reason.into(),
    }
}

impl LanguageAdapter for TreeAdapter {
    fn metadata(&self) -> Metadata {
        self.metadata
    }
    fn lower(&self, request: &Request) -> Result<Lowered, String> {
        if request.source.is_empty() {
            return Err("empty source has no semantic span; exclude explicitly at host".into());
        }
        let mut parser = Parser::new();
        let language = if matches!(self.profile, Profile::TypeScript)
            && request.path.to_ascii_lowercase().ends_with(".tsx")
        {
            tree_sitter_typescript::LANGUAGE_TSX.into()
        } else {
            (self.grammar)()
        };
        parser.set_language(&language).map_err(|e| e.to_string())?;
        let tree = parser
            .parse(&request.source, None)
            .ok_or("source parser did not return a tree")?;
        let root = tree.root_node();
        let mut gaps=vec![Gap {source:whole(&request.source),reason:"module initialization, imports, class initialization and ambient bindings are outside this adapter's semantic scope".into()}];
        if root.has_error() {
            gaps.push(Gap {
                source: whole(&request.source),
                reason: "syntax errors: recovered declarations are opaque".into(),
            });
        }
        let mut functions = BTreeMap::new();
        let mut represented = BTreeSet::new();
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            if self.declarations.contains(&node.kind()) {
                let id = FunctionId(format!(
                    "{}@{}:{}",
                    request.path,
                    node.start_byte(),
                    node.kind()
                ));
                let (f, covered, reason) = self.function(node, &request.source, root.has_error());
                if let Some(reason) = reason {
                    gaps.push(Gap {
                        source: span(node),
                        reason,
                    });
                }
                represented.extend(covered);
                functions.insert(id, f);
            }
            let mut cs = children(node);
            cs.reverse();
            stack.extend(cs);
        }
        let mut constructs = vec![];
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            // Missing recovery nodes may have zero length; the containing syntax gap accounts for them.
            if node.start_byte() < node.end_byte() {
                constructs.push(Construct {
                    syntax: node.kind().into(),
                    source: span(node),
                    disposition: if represented.contains(&(
                        node.start_byte(),
                        node.end_byte(),
                        node.kind().to_owned(),
                    )) {
                        Disposition::Represented
                    } else {
                        Disposition::Opaque
                    },
                });
            }
            let mut cs = children(node);
            cs.reverse();
            stack.extend(cs);
        }
        let snapshot = Snapshot {
            schema: SCHEMA.into(),
            revision: request.revision.clone(),
            producer_version: self.metadata.adapter_version.into(),
            environment_digest: request.environment_digest.clone(),
            documents: BTreeMap::from([(
                "source".into(),
                Document {
                    path: request.path.clone(),
                    sha256: source_digest(request.source.as_bytes()),
                    language: self.metadata.id.into(),
                    lowering_version: self.metadata.adapter_version.into(),
                    semantics_version: self.metadata.semantics.into(),
                    gaps,
                },
            )]),
            functions,
        };
        Ok(Lowered {
            snapshot,
            sources: BTreeMap::from([("source".into(), request.source.as_bytes().to_vec())]),
            constructs,
        })
    }
}

type Covered = BTreeSet<(usize, usize, String)>;
impl TreeAdapter {
    fn function(
        &self,
        node: Node<'_>,
        source: &str,
        syntax_error: bool,
    ) -> (Function, Covered, Option<String>) {
        let mut values = BTreeMap::new();
        let mut parameters = vec![];
        let parameter_node = node
            .child_by_field_name("parameters")
            .or_else(|| node.child_by_field_name("parameter"));
        if let Some(params) = parameter_node {
            let nodes = if params.kind() == "identifier" {
                vec![params]
            } else {
                children(params)
            };
            for (i, p) in nodes.iter().enumerate() {
                let id = ValueId(format!("parameter:{i}"));
                let ty = p
                    .child_by_field_name("type")
                    .and_then(|n| type_name(raw(n, source)))
                    .unwrap_or_else(|| opaque_type("parameter type/binding not established"));
                values.insert(id.clone(), ty);
                parameters.push(id);
            }
        }
        let owner = span(node);
        let body = node.child_by_field_name("body");
        let declared_return = node
            .child_by_field_name("return_type")
            .or_else(|| node.child_by_field_name("type"));
        let expected = declared_return.and_then(|n| type_name(raw(n, source)));
        let annotation_supported = declared_return.is_none() || expected.is_some();
        let parameter_bindings_supported = parameter_node.is_none_or(|p| {
            !raw(p, source).contains('=')
                && !raw(p, source).contains("...")
                && !raw(p, source).contains('{')
                && !raw(p, source).contains('[')
        });
        let mut f = Function {
            source: owner.clone(),
            parameters,
            return_type: expected
                .clone()
                .unwrap_or_else(|| opaque_type("return type not established")),
            values,
            entry: "entry".into(),
            blocks: BTreeMap::new(),
        };
        let covered = Covered::new();
        // async/generator/getter/setter/native/decorated methods have additional semantics.
        // Only plain function declarations, Java methods without modifiers other than access/static,
        // and plain arrows can use the literal subset.
        let prefix = body
            .map(|b| &source[node.start_byte()..b.start_byte()])
            .unwrap_or("");
        let modifiers_supported = !prefix.split(|c: char| !c.is_alphanumeric()).any(|word| {
            matches!(
                word,
                "async" | "synchronized" | "native" | "abstract" | "get" | "set" | "constructor"
            )
        }) && !node.kind().contains("generator")
            && !prefix.contains('@')
            && !prefix.contains('*');
        if !syntax_error
            && modifiers_supported
            && annotation_supported
            && parameter_bindings_supported
        {
            if let Some(body) = body {
                if let Some((function, covered)) =
                    self.straight_line(node, body, source, &f, expected.as_ref())
                {
                    let assumption = if matches!(self.profile, Profile::TypeScript)
                        && !function.parameters.is_empty()
                    {
                        Some("TypeScript parameter annotations are model assumptions; runtime argument types are not validated".into())
                    } else if function
                        .values
                        .values()
                        .any(|ty| matches!(ty, Type::Opaque { .. }))
                    {
                        Some("unknown value types retained; only supported value-preserving operations modeled".into())
                    } else {
                        None
                    };
                    return (function, covered, assumption);
                }
            }
        }

        let reason =
            "function body/bindings outside straight-line expression subset; no absence of effects inferred"
                .to_owned();
        f.blocks.insert(
            "entry".into(),
            Block {
                source: owner,
                instructions: vec![],
                terminator: Terminator::Opaque {
                    reason: reason.clone(),
                    inputs: f.parameters.clone(),
                    successors: BTreeSet::new(),
                },
            },
        );
        (f, covered, Some(reason))
    }

    fn literal(&self, text: &str, expected: Option<&Type>) -> Option<(Literal, Type)> {
        let text = text.trim();
        if matches!(text, "true" | "false") {
            return Some((
                Literal::Bool {
                    value: text == "true",
                },
                Type::Bool,
            ));
        }
        if text.starts_with('"') {
            if matches!(self.profile, Profile::Java) && text.contains('\\') {
                return None;
            }
            return serde_json::from_str::<String>(text)
                .ok()
                .map(|value| (Literal::Utf8 { value }, Type::String));
        }
        if matches!(self.profile, Profile::Java) {
            let decimal = text.strip_suffix(['L', 'l']).unwrap_or(text);
            if !decimal
                .strip_prefix('-')
                .unwrap_or(decimal)
                .bytes()
                .all(|c| c.is_ascii_digit())
            {
                return None;
            }
            let digits = decimal.strip_prefix('-').unwrap_or(decimal);
            if digits.len() > 1 && digits.starts_with('0') {
                return None;
            }
            let value = decimal.parse::<i128>().ok()?;
            let ty = expected
                .filter(|t| matches!(t, Type::Integer { .. }))
                .cloned()?;
            if let Type::Integer {
                bits: Some(bits),
                signed: true,
            } = &ty
            {
                if *bits < 128 && (value < -(1i128 << (bits - 1)) || value >= (1i128 << (bits - 1)))
                {
                    return None;
                }
            }
            // A long-suffixed literal cannot be implicitly narrowed to int.
            if text.ends_with(['l', 'L'])
                && ty
                    != (Type::Integer {
                        bits: Some(64),
                        signed: true,
                    })
            {
                return None;
            }
            // Unsuffixed Java decimal integer literals must fit int (negative minimum allowed).
            if !text.ends_with(['l', 'L']) && i32::try_from(value).is_err() {
                return None;
            }
            return Some((
                Literal::Integer {
                    decimal: value.to_string(),
                },
                ty,
            ));
        }
        if let Some(decimal) = text.strip_suffix('n') {
            let digits = decimal.strip_prefix('-').unwrap_or(decimal);
            if digits.is_empty()
                || !digits.bytes().all(|c| c.is_ascii_digit())
                || (digits.len() > 1 && digits.starts_with('0'))
            {
                return None;
            }
            return Some((
                Literal::Integer {
                    decimal: if decimal == "-0" {
                        "0".into()
                    } else {
                        decimal.into()
                    },
                },
                Type::Integer {
                    bits: None,
                    signed: true,
                },
            ));
        }
        // Only decimal syntax in this first subset; parser validates syntax, finite f64 is encoded exactly.
        if text.is_empty()
            || !text
                .bytes()
                .all(|c| c.is_ascii_digit() || b".-+eE".contains(&c))
        {
            return None;
        }
        let digits = text.strip_prefix(['-', '+']).unwrap_or(text);
        if digits.len() > 1 && digits.starts_with('0') && digits.as_bytes()[1].is_ascii_digit() {
            return None;
        }
        let value = text.parse::<f64>().ok()?;
        if !value.is_finite() {
            return None;
        }
        Some((
            Literal::FloatBits {
                hex: format!("{:016x}", value.to_bits()),
            },
            Type::Float {
                format: FloatFormat::Binary64,
            },
        ))
    }
}

fn type_name(name: &str) -> Option<Type> {
    Some(match name.trim().trim_start_matches(':').trim() {
        "void" => Type::Unit,
        "boolean" => Type::Bool,
        "String" | "string" => Type::String,
        "byte" => Type::Integer {
            bits: Some(8),
            signed: true,
        },
        "short" => Type::Integer {
            bits: Some(16),
            signed: true,
        },
        "int" => Type::Integer {
            bits: Some(32),
            signed: true,
        },
        "long" => Type::Integer {
            bits: Some(64),
            signed: true,
        },
        "number" => Type::Float {
            format: FloatFormat::Binary64,
        },
        "bigint" => Type::Integer {
            bits: None,
            signed: true,
        },
        _ => return None,
    })
}
