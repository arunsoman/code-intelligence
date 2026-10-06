//! Framework configuration metadata extractor.
//!
//! Detects:
//!   - `package.json`: scripts, dependencies, devDependencies
//!   - `tsconfig.json`: compiler options, include/exclude paths
//!   - `.env`, `.env.local`, `.env.*`: key/value pairs
//!   - `nest-cli.json`: NestJS CLI project metadata
//!   - `application*.yml` / `application*.properties`: Spring profiles and properties
//!
//! Emits `config_value` metadata rows. The indexer turns these into `config_value` facts.
use crate::frameworks::{FrameworkContext, FrameworkEntityKind, FrameworkExtension, RawFrameworkMetadata};
use crate::language::RawFile;
use serde_json::json;
use std::collections::HashMap;

pub struct ConfigExtension;

impl FrameworkExtension for ConfigExtension {
    fn framework(&self) -> &'static str { "config" }

    fn matches(&self, rel: &str) -> bool {
        rel.ends_with("package.json")
            || rel.ends_with("tsconfig.json")
            || rel.ends_with("nest-cli.json")
            || rel.ends_with(".env")
            || rel.contains(".env.")
            || rel.starts_with("application")
            || rel.contains("/application")
            || rel.ends_with("pom.xml")
    }

    fn extract(&self, ctx: FrameworkContext, raw: &mut RawFile) {
        let rel = ctx.rel;
        let src = ctx.src;
        let span = (0, src.len());

        if rel.ends_with("package.json") {
            parse_package_json(rel, src, raw, span);
        } else if rel.ends_with("tsconfig.json") {
            parse_tsconfig_json(rel, src, raw, span);
        } else if rel.ends_with("nest-cli.json") {
            parse_nest_cli_json(rel, src, raw, span);
        } else if rel.ends_with(".env") || rel.contains(".env.") {
            parse_dotenv(rel, src, raw, span);
        } else if rel.ends_with(".yml") || rel.ends_with(".yaml") {
            parse_spring_yml(rel, src, raw, span);
        } else if rel.ends_with(".properties") {
            parse_spring_properties(rel, src, raw, span);
        } else if rel.ends_with("pom.xml") {
            parse_pom_xml(rel, src, raw, span);
        }
    }
}

fn push(raw: &mut RawFile, name: String, key: String, value: serde_json::Value, source: &str, start: usize, end: usize) {
    raw.framework_metadata.push(RawFrameworkMetadata {
        framework: "config",
        kind: FrameworkEntityKind::ConfigValue,
        name,
        subject_symbol: None,
        start,
        end,
        properties: json!({"key": key, "value": value, "source": source}),
        parent: None,
    });
}

fn parse_package_json(rel: &str, src: &str, raw: &mut RawFile, span: (usize, usize)) {
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(src) else { return };
    if let Some(scripts) = pkg.get("scripts").and_then(|v| v.as_object()) {
        for (k, v) in scripts {
            if let Some(val) = v.as_str() {
                push(raw, format!("script:{}", k), format!("package.json:scripts:{}", k), json!(val), "package.json", span.0, span.1);
            }
        }
    }
    for dep_key in ["dependencies", "devDependencies", "peerDependencies"] {
        if let Some(deps) = pkg.get(dep_key).and_then(|v| v.as_object()) {
            for (k, v) in deps {
                let val = v.as_str().map(String::from).unwrap_or_else(|| v.to_string());
                push(raw, format!("dep:{}", k), format!("package.json:{}:{}", dep_key, k), json!(val), "package.json", span.0, span.1);
            }
        }
    }
    if let Some(name) = pkg.get("name").and_then(|v| v.as_str()) {
        push(raw, "package_name".into(), "package.json:name".into(), json!(name), "package.json", span.0, span.1);
    }
    if let Some(version) = pkg.get("version").and_then(|v| v.as_str()) {
        push(raw, "package_version".into(), "package.json:version".into(), json!(version), "package.json", span.0, span.1);
    }
}

