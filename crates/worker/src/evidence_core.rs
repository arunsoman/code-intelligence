//! Additive static provenance. Never certifies runtime behavior or closed-world absence.
use crate::producer_registry::{DOMAIN, PRODUCER_ID, PRODUCER_VERSION};
use crate::{canon, model::AnalysisBatch};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
pub const SCHEMA: &str = "cie.evidence-core.batch.v1";
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceCoreBatchV1 {
    pub schema: String,
    pub producer_runs: Vec<ProducerRunV1>,
    pub links: Vec<EvidenceLinkV1>,
    pub coverage: Vec<CoverageRecordV1>,
}
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProducerRunV1 {
    pub id: String,
    pub producer_id: String,
    pub producer_version: String,
    pub analyzer_version: String,
    pub revision: String,
    pub scope: Scope,
    pub status: String,
    pub input_digest: String,
    pub output_digest: String,
}
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Scope {
    FILE { file: String },
    REPOSITORY,
}
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceLinkV1 {
    pub subject_kind: String,
    pub subject_id: String,
    pub evidence_id: String,
    pub producer_run_id: String,
    pub role: String,
}
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoverageRecordV1 {
    pub id: String,
    pub producer_run_id: String,
    pub revision: String,
    pub domain: String,
    pub scope: Scope,
    pub status: String,
    pub exclusions: Vec<String>,
    pub unresolved: Vec<String>,
}

