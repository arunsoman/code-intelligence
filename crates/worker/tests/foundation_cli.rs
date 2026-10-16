use serde_json::{json, Value};
use std::process::Command;

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
