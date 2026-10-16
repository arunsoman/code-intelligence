use serde_json::{json, Value};
use std::process::Command;

#[test]
fn default_language_registry_and_real_source_lowering_are_exposed() {
    let worker = env!("CARGO_BIN_EXE_worker");
    let output = Command::new(worker)
        .arg("semanticLanguages")
        .output()
        .unwrap();
    assert!(output.status.success());
    let languages: Value = serde_json::from_slice(&output.stdout).unwrap();
    for id in ["java", "typescript", "javascript"] {
        assert!(languages.as_array().unwrap().iter().any(|m| m["id"] == id));
    }
    let path = std::env::temp_dir().join(format!("cie-semantic-cli-{}.json", std::process::id()));
    let request = json!({"path":"a.ts","source":"function value(): number { return 7; }","revision":"r1","environmentDigest":"env1"});
    std::fs::write(&path, request.to_string()).unwrap();
    let output = Command::new(worker)
        .arg("semanticLower")
        .arg(&path)
        .output()
        .unwrap();
    std::fs::remove_file(&path).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result["snapshot"]["schema"],
        analysis_foundation::semantic_ir::SCHEMA
    );
    assert_eq!(
        result["snapshot"]["functions"].as_object().unwrap().len(),
        1
    );
}

#[test]
fn foundation_cli_reports_only_represented_effects_and_rejects_bad_schema() {
    let path = std::env::temp_dir().join(format!("cie-foundation-cli-{}.json", std::process::id()));
    let source =
        json!({"file":"fixture.py","contentDigest":"fixture-v1","startByte":0,"endByte":50});
    let snapshot = json!({
        "schema":analysis_foundation::SCHEMA,"revision":"r1","semantics":"test-v1","environmentDigest":"env1",
        "functions":[{"id":"authorize","source":source,"gaps":[],"operations":[
            {"id":"authorize/0","source":source,"action":{"kind":"emit","resource":"stdout"}}
        ]}]
    });
    std::fs::write(&path, snapshot.to_string()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_worker"))
        .arg("analysisFoundation")
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result["summaries"]["authorize"]["effects"],
        json!([{"kind":"emit","resource":"stdout"}])
    );
    assert_eq!(
        result["summaries"]["authorize"]["completion"],
        "completeWithinModel"
    );
    std::fs::write(&path, "{}").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_worker"))
        .arg("analysisFoundation")
        .arg(&path)
        .output()
        .unwrap();
    std::fs::remove_file(&path).unwrap();
    assert!(!output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["error"]["code"], "INVALID_FOUNDATION_INPUT");
}
