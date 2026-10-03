//! Adapter for Nirdosha's stable `nirdosha.source-ir/1` JSON boundary.
//! The inspector is invoked once per repository, never once per file.
use crate::language::{RawDeclaration, RawDeclarationReference, RawFile, RawSymbol};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceIr {
    schema_version: String,
    dialect: String,
    documents: Vec<Document>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    source: String,
    content_hash: String,
    declarations: Vec<Declaration>,
    diagnostics: Vec<Diagnostic>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic {
    code: String,
    message: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Declaration {
    kind: String,
    name: String,
    macro_name: Option<String>,
    span: Span,
    properties: BTreeMap<String, Value>,
    references: Vec<Reference>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    kind: String,
    target: String,
    property: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Span {
    start_byte: usize,
    end_byte_exclusive: usize,
}

pub struct SourceIrBundle {
    docs: HashMap<String, Document>,
    pub diagnostics: Vec<(String, String, String)>,
}

impl SourceIrBundle {
    pub fn merge(&mut self, rel: &str, content_hash: &str, raw: &mut RawFile) {
        let Some(doc) = self.docs.remove(rel) else {
            return;
        };
        if doc.content_hash != content_hash {
            self.diagnostics.push((
                rel.into(),
                "NIRDOSHA_SOURCE_IR_STALE".into(),
                "source IR content hash does not match indexed bytes".into(),
            ));
            return;
        }
        for d in doc
            .declarations
            .into_iter()
            .filter(|d| d.macro_name.is_some())
        {
            let symbol_index = raw
                .symbols
                .iter()
                .position(|s| s.qualified == d.name)
                .unwrap_or_else(|| {
                    let kind: &'static str = match d.kind.as_str() {
                        "screen" => "screen",
                        "policy" => "policy",
                        "workflow" => "workflow",
                        "approval_chain" => "approval_chain",
                        "roles" => "roles",
                        "purpose_taxonomy" => "purpose_taxonomy",
                        "stream_port" => "stream_port",
                        "model_artifact" => "model_artifact",
                        "data_contract" => "data_contract",
                        _ => "nirdosha_declaration",
                    };
                    raw.symbols.push(RawSymbol {
                        kind,
                        qualified: d.name.clone(),
                        start: d.span.start_byte,
                        end: d.span.end_byte_exclusive,
                        exported: true,
                    });
                    raw.symbols.len() - 1
                });
            raw.declarations.push(RawDeclaration {
                kind: d.kind,
                name: d.name,
                macro_name: d.macro_name,
                properties: Value::Object(d.properties.into_iter().collect()),
                references: d
                    .references
                    .into_iter()
                    .map(|r| RawDeclarationReference {
                        kind: r.kind,
                        target: r.target,
                        property: r.property,
                    })
                    .collect(),
                symbol_index,
                start: d.span.start_byte,
                end: d.span.end_byte_exclusive,
            });
        }
        for d in doc.diagnostics {
            self.diagnostics.push((rel.into(), d.code, d.message));
        }
    }
}

pub fn inspect(root: &Path) -> Result<Option<SourceIrBundle>, String> {
    let Some(exe) = inspector_path() else {
        return Ok(None);
    };
    let output = Command::new(&exe)
        .arg(root)
        .output()
        .map_err(|e| format!("launching {}: {e}", exe.display()))?;
    if !output.status.success() {
        return Err(format!(
            "{} failed: {}",
            exe.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let ir: SourceIr = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("invalid source IR JSON: {e}"))?;
    if ir.schema_version != "nirdosha.source-ir/1" {
        return Err(format!(
            "unsupported source IR schema {}",
            ir.schema_version
        ));
    }
    if ir.dialect != "nirdosha-rust-v2" {
        return Err(format!("unsupported source IR dialect {}", ir.dialect));
    }
    Ok(Some(SourceIrBundle {
        docs: ir
            .documents
            .into_iter()
            .map(|d| (d.source.clone(), d))
            .collect(),
        diagnostics: vec![],
    }))
}

fn inspector_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CIE_NIRDOSHA_SOURCE_IR") {
        return Some(PathBuf::from(p));
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|p| p.join("nirdosha-source-ir"))
        .find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merges_versioned_ir_into_raw_file() {
        let json = r#"{"schemaVersion":"nirdosha.source-ir/1","dialect":"nirdosha-rust-v2","documents":[{"source":"src/a.nir","contentHash":"h","declarations":[{"id":"screen:mount_a","kind":"screen","name":"mount_a","macroName":"crud_screens","span":{"startByte":1,"endByteExclusive":20,"startLine":1,"startColumn":0,"endLine":1,"endColumn":19},"properties":{"mount":"mount_a"},"references":[{"kind":"role","target":"Analyst","property":"create"}]}],"diagnostics":[]}]}"#;
        let ir: SourceIr = serde_json::from_str(json).unwrap();
        let mut b = SourceIrBundle {
            docs: ir
                .documents
                .into_iter()
                .map(|d| (d.source.clone(), d))
                .collect(),
            diagnostics: vec![],
        };
        let mut raw = RawFile::default();
        b.merge("src/a.nir", "h", &mut raw);
        assert_eq!(raw.symbols[0].qualified, "mount_a");
        assert_eq!(raw.declarations[0].references[0].target, "Analyst");
    }
}
