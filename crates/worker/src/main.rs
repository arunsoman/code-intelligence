//! Rust worker (contracts §10): C04–C09 collapsed. Speaks length-prefixed JSON on stdio.
mod canon;
mod dataflow;
mod frameworks;
mod index;
mod artifact;
mod evidence;
mod evidence_core;
mod evidence_stream;
mod fact_normalize;
mod producer_registry;
mod ir;
mod irpdg;
mod irrender;
mod language;
mod metrics;
mod model;
mod motifs;
mod polyglot;
mod profiling;
mod protocol;
mod regexfind;
mod rust_language;
mod shape;
mod source_ir;

use crate::canon::KnownHash;
use crate::model::{BaseRef, ChangeSet};
use protocol::{FrameError, read_frame, write_frame};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{stdin, stdout};
use std::path::Path;

/// Responses above this go through a content handle (a file the parent reads) instead of a frame.
const INLINE_LIMIT: usize = 4 * 1024 * 1024;

fn profile_rpc<F, T: serde::Serialize>(req: &Value, f: F) -> Result<Value, (&str, String)>
where
    F: FnOnce(&[u8], Option<&str>) -> Result<T, Vec<profiling::Diagnostic>>,
{
    let params = req.pointer("/params").cloned().unwrap_or(Value::Null);
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or(("INVALID_SCHEMA", "params.path required".into()))?;
    let hint = params.get("serviceHint").and_then(Value::as_str);
    let bytes = std::fs::read(path).map_err(|e| ("NOT_FOUND", e.to_string()))?;
    let result = f(&bytes, hint).map_err(|diagnostics| {
        (
            "INVALID_SCHEMA",
            serde_json::to_string(&diagnostics).unwrap_or_default(),
        )
    })?;
    serde_json::to_value(result).map_err(|e| ("STORAGE_FAILURE", e.to_string()))
}

fn parse_trace_window(v: &Value) -> Result<profiling::TraceWindow, String> {
    let service = v
        .get("service")
        .and_then(Value::as_str)
        .ok_or_else(|| "trace.service required".to_string())?;
    let instance = v.get("instance").and_then(Value::as_str);
    let from_ns = v
        .get("fromNs")
        .and_then(Value::as_i64)
        .ok_or_else(|| "trace.fromNs required".to_string())?;
    let to_ns = v
        .get("toNs")
        .and_then(Value::as_i64)
        .ok_or_else(|| "trace.toNs required".to_string())?;
    let revision = v.get("revision").and_then(Value::as_str);
    let trace_id = v.get("traceId").and_then(Value::as_str);
    let span_id = v.get("spanId").and_then(Value::as_str);
    let endpoint = v.get("endpoint").and_then(Value::as_str);
    Ok(profiling::TraceWindow {
        service: service.into(),
        instance: instance.map(|s| s.into()),
        from_ns,
        to_ns,
        revision: revision.map(|s| s.into()),
        trace_id: trace_id.map(|s| s.into()),
        span_id: span_id.map(|s| s.into()),
        endpoint: endpoint.map(|s| s.into()),
    })
}

fn parse_population_spec(
    params: &Value,
    prefix: &str,
    profile: &profiling::ParsedProfile,
) -> Result<profiling::PopulationSpec, String> {
    let base = params.get(prefix).unwrap_or(&Value::Null);
    let service = base
        .get("service")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .or_else(|| profile.service.clone())
        .ok_or_else(|| format!("{}.service required", prefix))?;
    let from_ns = base
        .get("fromNs")
        .and_then(Value::as_i64)
        .unwrap_or(profile.start_ns);
    let to_ns = base
        .get("toNs")
        .and_then(Value::as_i64)
        .unwrap_or(profile.end_ns);
    let revision = base
        .get("revision")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let kind = base
        .get("sampleTypeKind")
        .and_then(|v| serde_json::from_value::<profiling::SampleKind>(v.clone()).ok())
        .unwrap_or_else(|| {
            profile
                .sample_types
                .first()
                .map(|st| st.kind.clone())
                .unwrap_or(profiling::SampleKind::Other)
        });
    Ok(profiling::PopulationSpec {
        service,
        window_from_ns: from_ns,
        window_to_ns: to_ns,
        revision,
        sample_type_kind: kind,
    })
}

