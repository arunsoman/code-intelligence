//! Repository walk (C04 local ingestion) + cross-file resolution (C05 resolveSemantics / C09 graph).
//! With a provided `ChangeSet` (per-file content hashes of the previously indexed revision) only
//! changed files are re-parsed; the rest reuse cached parses, and diagnostics report what was reused.
use crate::frameworks::{FrameworkContext, FrameworkEntityKind};
use crate::language::{multiplicity_of, parse_ts, RawFile};
use crate::polyglot::{parse_go, parse_java, parse_python};
use crate::rust_language::parse_rust;
use crate::source_ir;
use crate::model::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use ignore::WalkBuilder;

// Directories skipped regardless of .gitignore (defense in depth: a repo that forgot to ignore its own
// dependency/build output still shouldn't be indexed). .gitignore, .git/info/exclude and the global git
// excludes file are honoured on top of this list by `ignore::WalkBuilder` (same crate ripgrep uses), so a
// project's own ignore rules — not just this fixed list — keep generated and vendored files out of the index.
const SKIP_DIRS: &[&str] = &["node_modules", ".git", "dist", "build", "target", ".next", "coverage", "__pycache__", ".venv", "venv", ".gradle", ".idea", "vendor", "site-packages"];
pub const ANALYZER_VERSION: &str = "worker-0.5.0/tree-sitter-typescript-0.23+rust-0.24+nirdosha-v2+defect-semantic-v2+ast-metrics-v1+gitignore-aware-walk+uml-class-v1";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

struct FileRec {
    rel: String,
    hash: String,
    src: String,
    raw: RawFile,
    /// entity id per raw symbol index
    ids: Vec<String>,
}

fn is_config_file(rel: &str) -> bool {
    let n = std::path::Path::new(rel).file_name().and_then(|s| s.to_str()).unwrap_or("");
    matches!(n,
        "package.json" | "tsconfig.json" | "nest-cli.json" | "pom.xml" | ".env" | ".env.local"
    ) || n.starts_with("application") && (n.ends_with(".yml") || n.ends_with(".yaml") || n.ends_with(".properties"))
      || n.starts_with(".env.")
}

// ---- parse cache (incremental re-index; CE-3 region-level reuse) ----
// Key: (relative path, content hash); value: the parsed file. Only valid within one
// analyzer version and one worker process (spawn-local). Bounded by estimated parser bytes, not by an
// entry count: an entry cap made a large repository stop reusing parses after ~4,096 files (issue #4).
const CACHE_LIMIT: usize = 4096; // the old entry cap; kept to size the byte budget and the regression fixture
const CACHE_BYTE_LIMIT: usize = CACHE_LIMIT * 256 * 1024; // ~1 GiB of estimated parser memory
const PARSE_MEMORY_FACTOR: usize = 50; // README measures ~0.2 MB of parser memory per ~4 KB of source
#[derive(PartialEq, Eq, Hash, Clone)]
struct CacheKey(String, String, String); // repo_root, rel, content_hash
struct CacheEntry { raw: RawFile, bytes: usize }
struct ParseCache { entries: HashMap<CacheKey, CacheEntry>, order: std::collections::VecDeque<CacheKey>, bytes: usize }
static PARSE_CACHE: std::sync::OnceLock<std::sync::Mutex<ParseCache>> = std::sync::OnceLock::new();

/// A content-keyed parse cache, so an incremental re-index can reuse parses of files whose
/// bytes are unchanged. Only valid inside one worker process (spawn-local, one op at a time).
fn parse_cache() -> std::sync::MutexGuard<'static, ParseCache> {
    PARSE_CACHE.get_or_init(|| std::sync::Mutex::new(ParseCache { entries: HashMap::new(), order: std::collections::VecDeque::new(), bytes: 0 })).lock().unwrap_or_else(|e| e.into_inner())
}
fn cache_get(root: &str, rel: &str, hash: &str) -> Option<RawFile> {
    parse_cache().entries.get(&CacheKey(root.to_string(), rel.to_string(), hash.to_string())).map(|e| e.raw.clone())
}
fn cache_put(root: &str, rel: &str, hash: &str, raw: &RawFile, src_len: usize) {
    let mut c = parse_cache();
    let key = CacheKey(root.to_string(), rel.to_string(), hash.to_string());
    if let Some(prev) = c.entries.remove(&key) { c.bytes = c.bytes.saturating_sub(prev.bytes); c.order.retain(|k| k != &key); }
    let bytes = (src_len * PARSE_MEMORY_FACTOR).max(1);
    c.entries.insert(key.clone(), CacheEntry { raw: raw.clone(), bytes });
    c.order.push_back(key);
    c.bytes = c.bytes.saturating_add(bytes);
    // Evict oldest-first by bytes. A single file larger than the whole budget is still kept, so one huge file cannot make the cache useless.
    while c.bytes > CACHE_BYTE_LIMIT && c.entries.len() > 1 {
        match c.order.pop_front() { Some(old) => { if let Some(e) = c.entries.remove(&old) { c.bytes = c.bytes.saturating_sub(e.bytes); } } None => break }
    }
}

/// Rows are built with this stand-in for the revision id (which is only known once every file has been read and changes with every edit anywhere),
/// so a row's bytes do not depend on it; the real id is written into the rows that are kept, after they are digested.
const REV_PLACEHOLDER: &str = "@REV@";

/// A 128-bit, non-cryptographic digest (two independently seeded SipHash-1-3 streams) for the per-row digests. They only have to notice that a row changed, and
/// they are computed for every row of the repository on every index run: software SHA-256 over that volume was most of the cost on machines without SHA instructions.
/// The per-file digest and the revision id still use SHA-256.
struct RowHash(std::collections::hash_map::DefaultHasher, std::collections::hash_map::DefaultHasher);
impl RowHash {
    fn new(tag: u8) -> Self {
        use std::hash::Hasher;
        let (mut a, mut b) = (std::collections::hash_map::DefaultHasher::new(), std::collections::hash_map::DefaultHasher::new());
        a.write_u8(tag); b.write_u8(tag ^ 0x5a); b.write_u64(0x9e37_79b9_7f4a_7c15);
        RowHash(a, b)
    }
    fn update(&mut self, bytes: &[u8]) { use std::hash::Hasher; self.0.write(bytes); self.1.write(bytes); }
    fn finish(self) -> [u8; 16] { use std::hash::Hasher; let mut o = [0u8; 16]; o[..8].copy_from_slice(&self.0.finish().to_le_bytes()); o[8..].copy_from_slice(&self.1.finish().to_le_bytes()); o }
}
impl std::io::Write for RowHash {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> { self.update(buf); Ok(buf.len()) }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
/// Length-prefixed, so ("ab","c") and ("a","bc") digest differently.
fn put(h: &mut RowHash, s: &str) { h.update(&(s.len() as u32).to_le_bytes()); h.update(s.as_bytes()); }
fn put_json<T: serde::Serialize>(h: &mut RowHash, v: &T) { let _ = serde_json::to_writer(h, v); }
/// Every field of an evidence reference except the revision id inside its span.
fn put_evidence(h: &mut RowHash, ev: &EvidenceRef) {
    put(h, &ev.id); put(h, &ev.source_id); put(h, ev.class); put(h, &ev.observed_at); put(h, &ev.access_scope_id); put(h, ev.state);
    let l = &ev.location;
    put(h, l.get("kind").and_then(|v| v.as_str()).unwrap_or(""));
    let sp = l.get("span");
    for k in ["sourceId", "contentHash"] { put(h, sp.and_then(|s| s.get(k)).and_then(|v| v.as_str()).unwrap_or("")); }
    for k in ["startByte", "endByteExclusive"] { h.update(&sp.and_then(|s| s.get(k)).and_then(|v| v.as_u64()).unwrap_or(0).to_le_bytes()); }
}
fn entity_digest(e: &Entity) -> [u8; 16] {
    let mut h = RowHash::new(b'E');
    put(&mut h, &e.entity_id); put(&mut h, &e.kind); put(&mut h, &e.name); put(&mut h, &e.file); put(&mut h, e.symbol_hash.as_deref().unwrap_or(""));
    for sp in &e.spans { put(&mut h, &sp.source_id); put(&mut h, &sp.content_hash); h.update(&(sp.start_byte as u64).to_le_bytes()); h.update(&(sp.end_byte_exclusive as u64).to_le_bytes()); }
    h.finish()
}
fn fact_digest(f: &Fact) -> [u8; 16] {
    let mut h = RowHash::new(b'F');
    put(&mut h, &f.id); put(&mut h, &f.subject); put(&mut h, &f.predicate); put(&mut h, f.resolution);
    put_json(&mut h, &f.object);
    for ev in &f.evidence { put_evidence(&mut h, ev); }
    h.finish()
}
fn relationship_digest(r: &Relationship) -> [u8; 16] {
    let mut h = RowHash::new(b'R');
    put(&mut h, &r.id); put(&mut h, &r.from); put(&mut h, &r.to); put(&mut h, &r.kind); put(&mut h, r.resolution); put(&mut h, r.label.as_deref().unwrap_or(""));
    for ev in &r.evidence { put_evidence(&mut h, ev); }
    h.finish()
}
fn set_revision(ev: &mut EvidenceRef, rev: &str) {
    if let Some(r) = ev.location.pointer_mut("/span/revision") { *r = serde_json::Value::String(rev.to_string()); }
}

/// Digest everything emitted for each file, and, when the caller holds a base revision, keep only the rows of files whose digest differs.
/// A file's rows are its entities, the facts about them and the relationships from them. Row order does not matter (rows are digested one by one
/// and sorted), so a nondeterministic emission order cannot change a digest. Afterwards the real revision id replaces the placeholder in every kept row.
fn shard(batch: &mut AnalysisBatch, base: Option<&BaseRef>) {
    use std::collections::{BTreeMap, HashSet};
    let file_of: HashMap<&str, &str> = batch.entities.iter().map(|e| (e.entity_id.as_str(), e.file.as_str())).collect();
    let owner = |id: &str| -> &str { file_of.get(id).copied().unwrap_or("") };
    let t0 = std::time::Instant::now();
    let mut rows: BTreeMap<&str, Vec<[u8; 16]>> = BTreeMap::new();
    for e in &batch.entities { rows.entry(e.file.as_str()).or_default().push(entity_digest(e)); }
    timing("  shard: entity digests", t0);
    for f in &batch.facts { rows.entry(owner(&f.subject)).or_default().push(fact_digest(f)); }
    timing("  shard: + fact digests", t0);
    for r in &batch.relationships { rows.entry(owner(&r.from)).or_default().push(relationship_digest(r)); }
    timing("  shard: + relationship digests", t0);
    let mut manifest = BTreeMap::new();
    for (file, mut ds) in rows {
        ds.sort();
        let mut h = Sha256::new();
        for d in &ds { h.update(d); }
        manifest.insert(file.to_string(), hex(&h.finalize()));
    }
    let owned_facts: Vec<String> = batch.facts.iter().map(|f| owner(&f.subject).to_string()).collect();
    let owned_rels: Vec<String> = batch.relationships.iter().map(|r| owner(&r.from).to_string()).collect();
    batch.manifest = manifest;
    batch.mode = "full".into();
    let delta = base.filter(|b| b.analyzer_version == ANALYZER_VERSION && !b.digests.is_empty());
    if let Some(b) = delta {
        let changed: HashSet<String> = batch.manifest.iter().filter(|(f, d)| b.digests.get(*f) != Some(*d)).map(|(f, _)| f.clone()).collect();
        batch.removed_files = b.digests.keys().filter(|f| !batch.manifest.contains_key(*f)).cloned().collect();
        batch.removed_files.sort();
        // The rows that are not sent are freed on another thread: releasing ~100,000 facts took longer than digesting them.
        let (mut gone_e, mut gone_f, mut gone_r) = (Vec::new(), Vec::new(), Vec::new());
        let ents = std::mem::take(&mut batch.entities);
        for e in ents { if changed.contains(&e.file) { batch.entities.push(e); } else { gone_e.push(e); } }
        let facts = std::mem::take(&mut batch.facts);
        for (f, owner) in facts.into_iter().zip(owned_facts.iter()) { if changed.contains(owner) { batch.facts.push(f); } else { gone_f.push(f); } }
        let rels = std::mem::take(&mut batch.relationships);
        for (r, owner) in rels.into_iter().zip(owned_rels.iter()) { if changed.contains(owner) { batch.relationships.push(r); } else { gone_r.push(r); } }
        std::thread::spawn(move || drop((gone_e, gone_f, gone_r)));
        batch.changed_files = changed.into_iter().collect();
        batch.changed_files.sort();
        batch.mode = "delta".into();
        batch.base_revision = Some(b.revision.clone());
    }
    timing("  shard: + manifest and filtering", t0);
    let rev = batch.revision.clone();
    for e in batch.entities.iter_mut() { for sp in e.spans.iter_mut() { sp.revision = rev.clone(); } }
    for f in batch.facts.iter_mut() { for ev in f.evidence.iter_mut() { set_revision(ev, &rev); } }
    for r in batch.relationships.iter_mut() { for ev in r.evidence.iter_mut() { set_revision(ev, &rev); } }
}

pub fn git_head(root: &Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// CIE_WORKER_TIMING=<file> appends how long each phase of an index run took (the worker's stderr is discarded on purpose: it may contain source).
fn timing(phase: &str, since: std::time::Instant) {
    if let Some(f) = std::env::var_os("CIE_WORKER_TIMING") {
        use std::io::Write;
        if let Ok(mut h) = std::fs::OpenOptions::new().create(true).append(true).open(f) { let _ = writeln!(h, "{phase}: {} ms", since.elapsed().as_millis()); }
    }
}

pub fn index_repo(root: &Path, changes: Option<&ChangeSet>, base: Option<&BaseRef>) -> Result<AnalysisBatch, String> {
    let t_all = std::time::Instant::now();
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut paths: Vec<PathBuf> = WalkBuilder::new(&root)
        // Honour .gitignore even when the root is not (yet) a git checkout — e.g. a directory copied
        // without its .git folder should still keep its generated/vendored files out of the index.
        .require_git(false)
        .filter_entry(|e| {
            !(e.file_type().map_or(false, |ft| ft.is_dir()) && e.file_name().to_str().map_or(false, |n| SKIP_DIRS.contains(&n)))
        })
        .build()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map_or(false, |ft| ft.is_file()))
        .map(|e| e.into_path())
        .filter(|p| {
            let n = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let ext = p.extension().and_then(|s| s.to_str());
            let rel = p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
            !n.ends_with(".d.ts")
                && (is_config_file(&rel)
                    || matches!(ext, Some("ts" | "tsx" | "mts" | "cts" | "rs" | "nir" | "java" | "go" | "py" | "yml" | "yaml" | "properties")))
        })
        .collect();
    paths.sort();
    timing("walk", t_all);
    let t_pass1 = std::time::Instant::now();

    let mut batch = AnalysisBatch {
        repo_root: root.to_string_lossy().into(),
        git_head: git_head(&root),
        analyzer_version: ANALYZER_VERSION.into(),
        ..Default::default()
    };
    let mut nirdosha_ir = if paths.iter().any(|p| p.extension().and_then(|e| e.to_str()) == Some("nir")) {
        match source_ir::inspect(&root) {
            Ok(v) => v,
            Err(e) => {
                batch.diagnostics.push(Diagnostic { code:"NIRDOSHA_SOURCE_IR_FAILED".into(), message:e, related_entity_ids:vec![], retryable:false });
                None
            }
        }
    } else { None };

    // Pass 1: read + hash + parse.
    let mut sources: Vec<(String, String)> = Vec::new();
    let mut recs: Vec<FileRec> = Vec::new();
    let mut rev_hasher = Sha256::new();
    // Revisions are per repository: identical content at another path is a different revision,
    // because evidence spans resolve against this root.
    rev_hasher.update(root.to_string_lossy().as_bytes());
    // ---- incremental pass over the walk: hash every file, reuse parses of unchanged ones.
    // Hashing must touch every file (a change is undetectable otherwise); only *parsing* is skipped.
    let mut reused = 0usize;
    let _ = changes; // accepted for older callers; the content-keyed cache makes it unnecessary
    let mut read_files: Vec<(PathBuf, String, String, String)> = Vec::new();
    for p in &paths {
        let rel = p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        let bytes = match std::fs::read(p) {
            Ok(b) => b,
            Err(e) => {
                batch.diagnostics.push(Diagnostic {
                    code: "READ_FAILED".into(),
                    message: format!("{rel}: {e}"),
                    related_entity_ids: vec![],
                    retryable: true,
                });
                continue;
            }
        };
        let hash = sha(&bytes);
        rev_hasher.update(rel.as_bytes());
        rev_hasher.update(hash.as_bytes());
        let src = match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(_) => {
                batch.diagnostics.push(Diagnostic {
                    code: "NON_UTF8".into(),
                    message: format!("{rel}: skipped, not UTF-8"),
                    related_entity_ids: vec![],
                    retryable: false,
                });
                continue;
            }
        };
        read_files.push((p.clone(), rel, hash, src));
    }
    timing("pass1a read+hash", t_pass1);
    // The revision id is a hash of every file's path and bytes, so it is known before anything is parsed: when it is the base revision, stop here.
    let revision_id = format!("wt-{}", &hex(&rev_hasher.finalize())[..16]);
    if let Some(b) = base {
        if b.revision == revision_id && b.analyzer_version == ANALYZER_VERSION {
            batch.revision = revision_id;
            batch.mode = "unchanged".into();
            batch.base_revision = Some(b.revision.clone());
            timing("unchanged: early exit", t_all);
            return Ok(batch);
        }
    }
    for (p, rel, hash, src) in read_files {
        // Same content hash as the caller's previous revision: the parse is content-identical, reuse it.
        // The cache is keyed by (repo root, relative path, content hash) so concurrent tests with the same
        // relative names do not share entries; in production one worker run holds one repository at a time.
        if let Some(raw) = cache_get(&batch.repo_root, &rel, &hash) {
            reused += 1;
            sources.push((rel.clone(), hash.clone()));
            recs.push(FileRec { rel, hash, src, raw, ids: vec![] });
            continue;
        }
        let mut raw = match p.extension().and_then(|s| s.to_str()) {
            Some("rs" | "nir") => parse_rust(&src, rel.ends_with(".nir")),
            Some("java") => {
                let mut raw = parse_java(&src, &rel);
                crate::frameworks::apply(&mut raw, FrameworkContext { rel: &rel, src: &src, project_root: &root });
                raw
            }
            Some("go") => parse_go(&src, &rel),
            Some("py") => parse_python(&src, &rel),
            Some("yml" | "yaml" | "properties") => {
                let mut raw = crate::language::RawFile::default();
                crate::frameworks::apply(&mut raw, FrameworkContext { rel: &rel, src: &src, project_root: &root });
                raw
            }
            _ if is_config_file(&rel) => {
                let mut raw = crate::language::RawFile::default();
                crate::frameworks::apply(&mut raw, FrameworkContext { rel: &rel, src: &src, project_root: &root });
                raw
            }
            _ => {
                let mut raw = parse_ts(&src, rel.ends_with(".tsx"));
                crate::frameworks::apply(&mut raw, FrameworkContext { rel: &rel, src: &src, project_root: &root });
                raw
            }
        };
        if rel.ends_with(".nir") { if let Some(ir)=nirdosha_ir.as_mut() { ir.merge(&rel,&hash,&mut raw); } }
        if raw.had_errors {
            batch.diagnostics.push(Diagnostic {
                code: "PARSE_ERRORS".into(),
                message: format!("{rel}: syntax errors; facts from this file may be partial"),
                related_entity_ids: vec![format!("file:{rel}")],
                retryable: false,
            });
        }
        cache_put(&batch.repo_root, &rel, &hash, &raw, src.len());
        sources.push((rel.clone(), hash.clone()));
        recs.push(FileRec { rel, hash, src, raw, ids: vec![] });
    }
    if reused > 0 {
        batch.diagnostics.push(Diagnostic {
            code: "REUSED_CACHED_PARSES".into(),
            message: format!("incremental: {reused} of {} file(s) unchanged since the previous revision; their parses were reused", recs.len()),
            related_entity_ids: vec![],
            retryable: false,
        });
    }
    timing("pass1 read+hash+parse", t_pass1);
    let t_graph = std::time::Instant::now();
    batch.revision = revision_id;
    if let Some(ir)=nirdosha_ir { for (rel,code,message) in ir.diagnostics { batch.diagnostics.push(Diagnostic{code,message,related_entity_ids:vec![format!("file:{rel}")],retryable:false}); } }
    let rev = REV_PLACEHOLDER.to_string();

