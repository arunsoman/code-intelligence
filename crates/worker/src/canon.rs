//! pf-canon-v1 (Prompt-to-feature §29): the Rust half of the cross-runtime identity protocol. It must produce the same
//! bytes and digests as `packages/core/src/feature/canon.ts` for every vector in `fixtures/canon/canon-vectors.json`;
//! `cargo test` and `node --test` read that one file, and exact-bound publication stays disabled until both agree.
//!
//! The parser is hand-written on purpose: serde_json cannot report duplicate keys or `-0`, and it normalises numbers.
#![allow(dead_code)]
use sha2::{Digest, Sha256};

pub const PROTOCOL: &str = "pf-canon-v1";
const MAX_DEPTH: usize = 128;
const MAX_SAFE: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq)]
pub enum Canon {
    Null,
    Bool(bool),
    Str(String),
    Int(i64),
    Arr(Vec<Canon>),
    /// Insertion order is kept here; canonicalisation sorts by key bytes.
    Obj(Vec<(String, Canon)>),
    /// A schema-designated set (sorted by canonical element bytes; duplicates rejected).
    Set(Vec<Canon>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    UnsupportedValue, UnsafeNumber, NegativeZero, BadString, BadKey, DuplicateKey, DuplicateSetElement,
    BadUtf8, BadJson, BadSchema, BadDecimal, BadPath,
}
impl Code {
    /// The same identifiers the TypeScript implementation throws.
    pub fn name(self) -> &'static str {
        match self {
            Code::UnsupportedValue => "UNSUPPORTED_VALUE", Code::UnsafeNumber => "UNSAFE_NUMBER", Code::NegativeZero => "NEGATIVE_ZERO",
            Code::BadString => "BAD_STRING", Code::BadKey => "BAD_KEY", Code::DuplicateKey => "DUPLICATE_KEY",
            Code::DuplicateSetElement => "DUPLICATE_SET_ELEMENT", Code::BadUtf8 => "BAD_UTF8", Code::BadJson => "BAD_JSON",
            Code::BadSchema => "BAD_SCHEMA", Code::BadDecimal => "BAD_DECIMAL", Code::BadPath => "BAD_PATH",
        }
    }
}
#[derive(Debug, Clone, PartialEq)]
pub struct CanonError { pub code: Code, pub message: String }
fn err<T>(code: Code, message: impl Into<String>) -> Result<T, CanonError> { Err(CanonError { code, message: message.into() }) }

// ---------------------------------------------------------------------------------------------- canonical bytes