fn parse_known(params: &Value) -> Result<Option<HashMap<String, KnownHash>>, String> {
    if let Some(v) = params.get("known") {
        if !v.is_null() {
            return serde_json::from_value(v.clone())
                .map(Some)
                .map_err(|e| format!("params.known: {e}"));
        }
    }
    if let Some(f) = params.get("knownPath").and_then(Value::as_str) {
        let text =
            std::fs::read_to_string(f).map_err(|e| format!("params.knownPath {f:?}: {e}"))?;
        return serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("params.knownPath: {e}"));
    }
    Ok(None)
}

fn handle(req: &Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let op = req.get("op").and_then(Value::as_str).unwrap_or("");
    let result: Result<Value, (&str, String)> = match op {
        "ping" => Ok(json!({"pong": true, "analyzerVersion": index::ANALYZER_VERSION})),
        "languageCapabilities" => Ok(json!({"languages": {
            "typescript": ["PARSED", "RESOLVED(relative imports, same-file, namespace)", "NestJS: controllers, providers, modules, routes, constructor injection, guards, interceptors", "Express/Fastify: static routes and middleware", "Next.js: app/pages router routes and server actions"],
            "rust": ["PARSED", "RESOLVED(crate/self/super modules, same-file, imported functions)"],
            "java": ["PARSED", "RESOLVED(imports, same package, calls through fields and parameters of a declared type)", "Spring: controllers, providers, constructor injection, @Transactional, @*Mapping routes, message listeners, Spring Cloud Gateway routes/filters/YAML"],
            "go": ["PARSED", "RESOLVED(package imports, same package, methods on receivers and typed struct fields)"],
            "python": ["PARSED", "RESOLVED(absolute, relative and aliased imports, self methods, attributes typed by annotated parameters)"],
            "nirdosha-v2": ["PARSED_AS_RUST", "RESOLVED(path modules, crate modules, Nirdosha screen macros)"]
        }})),
        "index" => match req.pointer("/params/repoPath").and_then(Value::as_str) {
            None => Err(("INVALID_SCHEMA", "params.repoPath required".into())),
            Some(p) => {
                let changes: Option<ChangeSet> = req
                    .pointer("/params/changes")
                    .and_then(|v| serde_json::from_value(v.clone()).ok());
                let base: Option<BaseRef> = req
                    .pointer("/params/base")
                    .and_then(|v| serde_json::from_value(v.clone()).ok());
                match index::index_repo(Path::new(p), changes.as_ref(), base.as_ref()) {
                    Err(e) if e.starts_with("EVIDENCE_CORE_LIMIT") => Err(("RESOURCE_LIMIT", e)),
                    Err(e) if e.starts_with("EVIDENCE_CORE_") || e.starts_with("invalid CIE_EVIDENCE_CORE") => Err(("INVALID_SCHEMA", e)),
                    Err(e) => Err(("NOT_FOUND", e)),
                    // The batch is streamed straight to a handle file: no intermediate JSON value and no second copy in a byte
                    // buffer, which together cost several times the batch itself at the peak.
                    Ok(b) => {
                        let path = std::env::temp_dir().join(format!(
                            "cie-handle-{}-{}.json",
                            std::process::id(),
                            id
                        ));
                        let core_path=path.with_extension("core.jsonl");
                        let stream=crate::evidence_core::enabled().unwrap_or(false)
                            && crate::evidence_stream::should_stream(
                                crate::evidence_stream::transport().as_deref().unwrap_or("auto"),
                                &b.mode,
                                b.evidence_core.is_some(),
                            );
                        if stream {
                            let t_stream=std::time::Instant::now();
                            if let Err(e)=crate::evidence_stream::write(&b,&core_path){return json!({"id":id,"ok":false,"error":{"code":if e.starts_with("EVIDENCE_CORE_LIMIT"){"RESOURCE_LIMIT"}else{"STORAGE_FAILURE"},"message":e,"retryable":false}});}
                            index::timing("provenance stream + flush",t_stream);
                        }
                        let t_write = std::time::Instant::now();
                        let written = std::fs::File::create(&path)
                            .map(std::io::BufWriter::new)
                            .map_err(|e| e.to_string())
                            .and_then(|mut w| {
                                serde_json::to_writer(&mut w, &b)
                                    .map_err(|e| e.to_string())
                                    .and_then(|_| {
                                        std::io::Write::flush(&mut w).map_err(|e| e.to_string())
                                    })
                            });
                        index::timing("handle serialization + flush", t_write);
                        match written {
                            Ok(()) => {
                                if stream {return json!({"id":id,"ok":true,"handle":path.to_string_lossy(),"evidenceCoreHandle":core_path.to_string_lossy()});}
                                return json!({"id": id, "ok": true, "handle": path.to_string_lossy()});
                            }
                            Err(e) => {let _=std::fs::remove_file(&path);let _=std::fs::remove_file(&core_path);Err(("STORAGE_FAILURE", e))},
                        }
                    }
                }
            }
        },
        "probeArtifact" => {
            // C33: read one binary artifact (jar/so/dll/exe/…) and return what its bytes support.
            let params = req.pointer("/params").cloned().unwrap_or(Value::Null);
            match params.get("path").and_then(Value::as_str) {
                None => Err(("INVALID_SCHEMA", "params.path required".into())),
                Some(p) => {
                    let display = params.get("displayPath").and_then(Value::as_str).unwrap_or(p);
                    artifact::probe_artifact(Path::new(p), display).map_err(|(code, message)| (code, message)).and_then(|report| {
                        serde_json::to_value(report).map_err(|e| ("STORAGE_FAILURE", e.to_string()))
                    })
                }
            }
        }
        "regexFind" => {
            let params = req.pointer("/params").cloned().unwrap_or(Value::Null);
            match params.get("root").and_then(Value::as_str) {
                None => Err(("INVALID_SCHEMA", "params.root required".into())),
                Some(r) => regexfind::regex_verify(Path::new(r), &params),
            }
        }
        "metrics" => {
            let params = req.pointer("/params").cloned().unwrap_or(Value::Null);
            match params.get("root").and_then(Value::as_str) {
                None => Err(("INVALID_SCHEMA", "params.root required".into())),
                Some(r) => metrics::metrics_verify(Path::new(r), &params),
            }
        }
        "ingestProfile" => profile_rpc(req, |bytes, hint| profiling::ingest_profile(bytes, hint)),
        "queryHotspots" => profile_rpc(req, |bytes, hint| {
            let ordinal = req
                .pointer("/params/ordinal")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let order = req
                .pointer("/params/order")
                .and_then(Value::as_str)
                .unwrap_or("SELF");
            let limit = req
                .pointer("/params/limit")
                .and_then(Value::as_u64)
                .unwrap_or(50) as usize;
            profiling::query_hotspots_from_bytes(bytes, hint, ordinal, order, limit)
        }),
        "buildFlamegraph" => profile_rpc(req, |bytes, hint| {
            let ordinal = req
                .pointer("/params/ordinal")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            profiling::build_flamegraph_from_bytes(bytes, hint, ordinal)
        }),
        "correlateProfile" => {
            let params = req.pointer("/params").cloned().unwrap_or(Value::Null);
            (move || -> Result<Value, (&str, String)> {
                let p = params
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or(("INVALID_SCHEMA", "params.path required".into()))?;
                let bytes = std::fs::read(p).map_err(|e| ("NOT_FOUND", e.to_string()))?;
                let hint = params.get("serviceHint").and_then(Value::as_str);
                let parsed = profiling::parse_profile(&bytes, hint).map_err(|d| {
                    (
                        "INVALID_SCHEMA",
                        serde_json::to_string(&d).unwrap_or_default(),
                    )
                })?;
                let trace = parse_trace_window(&params).map_err(|e| ("INVALID_SCHEMA", e))?;
                let build_id = params.get("buildId").and_then(Value::as_str);
                let revision = params.get("revision").and_then(Value::as_str);
                let artifact_hash = profiling::artifact_hash(&bytes);
                let corr = profiling::correlate_profile_trace(
                    &artifact_hash,
                    &parsed,
                    &trace,
                    build_id,
                    revision,
                );
                serde_json::to_value(corr).map_err(|e| ("STORAGE_FAILURE", e.to_string()))
            })()
        }
        "compareProfiles" => {
            let params = req.pointer("/params").cloned().unwrap_or(Value::Null);
            (move || -> Result<Value, (&str, String)> {
                let baseline_path = params
                    .get("baselinePath")
                    .and_then(Value::as_str)
                    .ok_or(("INVALID_SCHEMA", "params.baselinePath required".into()))?;
                let candidate_path = params
                    .get("candidatePath")
                    .and_then(Value::as_str)
                    .ok_or(("INVALID_SCHEMA", "params.candidatePath required".into()))?;
                let baseline_bytes =
                    std::fs::read(baseline_path).map_err(|e| ("NOT_FOUND", e.to_string()))?;
                let candidate_bytes =
                    std::fs::read(candidate_path).map_err(|e| ("NOT_FOUND", e.to_string()))?;
                let hint = params.get("serviceHint").and_then(Value::as_str);
                let baseline = profiling::parse_profile(&baseline_bytes, hint).map_err(|d| {
                    (
                        "INVALID_SCHEMA",
                        serde_json::to_string(&d).unwrap_or_default(),
                    )
                })?;
                let candidate = profiling::parse_profile(&candidate_bytes, hint).map_err(|d| {
                    (
                        "INVALID_SCHEMA",
                        serde_json::to_string(&d).unwrap_or_default(),
                    )
                })?;
                let b_ordinal = params
                    .pointer("/baseline/ordinal")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                let c_ordinal = params
                    .pointer("/candidate/ordinal")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                let b_spec = parse_population_spec(&params, "baseline", &baseline)
                    .map_err(|e| ("INVALID_SCHEMA", e))?;
                let c_spec = parse_population_spec(&params, "candidate", &candidate)
                    .map_err(|e| ("INVALID_SCHEMA", e))?;
                let b_trace = params
                    .get("baselineTrace")
                    .and_then(|v| parse_trace_window(v).ok());
                let c_trace = params
                    .get("candidateTrace")
                    .and_then(|v| parse_trace_window(v).ok());
                let declare = params.get("declareEquivalent").and_then(|v| {
                    serde_json::from_value::<profiling::EquivalenceDeclaration>(v.clone()).ok()
                });
                let res = profiling::compare_profiles(
                    (&baseline, b_ordinal, &b_spec),
                    (&candidate, c_ordinal, &c_spec),
                    b_trace.as_ref(),
                    c_trace.as_ref(),
                    declare.as_ref(),
                );
                serde_json::to_value(res).map_err(|e| ("STORAGE_FAILURE", e.to_string()))
            })()
        }
        // Tree offload: walk + SHA-256 every file in native code (§29.2). Params: path, exclude?[]
        // (absent = only ".git"; present = exactly that set, possibly empty), known?{rel:{size,mtimeMs,hash}}
        // inline or via knownPath (a handle file, for caches too large to frame).
        "contentRoot" => (move || -> Result<Value, (&str, String)> {
            let params = req.pointer("/params").cloned().unwrap_or(Value::Null);
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or(("INVALID_SCHEMA", "params.path required".into()))?;
            let exclude: Option<Vec<String>> = match params.get("exclude") {
                None | Some(Value::Null) => None,
                Some(v) => Some(
                    serde_json::from_value(v.clone())
                        .map_err(|e| ("INVALID_SCHEMA", format!("params.exclude: {e}")))?,
                ),
            };
            let known = parse_known(&params).map_err(|e| ("INVALID_SCHEMA", e))?;
            let tree =
                canon::content_root_of_tree(Path::new(path), exclude.as_deref(), known.as_ref())
                    .map_err(|e| (e.code, e.message))?;
            serde_json::to_value(tree).map_err(|e| ("STORAGE_FAILURE", e.to_string()))
        })(),
        // Concept-hierarchy offload (plan §0.6): motif matching over a whole repo's program-graph batch.
        // Params: { pdgs: Pdg[] } — response preserves input order, matches in catalogue order.
        "conceptMotifs" => (move || -> Result<Value, (&str, String)> {
            let params = req.pointer("/params").cloned().unwrap_or(Value::Null);
            let pdgs: Vec<motifs::Pdg> = match params.get("pdgs") {
                Some(v) => serde_json::from_value(v.clone())
                    .map_err(|e| ("INVALID_SCHEMA", format!("params.pdgs: {e}")))?,
                None => return Err(("INVALID_SCHEMA", "params.pdgs required".into())),
            };
            serde_json::to_value(motifs::match_motif_batch(&pdgs))
                .map_err(|e| ("STORAGE_FAILURE", e.to_string()))
        })(),
        other => Err(("INVALID_SCHEMA", format!("unknown op {other:?}"))),
    };
    match result {
        Ok(v) => {
            let s = serde_json::to_vec(&v).unwrap();
            if s.len() > INLINE_LIMIT {
                let path = std::env::temp_dir().join(format!(
                    "cie-handle-{}-{}.json",
                    std::process::id(),
                    id
                ));
                if std::fs::write(&path, &s).is_ok() {
                    return json!({"id": id, "ok": true, "handle": path.to_string_lossy()});
                }
            }
            json!({"id": id, "ok": true, "result": v})
        }
        Err((code, message)) => {
            json!({"id": id, "ok": false, "error": {"code": code, "message": message, "retryable": false}})
        }
    }
}

