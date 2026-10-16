//! Wire DTOs; field names follow contracts §2.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpan {
    pub source_id: String,
    pub content_hash: String,
    pub revision: String,
    pub start_byte: usize,
    pub end_byte_exclusive: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRef {
    pub id: String,
    pub source_id: String,
    pub location: serde_json::Value,
    pub class: &'static str,
    pub observed_at: String,
    pub access_scope_id: String,
    pub state: &'static str,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub entity_id: String,
    pub kind: String,
    pub name: String,
    pub file: String,
    pub spans: Vec<SourceSpan>,
    /// Hash of this symbol's own source text, so "did this symbol change?" is exact rather than file-granular.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_hash: Option<String>,
    /// Hash of this symbol's AST shape (grammar node kinds only, no identifier/literal text) — see shape.rs.
    /// Two entities sharing a shape_hash are structurally identical regardless of naming.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape_hash: Option<String>,
    /// Hash of this symbol's semantic IR (ir.rs): local identifiers blanked, external names and
    /// control-flow idioms kept. Stable across a rename that also renames locals — the input C08's
    /// identity matching needed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ir_hash: Option<String>,
    /// Serialized IR tree (ir.rs), persisted by default since it is the inspection surface for the
    /// semantic IR; `CIE_IR_DUMP=0` trades the bytes away for artifact size.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ir_dump: Option<String>,
    /// Deterministic structural embedding of the IR (ir.rs `ir_vec`): sparse (dim, value×100)
    /// pairs flattened to `[d0, v0, d1, v1, …]`. Cosine over these is a zero-model structural
    /// similarity between any two symbols — exact-match is `irHash`, this is approximate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ir_vec: Option<Vec<i16>>,
}

/// A group of entities the worker found structurally identical (same kind, same shape_hash) across at least two
/// files — the zero-LLM, zero-text-comparison signal for "these are the same concept declared more than once"
/// (e.g. the same enum shape redeclared in several generated API clients). Content-addressed by its sorted member
/// ids, so an unchanged cluster gets the same `cluster_id` on every re-index.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConceptClusterRaw {
    pub cluster_id: String,
    pub kind: String,
    pub member_entity_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heuristic_name: Option<String>,
    /// Per-pair evidence for `near-duplicate` clusters: the two members, their IR shingle similarity
    /// and a short structural-diff summary. Absent for exact-shape and framework-role clusters.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pairs: Vec<ConceptPairRaw>,
}

/// One member pair of a near-duplicate cluster (ir.rs's `compare`): similarity in 0..1 (thousandths)
/// and the diff summary text shown as the pair's evidence.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConceptPairRaw {
    pub a: String,
    pub b: String,
    pub similarity: f64,
    pub diff: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub evidence: Vec<EvidenceRef>,
    pub resolution: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub id: String,
    pub subject: String,
    pub predicate: String,
    pub object: serde_json::Value,
    pub evidence: Vec<EvidenceRef>,
    pub resolution: &'static str,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub related_entity_ids: Vec<String>,
    pub retryable: bool,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisBatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_core: Option<crate::evidence_core::EvidenceCoreBatchV1>,
    pub revision: String,
    pub git_head: Option<String>,
    pub repo_root: String,
    pub entities: Vec<Entity>,
    pub facts: Vec<Fact>,
    pub relationships: Vec<Relationship>,
    pub diagnostics: Vec<Diagnostic>,
    pub analyzer_version: String,
    /// "full": every row. "delta": only the rows of `changedFiles`; the rest equal the base revision's rows. "unchanged": the worktree hashes to the base revision.
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<String>,
    /// Digest of everything emitted for each file (its entities, the facts about them, the relationships from them), with the revision id left out.
    pub manifest: std::collections::BTreeMap<String, String>,
    pub changed_files: Vec<String>,
    pub removed_files: Vec<String>,
    /// Zero-LLM concept clusters found this pass (index.rs's `cluster_concepts`) — only computed on a full index,
    /// empty on a delta/unchanged batch; the caller re-derives clusters from the full entity set when it needs them.
    pub concept_clusters: Vec<ConceptClusterRaw>,
}

/// The revision the caller already holds, and what it holds of it, so only what differs needs to be sent back.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BaseRef {
    #[serde(default)]
    pub evidence_core_version: Option<String>,
    pub revision: String,
    pub analyzer_version: String,
    pub digests: HashMap<String, String>,
}

/// The caller's previous revision, per file: content hashes (which files existed and what their
/// bytes hashed to). Relative paths arrive already normalized; the worker matches on content only.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    #[allow(dead_code)]
    pub files: HashMap<String, String>,
    /// Which revision the hashes are from (for diagnostics and audit). Not used for dedupe:
    /// the worker matches on content only.
    #[allow(dead_code)]
    pub revision: String,
}
