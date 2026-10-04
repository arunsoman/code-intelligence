//! F01 / decision D1: regex verification for text search runs here, not in the host process.
//! Node's `RegExp` backtracks and can be driven to catastrophic runtime by a hostile pattern;
//! the `regex` crate is linear in the input size and rejects constructs it cannot run
//! (backreferences, look-around) with a clear error, which the host reports rather than
//! approximating. Every bound (deadline, match cap, file cap) is enforced here.

use regex::bytes::RegexBuilder as BytesRegexBuilder;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The regex must keep the host's deadline even for huge inputs: verification stops at the
/// deadline and reports what was covered, rather than exceeding it.
const DEFAULT_DEADLINE_MS: u64 = 5_000;
const MAX_FILES_PER_CALL: usize = 20_000;
const MAX_PATTERN_BYTES: usize = 8 * 1024;
const MAX_TOTAL_MATCHES: usize = 5_000;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// The compiled program itself can be made pathological (a huge bounded repetition); the engine's
/// size limit catches that too.
const STATE_LIMIT: usize = 8 * (1 << 20);

fn unsupported_construct(err: &regex::Error) -> Option<&'static str> {
    let s = err.to_string().to_lowercase();
    if s.contains("backreference") || s.contains("back reference") || s.contains("backreferences") {
        return Some("backreference");
    }
    if s.contains("look-around") || s.contains("lookaround") || s.contains("look-ahead") || s.contains("lookahead") {
        return Some("lookaround");
    }
    None
}

struct Input {
    root: PathBuf,
    files: Vec<String>,
    pattern: String,
    case_sensitive: bool,
    deadline_ms: u64,
    max_matches_per_file: usize,
    max_total_matches: usize,
}

fn parse(params: &Value) -> Result<Input, (&'static str, String)> {
    let root = params
        .get("root")
        .and_then(Value::as_str)
        .ok_or_else(|| ("INVALID_SCHEMA", "params.root required".to_string()))?
        .to_string();
    let files = params
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| ("INVALID_SCHEMA", "params.files must be an array".to_string()))?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    if files.len() > MAX_FILES_PER_CALL {
        return Err(("BUDGET_EXCEEDED", format!("more than {MAX_FILES_PER_CALL} files were passed per call; split the request")));
    }
    let pattern = params
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or_else(|| ("INVALID_SCHEMA", "params.pattern required".to_string()))?
        .to_string();
    if pattern.is_empty() {
        return Err(("INVALID_SCHEMA", "the empty pattern matches every position and is refused; search with a literal instead".to_string()));
    }
    if pattern.len() > MAX_PATTERN_BYTES {
        return Err(("BUDGET_EXCEEDED", format!("pattern is longer than the {MAX_PATTERN_BYTES}-byte limit")));
    }
    Ok(Input {
        root: PathBuf::from(root),
        files,
        pattern,
        case_sensitive: params.get("caseSensitive").and_then(Value::as_bool).unwrap_or(false),
        deadline_ms: params
            .get("deadlineMs")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_DEADLINE_MS)
            .min(DEFAULT_DEADLINE_MS),
        max_matches_per_file: params.get("maxMatchesPerFile").and_then(Value::as_u64).unwrap_or(200) as usize,
        max_total_matches: params.get("maxTotalMatches").and_then(Value::as_u64).unwrap_or(MAX_TOTAL_MATCHES as u64) as usize,
    })
}

/// Index of the last line start not greater than `offset` (a small forward scan; line starts are
/// sorted and the offsets of successive matches are increasing).
fn line_number(line_starts: &[usize], offset: usize) -> usize {
    match line_starts.binary_search(&offset) {
        Ok(i) => i + 1,
        Err(i) => i,
    }
}

