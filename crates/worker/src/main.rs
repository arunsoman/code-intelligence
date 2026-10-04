//! Rust worker (contracts §10): C04–C09 collapsed. Speaks length-prefixed JSON on stdio.
mod index;
mod language;
mod model;
mod polyglot;
mod protocol;
mod rust_language;
mod source_ir;

use protocol::{read_frame, write_frame, FrameError};
use crate::model::ChangeSet;
use serde_json::{json, Value};
use std::io::{stdin, stdout};
use std::path::Path;

/// Responses above this go through a content handle (a file the parent reads) instead of a frame.
const INLINE_LIMIT: usize = 4 * 1024 * 1024;

fn handle(req: &Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let op = req.get("op").and_then(Value::as_str).unwrap_or("");
    let result: Result<Value, (&str, String)> = match op {
        "ping" => Ok(json!({"pong": true, "analyzerVersion": index::ANALYZER_VERSION})),
        "languageCapabilities" => Ok(json!({"languages": {
            "typescript": ["PARSED", "RESOLVED(relative imports, same-file, namespace)"],
            "rust": ["PARSED", "RESOLVED(crate/self/super modules, same-file, imported functions)"],
            "java": ["PARSED", "RESOLVED(imports, same package, calls through fields and parameters of a declared type)", "Spring: @Transactional, @KafkaListener/@RabbitListener/@JmsListener, template sends"],
            "go": ["PARSED", "RESOLVED(package imports, same package, methods on receivers and typed struct fields)"],
            "python": ["PARSED", "RESOLVED(absolute, relative and aliased imports, self methods, attributes typed by annotated parameters)"],
            "nirdosha-v2": ["PARSED_AS_RUST", "RESOLVED(path modules, crate modules, Nirdosha screen macros)"]
        }})),
        "index" => match req.pointer("/params/repoPath").and_then(Value::as_str) {
            None => Err(("INVALID_SCHEMA", "params.repoPath required".into())),
            Some(p) => {
                let changes: Option<ChangeSet> = req.pointer("/params/changes").and_then(|v| serde_json::from_value(v.clone()).ok());
                match index::index_repo(Path::new(p), changes.as_ref()) {
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
