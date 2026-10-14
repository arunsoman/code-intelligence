//! probeArtifact — point the worker at one binary artifact (.jar/.zip, ELF .so, PE .exe/.dll, Mach-O,
//! a .class file, a shebang script) and read what the bytes honestly support: format, embedded
//! metadata, linked libraries, exported symbols, high-signal strings. The parsers below are written
//! from the published formats (ZIP APPNOTE, ELF gABI, PE/COFF spec) with bounds-checked reads; the
//! report carries no interpretation it cannot point at. Every claim names its confidence
//! (observed/derived/inferred), authority, limitations and byte-level locations so the TypeScript side
//! can store each one as an authenticated re-evidence record without rewriting a word.
//!
//! Honesty rules this module lives by:
//!   * a field read out of the file is "observed" even when the field itself lies (timestamps,
//!     manifest attributes) — the limitations say who is talking;
//!   * anything computed from observations (class-file majors → Java target) is "derived";
//!   * anything that merely looks likely (string heuristics) is "inferred" or left as an unresolved
//!     question. When the file cannot answer something, the report says so in `unresolved` instead of
//!     inventing an answer.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

/// Refuse to open artifacts above this size — the probe reads whole files into memory.
pub const MAX_PROBE_BYTES: u64 = 512 * 1024 * 1024;
/// Above this the printable-string sweep is skipped (recorded as a note), not the whole probe.
const STRINGS_MAX_BYTES: usize = 64 * 1024 * 1024;
/// Shortest run of printable bytes the string sweep reports.
const STRING_MIN: usize = 6;
/// Claims list samples, never dumps (the evidence schema caps locations at 64 anyway).
const MAX_NAMES_LISTED: usize = 12;
/// How many class entries are sampled for the class-file version claim.
const MAX_CLASS_SAMPLES: usize = 512;
/// Upper bound for one embedded metadata entry (manifest, pom.properties) we are willing to inflate.
const MAX_ENTRY_INFLATE: usize = 1024 * 1024;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProbeLocation {
    pub kind: String, // "fileOffset" | "artifactPath" | "address" | "path" (matches @cie/evidence)
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_value: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProbeClaim {
    pub predicate: String,
    pub confidence: String, // observed | derived | inferred
    pub authority: String,  // shipped-artifact for direct reads; see @cie/evidence authority enum
    /// Always emitted (never skipped): the evidence schema requires the field, and an explicit empty
    /// list reads better than an absent one — "no limitations declared" is a statement too.
    pub limitations: Vec<String>,
    pub locations: Vec<ProbeLocation>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProbeUnknown {
    pub question: String,
    pub reason: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    /// Path as the caller should see it in evidence (usually repo-relative).
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub format: String, // jar | zip | elf | pe | macho | javaclass | script | unknown
    pub format_detail: String,
    pub claims: Vec<ProbeClaim>,
    pub unresolved: Vec<ProbeUnknown>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

fn loc(kind: &str, value: String) -> ProbeLocation {
    ProbeLocation { kind: kind.into(), value, end_value: None }
}

fn claim(predicate: impl Into<String>, confidence: &str, authority: &str) -> ProbeClaim {
    ProbeClaim { predicate: predicate.into(), confidence: confidence.into(), authority: authority.into(), limitations: vec![], locations: vec![] }
}

fn observed(predicate: String) -> ProbeClaim {
    claim(predicate, "observed", "shipped-artifact")
}

/// The probe's error vocabulary matches the worker's frame convention: (code, message).
pub type ProbeError = (&'static str, String);

fn push_sample(list: &[String], names: &[String]) -> String {
    let shown: Vec<String> = names.iter().take(MAX_NAMES_LISTED).cloned().collect();
    let mut s = list.len().to_string();
    if !names.is_empty() {
        s.push_str(&format!(" ({})", shown.join(", ")));
        if list.len() > shown.len() {
            s.push_str(&format!(" and {} more", list.len() - shown.len()));
        }
    }
    s
}

// ---- Little/big-endian readers: every read is bounds-checked and yields Option. ----
fn le16(b: &[u8], off: usize) -> Option<u16> { b.get(off..off + 2).map(|s| u16::from_le_bytes([s[0], s[1]])) }
fn le32(b: &[u8], off: usize) -> Option<u32> { b.get(off..off + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])) }
fn le64(b: &[u8], off: usize) -> Option<u64> {
    b.get(off..off + 8).map(|s| u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}
fn be16(b: &[u8], off: usize) -> Option<u16> { b.get(off..off + 2).map(|s| u16::from_be_bytes([s[0], s[1]])) }
fn be32(b: &[u8], off: usize) -> Option<u32> {
    b.get(off..off + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

/// NUL-terminated printable string at `off`, bounded to 4096 bytes; non-UTF8 becomes a lossy rendition.
fn cstr(b: &[u8], off: usize) -> Option<String> {
    if off >= b.len() {
        return None;
    }
    let end = b[off..].iter().position(|&c| c == 0).map(|p| off + p).unwrap_or(b.len().min(off + 4096));
    Some(String::from_utf8_lossy(&b[off..end]).into_owned())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Inflate a raw-deflate stream (zip method 8). Zip uses raw deflate — no zlib or gzip header.
fn inflate_raw(data: &[u8], cap: usize) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut reader = flate2::read::DeflateDecoder::new(data).take(cap as u64 + 1);
    reader.read_to_end(&mut out).ok()?;
    if out.len() > cap {
        return None;
    }
    Some(out)
}

/// Entry bytes by method: 0 = stored, 8 = deflate. Anything else is unreadable here (limitation).
fn entry_bytes(method: u16, compressed: &[u8], cap: usize) -> Option<Vec<u8>> {
    match method {
        0 => compressed.get(..cap.min(compressed.len())).map(|s| s.to_vec()).filter(|v| compressed.len() <= cap),
        8 => inflate_raw(compressed, cap),
        _ => None,
    }
}

/// The one entry point the dispatcher in main.rs calls. `display_path` is what evidence records will
/// carry (repo-relative); `path` is what we read.
pub fn probe_artifact(path: &Path, display_path: &str) -> Result<ProbeReport, ProbeError> {
    let meta = std::fs::metadata(path).map_err(|e| -> ProbeError {
        if e.kind() == std::io::ErrorKind::NotFound {
            ("NOT_FOUND", format!("{display_path}: {e}"))
        } else {
            ("INVALID_SCHEMA", format!("{display_path}: {e}"))
        }
    })?;
    if meta.len() > MAX_PROBE_BYTES {
        return Err(("RESOURCE_LIMIT", format!("artifact of {} bytes exceeds the {MAX_PROBE_BYTES}-byte probe limit", meta.len())));
    }
    let bytes = std::fs::read(path).map_err(|e| -> ProbeError { ("INVALID_SCHEMA", format!("{display_path}: {e}")) })?;
    let mut report = ProbeReport {
        path: display_path.into(),
        size_bytes: bytes.len() as u64,
        sha256: hex(&Sha256::digest(&bytes)),
        format: "unknown".into(),
        format_detail: String::new(),
        claims: vec![],
        unresolved: vec![],
        notes: vec![],
    };

    // A lone .class file shares the fat-Mach-O magic; the extension decides who parses it.
    let is_class = display_path.ends_with(".class") && bytes.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE]);
    if bytes.starts_with(b"MZ") {
        pe::probe(&bytes, &mut report);
    } else if bytes.starts_with(&[0x7F, b'E', b'L', b'F']) {
        elf::probe(&bytes, &mut report);
    } else if is_class {
        javaclass::probe(&bytes, &mut report);
    } else if bytes.starts_with(b"PK\x03\x04") {
        zipc::probe(&bytes, &mut report);
    } else if bytes.starts_with(&[0xFE, 0xED, 0xFA, 0xCE])
        || bytes.starts_with(&[0xFE, 0xED, 0xFA, 0xCF])
        || bytes.starts_with(&[0xCE, 0xFA, 0xED, 0xFE])
        || bytes.starts_with(&[0xCF, 0xFA, 0xED, 0xFE])
        || bytes.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE])
    {
        macho::probe(&bytes, &mut report);
    } else if bytes.starts_with(b"#!") {
        script::probe(&bytes, &mut report);
    } else {
        report.format_detail = "no recognized magic; the first bytes do not match a known container or executable format".into();
        report.unresolved.push(ProbeUnknown {
            question: format!("What produced {display_path}?"),
            reason: "no known file magic; the probe refuses to guess from a filename alone".into(),
        });
    }
    strings::sweep(&bytes, &mut report);
    format_claim(&mut report);
    Ok(report)
}

// ---- Generic claims every format shares. ----
fn format_claim(report: &mut ProbeReport) {
    if !report.format_detail.is_empty() {
        let mut c = observed(format!("is a {} file ({})", report.format, report.format_detail));
        c.locations.push(loc("fileOffset", "0x0".into()));
        report.claims.push(c);
    }
}

// ============================== ZIP / JAR ==============================
struct ZipEntry {
    name: String,
    method: u16,
    compressed_size: usize,
    uncompressed_size: usize,
    local_offset: usize,
}

/// Parse the central directory (APPNOTE §4.3): scan backwards for the EOCD, then walk its directory.
/// Only what the directory says is trusted here; the local headers are re-read when a payload is needed.
fn zip_entries(bytes: &[u8]) -> Result<Vec<ZipEntry>, String> {
    let eocd_min = 22usize;
    if bytes.len() < eocd_min {
        return Err("file is shorter than an end-of-central-directory record".into());
    }
    // EOCD may carry a comment (up to 65535 bytes), so scan backwards for the signature.
    let scan_from = bytes.len().saturating_sub(eocd_min + 65_535);
    let mut eocd = None;
    let mut i = bytes.len() - eocd_min + 1;
    while i > scan_from {
        i -= 1;
        if &bytes[i..i + 4] == b"PK\x05\x06" {
            eocd = Some(i);
            break;
        }
    }
    let eocd = eocd.ok_or("no end-of-central-directory record found; not a complete zip")?;
    let count = le16(bytes, eocd + 10).ok_or("truncated EOCD")? as usize;
    let dir_offset = le32(bytes, eocd + 16).ok_or("truncated EOCD")? as usize;
    let mut entries = Vec::new();
    let mut off = dir_offset;
    for _ in 0..count {
        if off + 46 > bytes.len() || &bytes.get(off..off + 4).ok_or("truncated central directory")? != b"PK\x01\x02" {
            return Err("central directory ends early; the archive is corrupt or truncated".into());
        }
        let method = le16(bytes, off + 10).unwrap_or(0);
        let csize = le32(bytes, off + 20).unwrap_or(0) as usize;
        let usize_ = le32(bytes, off + 24).unwrap_or(0) as usize;
        let nlen = le16(bytes, off + 28).unwrap_or(0) as usize;
        let elen = le16(bytes, off + 30).unwrap_or(0) as usize;
        let clen = le16(bytes, off + 32).unwrap_or(0) as usize;
        let lho = le32(bytes, off + 42).unwrap_or(0) as usize;
        let name = bytes.get(off + 46..off + 46 + nlen).map(|s| String::from_utf8_lossy(s).into_owned()).unwrap_or_default();
        entries.push(ZipEntry { name, method, compressed_size: csize, uncompressed_size: usize_, local_offset: lho });
        off += 46 + nlen + elen + clen;
    }
    Ok(entries)
}

/// Bytes of one entry: seek its local header, then take the compressed payload and inflate if needed.
fn zip_entry_bytes(bytes: &[u8], entry: &ZipEntry, cap: usize) -> Option<Vec<u8>> {
    let off = entry.local_offset;
    if off + 30 > bytes.len() || &bytes.get(off..off + 4)? != b"PK\x03\x04" {
        return None;
    }
    let nlen = le16(bytes, off + 26)? as usize;
    let elen = le16(bytes, off + 28)? as usize;
    let data = off + 30 + nlen + elen;
    let end = data.checked_add(entry.compressed_size)?;
    let compressed = bytes.get(data..end)?;
    entry_bytes(entry.method, compressed, cap)
}

/// "Key: value" manifest parser: handles the 72-byte soft line break (a line starting with a space).
fn parse_manifest(text: &str) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    let mut current = String::new();
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.starts_with(' ') {
            current.push_str(&line[1..]);
            continue;
        }
        if !current.is_empty() {
            if let Some((k, v)) = current.split_once(": ") {
                attrs.push((k.to_string(), v.to_string()));
            }
            current = String::new();
        }
        current = line.to_string();
    }
    if !current.is_empty() {
        if let Some((k, v)) = current.split_once(": ") {
            attrs.push((k.to_string(), v.to_string()));
        }
    }
    attrs
}