/// Verify a prefiltered candidate set against a regular expression, reading files from `root`.
/// Files that no longer exist are skipped and counted (the index may be a little ahead of the
/// worktree; that is a coverage fact, not an error). Never guesses.
pub fn regex_verify(root: &Path, params: &Value) -> Result<Value, (&'static str, String)> {
    let input = parse(params)?;
    let started = Instant::now();
    let deadline = started + Duration::from_millis(input.deadline_ms);
    let re = BytesRegexBuilder::new(&input.pattern)
        .case_insensitive(!input.case_sensitive)
        .multi_line(true)
        .size_limit(STATE_LIMIT)
        .dfa_size_limit(STATE_LIMIT)
        .build()
        .map_err(|e| {
            ("INVALID_SCHEMA", match unsupported_construct(&e) {
                Some(name) => format!("the pattern uses {} ({name}), which the linear-time engine rejects; this is reported, never approximated", e),
                None => format!("the pattern could not be compiled: {e}"),
            })
        })?;
    let base = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut matches: Vec<Value> = Vec::new();
    let mut files_scanned = 0usize;
    let mut files_missing = 0usize;
    let mut files_too_large = 0usize;
    let mut truncated = false;
    let mut buffer = Vec::new();
    let mut out_of_time = false;
    for f in &input.files {
        if out_of_time && files_scanned > 0 {
            truncated = true;
            break;
        }
        if matches.len() >= input.max_total_matches {
            truncated = true;
            break;
        }
        if Instant::now() > deadline {
            truncated = true;
            break;
        }
        let path = root.join(f);
        // Refuse the file when it escapes `root` after normalization. The paths come from our own
        // index, but a caller is a caller.
        match path.canonicalize() {
            Ok(joined) if joined.starts_with(&base) => {}
            _ => {
                files_missing += 1;
                continue;
            }
        }
        match std::fs::metadata(&path) {
            Ok(m) if m.len() <= MAX_FILE_BYTES => {}
            Ok(_) => {
                files_too_large += 1;
                continue;
            }
            Err(_) => {
                files_missing += 1;
                continue;
            }
        }
        buffer.clear();
        let readable = std::fs::File::open(&path)
            .map(|mut file| file.read_to_end(&mut buffer).is_ok())
            .unwrap_or(false);
        if !readable {
            files_missing += 1;
            continue;
        }
        files_scanned += 1;
        let mut line_starts: Vec<usize> = Vec::new();
        let mut per_file = 0usize;
        for m in re.find_iter(&buffer) {
            if per_file >= input.max_matches_per_file || matches.len() >= input.max_total_matches {
                truncated = true;
                break;
            }
            if Instant::now() > deadline {
                out_of_time = true;
                truncated = true;
                break;
            }
            if line_starts.is_empty() {
                line_starts.push(0);
                for (i, b) in buffer.iter().enumerate() {
                    if *b == b'\n' {
                        line_starts.push(i + 1);
                    }
                }
            }
            matches.push(json!({
                "path": f,
                "startByte": m.start(),
                "endByte": m.end(),
                "line": line_number(&line_starts, m.start()),
                "endLine": line_number(&line_starts, m.end().saturating_sub(1)),
            }));
            per_file += 1;
        }
    }
    Ok(json!({
        "matches": matches,
        "filesScanned": files_scanned,
        "filesMissing": files_missing,
        "filesTooLarge": files_too_large,
        "truncated": truncated,
        "elapsedMs": started.elapsed().as_millis() as u64,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project(dir: &Path, spec: &[(&str, &str)]) {
        for (name, body) in spec {
            let p = dir.join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
    }

    #[test]
    fn finds_matches_with_lines() {
        let dir = std::env::temp_dir().join(format!("cie-rx-{}", std::process::id()));
        project(&dir, &[("src/a.ts", "const createPayment = 1;\ncreatePayment(x);\n")]);
        let v = regex_verify(&dir, &json!({"root": dir, "files": ["src/a.ts"], "pattern": "createPayment", "caseSensitive": true})).unwrap();
        assert_eq!(v["matches"].as_array().unwrap().len(), 2);
        assert_eq!(v["matches"][0]["line"], 1);
        assert_eq!(v["matches"][1]["line"], 2);
        assert_eq!(v["filesScanned"], 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn case_insensitive_by_default() {
        let dir = std::env::temp_dir().join(format!("cie-rxc-{}", std::process::id()));
        project(&dir, &[("a.txt", "CreatePayment\n")]);
        let v = regex_verify(&dir, &json!({"root": dir, "files": ["a.txt"], "pattern": "createpayment"})).unwrap();
        assert_eq!(v["matches"].as_array().unwrap().len(), 1);
        let v2 = regex_verify(&dir, &json!({"root": dir, "files": ["a.txt"], "pattern": "createpayment", "caseSensitive": true})).unwrap();
        assert_eq!(v2["matches"].as_array().unwrap().len(), 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn backreference_is_rejected_with_the_construct_named() {
        let dir = std::env::temp_dir().join(format!("cie-rxb-{}", std::process::id()));
        let e = regex_verify(&dir, &json!({"root": dir, "files": [], "pattern": "(a)\\1"})).unwrap_err();
        assert_eq!(e.0, "INVALID_SCHEMA");
        assert!(e.1.to_lowercase().contains("backreference"), "{e:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lookaround_is_rejected() {
        let dir = std::env::temp_dir().join(format!("cie-rxl-{}", std::process::id()));
        let e = regex_verify(&dir, &json!({"root": dir, "files": [], "pattern": "a(?=b)"})).unwrap_err();
        assert_eq!(e.0, "INVALID_SCHEMA");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The pathological pattern whose backtracking engines hang on. A linear-time engine must
    /// answer well within the deadline regardless of the input shape.
    #[test]
    fn pathological_regex_terminates_within_its_deadline() {
        let dir = std::env::temp_dir().join(format!("cie-rxp-{}", std::process::id()));
        let mut body = String::new();
        for _ in 0..10_000 {
            body.push('a');
        }
        body.push('x');
        project(&dir, &[("big.txt", body.as_str())]);
        let t0 = Instant::now();
        let v = regex_verify(&dir, &json!({"root": dir, "files": ["big.txt"], "pattern": "(a+)+$", "deadlineMs": 3000})).unwrap();
        assert!(t0.elapsed().as_millis() < 4500, "took {}ms", t0.elapsed().as_millis());
        assert_eq!(v["matches"].as_array().unwrap().len(), 0, "no match: the trailing x spoils (a+)+$");
        assert_eq!(v["filesScanned"], 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_files_are_counted_not_errors_and_paths_must_stay_inside_the_root() {
        let dir = std::env::temp_dir().join(format!("cie-rxm-{}", std::process::id()));
        project(&dir, &[("keep.txt", "needle here\n")]);
        let v = regex_verify(&dir, &json!({"root": dir, "files": ["gone.txt", "../../etc/hosts"], "pattern": "root"})).unwrap();
        assert_eq!(v["filesMissing"], 2, "missing and out-of-root files are skipped and counted");
        assert_eq!(v["filesScanned"], 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn match_caps_are_reported_as_truncated() {
        let dir = std::env::temp_dir().join(format!("cie-rxt-{}", std::process::id()));
        project(&dir, &[("x.txt", "aa aa aa aa\n")]);
        let v = regex_verify(&dir, &json!({"root": dir, "files": ["x.txt"], "pattern": "aa", "maxMatchesPerFile": 2})).unwrap();
        assert_eq!(v["matches"].as_array().unwrap().len(), 2);
        assert_eq!(v["truncated"], true);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn non_utf8_files_still_search_as_bytes() {
        let dir = std::env::temp_dir().join(format!("cie-rxu-{}", std::process::id()));
        project(&dir, &[("bin.dat", "")]);
        std::fs::write(dir.join("bin.dat"), [0x61u8, 0x62, 0xFF, 0x63, 0x62, 0x61]).unwrap();
        let v = regex_verify(&dir, &json!({"root": dir, "files": ["bin.dat"], "pattern": "ba"})).unwrap();
        let ms = v["matches"].as_array().unwrap();
        assert_eq!(ms.len(), 1, "one match over the raw bytes (position 4): 0xFF is not matched past");
        assert_eq!(ms[0]["startByte"], 4);
        std::fs::remove_dir_all(&dir).ok();
    }
}