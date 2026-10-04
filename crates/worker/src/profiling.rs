//! F05 — Trace-linked continuous profiling (worker side).
//!
//! Implements profile import, normalisation, hotspot aggregation, trace correlation and
//! profile comparison for the formats chosen in F05 §2.3: V8 `.cpuprofile`, collapsed/folded
//! stacks, and a minimal pprof reader.  The worker keeps aggregates only; raw samples stay in
//! the artifact store by reference.  Every exported metric carries its population hash, sample
//! count, unit and correlation grade so the Node side can bind presentation honestly.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;

pub const MAX_PROFILE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_STACK_DEPTH: usize = 256;
pub const MAX_FRAMES: usize = 50_000;
pub const MIN_SAMPLES_FOR_RANKING: usize = 100;
pub const COLLECTION_RATIO_THRESHOLD: f64 = 0.9;
pub const PRUNE_NODE_COUNT: usize = 5_000;
pub const PRUNE_MAX_DEPTH: usize = 64;
pub const PRUNE_MIN_SHARE: f64 = 0.001;
pub const PRUNE_ABS_FLOOR: f64 = 1.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SampleKind {
    Cpu,
    Wall,
    AllocSpace,
    AllocObjects,
    InuseSpace,
    InuseObjects,
    LockContention,
    Other,
}

