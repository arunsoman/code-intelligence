//! Rust worker (contracts §10): C04–C09 collapsed. Speaks length-prefixed JSON on stdio.
mod dataflow;
mod frameworks;
mod index;
mod canon;
mod language;
mod metrics;
mod model;
mod polyglot;
mod profiling;
mod protocol;
mod regexfind;
mod rust_language;
mod source_ir;

use protocol::{read_frame, write_frame, FrameError};
use crate::model::{BaseRef, ChangeSet};
use serde_json::{json, Value};
use std::io::{stdin, stdout};
use std::path::Path;

/// Responses above this go through a content handle (a file the parent reads) instead of a frame.
const INLINE_LIMIT: usize = 4 * 1024 * 1024;

fn profile_rpc<F, T: serde::Serialize>(req: &Value, f: F) -> Result<Value, (&str, String)>
where
    F: FnOnce(&[u8], Option<&str>) -> Result<T, Vec<profiling::Diagnostic>>,
{
    let params = req.pointer("/params").cloned().unwrap_or(Value::Null);
    let path = params.get("path").and_then(Value::as_str).ok_or(("INVALID_SCHEMA", "params.path required".into()))?;
    let hint = params.get("serviceHint").and_then(Value::as_str);
    let bytes = std::fs::read(path).map_err(|e| ("NOT_FOUND", e.to_string()))?;
    let result = f(&bytes, hint).map_err(|diagnostics| {
        ("INVALID_SCHEMA", serde_json::to_string(&diagnostics).unwrap_or_default())
    })?;
    serde_json::to_value(result).map_err(|e| ("STORAGE_FAILURE", e.to_string()))
}

