//! Opt-in bounded scope chunks. The legacy graph remains on its existing handle.
use crate::{evidence_core, model::AnalysisBatch};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    io::Write,
    path::Path,
};

#[derive(Clone, Copy)]
pub struct Limits {
    pub rows: usize,
    pub bytes: usize,
    pub chunk_bytes: usize,
    pub chunk_rows: usize,
}
pub fn limits() -> Result<Limits, String> {
    fn value(key: &str, default: usize, max: usize) -> Result<usize, String> {
        let n = match std::env::var(key) {
            Ok(s)
                if !s.is_empty()
                    && !s.starts_with('0')
                    && s.bytes().all(|b| b.is_ascii_digit()) =>
            {
                s.parse::<usize>()
                    .map_err(|_| format!("invalid CIE_EVIDENCE_CORE budget: {key}"))?
            }
            Ok(_) => return Err(format!("invalid CIE_EVIDENCE_CORE budget: {key}")),
            Err(_) => default,
        };
        if n == 0 || n > max {
            return Err(format!("invalid CIE_EVIDENCE_CORE budget: {key}"));
        }
        Ok(n)
    }
    Ok(Limits {
        rows: value("CIE_EVIDENCE_CORE_MAX_ROWS", 100_000, 1_000_000)?,
        bytes: value(
            "CIE_EVIDENCE_CORE_MAX_BYTES",
            16 * 1024 * 1024,
            512 * 1024 * 1024,
        )?,
        chunk_bytes: value(
            "CIE_EVIDENCE_CORE_CHUNK_BYTES",
            8 * 1024 * 1024,
            32 * 1024 * 1024,
        )?,
        chunk_rows: value("CIE_EVIDENCE_CORE_CHUNK_ROWS", 16_384, 100_000)?,
    })
}
pub fn streaming() -> Result<bool, String> {
    match std::env::var("CIE_EVIDENCE_CORE_TRANSPORT")
        .as_deref()
        .unwrap_or("inline")
    {
        "inline" => Ok(false),
        "stream" => Ok(true),
        _ => Err("invalid CIE_EVIDENCE_CORE_TRANSPORT".into()),
    }
}
struct Bounded {
    bytes: Vec<u8>,
    max: usize,
}
impl Write for Bounded {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len() + b.len() > self.max {
            return Err(std::io::Error::other("chunk byte cap"));
        }
        self.bytes.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub fn write(batch: &AnalysisBatch, path: &Path) -> Result<(), String> {
    write_inner(batch, path)
}
fn write_inner(batch: &AnalysisBatch, path: &Path) -> Result<(), String> {
    let limits = limits()?;
    let inputs = evidence_core::input_digests(batch);
    let owners: HashMap<_, _> = batch
        .entities
        .iter()
        .map(|e| (e.entity_id.as_str(), e.file.as_str()))
        .collect();
    let mut groups: BTreeMap<&str, (Vec<_>, Vec<_>)> = BTreeMap::new();
    for file in batch
        .manifest
        .keys()
        .filter(|file| batch.mode != "delta" || batch.changed_files.contains(file))
    {
        groups.entry(file).or_default();
    }
    for fact in &batch.facts {
        groups
            .entry(owners.get(fact.subject.as_str()).copied().unwrap_or(""))
            .or_default()
            .0
            .push(fact);
    }
    for rel in &batch.relationships {
        groups
            .entry(owners.get(rel.from.as_str()).copied().unwrap_or(""))
            .or_default()
            .1
            .push(rel);
    }
    if groups.len() > limits.rows {
        return Err("EVIDENCE_CORE_LIMIT: scope count".into());
    }
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    struct Cleanup<'a> {
        path: &'a Path,
        keep: bool,
    }
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            if !self.keep {
                let _ = std::fs::remove_file(self.path);
            }
        }
    }
    let mut cleanup = Cleanup { path, keep: false };
    let mut writer = std::io::BufWriter::new(file);
    let mut total = 0;
    let mut links = 0;
    let mut digest = Sha256::new();
    send(
        &mut writer,
        &mut total,
        &serde_json::json!({"kind":"header","schema":"cie.evidence-core.stream.v1","revision":batch.revision}),
        limits,
        None,
    )?;
    let chunks = groups.len();
    for (sequence, (scope, (facts, relationships))) in groups.into_iter().enumerate() {
        let count: usize = facts
            .iter()
            .map(|f| f.evidence.len())
            .chain(relationships.iter().map(|r| r.evidence.len()))
            .sum();
        links += count;
        if count > limits.chunk_rows || links > limits.rows {
            return Err("EVIDENCE_CORE_LIMIT: scope or revision row cap".into());
        }
        // Bound identifier cloning before allocating JSON associations. The wire
        // writer separately checks escaping and envelope overhead.
        check_ids(
            facts
                .iter()
                .flat_map(|f| {
                    f.evidence
                        .iter()
                        .map(move |e| (f.id.as_str(), e.id.as_str()))
                })
                .chain(relationships.iter().flat_map(|r| {
                    r.evidence
                        .iter()
                        .map(move |e| (r.id.as_str(), e.id.as_str()))
                })),
            limits.chunk_bytes,
        )?;
        let core = evidence_core::emit_scope(batch, scope, &inputs, &facts, &relationships)?;
        #[derive(Serialize)]
        struct Chunk<'a> {
            kind: &'static str,
            sequence: usize,
            scope: &'a str,
            core: &'a evidence_core::EvidenceCoreBatchV1,
        }
        send(
            &mut writer,
            &mut total,
            &Chunk {
                kind: "chunk",
                sequence,
                scope,
                core: &core,
            },
            limits,
            Some(&mut digest),
        )?;
    }
    send(
        &mut writer,
        &mut total,
        &serde_json::json!({"kind":"footer","chunks":chunks,"sha256":format!("{:x}",digest.finalize())}),
        limits,
        None,
    )?;
    writer.flush().map_err(|e| e.to_string())?;
    cleanup.keep = true;
    Ok(())
}
fn check_ids<'a>(
    pairs: impl Iterator<Item = (&'a str, &'a str)>,
    max: usize,
) -> Result<(), String> {
    let mut total = 0usize;
    for (a, b) in pairs {
        total = total
            .checked_add(a.len())
            .and_then(|n| n.checked_add(b.len()))
            .ok_or("EVIDENCE_CORE_LIMIT: scope identifier byte budget")?;
        if total > max {
            return Err("EVIDENCE_CORE_LIMIT: scope identifier byte budget".into());
        }
    }
    Ok(())
}