fn quote(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn canonicalize(v: &Canon) -> Result<String, CanonError> { let mut s = String::new(); write(v, 0, &mut s)?; Ok(s) }

fn write(v: &Canon, depth: usize, out: &mut String) -> Result<(), CanonError> {
    if depth > MAX_DEPTH { return err(Code::UnsupportedValue, "value is nested too deeply"); }
    match v {
        Canon::Null => out.push_str("null"),
        Canon::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Canon::Str(s) => quote(s, out),
        Canon::Int(n) => {
            if n.abs() > MAX_SAFE { return err(Code::UnsafeNumber, "only safe integers are allowed"); }
            out.push_str(&n.to_string());
        }
        Canon::Arr(items) => {
            out.push('[');
            for (i, e) in items.iter().enumerate() { if i > 0 { out.push(','); } write(e, depth + 1, out)?; }
            out.push(']');
        }
        Canon::Set(items) => {
            let mut parts = Vec::with_capacity(items.len());
            for e in items { let mut s = String::new(); write(e, depth + 1, &mut s)?; parts.push(s); }
            parts.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            if parts.windows(2).any(|w| w[0] == w[1]) { return err(Code::DuplicateSetElement, "a set holds the same canonical element twice"); }
            out.push('['); out.push_str(&parts.join(",")); out.push(']');
        }
        Canon::Obj(fields) => {
            let mut sorted: Vec<&(String, Canon)> = fields.iter().collect();
            for (k, _) in &sorted { if k.is_empty() || !k.is_ascii() { return err(Code::BadKey, format!("object keys are non-empty ASCII schema field names: {k:?}")); } }
            sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            out.push('{');
            for (i, (k, val)) in sorted.iter().enumerate() {
                if i > 0 { out.push(','); }
                quote(k, out); out.push(':'); write(val, depth + 1, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

pub fn sha_hex(bytes: &[u8]) -> String { Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect() }

/// Digest over: protocol, NUL, schema, NUL, version, NUL, canonical payload.
pub fn canon_digest(schema: &str, version: &str, canonical: &str) -> String {
    let mut pre = Vec::new();
    pre.extend_from_slice(PROTOCOL.as_bytes()); pre.push(0);
    pre.extend_from_slice(schema.as_bytes()); pre.push(0);
    pre.extend_from_slice(version.as_bytes()); pre.push(0);
    pre.extend_from_slice(canonical.as_bytes());
    sha_hex(&pre)
}
pub fn raw_hash(bytes: &[u8]) -> String { sha_hex(bytes) }

// ---------------------------------------------------------------------------------------------- decimals

pub fn canon_decimal(input: &str) -> Result<String, CanonError> {
    let b = input.as_bytes();
    let mut i = 0;
    let neg = if i < b.len() && (b[i] == b'+' || b[i] == b'-') { i += 1; b[0] == b'-' } else { false };
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() { i += 1; }
    if i == int_start { return err(Code::BadDecimal, format!("not a decimal: {input:?}")); }
    let int = &input[int_start..i];
    let mut frac = "";
    if i < b.len() && b[i] == b'.' {
        let fs = i + 1; i = fs;
        while i < b.len() && b[i].is_ascii_digit() { i += 1; }
        if i == fs { return err(Code::BadDecimal, format!("not a decimal: {input:?}")); }
        frac = &input[fs..i];
    }
    if i != b.len() { return err(Code::BadDecimal, format!("not a decimal: {input:?}")); }
    let int = { let t = int.trim_start_matches('0'); if t.is_empty() { "0" } else { t } };
    let frac = frac.trim_end_matches('0');
    let zero = int == "0" && frac.is_empty();
    Ok(format!("{}{}{}{}", if neg && !zero { "-" } else { "" }, int, if frac.is_empty() { "" } else { "." }, frac))
}

// ---------------------------------------------------------------------------------------------- strict JSON ingress

pub fn parse_strict_json(input: &[u8]) -> Result<Canon, CanonError> {
    let text = match std::str::from_utf8(input) { Ok(t) => t, Err(_) => return err(Code::BadUtf8, "input is not valid UTF-8") };
    let mut p = P { b: text.as_bytes(), t: text, i: 0 };
    let v = p.value(0)?; p.ws();
    if p.i != p.b.len() { return p.fail("trailing characters"); }
    Ok(v)
}

struct P<'a> { b: &'a [u8], t: &'a str, i: usize }
impl<'a> P<'a> {
    fn fail<T>(&self, m: &str) -> Result<T, CanonError> { err(Code::BadJson, format!("{m} at offset {}", self.i)) }
    fn ws(&mut self) { while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') { self.i += 1; } }
    fn peek(&self) -> Option<u8> { self.b.get(self.i).copied() }
    fn value(&mut self, depth: usize) -> Result<Canon, CanonError> {
        if depth > MAX_DEPTH { return self.fail("nested too deeply"); }
        self.ws();
        match self.peek() {
            Some(b'{') => {
                self.i += 1; let mut o: Vec<(String, Canon)> = Vec::new(); self.ws();
                if self.peek() == Some(b'}') { self.i += 1; return Ok(Canon::Obj(o)); }
                loop {
                    self.ws(); if self.peek() != Some(b'"') { return self.fail("expected a key"); }
                    let k = self.string()?;
                    if o.iter().any(|(e, _)| *e == k) { return err(Code::DuplicateKey, format!("duplicate key {k:?}")); }
                    self.ws(); if self.peek() != Some(b':') { return self.fail("expected ':'"); } self.i += 1;
                    let v = self.value(depth + 1)?; o.push((k, v)); self.ws();
                    match self.peek() { Some(b',') => { self.i += 1; } Some(b'}') => { self.i += 1; return Ok(Canon::Obj(o)); } _ => return self.fail("expected ',' or '}'") }
                }
            }
            Some(b'[') => {
                self.i += 1; let mut a = Vec::new(); self.ws();
                if self.peek() == Some(b']') { self.i += 1; return Ok(Canon::Arr(a)); }
                loop {
                    a.push(self.value(depth + 1)?); self.ws();
                    match self.peek() { Some(b',') => { self.i += 1; } Some(b']') => { self.i += 1; return Ok(Canon::Arr(a)); } _ => return self.fail("expected ',' or ']'") }
                }
            }
            Some(b'"') => Ok(Canon::Str(self.string()?)),
            _ => {
                let rest = &self.b[self.i..];
                if rest.starts_with(b"true") { self.i += 4; return Ok(Canon::Bool(true)); }
                if rest.starts_with(b"false") { self.i += 5; return Ok(Canon::Bool(false)); }
                if rest.starts_with(b"null") { self.i += 4; return Ok(Canon::Null); }
                self.number()
            }
        }
    }
    fn number(&mut self) -> Result<Canon, CanonError> {
        let s = self.i; let mut j = s;
        if self.b.get(j) == Some(&b'-') { j += 1; }
        match self.b.get(j) {
            Some(b'0') => { j += 1; }
            Some(c) if c.is_ascii_digit() => { while self.b.get(j).map_or(false, |c| c.is_ascii_digit()) { j += 1; } }
            _ => return self.fail("unexpected token"),
        }
        let int_end = j;
        let frac = self.b.get(j) == Some(&b'.') && self.b.get(j + 1).map_or(false, |c| c.is_ascii_digit());
        let exp = matches!(self.b.get(j), Some(b'e') | Some(b'E')) && { let k = if matches!(self.b.get(j + 1), Some(b'+') | Some(b'-')) { j + 2 } else { j + 1 }; self.b.get(k).map_or(false, |c| c.is_ascii_digit()) };
        let mut e = j; // fraction / exponent presence is decided before the zero and range checks, as in the TS regex
        if frac { e += 1; while self.b.get(e).map_or(false, |c| c.is_ascii_digit()) { e += 1; } }
        let exp2 = matches!(self.b.get(e), Some(b'e') | Some(b'E'));
        if frac || exp || exp2 { let _ = int_end; return err(Code::UnsafeNumber, "floating-point and exponent numbers are not allowed"); }
        let lit = &self.t[s..int_end];
        if lit == "-0" { return err(Code::NegativeZero, "negative zero is not allowed"); }
        let n: i64 = match lit.parse() { Ok(n) => n, Err(_) => return err(Code::UnsafeNumber, "integer outside the safe range") };
        if n.abs() > MAX_SAFE { return err(Code::UnsafeNumber, "integer outside the safe range"); }
        self.i = int_end; Ok(Canon::Int(n))
    }
    fn hex4(&mut self) -> Result<u32, CanonError> {
        let h = self.t.get(self.i..self.i + 4).filter(|h| h.bytes().all(|c| c.is_ascii_hexdigit()));
        match h { Some(h) => { self.i += 4; Ok(u32::from_str_radix(h, 16).unwrap()) } None => self.fail("bad \\u escape") }
    }
    fn string(&mut self) -> Result<String, CanonError> {
        self.i += 1; let mut out = String::new();
        loop {
            let c = match self.t[self.i..].chars().next() { Some(c) => c, None => return self.fail("unterminated string") };
            self.i += c.len_utf8();
            if c == '"' { return Ok(out); }
            if (c as u32) < 0x20 { return self.fail("raw control character in string"); }
            if c != '\\' { out.push(c); continue; }
            let e = match self.peek() { Some(e) => e, None => return self.fail("bad escape") }; self.i += 1;
            match e {
                b'"' => out.push('"'), b'\\' => out.push('\\'), b'/' => out.push('/'),
                b'b' => out.push('\u{8}'), b'f' => out.push('\u{c}'), b'n' => out.push('\n'), b'r' => out.push('\r'), b't' => out.push('\t'),
                b'u' => {
                    let u = self.hex4()?;
                    if (0xd800..0xdc00).contains(&u) {
                        if self.b.get(self.i) == Some(&b'\\') && self.b.get(self.i + 1) == Some(&b'u') {
                            self.i += 2; let lo = self.hex4()?;
                            if !(0xdc00..0xe000).contains(&lo) { return err(Code::BadString, "escape sequence produced an unpaired surrogate"); }
                            out.push(char::from_u32(0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00)).unwrap());
                        } else { return err(Code::BadString, "escape sequence produced an unpaired surrogate"); }
                    } else if (0xdc00..0xe000).contains(&u) { return err(Code::BadString, "escape sequence produced an unpaired surrogate"); }
                    else { out.push(char::from_u32(u).unwrap()); }
                }
                _ => return self.fail("bad escape"),
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------- content root

#[derive(Debug, Clone)]
pub struct ManifestEntry { pub path: String, pub kind: String, pub mode: String, pub hash: Option<String>, pub target: Option<String>, pub commit: Option<String> }

fn check_path(p: &str) -> Result<(), CanonError> {
    let b = p.as_bytes();
    let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
    if p.is_empty() || p.starts_with('/') || drive || p.contains('\\') || p.chars().any(|c| (c as u32) < 0x20) { return err(Code::BadPath, format!("unsafe path {p:?}")); }
    if p.split('/').any(|s| s.is_empty() || s == "." || s == "..") { return err(Code::BadPath, format!("unsafe path segment in {p:?}")); }
    Ok(())
}
fn is_hex(s: &str, min: usize, max: usize) -> bool { s.len() >= min && s.len() <= max && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) }

/// Canonical identity of a tree. `case_sensitive = false` folds ASCII case only (see the TypeScript note on the known gap).
pub fn content_root(entries: &[ManifestEntry], case_sensitive: bool) -> Result<String, CanonError> {
    let mut sorted: Vec<&ManifestEntry> = entries.iter().collect();
    sorted.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for e in sorted {
        check_path(&e.path)?;
        let key = if case_sensitive { e.path.clone() } else { e.path.to_ascii_lowercase() };
        if !seen.insert(key) { return err(Code::BadPath, format!("colliding path {:?}", e.path)); }
        let mode_ok = match e.kind.as_str() { "file" => e.mode == "100644" || e.mode == "100755", "symlink" => e.mode == "120000", "submodule" => e.mode == "160000", _ => false };
        if !mode_ok { return err(Code::BadSchema, format!("mode {} is not valid for a {}", e.mode, e.kind)); }
        let s = |v: &str| Canon::Str(v.to_string());
        let mut f = vec![("kind".to_string(), s(&e.kind)), ("mode".to_string(), s(&e.mode)), ("path".to_string(), s(&e.path))];
        match e.kind.as_str() {
            "file" => match &e.hash { Some(h) if is_hex(h, 64, 64) => f.push(("hash".into(), s(h))), _ => return err(Code::BadSchema, format!("file {} needs a raw sha-256", e.path)) },
            "symlink" => match &e.target { Some(t) => f.push(("target".into(), s(t))), None => return err(Code::BadSchema, format!("symlink {} needs a target", e.path)) },
            _ => match &e.commit { Some(c) if is_hex(c, 40, 64) => f.push(("commit".into(), s(c))), _ => return err(Code::BadSchema, format!("submodule {} needs a pinned commit", e.path)) },
        }
        rows.push(Canon::Obj(f));
    }
    Ok(format!("{PROTOCOL}/pf.contentRoot@1:{}", canon_digest("pf.contentRoot", "1", &canonicalize(&Canon::Arr(rows))?)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn revive(v: Canon) -> Canon {
        match v {
            Canon::Arr(a) => Canon::Arr(a.into_iter().map(revive).collect()),
            Canon::Obj(mut o) => {
                if o.len() == 1 && o[0].0 == "$set" {
                    if let Canon::Arr(items) = o.remove(0).1 { return Canon::Set(items.into_iter().map(revive).collect()); }
                    unreachable!("$set holds an array");
                }
                Canon::Obj(o.into_iter().map(|(k, v)| (k, revive(v))).collect())
            }
            other => other,
        }
    }
    fn unhex(s: &str) -> Vec<u8> { (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect() }
    fn entry(v: &Value) -> ManifestEntry {
        let g = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
        ManifestEntry { path: g("path").unwrap(), kind: g("kind").unwrap(), mode: g("mode").unwrap(), hash: g("hash"), target: g("target"), commit: g("commit") }
    }

    #[test]
    fn shared_vectors_match_the_typescript_implementation() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/canon/canon-vectors.json");
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("vectors file")).unwrap();
        assert_eq!(doc["protocol"], PROTOCOL);
        let mut digests = std::collections::HashMap::new();
        let mut ran = 0;
        for v in doc["vectors"].as_array().unwrap() {
            let id = v["id"].as_str().unwrap().to_string();
            let expect_err = v.get("expectError").and_then(|e| e.as_str());
            let outcome: Result<String, CanonError> = (|| match v["op"].as_str().unwrap() {
                "hash" | "reject" => {
                    let input: Vec<u8> = match v.get("inputHex") { Some(h) => unhex(h.as_str().unwrap()), None => v["inputText"].as_str().unwrap().as_bytes().to_vec() };
                    let mut value = revive(parse_strict_json(&input)?);
                    if let Some(keep) = v.get("project") {
                        let keep: Vec<&str> = keep.as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
                        if let Canon::Obj(o) = value { value = Canon::Obj(o.into_iter().filter(|(k, _)| keep.contains(&k.as_str())).collect()); }
                    }
                    let text = canonicalize(&value)?;
                    if v["op"] == "hash" { assert_eq!(text, v["expectedCanonical"].as_str().unwrap(), "{id}: canonical bytes"); }
                    Ok(canon_digest(v.get("schema").and_then(|s| s.as_str()).unwrap_or(""), v.get("version").and_then(|s| s.as_str()).unwrap_or(""), &text))
                }
                "decimal" => canon_decimal(v["input"].as_str().unwrap()),
                "raw" => Ok(raw_hash(&unhex(v["inputHex"].as_str().unwrap()))),
                "root" => { let es: Vec<ManifestEntry> = v["entries"].as_array().unwrap().iter().map(entry).collect(); content_root(&es, false).map(|r| r.rsplit(':').next().unwrap().to_string()) }
                other => panic!("unknown op {other}"),
            })();
            match (expect_err, outcome) {
                (Some(want), Err(e)) => assert_eq!(e.code.name(), want, "{id}"),
                (Some(want), Ok(_)) => panic!("{id}: expected {want} but it succeeded"),
                (None, Err(e)) => panic!("{id}: unexpected error {e:?}"),
                (None, Ok(got)) => {
                    match v["op"].as_str().unwrap() {
                        "decimal" => assert_eq!(got, v["expected"].as_str().unwrap(), "{id}"),
                        _ => assert_eq!(got, v["expectedDigest"].as_str().unwrap(), "{id}: digest"),
                    }
                    digests.insert(id, got);
                }
            }
            ran += 1;
        }
        for r in doc["relations"].as_array().unwrap() {
            let (ids, same) = match r.get("same") { Some(s) => (s, true), None => (&r["different"], false) };
            let ds: Vec<&String> = ids.as_array().unwrap().iter().map(|i| digests.get(i.as_str().unwrap()).expect("related vector ran")).collect();
            if same { assert!(ds.iter().all(|d| *d == ds[0])); } else { assert_ne!(ds[0], ds[1]); }
        }
        assert!(ran >= 70, "ran {ran} vectors");
    }
}