// ---------------------------------------------------------------------------------------------- one-shot CLI (tree offload)

fn fail_usage(message: &'static str) -> ! {
    println!(
        "{}",
        json!({"error": {"code": "INVALID_SCHEMA", "message": message}})
    );
    std::process::exit(64);
}

/// One-shot mode for the synchronous TS call sites (contracts §10: the workers' protocol is frames,
/// but those call paths are synchronous, so blocking on a child one-shot keeps the call graph intact
/// while the hashing still runs in native code):
/// `worker contentRoot <path> [--exclude <name>]... [--exclude-none] [--known <file>]`
/// Prints exactly one JSON line on stdout; exits 0 on success, 1 on a refused tree, 64 on usage
/// errors. Without --exclude/--exclude-none, only ".git" is skipped (the TS walker's default).
fn content_root_one_shot(args: &[String]) {
    let mut path: Option<&String> = None;
    let mut exclude: Vec<String> = Vec::new();
    let mut explicit_exclude = false;
    let mut known_file: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--exclude" => {
                if i + 1 >= args.len() {
                    fail_usage("--exclude needs a name");
                }
                exclude.push(args[i + 1].clone());
                explicit_exclude = true;
                i += 2;
            }
            "--exclude-none" => {
                explicit_exclude = true;
                i += 1;
            }
            "--known" => {
                if i + 1 >= args.len() {
                    fail_usage("--known needs a file");
                }
                known_file = Some(args[i + 1].clone());
                i += 2;
            }
            other if other.starts_with("--") => fail_usage("unknown flag"),
            _ => {
                if path.is_some() {
                    fail_usage("only one root path is accepted");
                }
                path = Some(&args[i]);
                i += 1;
            }
        }
    }
    let root = match path {
        Some(p) => p,
        None => fail_usage("a root path is required"),
    };
    let known = match &known_file {
        Some(f) => match std::fs::read_to_string(f) {
            Ok(text) => match serde_json::from_str::<HashMap<String, KnownHash>>(&text) {
                Ok(m) => Some(m),
                Err(e) => {
                    println!(
                        "{}",
                        json!({"error": {"code": "INVALID_SCHEMA", "message": format!("{f}: {e}")} })
                    );
                    std::process::exit(1);
                }
            },
            Err(e) => {
                println!(
                    "{}",
                    json!({"error": {"code": "NOT_FOUND", "message": format!("{f}: {e}")} })
                );
                std::process::exit(1);
            }
        },
        None => None,
    };
    let exclude_arg: Option<&[String]> = if explicit_exclude {
        Some(&exclude)
    } else {
        None
    };
    match canon::content_root_of_tree(Path::new(root.as_str()), exclude_arg, known.as_ref()) {
        Ok(tree) => println!("{}", serde_json::to_string(&tree).unwrap()),
        Err(e) => {
            println!(
                "{}",
                json!({"error": {"code": e.code, "message": e.message}})
            );
            std::process::exit(1);
        }
    }
}

