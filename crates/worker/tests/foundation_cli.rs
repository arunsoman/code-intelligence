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

#[test]
fn semantic_analysis_cli_exposes_graphs_slices_inputs_and_explicit_gaps() {
    let path = std::env::temp_dir().join(format!("cie-analysis-cli-{}.json", std::process::id()));
    std::fs::write(&path, json!({"path":"a.ts","source":"function value(x:boolean):number {if(x){return 1;}return 2;}","revision":"r1","environmentDigest":"env1"}).to_string()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_worker"))
        .arg("semanticAnalyze")
        .arg(&path)
        .output()
        .unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["analysis"]["schema"], "cie.source-analysis.v1");
    let function = result["analysis"]["functions"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap();
    assert!(function["graph"]["edges"].as_array().unwrap().len() > 3);
    assert_eq!(function["returns"].as_array().unwrap().len(), 2);
    assert!(function["summary"]["must_effects"].is_null());
    assert!(!function["summary"]["gaps"].as_array().unwrap().is_empty());
}

#[test]
fn semantic_check_cli_reports_concrete_contract_violation_and_rejects_stale_registry() {
    let worker = env!("CARGO_BIN_EXE_worker");
    let dir = std::env::temp_dir().join(format!("cie-check-cli-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let request = dir.join("source.json");
    let registry = dir.join("contracts.json");
    let source = "function authorize(allowed:boolean):boolean{return true;}";
    std::fs::write(
        &request,
        json!({"path":"a.ts","source":source,"revision":"r1","environmentDigest":"env1"})
            .to_string(),
    )
    .unwrap();
    let mut contracts = json!({"schema":"cie.behavior-contracts.v1","revision":"r1","environmentDigest":"env1","models":[],"contracts":[{"id":"auth","key":"auth","label":"Authorize only permitted requests","function":"a.ts@0:function_declaration","provenance":{"authority":"approvedSpecification","reference":"spec:auth","version":"1"},"supersedes":[],"domains":[[{"kind":"bool","value":false},{"kind":"bool","value":true}]],"precondition":null,"obligations":[{"kind":"ensures","predicate":{"kind":"equal","left":{"kind":"return"},"right":{"kind":"argument","index":0}}}]}]});
    std::fs::write(&registry, contracts.to_string()).unwrap();
    let output = Command::new(worker)
        .arg("semanticCheck")
        .arg(&request)
        .arg(&registry)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["findings"][0]["conclusion"], "violatedWithinModel");
    assert_eq!(
        result["findings"][0]["counterexamples"][0]["arguments"][0]["value"],
        false
    );
    assert_eq!(
        result["findings"][0]["contract"]["provenance"]["authority"],
        "approvedSpecification"
    );
    contracts["revision"] = json!("stale");
    std::fs::write(&registry, contracts.to_string()).unwrap();
    let output = Command::new(worker)
        .arg("semanticCheck")
        .arg(&request)
        .arg(&registry)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["error"]["code"], "INVALID_BEHAVIOR_INPUT");
    std::fs::remove_dir_all(dir).unwrap();
}
