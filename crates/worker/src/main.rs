//! Rust worker (contracts §10): C04–C09 collapsed. Speaks length-prefixed JSON on stdio.
mod index;
mod language;
mod model;
mod protocol;
mod rust_language;
mod source_ir;

use protocol::{read_frame, write_frame, FrameError};
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
            "nirdosha-v2": ["PARSED_AS_RUST", "RESOLVED(path modules, crate modules, Nirdosha screen macros)"]
        }})),
        "index" => match req.pointer("/params/repoPath").and_then(Value::as_str) {
            None => Err(("INVALID_SCHEMA", "params.repoPath required".into())),
            Some(p) => index::index_repo(Path::new(p))
                .map_err(|e| ("NOT_FOUND", e))
                .and_then(|b| serde_json::to_value(b).map_err(|e| ("STORAGE_FAILURE", e.to_string()))),
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