fn send<T: Serialize>(
    writer: &mut impl Write,
    total: &mut usize,
    value: &T,
    limits: Limits,
    hash: Option<&mut Sha256>,
) -> Result<(), String> {
    let mut buffer = Bounded {
        bytes: Vec::new(),
        max: limits.chunk_bytes,
    };
    serde_json::to_writer(&mut buffer, value)
        .map_err(|_| "EVIDENCE_CORE_LIMIT: scope chunk byte cap")?;
    buffer.bytes.push(b'\n');
    *total += buffer.bytes.len();
    if *total > limits.bytes {
        return Err("EVIDENCE_CORE_LIMIT: revision byte cap".into());
    }
    if let Some(hash) = hash {
        hash.update(&buffer.bytes);
    }
    writer.write_all(&buffer.bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repository_scope_can_be_streamed_with_an_empty_manifest_owner() {
        let mut batch = AnalysisBatch::default();
        batch.revision = "repo-r1".into();
        batch.manifest.insert("".into(), "root".into());
        let full = evidence_core::emit(&batch).unwrap();
        let scoped =
            evidence_core::emit_scope(&batch, "", &evidence_core::input_digests(&batch), &[], &[])
                .unwrap();
        assert_eq!(
            serde_json::to_value(full).unwrap(),
            serde_json::to_value(scoped).unwrap()
        );
        let path = std::env::temp_dir().join(format!(
            "cie-root-test-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write(&batch, &path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(path).unwrap();
        let chunk: serde_json::Value = serde_json::from_str(text.lines().nth(1).unwrap()).unwrap();
        assert_eq!(chunk["scope"], "");
        assert!(chunk["core"]["producerRuns"][0]["inputDigest"]
            .as_str()
            .unwrap()
            .starts_with("cie.evidence-core.manifest-input@1:"));
    }
    #[test]
    fn identifiers_are_bounded_before_association_allocation() {
        assert!(check_ids(std::iter::once(("1234", "56")), 5).is_err());
        assert!(check_ids(std::iter::once(("1234", "56")), 6).is_ok());
    }
    #[test]
    fn chunk_writer_rejects_before_growing_past_its_budget() {
        let mut writer = Bounded {
            bytes: Vec::new(),
            max: 4,
        };
        writer.write_all(b"1234").unwrap();
        assert!(writer.write_all(b"5").is_err());
        assert_eq!(writer.bytes, b"1234");
    }
    #[test]
    fn total_wire_budget_is_checked_before_writing_a_record() {
        let mut output = Vec::new();
        let mut total = 0;
        let limits = Limits {
            rows: 100,
            bytes: 1,
            chunk_bytes: 100,
            chunk_rows: 100,
        };
        assert!(send(
            &mut output,
            &mut total,
            &serde_json::json!({}),
            limits,
            None
        )
        .is_err());
        assert!(output.is_empty());
    }
}