    let span = |rel: &str, hash: &str, s: usize, e: usize| SourceSpan {
        source_id: rel.to_string(),
        content_hash: hash.to_string(),
        revision: rev.clone(),
        start_byte: s,
        end_byte_exclusive: e,
    };
    let evidence = |rel: &str, hash: &str, s: usize, e: usize, class: &'static str| EvidenceRef {
        id: format!("ev:{}", &sha(format!("{rel}:{s}:{e}:{class}").as_bytes())[..16]),
        source_id: rel.to_string(),
        location: json!({"kind":"CodeLocation","span":{"sourceId":rel,"contentHash":hash,"revision":rev,
            "startByte":s,"endByteExclusive":e}}),
        class,
        observed_at: "1970-01-01T00:00:00Z".into(),
        access_scope_id: "local".into(),
        state: "CURRENT",
    };

    // Entities.
    let mut seen_ids: HashMap<String, usize> = HashMap::new();
    for rec in recs.iter_mut() {
        let fid = format!("file:{}", rec.rel);
        batch.entities.push(Entity {
            entity_id: fid.clone(),
            kind: "file".into(),
            name: rec.rel.rsplit('/').next().unwrap_or(&rec.rel).into(),
            file: rec.rel.clone(),
            spans: vec![span(&rec.rel, &rec.hash, 0, 0)],
            symbol_hash: None,
        });
        for s in &rec.raw.symbols {
            let mut id = format!("{}:{}#{}", s.kind, rec.rel, s.qualified);
            let n = seen_ids.entry(id.clone()).or_insert(0);
            *n += 1;
            if *n > 1 {
                id = format!("{id}@{}", s.start); // overloads / duplicate names
            }
            rec.ids.push(id.clone());
            batch.entities.push(Entity {
                entity_id: id.clone(),
                kind: s.kind.into(),
                name: s.qualified.clone(),
                file: rec.rel.clone(),
                spans: vec![span(&rec.rel, &rec.hash, s.start, s.end)],
                symbol_hash: rec.src.get(s.start..s.end).map(|t| sha(t.as_bytes())[..16].to_string()),
            });
            batch.relationships.push(Relationship {
                id: format!("rel:contains:{id}"),
                from: fid.clone(),
                to: id.clone(),
                kind: "contains".into(),
                evidence: vec![evidence(&rec.rel, &rec.hash, s.start, s.end, "STATIC_PARSED")],
                resolution: "PARSED",
                label: None,
            });
            if s.exported {
                batch.facts.push(Fact {
                    id: format!("fact:visibility:{id}"),
                    subject: id,
                    predicate: "visibility".into(),
                    object: json!({"kind":"ScalarValue","value":"public"}),
                    evidence: vec![evidence(&rec.rel, &rec.hash, s.start, s.end, "STATIC_PARSED")],
                    resolution: "PARSED",
                });
            }
        }
    }

    // Nirdosha's own source IR adds domain declarations and typed references.
    // Reference nodes are explicit concepts, not claims that the referenced
    // runtime object was successfully resolved or enforced.
    let mut reference_entities: std::collections::HashSet<String> = std::collections::HashSet::new();
    for rec in &recs {
        for d in &rec.raw.declarations {
            let subject=rec.ids[d.symbol_index].clone();
            let ev=evidence(&rec.rel,&rec.hash,d.start,d.end,"STATIC_PARSED");
            batch.facts.push(Fact{id:format!("fact:nirdosha:{}:{}",rec.rel,d.start),subject:subject.clone(),predicate:"nirdosha_declaration".into(),object:json!({"kind":"ScalarValue","value":{"kind":d.kind,"name":d.name,"macro":d.macro_name,"properties":d.properties}}),evidence:vec![ev.clone()],resolution:"PARSED"});
            for r in &d.references {
                let target=format!("nirdosha-ref:{}:{}",r.kind,r.target);
                if reference_entities.insert(target.clone()) { batch.entities.push(Entity{entity_id:target.clone(),kind:format!("nirdosha_{}",r.kind),name:r.target.clone(),file:rec.rel.clone(),spans:vec![span(&rec.rel,&rec.hash,d.start,d.end)],symbol_hash:None}); }
                let rel_kind=match r.kind.as_str(){"role"=>"requires_role","entity"=>"uses_entity","store"=>"uses_store","purpose"=>"has_purpose","route"=>"exposes_route","capability"=>"capability_gate",_=>"nirdosha_reference"};
                batch.relationships.push(Relationship{id:format!("rel:{rel_kind}:{subject}->{target}:{}",r.property),from:subject.clone(),to:target,kind:rel_kind.into(),evidence:vec![ev.clone()],resolution:"PARSED",label:Some(r.property.clone())});
            }
        }
    }

    // Lookup tables.
    let known_files: HashMap<String, usize> = recs.iter().enumerate().map(|(i, r)| (r.rel.clone(), i)).collect();
    let find_symbol = |file_idx: usize, name: &str| -> Option<String> {
        let r = &recs[file_idx];
        r.raw.symbols.iter().position(|s| s.qualified == name && s.kind != "method").map(|i| r.ids[i].clone())
    };
    // Java and Go scope names by package, and a package is a directory: siblings see each other without importing.
    let pkg_lang = |rel: &str| rel.ends_with(".go") || rel.ends_with(".java");
    // A Java package is the directory under src/main/java or src/test/java, so main and test code of one package share it.
    let dir_of = |rel: &str| -> String {
        let d = rel.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
        if rel.ends_with(".java") {
            for root in ["/src/main/java/", "/src/test/java/"] { if let Some((pre, post)) = d.split_once(root.trim_end_matches('/')) { return format!("{pre}|{}", post.trim_start_matches('/')); } }
            for root in ["src/main/java", "src/test/java"] { if let Some(post) = d.strip_prefix(root) { return format!("|{}", post.trim_start_matches('/')); } }
        }
        d
    };
    let mut dir_files: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, r) in recs.iter().enumerate() { if pkg_lang(&r.rel) { dir_files.entry(dir_of(&r.rel)).or_default().push(i); } }
    let siblings = |file_idx: usize| -> Vec<usize> { let r = &recs[file_idx].rel; if pkg_lang(r) { dir_files.get(&dir_of(r)).cloned().unwrap_or_default() } else { vec![file_idx] } };
    let find_symbol_pkg = |file_idx: usize, name: &str| -> Option<String> {
        find_symbol(file_idx, name).or_else(|| siblings(file_idx).into_iter().filter(|i| *i != file_idx).find_map(|i| find_symbol(i, name)))
    };
    let find_member = |file_idx: usize, class: &str, name: &str| -> Option<String> {
        let q = format!("{class}.{name}");
        let r = &recs[file_idx];
        r.raw.symbols.iter().position(|s| s.qualified == q).map(|i| r.ids[i].clone())
    };
    let find_member_pkg = |file_idx: usize, class: &str, name: &str| -> Option<String> {
        find_member(file_idx, class, name).or_else(|| siblings(file_idx).into_iter().filter(|i| *i != file_idx).find_map(|i| find_member(i, class, name)))
    };
    // Suffix indexes for resolving package-style imports to files.
    let mut java_by_suffix: HashMap<String, usize> = HashMap::new();
    let mut py_by_suffix: HashMap<String, usize> = HashMap::new();
    let mut go_dir_by_suffix: HashMap<String, usize> = HashMap::new();
    for (i, r) in recs.iter().enumerate() {
        let segs: Vec<&str> = r.rel.split('/').collect();
        if r.rel.ends_with(".py") { for k in 0..segs.len() { py_by_suffix.entry(segs[k..].join("/")).or_insert(i); } }
        if r.rel.ends_with(".java") { for k in 0..segs.len() { java_by_suffix.entry(segs[k..].join("/")).or_insert(i); } }
        if r.rel.ends_with(".go") && !r.rel.ends_with("_test.go") { let d = &segs[..segs.len() - 1]; for k in 0..d.len() { go_dir_by_suffix.entry(d[k..].join("/")).or_insert(i); } }
    }

    let mut rel_ids: HashMap<String, usize> = batch.relationships.iter().enumerate().map(|(i, r)| (r.id.clone(), i)).collect();
    let mut add_rel = |batch: &mut AnalysisBatch, r: Relationship| {
        // The same edge can be emitted once per call site. The store keeps only the first row for an id, so
        // merge the evidence into the row already held instead of dropping it (evidence ids are content-addressed).
        match rel_ids.get(&r.id).copied() {
            Some(i) => { let existing = &mut batch.relationships[i]; for ev in r.evidence { if !existing.evidence.iter().any(|e| e.id == ev.id) { existing.evidence.push(ev); } } }
            None => { rel_ids.insert(r.id.clone(), batch.relationships.len()); batch.relationships.push(r); }
        }
    };

    let mut pending_reads: Vec<(String, String, String, String, Option<String>, usize, usize)> = Vec::new();
    let mut pubs: Vec<(String, String, EvidenceRef)> = Vec::new();
    let mut subs: Vec<(String, String, EvidenceRef)> = Vec::new();
    for fi in 0..recs.len() {
        let rec = &recs[fi];
        let fid = format!("file:{}", rec.rel);
        // local name -> (target file idx, imported name)
        let mut bindings: HashMap<String, (usize, String)> = HashMap::new();

        for imp in &rec.raw.imports {
            let ev = evidence(&rec.rel, &rec.hash, imp.start, imp.end, "STATIC_RESOLVED");
            let (resolved, imp_name) = if let Some(m) = imp.module.strip_prefix("java:") {
                (java_by_suffix.get(&format!("{}.java", m.replace('.', "/"))).copied(), imp.imported.clone())
            } else if let Some(m) = imp.module.strip_prefix("go:") {
                // The longest tail of the import path that names a directory in this repository; the rest is the module path.
                let segs: Vec<&str> = m.split('/').collect();
                ((0..segs.len()).find_map(|k| go_dir_by_suffix.get(&segs[k..].join("/")).copied()), imp.imported.clone())
            } else if let Some(m) = imp.module.strip_prefix("py:") {
                // `from a import b` may name a module (a/b.py) rather than something inside a: prefer the module.
                let sub = if imp.imported != "*" { resolve_py(&rec.rel, &format!("{m}.{}", imp.imported), &known_files, &py_by_suffix) } else { None };
                match sub { Some(t) => (Some(t), "*".to_string()), None => (resolve_py(&rec.rel, m, &known_files, &py_by_suffix), imp.imported.clone()) }
            } else { (resolve_module(&rec.rel, &imp.module, &known_files), imp.imported.clone()) };
            match resolved {
                Some(ti) => {
                    let tgt = &recs[ti];
                    add_rel(
                        &mut batch,
                        Relationship {
                            id: format!("rel:imports:{}->{}", rec.rel, tgt.rel),
                            from: fid.clone(),
                            to: format!("file:{}", tgt.rel),
                            kind: "imports".into(),
                            evidence: vec![ev],
                            resolution: "RESOLVED",
                            label: None,
                        },
                    );
                    if !imp.local.is_empty() {
                        bindings.insert(imp.local.clone(), (ti, imp_name));
                    }
                }
                None if imp.module.starts_with('.') || imp.module.starts_with("py:.") => batch.facts.push(Fact {
                    id: format!("fact:unresolved-import:{}:{}", rec.rel, imp.start),
                    subject: fid.clone(),
                    predicate: "imports".into(),
                    object: json!({"kind":"UnknownValue","reason":format!("cannot resolve relative module {}", imp.module)}),
                    evidence: vec![evidence(&rec.rel, &rec.hash, imp.start, imp.end, "STATIC_PARSED")],
                    resolution: "UNRESOLVED",
                }),
                None => batch.facts.push(Fact {
                    id: format!("fact:external-import:{}:{}", rec.rel, imp.module),
                    subject: fid.clone(),
                    predicate: "imports_external".into(),
                    object: json!({"kind":"ScalarValue","value":imp.module.split_once(':').filter(|(p, _)| matches!(*p, "java" | "go" | "py")).map_or(imp.module.as_str(), |(_, m)| m)}),
                    evidence: vec![evidence(&rec.rel, &rec.hash, imp.start, imp.end, "STATIC_PARSED")],
                    resolution: "PARSED",
                }),
            }
        }

        for call in &rec.raw.calls {
            let from = match call.caller {
                Some(i) => rec.ids[i].clone(),
                None => fid.clone(),
            };
            let caller_class = call
                .caller
                .and_then(|i| rec.raw.symbols[i].qualified.split_once('.').map(|(c, _)| c.to_string()));

            let typed: Option<(String, &'static str)> = call.recv_type.as_deref().and_then(|t| {
                // `pkg.Type` (Go): the package names an import, the type is in that package's files.
                if let Some((pkg, ty)) = t.split_once('.') {
                    return bindings.get(pkg).and_then(|(ti, _)| find_member_pkg(*ti, ty, &call.callee)).map(|x| (x, "STATIC_RESOLVED"));
                }
                // The receiver's declared type names a class: this file, an imported file, or a file of the same package.
                let via_binding = bindings.get(t).and_then(|(ti, _)| find_member_pkg(*ti, t, &call.callee));
                via_binding.or_else(|| find_member_pkg(fi, t, &call.callee)).map(|x| (x, "STATIC_RESOLVED"))
            });
            let target: Option<(String, &'static str)> = if typed.is_some() { typed } else { match call.receiver.as_deref() {
                None => bindings
                    .get(&call.callee)
                    .and_then(|(ti, imported)| {
                        let name = if imported == "default" || imported == "*" { &call.callee } else { imported };
                        find_symbol(*ti, name).or_else(|| find_symbol(*ti, &call.callee))
                    })
                    .or_else(|| find_symbol_pkg(fi, &call.callee))
                    .map(|t| (t, "STATIC_RESOLVED")),
                Some("this" | "self") => caller_class.and_then(|c| {
                    let q = format!("{c}.{}", call.callee);
                    rec.raw.symbols.iter().position(|s| s.qualified == q).map(|i| (rec.ids[i].clone(), "STATIC_RESOLVED"))
                }).or_else(|| if rec.rel.ends_with(".java") { find_symbol_pkg(fi, &call.callee).map(|t| (t, "STATIC_RESOLVED")) } else { None }),
                Some(recv) => bindings.get(recv).and_then(|(ti, imported)| {
                    // namespace import: ns.fn()
                    (imported == "*").then(|| find_symbol_pkg(*ti, &call.callee)).flatten().map(|t| (t, "STATIC_RESOLVED"))
                }),
            } };

            match target {
                Some((to, class)) if to != from => add_rel(
                    &mut batch,
                    Relationship {
                        id: format!("rel:calls:{from}->{to}"),
                        from,
                        to,
                        kind: "calls".into(),
                        evidence: vec![evidence(&rec.rel, &rec.hash, call.start, call.end, class)],
                        resolution: "RESOLVED",
                        label: None,
                    },
                ),
                Some(_) => {}
                None => {
                    let label = match &call.receiver {
                        Some(r) => format!("{r}.{}", call.callee),
                        None => call.callee.clone(),
                    };
                    batch.facts.push(Fact {
                        id: format!("fact:unresolved-call:{}:{}", rec.rel, call.start),
                        subject: from,
                        predicate: "calls".into(),
                        object: json!({"kind":"UnknownValue","reason":format!("cannot statically resolve call to {label}")}),
                        evidence: vec![evidence(&rec.rel, &rec.hash, call.start, call.end, "STATIC_PARSED")],
                        resolution: "UNRESOLVED",
                    });
                }
            }
        }

        // UML heritage is emitted only when the declared target resolves statically.
        for h in &rec.raw.heritage {
            let Some(from) = rec.ids.get(h.owner).cloned() else { continue };
            let in_file = rec.raw.symbols.iter().position(|s| s.qualified == h.target && matches!(s.kind, "class" | "interface" | "enum")).map(|i| rec.ids[i].clone());
            let to = in_file
                .or_else(|| bindings.get(&h.target).and_then(|(ti, imported)| {
                    let name = if imported == "default" || imported == "*" { h.target.as_str() } else { imported };
                    find_symbol(*ti, name)
                }))
                .or_else(|| find_symbol_pkg(fi, &h.target));
            match to {
                Some(to) if to != from => add_rel(&mut batch, Relationship {
                    id: format!("rel:{}:{from}->{to}", h.rel), from, to,
                    kind: h.rel.to_string(),
                    evidence: vec![evidence(&rec.rel, &rec.hash, h.start, h.end, "STATIC_RESOLVED")],
                    resolution: "RESOLVED", label: None,
                }),
                Some(_) => {}
                None => batch.facts.push(Fact {
                    id: format!("fact:unresolved-{}:{}:{}", h.rel, rec.rel, h.start),
                    subject: from, predicate: h.rel.to_string(),
                    object: json!({"kind":"UnknownValue","reason":format!("cannot statically resolve {} target {}", h.rel, h.target)}),
                    evidence: vec![evidence(&rec.rel, &rec.hash, h.start, h.end, "STATIC_PARSED")],
                    resolution: "UNRESOLVED",
                }),
            }
        }

        // Field types become associations only when their target is a known symbol.
        for ft in &rec.raw.field_types {
            let Some(field_id) = rec.ids.get(ft.field).cloned() else { continue };
            let Some(field_sym) = rec.raw.symbols.get(ft.field) else { continue };
            let Some((cls, _)) = field_sym.qualified.split_once('.') else { continue };
            let from = rec.raw.symbols.iter().position(|s| s.qualified == cls && matches!(s.kind, "class" | "interface")).map(|i| rec.ids[i].clone()).unwrap_or(field_id);
            let (mult, target) = multiplicity_of(&ft.type_text);
            if target.is_empty() { continue; }
            let in_file = rec.raw.symbols.iter().position(|s| s.qualified == target && matches!(s.kind, "class" | "interface" | "enum")).map(|i| rec.ids[i].clone());
            let to = in_file
                .or_else(|| bindings.get(&target).and_then(|(ti, imported)| {
                    let name = if imported == "default" || imported == "*" { target.as_str() } else { imported };
                    find_symbol(*ti, name)
                }))
                .or_else(|| find_symbol_pkg(fi, &target));
            match to {
                Some(to) if to != from => add_rel(&mut batch, Relationship {
                    id: format!("rel:association:{from}->{to}:{mult}"), from, to,
                    kind: "association".into(),
                    evidence: vec![evidence(&rec.rel, &rec.hash, ft.start, ft.end, "STATIC_RESOLVED")],
                    resolution: "RESOLVED", label: Some(mult.to_string()),
                }),
                Some(_) => {}
                None => batch.facts.push(Fact {
                    id: format!("fact:unresolved-assoc:{}:{}", rec.rel, ft.start),
                    subject: from, predicate: "association".into(),
                    object: json!({"kind":"UnknownValue","reason":format!("cannot statically resolve association target {target}")}),
                    evidence: vec![evidence(&rec.rel, &rec.hash, ft.start, ft.end, "STATIC_PARSED")],
                    resolution: "UNRESOLVED",
                }),
            }
        }

        for sig in &rec.raw.signatures {
            if let Some(subject) = rec.ids.get(sig.method) {
                batch.facts.push(Fact {
                    id: format!("fact:signature:{subject}"), subject: subject.clone(), predicate: "signature".into(),
                    object: json!({"kind":"ScalarValue","value":sig.text}),
                    evidence: vec![evidence(&rec.rel, &rec.hash, sig.start, sig.end, "STATIC_PARSED")],
                    resolution: "PARSED",
                });
            }
        }

        // Behavioral facts: where code can fail, write state, run in a transaction, or cross async boundaries.
        let subject_of = |caller: Option<usize>| match caller {
            Some(i) => rec.ids[i].clone(),
            None => fid.clone(),
        };
        for event in &rec.raw.semantic {
            batch.facts.push(Fact {
                id: format!("fact:defect:{}:{}", rec.rel, event.start),
                subject: subject_of(event.caller), predicate: "defect.semantic-event.v1".into(),
                object: event.value.clone(),
                evidence: vec![evidence(&rec.rel, &rec.hash, event.start, event.end, "STATIC_PARSED")],
                resolution: "PARSED",
            });
        }
        for metric in &rec.raw.metrics {
            batch.facts.push(Fact {
                id: format!("fact:metric:{}:{}", rec.rel, metric.start),
                subject: subject_of(metric.caller), predicate: "metric_declaration".into(),
                object: json!({"kind":"ScalarValue","value":metric.name,"metricKind":metric.kind}),
                evidence: vec![evidence(&rec.rel, &rec.hash, metric.start, metric.end, "STATIC_PARSED")],
                resolution: "PARSED",
            });
        }
        // A field access is qualified by its receiver when one is statically present (`account.balance`,
        // `self.balance` → the enclosing class), so two unrelated same-named fields stay distinct.
        // Receiver-free writes (object literals, bare identifiers) keep the bare name.
        let qualifier_of = |caller: Option<usize>, receiver: &Option<String>| -> Option<String> {
            let r = receiver.as_ref()?.trim();
            if r.is_empty() { return None; }
            if r == "this" || r == "self" {
                let cls = caller.and_then(|i| rec.raw.symbols[i].qualified.split('.').next().map(String::from));
                return Some(cls.unwrap_or_else(|| r.to_string()));
            }
            Some(r.split('.').next_back().unwrap_or(r).to_string())
        };
        for t in &rec.raw.throws {
            batch.facts.push(Fact {
                id: format!("fact:throws:{}:{}", rec.rel, t.start),
                subject: subject_of(t.caller),
                predicate: "throws".into(),
                object: json!({"kind":"ScalarValue","value":t.error_class}),
                evidence: vec![evidence(&rec.rel, &rec.hash, t.start, t.end, "STATIC_PARSED")],
                resolution: "PARSED",
            });
        }
        for w in &rec.raw.writes {
            let q = qualifier_of(w.caller, &w.receiver);
            batch.facts.push(Fact {
                id: format!("fact:writes:{}:{}", rec.rel, w.start),
                subject: subject_of(w.caller),
                predicate: "writes".into(),
                object: json!({"kind":"ScalarValue","value":w.field,"qualifier":q}),
                evidence: vec![evidence(&rec.rel, &rec.hash, w.start, w.end, "STATIC_PARSED")],
                resolution: "PARSED",
            });
        }
        for rd in &rec.raw.reads {
            // Reads are only meaningful for state that is written somewhere in the repository; filtered after all files are seen.
            pending_reads.push((rec.rel.clone(), rec.hash.clone(), subject_of(rd.caller), rd.field.clone(), qualifier_of(rd.caller, &rd.receiver), rd.start, rd.end));
        }
        for t in &rec.raw.txs {
            batch.facts.push(Fact {
                id: format!("fact:tx:{}:{}", rec.rel, t.start),
                subject: subject_of(t.caller),
                predicate: "uses_transaction".into(),
                object: json!({"kind":"ScalarValue","value":true}),
                evidence: vec![evidence(&rec.rel, &rec.hash, t.start, t.end, "STATIC_PARSED")],
                resolution: "PARSED",
            });
        }
        for l in &rec.raw.locks {
            batch.facts.push(Fact {
                id: format!("fact:uses_lock:{}:{}", rec.rel, l.start),
                subject: subject_of(l.caller),
                predicate: "uses_lock".into(),
                object: json!({"kind":"ScalarValue","value":l.object}),
                evidence: vec![evidence(&rec.rel, &rec.hash, l.start, l.end, "STATIC_PARSED")],
                resolution: "PARSED",
            });
        }
        for ch in &rec.raw.channels {
            let who = subject_of(ch.caller);
            let ev = evidence(&rec.rel, &rec.hash, ch.start, ch.end, "STATIC_PARSED");
            batch.facts.push(Fact {
                id: format!("fact:{}:{}:{}", ch.role, rec.rel, ch.start),
                subject: who.clone(),
                predicate: if ch.role == "publish" { "publishes".into() } else { "subscribes".into() },
                object: json!({"kind":"ScalarValue","value":ch.topic}),
                evidence: vec![ev.clone()],
                resolution: "PARSED",
            });
            if ch.role == "publish" {
                pubs.push((ch.topic.clone(), who, ev));
            } else {
                // The subscriber's target is the named handler if it resolves, else the registering function.
                let target = ch
                    .handler
                    .as_ref()
                    .and_then(|h| {
                        bindings
                            .get(h)
                            .and_then(|(ti, imported)| find_symbol(*ti, if imported == "default" { h } else { imported }))
                            .or_else(|| find_symbol(fi, h))
                    })
                    .unwrap_or(who);
                subs.push((ch.topic.clone(), target, ev));
            }
        }
    }

    // Framework metadata resolution: turn plugin output into typed Entity/Fact/Relationship rows.
    // This runs before the per-file call-resolution loop so that framework relationships (injects,
    // exposes_route, uses_transaction) are available to the rest of the pipeline.
    resolve_framework_metadata(&mut batch, &recs, &known_files, &evidence, &span);

    // Join publishers to subscribers by literal topic. This is a string-key join, so it stays PARSED.
    for (topic, from, pev) in &pubs {
        for (t2, to, sev) in &subs {
            if topic == t2 && from != to {
                add_rel(
                    &mut batch,
                    Relationship {
                        id: format!("rel:async:{topic}:{from}->{to}"),
                        from: from.clone(),
                        to: to.clone(),
                        kind: "async-flow".into(),
                        evidence: vec![pev.clone(), sev.clone()],
                        resolution: "PARSED",
                        label: Some(format!("topic \"{topic}\"")),
                    },
                );
            }
        }
    }

    // Keep reads of fields that some function writes (the data-lineage view needs both sides), one fact per reader and field.
    let written: std::collections::HashSet<String> = batch.facts.iter().filter(|f| f.predicate == "writes").filter_map(|f| f.object["value"].as_str().map(String::from)).collect();
    let mut seen_reads: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for (rel, hash, subject, field, qualifier, start, end) in pending_reads {
        if !written.contains(&field) || !seen_reads.insert((subject.clone(), field.clone())) {
            continue;
        }
        batch.facts.push(Fact {
            id: format!("fact:reads:{rel}:{start}"),
            subject,
            predicate: "reads".into(),
            object: json!({"kind":"ScalarValue","value":field,"qualifier":qualifier}),
            evidence: vec![evidence(&rel, &hash, start, end, "STATIC_PARSED")],
            resolution: "PARSED",
        });
    }

    // Git history (HISTORY evidence), when the root is inside a work tree.
    timing("graph (before history)", t_graph);
    let t_hist = std::time::Instant::now();
    let hist_map = git_history(&root);
    timing("git history", t_hist);
    for (rel, h) in hist_map {
        if !known_files.contains_key(&rel) {
            continue;
        }
        let ev = EvidenceRef {
            id: format!("ev:{}", &sha(format!("history:{rel}:{}", h.last_commit).as_bytes())[..16]),
            source_id: rel.clone(),
            location: json!({"kind":"DocumentLocation","documentId":h.last_commit,"version":h.last_date,
                "locator":format!("{rel}: {} commit(s); last by {} — {}", h.commits, h.last_author, h.last_subject)}),
            class: "HISTORY",
            observed_at: h.last_date.clone(),
            access_scope_id: "local".into(),
            state: "CURRENT",
        };
        batch.facts.push(Fact {
            id: format!("fact:history:{rel}"),
            subject: format!("file:{rel}"),
            predicate: "history".into(),
            object: json!({"kind":"ScalarValue","value":{"commits":h.commits,"lastCommit":h.last_commit,"lastAuthor":h.last_author,
                "lastDate":h.last_date,"lastSubject":h.last_subject,"authors":h.authors}}),
            evidence: vec![ev],
            resolution: "OBSERVED",
        });
    }
    let t_shard = std::time::Instant::now();
    merge_duplicate_rows(&mut batch);
    shard(&mut batch, base);
    timing("shard digests + delta", t_shard);
    timing("total index_repo", t_all);
    Ok(batch)
}