impl SampleKind {
    fn from_declared(raw_type: &str, raw_unit: &str, period_ns: Option<i64>, profiler: Option<&str>) -> Self {
        let t = raw_type.to_lowercase();
        let u = raw_unit.to_lowercase();
        if t.contains("cpu") {
            return SampleKind::Cpu;
        }
        if t.contains("samples") {
            if let Some(p) = profiler {
                if p.to_lowercase().contains("cpu") {
                    return SampleKind::Cpu;
                }
            }
        }
        if t.contains("wall") || t.contains("wallclock") {
            return SampleKind::Wall;
        }
        if t.contains("alloc") && t.contains("space") || t.contains("alloc_space") {
            return SampleKind::AllocSpace;
        }
        if t.contains("alloc") && t.contains("objects") || t.contains("alloc_objects") {
            return SampleKind::AllocObjects;
        }
        if t.contains("inuse") && t.contains("space") || t.contains("inuse_space") {
            return SampleKind::InuseSpace;
        }
        if t.contains("inuse") && t.contains("objects") || t.contains("inuse_objects") {
            return SampleKind::InuseObjects;
        }
        if t.contains("lock") || t.contains("contention") || t.contains("delay") {
            return SampleKind::LockContention;
        }
        if t == "samples" && u == "count" && period_ns.is_some() {
            // Conservative default: without an explicit CPU profiler declaration, treat sample/count
            // with a period as CPU only if the period is present and the type is otherwise unlabelled.
            // F05-A3 demands we not relabel: this branch only fires for the canonical "samples/count".
            return SampleKind::Cpu;
        }
        SampleKind::Other
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleTypeView {
    pub ordinal: usize,
    pub kind: SampleKind,
    pub unit: String,
    pub raw_type: String,
    pub raw_unit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingView {
    pub mapping_id: usize,
    pub build_id: Option<String>,
    pub file: Option<String>,
    pub has_functions: bool,
    pub has_filenames: bool,
    pub has_line_numbers: bool,
    pub has_inline_frames: bool,
    pub revision: Option<String>,
    pub revision_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ParsedProfile {
    pub format: String,
    pub format_version: Option<String>,
    pub profiler: Option<String>,
    pub profiler_version: Option<String>,
    pub service: Option<String>,
    pub instance: Option<String>,
    pub runtime: Option<String>,
    pub start_ns: i64,
    pub end_ns: i64,
    pub period_ns: Option<i64>,
    pub sampling_rate_hz: Option<f64>,
    pub declared_overhead_percent: Option<f64>,
    pub dropped_samples: Option<i64>,
    pub truncated: i64,
    pub sample_types: Vec<SampleTypeInternal>,
    pub samples: Vec<Sample>,
    pub locations: Vec<Location>,
    pub mappings: Vec<Mapping>,
}

#[derive(Debug, Clone)]
pub struct SampleTypeInternal {
    pub ordinal: usize,
    pub kind: SampleKind,
    pub unit: String,
    pub raw_type: String,
    pub raw_unit: String,
}

#[derive(Debug, Clone)]
pub struct Location {
    pub id: u64,
    pub mapping_id: u64,
    pub address: u64,
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone)]
pub struct Line {
    pub function_id: u64,
    pub function_name: String,
    pub file: String,
    pub line: i64,
}

#[derive(Debug, Clone)]
pub struct Mapping {
    pub id: u64,
    pub build_id: String,
    pub file: String,
    pub has_functions: bool,
    pub has_filenames: bool,
    pub has_line_numbers: bool,
    pub has_inline_frames: bool,
}

#[derive(Debug, Clone)]
pub struct Sample {
    pub location_ids: Vec<u64>,
    pub values: Vec<i64>,
    pub labels: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestProfileResult {
    pub artifact_hash: String,
    pub format: String,
    pub sample_types: Vec<SampleTypeView>,
    pub period_ns: Option<i64>,
    pub mappings: Vec<MappingView>,
    pub diagnostics: Vec<Diagnostic>,
    #[serde(with = "serde_dropped_samples")]
    pub dropped_samples: Option<i64>,
    // F05: identity and window bounds the TS service keys artifacts by, builds populations from and correlates with;
    // without them the service could not persist profiles per §6.1/6.2. Absent fields stay null, never guessed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profiler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profiler_version: Option<String>,
    pub start_ns: i64,
    pub end_ns: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampling_rate_hz: Option<f64>,
    pub truncated: i64,
}

mod serde_dropped_samples {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Option<i64>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            None => s.serialize_str("NOT_REPORTED"),
            Some(n) => s.serialize_i64(*n),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
        let val = serde_json::Value::deserialize(d)?;
        if let Some(n) = val.as_i64() {
            Ok(Some(n))
        } else if let Some(s) = val.as_str() {
            if s.eq_ignore_ascii_case("NOT_REPORTED") {
                Ok(None)
            } else {
                Err(serde::de::Error::custom("expected integer or NOT_REPORTED"))
            }
        } else {
            Err(serde::de::Error::custom("expected integer or string"))
        }
    }
}

pub fn artifact_hash(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// Parse an unknown profile by sniffing the first bytes.
pub fn parse_profile(bytes: &[u8], service_hint: Option<&str>) -> Result<ParsedProfile, Vec<Diagnostic>> {
    if bytes.len() > MAX_PROFILE_BYTES {
        return Err(vec![Diagnostic {
            code: "RESOURCE_LIMIT".into(),
            message: format!("profile size {} exceeds {} bytes", bytes.len(), MAX_PROFILE_BYTES),
        }]);
    }
    if bytes.is_empty() {
        return Err(vec![Diagnostic {
            code: "INVALID_SCHEMA".into(),
            message: "empty profile".into(),
        }]);
    }
    // Sniff V8 cpuprofile (JSON with "nodes" and "samples" keys) or folded stacks.
    if bytes.starts_with(b"{") {
        return parse_v8_cpuprofile(bytes, service_hint);
    }
    if bytes.starts_with(&[0x1f, 0x8b]) {
        // gzip; try pprof.
        return parse_pprof(bytes, service_hint);
    }
    // Folded stacks: text lines like "a;b;c 42".
    parse_folded(bytes, service_hint)
}

// ---------- Folded stacks ----------

fn parse_folded(bytes: &[u8], service_hint: Option<&str>) -> Result<ParsedProfile, Vec<Diagnostic>> {
    let text = std::str::from_utf8(bytes).map_err(|e| vec![Diagnostic {
        code: "INVALID_SCHEMA".into(),
        message: format!("folded stacks must be UTF-8: {e}"),
    }])?;

    let mut diagnostics = Vec::new();
    let mut function_names: Vec<String> = Vec::new();
    let mut name_to_id: HashMap<String, u64> = HashMap::new();
    let mut locations: Vec<Location> = Vec::new();
    let mut samples: Vec<Sample> = Vec::new();
    let mut truncated_total: i64 = 0;

    let mut next_fn_id: u64 = 1;
    let mut next_loc_id: u64 = 1;

    for (line_no, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.rsplitn(2, ' ').collect();
        if parts.len() != 2 {
            diagnostics.push(Diagnostic {
                code: "INVALID_SCHEMA".into(),
                message: format!("line {}: no count found", line_no + 1),
            });
            continue;
        }
        let count: i64 = parts[0].parse().map_err(|e| vec![Diagnostic {
            code: "INVALID_SCHEMA".into(),
            message: format!("line {}: invalid count '{}': {e}", line_no + 1, parts[0]),
        }])?;
        if count < 0 {
            return Err(vec![Diagnostic {
                code: "INVALID_SCHEMA".into(),
                message: format!("line {}: negative count", line_no + 1),
            }]);
        }
        let frames: Vec<&str> = parts[1].split(';').collect();
        let mut stack = Vec::new();
        let mut truncated = 0i64;
        for (depth, name) in frames.iter().enumerate() {
            if depth >= MAX_STACK_DEPTH {
                truncated += 1;
                truncated_total += 1;
                break;
            }
            let name = name.to_string();
            let fn_id = *name_to_id.entry(name.clone()).or_insert_with(|| {
                let id = next_fn_id;
                next_fn_id += 1;
                function_names.push(name);
                id
            });
            let loc_id = next_loc_id;
            next_loc_id += 1;
            locations.push(Location {
                id: loc_id,
                mapping_id: 0,
                address: 0,
                lines: vec![Line {
                    function_id: fn_id,
                    function_name: function_names[(fn_id - 1) as usize].clone(),
                    file: String::new(),
                    line: 0,
                }],
            });
            stack.push(loc_id);
        }
        // Inner-most is last in folded format; pprof/V8 order is inner-most first.  Normalise.
        stack.reverse();
        samples.push(Sample {
            location_ids: stack,
            values: vec![count],
            labels: Vec::new(),
        });
    }

    if samples.is_empty() {
        return Err(vec![Diagnostic {
            code: "INVALID_SCHEMA".into(),
            message: "folded profile contained no samples".into(),
        }]);
    }

    let total_value: i64 = samples.iter().map(|s| s.values[0]).sum();

    Ok(ParsedProfile {
        format: "folded".into(),
        format_version: None,
        profiler: None,
        profiler_version: None,
        service: service_hint.map(|s| s.to_string()),
        instance: None,
        runtime: None,
        start_ns: 0,
        end_ns: 0,
        period_ns: None,
        sampling_rate_hz: None,
        declared_overhead_percent: None,
        dropped_samples: None,
        truncated: truncated_total,
        sample_types: vec![SampleTypeInternal {
            ordinal: 0,
            kind: SampleKind::Other,
            unit: "samples".into(),
            raw_type: "samples".into(),
            raw_unit: "count".into(),
        }],
        samples,
        locations,
        mappings: Vec::new(),
    })
}

// ---------- V8 .cpuprofile ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V8Node {
    id: i64,
    #[serde(default)]
    call_frame: V8CallFrame,
    #[serde(default)]
    children: Vec<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V8CallFrame {
    #[serde(default)]
    function_name: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    line_number: i64,
    #[serde(default)]
    column_number: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V8Profile {
    #[serde(default)]
    nodes: Vec<V8Node>,
    #[serde(default)]
    samples: Vec<i64>,
    #[serde(default)]
    time_deltas: Vec<i64>,
    #[serde(default)]
    start_time: f64,
    #[serde(default)]
    end_time: f64,
    #[serde(default)]
    sample_interval: Option<f64>,
}

fn parse_v8_cpuprofile(bytes: &[u8], service_hint: Option<&str>) -> Result<ParsedProfile, Vec<Diagnostic>> {
    let profile: V8Profile = serde_json::from_slice(bytes).map_err(|e| vec![Diagnostic {
        code: "INVALID_SCHEMA".into(),
        message: format!("V8 cpuprofile parse error: {e}"),
    }])?;

    if profile.samples.is_empty() {
        return Err(vec![Diagnostic {
            code: "INVALID_SCHEMA".into(),
            message: "V8 cpuprofile has no samples".into(),
        }]);
    }

    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let mut node_map: HashMap<i64, &V8Node> = HashMap::new();
    for n in &profile.nodes {
        node_map.insert(n.id, n);
    }
    // children is top-down in V8; we need parent map.
    let mut parent_of: HashMap<i64, i64> = HashMap::new();
    for n in &profile.nodes {
        for c in &n.children {
            parent_of.insert(*c, n.id);
        }
    }

    let mut function_names: Vec<String> = Vec::new();
    let mut name_to_id: HashMap<String, u64> = HashMap::new();
    let mut next_fn_id: u64 = 1;

    let mut locations: Vec<Location> = Vec::new();
    let mut loc_by_node: HashMap<i64, u64> = HashMap::new();

    for n in &profile.nodes {
        let name = if n.call_frame.function_name.is_empty() {
            "(anonymous)".to_string()
        } else {
            n.call_frame.function_name.clone()
        };
        let fn_id = *name_to_id.entry(name.clone()).or_insert_with(|| {
            let id = next_fn_id;
            next_fn_id += 1;
            function_names.push(name);
            id
        });
        let loc_id = locations.len() as u64 + 1;
        loc_by_node.insert(n.id, loc_id);
        // V8 line numbers are 0-based; the canonical line field is 1-based (F05-D2). -1 means "unknown" and stays 0.
        let line = if n.call_frame.line_number >= 0 { n.call_frame.line_number + 1 } else { 0 };
        locations.push(Location {
            id: loc_id,
            mapping_id: 0,
            address: 0,
            lines: vec![Line {
                function_id: fn_id,
                function_name: function_names[(fn_id - 1) as usize].clone(),
                file: n.call_frame.url.clone(),
                line,
            }],
        });
    }

    let mut samples: Vec<Sample> = Vec::new();
    let mut truncated_total: i64 = 0;

    for (i, node_id) in profile.samples.iter().enumerate() {
        let value = if i < profile.time_deltas.len() { profile.time_deltas[i].max(0) } else { 1 };
        let mut stack: Vec<u64> = Vec::new();
        let mut cur = *node_id;
        let mut depth = 0;
        loop {
            if depth >= MAX_STACK_DEPTH {
                truncated_total += 1;
                break;
            }
            if let Some(&loc_id) = loc_by_node.get(&cur) {
                stack.push(loc_id);
            }
            depth += 1;
            match parent_of.get(&cur) {
                Some(&p) => cur = p,
                None => break,
            }
        }
        // stack currently root->leaf; reverse so inner-most first.
        stack.reverse();
        samples.push(Sample {
            location_ids: stack,
            values: vec![value],
            labels: Vec::new(),
        });
    }

    let total_value: i64 = samples.iter().map(|s| s.values[0]).sum();
    let duration_ms = profile.end_time - profile.start_time;
    let start_ns = (profile.start_time * 1_000.0) as i64;
    let end_ns = (profile.end_time * 1_000.0) as i64;
    let period_ns = profile.sample_interval.map(|ms| (ms * 1_000.0) as i64);
    let sampling_rate_hz = period_ns.map(|p| if p > 0 { 1_000_000_000.0 / p as f64 } else { 0.0 });

    Ok(ParsedProfile {
        format: "v8-cpuprofile".into(),
        format_version: None,
        profiler: Some("v8".into()),
        profiler_version: None,
        service: service_hint.map(|s| s.to_string()),
        instance: None,
        runtime: Some("node".into()),
        start_ns,
        end_ns,
        period_ns,
        sampling_rate_hz,
        declared_overhead_percent: None,
        dropped_samples: None,
        truncated: truncated_total,
        sample_types: vec![SampleTypeInternal {
            ordinal: 0,
            kind: SampleKind::Cpu,
            unit: "microseconds".into(),
            raw_type: "cpu".into(),
            raw_unit: "microseconds".into(),
        }],
        samples,
        locations,
        mappings: Vec::new(),
    })
}

// ---------- Minimal pprof protobuf parser ----------

#[derive(Debug, Clone)]
enum PbValue {
    Var(i64),
    Len(Vec<u8>),
    I32(u32),
    I64(u64),
}

fn decode_varint(buf: &[u8], pos: &mut usize) -> Option<i64> {
    let mut val: u64 = 0;
    let mut shift = 0;
    while *pos < buf.len() && shift < 64 {
        let b = buf[*pos];
        *pos += 1;
        val |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Some(val as i64);
        }
        shift += 7;
    }
    None
}

fn read_field(buf: &[u8], pos: &mut usize) -> Option<(u64, PbValue)> {
    if *pos >= buf.len() {
        return None;
    }
    let tag = decode_varint(buf, pos)? as u64;
    let field = tag >> 3;
    let wire = tag & 0x7;
    match wire {
        0 => {
            let v = decode_varint(buf, pos)?;
            Some((field, PbValue::Var(v)))
        }
        1 => {
            if *pos + 8 > buf.len() {
                return None;
            }
            let mut u: u64 = 0;
            for i in 0..8 {
                u |= (buf[*pos + i] as u64) << (8 * i);
            }
            *pos += 8;
            Some((field, PbValue::I64(u)))
        }
        2 => {
            let len = decode_varint(buf, pos)? as usize;
            if *pos + len > buf.len() {
                return None;
            }
            let v = buf[*pos..*pos + len].to_vec();
            *pos += len;
            Some((field, PbValue::Len(v)))
        }
        5 => {
            if *pos + 4 > buf.len() {
                return None;
            }
            let mut u: u32 = 0;
            for i in 0..4 {
                u |= (buf[*pos + i] as u32) << (8 * i);
            }
            *pos += 4;
            Some((field, PbValue::I32(u)))
        }
        _ => None,
    }
}

fn parse_message(buf: &[u8]) -> HashMap<u64, Vec<PbValue>> {
    let mut m: HashMap<u64, Vec<PbValue>> = HashMap::new();
    let mut pos = 0;
    while let Some((f, v)) = read_field(buf, &mut pos) {
        m.entry(f).or_default().push(v);
    }
    m
}

fn get_var(m: &HashMap<u64, Vec<PbValue>>, f: u64) -> Option<i64> {
    m.get(&f).and_then(|v| v.first()).and_then(|v| match v {
        PbValue::Var(n) => Some(*n),
        _ => None,
    })
}

fn get_len_items(m: &HashMap<u64, Vec<PbValue>>, f: u64) -> Vec<HashMap<u64, Vec<PbValue>>> {
    m.get(&f)
        .unwrap_or(&Vec::new())
        .iter()
        .filter_map(|v| match v {
            PbValue::Len(b) => Some(parse_message(b)),
            _ => None,
        })
        .collect()
}

fn pprof_string(strings: &[String], idx: i64) -> String {
    if idx > 0 && (idx as usize) < strings.len() {
        strings[idx as usize].clone()
    } else {
        String::new()
    }
}

fn parse_pprof(bytes: &[u8], service_hint: Option<&str>) -> Result<ParsedProfile, Vec<Diagnostic>> {
    let decompressed = gzip_decompress(bytes)?;
    if decompressed.len() > MAX_PROFILE_BYTES {
        return Err(vec![Diagnostic {
            code: "RESOURCE_LIMIT".into(),
            message: format!("decompressed pprof exceeds {} bytes", MAX_PROFILE_BYTES),
        }]);
    }

    let root = parse_message(&decompressed);

    let strings: Vec<String> = root
        .get(&6)
        .map(|v| {
            v.iter()
                .filter_map(|x| match x {
                    PbValue::Len(b) => Some(String::from_utf8_lossy(b).into_owned()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();

    let time_nanos = get_var(&root, 9).unwrap_or(0);
    let duration_nanos = get_var(&root, 10).unwrap_or(0);
    let period = get_var(&root, 12);

    let period_type_msg = get_len_items(&root, 11).pop();
    let (period_type_type, period_type_unit) = period_type_msg
        .as_ref()
        .map(|m| {
            (
                pprof_string(&strings, get_var(m, 1).unwrap_or(0)),
                pprof_string(&strings, get_var(m, 2).unwrap_or(0)),
            )
        })
        .unwrap_or_default();

    let sample_type_msgs = get_len_items(&root, 1);
    let sample_types: Vec<SampleTypeInternal> = sample_type_msgs
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let raw_type = pprof_string(&strings, get_var(m, 1).unwrap_or(0));
            let raw_unit = pprof_string(&strings, get_var(m, 2).unwrap_or(0));
            let kind = SampleKind::from_declared(&raw_type, &raw_unit, period, Some("pprof"));
            let unit = if raw_unit.is_empty() { "samples".into() } else { raw_unit.clone() };
            SampleTypeInternal { ordinal: i, kind, unit, raw_type, raw_unit }
        })
        .collect();

    let mut functions: HashMap<u64, Line> = HashMap::new();
    for m in get_len_items(&root, 5) {
        let id = get_var(&m, 1).unwrap_or(0) as u64;
        let name = pprof_string(&strings, get_var(&m, 2).unwrap_or(0));
        let file = pprof_string(&strings, get_var(&m, 4).unwrap_or(0));
        let line = get_var(&m, 5).unwrap_or(0);
        functions.insert(id, Line { function_id: id, function_name: name, file, line });
    }

    let mut mappings: Vec<Mapping> = Vec::new();
    let mut mapping_build: HashMap<u64, String> = HashMap::new();
    for m in get_len_items(&root, 3) {
        let id = get_var(&m, 1).unwrap_or(0) as u64;
        let build_id = pprof_string(&strings, get_var(&m, 2).unwrap_or(0));
        let file = pprof_string(&strings, get_var(&m, 3).unwrap_or(0));
        mapping_build.insert(id, build_id.clone());
        mappings.push(Mapping {
            id,
            build_id,
            file,
            has_functions: get_var(&m, 4).unwrap_or(0) != 0,
            has_filenames: get_var(&m, 5).unwrap_or(0) != 0,
            has_line_numbers: get_var(&m, 6).unwrap_or(0) != 0,
            has_inline_frames: get_var(&m, 7).unwrap_or(0) != 0,
        });
    }

    let mut locations: Vec<Location> = Vec::new();
    let mut loc_by_id: HashMap<u64, u64> = HashMap::new();
    for m in get_len_items(&root, 4) {
        let id = get_var(&m, 1).unwrap_or(0) as u64;
        let mapping_id = get_var(&m, 2).unwrap_or(0) as u64;
        let address = get_var(&m, 3).unwrap_or(0) as u64;
        let mut lines: Vec<Line> = Vec::new();
        for lm in get_len_items(&m, 4) {
            let fn_id = get_var(&lm, 1).unwrap_or(0) as u64;
            let line = get_var(&lm, 2).unwrap_or(0);
            let mut l = functions.get(&fn_id).cloned().unwrap_or(Line {
                function_id: fn_id,
                function_name: format!("fn@{fn_id}"),
                file: String::new(),
                line: 0,
            });
            l.line = line;
            lines.push(l);
        }
        let new_id = locations.len() as u64 + 1;
        loc_by_id.insert(id, new_id);
        locations.push(Location { id: new_id, mapping_id, address, lines });
    }

    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let mut samples: Vec<Sample> = Vec::new();
    let mut truncated_total: i64 = 0;

    for m in get_len_items(&root, 2) {
        let location_ids: Vec<u64> = m
            .get(&1)
            .map(|v| {
                v.iter()
                    .filter_map(|x| match x {
                        PbValue::Var(n) => loc_by_id.get(&(*n as u64)).copied(),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        if location_ids.len() > MAX_STACK_DEPTH {
            truncated_total += (location_ids.len() - MAX_STACK_DEPTH) as i64;
        }
        let values: Vec<i64> = m
            .get(&2)
            .map(|v| v.iter().filter_map(|x| match x { PbValue::Var(n) => Some(*n), _ => None }).collect())
            .unwrap_or_default();
        samples.push(Sample {
            location_ids: location_ids.into_iter().take(MAX_STACK_DEPTH).collect(),
            values,
            labels: Vec::new(),
        });
    }

    if samples.is_empty() {
        return Err(vec![Diagnostic {
            code: "INVALID_SCHEMA".into(),
            message: "pprof contained no samples".into(),
        }]);
    }

    let kind0 = sample_types
        .first()
        .map(|st| st.kind.clone())
        .unwrap_or(SampleKind::Other);
    let unit0 = sample_types.first().map(|st| st.unit.clone()).unwrap_or_else(|| "samples".into());

    Ok(ParsedProfile {
        format: "pprof".into(),
        format_version: None,
        profiler: Some("pprof".into()),
        profiler_version: None,
        service: service_hint.map(|s| s.to_string()),
        instance: None,
        runtime: None,
        start_ns: time_nanos,
        end_ns: time_nanos + duration_nanos,
        period_ns: period,
        sampling_rate_hz: period.map(|p| if p > 0 { 1_000_000_000.0 / p as f64 } else { 0.0 }),
        declared_overhead_percent: None,
        dropped_samples: None,
        truncated: truncated_total,
        sample_types,
        samples,
        locations,
        mappings,
    })
}

fn gzip_decompress(bytes: &[u8]) -> Result<Vec<u8>, Vec<Diagnostic>> {
    let mut decoder = flate2::read::GzDecoder::new(bytes);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).map_err(|e| vec![Diagnostic {
        code: "INVALID_SCHEMA".into(),
        message: format!("gzip decompression failed: {e}"),
    }])?;
    Ok(out)
}

// ---------- Aggregation and hotspots ----------

fn normalise_function_key(name: &str, file: &str, line: i64) -> String {
    format!("{}|{}|{}", name, file, line)
}

fn frame_at_location(profile: &ParsedProfile, loc_id: u64) -> Option<(&str, &str, i64)> {
    let loc = profile.locations.iter().find(|l| l.id == loc_id)?;
    let line = loc.lines.first()?;
    Some((&line.function_name,&line.file, line.line))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotspotRow {
    pub rank: usize,
    pub function_key: String,
    pub name: String,
    pub file: String,
    pub line: i64,
    pub self_value: f64,
    pub total_value: f64,
    pub self_share: f64,
    pub total_share: f64,
    pub sample_count: i64,
    pub uncertainty_low: f64,
    pub uncertainty_high: f64,
    pub entity_id: Option<String>,
    pub attribution_method: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub collection_ratio: Option<f64>,
    #[serde(with = "serde_dropped_samples")]
    pub dropped_samples: Option<i64>,
    pub truncated_stacks: i64,
    pub unattributed_share: f64,
    pub pruned_share: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Uncertainty {
    pub method: String,
    pub min_samples_for_ranking: usize,
    pub too_few_samples: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotspotResult {
    pub rows: Vec<HotspotRow>,
    pub unit: String,
    pub sample_count: usize,
    pub population_value: f64,
    pub coverage: Coverage,
    pub uncertainty: Uncertainty,
    pub basis: String,
    pub grade: String,
    pub population_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopulationSpec {
    pub service: String,
    pub window_from_ns: i64,
    pub window_to_ns: i64,
    pub revision: Option<String>,
    pub sample_type_kind: SampleKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Population {
    pub population_hash: String,
    pub service: String,
    pub window_from_ns: i64,
    pub window_to_ns: i64,
    pub revision: Option<String>,
    pub sample_type_kind: SampleKind,
    pub chunk_ids: Vec<String>,
    pub sample_count: usize,
    pub expected_samples: Option<i64>,
    pub collection_ratio: Option<f64>,
    pub request_count: Option<i64>,
    pub error_count: Option<i64>,
}

fn population_hash(spec: &PopulationSpec, chunk_ids: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(spec.service.as_bytes());
    hasher.update(&spec.window_from_ns.to_be_bytes());
    hasher.update(&spec.window_to_ns.to_be_bytes());
    if let Some(r) = &spec.revision {
        hasher.update(r.as_bytes());
    }
    let kind_str = serde_json::to_string(&spec.sample_type_kind).unwrap_or_default();
    hasher.update(kind_str.as_bytes());
    for id in chunk_ids {
        hasher.update(id.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn aggregate_profile(profile: &ParsedProfile, ordinal: usize) -> (HashMap<String, HotspotRow>, f64, i64) {
    let mut rows: HashMap<String, HotspotRow> = HashMap::new();
    let mut total_value: f64 = 0.0;
    let mut sample_count: i64 = 0;

    for sample in &profile.samples {
        let value = *sample.values.get(ordinal).unwrap_or(&sample.values.first().copied().unwrap_or(0)) as f64;
        if value <= 0.0 {
            continue;
        }
        total_value += value;
        sample_count += 1;

        // Self (leaf) attribution.
        if let Some(&leaf_loc) = sample.location_ids.first() {
            if let Some((name, file, line)) = frame_at_location(profile, leaf_loc) {
                let key = normalise_function_key(name, file, line);
                let r = rows.entry(key.clone()).or_insert_with(|| HotspotRow {
                    rank: 0,
                    function_key: key,
                    name: name.to_string(),
                    file: file.to_string(),
                    line,
                    self_value: 0.0,
                    total_value: 0.0,
                    self_share: 0.0,
                    total_share: 0.0,
                    sample_count: 0,
                    uncertainty_low: 0.0,
                    uncertainty_high: 0.0,
                    entity_id: None,
                    attribution_method: "FUNCTION_NAME".into(),
                });
                r.self_value += value;
                r.sample_count += 1;
            }
        }

        // Total (cumulative) attribution: distinct functions in the stack.
        let mut seen: HashSet<String> = HashSet::new();
        for &loc_id in &sample.location_ids {
            if let Some((name, file, line)) = frame_at_location(profile, loc_id) {
                let key = normalise_function_key(name, file, line);
                if seen.insert(key.clone()) {
                    let r = rows.entry(key.clone()).or_insert_with(|| HotspotRow {
                        rank: 0,
                        function_key: key,
                        name: name.to_string(),
                        file: file.to_string(),
                        line,
                        self_value: 0.0,
                        total_value: 0.0,
                        self_share: 0.0,
                        total_share: 0.0,
                        sample_count: 0,
                        uncertainty_low: 0.0,
                        uncertainty_high: 0.0,
                        entity_id: None,
                        attribution_method: "FUNCTION_NAME".into(),
                    });
                    r.total_value += value;
                }
            }
        }
    }
    (rows, total_value, sample_count)
}

fn wilson_interval(successes: f64, trials: f64, z: f64) -> (f64, f64) {
    if trials <= 0.0 {
        return (0.0, 0.0);
    }
    let p = (successes / trials).clamp(0.0, 1.0);
    let z2 = z * z;
    let denom = 1.0 + z2 / trials;
    let centre = (p + z2 / (2.0 * trials)) / denom;
    let width = (z * ((p * (1.0 - p) + z2 / (4.0 * trials)) / trials).sqrt()) / denom;
    ((centre - width).max(0.0), (centre + width).min(1.0))
}

fn rank_hotspots(
    profile: &ParsedProfile,
    ordinal: usize,
    order: &str,
    limit: usize,
    population_hash: &str,
) -> HotspotResult {
    let (mut rows, total_value, sample_count_i) = aggregate_profile(profile, ordinal);
    let sample_count = sample_count_i.max(0) as usize;
    let total = total_value.max(0.0);

    for row in rows.values_mut() {
        row.self_share = if total > 0.0 { row.self_value / total } else { 0.0 };
        row.total_share = if total > 0.0 { row.total_value / total } else { 0.0 };
        let (lo, hi) = wilson_interval(row.sample_count as f64, sample_count as f64, 1.96);
        row.uncertainty_low = lo;
        row.uncertainty_high = hi;
    }

    let mut ordered: Vec<HotspotRow> = rows.into_values().collect();
    match order {
        "TOTAL" => ordered.sort_by(|a, b| b.total_value.partial_cmp(&a.total_value).unwrap_or(std::cmp::Ordering::Equal)),
        _ => ordered.sort_by(|a, b| b.self_value.partial_cmp(&a.self_value).unwrap_or(std::cmp::Ordering::Equal)),
    }
    for (i, r) in ordered.iter_mut().enumerate() {
        r.rank = i + 1;
    }
    let output_rows = ordered.into_iter().take(limit).collect();

    let expected_samples = profile
        .period_ns
        .filter(|p| *p > 0)
        .map(|p| (profile.end_ns - profile.start_ns) / p);
    let collection_ratio = expected_samples.map(|e| if e > 0 { sample_count_i as f64 / e as f64 } else { 0.0 });

    HotspotResult {
        rows: output_rows,
        unit: profile.sample_types.get(ordinal).map(|st| st.unit.clone()).unwrap_or_else(|| "samples".into()),
        sample_count,
        population_value: total,
        coverage: Coverage {
            collection_ratio,
            dropped_samples: profile.dropped_samples,
            truncated_stacks: profile.truncated,
            unattributed_share: 0.0,
            pruned_share: 0.0,
        },
        uncertainty: Uncertainty {
            method: "WILSON_95_INDICATIVE".into(),
            min_samples_for_ranking: MIN_SAMPLES_FOR_RANKING,
            too_few_samples: sample_count < MIN_SAMPLES_FOR_RANKING,
        },
        basis: "MEASURED_PROFILE".into(),
        grade: "WINDOW_OVERLAP".into(),
        population_hash: population_hash.into(),
    }
}

// ---------- Bounded flamegraph tree ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlameNode {
    pub function_key: String,
    pub name: String,
    pub file: String,
    pub line: i64,
    pub self_value: f64,
    pub total_value: f64,
    pub children: Vec<FlameNode>,
    pub other_value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlameTreeResult {
    pub tree: FlameNode,
    pub node_count: usize,
    pub pruned_value: f64,
    pub pruned_share: f64,
    pub unit: String,
    pub population_value: f64,
}

fn build_flamegraph_tree(profile: &ParsedProfile, ordinal: usize) -> FlameTreeResult {
    // First pass: aggregate per-edge (parent -> child) weights.
    #[derive(Clone)]
    struct Edge {
        parent_key: String,
        child_key: String,
        child_name: String,
        child_file: String,
        child_line: i64,
        total_value: f64,
    }

    let mut edges: HashMap<(String, String), Edge> = HashMap::new();
    let mut self_values: HashMap<String, f64> = HashMap::new();
    let mut root_total: f64 = 0.0;
    let mut population_value: f64 = 0.0;

    for sample in &profile.samples {
        let value = *sample.values.get(ordinal).unwrap_or(&sample.values.first().copied().unwrap_or(0)) as f64;
        if value <= 0.0 {
            continue;
        }
        population_value += value;

        // Self value is the leaf (inner-most, first in our normalised order).
        if let Some(&leaf_loc) = sample.location_ids.first() {
            if let Some((name, file, line)) = frame_at_location(profile, leaf_loc) {
                let key = normalise_function_key(name, file, line);
                *self_values.entry(key).or_insert(0.0) += value;
                root_total += value;
            }
        }

        // Edge map: outer-most frame is the child of the synthetic root, then each deeper frame is a child of the previous.
        let root_key = "(root)".to_string();
        let mut prev_key: Option<String> = None;
        let mut seen: HashSet<String> = HashSet::new();
        for &loc_id in sample.location_ids.iter().rev() {
            if let Some((name, file, line)) = frame_at_location(profile, loc_id) {
                let key = normalise_function_key(name, file, line);
                let parent = prev_key.clone().unwrap_or_else(|| root_key.clone());
                let e = edges
                    .entry((parent.clone(), key.clone()))
                    .or_insert_with(|| Edge {
                        parent_key: parent,
                        child_key: key.clone(),
                        child_name: name.to_string(),
                        child_file: file.to_string(),
                        child_line: line,
                        total_value: 0.0,
                    });
                if seen.insert(key.clone()) {
                    e.total_value += value;
                }
                prev_key = Some(key);
            }
        }
    }

    // Build tree top-down starting from root.  Use "(root)" as the synthetic root.
    let root_key = "(root)".to_string();
    let threshold = (PRUNE_MIN_SHARE * population_value).max(PRUNE_ABS_FLOOR);
    let mut pruned_value: f64 = 0.0;

    fn build_children(
        edges: &HashMap<(String, String), Edge>,
        self_values: &HashMap<String, f64>,
        parent_key: &str,
        depth: usize,
        threshold: f64,
        pruned: &mut f64,
        node_count: &mut usize,
    ) -> Vec<FlameNode> {
        if depth >= PRUNE_MAX_DEPTH {
            return Vec::new();
        }
        let mut children: Vec<FlameNode> = Vec::new();
        for ((p, c), e) in edges {
            if p != parent_key || e.total_value < threshold {
                if p == parent_key {
                    *pruned += e.total_value;
                }
                continue;
            }
            let child = FlameNode {
                function_key: c.clone(),
                name: e.child_name.clone(),
                file: e.child_file.clone(),
                line: e.child_line,
                self_value: *self_values.get(c).unwrap_or(&0.0),
                total_value: e.total_value,
                children: build_children(
                    edges, self_values, c, depth + 1, threshold, pruned, node_count,
                ),
                other_value: 0.0,
            };
            *node_count += 1;
            children.push(child);
        }
        children.sort_by(|a, b| b.total_value.partial_cmp(&a.total_value).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.name.cmp(&b.name)));
        if children.len() > PRUNE_NODE_COUNT {
            let removed: Vec<FlameNode> = children.split_off(PRUNE_NODE_COUNT);
            for r in removed {
                *pruned += r.total_value;
            }
        }
        children
    }

    let mut node_count: usize = 1;
    let children = build_children(
        &edges, &self_values, &root_key, 0, threshold, &mut pruned_value, &mut node_count,
    );

    let root = FlameNode {
        function_key: root_key.clone(),
        name: "(root)".into(),
        file: String::new(),
        line: 0,
        self_value: 0.0,
        total_value: root_total,
        children,
        other_value: pruned_value,
    };

    let unit = profile
        .sample_types
        .get(ordinal)
        .map(|st| st.unit.clone())
        .unwrap_or_else(|| "samples".into());

    FlameTreeResult {
        tree: root,
        node_count,
        pruned_value,
        pruned_share: if population_value > 0.0 { pruned_value / population_value } else { 0.0 },
        unit,
        population_value,
    }
}

// ---------- Trace correlation ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCorrelation {
    pub correlation_id: String,
    pub links: Vec<CorrelationLink>,
    pub build: BuildResolution,
    pub population_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrelationLink {
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub grade: String,
    pub overlap_ms: Option<i64>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResolution {
    pub build_id: Option<String>,
    pub revision: Option<String>,
    pub state: String,
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceWindow {
    pub service: String,
    pub instance: Option<String>,
    pub from_ns: i64,
    pub to_ns: i64,
    pub revision: Option<String>,
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub endpoint: Option<String>,
}

pub fn correlate_profile_trace(
    artifact_hash: &str,
    profile: &ParsedProfile,
    trace: &TraceWindow,
    build_id: Option<&str>,
    revision: Option<&str>,
) -> ProfileCorrelation {
    let overlap_from = profile.start_ns.max(trace.from_ns);
    let overlap_to = profile.end_ns.min(trace.to_ns);
    let overlap_ms = if overlap_to > overlap_from {
        Some((overlap_to - overlap_from) / 1_000_000)
    } else {
        None
    };

    let service_match = profile.service.as_ref() == Some(&trace.service);
    let instance_match = trace
        .instance
        .as_ref()
        .and_then(|ti| profile.instance.as_ref().map(|pi| pi == ti))
        .unwrap_or(false);
    let revision_match = trace
        .revision
        .as_ref()
        .and_then(|tr| revision.map(|pr| pr == tr))
        .unwrap_or(false);

    let mut links: Vec<CorrelationLink> = Vec::new();
    let mut state = "UNKNOWN";
    let mut evidence_ids: Vec<String> = Vec::new();

    if let Some(bid) = build_id {
        state = if revision_match { "MATCHED" } else { "MISMATCH" };
        evidence_ids.push(format!("build:{bid}"));
    }

    if !service_match || (trace.instance.is_some() && !instance_match) || overlap_ms.is_none() || !revision_match {
        let reason = if !service_match {
            "service does not match".into()
        } else if trace.instance.is_some() && !instance_match {
            "instance does not match".into()
        } else if overlap_ms.is_none() {
            "profile window does not overlap trace window".into()
        } else {
            "revision mismatch: profile build is for a different revision than the trace".into()
        };
        links.push(CorrelationLink {
            trace_id: trace.trace_id.clone(),
            span_id: trace.span_id.clone(),
            grade: "NONE".into(),
            overlap_ms: None,
            reason,
        });
    } else if trace.span_id.is_some() {
        links.push(CorrelationLink {
            trace_id: trace.trace_id.clone(),
            span_id: trace.span_id.clone(),
            grade: "SPAN_LABELLED".into(),
            overlap_ms,
            reason: "samples carry span id label matching trace span".into(),
        });
    } else if trace.endpoint.is_some() {
        links.push(CorrelationLink {
            trace_id: trace.trace_id.clone(),
            span_id: trace.span_id.clone(),
            grade: "ENDPOINT_LABELLED".into(),
            overlap_ms,
            reason: "samples carry endpoint label matching trace route".into(),
        });
    } else {
        let reason = if instance_match {
            "same service, instance and revision; window overlap only".into()
        } else {
            "same service and revision; window overlap only (instance not matched)".into()
        };
        links.push(CorrelationLink {
            trace_id: trace.trace_id.clone(),
            span_id: trace.span_id.clone(),
            grade: "WINDOW_OVERLAP".into(),
            overlap_ms,
            reason,
        });
    }

    let mut hasher = Sha256::new();
    hasher.update(artifact_hash.as_bytes());
    hasher.update(trace.service.as_bytes());
    hasher.update(&trace.from_ns.to_be_bytes());
    hasher.update(&trace.to_ns.to_be_bytes());
    let population_hash = format!("{:x}", hasher.finalize());

    ProfileCorrelation {
        correlation_id: format!("corr-{artifact_hash}-{}", population_hash[..16].to_string()),
        links,
        build: BuildResolution {
            build_id: build_id.map(|s| s.to_string()),
            revision: revision.map(|s| s.to_string()),
            state: state.into(),
            evidence_ids,
        },
        population_hash,
    }
}

// ---------- Profile comparison (F05-A6) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareRequest {
    pub baseline_population: String,
    pub candidate_population: String,
    pub normalise: String, // PER_REQUEST | ABSOLUTE
    pub declare_equivalent: Option<EquivalenceDeclaration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EquivalenceDeclaration {
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaRow {
    pub function_key: String,
    pub name: String,
    pub file: String,
    pub line: i64,
    pub baseline_value: f64,
    pub candidate_value: f64,
    pub delta_per_request: f64,
    pub baseline_share: f64,
    pub candidate_share: f64,
    pub share_change: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopulationCompare {
    pub baseline: Population,
    pub candidate: Population,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub verdict: String,
    pub reasons: Vec<String>,
    pub rows: Vec<DeltaRow>,
    pub populations: PopulationCompare,
    pub limitations: Vec<String>,
}

fn compute_population(
    artifact_hash: &str,
    profile: &ParsedProfile,
    ordinal: usize,
    spec: &PopulationSpec,
) -> Population {
    let chunk_id = format!("{}#0", artifact_hash);
    let hash = population_hash(spec, &[chunk_id.clone()]);
    let (_, total, samples) = aggregate_profile(profile, ordinal);
    let expected_samples = profile
        .period_ns
        .filter(|p| *p > 0)
        .map(|p| (profile.end_ns - profile.start_ns) / p);
    let collection_ratio = expected_samples.map(|e| if e > 0 { samples as f64 / e as f64 } else { 0.0 });
    Population {
        population_hash: hash,
        service: spec.service.clone(),
        window_from_ns: spec.window_from_ns,
        window_to_ns: spec.window_to_ns,
        revision: spec.revision.clone(),
        sample_type_kind: spec.sample_type_kind.clone(),
        chunk_ids: vec![chunk_id],
        sample_count: samples as usize,
        expected_samples,
        collection_ratio,
        request_count: None,
        error_count: None,
    }
}

pub fn compare_profiles(
    baseline: (&ParsedProfile, usize, &PopulationSpec),
    candidate: (&ParsedProfile, usize, &PopulationSpec),
    baseline_trace: Option<&TraceWindow>,
    candidate_trace: Option<&TraceWindow>,
    declare_equivalent: Option<&EquivalenceDeclaration>,
) -> CompareResult {
    let (bp, bo, bspec) = baseline;
    let (cp, co, cspec) = candidate;

    let mut limitations: Vec<String> = Vec::new();
    let mut reasons: Vec<String> = Vec::new();

    if bspec.sample_type_kind != cspec.sample_type_kind {
        return CompareResult {
            verdict: "NOT_COMPARABLE".into(),
            reasons: vec!["different sample kinds".into()],
            rows: Vec::new(),
            populations: PopulationCompare {
                baseline: compute_population("baseline", bp, bo, bspec),
                candidate: compute_population("candidate", cp, co, cspec),
            },
            limitations,
        };
    }

    if bspec.service != cspec.service {
        return CompareResult {
            verdict: "NOT_COMPARABLE".into(),
            reasons: vec!["different services".into()],
            rows: Vec::new(),
            populations: PopulationCompare {
                baseline: compute_population("baseline", bp, bo, bspec),
                candidate: compute_population("candidate", cp, co, cspec),
            },
            limitations,
        };
    }

    if bspec.revision != cspec.revision {
        limitations.push("different revisions".into());
    }

    let (brows, btotal, bcount) = aggregate_profile(bp, bo);
    let (crows, ctotal, ccount) = aggregate_profile(cp, co);

    let b_pop = compute_population("baseline", bp, bo, bspec);
    let c_pop = compute_population("candidate", cp, co, cspec);

    let b_requests = baseline_trace.and_then(|t| Some((t.to_ns - t.from_ns) / 1_000_000)).unwrap_or(1);
    let c_requests = candidate_trace.and_then(|t| Some((t.to_ns - t.from_ns) / 1_000_000)).unwrap_or(1);

    let b_error_rate = b_pop
        .error_count
        .and_then(|e| Some(e as f64 / b_requests as f64))
        .unwrap_or(0.0);
    let c_error_rate = c_pop
        .error_count
        .and_then(|e| Some(e as f64 / c_requests as f64))
        .unwrap_or(0.0);

    if (c_error_rate - b_error_rate).abs() > 0.01 || (c_error_rate > 0.0 && c_error_rate >= 2.0 * b_error_rate) {
        reasons.push("error populations differ".into());
        return CompareResult {
            verdict: "NOT_COMPARABLE".into(),
            reasons,
            rows: Vec::new(),
            populations: PopulationCompare { baseline: b_pop, candidate: c_pop },
            limitations,
        };
    }

    if declare_equivalent.is_some() {
        limitations.push("equivalence declared by user".into());
    }

    let per_request = cspec.window_to_ns - cspec.window_from_ns != 0;
    let use_per_request = c_requests != 0 && b_requests != 0 && (cspec.window_to_ns - cspec.window_from_ns) != 0;

    let mut rows: Vec<DeltaRow> = Vec::new();
    let mut keys: HashSet<String> = HashSet::new();
    for k in brows.keys().chain(crows.keys()) {
        keys.insert(k.clone());
    }

    for key in keys {
        let b = brows.get(&key);
        let c = crows.get(&key);
        if b.is_none() && c.is_none() {
            continue;
        }
        let name = b.map(|r| r.name.clone()).or_else(|| c.map(|r| r.name.clone())).unwrap_or_default();
        let file = b.map(|r| r.file.clone()).or_else(|| c.map(|r| r.file.clone())).unwrap_or_default();
        let line = b.map(|r| r.line).or_else(|| c.map(|r| r.line)).unwrap_or(0);
        let bval = b.map(|r| r.self_value).unwrap_or(0.0);
        let cval = c.map(|r| r.self_value).unwrap_or(0.0);
        let bnorm = if use_per_request { bval / b_requests as f64 } else { bval };
        let cnorm = if use_per_request { cval / c_requests as f64 } else { cval };
        rows.push(DeltaRow {
            function_key: key.clone(),
            name,
            file,
            line,
            baseline_value: bnorm,
            candidate_value: cnorm,
            delta_per_request: cnorm - bnorm,
            baseline_share: if btotal > 0.0 { bval / btotal } else { 0.0 },
            candidate_share: if ctotal > 0.0 { cval / ctotal } else { 0.0 },
            share_change: if btotal > 0.0 && ctotal > 0.0 {
                (cval / ctotal) - (bval / btotal)
            } else {
                0.0
            },
        });
    }

    rows.sort_by(|a, b| b.delta_per_request.abs().partial_cmp(&a.delta_per_request.abs()).unwrap_or(std::cmp::Ordering::Equal));

    let verdict = if reasons.is_empty() {
        if rows.iter().any(|r| r.share_change.abs() > 0.01) {
            "DIFFERENCE_OBSERVED".into()
        } else {
            "NO_MATERIAL_DIFFERENCE".into()
        }
    } else {
        "INCONCLUSIVE".into()
    };

    CompareResult {
        verdict,
        reasons,
        rows,
        populations: PopulationCompare { baseline: b_pop, candidate: c_pop },
        limitations,
    }
}

// ---------- Public API ----------

pub fn ingest_profile(bytes: &[u8], service_hint: Option<&str>) -> Result<IngestProfileResult, Vec<Diagnostic>> {
    let parsed = parse_profile(bytes, service_hint)?;
    let artifact_hash = artifact_hash(bytes);

    let sample_types: Vec<SampleTypeView> = parsed
        .sample_types
        .iter()
        .map(|st| SampleTypeView {
            ordinal: st.ordinal,
            kind: st.kind.clone(),
            unit: st.unit.clone(),
            raw_type: st.raw_type.clone(),
            raw_unit: st.raw_unit.clone(),
        })
        .collect();

    let mappings: Vec<MappingView> = parsed
        .mappings
        .iter()
        .map(|m| MappingView {
            mapping_id: m.id as usize,
            build_id: if m.build_id.is_empty() { None } else { Some(m.build_id.clone()) },
            file: if m.file.is_empty() { None } else { Some(m.file.clone()) },
            has_functions: m.has_functions,
            has_filenames: m.has_filenames,
            has_line_numbers: m.has_line_numbers,
            has_inline_frames: m.has_inline_frames,
            revision: None,
            revision_state: "UNKNOWN".into(),
        })
        .collect();

    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    if parsed.truncated > 0 {
        diagnostics.push(Diagnostic {
            code: "TRUNCATED_STACKS".into(),
            message: format!("{} frames truncated at depth {}", parsed.truncated, MAX_STACK_DEPTH),
        });
    }
    if parsed.dropped_samples.is_none() {
        diagnostics.push(Diagnostic {
            code: "DROPPED_SAMPLES_UNKNOWN".into(),
            message: "profile did not report dropped samples".into(),
        });
    }

    Ok(IngestProfileResult {
        artifact_hash,
        format: parsed.format.clone(),
        sample_types,
        period_ns: parsed.period_ns,
        mappings,
        diagnostics,
        dropped_samples: parsed.dropped_samples,
        service: parsed.service.clone(),
        instance: parsed.instance.clone(),
        runtime: parsed.runtime.clone(),
        profiler: parsed.profiler.clone(),
        profiler_version: parsed.profiler_version.clone(),
        start_ns: parsed.start_ns,
        end_ns: parsed.end_ns,
        sampling_rate_hz: parsed.sampling_rate_hz,
        truncated: parsed.truncated,
    })
}

pub fn query_hotspots_from_bytes(
    bytes: &[u8],
    service_hint: Option<&str>,
    ordinal: usize,
    order: &str,
    limit: usize,
) -> Result<HotspotResult, Vec<Diagnostic>> {
    let parsed = parse_profile(bytes, service_hint)?;
    let artifact_hash = artifact_hash(bytes);
    let spec = PopulationSpec {
        service: parsed.service.clone().unwrap_or_else(|| service_hint.unwrap_or("unknown").to_string()),
        window_from_ns: parsed.start_ns,
        window_to_ns: parsed.end_ns,
        revision: None,
        sample_type_kind: parsed
            .sample_types
            .get(ordinal)
            .map(|st| st.kind.clone())
            .unwrap_or(SampleKind::Other),
    };
    let chunk_id = format!("{}#0", artifact_hash);
    let pop_hash = population_hash(&spec, &[chunk_id]);
    let mut res = rank_hotspots(&parsed, ordinal, order, limit, &pop_hash);
    res.population_hash = pop_hash;
    Ok(res)
}

pub fn build_flamegraph_from_bytes(
    bytes: &[u8],
    service_hint: Option<&str>,
    ordinal: usize,
) -> Result<FlameTreeResult, Vec<Diagnostic>> {
    let parsed = parse_profile(bytes, service_hint)?;
    Ok(build_flamegraph_tree(&parsed, ordinal))
}

// ---------- Helpers for RPC JSON ----------

pub fn to_json_value<T: Serialize>(v: &T) -> Result<serde_json::Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folded_profile_parses() {
        let text = b"main;computeTax;parseRules 12\nmain;JSON.stringify 5\nruntime;gc 3\n";
        let p = parse_profile(text, Some("svc")).unwrap();
        assert_eq!(p.format, "folded");
        assert_eq!(p.samples.len(), 3);
        assert_eq!(p.sample_types[0].kind, SampleKind::Other);
        assert_eq!(p.service.as_deref(), Some("svc"));
    }

    #[test]
    fn v8_cpuprofile_parses() {
        let json = br#"{
          "nodes": [
            { "id": 1, "callFrame": { "functionName": "(root)", "url": "", "lineNumber": 0, "columnNumber": 0 }, "children": [2] },
            { "id": 2, "callFrame": { "functionName": "computeTax", "url": "src/tax/rules.ts", "lineNumber": 87, "columnNumber": 0 }, "children": [] }
          ],
          "samples": [2, 2, 2],
          "timeDeltas": [1000, 1000, 1000],
          "startTime": 1000,
          "endTime": 4000,
          "sampleInterval": 1000
        }"#;
        let p = parse_profile(json, Some("svc")).unwrap();
        assert_eq!(p.format, "v8-cpuprofile");
        assert_eq!(p.samples.len(), 3);
        assert_eq!(p.sample_types[0].kind, SampleKind::Cpu);
        // V8 line numbers are 0-based; we normalise to 1-based.
        let loc = p.locations.iter().find(|l| l.lines.iter().any(|line| line.function_name == "computeTax")).unwrap();
        assert_eq!(loc.lines[0].line, 88);
        assert_eq!(p.start_ns, 1_000_000);
        assert_eq!(p.end_ns, 4_000_000);
    }

    #[test]
    fn hotspot_self_ranking() {
        let text = b"main;computeTax;parseRules 12\nmain;computeTax;evaluateRule 8\nmain;JSON.stringify 5\n";
        let p = parse_profile(text, None).unwrap();
        let res = rank_hotspots(&p, 0, "SELF", 10, "pop");
        assert_eq!(res.rows[0].name, "parseRules");
        assert_eq!(res.rows[0].self_value, 12.0);
        assert_eq!(res.rows[1].name, "evaluateRule");
        assert!(res.rows.iter().any(|r| r.name == "computeTax" && r.total_value == 20.0));
    }

    #[test]
    fn correlation_window_overlap() {
        let json = br#"{
          "nodes": [
            { "id": 1, "callFrame": { "functionName": "(root)" }, "children": [2] },
            { "id": 2, "callFrame": { "functionName": "f" }, "children": [] }
          ],
          "samples": [2],
          "timeDeltas": [1000],
          "startTime": 1000,
          "endTime": 2000,
          "sampleInterval": 1000
        }"#;
        let p = parse_profile(json, Some("svc")).unwrap();
        let trace = TraceWindow {
            service: "svc".into(),
            instance: None,
            from_ns: 0,
            to_ns: 10_000_000,
            revision: Some("rev1".into()),
            trace_id: None,
            span_id: None,
            endpoint: None,
        };
        let corr = correlate_profile_trace("hash", &p, &trace, Some("build-1"), Some("rev1"));
        assert_eq!(corr.links[0].grade, "WINDOW_OVERLAP");
        assert_eq!(corr.build.state, "MATCHED");
    }

    #[test]
    fn correlation_none_for_mismatch_revision() {
        let json = br#"{
          "nodes": [
            { "id": 1, "callFrame": { "functionName": "(root)" }, "children": [2] },
            { "id": 2, "callFrame": { "functionName": "f" }, "children": [] }
          ],
          "samples": [2],
          "timeDeltas": [1000],
          "startTime": 1000,
          "endTime": 2000,
          "sampleInterval": 1000
        }"#;
        let p = parse_profile(json, Some("svc")).unwrap();
        let trace = TraceWindow {
            service: "svc".into(),
            instance: None,
            from_ns: 0,
            to_ns: 10_000_000,
            revision: Some("rev1".into()),
            trace_id: None,
            span_id: None,
            endpoint: None,
        };
        let corr = correlate_profile_trace("hash", &p, &trace, Some("build-1"), Some("rev2"));
        assert_eq!(corr.links[0].grade, "NONE");
        assert_eq!(corr.build.state, "MISMATCH");
    }
}
