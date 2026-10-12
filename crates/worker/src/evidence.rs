//! re-evidence-v1 — the Rust half of the reverse-engineering evidence identity. The TypeScript half is
//! packages/evidence; the shared contract is fixtures/canon/re-evidence-vectors.json, read by both
//! `cargo test` and `node --test` (the same one-file pattern pf-canon-v1 uses). The projection here is
//! written from the rules documented in packages/evidence/src/identity.ts, not from its code:
//!   evidence id  = "ev_" + digest(cie.re-evidence@1, canonical(identity fields))
//!   unknown id   = "ru_" + digest(cie.re-unknown@1, canonical({question, revision}))
//!   bundle id    = full form "pf-canon-v1/cie.re-evidence-bundle@1:<hex>" over the members' identities
//! Identity fields: subject{path,sha256,format}, provider{id,name,version}, predicate, confidence,
//! authority, limitations (sorted + deduped by UTF-8 bytes), locations (given order preserved).
//! Custody (id, revision, state, observedAt) is never identity. A protocol change creates new
//! identities; it never relabels old ones.
use crate::canon::{self, Canon, CanonError, Code};

pub const EVIDENCE_SCHEMA: &str = "cie.re-evidence";
pub const UNKNOWN_SCHEMA: &str = "cie.re-unknown";
pub const BUNDLE_SCHEMA: &str = "cie.re-evidence-bundle";
pub const PROTOCOL_VERSION: &str = "1";

fn err<T>(code: Code, message: impl Into<String>) -> Result<T, CanonError> {
    Err(CanonError { code, message: message.into() })
}

fn as_obj<'a>(v: &'a Canon, what: &str) -> Result<&'a Vec<(String, Canon)>, CanonError> {
    match v {
        Canon::Obj(fields) => Ok(fields),
        _ => err(Code::BadSchema, format!("{what} must be an object")),
    }
}

fn as_arr<'a>(v: &'a Canon, what: &str) -> Result<&'a Vec<Canon>, CanonError> {
    match v {
        Canon::Arr(items) => Ok(items),
        _ => err(Code::BadSchema, format!("{what} must be an array")),
    }
}

fn field<'a>(obj: &'a [(String, Canon)], key: &str, what: &str) -> Result<&'a Canon, CanonError> {
    obj.iter().find(|(k, _)| k == key).map(|(_, v)| v).ok_or_else(|| CanonError {
        code: Code::BadSchema,
        message: format!("{what} is missing the field {key:?}"),
    })
}

fn as_str(v: &Canon, what: &str) -> Result<String, CanonError> {
    match v {
        Canon::Str(s) => Ok(s.clone()),
        _ => err(Code::BadSchema, format!("{what} must be a string")),
    }
}

fn as_str_array(v: &Canon, what: &str) -> Result<Vec<String>, CanonError> {
    as_arr(v, what)?.iter().map(|item| as_str(item, what)).collect()
}

/// Limitations are a set: sort by UTF-8 bytes, drop duplicates. Matches packages/evidence `sortedUnique`.
fn sorted_unique_strings(values: Vec<String>) -> Vec<String> {
    let mut sorted = values;
    sorted.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    sorted.dedup();
    sorted
}

/// One location: {kind, value, endValue?} — unknown keys are not carried into identity (the TypeScript
/// side rejects them at validation; both sides must simply never hash them).
fn location_canon(v: &Canon) -> Result<Canon, CanonError> {
    let obj = as_obj(v, "location")?;
    let kind = as_str(field(obj, "kind", "location")?, "location.kind")?;
    let value = as_str(field(obj, "value", "location")?, "location.value")?;
    let mut fields: Vec<(String, Canon)> = vec![("kind".into(), Canon::Str(kind)), ("value".into(), Canon::Str(value))];
    if let Ok(end) = field(obj, "endValue", "location") {
        fields.push(("endValue".into(), Canon::Str(as_str(end, "location.endValue")?)));
    }
    Ok(Canon::Obj(fields))
}

/// The identity projection of an evidence record: exactly the seven observed fields, nothing of custody.
pub fn evidence_identity(v: &Canon) -> Result<Canon, CanonError> {
    let obj = as_obj(v, "evidence")?;
    let subject = as_obj(field(obj, "subject", "evidence")?, "subject")?;
    let provider = as_obj(field(obj, "provider", "evidence")?, "provider")?;
    Ok(Canon::Obj(vec![
        (
            "authority".into(),
            Canon::Str(as_str(field(obj, "authority", "evidence")?, "evidence.authority")?),
        ),
        (
            "confidence".into(),
            Canon::Str(as_str(field(obj, "confidence", "evidence")?, "evidence.confidence")?),
        ),
        (
            "limitations".into(),
            Canon::Arr(
                sorted_unique_strings(as_str_array(field(obj, "limitations", "evidence")?, "evidence.limitations")?)
                    .into_iter()
                    .map(Canon::Str)
                    .collect(),
            ),
        ),
        (
            "locations".into(),
            Canon::Arr(
                as_arr(field(obj, "locations", "evidence")?, "evidence.locations")?
                    .iter()
                    .map(location_canon)
                    .collect::<Result<Vec<Canon>, CanonError>>()?,
            ),
        ),
        (
            "predicate".into(),
            Canon::Str(as_str(field(obj, "predicate", "evidence")?, "evidence.predicate")?),
        ),
        (
            "provider".into(),
            Canon::Obj(vec![
                ("id".into(), Canon::Str(as_str(field(provider, "id", "provider")?, "provider.id")?)),
                ("name".into(), Canon::Str(as_str(field(provider, "name", "provider")?, "provider.name")?)),
                ("version".into(), Canon::Str(as_str(field(provider, "version", "provider")?, "provider.version")?)),
            ]),
        ),
        (
            "subject".into(),
            Canon::Obj(vec![
                ("format".into(), Canon::Str(as_str(field(subject, "format", "subject")?, "subject.format")?)),
                ("path".into(), Canon::Str(as_str(field(subject, "path", "subject")?, "subject.path")?)),
                ("sha256".into(), Canon::Str(as_str(field(subject, "sha256", "subject")?, "subject.sha256")?)),
            ]),
        ),
    ]))
}