/// Rows with the same id are one row: the same edge seen from two call sites, or the same fact emitted twice.
/// Their evidence is merged, deduplicated by content-addressed evidence id; the store keeps only the first
/// row it is given for an id, so any evidence dropped here would be lost from views and claim cards.
fn merge_duplicate_rows(batch: &mut AnalysisBatch) {
    fn merge_evidence(into: &mut Vec<EvidenceRef>, extra: Vec<EvidenceRef>) {
        for ev in extra { if !into.iter().any(|e| e.id == ev.id) { into.push(ev); } }
    }
    let mut rel_index: HashMap<String, usize> = HashMap::new();
    let mut rels: Vec<Relationship> = Vec::with_capacity(batch.relationships.len());
    for r in batch.relationships.drain(..) {
        match rel_index.get(&r.id).copied() {
            Some(i) => merge_evidence(&mut rels[i].evidence, r.evidence),
            None => { rel_index.insert(r.id.clone(), rels.len()); rels.push(r); }
        }
    }
    batch.relationships = rels;
    let mut fact_index: HashMap<String, usize> = HashMap::new();
    let mut facts: Vec<Fact> = Vec::with_capacity(batch.facts.len());
    for f in batch.facts.drain(..) {
        match fact_index.get(&f.id).copied() {
            Some(i) => merge_evidence(&mut facts[i].evidence, f.evidence),
            None => { fact_index.insert(f.id.clone(), facts.len()); facts.push(f); }
        }
    }
    batch.facts = facts;
}