/// One-shot mode for the concept-hierarchy motif phase: `worker conceptMotifs <pdgs.json>` where the
/// file holds the graphs as a JSON array (the same objects `pdg.ts` produces). One process per build
/// keeps the synchronous call site intact while every repo-wide graph scan runs natively.
/// One-shot mode for the concept-hierarchy graph phase: `worker irPdgs <entities.json>` where the
/// file holds `{maxStatements, entities:[{entityId,file,irHash,irDump}]}` — folding each entity's
/// stored semantic IR into its PDG in Rust (core keeps the reference folder and the reuse plan).
fn ir_pdgs_one_shot(args: &[String]) {
    let path = match args.first() {
        Some(p) if !args.iter().skip(1).any(|a| a.starts_with("--")) => p,
        _ => fail_usage("exactly one input file is required"),
    };
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            println!("{}", json!({"error": {"code": "NOT_FOUND", "message": format!("{path}: {e}")}}));
            std::process::exit(1);
        }
    };
    let req: irpdg::IrPdgRequest = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            println!("{}", json!({"error": {"code": "INVALID_SCHEMA", "message": e.to_string()}}));
            std::process::exit(1);
        }
    };
    println!("{}", json!({"results": irpdg::fold_batch(&req)}));
}

/// One-shot mode for IR-first model contexts: `worker irRender <entities.json>` where the file
/// holds `{maxLines?, entities:[{entityId, irDump}]}` — renders each stored semantic IR dump as
/// deterministic pseudocode (irrender.rs); core keeps the thin router and the budget.
fn ir_render_one_shot(args: &[String]) {
    let path = match args.first() {
        Some(p) if !args.iter().skip(1).any(|a| a.starts_with("--")) => p,
        _ => fail_usage("exactly one input file is required"),
    };
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            println!("{}", json!({"error": {"code": "NOT_FOUND", "message": format!("{path}: {e}")}}));
            std::process::exit(1);
        }
    };
    let req: irrender::IrRenderRequest = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            println!("{}", json!({"error": {"code": "INVALID_SCHEMA", "message": e.to_string()}}));
            std::process::exit(1);
        }
    };
    println!("{}", json!({"results": irrender::render_batch(&req)}));
}

