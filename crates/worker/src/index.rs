//! Repository walk (C04 local ingestion) + cross-file resolution (C05 resolveSemantics / C09 graph).
//! With a provided `ChangeSet` (per-file content hashes of the previously indexed revision) only
//! changed files are re-parsed; the rest reuse cached parses, and diagnostics report what was reused.
use crate::language::{parse_ts, RawFile};
use crate::polyglot::{parse_go, parse_java, parse_python};
use crate::rust_language::parse_rust;
use crate::source_ir;
use crate::model::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const SKIP_DIRS: &[&str] = &["node_modules", ".git", "dist", "build", "target", ".next", "coverage", "__pycache__", ".venv", "venv", ".gradle", ".idea", "vendor", "site-packages"];
pub const ANALYZER_VERSION: &str = "worker-0.3.0/tree-sitter-typescript-0.23+rust-0.24+nirdosha-v2+defect-semantic-v1";

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

// ---- parse cache (incremental re-index; CE-3 region-level reuse) ----
// Key: (relative path, content hash); value: the parsed file. Only valid within one
// analyzer version and one worker process (spawn-local). Entries evicted FIFO beyond a bounded size.
const CACHE_LIMIT: usize = 4096;
#[derive(PartialEq, Eq, Hash, Clone)]
struct CacheKey(String, String);
struct ParseCache { entries: HashMap<CacheKey, RawFile> }
static PARSE_CACHE: std::sync::OnceLock<std::sync::Mutex<ParseCache>> = std::sync::OnceLock::new();

/// A content-keyed parse cache, so an incremental re-index can reuse parses of files whose
/// bytes are unchanged. Only valid inside one worker process (spawn-local, one op at a time).
fn parse_cache() -> std::sync::MutexGuard<'static, ParseCache> {
    PARSE_CACHE.get_or_init(|| std::sync::Mutex::new(ParseCache { entries: HashMap::new() })).lock().unwrap_or_else(|e| e.into_inner())
}
fn cache_get(rel: &str, hash: &str) -> Option<RawFile> {
    parse_cache().entries.get(&CacheKey(rel.to_string(), hash.to_string())).cloned()
}
fn cache_put(rel: &str, hash: &str, raw: &RawFile) {
    let mut c = parse_cache();
    while c.entries.len() >= CACHE_LIMIT { if let Some(k) = c.entries.keys().next().cloned() { c.entries.remove(&k); } else { break; } }
    c.entries.insert(CacheKey(rel.to_string(), hash.to_string()), raw.clone());
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

pub fn index_repo(root: &Path, changes: Option<&ChangeSet>) -> Result<AnalysisBatch, String> {
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut paths: Vec<PathBuf> = WalkDir::new(&root)
        .into_iter()
        .filter_entry(|e| {
            !(e.file_type().is_dir() && e.file_name().to_str().map_or(false, |n| SKIP_DIRS.contains(&n)))
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            let n = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            !n.ends_with(".d.ts")
                && matches!(p.extension().and_then(|s| s.to_str()), Some("ts" | "tsx" | "mts" | "cts" | "rs" | "nir" | "java" | "go" | "py"))
        })
        .collect();
    paths.sort();

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
    let cache = changes.map(|c| c.files.clone()).unwrap_or_default();
    let cache_by_rel: HashMap<&str, &str> = cache.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
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
        // Same content hash as the caller's previous revision: the parse is content-identical, reuse it.
        if cache_by_rel.get(rel.as_str()).map_or(false, |h| *h == hash) {
            if let Some(raw) = cache_get(&rel, &hash) {
                reused += 1;
                sources.push((rel.clone(), hash.clone()));
                recs.push(FileRec { rel, hash, src, raw, ids: vec![] });
                continue;
            }
        }
        let mut raw = match p.extension().and_then(|s| s.to_str()) {
            Some("rs" | "nir") => parse_rust(&src, rel.ends_with(".nir")),
            Some("java") => parse_java(&src, &rel),
            Some("go") => parse_go(&src, &rel),
            Some("py") => parse_python(&src, &rel),
            _ => parse_ts(&src, rel.ends_with(".tsx")),
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
        cache_put(&rel, &hash, &raw);
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
    batch.revision = format!("wt-{}", &hex(&rev_hasher.finalize())[..16]);
    if let Some(ir)=nirdosha_ir { for (rel,code,message) in ir.diagnostics { batch.diagnostics.push(Diagnostic{code,message,related_entity_ids:vec![format!("file:{rel}")],retryable:false}); } }
    let rev = batch.revision.clone();

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

    let mut rel_ids: HashMap<String, ()> = batch.relationships.iter().map(|r| (r.id.clone(), ())).collect();
    let mut add_rel = |batch: &mut AnalysisBatch, r: Relationship| {
        if rel_ids.insert(r.id.clone(), ()).is_none() {
            batch.relationships.push(r);
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

    // Git history (HISTORY evidence), when the root is inside a work tree.
    for (rel, h) in git_history(&root) {
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
    Ok(batch)
}

struct History {
    commits: usize,
    last_commit: String,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> AnalysisBatch {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/sample-repo");
        index_repo(&root, None).unwrap()
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
        let a = index_repo(&src, None).unwrap();
        let b = index_repo(&dst, None).unwrap();
        let _ = std::fs::remove_dir_all(&dst);
        assert_ne!(a.revision, b.revision);
        assert_eq!(a.entities.len(), b.entities.len());
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
        let first = index_repo(&dir, None).unwrap();
        assert!(!first.diagnostics.iter().any(|d| d.code == "REUSED_CACHED_PARSES"));

        // Same content, passed as the previous revision's hashes: everything should be reused
        // and the revision must be identical (content-addressed, not a function of the cache).
        let files: Vec<(String, String)> = first.entities.iter().filter(|e| e.kind == "file")
            .map(|e| (e.file.clone(), e.spans[0].content_hash.clone())).collect();
        let cs = ChangeSet { files: files.into_iter().collect(), revision: first.revision.clone() };
        let second = index_repo(&dir, Some(&cs)).unwrap();
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
        let third = index_repo(&dir, Some(&cs2)).unwrap();
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
        index_repo(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/payments-repo"), None).unwrap()
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
        let b = index_repo(&dir, None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let h = b.facts.iter().find(|f| f.predicate == "history" && f.subject == "file:a.ts").expect("history fact");
        assert_eq!(h.object["value"]["commits"], 2);
        assert_eq!(h.object["value"]["lastSubject"], "second");
        assert_eq!(h.evidence[0].class, "HISTORY");
        assert_eq!(h.resolution, "OBSERVED");
    }
}

#[cfg(test)]
mod reads_tests {
    use super::*;

    #[test]
    fn records_reads_only_of_fields_that_are_written_somewhere() {
        let b = index_repo(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/payments-repo"), None).unwrap();
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
        index_repo(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/rust-nir-repo"), None).unwrap()
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
