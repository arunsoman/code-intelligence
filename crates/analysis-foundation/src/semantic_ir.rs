//! Semantic IR wire boundary, separate from the unordered P01 effect inventory.
//! Validation establishes referential/type/source consistency, not faithful lowering,
//! reachability, SSA dominance, business meaning or external execution success.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const SCHEMA: &str = "cie.semantic-ir.v1";

macro_rules! identity {
    ($($name:ident),*) => {$(
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);
        impl From<&str> for $name { fn from(s: &str) -> Self { Self(s.into()) } }
    )*};
}
identity!(
    DocumentId,
    FunctionId,
    BlockId,
    InstructionId,
    ValueId,
    ResourceId
);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub schema: String,
    pub revision: String,
    pub producer_version: String,
    pub environment_digest: String,
    #[serde(deserialize_with = "unique_map")]
    pub documents: BTreeMap<DocumentId, Document>,
    #[serde(deserialize_with = "unique_map")]
    pub functions: BTreeMap<FunctionId, Function>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    /// Unique repository-relative path; source bytes are provided by the host, not read here.
    pub path: String,
    pub sha256: String,
    pub language: String,
    pub lowering_version: String,
    pub semantics_version: String,
    pub gaps: Vec<Gap>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Span {
    pub document: DocumentId,
    pub start_byte: u64,
    pub end_byte: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Gap {
    pub source: Span,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Function {
    pub source: Span,
    pub parameters: Vec<ValueId>,
    pub return_type: Type,
    #[serde(deserialize_with = "unique_map")]
    pub values: BTreeMap<ValueId, Type>,
    pub entry: BlockId,
    #[serde(deserialize_with = "unique_map")]
    pub blocks: BTreeMap<BlockId, Block>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Block {
    /// Execution order is significant. Map key order is not.
    pub instructions: Vec<Instruction>,
    pub terminator: Terminator,
    pub source: Span,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Type {
    Unit,
    Bool,
    String,
    Bytes,
    /// None denotes unbounded integers; fixed widths: 8/16/32/64/128.
    Integer {
        bits: Option<u16>,
        signed: bool,
    },
    Float {
        format: FloatFormat,
    },
    Decimal {
        precision: u16,
        scale: u16,
    },
    Reference {
        model: String,
    },
    Opaque {
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FloatFormat {
    Binary32,
    Binary64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Literal {
    Unit,
    Bool {
        value: bool,
    },
    Utf8 {
        value: String,
    },
    Bytes {
        hex: String,
    },
    /// Canonical decimal string, avoiding JSON/JavaScript integer precision loss.
    Integer {
        decimal: String,
    },
    /// IEEE bit pattern preserves NaN payloads and signed zero exactly.
    FloatBits {
        hex: String,
    },
    Decimal {
        unscaled: String,
        scale: u16,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Instruction {
    /// Exception continuation for this operation; None asserts no modeled exceptional exit.
    pub exceptional: Option<ExceptionalExit>,
    pub id: InstructionId,
    pub source: Span,
    pub action: Action,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    Constant {
        result: ValueId,
        literal: Literal,
    },
    Copy {
        result: ValueId,
        operand: ValueId,
    },
    Unary {
        result: ValueId,
        operand: ValueId,
        operator: UnaryOp,
    },
    Binary {
        result: ValueId,
        left: ValueId,
        right: ValueId,
        operator: BinaryOp,
    },
    Read {
        result: ValueId,
        resource: ResourceId,
    },
    Write {
        resource: ResourceId,
        value: ValueId,
    },
    /// Explicit approximation boundary; no interpretation of spelling or names.
    Opaque {
        reason: String,
        inputs: Vec<ValueId>,
        outputs: Vec<ValueId>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnaryOp {
    Not,
    Negate,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BinaryOp {
    Add,
    Subtract,
    Multiply,
    Divide,
    Remainder,
    Equal,
    LessThan,
    And,
    Or,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallSite {
    pub arguments: Vec<ValueId>,
    pub binding: Binding,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Binding {
    /// Candidate set, not proof of which target executes. All signatures must match.
    Resolved {
        targets: BTreeSet<FunctionId>,
        evidence: Span,
    },
    Unresolved {
        reason: String,
        evidence: Span,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExceptionalExit {
    Propagate,
    Block { target: BlockId },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Terminator {
    Goto {
        target: BlockId,
    },
    Branch {
        condition: ValueId,
        then_block: BlockId,
        else_block: BlockId,
    },
    Return {
        value: Option<ValueId>,
    },
    Raise {
        value: Option<ValueId>,
    },
    /// Calls always have an explicit normal and exceptional continuation.
    Invoke {
        result: Option<ValueId>,
        call: CallSite,
        normal: BlockId,
        exceptional: ExceptionalExit,
    },
    Opaque {
        reason: String,
        inputs: Vec<ValueId>,
        successors: BTreeSet<BlockId>,
    },
}

pub type Sources = BTreeMap<DocumentId, Vec<u8>>;

/// A repeated JSON map key must not silently replace a declaration before validation.
fn unique_map<'de, D, K, V>(deserializer: D) -> Result<BTreeMap<K, V>, D::Error>
where
    D: serde::Deserializer<'de>,
    K: Deserialize<'de> + Ord,
    V: Deserialize<'de>,
{
    struct Visitor<K, V>(std::marker::PhantomData<(K, V)>);
    impl<'de, K: Deserialize<'de> + Ord, V: Deserialize<'de>> serde::de::Visitor<'de>
        for Visitor<K, V>
    {
        type Value = BTreeMap<K, V>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a map with unique identities")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut access: M,
        ) -> Result<Self::Value, M::Error> {
            let mut map = BTreeMap::new();
            while let Some((key, value)) = access.next_entry()? {
                if map.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom(
                        "duplicate semantic IR map identity",
                    ));
                }
            }
            Ok(map)
        }
    }
    deserializer.deserialize_map(Visitor(std::marker::PhantomData))
}

pub fn source_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn text(s: &str) -> Result<(), String> {
    if s.trim().is_empty() {
        Err("empty identity, version or reason".into())
    } else {
        Ok(())
    }
}
fn require(ok: bool, message: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn integer(s: &str) -> bool {
    let digits = s.strip_prefix('-').unwrap_or(s);
    !digits.is_empty()
        && digits.bytes().all(|c| c.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'))
        && s != "-0"
}
fn hex(s: &str) -> bool {
    s.len().is_multiple_of(2)
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn numeric(t: &Type) -> bool {
    matches!(
        t,
        Type::Integer { .. } | Type::Float { .. } | Type::Decimal { .. }
    )
}

fn validate_type(t: &Type) -> Result<(), String> {
    match t {
        Type::Integer { bits: Some(n), .. } => require(
            [8, 16, 32, 64, 128].contains(n),
            "unsupported integer width",
        ),
        Type::Decimal { precision, scale } => require(
            *precision > 0 && *scale <= *precision,
            "invalid decimal type",
        ),
        Type::Reference { model } => text(model),
        Type::Opaque { reason } => text(reason),
        _ => Ok(()),
    }
}
fn literal_matches(l: &Literal, t: &Type) -> bool {
    match (l, t) {
        (Literal::Unit, Type::Unit)
        | (Literal::Bool { .. }, Type::Bool)
        | (Literal::Utf8 { .. }, Type::String) => true,
        (Literal::Bytes { hex: h }, Type::Bytes) => hex(h),
        (Literal::FloatBits { hex: h }, Type::Float { format }) => {
            hex(h)
                && h.len()
                    == match format {
                        FloatFormat::Binary32 => 8,
                        FloatFormat::Binary64 => 16,
                    }
        }
        (
            Literal::Decimal { unscaled, scale },
            Type::Decimal {
                precision,
                scale: ts,
            },
        ) => {
            integer(unscaled)
                && scale == ts
                && unscaled.trim_start_matches('-').len() <= usize::from(*precision)
        }
        (Literal::Integer { decimal }, Type::Integer { bits, signed }) => {
            if !integer(decimal) || (!signed && decimal.starts_with('-')) {
                return false;
            }
            match (bits, signed) {
                (None, _) => true,
                (Some(n), true) => decimal.parse::<i128>().is_ok_and(|v| {
                    *n == 128 || (v >= -(1i128 << (n - 1)) && v < (1i128 << (n - 1)))
                }),
                (Some(n), false) => decimal
                    .parse::<u128>()
                    .is_ok_and(|v| *n == 128 || v < (1u128 << n)),
            }
        }
        _ => false,
    }
}

impl Snapshot {
    /// All source bytes must come from the host's checked revision/build snapshot.
    /// Matching hashes does not authenticate a repository or certify producer fidelity.
    pub fn validate(&self, sources: &Sources) -> Result<(), String> {
        require(
            self.schema == SCHEMA,
            "unsupported semantic IR schema; no implicit migration",
        )?;
        for version in [
            &self.revision,
            &self.producer_version,
            &self.environment_digest,
        ] {
            text(version)?;
        }
        require(
            self.documents.len() == sources.len(),
            "source/document set mismatch",
        )?;
        let mut paths = BTreeSet::new();
        for (id, doc) in &self.documents {
            text(&id.0)?;
            for s in [
                &doc.path,
                &doc.language,
                &doc.lowering_version,
                &doc.semantics_version,
            ] {
                text(s)?;
            }
            require(
                !doc.path.starts_with('/')
                    && !doc.path.contains('\\')
                    && !doc
                        .path
                        .split('/')
                        .any(|p| p == ".." || p == "." || p.is_empty()),
                "document path must be normalized repository-relative",
            )?;
            require(paths.insert(&doc.path), "duplicate document path")?;
            let bytes = sources.get(id).ok_or("missing source document")?;
            std::str::from_utf8(bytes).map_err(|_| "semantic IR v1 requires UTF-8 source")?;
            require(doc.sha256 == source_digest(bytes), "source digest mismatch")?;
            for gap in &doc.gaps {
                text(&gap.reason)?;
                self.span(&gap.source, sources)?;
                require(
                    &gap.source.document == id,
                    "coverage gap belongs to another document",
                )?;
            }
        }
        for (id, f) in &self.functions {
            text(&id.0)?;
            self.validate_function(f, sources)
                .map_err(|e| format!("function {}: {e}", id.0))?;
        }
        Ok(())
    }

    fn span(&self, s: &Span, sources: &Sources) -> Result<(), String> {
        let bytes = sources
            .get(&s.document)
            .ok_or("span references unknown document")?;
        require(
            self.documents.contains_key(&s.document),
            "span references undeclared document",
        )?;
        let start = usize::try_from(s.start_byte).map_err(|_| "span offset overflow")?;
        let end = usize::try_from(s.end_byte).map_err(|_| "span offset overflow")?;
        let source = std::str::from_utf8(bytes).map_err(|_| "invalid source UTF-8")?;
        require(
            start < end
                && end <= bytes.len()
                && source.is_char_boundary(start)
                && source.is_char_boundary(end),
            "invalid source byte span",
        )
    }

    fn contained(&self, child: &Span, parent: &Span, sources: &Sources) -> Result<(), String> {
        self.span(child, sources)?;
        require(
            child.document == parent.document
                && child.start_byte >= parent.start_byte
                && child.end_byte <= parent.end_byte,
            "source span outside owner",
        )
    }

    fn validate_function(&self, f: &Function, sources: &Sources) -> Result<(), String> {
        self.span(&f.source, sources)?;
        validate_type(&f.return_type)?;
        require(
            f.blocks.contains_key(&f.entry),
            "entry block does not exist",
        )?;
        for (v, t) in &f.values {
            text(&v.0)?;
            validate_type(t)?;
        }
        let ty = |v: &ValueId| {
            f.values
                .get(v)
                .ok_or_else(|| format!("unknown value {}", v.0))
        };
        let mut definitions = BTreeSet::new();
        let mut instructions = BTreeSet::new();
        for p in &f.parameters {
            ty(p)?;
            require(
                definitions.insert(p.clone()),
                "duplicate parameter definition",
            )?;
        }
        for (id, b) in &f.blocks {
            text(&id.0)?;
            self.contained(&b.source, &f.source, sources)?;
            for i in &b.instructions {
                text(&i.id.0)?;
                if let Some(ExceptionalExit::Block { target }) = &i.exceptional {
                    require(
                        f.blocks.contains_key(target),
                        "instruction exception target missing",
                    )?;
                }
                require(instructions.insert(&i.id), "duplicate instruction identity")?;
                self.contained(&i.source, &b.source, sources)?;
                let outputs = match &i.action {
                    Action::Constant { result, literal } => {
                        require(
                            literal_matches(literal, ty(result)?),
                            "constant/type mismatch or noncanonical literal",
                        )?;
                        vec![result]
                    }
                    Action::Copy { result, operand } => {
                        require(ty(result)? == ty(operand)?, "copy type mismatch")?;
                        vec![result]
                    }
                    Action::Unary {
                        result,
                        operand,
                        operator,
                    } => {
                        require(ty(result)? == ty(operand)?, "unary type mismatch")?;
                        require(
                            match operator {
                                UnaryOp::Not => ty(operand)? == &Type::Bool,
                                UnaryOp::Negate => numeric(ty(operand)?),
                            },
                            "invalid unary operand",
                        )?;
                        vec![result]
                    }
                    Action::Binary {
                        result,
                        left,
                        right,
                        operator,
                    } => {
                        let a = ty(left)?;
                        let b = ty(right)?;
                        let r = ty(result)?;
                        require(a == b, "binary operand type mismatch")?;
                        let valid = match operator {
                            BinaryOp::Equal => {
                                r == &Type::Bool && !matches!(a, Type::Opaque { .. })
                            }
                            BinaryOp::LessThan => r == &Type::Bool && numeric(a),
                            BinaryOp::And | BinaryOp::Or => a == &Type::Bool && r == &Type::Bool,
                            _ => numeric(a) && r == a,
                        };
                        require(valid, "invalid binary operator/result type")?;
                        vec![result]
                    }
                    Action::Read { result, resource } => {
                        text(&resource.0)?;
                        ty(result)?;
                        vec![result]
                    }
                    Action::Write { resource, value } => {
                        text(&resource.0)?;
                        ty(value)?;
                        vec![]
                    }
                    Action::Opaque {
                        reason,
                        inputs,
                        outputs,
                    } => {
                        text(reason)?;
                        for v in inputs {
                            ty(v)?;
                        }
                        for v in outputs {
                            ty(v)?;
                        }
                        outputs.iter().collect()
                    }
                };
                for out in outputs {
                    require(
                        definitions.insert(out.clone()),
                        "value has multiple definitions",
                    )?;
                }
            }
            let block = |id: &BlockId| {
                require(
                    f.blocks.contains_key(id),
                    "successor block does not exist in function",
                )
            };
            match &b.terminator {
                Terminator::Goto { target } => block(target)?,
                Terminator::Branch {
                    condition,
                    then_block,
                    else_block,
                } => {
                    require(ty(condition)? == &Type::Bool, "branch requires boolean")?;
                    block(then_block)?;
                    block(else_block)?;
                }
                Terminator::Return { value } => match value {
                    Some(v) => require(ty(v)? == &f.return_type, "return type mismatch")?,
                    None => require(
                        f.return_type == Type::Unit,
                        "non-unit function requires return value",
                    )?,
                },
                Terminator::Raise { value } => {
                    if let Some(v) = value {
                        ty(v)?;
                    }
                }
                Terminator::Invoke {
                    result,
                    call,
                    normal,
                    exceptional,
                } => {
                    block(normal)?;
                    if let ExceptionalExit::Block { target } = exceptional {
                        block(target)?;
                    }
                    for a in &call.arguments {
                        ty(a)?;
                    }
                    if let Some(v) = result {
                        ty(v)?;
                        require(definitions.insert(v.clone()), "invoke result defined twice")?;
                    }
                    match &call.binding {
                        Binding::Resolved { targets, evidence } => {
                            self.contained(evidence, &f.source, sources)?;
                            require(!targets.is_empty(), "resolved call requires targets")?;
                            for target in targets {
                                let callee = self
                                    .functions
                                    .get(target)
                                    .ok_or("missing call target; use unresolved binding")?;
                                require(
                                    callee.parameters.len() == call.arguments.len(),
                                    "call arity mismatch",
                                )?;
                                for (p, a) in callee.parameters.iter().zip(&call.arguments) {
                                    require(
                                        callee.values.get(p) == Some(ty(a)?),
                                        "call parameter type mismatch",
                                    )?;
                                }
                                if let Some(v) = result {
                                    require(
                                        ty(v)? == &callee.return_type,
                                        "call result type mismatch",
                                    )?;
                                }
                            }
                        }
                        Binding::Unresolved { reason, evidence } => {
                            text(reason)?;
                            self.contained(evidence, &f.source, sources)?;
                        }
                    }
                }
                Terminator::Opaque {
                    reason,
                    inputs,
                    successors,
                } => {
                    text(reason)?;
                    for v in inputs {
                        ty(v)?;
                    }
                    for s in successors {
                        block(s)?;
                    }
                }
            }
        }
        require(
            definitions.len() == f.values.len(),
            "declared value lacks definition",
        )?;
        Ok(())
    }

    /// Deterministic wire digest, NOT semantic equivalence. Includes revision/provenance.
    /// BTreeMap keys are sorted; instruction/parameter order is preserved.
    pub fn checked_digest(&self, sources: &Sources) -> Result<String, String> {
        self.validate(sources)?;
        serde_json::to_vec(self)
            .map(|bytes| source_digest(&bytes))
            .map_err(|e| e.to_string())
    }
}