/// `ev_<hex>` — matches packages/evidence `evidenceId` byte for byte.
pub fn evidence_id(v: &Canon) -> Result<String, CanonError> {
    let canonical = canon::canonicalize(&evidence_identity(v)?)?;
    Ok(format!("ev_{}", canon::canon_digest(EVIDENCE_SCHEMA, PROTOCOL_VERSION, &canonical)))
}

/// The identity projection of a residual unknown: the question and the revision. Extra keys (status,
/// timestamps) are simply not read — custody is not identity.
pub fn unknown_identity(v: &Canon) -> Result<Canon, CanonError> {
    let obj = as_obj(v, "unknown")?;
    Ok(Canon::Obj(vec![
        (
            "question".into(),
            Canon::Str(as_str(field(obj, "question", "unknown")?, "unknown.question")?),
        ),
        (
            "revision".into(),
            Canon::Str(as_str(field(obj, "revision", "unknown")?, "unknown.revision")?),
        ),
    ]))
}

/// `ru_<hex>` — matches packages/evidence `unknownId`.
pub fn unknown_id(v: &Canon) -> Result<String, CanonError> {
    let canonical = canon::canonicalize(&unknown_identity(v)?)?;
    Ok(format!("ru_{}", canon::canon_digest(UNKNOWN_SCHEMA, PROTOCOL_VERSION, &canonical)))
}

/// Stable sort of members by their id. Matches the TypeScript side, which relies on Array.sort's stability.
fn sorted_by_id<'a>(items: &'a [Canon], what: &str) -> Result<Vec<&'a Canon>, CanonError> {
    let mut refs: Vec<&Canon> = items.iter().collect();
    let key = |item: &Canon| -> Result<String, CanonError> {
        let obj = as_obj(item, what)?;
        as_str(field(obj, "id", what)?, &format!("{what}.id"))
    };
    // Decorate-sort-undecorate with a stable sort_by.
    let mut keyed: Vec<(String, &Canon)> = refs.drain(..).map(|item| Ok((key(item)?, item))).collect::<Result<Vec<_>, CanonError>>()?;
    keyed.sort_by(|a, b| a.0.as_bytes().cmp(&b.0.as_bytes()));
    Ok(keyed.into_iter().map(|(_, item)| item).collect())
}

/// The identity projection of a bundle: revision plus every member's identity, members sorted by id.
pub fn bundle_identity(v: &Canon) -> Result<Canon, CanonError> {
    let obj = as_obj(v, "bundle")?;
    let records = as_arr(field(obj, "records", "bundle")?, "bundle.records")?;
    let unknowns = as_arr(field(obj, "unknowns", "bundle")?, "bundle.unknowns")?;
    Ok(Canon::Obj(vec![
        (
            "records".into(),
            Canon::Arr(
                sorted_by_id(records, "record")?
                    .iter()
                    .map(|r| evidence_identity(r))
                    .collect::<Result<Vec<Canon>, CanonError>>()?,
            ),
        ),
        (
            "revision".into(),
            Canon::Str(as_str(field(obj, "revision", "bundle")?, "bundle.revision")?),
        ),
        (
            "unknowns".into(),
            Canon::Arr(
                sorted_by_id(unknowns, "unknown")?
                    .iter()
                    .map(|u| unknown_identity(u))
                    .collect::<Result<Vec<Canon>, CanonError>>()?,
            ),
        ),
    ]))
}