struct History {
    commits: usize,    last_commit: String,
    last_author: String,
    last_date: String,
    last_subject: String,
    authors: usize,
}

/// `git log --name-only` aggregated per file. Empty when not a git work tree.
fn git_history(root: &Path) -> HashMap<String, History> {
    let run = |args: &[&str]| {
        std::process::Command::new("git").arg("-C").arg(root).args(args).output().ok().filter(|o| o.status.success())
    };
    let mut out: HashMap<String, History> = HashMap::new();
    let Some(prefix) = run(&["rev-parse", "--show-prefix"]) else { return out };
    let prefix = String::from_utf8_lossy(&prefix.stdout).trim().to_string();
    let Some(log) = run(&["log", "--name-only", "--no-renames", "-n", "500", "--pretty=format:@@%H|%an|%aI|%s"]) else { return out };
    let text = String::from_utf8_lossy(&log.stdout).to_string();
    let mut authors: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
    let mut cur: Option<(String, String, String, String)> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("@@") {
            let mut p = rest.splitn(4, '|');
            cur = Some((p.next().unwrap_or("").into(), p.next().unwrap_or("").into(), p.next().unwrap_or("").into(), p.next().unwrap_or("").into()));
        } else if !line.trim().is_empty() {
            let (Some((h, a, d, subj)), Some(rel)) = (&cur, line.strip_prefix(prefix.as_str())) else { continue };
            authors.entry(rel.to_string()).or_default().insert(a.clone());
            let e = out.entry(rel.to_string()).or_insert_with(|| History {
                commits: 0,
                last_commit: h.clone(), // log is newest-first, so the first sighting is the latest
                last_author: a.clone(),
                last_date: d.clone(),
                last_subject: subj.clone(),
                authors: 0,
            });
            e.commits += 1;
        }
    }
    for (k, v) in out.iter_mut() {
        v.authors = authors.get(k).map_or(0, |s| s.len());
    }
    out
}

fn resolve_module(from_rel: &str, module: &str, known: &HashMap<String, usize>) -> Option<usize> {
    if let Some(path) = module.strip_prefix("crate::") {
        let base = path.replace("::", "/");
        return rust_module_candidates(&base, known);
    }
    if let Some(path) = module.strip_prefix("self::") {
        let dir = Path::new(from_rel).parent().unwrap_or(Path::new(""));
        let base = dir.join(path.replace("::", "/")).to_string_lossy().replace('\\', "/");
        return rust_module_candidates(&base, known);
    }
    if let Some(path) = module.strip_prefix("super::") {
        let dir = Path::new(from_rel).parent().and_then(Path::parent).unwrap_or(Path::new(""));
        let base = dir.join(path.replace("::", "/")).to_string_lossy().replace('\\', "/");
        return rust_module_candidates(&base, known);
    }
    if !module.starts_with('.') { return None; }
    let dir = Path::new(from_rel).parent().unwrap_or(Path::new(""));
    let mut parts: Vec<String> = dir.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    for seg in module.split('/') {
        match seg {
            "." | "" => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s.to_string()),
        }
    }
    let base = parts.join("/");
    let stripped = base.trim_end_matches(".js").trim_end_matches(".jsx").to_string();
    let mut cands = vec![];
    for b in [&base, &stripped] {
        for ext in ["", ".ts", ".tsx", ".mts", ".cts", ".rs", ".nir"] {
            cands.push(format!("{b}{ext}"));
        }
        for ext in ["ts", "tsx", "rs", "nir"] {
            cands.push(format!("{b}/index.{ext}"));
        }
    }
    cands.into_iter().find_map(|c| known.get(&c).copied())
}