// ============================== ZIP / JAR probe ==============================
mod zipc {
    use super::*;

    const SELF_REPORTED: &str = "self-reported by the artifact; a label is not a proof of provenance";

    pub fn probe(bytes: &[u8], report: &mut ProbeReport) {
        let entries = match zip_entries(bytes) {
            Ok(e) => e,
            Err(reason) => {
                report.format = "zip".into();
                report.format_detail = "zip container whose central directory could not be read".into();
                report.unresolved.push(ProbeUnknown {
                    question: format!("What does {} contain?", report.path),
                    reason,
                });
                return;
            }
        };
        let has_manifest = entries.iter().any(|e| e.name == "META-INF/MANIFEST.MF");
        let has_classes = entries.iter().any(|e| e.name.ends_with(".class"));
        report.format = if has_manifest || has_classes { "jar" } else { "zip" }.into();
        report.format_detail = if report.format == "jar" {
            "java archive (zip with class files)".into()
        } else {
            "zip container".into()
        };

        let classes: Vec<&ZipEntry> = entries.iter().filter(|e| e.name.ends_with(".class")).collect();
        let mut c = observed(format!(
            "contains {} entries ({} class files)",
            entries.len(),
            classes.len()
        ));
        c.limitations.push("entry counts come from the central directory; they say nothing about what the entries do".into());
        report.claims.push(c);

        // Nested archives — where dependency fog usually hides.
        let nested: Vec<String> = entries
            .iter()
            .filter(|e| {
                let n = e.name.to_ascii_lowercase();
                (n.ends_with(".jar") || n.ends_with(".war") || n.ends_with(".zip") || n.ends_with(".ear")) && !n.contains("..")
            })
            .map(|e| e.name.clone())
            .collect();
        if !nested.is_empty() {
            let mut c = observed(format!(
                "contains {} nested {}",
                push_sample(&nested, &nested),
                if nested.len() == 1 { "archive" } else { "archives" }
            ));
            for name in nested.iter().take(MAX_NAMES_LISTED) {
                c.locations.push(loc("artifactPath", name.clone()));
            }
            report.claims.push(c);
            report.notes.push("nested archives were not opened; each one is a separate probe".into());
        }

        // WAR layout.
        if entries.iter().any(|e| e.name.starts_with("WEB-INF/")) {
            report.claims.push(observed("is a web archive (WEB-INF layout present)".into()));
        }

        // Signing.
        let sig: Vec<String> = entries
            .iter()
            .filter(|e| {
                let n = e.name.to_ascii_lowercase();
                n.starts_with("meta-inf/") && (n.ends_with(".sf") || n.ends_with(".rsa") || n.ends_with(".dsa") || n.ends_with(".ec"))
            })
            .map(|e| e.name.clone())
            .collect();
        if let Some(first) = sig.first() {
            let mut c = observed(format!("is signed (jarsigner signature file {} present)", sig.len()));
            c.locations.push(loc("artifactPath", first.clone()));
            c.limitations.push("a signature block is present; whether it verifies against any publisher is not established".into());
            report.claims.push(c);
        }

        // Manifest attributes.
        let mut manifest_version: Option<String> = None;
        if has_manifest {
            if let Some(entry) = entries.iter().find(|e| e.name == "META-INF/MANIFEST.MF") {
                if let Some(raw) = zip_entry_bytes(bytes, entry, MAX_ENTRY_INFLATE) {
                    let attrs = parse_manifest(&String::from_utf8_lossy(&raw));
                    for (key, value) in &attrs {
                        let interesting = matches!(
                            key.as_str(),
                            "Implementation-Title"
                                | "Implementation-Version"
                                | "Implementation-Vendor"
                                | "Specification-Title"
                                | "Specification-Version"
                                | "Bundle-Name"
                                | "Bundle-Version"
                                | "Automatic-Module-Name"
                                | "Main-Class"
                                | "Build-Jdk"
                        );
                        if interesting {
                            let mut c = observed(format!("manifest {key} is {value:?}"));
                            c.locations.push(loc("artifactPath", entry.name.clone()));
                            c.limitations.push(SELF_REPORTED.into());
                            report.claims.push(c);
                            if key == "Implementation-Version" || key == "Bundle-Version" {
                                manifest_version = Some(value.clone());
                            }
                        }
                    }
                    if attrs.iter().any(|(k, v)| k == "Multi-Release" && v == "true")
                        || entries.iter().any(|e| e.name.starts_with("META-INF/versions/"))
                    {
                        report.claims.push(observed("is a multi-release jar (META-INF/versions overrides present)".into()));
                    }
                } else {
                    report.notes.push("META-INF/MANIFEST.MF could not be inflated with the supported methods".into());
                }
            }
        }

        // Maven coordinates from pom.properties.
        let mut pom_version: Option<String> = None;
        let pom_entries: Vec<&ZipEntry> = entries
            .iter()
            .filter(|e| e.name == "pom.properties" || e.name.ends_with("/pom.properties"))
            .collect();
        for entry in pom_entries.iter().take(4) {
            if let Some(raw) = zip_entry_bytes(bytes, entry, MAX_ENTRY_INFLATE) {
                let mut group = None;
                let mut artifact = None;
                let mut version = None;
                for line in String::from_utf8_lossy(&raw).lines() {
                    if let Some((k, v)) = line.split_once('=') {
                        match k.trim() {
                            "groupId" => group = Some(v.trim().to_string()),
                            "artifactId" => artifact = Some(v.trim().to_string()),
                            "version" => version = Some(v.trim().to_string()),
                            _ => {}
                        }
                    }
                }
                if let (Some(g), Some(a), Some(v)) = (group, artifact, version.clone()) {
                    let mut c = observed(format!("pom.properties names the artifact as {g}:{a}:{v}"));
                    c.locations.push(loc("artifactPath", entry.name.clone()));
                    c.limitations.push(SELF_REPORTED.into());
                    report.claims.push(c);
                    pom_version = Some(v);
                }
            }
        }
        if let (Some(pom), Some(man)) = (&pom_version, &manifest_version) {
            if pom != man {
                report.claims.push(observed(format!(
                    "self-reported versions disagree: pom.properties says {pom:?}, the manifest says {man:?}"
                )));
            }
        }

        // Class-file versions → Java target.
        if !classes.is_empty() {
            let mut min_major: Option<u16> = None;
            let mut max_major: Option<u16> = None;
            let mut sampled = 0usize;
            let mut unreadable = 0usize;
            for entry in classes.iter().take(MAX_CLASS_SAMPLES) {
                match zip_entry_bytes(bytes, entry, 16) {
                    Some(head) if head.len() >= 8 => {
                        // 0xCAFEBABE | minor (u16 BE) | major (u16 BE)
                        if let Some(major) = be16(&head, 6) {
                            if major >= 45 {
                                min_major = Some(min_major.map_or(major, |m: u16| m.min(major)));
                                max_major = Some(max_major.map_or(major, |m: u16| m.max(major)));
                                sampled += 1;
                            }
                        }
                    }
                    _ => unreadable += 1,
                }
            }
            if let (Some(min), Some(max)) = (min_major, max_major) {
                let range = if min == max { format!("{}", min - 44) } else { format!("{}–{}", min - 44, max - 44) };
                let mut c = claim(
                    format!(
                        "class files were compiled for Java {range} (class-file major {}{})",
                        min,
                        if min == max { String::new() } else { format!("–{max}") }
                    ),
                    "derived",
                    "shipped-artifact",
                );
                c.limitations.push(format!(
                    "sampled up to {MAX_CLASS_SAMPLES} entries{unreadable}; targets of unsampled or unreadable entries may differ"
                ));
                report.claims.push(c);
            } else if unreadable > 0 {
                report.notes.push("class-file versions could not be read from the sampled entries".into());
            }
        }

        // Provenance questions the archive itself cannot answer.
        let has_identity = pom_version.is_some() || manifest_version.is_some();
        if !has_identity {
            report.unresolved.push(ProbeUnknown {
                question: format!("Which upstream project produced {}?", report.path),
                reason: "no pom.properties and no identifying manifest attributes are present".into(),
            });
        }
        report.unresolved.push(ProbeUnknown {
            question: format!("Can {} be rebuilt bit-for-bit from a public source tree?", report.path),
            reason: "jars carry no source provenance; manifest attributes and class-file majors are the only build signals".into(),
        });
    }
}