/// Full-form identity: "pf-canon-v1/cie.re-evidence-bundle@1:<hex>" — matches packages/evidence `bundleDigest`.
pub fn bundle_digest(v: &Canon) -> Result<String, CanonError> {
    let canonical = canon::canonicalize(&bundle_identity(v)?)?;
    Ok(format!("{}/{}@{}:{}", canon::PROTOCOL, BUNDLE_SCHEMA, PROTOCOL_VERSION, canon::canon_digest(BUNDLE_SCHEMA, PROTOCOL_VERSION, &canonical)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn load_fixture() -> Canon {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/canon/re-evidence-vectors.json");
        canon::parse_strict_json(&std::fs::read(&path).expect("fixture file must exist")).expect("fixture must be strict JSON")
    }

    fn fixture_vectors(fixture: &Canon) -> Vec<(String, String, String, String)> {
        let obj = as_obj(fixture, "fixture").unwrap();
        let vectors = as_arr(field(obj, "vectors", "fixture").unwrap(), "fixture.vectors").unwrap();
        vectors
            .iter()
            .map(|v| {
                let vo = as_obj(v, "vector").unwrap();
                let id = as_str(field(vo, "id", "vector").unwrap(), "vector.id").unwrap();
                let op = as_str(field(vo, "op", "vector").unwrap(), "vector.op").unwrap();
                let input = as_str(field(vo, "inputText", "vector").unwrap(), "vector.inputText").unwrap();
                let expected = if op == "bundleDigest" {
                    as_str(field(vo, "expectedDigest", "vector").unwrap(), "expectedDigest").unwrap()
                } else {
                    as_str(field(vo, "expectedId", "vector").unwrap(), "expectedId").unwrap()
                };
                (id, op, input, expected)
            })
            .collect()
    }

    /// The cross-runtime contract: every vector the TypeScript side generated must reproduce here,
    /// from an independent implementation of the same projection rules.
    #[test]
    fn fixture_vectors_reproduce() {
        let fixture = load_fixture();
        let vectors = fixture_vectors(&fixture);
        assert!(vectors.len() >= 8, "the fixture carries the full vector set");
        for (id, op, input, expected) in vectors {
            let parsed = canon::parse_strict_json(input.as_bytes()).unwrap_or_else(|e| panic!("vector {id}: {}", e.message));
            let actual = match op.as_str() {
                "evidenceId" => evidence_id(&parsed),
                "unknownId" => unknown_id(&parsed),
                "bundleDigest" => bundle_digest(&parsed),
                other => panic!("vector {id}: unknown op {other}"),
            }
            .unwrap_or_else(|e| panic!("vector {id}: {}", e.message));
            assert_eq!(actual, expected, "vector {id} must reproduce");
        }
    }

    #[test]
    fn locations_are_a_sequence_and_limitations_are_not() {
        let base = r#"{"authority":"shipped-artifact","confidence":"observed","limitations":["b","a"],"locations":[{"kind":"address","value":"0x1"},{"kind":"fileOffset","value":"0x2"}],"predicate":"p","provider":{"id":"t","name":"T","version":"1"},"subject":{"format":"macho","path":"x.node","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}}"#;
        let reordered_locations = r#"{"authority":"shipped-artifact","confidence":"observed","limitations":["b","a"],"locations":[{"kind":"fileOffset","value":"0x2"},{"kind":"address","value":"0x1"}],"predicate":"p","provider":{"id":"t","name":"T","version":"1"},"subject":{"format":"macho","path":"x.node","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}}"#;
        let reordered_limitations = r#"{"authority":"shipped-artifact","confidence":"observed","limitations":["a","b"],"locations":[{"kind":"address","value":"0x1"},{"kind":"fileOffset","value":"0x2"}],"predicate":"p","provider":{"id":"t","name":"T","version":"1"},"subject":{"format":"macho","path":"x.node","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}}"#;
        let base_id = evidence_id(&canon::parse_strict_json(base.as_bytes()).unwrap()).unwrap();
        let loc_id = evidence_id(&canon::parse_strict_json(reordered_locations.as_bytes()).unwrap()).unwrap();
        let lim_id = evidence_id(&canon::parse_strict_json(reordered_limitations.as_bytes()).unwrap()).unwrap();
        assert_ne!(base_id, loc_id, "locations keep their order");
        assert_eq!(base_id, lim_id, "limitations are a set");
    }

    #[test]
    fn custody_is_not_identity() {
        let with_custody = r#"{"authority":"shipped-artifact","confidence":"observed","id":"ev_ignored","limitations":[],"locations":[],"observedAt":"1999-01-01T00:00:00Z","predicate":"p","provider":{"id":"t","name":"T","version":"1"},"revision":"rev-other","state":"STALE","subject":{"format":"macho","path":"x.node","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}}"#;
        let without_custody = r#"{"authority":"shipped-artifact","confidence":"observed","limitations":[],"locations":[],"predicate":"p","provider":{"id":"t","name":"T","version":"1"},"subject":{"format":"macho","path":"x.node","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}}"#;
        let a = evidence_id(&canon::parse_strict_json(with_custody.as_bytes()).unwrap()).unwrap();
        let b = evidence_id(&canon::parse_strict_json(without_custody.as_bytes()).unwrap()).unwrap();
        assert_eq!(a, b, "state, observedAt, revision and the stored id are not identity");
    }

    #[test]
    fn missing_fields_are_bad_schema() {
        let empty = canon::parse_strict_json(b"{}").unwrap();
        assert_eq!(evidence_id(&empty).unwrap_err().code, Code::BadSchema);
        let partial = canon::parse_strict_json(br#"{"question":"q"}"#).unwrap();
        assert_eq!(unknown_id(&partial).unwrap_err().code, Code::BadSchema);
    }
}