fn parse_tsconfig_json(rel: &str, src: &str, raw: &mut RawFile, span: (usize, usize)) {
    let Ok(ts) = serde_json::from_str::<serde_json::Value>(src) else { return };
    if let Some(opts) = ts.get("compilerOptions").and_then(|v| v.as_object()) {
        for (k, v) in opts {
            push(raw, format!("tsconfig:{}", k), format!("tsconfig.json:compilerOptions:{}", k), v.clone(), "tsconfig.json", span.0, span.1);
        }
    }
    for arr_key in ["include", "exclude"] {
        if let Some(arr) = ts.get(arr_key).and_then(|v| v.as_array()) {
            let vals: Vec<String> = arr.iter().filter_map(|x| x.as_str().map(String::from)).collect();
            push(raw, format!("tsconfig:{}", arr_key), format!("tsconfig.json:{}", arr_key), json!(vals), "tsconfig.json", span.0, span.1);
        }
    }
}

fn parse_nest_cli_json(rel: &str, src: &str, raw: &mut RawFile, span: (usize, usize)) {
    let Ok(cfg) = serde_json::from_str::<serde_json::Value>(src) else { return };
    if let Some(proj) = cfg.get("collection").and_then(|v| v.as_str()) {
        push(raw, "nest_cli:collection".into(), "nest-cli.json:collection".into(), json!(proj), "nest-cli.json", span.0, span.1);
    }
    if let Some(src_root) = cfg.get("sourceRoot").and_then(|v| v.as_str()) {
        push(raw, "nest_cli:sourceRoot".into(), "nest-cli.json:sourceRoot".into(), json!(src_root), "nest-cli.json", span.0, span.1);
    }
    if let Some(proj) = cfg.get("projects").and_then(|v| v.as_object()) {
        for (k, v) in proj {
            push(raw, format!("nest_cli:project:{}", k), format!("nest-cli.json:projects:{}", k), v.clone(), "nest-cli.json", span.0, span.1);
        }
    }
}

fn parse_dotenv(rel: &str, src: &str, raw: &mut RawFile, span: (usize, usize)) {
    let file = std::path::Path::new(rel).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| ".env".to_string());
    for (line_idx, line) in src.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let Some((k, v)) = line.split_once('=') else { continue };
        let k = k.trim().to_string();
        let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
        let start = src.find(&k).unwrap_or(span.0);
        let end = start + k.len() + 1 + v.len();
        push(raw, format!("env:{}:{}", file, k), k.clone(), json!(v), &file, start, end.min(span.1));
    }
}

fn parse_spring_yml(rel: &str, src: &str, raw: &mut RawFile, span: (usize, usize)) {
    let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(src) else { return };
    let mut flat: HashMap<String, serde_json::Value> = HashMap::new();
    flatten_yaml("", &yaml, &mut flat);
    for (k, v) in flat {
        push(raw, format!("spring:{}", k), k.clone(), v, "application.yml", span.0, span.1);
    }
}

fn flatten_yaml(prefix: &str, value: &serde_yaml::Value, out: &mut HashMap<String, serde_json::Value>) {
    match value {
        serde_yaml::Value::Mapping(m) => {
            for (k, v) in m {
                let key = k.as_str().unwrap_or("");
                let new_prefix = if prefix.is_empty() { key.to_string() } else { format!("{}.{}", prefix, key) };
                flatten_yaml(&new_prefix, v, out);
            }
        }
        serde_yaml::Value::Sequence(seq) => {
            let arr: Vec<serde_json::Value> = seq.iter().map(|v| serde_json::to_value(v).unwrap_or(serde_json::Value::Null)).collect();
            out.insert(prefix.to_string(), json!(arr));
        }
        _ => {
            out.insert(prefix.to_string(), serde_json::to_value(value).unwrap_or(serde_json::Value::Null));
        }
    }
}

fn parse_spring_properties(rel: &str, src: &str, raw: &mut RawFile, span: (usize, usize)) {
    for line in src.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let Some((k, v)) = line.split_once('=') else { continue };
        let k = k.trim().to_string();
        let v = v.trim().to_string();
        let start = src.find(&k).unwrap_or(span.0);
        let end = start + k.len() + 1 + v.len();
        push(raw, format!("spring:{}", k), k.clone(), json!(v), "application.properties", start, end.min(span.1));
    }
}