/// Python modules: `a.b` is `a/b.py` or `a/b/__init__.py` from the repository root, from `src/`, or from the importing file's own
/// directory; leading dots climb from the importing file's directory.
fn resolve_py(from_rel: &str, module: &str, known: &HashMap<String, usize>, by_suffix: &HashMap<String, usize>) -> Option<usize> {
    let dots = module.chars().take_while(|c| *c == '.').count();
    let rest = module.trim_start_matches('.').replace('.', "/");
    let dir = Path::new(from_rel).parent().unwrap_or(Path::new(""));
    let mut bases: Vec<String> = vec![];
    if dots > 0 {
        let mut d = dir.to_path_buf();
        for _ in 1..dots { d = d.parent().map(Path::to_path_buf).unwrap_or_default(); }
        bases.push(d.join(&rest).to_string_lossy().replace('\\', "/"));
    } else {
        bases.push(rest.clone());
        bases.push(format!("src/{rest}"));
        bases.push(dir.join(&rest).to_string_lossy().replace('\\', "/"));
    }
    for b in bases {
        let b = b.trim_start_matches('/').to_string();
        for c in [format!("{b}.py"), format!("{b}/__init__.py")] { if let Some(i) = known.get(&c) { return Some(*i); } }
    }
    // An absolute import is relative to some source root that is not named: `app.util` is `<root>/app/util.py` wherever the root is.
    if dots == 0 { for c in [format!("{rest}.py"), format!("{rest}/__init__.py")] { if let Some(i) = by_suffix.get(&c) { return Some(*i); } } }
    None
}

fn rust_module_candidates(base: &str, known: &HashMap<String, usize>) -> Option<usize> {
    let roots = if base.starts_with("src/") { vec![base.to_string()] } else { vec![format!("src/{base}"), base.to_string()] };
    roots.into_iter().flat_map(|b| [format!("{b}.rs"), format!("{b}.nir"), format!("{b}/mod.rs"), format!("{b}/mod.nir")])
        .find_map(|c| known.get(&c).copied())
}