fn concept_motifs_one_shot(args: &[String]) {
    let path = match args.first() {
        Some(p) if !args.iter().skip(1).any(|a| a.starts_with("--")) => p,
        _ => fail_usage("exactly one input file is required"),
    };
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            println!(
                "{}",
                json!({"error": {"code": "NOT_FOUND", "message": format!("{path}: {e}")}})
            );
            std::process::exit(1);
        }
    };
    let pdgs: Vec<motifs::Pdg> = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            println!(
                "{}",
                json!({"error": {"code": "INVALID_SCHEMA", "message": format!("{path}: {e}")}})
            );
            std::process::exit(1);
        }
    };
    println!(
        "{}",
        serde_json::to_string(&motifs::match_motif_batch(&pdgs)).unwrap()
    );
}

fn main() {
    let argv: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().to_string())
        .collect();
    if !argv.is_empty() {
        if argv[0] == "semanticLanguages"
            || argv[0] == "semanticLower"
            || argv[0] == "semanticAnalyze"
        {
            let result = (|| -> Result<Value, String> {
                let registry = analysis_foundation::languages::Registry::builtins()?;
                if argv[0] == "semanticLanguages" {
                    if argv.len() != 1 {
                        return Err("semanticLanguages takes no arguments".into());
                    }
                    return serde_json::to_value(registry.metadata()).map_err(|e| e.to_string());
                }
                if argv.len() != 2 {
                    return Err(
                        "semanticLower/semanticAnalyze require one request JSON file".into(),
                    );
                }
                let request: analysis_foundation::languages::Request =
                    serde_json::from_slice(&std::fs::read(&argv[1]).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                let lowered = registry.lower(&request)?;
                if argv[0] == "semanticAnalyze" {
                    let analysis = analysis_foundation::source_analysis::analyze(
                        &lowered.snapshot,
                        &lowered.sources,
                        &Default::default(),
                    )?;
                    Ok(json!({"lowering":lowered,"analysis":analysis}))
                } else {
                    serde_json::to_value(lowered).map_err(|e| e.to_string())
                }
            })();
            match result {
                Ok(result) => println!("{result}"),
                Err(message) => {
                    println!(
                        "{}",
                        json!({"error":{"code":"SEMANTIC_ADAPTER_ERROR","message":message}})
                    );
                    std::process::exit(1);
                }
            }
            return;
        }
        if argv[0] == "semanticCheck" {
            let result=(|| -> Result<Value,String> {
                if argv.len()!=3{return Err("semanticCheck requires source-request.json and contracts.json".into())}
                let bytes=std::fs::read(&argv[1]).map_err(|e|e.to_string())?;
                let request:analysis_foundation::languages::Request=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
                let registry=analysis_foundation::behavior::Registry::parse(&std::fs::read(&argv[2]).map_err(|e|e.to_string())?)?;
                let lowered=analysis_foundation::languages::Registry::builtins()?.lower(&request)?;
                let report=analysis_foundation::behavior::check(&lowered.snapshot,&lowered.sources,&registry,&Default::default())?;
                serde_json::to_value(report).map_err(|e|e.to_string())
            })();
            match result{Ok(value)=>println!("{value}"),Err(message)=>{println!("{}",json!({"error":{"code":"INVALID_BEHAVIOR_INPUT","message":message}}));std::process::exit(1);}}
            return;
        }
        if argv[0] == "analysisFoundation" {
            let result = (|| -> Result<_, String> {
                if argv.len() != 2 { return Err("analysisFoundation requires exactly one snapshot JSON file".into()); }
                let bytes = std::fs::read(&argv[1]).map_err(|e| e.to_string())?;
                let snapshot: analysis_foundation::Snapshot = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                analysis_foundation::analyze(&snapshot, 100_000)
            })();
            match result {
                Ok(result) => println!("{}", serde_json::to_string(&result).unwrap()),
                Err(message) => {
                    println!("{}", json!({"error": {"code": "INVALID_FOUNDATION_INPUT", "message": message}}));
                    std::process::exit(1);
                }
            }
            return;
        }
        if argv[0] == "contentRoot" {
            content_root_one_shot(&argv[1..]);
            return;
        }
        if argv[0] == "irPdgs" {
            ir_pdgs_one_shot(&argv[1..]);
            return;
        }
        if argv[0] == "irRender" {
            ir_render_one_shot(&argv[1..]);
            return;
        }
        if argv[0] == "conceptMotifs" {
            concept_motifs_one_shot(&argv[1..]);
            return;
        }
        eprintln!(
            "unknown one-shot command {:?} (expected: contentRoot | conceptMotifs)",
            argv[0]
        );
        std::process::exit(64);
    }
    let (mut inp, mut out) = (stdin().lock(), stdout().lock());
    loop {
        let frame = match read_frame(&mut inp) {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(FrameError::TooLarge(n)) => {
                // Can't resync after an oversize header; report and stop.
                let e = json!({"id": null, "ok": false, "error": {"code": "RESOURCE_LIMIT", "message": format!("frame of {n} bytes exceeds limit"), "retryable": false}});
                let _ = write_frame(&mut out, &serde_json::to_vec(&e).unwrap());
                std::process::exit(2);
            }
            Err(FrameError::Io(e)) => {
                eprintln!("worker input framing error: {e}");
                break;
            }
        };
        let resp = match serde_json::from_slice::<Value>(&frame) {
            Ok(req) => handle(&req),
            Err(e) => {
                json!({"id": null, "ok": false, "error": {"code": "INVALID_SCHEMA", "message": e.to_string(), "retryable": false}})
            }
        };
        if write_frame(&mut out, &serde_json::to_vec(&resp).unwrap()).is_err() {
            break;
        }
    }
}
