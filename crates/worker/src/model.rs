//! Wire DTOs; field names follow contracts §2.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpan {
    pub source_id: String,
    pub content_hash: String,
    pub revision: String,
    pub start_byte: usize,
    pub end_byte_exclusive: usize,
}

#[derive(Serialize, Clone, Debug)]
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

#[derive(Serialize, Clone, Debug)]
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
}

/// The revision the caller already holds, and what it holds of it, so only what differs needs to be sent back.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BaseRef {
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