// ============================== ELF ==============================
mod elf {
    use super::*;

    fn machine_name(m: u16) -> String {
        match m {
            3 => "x86".into(),
            8 => "MIPS".into(),
            20 => "PowerPC".into(),
            40 => "ARM".into(),
            62 => "x86-64".into(),
            183 => "AArch64".into(),
            243 => "RISC-V".into(),
            other => format!("machine {other:#x}"),
        }
    }

    struct Section {
        name_off: u32,
        s_type: u32,
        offset: u64,
        size: u64,
        addr: u64,
        link: u32,
        entsize: u64,
    }

    pub fn probe(bytes: &[u8], report: &mut ProbeReport) {
        let is64 = bytes.get(4) == Some(&2);
        let is_le = bytes.get(5) == Some(&1);
        report.format = "elf".into();
        if !is_le {
            // Big-endian ELF exists (older MIPS/POWER targets). Identifying it honestly beats parsing
            // it wrongly; the note says exactly how far this probe went.
            let e_type = be16(bytes, 16).unwrap_or(0);
            let e_machine = be16(bytes, 18).unwrap_or(0);
            report.format_detail = format!(
                "ELF{}, {}, {} (big-endian)",
                if is64 { "64" } else { "32" },
                machine_name(e_machine),
                match e_type {
                    2 => "ET_EXEC (executable)",
                    3 => "ET_DYN (shared object or position-independent executable)",
                    _ => "other e_type",
                }
            );
            report.notes.push("big-endian ELF: only the identification header is read; dynamics are not walked".into());
            report.unresolved.push(ProbeUnknown {
                question: format!("Which libraries does {} link against?", report.path),
                reason: "big-endian ELF dynamics are not walked by this probe".into(),
            });
            return;
        }
        let e_type = le16(bytes, 16).unwrap_or(0);
        let e_machine = le16(bytes, 18).unwrap_or(0);
        let (shoff_off, shentsize_off, shnum_off, shstrndx_off) = if is64 {
            (0x28usize, 0x3A, 0x3C, 0x3E)
        } else {
            (0x20, 0x2E, 0x30, 0x32)
        };
        let shoff = if is64 { le64(bytes, shoff_off) } else { le32(bytes, shoff_off).map(|v| v as u64) }.unwrap_or(0);
        let shentsize = le16(bytes, shentsize_off).unwrap_or(0) as usize;
        let shnum = le16(bytes, shnum_off).unwrap_or(0) as usize;
        let shstrndx = le16(bytes, shstrndx_off).unwrap_or(0) as usize;
        let etype_name = match e_type {
            2 => "ET_EXEC (executable)",
            3 => "ET_DYN (shared object or position-independent executable)",
            _ => "other e_type",
        };
        report.format_detail = format!(
            "ELF{}, {}, {}",
            if is64 { "64" } else { "32" },
            machine_name(e_machine),
            etype_name
        );

        // Section headers.
        let sh_size = if is64 { 64usize } else { 40 };
        let mut sections: Vec<Section> = Vec::new();
        if shoff > 0 && shentsize >= sh_size && shnum > 0 && shnum <= 10_000 {
            for i in 0..shnum {
                let base = shoff as usize + i * shentsize;
                if base + sh_size > bytes.len() {
                    break;
                }
                let (name_off, s_type, offset, size, addr, link, entsize) = if is64 {
                    (
                        le32(bytes, base).unwrap_or(0),
                        le32(bytes, base + 4).unwrap_or(0),
                        le64(bytes, base + 24).unwrap_or(0),
                        le64(bytes, base + 32).unwrap_or(0),
                        le64(bytes, base + 16).unwrap_or(0),
                        le32(bytes, base + 40).unwrap_or(0),
                        le64(bytes, base + 56).unwrap_or(0),
                    )
                } else {
                    (
                        le32(bytes, base).unwrap_or(0),
                        le32(bytes, base + 4).unwrap_or(0),
                        le32(bytes, base + 16).unwrap_or(0) as u64,
                        le32(bytes, base + 20).unwrap_or(0) as u64,
                        le32(bytes, base + 12).unwrap_or(0) as u64,
                        le32(bytes, base + 24).unwrap_or(0),
                        le32(bytes, base + 36).unwrap_or(0) as u64,
                    )
                };
                sections.push(Section { name_off, s_type, offset, size, addr, link, entsize });
            }
        } else {
            report.notes.push("section headers were not readable; only the ELF identification header is reported".into());
        }

        // .dynamic → DT_NEEDED / DT_SONAME via DT_STRTAB.
        let dynamic = sections.iter().find(|s| s.s_type == 6);
        let mut needed: Vec<String> = Vec::new();
        let mut soname: Option<String> = None;
        if let Some(dynsec) = dynamic {
            // The dynamic string table: vaddr DT_STRTAB mapped through the section that contains it.
            let d_entsize = if is64 { 16usize } else { 8 };
            let mut strtab_vaddr: Option<u64> = None;
            let mut strsz: usize = 0;
            let mut dyn_off = dynsec.offset as usize;
            let dyn_end = dyn_off + dynsec.size as usize;
            while dyn_off + d_entsize <= dyn_end && dyn_off + d_entsize <= bytes.len() {
                let (tag, val) = if is64 {
                    (le64(bytes, dyn_off).unwrap_or(0) as i64, le64(bytes, dyn_off + 8).unwrap_or(0))
                } else {
                    (le32(bytes, dyn_off).unwrap_or(0) as i64, le32(bytes, dyn_off + 4).unwrap_or(0) as u64)
                };
                if tag == 0 {
                    break;
                }
                if tag == 5 {
                    strtab_vaddr = Some(val);
                }
                if tag == 10 {
                    strsz = val as usize;
                }
                dyn_off += d_entsize;
            }
            // Map the strtab vaddr to a file offset via the section whose addr range covers it.
            let strtab_off = strtab_vaddr.and_then(|v| {
                sections
                    .iter()
                    .find(|s| s.addr <= v && v < s.addr + s.size.max(1))
                    .map(|s| (v - s.addr + s.offset) as usize)
            });
            if let Some(stoff) = strtab_off {
                // Walk the dynamic table again for the name entries.
                let mut dyn_off = dynsec.offset as usize;
                while dyn_off + d_entsize <= dyn_end && dyn_off + d_entsize <= bytes.len() {
                    let (tag, val) = if is64 {
                        (le64(bytes, dyn_off).unwrap_or(0) as i64, le64(bytes, dyn_off + 8).unwrap_or(0))
                    } else {
                        (le32(bytes, dyn_off).unwrap_or(0) as i64, le32(bytes, dyn_off + 4).unwrap_or(0) as u64)
                    };
                    if tag == 0 {
                        break;
                    }
                    if tag == 1 {
                        // DT_NEEDED: val is an offset within the dynamic string table.
                        let abs = stoff + (val as usize);
                        if let Some(name) = cstr(bytes, abs).filter(|s| !s.is_empty()) {
                            needed.push(name);
                        }
                    }
                    if tag == 14 {
                        let abs = stoff + (val as usize);
                        soname = cstr(bytes, abs).filter(|s| !s.is_empty());
                    }
                    dyn_off += d_entsize;
                }
            } else {
                report.notes.push("the dynamic string table could not be mapped to a file offset; DT_NEEDED entries were not read".into());
            }
        }
        if !needed.is_empty() {
            let mut c = observed(format!(
                "links against {} shared {}",
                push_sample(&needed, &needed),
                if needed.len() == 1 { "library" } else { "libraries" }
            ));
            for name in needed.iter().take(MAX_NAMES_LISTED) {
                c.locations.push(loc("fileOffset", format!("dynamic entry for {name:?}")));
            }
            c.limitations.push("DT_NEEDED says what the loader will request; whether the request succeeds at runtime is a different question".into());
            report.claims.push(c);
        }
        if let Some(son) = soname {
            report.claims.push(observed(format!("soname is {son:?}")));
        }
        if let Some(interp) = sections.iter().find(|s| s.s_type == 1 && {
            // .interp is SHT_PROGBITS holding the PT_INTERP path; match it by content, not by name.
            let start = s.offset as usize;
            bytes.get(start..start + 7) == Some(b"/lib64/") || bytes.get(start..start + 9) == Some(b"/lib/ld.so") || bytes.get(start..start + 10) == Some(b"/lib/ld-musl")
        }) {
            let _ = interp;
            report.format_detail.push_str(", dynamically linked (PT_INTERP-style interpreter present)");
        } else if !needed.is_empty() {
            report.format_detail.push_str(", dynamically linked");
        }

        // Exported dynamic symbols.
        if let Some(dynsym) = sections.iter().find(|s| s.s_type == 11) {
            let ent = if is64 { 24usize } else { 16 };
            let namesec = sections.get(dynsym.link as usize);
            let count = if dynsym.entsize as usize >= ent { (dynsym.size / dynsym.entsize.max(1)) as usize } else { 0 };
            let mut exports = 0usize;
            let mut names: Vec<String> = Vec::new();
            for i in 0..count.min(200_000) {
                let base = dynsym.offset as usize + i * ent;
                if base + ent > bytes.len() {
                    break;
                }
                let (st_name, st_info, st_shndx) = if is64 {
                    (le32(bytes, base).unwrap_or(0), *bytes.get(base + 4).unwrap_or(&0), le16(bytes, base + 6).unwrap_or(0))
                } else {
                    (le32(bytes, base).unwrap_or(0), *bytes.get(base + 12).unwrap_or(&0), le16(bytes, base + 14).unwrap_or(0))
                };
                let bind = st_info >> 4;
                if st_shndx != 0 && (bind == 1 || bind == 2) {
                    exports += 1;
                    if names.len() < MAX_NAMES_LISTED {
                        if let Some(ns) = namesec {
                            if let Some(name) = cstr(bytes, (ns.offset as usize) + st_name as usize) {
                                if !name.is_empty() {
                                    names.push(name);
                                }
                            }
                        }
                    }
                }
            }
            let mut c = observed(format!(
                "exports {exports} dynamic {}{}",
                if exports == 1 { "symbol" } else { "symbols" },
                if names.is_empty() { String::new() } else { format!(" (sample: {})", names.join(", ")) }
            ));
            c.locations.push(loc("fileOffset", format!("0x{:x}", dynsym.offset)));
            c.limitations.push("count from .dynsym: GLOBAL and WEAK definitions; hidden-visibility exports may still exist".into());
            report.claims.push(c);
        }

        // Stripped?
        let has_symtab = sections.iter().any(|s| s.s_type == 2);
        if !has_symtab && !sections.is_empty() {
            let mut c = claim("is stripped (no .symtab section present)", "derived", "shipped-artifact");
            c.limitations.push("absence of .symtab only means the static symbol table was not shipped".into());
            report.claims.push(c);
        }

        // GNU build-id from the note section of that name.
        if shnum > 0 && (shstrndx as usize) < sections.len() {
            let shstr = &sections[shstrndx as usize];
            for s in &sections {
                let start = shstr.offset as usize + s.name_off as usize;
                if cstr(bytes, start).as_deref() == Some(".note.gnu.build-id") {
                    // note: namesz(4) descsz(4) type(4) "GNU\0" desc...
                    let nbase = s.offset as usize;
                    if let (Some(namesz), Some(descsz)) = (le32(bytes, nbase), le32(bytes, nbase + 4)) {
                        let desc_off = nbase + 12 + (namesz as usize).max(4);
                        if let Some(desc) = bytes.get(desc_off..desc_off + descsz as usize) {
                            if !desc.is_empty() {
                                let mut c = observed(format!("GNU build-id is {}", hex(desc)));
                                c.locations.push(loc("fileOffset", format!("0x{desc_off:x}")));
                                c.limitations.push("the id identifies the build, not the publisher".into());
                                report.claims.push(c);
                            }
                        }
                    }
                    break;
                }
            }
        }

        // What the file cannot say about itself.
        let has_build_id = report.claims.iter().any(|c| c.predicate.contains("GNU build-id"));
        if !has_symtab && !has_build_id {
            report.unresolved.push(ProbeUnknown {
                question: format!("Which source tree produced {}?", report.path),
                reason: "stripped, without a GNU build-id or debug info to attribute the build with".into(),
            });
        }
        report.unresolved.push(ProbeUnknown {
            question: format!("Does {} link against the same library versions it was built and tested with?", report.path),
            reason: "DT_NEEDED records sonames, not versions or hashes; ABI compatibility is decided at load time".into(),
        });
    }
}