fn parse_trace_window(v: &Value) -> Result<profiling::TraceWindow, String> {
    let service = v.get("service").and_then(Value::as_str).ok_or_else(|| "trace.service required".to_string())?;
    let instance = v.get("instance").and_then(Value::as_str);
    let from_ns = v.get("fromNs").and_then(Value::as_i64).ok_or_else(|| "trace.fromNs required".to_string())?;
    let to_ns = v.get("toNs").and_then(Value::as_i64).ok_or_else(|| "trace.toNs required".to_string())?;
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
    let from_ns = base.get("fromNs").and_then(Value::as_i64).unwrap_or(profile.start_ns);
    let to_ns = base.get("toNs").and_then(Value::as_i64).unwrap_or(profile.end_ns);
    let revision = base.get("revision").and_then(Value::as_str).map(|s| s.to_string());
    let kind = base
        .get("sampleTypeKind")
        .and_then(|v| serde_json::from_value::<profiling::SampleKind>(v.clone()).ok())
        .unwrap_or_else(|| profile.sample_types.first().map(|st| st.kind.clone()).unwrap_or(profiling::SampleKind::Other));
    Ok(profiling::PopulationSpec {
        service,
        window_from_ns: from_ns,
        window_to_ns: to_ns,
        revision,
        sample_type_kind: kind,
    })
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
                let changes: Option<ChangeSet> = req.pointer("/params/changes").and_then(|v| serde_json::from_value(v.clone()).ok());
                let base: Option<BaseRef> = req.pointer("/params/base").and_then(|v| serde_json::from_value(v.clone()).ok());
                match index::index_repo(Path::new(p), changes.as_ref(), base.as_ref()) {
                    Err(e) => Err(("NOT_FOUND", e)),
                    // The batch is streamed straight to a handle file: no intermediate JSON value and no second copy in a byte
                    // buffer, which together cost several times the batch itself at the peak.
                    Ok(b) => {
                        let path = std::env::temp_dir().join(format!("cie-handle-{}-{}.json", std::process::id(), id));
                        let written = std::fs::File::create(&path)
                            .map(std::io::BufWriter::new)
                            .map_err(|e| e.to_string())
                            .and_then(|mut w| serde_json::to_writer(&mut w, &b).map_err(|e| e.to_string()).and_then(|_| std::io::Write::flush(&mut w).map_err(|e| e.to_string())));
                        match written {
                            Ok(()) => return json!({"id": id, "ok": true, "handle": path.to_string_lossy()}),
                            Err(e) => Err(("STORAGE_FAILURE", e)),
                        }
                    }
                }
            }
        },
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
            let ordinal = req.pointer("/params/ordinal").and_then(Value::as_u64).unwrap_or(0) as usize;
            let order = req.pointer("/params/order").and_then(Value::as_str).unwrap_or("SELF");
            let limit = req.pointer("/params/limit").and_then(Value::as_u64).unwrap_or(50) as usize;
            profiling::query_hotspots_from_bytes(bytes, hint, ordinal, order, limit)
        }),
        "buildFlamegraph" => profile_rpc(req, |bytes, hint| {
            let ordinal = req.pointer("/params/ordinal").and_then(Value::as_u64).unwrap_or(0) as usize;
            profiling::build_flamegraph_from_bytes(bytes, hint, ordinal)
        }),
        "correlateProfile" => {
            let params = req.pointer("/params").cloned().unwrap_or(Value::Null);
            (move || -> Result<Value, (&str, String)> {
                let p = params.get("path").and_then(Value::as_str).ok_or(("INVALID_SCHEMA", "params.path required".into()))?;
                let bytes = std::fs::read(p).map_err(|e| ("NOT_FOUND", e.to_string()))?;
                let hint = params.get("serviceHint").and_then(Value::as_str);
                let parsed = profiling::parse_profile(&bytes, hint).map_err(|d| ("INVALID_SCHEMA", serde_json::to_string(&d).unwrap_or_default()))?;
                let trace = parse_trace_window(&params).map_err(|e| ("INVALID_SCHEMA", e))?;
                let build_id = params.get("buildId").and_then(Value::as_str);
                let revision = params.get("revision").and_then(Value::as_str);
                let artifact_hash = profiling::artifact_hash(&bytes);
                let corr = profiling::correlate_profile_trace(&artifact_hash, &parsed, &trace, build_id, revision);
                serde_json::to_value(corr).map_err(|e| ("STORAGE_FAILURE", e.to_string()))
            })()
        }
        "compareProfiles" => {
            let params = req.pointer("/params").cloned().unwrap_or(Value::Null);
            (move || -> Result<Value, (&str, String)> {
                let baseline_path = params.get("baselinePath").and_then(Value::as_str).ok_or(("INVALID_SCHEMA", "params.baselinePath required".into()))?;
                let candidate_path = params.get("candidatePath").and_then(Value::as_str).ok_or(("INVALID_SCHEMA", "params.candidatePath required".into()))?;
                let baseline_bytes = std::fs::read(baseline_path).map_err(|e| ("NOT_FOUND", e.to_string()))?;
                let candidate_bytes = std::fs::read(candidate_path).map_err(|e| ("NOT_FOUND", e.to_string()))?;
                let hint = params.get("serviceHint").and_then(Value::as_str);
                let baseline = profiling::parse_profile(&baseline_bytes, hint).map_err(|d| ("INVALID_SCHEMA", serde_json::to_string(&d).unwrap_or_default()))?;
                let candidate = profiling::parse_profile(&candidate_bytes, hint).map_err(|d| ("INVALID_SCHEMA", serde_json::to_string(&d).unwrap_or_default()))?;
                let b_ordinal = params.pointer("/baseline/ordinal").and_then(Value::as_u64).unwrap_or(0) as usize;
                let c_ordinal = params.pointer("/candidate/ordinal").and_then(Value::as_u64).unwrap_or(0) as usize;
                let b_spec = parse_population_spec(&params, "baseline", &baseline).map_err(|e| ("INVALID_SCHEMA", e))?;
                let c_spec = parse_population_spec(&params, "candidate", &candidate).map_err(|e| ("INVALID_SCHEMA", e))?;
                let b_trace = params.get("baselineTrace").and_then(|v| parse_trace_window(v).ok());
                let c_trace = params.get("candidateTrace").and_then(|v| parse_trace_window(v).ok());
                let declare = params
                    .get("declareEquivalent")
                    .and_then(|v| serde_json::from_value::<profiling::EquivalenceDeclaration>(v.clone()).ok());
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
        other => Err(("INVALID_SCHEMA", format!("unknown op {other:?}"))),
    };
    match result {
        Ok(v) => {
            let s = serde_json::to_vec(&v).unwrap();
            if s.len() > INLINE_LIMIT {
                let path = std::env::temp_dir().join(format!("cie-handle-{}-{}.json", std::process::id(), id));
                if std::fs::write(&path, &s).is_ok() {
                    return json!({"id": id, "ok": true, "handle": path.to_string_lossy()});
                }
            }
            json!({"id": id, "ok": true, "result": v})
        }
        Err((code, message)) => json!({"id": id, "ok": false, "error": {"code": code, "message": message, "retryable": false}}),
    }
}

fn main() {
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
            Err(e) => json!({"id": null, "ok": false, "error": {"code": "INVALID_SCHEMA", "message": e.to_string(), "retryable": false}}),
        };
        if write_frame(&mut out, &serde_json::to_vec(&resp).unwrap()).is_err() {
            break;
        }
    }
}