pub fn enabled() -> Result<bool, String> {
    match std::env::var("CIE_EVIDENCE_CORE_MODE")
        .as_deref()
        .unwrap_or("off")
    {
        "off" => Ok(false),
        "shadow" | "on" => Ok(true),
        _ => Err("invalid CIE_EVIDENCE_CORE_MODE".into()),
    }
}
pub fn identity(kind: &str, value: &Value) -> String {
    let parsed = canon::parse_strict_json(&serde_json::to_vec(value).unwrap()).unwrap();
    let text = canon::canonicalize(&parsed).unwrap();
    let name = format!("cie.evidence-core.{kind}");
    format!("{name}@1:{}", canon::canon_digest(&name, "1", &text))
}
/// Reject incompatible IDs before the legacy deduper can silently retain the first row.
pub fn validate(batch: &AnalysisBatch) -> Result<(), String> {
    fn unique(rows: Vec<(String, Value)>) -> Result<(), String> {
        let mut seen = HashMap::new();
        for (id, value) in rows {
            match seen.entry(id) {
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(value);
                }
                std::collections::hash_map::Entry::Occupied(entry) if entry.get() != &value => {
                    return Err("EVIDENCE_CORE_ID_COLLISION".into())
                }
                _ => {}
            }
        }
        Ok(())
    }
    unique(
        batch
            .entities
            .iter()
            .map(|e| (e.entity_id.clone(), serde_json::to_value(e).unwrap()))
            .collect(),
    )?;
    let rows = batch
        .facts
        .iter()
        .map(|f| {
            (
                f.id.clone(),
                json!([f.subject, f.predicate, f.object, f.resolution]),
            )
        })
        .chain(batch.relationships.iter().map(|r| {
            (
                r.id.clone(),
                json!([r.from, r.to, r.kind, r.resolution, r.label]),
            )
        }))
        .collect();
    unique(rows)?;
    let evs: Vec<_> = batch
        .facts
        .iter()
        .flat_map(|f| &f.evidence)
        .chain(batch.relationships.iter().flat_map(|r| &r.evidence))
        .collect();
    unique(
        evs.iter()
            .map(|e| (e.id.clone(), serde_json::to_value(e).unwrap()))
            .collect(),
    )?;
    let root = std::path::Path::new(&batch.repo_root);
    let mut files = HashMap::new();
    for e in batch.entities.iter().filter(|e| e.kind == "file") {
        if let Some(span) = e.spans.first() {
            let path = root
                .join(&e.file)
                .canonicalize()
                .map_err(|_| "EVIDENCE_CORE_MISSING_SOURCE")?;
            if !path.starts_with(root) {
                return Err("EVIDENCE_CORE_BAD_SPAN".into());
            }
            let len = std::fs::metadata(path)
                .map_err(|_| "EVIDENCE_CORE_MISSING_SOURCE")?
                .len();
            files.insert(
                e.file.as_str(),
                (span.content_hash.as_str(), span.revision.as_str(), len),
            );
        }
    }
    for e in evs {
        if e.location["kind"] == "CodeLocation" {
            let s = &e.location["span"];
            let source = s["sourceId"].as_str().ok_or("EVIDENCE_CORE_BAD_SPAN")?;
            let start = s["startByte"].as_u64().ok_or("EVIDENCE_CORE_BAD_SPAN")?;
            let end = s["endByteExclusive"]
                .as_u64()
                .ok_or("EVIDENCE_CORE_BAD_SPAN")?;
            if source != e.source_id
                || source.starts_with('/')
                || source.split('/').any(|x| x == "..")
                || start > end
                || files.get(source).map(|f| (Some(f.0), Some(f.1)))
                    != Some((s["contentHash"].as_str(), s["revision"].as_str()))
            {
                return Err("EVIDENCE_CORE_BAD_SPAN".into());
            }
            if end > files.get(source).unwrap().2 {
                return Err("EVIDENCE_CORE_BAD_SPAN".into());
            }
        }
    }
    Ok(())
}
pub fn emit(batch: &AnalysisBatch) -> Result<EvidenceCoreBatchV1, String> {
    let links: usize = batch
        .facts
        .iter()
        .map(|f| f.evidence.len())
        .chain(batch.relationships.iter().map(|r| r.evidence.len()))
        .sum();
    if links > 100_000 || batch.entities.iter().filter(|e| e.kind == "file").count() > 100_000 {
        return Err("EVIDENCE_CORE_LIMIT: sidecar row cap exceeded".into());
    }
    let owners: HashMap<_, _> = batch
        .entities
        .iter()
        .map(|e| (e.entity_id.as_str(), e.file.as_str()))
        .collect();
    let inputs: HashMap<_, _> = batch
        .entities
        .iter()
        .filter(|e| e.kind == "file")
        .filter_map(|e| {
            e.spans
                .first()
                .map(|s| (e.file.as_str(), s.content_hash.as_str()))
        })
        .collect();
    let fallback_input = identity("input", &json!(batch.manifest));
    let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for e in batch.entities.iter().filter(|e| e.kind == "file") {
        groups.entry(e.file.clone()).or_default();
    }
    for (kind, id, owner, evidence) in batch
        .facts
        .iter()
        .map(|f| ("FACT", &f.id, &f.subject, &f.evidence))
        .chain(
            batch
                .relationships
                .iter()
                .map(|r| ("RELATIONSHIP", &r.id, &r.from, &r.evidence)),
        )
    {
        let file = owners.get(owner.as_str()).copied().unwrap_or("");
        for e in evidence {
            groups.entry(file.into()).or_default().push(
                json!({"subjectKind":kind,"subjectId":id,"evidenceId":e.id,"role":"SUPPORTS"}),
            );
        }
    }
    if batch.manifest.contains_key("")
        && (batch.mode != "delta" || batch.changed_files.iter().any(|f| f.is_empty()))
    {
        groups.entry(String::new()).or_default();
    }
    let mut runs = vec![];
    let mut links = vec![];
    let mut coverage = vec![];
    for (file, mut associations) in groups {
        associations.sort_by_cached_key(|v| {
            canon::canonicalize(&canon::parse_strict_json(&serde_json::to_vec(v).unwrap()).unwrap())
                .unwrap()
        });
        associations.dedup();
        let scope = if file.is_empty() {
            json!({"kind":"REPOSITORY"})
        } else {
            json!({"kind":"FILE","file":file})
        };
        let input = inputs
            .get(file.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| fallback_input.clone());
        let output = identity("output", &json!([batch.manifest.get(&file), associations]));
        let run = identity(
            "run",
            &json!([
                PRODUCER_ID,
                PRODUCER_VERSION,
                batch.analyzer_version,
                scope,
                input,
                output
            ]),
        );
        runs.push(json!({"id":run,"producerId":PRODUCER_ID,"producerVersion":PRODUCER_VERSION,"analyzerVersion":batch.analyzer_version,"revision":batch.revision,"scope":scope,"status":"PARTIAL","inputDigest":input,"outputDigest":output}));
        for mut link in associations {
            link["producerRunId"] = json!(run);
            links.push(link);
        }
        coverage.push(json!({"id":identity("coverage", &json!([run,DOMAIN])),"producerRunId":run,"revision":batch.revision,"domain":DOMAIN,"scope":scope,"status":"PARTIAL","exclusions":["reflection","dynamic dispatch","external dependencies","async delivery","generated or excluded sources"],"unresolved":["No closed-world completeness claim; parser diagnostics remain authoritative"]}));
    }
    serde_json::from_value(
        json!({"schema":SCHEMA,"producerRuns":runs,"links":links,"coverage":coverage}),
    )
    .map_err(|_| "EVIDENCE_CORE_SERIALIZATION".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_identity_is_order_independent() {
        assert_eq!(
            identity("fixture", &json!({"b":2,"a":1})),
            identity("fixture", &json!({"a":1,"b":2}))
        );
    }
    #[test]
    fn empty_scope_never_certifies_absence() {
        let b = AnalysisBatch::default();
        let v = emit(&b).unwrap();
        assert_eq!(v.schema, SCHEMA);
        assert!(v.coverage.is_empty());
    }
    #[test]
    fn duplicate_fact_conflicts_are_rejected() {
        let mut b = AnalysisBatch::default();
        let f = crate::model::Fact {
            id: "same".into(),
            subject: "entity".into(),
            predicate: "a".into(),
            object: json!({"kind":"literal"}),
            evidence: vec![],
            resolution: "RESOLVED",
        };
        b.facts.push(f.clone());
        let mut other = f;
        other.predicate = "b".into();
        b.facts.push(other);
        assert_eq!(validate(&b).unwrap_err(), "EVIDENCE_CORE_ID_COLLISION");
    }
}
#[cfg(test)]
mod parity {
    #[test]
    fn shared_canonical_vectors() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/evidence-core/identities.json"
        ))
        .unwrap();
        for v in vectors.as_array().unwrap() {
            assert_eq!(
                super::identity(v["kind"].as_str().unwrap(), &v["payload"]),
                v["id"].as_str().unwrap()
            );
        }
    }
}