fn resolve_framework_metadata<E, S>(
    batch: &mut AnalysisBatch,
    recs: &[FileRec],
    known_files: &HashMap<String, usize>,
    evidence: E,
    span: S,
)
where
    E: Fn(&str, &str, usize, usize, &'static str) -> EvidenceRef,
    S: Fn(&str, &str, usize, usize) -> SourceSpan,
{
    // Build a map: simple class name -> file index where a class/interface of that short name is declared.
    let mut class_to_file: HashMap<String, usize> = HashMap::new();
    for (fi, rec) in recs.iter().enumerate() {
        for s in &rec.raw.symbols {
            if s.kind == "class" || s.kind == "interface" {
                let short = s.qualified.split('.').next().unwrap_or(&s.qualified).to_string();
                class_to_file.entry(short).or_insert(fi);
            }
        }
    }

    fn pkg_lang(rel: &str) -> bool { rel.ends_with(".go") || rel.ends_with(".java") }
    fn dir_of(rel: &str) -> String {
        let d = rel.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
        if rel.ends_with(".java") {
            for root in ["/src/main/java/", "/src/test/java/"] { if let Some((pre, post)) = d.split_once(root.trim_end_matches('/')) { return format!("{pre}|{}", post.trim_start_matches('/')); } }
            for root in ["src/main/java", "src/test/java"] { if let Some(post) = d.strip_prefix(root) { return format!("|{}", post.trim_start_matches('/')); } }
        }
        d
    }
    let mut dir_files: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, r) in recs.iter().enumerate() { if pkg_lang(&r.rel) { dir_files.entry(dir_of(&r.rel)).or_default().push(i); } }
    let siblings = |file_idx: usize| -> Vec<usize> {
        let r = &recs[file_idx].rel;
        if pkg_lang(r) { dir_files.get(&dir_of(r)).cloned().unwrap_or_default() } else { vec![file_idx] }
    };
    fn find_symbol(recs: &[FileRec], file_idx: usize, name: &str) -> Option<String> {
        let r = &recs[file_idx];
        r.raw.symbols.iter().position(|s| s.qualified == name && s.kind != "method").map(|i| r.ids[i].clone())
    }
    fn find_symbol_pkg(recs: &[FileRec], file_idx: usize, name: &str, siblings: &dyn Fn(usize) -> Vec<usize>) -> Option<String> {
        find_symbol(recs, file_idx, name).or_else(|| siblings(file_idx).into_iter().filter(|i| *i != file_idx).find_map(|i| find_symbol(recs, i, name)))
    }

    let resolve_type = |fi: usize, ty: &str, recs: &[FileRec], class_to_file: &HashMap<String, usize>, siblings: &dyn Fn(usize) -> Vec<usize>| -> Option<String> {
        let simple = ty.split('<').next().unwrap_or(ty).rsplit('.').next().unwrap_or(ty).trim();
        // Prefer same package.
        for si in siblings(fi) {
            if let Some(id) = find_symbol(recs, si, simple) { return Some(id); }
        }
        // Then any file.
        let fi = class_to_file.get(simple)?;
        find_symbol(recs, *fi, simple)
    };

    let resolve_name = |fi: usize, name: &str, recs: &[FileRec], class_to_file: &HashMap<String, usize>, siblings: &dyn Fn(usize) -> Vec<usize>| -> Option<String> {
        let simple = name.split('<').next().unwrap_or(name).rsplit('.').next().unwrap_or(name).trim();
        for si in siblings(fi) {
            if let Some(id) = find_symbol(recs, si, simple) { return Some(id); }
        }
        let fi = class_to_file.get(simple)?;
        find_symbol(recs, *fi, simple)
    };

    fn public_kind(framework: &str, kind: FrameworkEntityKind) -> String {
        if kind == FrameworkEntityKind::PersistenceEntity { return "table".into(); }
        if kind == FrameworkEntityKind::PersistenceColumn { return "column".into(); }
        let fw_slug = framework.replace('-', "_");
        let kind_suffix = match kind {
            FrameworkEntityKind::GatewayRoute => "route",
            FrameworkEntityKind::GatewayFilter => "filter",
            _ => kind.as_str(),
        };
        format!("{}_{}", fw_slug, kind_suffix)
    }

    // First pass: emit framework entities and remember their id mapping.
    let mut framework_entity_id: HashMap<String, String> = HashMap::new();
    for (fi, rec) in recs.iter().enumerate() {
        let fid = format!("file:{}", rec.rel);
        for m in &rec.raw.framework_metadata {
            let entity_id = match m.kind {
                FrameworkEntityKind::Controller | FrameworkEntityKind::Provider | FrameworkEntityKind::Guard | FrameworkEntityKind::Module => {
                    // Module-member provider rows (e.g., controllers/providers/imports/exports of a NestJS module)
                    // may reference classes declared in other files. Resolve them by name when there is no local symbol.
                    let is_module_member = m.kind == FrameworkEntityKind::Provider && m.properties.get("relation").is_some();
                    let subject = if is_module_member {
                        resolve_name(fi, &m.name, recs, &class_to_file, &siblings)
                            .or_else(|| m.subject_symbol.and_then(|i| rec.ids.get(i).cloned()))
                            .unwrap_or_else(|| fid.clone())
                    } else {
                        m.subject_symbol.and_then(|i| rec.ids.get(i).cloned()).unwrap_or_else(|| fid.clone())
                    };
                    framework_entity_id.insert(format!("{}:{}:{}", rec.rel, m.kind.as_str(), m.name), subject.clone());
                    subject
                }
                FrameworkEntityKind::Route | FrameworkEntityKind::MessageListener | FrameworkEntityKind::GatewayRoute | FrameworkEntityKind::GatewayFilter => {
                    let id = if matches!(m.kind, FrameworkEntityKind::GatewayRoute | FrameworkEntityKind::GatewayFilter) {
                        format!("{}:{}:{}:{}", m.framework, m.kind.as_str(), rec.rel, m.name)
                    } else {
                        format!("{}:{}:{}:{}", m.framework, m.kind.as_str(), rec.rel, m.start)
                    };
                    batch.entities.push(Entity {
                        entity_id: id.clone(),
                        kind: public_kind(m.framework, m.kind),
                        name: match m.kind {
                            FrameworkEntityKind::PersistenceEntity => m.properties.get("tableName").and_then(|v| v.as_str()).unwrap_or(&m.name).to_string(),
                            FrameworkEntityKind::PersistenceColumn => m.properties.get("columnName").and_then(|v| v.as_str()).unwrap_or(&m.name).to_string(),
                            _ => m.name.clone(),
                        },
                        file: rec.rel.clone(),
                        spans: vec![span(&rec.rel, &rec.hash, m.start, m.end)],
                        symbol_hash: None,
                    });
                    framework_entity_id.insert(format!("{}:{}:{}", rec.rel, m.kind.as_str(), m.name), id.clone());
                    id
                }
                FrameworkEntityKind::Inject | FrameworkEntityKind::Transaction | FrameworkEntityKind::ConfigValue => {
                    let subject = m.subject_symbol.and_then(|i| rec.ids.get(i).cloned()).unwrap_or_else(|| fid.clone());
                    framework_entity_id.insert(format!("{}:{}:{}", rec.rel, m.kind.as_str(), m.name), subject);
                    continue;
                }
                _ => {
                    let id = format!("{}:{}:{}:{}", m.framework, m.kind.as_str(), rec.rel, m.start);
                    batch.entities.push(Entity {
                        entity_id: id.clone(),
                        kind: public_kind(m.framework, m.kind),
                        name: m.name.clone(),
                        file: rec.rel.clone(),
                        spans: vec![span(&rec.rel, &rec.hash, m.start, m.end)],
                        symbol_hash: None,
                    });
                    framework_entity_id.insert(format!("{}:{}:{}", rec.rel, m.kind.as_str(), m.name), id.clone());
                    id
                }
            };

            if let Some(parent) = &m.parent {
                let parent_kind = match m.kind {
                    FrameworkEntityKind::Route => "controller",
                    FrameworkEntityKind::GatewayFilter => "gateway_route",
                    FrameworkEntityKind::MessageListener => "provider",
                    FrameworkEntityKind::PersistenceColumn => "table",
                    _ => "module",
                };
                let key = format!("{}:{}:{}", rec.rel, parent_kind, parent);
                let parent_id = framework_entity_id.get(&key).cloned()
                    .or_else(|| rec.raw.symbols.iter().position(|s| s.qualified == *parent || s.qualified.split('.').next() == Some(parent)).map(|i| rec.ids[i].clone()));
                if let Some(parent_id) = parent_id {
                    batch.relationships.push(Relationship {
                        id: format!("rel:framework:contains:{}->{}", parent_id, entity_id),
                        from: parent_id,
                        to: entity_id,
                        kind: "contains".into(),
                        evidence: vec![evidence(&rec.rel, &rec.hash, m.start, m.end, "STATIC_RESOLVED")],
                        resolution: "RESOLVED",
                        label: Some(m.kind.as_str().to_string()),
                    });
                }
            }
        }
    }

    // Map Java class symbols to their JPA table entities for cross-file association resolution.
    let mut persistence_table_by_class: HashMap<String, String> = HashMap::new();
    for rec in recs {
        for m in &rec.raw.framework_metadata {
            if m.kind != FrameworkEntityKind::PersistenceEntity { continue; }
            let Some(class_id) = m.subject_symbol.and_then(|i| rec.ids.get(i)).cloned() else { continue };
            if let Some(table_id) = framework_entity_id.get(&format!("{}:table:{}", rec.rel, m.name)) {
                persistence_table_by_class.insert(class_id, table_id.clone());
            }
        }
    }

    // Second pass: emit facts and relationships.
    for (fi, rec) in recs.iter().enumerate() {
        let fid = format!("file:{}", rec.rel);
        for m in &rec.raw.framework_metadata {
            let ev = evidence(&rec.rel, &rec.hash, m.start, m.end, "STATIC_RESOLVED");
            match m.kind {
                FrameworkEntityKind::PersistenceEntity => {
                    if let Some(subject) = framework_entity_id.get(&format!("{}:table:{}", rec.rel, m.name)).cloned() {
                        batch.facts.push(Fact {
                            id: format!("fact:persistence:table:{}:{}", rec.rel, m.start), subject,
                            predicate: "persisted_table".into(),
                            object: json!({"kind":"ScalarValue","value":m.properties.clone()}),
                            evidence: vec![evidence(&rec.rel, &rec.hash, m.start, m.end, "STATIC_PARSED")], resolution: "PARSED",
                        });
                    }
                }
                FrameworkEntityKind::PersistenceColumn => {
                    let column_id = framework_entity_id.get(&format!("{}:column:{}", rec.rel, m.name)).cloned();
                    if let Some(column_id) = column_id {
                        batch.facts.push(Fact {
                            id: format!("fact:persistence:column:{}:{}", rec.rel, m.start), subject: column_id,
                            predicate: "persisted_column".into(),
                            object: json!({"kind":"ScalarValue","value":m.properties.clone()}),
                            evidence: vec![evidence(&rec.rel, &rec.hash, m.start, m.end, "STATIC_PARSED")], resolution: "PARSED",
                        });
                    }
                    let owner_table = m.parent.as_ref().and_then(|parent| framework_entity_id.get(&format!("{}:table:{}", rec.rel, parent))).cloned();
                    let target_type = m.properties.get("targetType").and_then(|v| v.as_str()).unwrap_or("");
                    if !target_type.is_empty() {
                        let target_class = resolve_name(fi, target_type, recs, &class_to_file, &siblings);
                        let target_table = target_class.as_ref().and_then(|class| persistence_table_by_class.get(class)).cloned();
                        if let (Some(from), Some(to)) = (owner_table.clone(), target_table) {
                            if from != to {
                                let relation_kind = m.properties.get("relationKind").and_then(|v| v.as_str()).unwrap_or("association");
                                let cardinality = m.properties.get("cardinality").and_then(|v| v.as_str()).unwrap_or("1:N");
                                batch.relationships.push(Relationship {
                                    id: format!("rel:persistence:{}:{}->{}", rec.rel, m.start, to), from, to,
                                    kind: relation_kind.into(),
                                    evidence: vec![evidence(&rec.rel, &rec.hash, m.start, m.end, "STATIC_PARSED")],
                                    resolution: "PARSED",
                                    label: Some(m.properties.get("joinColumn").and_then(|v| v.as_str()).map(|fk| format!("{cardinality} · {fk}")).unwrap_or_else(|| cardinality.to_string())),
                                });
                            }
                        } else if m.properties.get("relationKind").is_some() {
                            if let Some(from) = owner_table {
                                batch.facts.push(Fact {
                                    id: format!("fact:unresolved-persistence:{}:{}", rec.rel, m.start), subject: from,
                                    predicate: "persistence_association".into(),
                                    object: json!({"kind":"UnknownValue","reason":format!("cannot resolve JPA target entity {target_type}")}),
                                    evidence: vec![evidence(&rec.rel, &rec.hash, m.start, m.end, "STATIC_PARSED")], resolution: "UNRESOLVED",
                                });
                            }
                        }
                    }
                }
                FrameworkEntityKind::Route => {
                    let subject = framework_entity_id.get(&format!("{}:route:{}", rec.rel, m.name)).cloned().unwrap_or_else(|| fid.clone());
                    let method = m.properties.get("method").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let path = m.properties.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let handler = m.properties.get("handler").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let kind = m.properties.get("kind").and_then(|v| v.as_str()).map(String::from);
                    let mut value = json!({"method":method,"path":path,"handler":handler});
                    if let Some(k) = kind {
                        value["kind"] = json!(k);
                    }
                    batch.facts.push(Fact {
                        id: format!("fact:route:{}:{}", rec.rel, m.start),
                        subject: subject.clone(),
                        predicate: "route".into(),
                        object: json!({"kind":"ScalarValue","value":value}),
                        evidence: vec![ev.clone()],
                        resolution: "STATIC_RESOLVED",
                    });
                    if let Some(parent) = &m.parent {
                        let parent_key = format!("{}:controller:{}", rec.rel, parent);
                        if let Some(parent_id) = framework_entity_id.get(&parent_key).cloned() {
                            batch.relationships.push(Relationship {
                                id: format!("rel:exposes_route:{}->{}", parent_id, subject),
                                from: parent_id,
                                to: subject,
                                kind: "exposes_route".into(),
                                evidence: vec![ev],
                                resolution: "STATIC_RESOLVED",
                                label: Some(format!("{} {}", method, path)),
                            });
                        }
                    }
                }
                FrameworkEntityKind::Inject => {
                    let target_name = m.properties.get("target").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let ty = m.properties.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let qualifier = m.properties.get("qualifier").and_then(|v| v.as_str());
                    let kind = m.properties.get("kind").and_then(|v| v.as_str()).unwrap_or("field").to_string();
                    let value = m.properties.get("value").cloned();
                    let subject = m.subject_symbol.and_then(|i| rec.ids.get(i).cloned()).unwrap_or_else(|| fid.clone());
                    let dependency = resolve_type(fi, &ty, recs, &class_to_file, &siblings);
                    batch.facts.push(Fact {
                        id: format!("fact:injected:{}:{}", rec.rel, m.start),
                        subject: subject.clone(),
                        predicate: "injected".into(),
                        object: json!({"kind":"ScalarValue","value":{"target":target_name,"type":ty,"qualifier":qualifier,"injectKind":kind,"value":value}}),
                        evidence: vec![ev.clone()],
                        resolution: "STATIC_RESOLVED",
                    });
                    if let Some(dep_id) = dependency {
                        batch.relationships.push(Relationship {
                            id: format!("rel:injects:{}->{}", subject, dep_id),
                            from: subject,
                            to: dep_id,
                            kind: "injects".into(),
                            evidence: vec![ev],
                            resolution: "STATIC_RESOLVED",
                            label: qualifier.map(|q| format!("@Qualifier(\"{}\")", q)),
                        });
                    }
                }
                FrameworkEntityKind::Transaction => {
                    let subject = m.subject_symbol.and_then(|i| rec.ids.get(i).cloned()).unwrap_or_else(|| fid.clone());
                    let source = m.properties.get("source").and_then(|v| v.as_str()).unwrap_or("class").to_string();
                    let is_constructor = m.properties.get("constructor").and_then(|v| v.as_bool()).unwrap_or(false);
                    batch.facts.push(Fact {
                        id: format!("fact:framework:tx:{}:{}", rec.rel, m.start),
                        subject: subject.clone(),
                        predicate: "uses_transaction".into(),
                        object: json!({"kind":"ScalarValue","value":true,"framework":"spring","source":source,"constructor":is_constructor}),
                        evidence: vec![ev],
                        resolution: "STATIC_RESOLVED",
                    });
                }
                FrameworkEntityKind::Provider | FrameworkEntityKind::Controller | FrameworkEntityKind::Guard | FrameworkEntityKind::Interceptor | FrameworkEntityKind::Module => {
                    // Skip module-member provider rows (they only exist to build module contains edges).
                    let is_module_member = m.kind == FrameworkEntityKind::Provider && m.properties.get("relation").is_some();
                    if is_module_member { continue; }
                    let subject = m.subject_symbol.and_then(|i| rec.ids.get(i).cloned()).unwrap_or_else(|| fid.clone());
                    batch.facts.push(Fact {
                        id: format!("fact:framework:{}:{}:{}", m.kind.as_str(), rec.rel, m.start),
                        subject,
                        predicate: "framework_role".into(),
                        object: json!({"kind":"ScalarValue","value":{"framework":m.framework,"role":m.kind.as_str(),"name":m.name,"properties":m.properties}}),
                        evidence: vec![ev],
                        resolution: "STATIC_RESOLVED",
                    });
                }
                FrameworkEntityKind::GatewayRoute => {
                    let subject = framework_entity_id.get(&format!("{}:gateway_route:{}", rec.rel, m.name)).cloned().unwrap_or_else(|| fid.clone());
                    let id = m.properties.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let uri = m.properties.get("uri").and_then(|v| v.as_str()).map(String::from);
                    let predicates = m.properties.get("predicates").cloned().unwrap_or(serde_json::Value::Null);
                    let filters = m.properties.get("filters").cloned().unwrap_or(serde_json::Value::Null);
                    batch.facts.push(Fact {
                        id: format!("fact:gateway_route:{}:{}", rec.rel, m.name),
                        subject: subject.clone(),
                        predicate: "gateway_route".into(),
                        object: json!({"kind":"ScalarValue","value":{"id":id,"uri":uri,"predicates":predicates,"filters":filters}}),
                        evidence: vec![ev],
                        resolution: "STATIC_RESOLVED",
                    });
                }
                FrameworkEntityKind::GatewayFilter => {
                    let subject = framework_entity_id.get(&format!("{}:gateway_filter:{}", rec.rel, m.name)).cloned().unwrap_or_else(|| fid.clone());
                    let name = m.properties.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let args = m.properties.get("args").cloned().unwrap_or(serde_json::Value::Null);
                    batch.facts.push(Fact {
                        id: format!("fact:gateway_filter:{}:{}", rec.rel, m.name),
                        subject: subject.clone(),
                        predicate: "gateway_filter".into(),
                        object: json!({"kind":"ScalarValue","value":{"name":name,"args":args}}),
                        evidence: vec![ev.clone()],
                        resolution: "STATIC_RESOLVED",
                    });
                    // Custom GatewayFilter classes also carry a framework_role fact so guard/permission tooling can consume them uniformly.
                    if m.subject_symbol.is_some() {
                        batch.facts.push(Fact {
                            id: format!("fact:framework:gateway_filter:{}:{}", rec.rel, m.name),
                            subject: subject.clone(),
                            predicate: "framework_role".into(),
                            object: json!({"kind":"ScalarValue","value":{"framework":m.framework,"role":"gateway_filter","name":m.name,"properties":m.properties}}),
                            evidence: vec![ev.clone()],
                            resolution: "STATIC_RESOLVED",
                        });
                    }
                    if let Some(parent) = &m.parent {
                        let parent_key = format!("{}:gateway_route:{}", rec.rel, parent);
                        if let Some(parent_id) = framework_entity_id.get(&parent_key).cloned() {
                            batch.relationships.push(Relationship {
                                id: format!("rel:uses_filter:{}->{}", parent_id, subject),
                                from: parent_id,
                                to: subject,
                                kind: "uses_filter".into(),
                                evidence: vec![ev],
                                resolution: "STATIC_RESOLVED",
                                label: Some(name),
                            });
                        }
                    }
                }
                FrameworkEntityKind::ConfigValue => {
                    let key = m.properties.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let value = m.properties.get("value").cloned().unwrap_or(serde_json::Value::Null);
                    let source = m.properties.get("source").and_then(|v| v.as_str()).unwrap_or("config").to_string();
                    let is_secret = key.to_ascii_uppercase().contains("TOKEN") || key.to_ascii_uppercase().contains("PASSWORD") || key.to_ascii_uppercase().contains("SECRET") || key.to_ascii_uppercase().contains("KEY");
                    let redacted = if is_secret { serde_json::Value::String("***".to_string()) } else { value.clone() };
                    batch.facts.push(Fact {
                        id: format!("fact:config_value:{}:{}:{}", rec.rel, m.name, m.start),
                        subject: fid.clone(),
                        predicate: "config_value".into(),
                        object: json!({"kind":"ScalarValue","value":{"key":key,"source":source,"redacted":redacted,"has_secret":is_secret}}),
                        evidence: vec![ev],
                        resolution: "STATIC_RESOLVED",
                    });
                    // Emit active_profile fact when the key is a profile activator.
                    if key == "spring.profiles.active" || key == "SPRING_PROFILES_ACTIVE" {
                        if let Some(profile) = value.as_str() {
                            batch.facts.push(Fact {
                                id: format!("fact:active_profile:{}:{}", rec.rel, m.start),
                                subject: fid.clone(),
                                predicate: "active_profile".into(),
                                object: json!({"kind":"ScalarValue","value":{"profile":profile,"source":source}}),
                                evidence: vec![evidence(&rec.rel, &rec.hash, m.start, m.end, "STATIC_RESOLVED")],
                                resolution: "STATIC_RESOLVED",
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> AnalysisBatch {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/sample-repo");
        index_repo(&root, None, None).unwrap()
    }

    fn has_rel(b: &AnalysisBatch, kind: &str, from: &str, to: &str) -> bool {
        b.relationships.iter().any(|r| r.kind == kind && r.from == from && r.to == to)
    }

    #[test]
    fn resolves_cross_file_calls_and_imports() {
        let b = fixture();
        assert!(has_rel(&b, "imports", "file:src/auth/service.ts", "file:src/auth/token.ts"));
        assert!(has_rel(&b, "calls", "method:src/auth/service.ts#AuthService.login", "function:src/auth/token.ts#signToken"));
        assert!(has_rel(&b, "calls", "method:src/auth/service.ts#AuthService.login", "method:src/auth/service.ts#AuthService.audit"));
        assert!(has_rel(&b, "calls", "function:src/api/middleware.ts#requireAuth", "function:src/auth/token.ts#verifyToken"));
        assert!(has_rel(&b, "calls", "function:src/auth/token.ts#verifyToken", "function:src/db/users.ts#getUser"));
    }

    #[test]
    fn dynamic_and_external_calls_stay_unknown() {
        let b = fixture();
        // handlers[req.kind]() is omitted; jwt.sign / app.post are receiver calls on non-imported bindings.
        assert!(b.facts.iter().any(|f| f.resolution == "UNRESOLVED" && f.predicate == "calls"));
        assert!(!b.relationships.iter().any(|r| r.kind == "calls" && r.to.contains("jwt")));
        assert!(b.facts.iter().any(|f| f.predicate == "imports_external"));
    }

    #[test]
    fn every_relationship_has_evidence_and_revision_is_stable() {
        let (a, b) = (fixture(), fixture());
        assert!(a.relationships.iter().all(|r| !r.evidence.is_empty()));
        assert_eq!(a.revision, b.revision);
    }

    #[test]
    fn extracts_uml_fields_enums_heritage_signatures_and_associations() {
        let dir = std::env::temp_dir().join(format!("cie-uml-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("outbox.ts"), r#"
export class OutboxEntry { constructor(public id: string) {} }
export interface Sink { deliver(e: OutboxEntry): void; }
export enum OutboxState { Pending, Failed }
export abstract class BaseOutbox { protected entries: OutboxEntry[] = []; }
export class OutboxService extends BaseOutbox implements Sink {
  private state: OutboxState = OutboxState.Pending;
  private dead: OutboxEntry | null = null;
  markFailed(entry: OutboxEntry): void { this.state = OutboxState.Failed; }
}
"#).unwrap();
        let b = index_repo(&dir, None, None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(b.entities.iter().any(|e| e.kind == "field" && e.name == "BaseOutbox.entries"));
        assert!(b.entities.iter().any(|e| e.kind == "field" && e.name == "OutboxService.dead"));
        assert!(b.entities.iter().any(|e| e.kind == "enum" && e.name == "OutboxState"));
        assert!(b.relationships.iter().any(|r| r.kind == "extends" && r.from.ends_with("#OutboxService") && r.to.ends_with("#BaseOutbox")));
        assert!(b.relationships.iter().any(|r| r.kind == "implements" && r.from.ends_with("#OutboxService") && r.to.ends_with("#Sink")));
        assert!(b.relationships.iter().any(|r| r.kind == "association" && r.label.as_deref() == Some("0..*") && r.from.ends_with("#BaseOutbox") && r.to.ends_with("#OutboxEntry")));
        assert!(b.relationships.iter().any(|r| r.kind == "association" && r.label.as_deref() == Some("0..1") && r.to.ends_with("#OutboxEntry")));
        assert!(b.relationships.iter().any(|r| r.kind == "association" && r.label.as_deref() == Some("1") && r.from.ends_with("#OutboxService") && r.to.ends_with("#OutboxState")));
        assert!(b.facts.iter().any(|f| f.predicate == "signature" && f.subject.ends_with("#OutboxService.markFailed") && f.object.to_string().contains("markFailed(entry: OutboxEntry): void")));
    }
}

#[cfg(test)]
mod revision_tests {
    use super::*;

    #[test]
    fn same_content_at_different_roots_gets_different_revisions() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/sample-repo");
        let dst = std::env::temp_dir().join(format!("cie-rev-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dst);
        fn copy(a: &Path, b: &Path) {
            std::fs::create_dir_all(b).unwrap();
            for e in std::fs::read_dir(a).unwrap() {
                let e = e.unwrap();
                let t = b.join(e.file_name());
                if e.file_type().unwrap().is_dir() { copy(&e.path(), &t) } else { std::fs::copy(e.path(), t).unwrap(); }
            }
        }
        copy(&src, &dst);
        let a = index_repo(&src, None, None).unwrap();
        let b = index_repo(&dst, None, None).unwrap();
        let _ = std::fs::remove_dir_all(&dst);
        assert_ne!(a.revision, b.revision);
        assert_eq!(a.entities.len(), b.entities.len());
    }
}

#[cfg(test)]
mod gitignore_tests {
    use super::*;

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn a_file_under_a_gitignored_directory_is_not_indexed() {
        let dir = std::env::temp_dir().join(format!("cie-gitignore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write(&dir.join(".gitignore"), "generated/\n");
        write(&dir.join("src/kept.ts"), "export function keptFunction() {}\n");
        write(&dir.join("generated/skip.ts"), "export function shouldNotAppear() {}\n");

        let b = index_repo(&dir, None, None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(b.entities.iter().any(|e| e.file == "src/kept.ts"), "a non-ignored file is still indexed");
        assert!(!b.entities.iter().any(|e| e.file == "generated/skip.ts"), "a .gitignore'd file is never indexed");
    }

    #[test]
    fn a_hardcoded_skip_dir_is_excluded_even_when_not_gitignored() {
        // Defense in depth: SKIP_DIRS still applies regardless of what .gitignore says (or doesn't say).
        let dir = std::env::temp_dir().join(format!("cie-gitignore-skipdirs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write(&dir.join("src/kept.ts"), "export function keptFunction() {}\n");
        write(&dir.join("node_modules/vendor/pkg.ts"), "export function vendorFunction() {}\n");

        let b = index_repo(&dir, None, None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(b.entities.iter().any(|e| e.file == "src/kept.ts"));
        assert!(!b.entities.iter().any(|e| e.file.contains("node_modules")), "node_modules is excluded regardless of .gitignore content");
    }

    #[test]
    fn a_nested_gitignore_is_also_honoured() {
        let dir = std::env::temp_dir().join(format!("cie-gitignore-nested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write(&dir.join("pkg/.gitignore"), "local-only.ts\n");
        write(&dir.join("pkg/local-only.ts"), "export function localOnlyFunction() {}\n");
        write(&dir.join("pkg/shared.ts"), "export function sharedFunction() {}\n");

        let b = index_repo(&dir, None, None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(b.entities.iter().any(|e| e.file == "pkg/shared.ts"));
        assert!(!b.entities.iter().any(|e| e.file == "pkg/local-only.ts"), "a nested .gitignore's rule is honoured too, not just the repo root's");
    }
}

#[cfg(test)]
mod incremental_tests {
    use super::*;

    #[test]
    fn reindexes_unchanged_content_from_the_previous_hashes_and_reports_reuse() {
        let dir = std::env::temp_dir().join(format!("cie-incr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), "export function a() {}\n").unwrap();
        std::fs::write(dir.join("b.ts"), "export function b() {}\n").unwrap();
        let first = index_repo(&dir, None, None).unwrap();
        assert!(!first.diagnostics.iter().any(|d| d.code == "REUSED_CACHED_PARSES"));

        // Same content, passed as the previous revision's hashes: everything should be reused
        // and the revision must be identical (content-addressed, not a function of the cache).
        let files: Vec<(String, String)> = first.entities.iter().filter(|e| e.kind == "file")
            .map(|e| (e.file.clone(), e.spans[0].content_hash.clone())).collect();
        let cs = ChangeSet { files: files.into_iter().collect(), revision: first.revision.clone() };
        let second = index_repo(&dir, Some(&cs), None).unwrap();
        assert_eq!(second.revision, first.revision, "revision is content-addressed");
        assert_eq!(second.entities.len(), first.entities.len());
        assert_eq!(second.facts.len(), first.facts.len());
        assert_eq!(second.relationships.len(), first.relationships.len());
        let reuse = second.diagnostics.iter().find(|d| d.code == "REUSED_CACHED_PARSES").expect("reuse diagnostic");
        assert!(reuse.message.contains("2 of 2"), "both files reused: {}", reuse.message);

        // After a change, only the changed file is re-parsed.
        std::fs::write(dir.join("a.ts"), "export function a() { return 1 }\n").unwrap();
        let mut cs2 = cs.clone();
        let b_hash = second.entities.iter().find(|e| e.file == "b.ts").unwrap().spans[0].content_hash.clone();
        let a_hash = "stale".to_string();
        cs2.files = [("b.ts".to_string(), b_hash), ("a.ts".to_string(), a_hash)].into_iter().collect();
        let third = index_repo(&dir, Some(&cs2), None).unwrap();
        assert_ne!(third.revision, first.revision);
        let reuse3 = third.diagnostics.iter().find(|d| d.code == "REUSED_CACHED_PARSES").expect("reuse diagnostic");
        assert!(reuse3.message.contains("1 of 2"), "only b.ts reused: {}", reuse3.message);
        assert!(third.entities.iter().any(|e| e.name == "a" && e.spans[0].content_hash != second.entities.iter().find(|e| e.file == "a.ts").unwrap().spans[0].content_hash));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod behavior_tests {
    use super::*;

    fn payments() -> AnalysisBatch {
        index_repo(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/payments-repo"), None, None).unwrap()
    }
    fn facts<'a>(b: &'a AnalysisBatch, pred: &str, subject: &str) -> Vec<&'a Fact> {
        b.facts.iter().filter(|f| f.predicate == pred && f.subject == subject).collect()
    }
    fn scalar(f: &Fact) -> String {
        f.object["value"].as_str().unwrap_or("").to_string()
    }

    #[test]
    fn extracts_throw_sites_by_error_class() {
        let b = payments();
        let t = facts(&b, "throws", "function:src/payments/fraud.ts#checkFraud");
        assert_eq!(t.len(), 1);
        assert_eq!(scalar(t[0]), "FraudRejectedError");
        assert!(facts(&b, "throws", "function:src/ledger/ledger.ts#reserve").iter().any(|f| scalar(f) == "InsufficientFundsError"));
    }

    #[test]
    fn extracts_state_writes_and_transactions() {
        let b = payments();
        let w = |s: &str| facts(&b, "writes", s).iter().map(|f| scalar(f)).collect::<Vec<_>>();
        assert!(w("function:src/ledger/ledger.ts#commit").contains(&"balance".to_string()));
        assert!(w("function:src/ledger/ledger.ts#adjustBalance").contains(&"balance".to_string()));
        assert!(w("function:src/jobs/reconciler.ts#reconcileBalances").contains(&"balance".to_string()));
        assert!(!facts(&b, "uses_transaction", "function:src/ledger/ledger.ts#commit").is_empty());
        assert!(facts(&b, "uses_transaction", "function:src/ledger/ledger.ts#adjustBalance").is_empty(), "refund path is not transactional");
    }

    #[test]
    fn joins_publishers_to_subscribers_across_the_async_boundary() {
        let b = payments();
        let r = b.relationships.iter().find(|r| r.kind == "async-flow" && r.from == "function:src/payments/disputes.ts#openDispute");
        let r = r.expect("openDispute -> handleRefund");
        assert_eq!(r.to, "function:src/refunds/refund-worker.ts#handleRefund");
        assert_eq!(r.label.as_deref(), Some("topic \"refund.requested\""));
        assert_eq!(r.evidence.len(), 2, "cites both the publish and the subscribe site");
        // payment.completed has a publisher but no subscriber: no edge is invented.
        assert!(!b.relationships.iter().any(|r| r.kind == "async-flow" && r.label.as_deref() == Some("topic \"payment.completed\"")));
    }

    #[test]
    fn test_symbols_call_into_code() {
        let b = payments();
        assert!(b.entities.iter().any(|e| e.kind == "test" && e.name == "charges an account"));
        assert!(b.relationships.iter().any(|r| r.kind == "calls" && r.from.starts_with("test:tests/payment-service.test.ts#charges an account") && r.to == "function:src/payments/payment-service.ts#charge"));
        assert!(!b.relationships.iter().any(|r| r.kind == "calls" && r.to == "function:src/refunds/refund-worker.ts#handleRefund" && r.from.starts_with("test:")));
    }

    #[test]
    fn git_history_is_attached_as_history_evidence() {
        let dir = std::env::temp_dir().join(format!("cie-hist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sh = |args: &[&str]| {
            let s = std::process::Command::new("git").arg("-C").arg(&dir).args(args)
                .env("GIT_AUTHOR_NAME", "A").env("GIT_AUTHOR_EMAIL", "a@x").env("GIT_COMMITTER_NAME", "A").env("GIT_COMMITTER_EMAIL", "a@x")
                .status().unwrap();
            assert!(s.success());
        };
        sh(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.ts"), "export function a() {}\n").unwrap();
        sh(&["add", "-A"]);
        sh(&["commit", "-qm", "first"]);
        std::fs::write(dir.join("a.ts"), "export function a() { return 1 }\n").unwrap();
        sh(&["commit", "-qam", "second"]);
        let b = index_repo(&dir, None, None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let h = b.facts.iter().find(|f| f.predicate == "history" && f.subject == "file:a.ts").expect("history fact");
        assert_eq!(h.object["value"]["commits"], 2);
        assert_eq!(h.object["value"]["lastSubject"], "second");
        assert_eq!(h.evidence[0].class, "HISTORY");
        assert_eq!(h.resolution, "OBSERVED");
    }
}

#[cfg(test)]
mod spring_tests {
    use super::*;

    fn fixture() -> AnalysisBatch {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/spring-repo");
        index_repo(&root, None, None).unwrap()
    }

    #[test]
    fn extracts_spring_routes_and_injection() {
        let b = fixture();
        // Controllers and providers are framework-annotated existing class entities.
        assert!(b.facts.iter().any(|f| f.predicate == "framework_role" && f.object["value"]["role"] == "controller" && f.subject.contains("PaymentController")));
        assert!(b.facts.iter().any(|f| f.predicate == "framework_role" && f.object["value"]["role"] == "provider" && f.subject.contains("PaymentService")));
        // Spring Security guard recognised from @PreAuthorize.
        assert!(b.facts.iter().any(|f| f.predicate == "framework_role" && f.object["value"]["role"] == "guard" && f.subject.contains("PaymentController.create")));

        // Route entity and fact.
        assert!(b.entities.iter().any(|e| e.kind == "spring_route" && e.name.contains("POST")));
        let route_fact = b.facts.iter().find(|f| f.predicate == "route" && f.object["value"]["path"] == "/payments/{userId}").unwrap();
        assert_eq!(route_fact.object["value"]["method"], "POST");

        // Constructor injection: PaymentService injects UserRepository, PaymentController injects PaymentService.
        assert!(b.relationships.iter().any(|r| r.kind == "injects" && r.from.contains("PaymentService.PaymentService") && r.to.contains("UserRepository")));
        assert!(b.relationships.iter().any(|r| r.kind == "injects" && r.from.contains("PaymentController.PaymentController") && r.to.contains("PaymentService")));

        // Transactional method. The framework indexer adds framework:"spring".
        assert!(b.facts.iter().any(|f| f.predicate == "uses_transaction" && f.subject.contains("PaymentService.charge") && f.object["framework"] == "spring"));

        // Controller exposes route.
        assert!(b.relationships.iter().any(|r| r.kind == "exposes_route" && r.from.contains("PaymentController") && r.label.as_deref() == Some("POST /payments/{userId}")));
    }

    #[test]
    fn extracts_spring_cloud_gateway_routes_and_filters() {
        let b = fixture();
        // Java DSL routes.
        assert!(b.entities.iter().any(|e| e.kind == "spring_cloud_gateway_route" && e.name == "payments"));
        assert!(b.entities.iter().any(|e| e.kind == "spring_cloud_gateway_route" && e.name == "orders"));
        assert!(b.facts.iter().any(|f| f.predicate == "gateway_route" && f.object["value"]["id"] == "payments"));

        // Filters emitted by the DSL (camelCase method names).
        assert!(b.entities.iter().any(|e| e.kind == "spring_cloud_gateway_filter" && e.name.contains("stripPrefix")));
        assert!(b.entities.iter().any(|e| e.kind == "spring_cloud_gateway_filter" && e.name.contains("circuitBreaker")));
        assert!(b.entities.iter().any(|e| e.kind == "spring_cloud_gateway_filter" && e.name.contains("retry")));

        // Route-to-filter relationships.
        assert!(b.relationships.iter().any(|r| r.kind == "uses_filter" && r.from.contains("payments") && r.to.contains("stripPrefix")));
        assert!(b.relationships.iter().any(|r| r.kind == "uses_filter" && r.from.contains("orders") && r.to.contains("retry")));

        // Custom GatewayFilter class.
        assert!(b.facts.iter().any(|f| f.predicate == "framework_role" && f.object["value"]["role"] == "gateway_filter" && f.subject.contains("AuthFilter")));

        // YAML route.
        assert!(b.entities.iter().any(|e| e.kind == "spring_cloud_gateway_route" && e.name == "payments-route"));
        assert!(b.facts.iter().any(|f| f.predicate == "gateway_filter" && f.object["value"]["name"] == "StripPrefix"));
        assert!(b.facts.iter().any(|f| f.predicate == "gateway_filter" && f.object["value"]["name"] == "CircuitBreaker"));
    }
}

#[cfg(test)]
mod nestjs_tests {
    use super::*;

    fn fixture() -> AnalysisBatch {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/nestjs-repo");
        index_repo(&root, None, None).unwrap()
    }

    #[test]
    fn extracts_nestjs_controllers_providers_routes_and_injection() {
        let b = fixture();

        // Framework roles annotate class entities.
        assert!(b.facts.iter().any(|f| f.predicate == "framework_role" && f.object["value"]["role"] == "controller" && f.subject.contains("UsersController")));
        assert!(b.facts.iter().any(|f| f.predicate == "framework_role" && f.object["value"]["role"] == "provider" && f.subject.contains("UsersService")));
        assert!(b.facts.iter().any(|f| f.predicate == "framework_role" && f.object["value"]["role"] == "module" && f.subject.contains("AppModule")));
        assert!(b.facts.iter().any(|f| f.predicate == "framework_role" && f.object["value"]["role"] == "guard" && f.subject.contains("AuthGuard")));

        // Route entity and fact.
        assert!(b.facts.iter().any(|f| f.predicate == "route" && f.object["value"]["path"] == "/users" && f.object["value"]["method"] == "GET"));
        assert!(b.entities.iter().any(|e| e.kind == "nestjs_route" && e.name.contains("GET")));

        // Constructor injection: UsersController injects UsersService.
        assert!(b.relationships.iter().any(|r| r.kind == "injects" && r.from.contains("UsersController") && r.to.contains("UsersService")));

        // Module contains its own controller/provider.
        assert!(b.relationships.iter().any(|r| r.kind == "contains" && r.from.contains("UsersModule") && r.to.contains("UsersController")));
        assert!(b.relationships.iter().any(|r| r.kind == "contains" && r.from.contains("UsersModule") && r.to.contains("UsersService")));
    }
}

#[cfg(test)]
mod express_tests {
    use super::*;

    fn fixture() -> AnalysisBatch {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/express-repo");
        index_repo(&root, None, None).unwrap()
    }

    #[test]
    fn extracts_express_routes_and_middleware() {
        let b = fixture();
        assert!(b.facts.iter().any(|f| f.predicate == "route" && f.object["value"]["path"] == "/health" && f.object["value"]["method"] == "GET"));
        assert!(b.facts.iter().any(|f| f.predicate == "route" && f.object["value"]["path"] == "/login" && f.object["value"]["method"] == "POST"));
        assert!(b.facts.iter().any(|f| f.predicate == "route" && f.object["value"]["path"] == "/" && f.object["value"]["method"] == "GET"));
        assert!(b.facts.iter().any(|f| f.predicate == "route" && f.object["value"]["path"] == "/:id" && f.object["value"]["method"] == "GET"));
        assert!(b.entities.iter().any(|e| e.kind == "express_route" && e.name == "GET /health"));
        assert!(b.entities.iter().any(|e| e.kind == "express_middleware" && e.name == "requireAuth"));
    }
}

#[cfg(test)]
mod nextjs_tests {
    use super::*;

    fn fixture() -> AnalysisBatch {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/nextjs-repo");
        index_repo(&root, None, None).unwrap()
    }

    #[test]
    fn extracts_nextjs_routes_and_actions() {
        let b = fixture();
        assert!(b.facts.iter().any(|f| f.predicate == "route" && f.object["value"]["path"] == "/" && f.object["value"]["method"] == "GET"));
        assert!(b.facts.iter().any(|f| f.predicate == "route" && f.object["value"]["path"] == "/users/:id" && f.object["value"]["method"] == "GET"));
        assert!(b.facts.iter().any(|f| f.predicate == "route" && f.object["value"]["path"] == "/api/users" && f.object["value"]["method"] == "GET"));
        assert!(b.facts.iter().any(|f| f.predicate == "route" && f.object["value"]["path"] == "/api/users" && f.object["value"]["method"] == "POST"));
        assert!(b.facts.iter().any(|f| f.predicate == "route" && f.object["value"]["path"] == "/blog/:slug" && f.object["value"]["method"] == "GET"));
        assert!(b.entities.iter().any(|e| e.kind == "nextjs_route" && e.name.contains("/users/:id")));
        assert!(b.facts.iter().any(|f| f.predicate == "route" && f.object["value"]["kind"] == "server_action"));
    }
}

#[cfg(test)]
mod reads_tests {
    use super::*;

    #[test]
    fn records_reads_only_of_fields_that_are_written_somewhere() {
        let b = index_repo(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/payments-repo"), None, None).unwrap();
        let readers = |field: &str| b.facts.iter().filter(|f| f.predicate == "reads" && f.object["value"] == field).map(|f| f.subject.clone()).collect::<Vec<_>>();
        let r = readers("balance");
        assert!(r.contains(&"function:src/ledger/ledger.ts#reserve".to_string()), "reserve reads account.balance: {r:?}");
        assert!(r.contains(&"function:src/ledger/ledger.ts#commit".to_string()) || r.contains(&"function:src/ledger/ledger.ts#adjustBalance".to_string()));
        // `.status`, `.body` etc. are read but never written in this repo: no noise.
        assert!(!b.facts.iter().any(|f| f.predicate == "reads" && f.object["value"] == "body"));
        let mut seen = std::collections::HashSet::new();
        assert!(b.facts.iter().filter(|f| f.predicate == "reads").all(|f| seen.insert((f.subject.clone(), f.object["value"].to_string()))), "one read fact per reader and field");
    }
}

#[cfg(test)]
mod rust_nir_tests {
    use super::*;

    fn fixture() -> AnalysisBatch {
        index_repo(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/rust-nir-repo"), None, None).unwrap()
    }

    #[test]
    fn indexes_rust_and_nirdosha_v2_files_together() {
        let b = fixture();
        assert!(b.entities.iter().any(|e| e.entity_id == "function:src/auth.rs#verify"));
        assert!(b.entities.iter().any(|e| e.entity_id == "function:src/screens/tasks.nir#load_tasks"));
        assert!(b.entities.iter().any(|e| e.entity_id == "screen:src/screens/tasks.nir#mount_tasks"));
        assert!(b.relationships.iter().any(|r| r.kind == "imports" && r.from == "file:src/lib.rs" && r.to == "file:src/auth.rs"));
        assert!(b.relationships.iter().any(|r| r.kind == "imports" && r.from == "file:src/lib.rs" && r.to == "file:src/screens/tasks.nir"));
        assert!(b.relationships.iter().any(|r| r.kind == "calls" && r.from == "function:src/lib.rs#entry" && r.to == "function:src/auth.rs#verify"));
        assert!(b.facts.iter().any(|f| f.predicate == "throws" && f.subject == "function:src/auth.rs#verify" && f.object["value"] == "panic!"));
        assert!(!b.diagnostics.iter().any(|d| d.code == "PARSE_ERRORS"), "{:#?}", b.diagnostics);
    }
}

#[cfg(test)]
mod delta_tests {
    use super::*;

    fn copy(a: &Path, b: &Path) {
        std::fs::create_dir_all(b).unwrap();
        for e in std::fs::read_dir(a).unwrap() {
            let e = e.unwrap();
            let t = b.join(e.file_name());
            if e.file_type().unwrap().is_dir() { copy(&e.path(), &t) } else { std::fs::copy(e.path(), t).unwrap(); }
        }
    }
    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cie-delta-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        copy(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/payments-repo/src"), &d);
        d
    }
    fn base_of(b: &AnalysisBatch) -> BaseRef { BaseRef { revision: b.revision.clone(), analyzer_version: b.analyzer_version.clone(), digests: b.manifest.iter().map(|(k, v)| (k.clone(), v.clone())).collect() } }
    fn all_rows(b: &AnalysisBatch) -> usize { b.entities.len() + b.facts.len() + b.relationships.len() }

    #[test]
    fn a_files_digest_is_stable_between_runs_and_ignores_the_revision_id() {
        let dir = tmp("stable");
        let a = index_repo(&dir, None, None).unwrap();
        let b = index_repo(&dir, None, None).unwrap();
        assert_eq!(a.manifest, b.manifest, "the same worktree gives the same digests, whatever order rows were emitted in");
        assert_eq!(a.mode, "full");
        let text = serde_json::to_string(&a).unwrap();
        assert!(!text.contains(REV_PLACEHOLDER), "the placeholder never leaves the worker");
        assert!(text.contains(&a.revision), "rows carry the real revision id");
        // Editing one file changes the revision id; every other file's rows still carry the old id's replacement, and must keep their digest.
        let target = dir.join("errors.ts");
        std::fs::write(&target, format!("{}\n// a comment\n", std::fs::read_to_string(&target).unwrap())).unwrap();
        let c = index_repo(&dir, None, None).unwrap();
        assert_ne!(a.revision, c.revision);
        let differing: Vec<&String> = a.manifest.keys().filter(|f| a.manifest[*f] != c.manifest[*f]).collect();
        assert_eq!(differing, vec!["errors.ts"], "only the edited file's digest changes");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unchanged_worktree_returns_nothing_and_an_edit_returns_only_the_files_whose_rows_changed() {
        let dir = tmp("delta");
        let full = index_repo(&dir, None, None).unwrap();
        let base = base_of(&full);
        let same = index_repo(&dir, None, Some(&base)).unwrap();
        assert_eq!(same.mode, "unchanged");
        assert_eq!(all_rows(&same), 0);

        // Nothing parsed to decide it: with the cached parse of a file removed, an unchanged worktree is still recognised, and the file is not parsed on the way.
        let unique = format!("export const marker{} = 1;\n", std::process::id());
        std::fs::write(dir.join("unique-marker.ts"), &unique).unwrap();
        let with_marker = index_repo(&dir, None, None).unwrap();
        let root_key = dir.canonicalize().unwrap().to_string_lossy().to_string();
        let key = CacheKey(root_key, "unique-marker.ts".to_string(), sha(unique.as_bytes()));
        assert!(parse_cache().entries.remove(&key).is_some(), "the full index cached the parse");
        let again = index_repo(&dir, None, Some(&base_of(&with_marker))).unwrap();
        assert_eq!(again.mode, "unchanged");
        assert!(parse_cache().entries.get(&key).is_none(), "an unchanged worktree is recognised before any file is parsed");
        std::fs::remove_file(dir.join("unique-marker.ts")).unwrap();

        let target = dir.join("errors.ts");
        std::fs::write(&target, format!("{}\n// a comment\n", std::fs::read_to_string(&target).unwrap())).unwrap();
        let delta = index_repo(&dir, None, Some(&base)).unwrap();
        assert_eq!(delta.mode, "delta");
        assert!(!serde_json::to_string(&delta).unwrap().contains(REV_PLACEHOLDER), "kept rows of a delta carry the real revision id too");
        assert_eq!(delta.base_revision.as_deref(), Some(full.revision.as_str()));
        assert_eq!(delta.changed_files, vec!["errors.ts".to_string()]);
        assert!(delta.entities.iter().all(|e| e.file == "errors.ts"));
        assert!(all_rows(&delta) < all_rows(&full) / 4, "{} of {} rows", all_rows(&delta), all_rows(&full));
        assert_eq!(delta.manifest.len(), full.manifest.len(), "the manifest still lists every file");

        // A deleted file is named, and a new file is a changed file.
        std::fs::remove_file(dir.join("errors.ts")).unwrap();
        std::fs::write(dir.join("added.ts"), "export function added(): number { return 1 }\n").unwrap();
        let moved = index_repo(&dir, None, Some(&base)).unwrap();
        assert!(moved.removed_files.contains(&"errors.ts".to_string()));
        assert!(moved.changed_files.contains(&"added.ts".to_string()));

        // A base from another analyzer version is not trusted: everything is sent.
        let mut old = base.clone(); old.analyzer_version = "something-else".into();
        let all = index_repo(&dir, None, Some(&old)).unwrap();
        assert_eq!(all.mode, "full");
        let _ = std::fs::remove_dir_all(&dir);
    }
}


#[cfg(test)]
mod parse_cache_bug {
    use super::*;

    #[test]
    fn a_repository_larger_than_the_parse_cache_still_reuses_the_parses_of_unchanged_files() {
        let dir = std::env::temp_dir().join(format!("cie-bigcache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let files = CACHE_LIMIT + 200;
        for i in 0..files {
            std::fs::write(dir.join(format!("m{i:05}.ts")), format!("export function f{i}(n: number) {{ return n + {i}; }}\n")).unwrap();
        }
        index_repo(&dir, None, None).unwrap();                       // parses everything and fills the cache
        std::fs::write(dir.join("m00000.ts"), "export function f0(n: number) { return n; }\n").unwrap(); // one file changes
        let second = index_repo(&dir, None, None).unwrap();
        let reused: usize = second.diagnostics.iter().filter(|d| d.code == "REUSED_CACHED_PARSES").filter_map(|d| d.message.split_whitespace().nth(1).and_then(|n| n.parse::<usize>().ok())).sum();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(reused, files - 1, "{files} files, one edited: {reused} parses reused (the parse cache holds at most {CACHE_LIMIT} files, so reuse stops there)");
    }
}
