//! Versioned projection: retain legacy observations and disambiguate known emitter collisions.
use crate::model::AnalysisBatch;
pub fn normalize(batch: &mut AnalysisBatch) -> Result<(), String> {
    // These legacy emitters keyed distinct observations only by a shared start byte.
    // Preserve the first record. Existing call/defect suffixes stay v2; nested reads use v3.
    // Other conflicting IDs remain hard errors; do not repair arbitrary collisions.
    let mut seen = std::collections::HashMap::new();
    for fact in &mut batch.facts {
        let nested_read = fact.id.starts_with("fact:reads:") && fact.predicate == "reads";
        if !fact.id.starts_with("fact:unresolved-call:")
            && !fact.id.starts_with("fact:defect:")
            && !nested_read
        {
            continue;
        }
        let payload = serde_json::to_vec(&serde_json::json!([
            fact.subject,
            fact.predicate,
            fact.object,
            fact.resolution
        ]))
        .unwrap();
        if seen.get(&fact.id).is_some_and(|old| old != &payload) {
            fact.id = format!(
                "{}:observation-{}:{}",
                fact.id,
                if nested_read { "v3" } else { "v2" },
                crate::canon::raw_hash(&payload)
            );
        }
        seen.entry(fact.id.clone()).or_insert(payload);
    }
    crate::evidence_core::validate(batch)?;
    let mut ids = std::collections::HashSet::new();
    batch.entities.retain(|e| ids.insert(e.entity_id.clone()));
    crate::index::merge_duplicate_rows(batch);
    for evidence in batch
        .facts
        .iter_mut()
        .map(|f| &mut f.evidence)
        .chain(batch.relationships.iter_mut().map(|r| &mut r.evidence))
    {
        evidence.sort_by(|a, b| a.id.cmp(&b.id));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EvidenceRef, Fact};
    use serde_json::json;
    fn ev(id: &str) -> EvidenceRef {
        EvidenceRef {
            id: id.into(),
            source_id: "synthetic".into(),
            location: json!({"kind":"History"}),
            class: "HISTORY",
            observed_at: "epoch".into(),
            access_scope_id: "local".into(),
            state: "CURRENT",
        }
    }
    #[test]
    fn evidence_union_is_order_independent_and_id_preserving() {
        let f = Fact {
            id: "fact-id".into(),
            subject: "subject".into(),
            predicate: "p".into(),
            object: json!({"kind":"literal"}),
            resolution: "PARSED",
            evidence: vec![ev("b")],
        };
        let mut other = f.clone();
        other.evidence = vec![ev("a")];
        let mut a = AnalysisBatch::default();
        a.facts = vec![f.clone(), other.clone()];
        let mut b = AnalysisBatch::default();
        b.facts = vec![other, f];
        normalize(&mut a).unwrap();
        normalize(&mut b).unwrap();
        assert_eq!(
            serde_json::to_value(&a.facts).unwrap(),
            serde_json::to_value(&b.facts).unwrap()
        );
        assert_eq!(a.facts[0].id, "fact-id");
    }
    #[test]
    fn arbitrary_fact_collision_is_not_repaired() {
        let mut batch = AnalysisBatch::default();
        let fact = Fact {
            id: "fact:other:collision".into(),
            subject: "s".into(),
            predicate: "p".into(),
            object: json!({"value":1}),
            resolution: "PARSED",
            evidence: vec![],
        };
        let mut other = fact.clone();
        other.object = json!({"value":2});
        batch.facts = vec![fact, other];
        assert!(
            normalize(&mut batch)
                .unwrap_err()
                .starts_with("EVIDENCE_CORE_ID_COLLISION")
        );
    }
    #[test]
    fn incompatible_evidence_ids_fail_before_deduplication() {
        let mut a = AnalysisBatch::default();
        let mut second = ev("same");
        second.source_id = "other".into();
        a.facts.push(Fact {
            id: "f".into(),
            subject: "s".into(),
            predicate: "p".into(),
            object: json!({}),
            resolution: "PARSED",
            evidence: vec![ev("same"), second],
        });
        assert!(normalize(&mut a).unwrap_err().contains("ID_COLLISION"));
    }
}