fn parse_pom_xml(rel: &str, src: &str, raw: &mut RawFile, span: (usize, usize)) {
    // Minimal Maven POM extraction: properties and key coordinates.
    let artifact_id = xml_text(src, "artifactId");
    let group_id = xml_text(src, "groupId");
    let version = xml_text(src, "version");
    let java_version = xml_text(src, "java.version");
    let spring_version = xml_text(src, "spring-boot.version");
    if let Some(v) = artifact_id { push(raw, "maven:artifactId".into(), "pom.xml:artifactId".into(), json!(v), "pom.xml", span.0, span.1); }
    if let Some(v) = group_id { push(raw, "maven:groupId".into(), "pom.xml:groupId".into(), json!(v), "pom.xml", span.0, span.1); }
    if let Some(v) = version { push(raw, "maven:version".into(), "pom.xml:version".into(), json!(v), "pom.xml", span.0, span.1); }
    if let Some(v) = java_version { push(raw, "maven:java.version".into(), "pom.xml:java.version".into(), json!(v), "pom.xml", span.0, span.1); }
    if let Some(v) = spring_version { push(raw, "maven:spring-boot.version".into(), "pom.xml:spring-boot.version".into(), json!(v), "pom.xml", span.0, span.1); }
}

fn xml_text(src: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let start = src.find(&open)?;
    let end = src.find(&close)?;
    if end <= start { return None; }
    Some(src[start + open.len()..end].trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract(rel: &str, src: &str) -> Vec<RawFrameworkMetadata> {
        let mut raw = crate::language::RawFile::default();
        let ext = ConfigExtension;
        let ctx = FrameworkContext { rel, src, project_root: std::path::Path::new(".") };
        ext.extract(ctx, &mut raw);
        raw.framework_metadata
    }

    #[test]
    fn extracts_package_json() {
        let src = r#"{"name":"demo","version":"1.0.0","scripts":{"start":"node dist/main.js"},"dependencies":{"express":"^4.18.0"}}"#;
        let m = extract("package.json", src);
        assert!(m.iter().any(|x| x.name == "script:start" && x.properties["value"] == "node dist/main.js"));
        assert!(m.iter().any(|x| x.name == "dep:express" && x.properties["value"] == "^4.18.0"));
        assert!(m.iter().any(|x| x.name == "package_name"));
    }

    #[test]
    fn extracts_tsconfig() {
        let src = r#"{"compilerOptions":{"strict":true,"target":"es2021"},"include":["src"]}"#;
        let m = extract("tsconfig.json", src);
        assert!(m.iter().any(|x| x.name == "tsconfig:strict" && x.properties["value"] == true));
        assert!(m.iter().any(|x| x.name == "tsconfig:include"));
    }

    #[test]
    fn extracts_dotenv() {
        let src = "DATABASE_URL=postgres://localhost\n# comment\nAUTH_TOKEN=secret\n";
        let m = extract(".env", src);
        assert!(m.iter().any(|x| x.properties["key"] == "DATABASE_URL" && x.properties["value"] == "postgres://localhost"));
        assert!(m.iter().any(|x| x.properties["key"] == "AUTH_TOKEN"));
    }

    #[test]
    fn extracts_application_yml() {
        let src = "\nspring:\n  profiles:\n    active: dev\n  application:\n    name: demo\n";
        let m = extract("application.yml", src);
        assert!(m.iter().any(|x| x.properties["key"] == "spring.profiles.active" && x.properties["value"] == "dev"));
        assert!(m.iter().any(|x| x.properties["key"] == "spring.application.name"));
    }

    #[test]
    fn extracts_application_properties() {
        let src = "spring.profiles.active=prod\nserver.port=8080\n";
        let m = extract("application.properties", src);
        assert!(m.iter().any(|x| x.properties["key"] == "spring.profiles.active" && x.properties["value"] == "prod"));
        assert!(m.iter().any(|x| x.properties["key"] == "server.port"));
    }

    #[test]
    fn extracts_pom_xml() {
        let src = r#"<project><groupId>com.example</groupId><artifactId>demo</artifactId><version>1.0</version><properties><java.version>17</java.version></properties></project>"#;
        let m = extract("pom.xml", src);
        assert!(m.iter().any(|x| x.name == "maven:artifactId" && x.properties["value"] == "demo"));
        assert!(m.iter().any(|x| x.name == "maven:java.version" && x.properties["value"] == "17"));
    }
}