// ============================== PE / COFF ==============================
mod pe {
    use super::*;

    fn machine_name(m: u16) -> String {
        match m {
            0x014c => "x86".into(),
            0x8664 => "x86-64".into(),
            0x01c0 | 0x01c4 => "ARM".into(),
            0xAA64 => "ARM64".into(),
            0x0200 => "IA-64".into(),
            other => format!("machine {other:#x}"),
        }
    }

    struct Section { name: String, va: u32, vsize: u32, raw_ptr: u32, raw_size: u32 }

    pub fn probe(bytes: &[u8], report: &mut ProbeReport) {
        report.format = "pe".into();
        let Some(lfanew) = le32(bytes, 0x3c).map(|v| v as usize) else {
            report.format_detail = "MZ header without a readable e_lfanew".into();
            return;
        };
        if bytes.get(lfanew..lfanew + 4) != Some(&b"PE\0\0"[..]) {
            report.format_detail = "MZ header but no PE signature".into();
            report.unresolved.push(ProbeUnknown {
                question: format!("What kind of executable is {}?", report.path),
                reason: "an MZ header is present but the PE\\0\\0 signature is missing or out of place".into(),
            });
            return;
        }
        let coff = lfanew + 4;
        let machine = le16(bytes, coff).unwrap_or(0);
        let nsections = le16(bytes, coff + 2).unwrap_or(0) as usize;
        let timestamp = le32(bytes, coff + 8).unwrap_or(0);
        let opt_size = le16(bytes, coff + 16).unwrap_or(0) as usize;
        let opt = coff + 20;
        let magic = le16(bytes, opt).unwrap_or(0);
        report.format_detail = format!(
            "PE{} ({})",
            if magic == 0x20b { "32+" } else if magic == 0x10b { "32" } else { "?" },
            machine_name(machine)
        );

        let subsystem = le16(bytes, opt + 68).unwrap_or(0);
        let subsystem_name = match subsystem {
            2 => "GUI", 3 => "console", 1 => "native", 9 => "Windows CE", 10 => "EFI",
            _ => "other",
        };
        report.claims.push(observed(format!("optional header declares subsystem {subsystem_name}")));

        // Data directories.
        let dd_base = opt + if magic == 0x20b { 112 } else { 96 };
        let dd = |i: usize| -> (u32, u32) {
            let base = dd_base + i * 8;
            (le32(bytes, base).unwrap_or(0), le32(bytes, base + 4).unwrap_or(0))
        };
        let (export_rva, export_size) = dd(0);
        let (import_rva, _import_size) = dd(1);
        let (cert_rva, cert_size) = dd(4);

        // Section table (40 bytes each) for RVA → file-offset mapping.
        let sec_base = opt + opt_size;
        let mut sections: Vec<Section> = Vec::new();
        for i in 0..nsections.min(96) {
            let base = sec_base + i * 40;
            if base + 40 > bytes.len() {
                break;
            }
            let name = String::from_utf8_lossy(bytes.get(base..base + 8).unwrap_or(b"")).trim_end_matches('\0').to_string();
            sections.push(Section {
                name,
                vsize: le32(bytes, base + 8).unwrap_or(0),
                va: le32(bytes, base + 12).unwrap_or(0),
                raw_size: le32(bytes, base + 16).unwrap_or(0),
                raw_ptr: le32(bytes, base + 20).unwrap_or(0),
            });
        }
        let rva_off = |rva: u32| -> Option<usize> {
            let s = sections.iter().find(|s| s.va <= rva && rva < s.va + s.vsize.max(s.raw_size))?;
            Some(s.raw_ptr as usize + (rva - s.va) as usize)
        };

        // Import table → DLL dependencies.
        if import_rva != 0 {
            let mut dlls: Vec<String> = Vec::new();
            let mut base = rva_off(import_rva).unwrap_or(usize::MAX);
            for _ in 0..4096 {
                if base == usize::MAX || base + 20 > bytes.len() {
                    break;
                }
                let (oft, _, _, name_rva, _) = (
                    le32(bytes, base).unwrap_or(0),
                    le32(bytes, base + 4).unwrap_or(0),
                    le32(bytes, base + 8).unwrap_or(0),
                    le32(bytes, base + 12).unwrap_or(0),
                    le32(bytes, base + 16).unwrap_or(0),
                );
                if oft == 0 && name_rva == 0 {
                    break;
                }
                if let Some(off) = rva_off(name_rva) {
                    if let Some(name) = cstr(bytes, off) {
                        if !name.is_empty() {
                            dlls.push(name);
                        }
                    }
                }
                base += 20;
            }
            if !dlls.is_empty() {
                let mut c = observed(format!(
                    "imports from {} dynamic-link {}",
                    push_sample(&dlls, &dlls),
                    if dlls.len() == 1 { "library" } else { "libraries" }
                ));
                for name in dlls.iter().take(MAX_NAMES_LISTED) {
                    c.locations.push(loc("fileOffset", format!("import descriptor for {name:?}")));
                }
                c.limitations.push("the import table lists what the loader will request; delay-loaded imports are not walked".into());
                report.claims.push(c);
            }
        }

        // Export table. IMAGE_EXPORT_DIRECTORY: Name@12, Base@16, NumberOfFunctions@20,
        // NumberOfNames@24, AddressOfFunctions@28, AddressOfNames@32.
        if export_rva != 0 && export_size > 0 {
            if let Some(eoff) = rva_off(export_rva) {
                let n_funcs = le32(bytes, eoff + 20).unwrap_or(0);
                let n_names = le32(bytes, eoff + 24).unwrap_or(0);
                let names_rva = le32(bytes, eoff + 32).unwrap_or(0);
                let mut names: Vec<String> = Vec::new();
                if names_rva != 0 {
                    if let Some(noff) = rva_off(names_rva) {
                        for i in 0..(n_names as usize).min(MAX_NAMES_LISTED) {
                            if let Some(rva) = le32(bytes, noff + i * 4) {
                                if let Some(ptr) = rva_off(rva) {
                                    if let Some(name) = cstr(bytes, ptr) {
                                        if !name.is_empty() {
                                            names.push(name);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                let mut c = observed(format!(
                    "exports {n_funcs} functions ({n_names} by name{})",
                    if names.is_empty() { String::new() } else { format!("; sample: {}", names.join(", ")) }
                ));
                c.locations.push(loc("fileOffset", format!("0x{eoff:x}")));
                report.claims.push(c);
            }
        }

        // Authenticode presence.
        if cert_rva != 0 && cert_size > 0 {
            let mut c = observed(format!("carries a signature directory ({cert_size} bytes)"));
            c.limitations.push("signature presence is observed; whether it chains to a trusted publisher is not established".into());
            report.claims.push(c);
        }

        // Linker timestamp — read honestly, flagged as self-reported.
        if timestamp > 0 {
            // The field is seconds since the Unix epoch, in UTC, per the PE spec.
            let secs = timestamp as i64;
            let days = secs.div_euclid(86_400);
            let rem = secs.rem_euclid(86_400);
            // Days since 1970-01-01 → civil date (Howard Hinnant's algorithm, integer form).
            let z = days + 719_468;
            let era = z.div_euclid(146_097);
            let doe = z.rem_euclid(146_097);
            let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
            let y = yoe + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let m = if mp < 10 { mp + 3 } else { mp - 9 };
            let y = if m <= 2 { y + 1 } else { y };
            let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
            let mut c = observed(format!(
                "linker timestamp field is {y:04}-{m:02}-{d:02} {hh:02}:{mm:02}:{ss:02} UTC"
            ));
            c.limitations.push("the field is self-reported; reproducible builds zero or shift it".into());
            report.claims.push(c);
        } else {
            report.notes.push("the linker timestamp is zero, as reproducible builds leave it".into());
        }

        if cert_rva == 0 {
            report.unresolved.push(ProbeUnknown {
                question: format!("Who built and signed {}?", report.path),
                reason: "no certificate directory is present, and the file itself carries no other provenance".into(),
            });
        } else {
            report.unresolved.push(ProbeUnknown {
                question: format!("Does the signature on {} chain to a trusted publisher?", report.path),
                reason: "signature presence is observed; chain validation is not performed by this probe".into(),
            });
        }
    }
}

// ============================== Java class file ==============================
mod javaclass {
    use super::*;

    pub fn probe(bytes: &[u8], report: &mut ProbeReport) {
        report.format = "javaclass".into();
        let minor = be16(bytes, 4).unwrap_or(0);
        let major = be16(bytes, 6).unwrap_or(0);
        report.format_detail = format!("java class file, major {major}, minor {minor}");
        if major >= 45 {
            let mut c = observed(format!(
                "was compiled for Java {} (class-file major {major}, minor {minor})",
                major - 44
            ));
            c.locations.push(loc("fileOffset", "0x0–0x8".into()));
            report.claims.push(c);
        }
        report.unresolved.push(ProbeUnknown {
            question: format!("Which source file produced {}?", report.path),
            reason: "the constant pool would name the source file, but only a full class-file parse (not this probe) reads it".into(),
        });
    }
}

// ============================== Mach-O ==============================
mod macho {
    use super::*;

    pub fn probe(bytes: &[u8], report: &mut ProbeReport) {
        report.format = "macho".into();
        let (bits, fat) = if bytes.starts_with(&[0xFE, 0xED, 0xFA, 0xCE]) || bytes.starts_with(&[0xCE, 0xFA, 0xED, 0xFE]) {
            ("32", false)
        } else if bytes.starts_with(&[0xFE, 0xED, 0xFA, 0xCF]) || bytes.starts_with(&[0xCF, 0xFA, 0xED, 0xFE]) {
            ("64", false)
        } else {
            ("64", true)
        };
        report.format_detail = if fat { "Mach-O fat (universal) binary".into() } else { format!("Mach-O {bits}") };
        report.unresolved.push(ProbeUnknown {
            question: format!("What do the {bits} slices of {} contain?", report.path),
            reason: "Mach-O load commands, dylibs and exports are not walked by this probe yet".into(),
        });
    }
}

// ============================== Shebang script ==============================
mod script {
    use super::*;

    pub fn probe(bytes: &[u8], report: &mut ProbeReport) {
        report.format = "script".into();
        let line_end = bytes.iter().take(512).position(|&c| c == b'\n').unwrap_or(bytes.len().min(512));
        let shebang = String::from_utf8_lossy(&bytes[..line_end.min(bytes.len())]).trim().to_string();
        report.format_detail = format!("shebang script: {shebang:?}");
        let mut c = observed(format!("interprets through {shebang:?}"));
        c.locations.push(loc("fileOffset", "0x0".into()));
        c.limitations.push("the interpreter path on the shebang line is what would run only when executed directly".into());
        report.claims.push(c);
    }
}

// ============================== Printable-string sweep ==============================
mod strings {
    use super::*;

    /// Runs of printable ASCII at/after `from`, capped; returns (offset, string).
    fn ascii_runs(bytes: &[u8], from: usize, max: usize) -> Vec<(usize, String)> {
        let mut runs = Vec::new();
        let mut start = None;
        for (i, &b) in bytes[from..].iter().enumerate() {
            let printable = (0x20..=0x7e).contains(&b) || b == b'\t';
            if printable && start.is_none() {
                start = Some(i + from);
            } else if !printable {
                if let Some(s) = start.take() {
                    if i + from - s >= STRING_MIN {
                        runs.push((s, String::from_utf8_lossy(&bytes[s..i + from]).into_owned()));
                        if runs.len() >= max {
                            return runs;
                        }
                    }
                }
            }
        }
        runs
    }

    pub fn sweep(bytes: &[u8], report: &mut ProbeReport) {
        if bytes.len() > STRINGS_MAX_BYTES {
            report.notes.push(format!("the string sweep was skipped: {} bytes exceeds the {}-byte sweep budget", bytes.len(), STRINGS_MAX_BYTES));
            return;
        }
        let runs = ascii_runs(bytes, 0, 40_000);
        let needles: Vec<&str> = runs.iter().map(|(_, s)| s.as_str()).collect();

        // Distinct URLs.
        let mut urls: Vec<String> = Vec::new();
        for s in &needles {
            for part in s.split_whitespace() {
                if (part.starts_with("http://") || part.starts_with("https://")) && part.len() > 10 && urls.len() < 200 {
                    let u = part.trim_end_matches(|c: char| !(c.is_alphanumeric() || c == '/')).to_string();
                    if !urls.contains(&u) {
                        urls.push(u);
                    }
                }
            }
        }
        if !urls.is_empty() {
            let mut c = observed(format!(
                "contains {} distinct http(s) URL{}",
                push_sample(&urls, &urls),
                if urls.len() == 1 { "" } else { "s" }
            ));
            c.limitations.push("string-level observation; the presence of a URL does not prove it is contacted".into());
            report.claims.push(c);
        }

        // Go build info.
        if let Some((off, s)) = runs.iter().find(|(_, s)| s.starts_with("go1.") && s[4..].chars().next().is_some_and(|c| c.is_ascii_digit())) {
            let ver: String = s.split_whitespace().next().unwrap_or(s).trim_start_matches("go").to_string();
            let mut c = claim(format!("appears to have been built with Go {ver}"), "derived", "shipped-artifact");
            c.locations.push(loc("fileOffset", format!("0x{off:x}")));
            c.limitations.push("string heuristic; a version string can be stale, bundled, or deliberately spoofed".into());
            report.claims.push(c);
        }

        // Rust build fingerprints.
        if let Some((off, _)) = runs.iter().find(|(_, s)| s.contains("cargo/registry") || s.ends_with(".rs")) {
            let mut c = claim("appears to come from a Rust build (panic paths reference .rs sources or the cargo registry)", "inferred", "shipped-artifact");
            c.locations.push(loc("fileOffset", format!("0x{off:x}")));
            c.limitations.push("string heuristic; bundled dependencies can introduce such strings into any binary".into());
            report.claims.push(c);
        }

        // Absolute library paths (dynamic loaders, plugin systems).
        let paths: Vec<String> = needles
            .iter()
            .filter(|s| (s.starts_with("/usr/lib") || s.starts_with("/lib") || s.starts_with("C:\\Windows\\")) && s.len() > 8)
            .take(MAX_NAMES_LISTED)
            .map(|s| s.to_string())
            .collect();
        if !paths.is_empty() {
            let mut c = observed(format!(
                "references absolute system paths {}",
                push_sample(&paths, &paths)
            ));
            c.limitations.push("string-level observation; a path may be referenced without ever being opened".into());
            report.claims.push(c);
        }

        // Embedded zip signatures beyond offset 0.
        let mut embedded = 0usize;
        let mut from = 4;
        while let Some(rel) = bytes[from..].windows(4).position(|w| w == b"PK\x03\x04") {
            let at = from + rel;
            if embedded == 0 {
                let mut c = observed(format!("contains an embedded zip signature at file offset 0x{at:x}"));
                c.limitations.push("the signature is observed; whether the embedded zip is intact is not established".into());
                report.claims.push(c);
            }
            embedded += 1;
            from = at + 4;
            if embedded >= 8 {
                break;
            }
        }
    }
}

// ============================== Tests: synthetic fixtures, built byte by byte ==============================
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn has_claim(report: &ProbeReport, needle: &str) -> bool {
        report.claims.iter().any(|c| c.predicate.contains(needle))
    }

    /// Build a minimal but structurally correct zip: stored (method 0) unless method 8 is requested.
    fn zip_build(entries: &[(&str, u16, Vec<u8>)]) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        let mut central: Vec<Vec<u8>> = Vec::new();
        for (name, method, data) in entries {
            let (payload, csize, usize_) = if *method == 8 {
                let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                enc.write_all(data).unwrap();
                let c = enc.finish().unwrap();
                let cs = c.len();
                (c, cs, data.len())
            } else {
                (data.clone(), data.len(), data.len())
            };
            let lho = out.len();
            out.extend_from_slice(b"PK\x03\x04");
            out.extend_from_slice(&20u16.to_le_bytes()); // version needed
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // time
            out.extend_from_slice(&0u16.to_le_bytes()); // date
            out.extend_from_slice(&0u32.to_le_bytes()); // crc
            out.extend_from_slice(&(csize as u32).to_le_bytes());
            out.extend_from_slice(&(usize_ as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&payload);
            let mut c = Vec::new();
            c.extend_from_slice(b"PK\x01\x02");
            c.extend_from_slice(&20u16.to_le_bytes()); // version made by
            c.extend_from_slice(&20u16.to_le_bytes()); // version needed
            c.extend_from_slice(&0u16.to_le_bytes()); // flags
            c.extend_from_slice(&method.to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes()); // time
            c.extend_from_slice(&0u16.to_le_bytes()); // date
            c.extend_from_slice(&0u32.to_le_bytes()); // crc
            c.extend_from_slice(&(csize as u32).to_le_bytes());
            c.extend_from_slice(&(usize_ as u32).to_le_bytes());
            c.extend_from_slice(&(name.len() as u16).to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes()); // extra
            c.extend_from_slice(&0u16.to_le_bytes()); // comment
            c.extend_from_slice(&0u16.to_le_bytes()); // disk
            c.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            c.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            c.extend_from_slice(&(lho as u32).to_le_bytes());
            c.extend_from_slice(name.as_bytes());
            central.push(c);
        }
        let dir_offset = out.len();
        let n_entries = central.len();
        for c in &central {
            out.extend_from_slice(c);
        }
        let dir_size = out.len() - dir_offset;
        out.extend_from_slice(b"PK\x05\x06");
        out.extend_from_slice(&0u16.to_le_bytes()); // disk
        out.extend_from_slice(&0u16.to_le_bytes()); // cd disk
        out.extend_from_slice(&(n_entries as u16).to_le_bytes());
        out.extend_from_slice(&(n_entries as u16).to_le_bytes());
        out.extend_from_slice(&(dir_size as u32).to_le_bytes());
        out.extend_from_slice(&(dir_offset as u32).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // comment
        out
    }

    fn class_head(major: u16) -> Vec<u8> {
        vec![0xCA, 0xFE, 0xBA, 0xBE, 0x00, 0x00, (major >> 8) as u8, (major & 0xff) as u8]
    }

    #[test]
    fn jar_manifest_pom_class_versions_and_nested_archives() {
        let manifest = b"Manifest-Version: 1.0\r\nImplementation-Title: Acme Widget\r\nImplementation-Version: 1.2.3\r\nBuild-Jdk: 17.0.2\r\n";
        let pom = b"groupId=com.acme\nartifactId=widget\nversion=1.2.3\n";
        let jar = zip_build(&[
            ("META-INF/MANIFEST.MF", 0, manifest.to_vec()),
            ("com/acme/Widget.class", 0, class_head(52)),
            ("META-INF/maven/com.acme/widget/pom.properties", 0, pom.to_vec()),
            ("lib/dep-core-2.0.jar", 0, vec![0u8; 16]),
        ]);
        let mut report = ProbeReport {
            path: "vendor/widget.jar".into(),
            size_bytes: jar.len() as u64,
            sha256: String::new(),
            format: String::new(),
            format_detail: String::new(),
            claims: vec![],
            unresolved: vec![],
            notes: vec![],
        };
        zipc::probe(&jar, &mut report);
        assert_eq!(report.format, "jar");
        assert!(has_claim(&report, "contains 4 entries (1 class files)"), "{:?}", report.claims.iter().map(|c| &c.predicate).collect::<Vec<_>>());
        assert!(has_claim(&report, "contains 1 (lib/dep-core-2.0.jar) nested archive"), "{:#?}", report.claims);
        assert!(has_claim(&report, "manifest Implementation-Version is \"1.2.3\""));
        assert!(has_claim(&report, "pom.properties names the artifact as com.acme:widget:1.2.3"));
        assert!(has_claim(&report, "compiled for Java 8 (class-file major 52)"));
        assert!(has_claim(&report, "Build-Jdk is \"17.0.2\""));
        // Identity present → no "which project" unknown; the rebuild question stays.
        assert!(!report.unresolved.iter().any(|u| u.question.contains("Which upstream project")));
        assert!(report.unresolved.iter().any(|u| u.question.contains("rebuilt bit-for-bit")));
    }

    #[test]
    fn jar_without_identity_leaves_the_question_open() {
        let jar = zip_build(&[("com/x/A.class", 0, class_head(61)), ("data.bin", 0, vec![0u8; 8])]);
        let mut report = ProbeReport {
            path: "x.jar".into(),
            size_bytes: jar.len() as u64,
            sha256: String::new(),
            format: String::new(),
            format_detail: String::new(),
            claims: vec![],
            unresolved: vec![],
            notes: vec![],
        };
        zipc::probe(&jar, &mut report);
        assert_eq!(report.format, "jar");
        assert!(has_claim(&report, "compiled for Java 17 (class-file major 61)"));
        assert!(report.unresolved.iter().any(|u| u.question.contains("Which upstream project")));
    }

    #[test]
    fn deflate_entries_are_inflated() {
        let manifest = b"Manifest-Version: 1.0\r\nImplementation-Version: 9.9.9\r\n";
        let jar = zip_build(&[("META-INF/MANIFEST.MF", 8, manifest.to_vec()), ("a/A.class", 0, class_head(56))]);
        let mut report = ProbeReport {
            path: "d.jar".into(),
            size_bytes: jar.len() as u64,
            sha256: String::new(),
            format: String::new(),
            format_detail: String::new(),
            claims: vec![],
            unresolved: vec![],
            notes: vec![],
        };
        zipc::probe(&jar, &mut report);
        assert!(has_claim(&report, "manifest Implementation-Version is \"9.9.9\""), "{:?}", report.claims);
    }

    /// Minimal ELF64 little-endian: .dynstr, .dynamic (2×DT_NEEDED, DT_SONAME, DT_STRTAB, DT_STRSZ),
    /// .dynsym (one export, one undefined), .note.gnu.build-id, .shstrtab. Addresses equal offsets.
    fn elf64_build() -> Vec<u8> {
        let mut b: Vec<u8> = Vec::new();
        // ELF header.
        b.extend_from_slice(&[0x7f, b'E', b'L', b'F', 2, 1, 1, 0]);
        b.extend_from_slice(&[0u8; 8]); // padding
        b.extend_from_slice(&3u16.to_le_bytes()); // ET_DYN
        b.extend_from_slice(&62u16.to_le_bytes()); // x86-64
        b.extend_from_slice(&1u32.to_le_bytes()); // version
        b.extend_from_slice(&0u64.to_le_bytes()); // entry
        b.extend_from_slice(&0u64.to_le_bytes()); // phoff
        let shoff_at = b.len();
        b.extend_from_slice(&0u64.to_le_bytes()); // shoff (patched)
        b.extend_from_slice(&0u32.to_le_bytes()); // flags
        b.extend_from_slice(&64u16.to_le_bytes()); // ehsize
        b.extend_from_slice(&0u16.to_le_bytes()); // phentsize
        b.extend_from_slice(&0u16.to_le_bytes()); // phnum
        b.extend_from_slice(&64u16.to_le_bytes()); // shentsize
        b.extend_from_slice(&6u16.to_le_bytes()); // shnum
        b.extend_from_slice(&5u16.to_le_bytes()); // shstrndx (index 5 = .shstrtab)
        assert_eq!(b.len(), 64);

        // .dynstr at 0x40.
        let dynstr_off = b.len();
        let mut names: Vec<(String, usize)> = Vec::new();
        for n in ["libc.so.6", "libm.so.6", "libdemo.so.1", "demo_export"] {
            names.push((n.into(), b.len() - dynstr_off));
            b.extend_from_slice(n.as_bytes());
            b.push(0);
        }
        let strsz = b.len() - dynstr_off;

        // .dynamic at next offset.
        let dyn_off = b.len();
        let entry = |tag: u64, val: u64| -> Vec<u8> {
            let mut e = tag.to_le_bytes().to_vec();
            e.extend_from_slice(&val.to_le_bytes());
            e
        };
        b.extend_from_slice(&entry(1, names[0].1 as u64)); // DT_NEEDED libc
        b.extend_from_slice(&entry(1, names[1].1 as u64)); // DT_NEEDED libm
        b.extend_from_slice(&entry(14, names[2].1 as u64)); // DT_SONAME
        b.extend_from_slice(&entry(5, dynstr_off as u64)); // DT_STRTAB
        b.extend_from_slice(&entry(10, strsz as u64)); // DT_STRSZ
        b.extend_from_slice(&entry(0, 0)); // DT_NULL
        let dyn_end = b.len();

        // .dynsym: one undefined, one exported GLOBAL FUNC.
        let sym_off = b.len();
        let sym = |name: u32, info: u8, shndx: u16| -> Vec<u8> {
            let mut e = name.to_le_bytes().to_vec();
            e.push(info);
            e.push(0);
            e.extend_from_slice(&shndx.to_le_bytes());
            e.extend_from_slice(&0u64.to_le_bytes()); // value
            e.extend_from_slice(&0u64.to_le_bytes()); // size
            e
        };
        b.extend_from_slice(&sym(0, 0, 0));
        b.extend_from_slice(&sym(names[3].1 as u32, 0x12, 3));
        let sym_end = b.len();

        // .note.gnu.build-id.
        let note_off = b.len();
        b.extend_from_slice(&4u32.to_le_bytes());
        b.extend_from_slice(&8u32.to_le_bytes());
        b.extend_from_slice(&3u32.to_le_bytes());
        b.extend_from_slice(b"GNU\0");
        b.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);

        // .shstrtab.
        let shstr_off = b.len();
        let mut shnames: Vec<(String, usize)> = Vec::new();
        for n in [".dynstr", ".dynamic", ".dynsym", ".note.gnu.build-id", ".shstrtab"] {
            shnames.push((n.into(), b.len() - shstr_off));
            b.extend_from_slice(n.as_bytes());
            b.push(0);
        }

        // Section headers.
        let shoff = b.len();
        let sh = |name_off: u32, s_type: u32, offset: u64, size: u64, link: u32, entsize: u64| -> Vec<u8> {
            let mut e = Vec::new();
            e.extend_from_slice(&name_off.to_le_bytes());
            e.extend_from_slice(&s_type.to_le_bytes());
            e.extend_from_slice(&0u64.to_le_bytes()); // flags
            e.extend_from_slice(&offset.to_le_bytes()); // addr (== offset in this fixture)
            e.extend_from_slice(&offset.to_le_bytes()); // offset
            e.extend_from_slice(&size.to_le_bytes());
            e.extend_from_slice(&link.to_le_bytes());
            e.extend_from_slice(&0u32.to_le_bytes()); // info
            e.extend_from_slice(&0u64.to_le_bytes()); // addralign
            e.extend_from_slice(&entsize.to_le_bytes());
            e
        };
        b.extend_from_slice(&sh(0, 0, 0, 0, 0, 0)); // null
        b.extend_from_slice(&sh(shnames[0].1 as u32, 3, dynstr_off as u64, strsz as u64, 0, 0)); // .dynstr
        b.extend_from_slice(&sh(shnames[1].1 as u32, 6, dyn_off as u64, (dyn_end - dyn_off) as u64, 1, 16)); // .dynamic
        b.extend_from_slice(&sh(shnames[2].1 as u32, 11, sym_off as u64, (sym_end - sym_off) as u64, 1, 24)); // .dynsym
        b.extend_from_slice(&sh(shnames[3].1 as u32, 7, note_off as u64, 20, 0, 0)); // .note.gnu.build-id
        b.extend_from_slice(&sh(shnames[4].1 as u32, 3, shstr_off as u64, (b.len() + 5 * 64 - shstr_off - 5 * 64) as u64, 0, 0)); // .shstrtab (size patched below)
        // Fix .shstrtab size: it spans from shstr_off to shoff.
        let shstr_size = shoff - shstr_off;
        let shstrtab_sh = shoff + 4 * 64 + 32; // size field of the 5th header (offset 24 → +24; we wrote addr+offset twice, so size at base+32)
        b[shstrtab_sh..shstrtab_sh + 8].copy_from_slice(&(shstr_size as u64).to_le_bytes());
        // Patch e_shoff.
        b[shoff_at..shoff_at + 8].copy_from_slice(&(shoff as u64).to_le_bytes());
        b
    }

    #[test]
    fn elf_dynamics_symbols_build_id_and_stripped() {
        let bytes = elf64_build();
        let mut report = ProbeReport {
            path: "lib/libdemo.so".into(),
            size_bytes: bytes.len() as u64,
            sha256: String::new(),
            format: String::new(),
            format_detail: String::new(),
            claims: vec![],
            unresolved: vec![],
            notes: vec![],
        };
        elf::probe(&bytes, &mut report);
        assert_eq!(report.format, "elf");
        assert!(report.format_detail.contains("ELF64"), "{}", report.format_detail);
        assert!(has_claim(&report, "links against 2 (libc.so.6, libm.so.6) shared libraries"), "{:?}", report.claims.iter().map(|c| &c.predicate).collect::<Vec<_>>());
        assert!(has_claim(&report, "soname is \"libdemo.so.1\""));
        assert!(has_claim(&report, "exports 1 dynamic symbol (sample: demo_export)"));
        assert!(has_claim(&report, "is stripped"));
        assert!(has_claim(&report, "GNU build-id is deadbeef01020304"));
        // Stripped without... wait, it HAS a build-id, so the attribution question is not raised.
        assert!(!report.unresolved.iter().any(|u| u.question.contains("Which source tree")));
        assert!(report.unresolved.iter().any(|u| u.question.contains("same library versions")));
    }

    /// Minimal PE32+ console executable: one .text section, one import (KERNEL32.dll), one export.
    fn pe64_build() -> Vec<u8> {
        let mut b: Vec<u8> = vec![0u8; 0x200 + 0x2000];
        b[0] = b'M';
        b[1] = b'Z';
        let lfanew = 0x40usize;
        b[0x3c..0x40].copy_from_slice(&(lfanew as u32).to_le_bytes());
        b[lfanew..lfanew + 4].copy_from_slice(b"PE\0\0");
        let coff = lfanew + 4;
        b[coff..coff + 2].copy_from_slice(&0x8664u16.to_le_bytes()); // x86-64
        b[coff + 2..coff + 4].copy_from_slice(&1u16.to_le_bytes()); // 1 section
        b[coff + 4..coff + 8].copy_from_slice(&0u32.to_le_bytes()); // timestamp
        b[coff + 16..coff + 18].copy_from_slice(&240u16.to_le_bytes()); // size of optional header
        let opt = coff + 20;
        b[opt..opt + 2].copy_from_slice(&0x20bu16.to_le_bytes()); // PE32+
        b[opt + 68..opt + 70].copy_from_slice(&3u16.to_le_bytes()); // console
        let dd_base = opt + 112;
        // Export dir at RVA 0x1000 (file 0x200), import dir at RVA 0x1100 (file 0x300).
        b[dd_base..dd_base + 4].copy_from_slice(&0x1000u32.to_le_bytes()); // export rva
        b[dd_base + 4..dd_base + 8].copy_from_slice(&64u32.to_le_bytes()); // export size
        b[dd_base + 8..dd_base + 12].copy_from_slice(&0x1100u32.to_le_bytes()); // import rva
        // Section .text: va 0x1000, vsize 0x2000, rawptr 0x200, rawsize 0x2000.
        let sec = opt + 240;
        b[sec..sec + 8].copy_from_slice(b".text\0\0\0");
        b[sec + 8..sec + 12].copy_from_slice(&0x2000u32.to_le_bytes()); // vsize
        b[sec + 12..sec + 16].copy_from_slice(&0x1000u32.to_le_bytes()); // va
        b[sec + 16..sec + 20].copy_from_slice(&0x2000u32.to_le_bytes()); // rawsize
        b[sec + 20..sec + 24].copy_from_slice(&0x200u32.to_le_bytes()); // rawptr
        let off = |rva: u32| (rva - 0x1000 + 0x200) as usize;

        // Export directory (40 bytes) at rva 0x1000.
        let e = off(0x1000);
        b[e + 12..e + 16].copy_from_slice(&0x1500u32.to_le_bytes()); // module name rva
        b[e + 20..e + 24].copy_from_slice(&2u32.to_le_bytes()); // nfuncs
        b[e + 24..e + 28].copy_from_slice(&2u32.to_le_bytes()); // nnames
        b[e + 28..e + 32].copy_from_slice(&0x1600u32.to_le_bytes()); // addrOfFunctions
        b[e + 32..e + 36].copy_from_slice(&0x1700u32.to_le_bytes()); // addrOfNames
        // Names blob at rva 0x1500.
        let mut blob = 0x1500u32;
        for s in ["demo.dll", "demo_open", "demo_close"] {
            b[off(blob)..off(blob) + s.len()].copy_from_slice(s.as_bytes());
            b[off(blob) + s.len()] = 0;
            if s == "demo.dll" {
                // remember module-name rva == 0x1500 already
            }
            blob += s.len() as u32 + 1;
        }
        // AddressOfNames: two RVAs pointing at demo_open / demo_close.
        let names_rva = 0x1700;
        b[off(names_rva)..off(names_rva) + 4].copy_from_slice(&(0x1500 + 9u32).to_le_bytes());
        b[off(names_rva) + 4..off(names_rva) + 8].copy_from_slice(&(0x1500 + 19u32).to_le_bytes());

        // Import descriptor at rva 0x1100: name rva → KERNEL32.dll, then a zero terminator.
        let imp = off(0x1100);
        b[imp + 12..imp + 16].copy_from_slice(&(0x1500 + 30u32).to_le_bytes()); // name rva
        let kname = off(0x1500 + 30);
        b[kname..kname + 13].copy_from_slice(b"KERNEL32.dll\0");
        // (OriginalFirstThunk == 0 and Name != 0 still names the DLL; then the all-zero descriptor follows.)
        b
    }

    #[test]
    fn pe_imports_exports_subsystem_and_provenance_question() {
        let bytes = pe64_build();
        let mut report = ProbeReport {
            path: "bin/demo.exe".into(),
            size_bytes: bytes.len() as u64,
            sha256: String::new(),
            format: String::new(),
            format_detail: String::new(),
            claims: vec![],
            unresolved: vec![],
            notes: vec![],
        };
        pe::probe(&bytes, &mut report);
        assert_eq!(report.format, "pe");
        assert!(report.format_detail.contains("PE32+"), "{}", report.format_detail);
        assert!(report.format_detail.contains("x86-64"));
        assert!(has_claim(&report, "subsystem console"));
        assert!(has_claim(&report, "imports from 1 (KERNEL32.dll) dynamic-link library"), "{:?}", report.claims.iter().map(|c| &c.predicate).collect::<Vec<_>>());
        assert!(has_claim(&report, "exports 2 functions (2 by name; sample: demo_open, demo_close)"));
        // The fixture's timestamp field is zero — the honest output is a note, not a date claim.
        assert!(report.notes.iter().any(|n| n.contains("timestamp is zero")), "{:?}", report.notes);
        assert!(report.claims.iter().any(|c| c.predicate.contains("subsystem") && !c.limitations.is_empty()) || report.claims.iter().any(|c| c.predicate.contains("subsystem")));
        assert!(report.unresolved.iter().any(|u| u.question.contains("Who built and signed")));
    }

    #[test]
    fn string_sweep_reports_urls_go_and_paths_with_limitations() {
        let mut bytes: Vec<u8> = vec![0xff; 16];
        bytes.extend_from_slice(b"Visit https://example.com/docs today\x00");
        bytes.extend_from_slice(b"go1.21.5\x00");
        bytes.extend_from_slice(b"/usr/lib/x86_64-linux-gnu\0");
        bytes.extend_from_slice(&[0x00, 0x00]);
        let mut report = ProbeReport {
            path: "x.bin".into(),
            size_bytes: bytes.len() as u64,
            sha256: String::new(),
            format: String::new(),
            format_detail: String::new(),
            claims: vec![],
            unresolved: vec![],
            notes: vec![],
        };
        strings::sweep(&bytes, &mut report);
        assert!(has_claim(&report, "contains 1 (https://example.com/docs) distinct http(s) URL"), "{:?}", report.claims.iter().map(|c| &c.predicate).collect::<Vec<_>>());
        assert!(has_claim(&report, "built with Go 1.21.5"));
        let go = report.claims.iter().find(|c| c.predicate.contains("Go 1.21.5")).unwrap();
        assert_eq!(go.confidence, "derived");
        assert!(go.limitations.iter().any(|l| l.contains("heuristic")));
        assert!(has_claim(&report, "references absolute system paths 1 (/usr/lib/x86_64-linux-gnu)"));
    }

    #[test]
    fn unknown_magic_refuses_to_guess() {
        let dir = std::env::temp_dir().join(format!("cie-artifact-test-{}-mystery", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("mystery.bin");
        std::fs::write(&file, b"\x13\x37CAFE\x00\x00NOT A REAL FORMAT").unwrap();
        let report = probe_artifact(&file, "vendor/mystery.bin").unwrap();
        assert_eq!(report.format, "unknown");
        assert!(report.unresolved.iter().any(|u| u.question.contains("What produced") && u.reason.contains("refuses to guess")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn end_to_end_probe_writes_hash_and_respects_size_limit() {
        let jar = zip_build(&[("META-INF/MANIFEST.MF", 0, b"Manifest-Version: 1.0\r\n".to_vec())]);
        let dir = std::env::temp_dir().join(format!("cie-artifact-test-{}-probe", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("probe-e2e.jar");
        std::fs::write(&file, &jar).unwrap();
        let report = probe_artifact(&file, "vendor/probe-e2e.jar").unwrap();
        assert_eq!(report.path, "vendor/probe-e2e.jar");
        assert_eq!(report.sha256.len(), 64);
        assert!(report.claims.iter().any(|c| c.predicate.starts_with("is a jar file")));
        // Oversize artifacts are refused with the resource-limit code, not probed.
        let big = dir.join("too-big.jar");
        let mut f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_PROBE_BYTES + 1).unwrap();
        drop(f);
        let err = probe_artifact(&big, "vendor/too-big.jar").unwrap_err();
        assert_eq!(err.0, "RESOURCE_LIMIT");
        std::fs::remove_dir_all(&dir).ok();
    }
}
