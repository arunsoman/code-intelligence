use analysis_foundation::{languages::*, semantic_ir::*};

fn request(path: &str, source: &str) -> Request {
    Request {
        path: path.into(),
        source: source.into(),
        revision: "r1".into(),
        environment_digest: "env1".into(),
    }
}
fn lower(path: &str, source: &str) -> Lowered {
    Registry::builtins()
        .unwrap()
        .lower(&request(path, source))
        .unwrap()
}
fn constant(result: &Lowered) -> Option<&Literal> {
    result
        .snapshot
        .functions
        .values()
        .flat_map(|f| f.blocks.values())
        .flat_map(|b| &b.instructions)
        .find_map(|i| match &i.action {
            Action::Constant { literal, .. } => Some(literal),
            _ => None,
        })
}

#[test]
fn defaults_include_all_three_languages_and_extensions() {
    let registry = Registry::builtins().unwrap();
    let meta = registry.metadata();
    for id in ["java", "typescript", "javascript"] {
        assert!(meta.iter().any(|m| m.id == id));
    }
    for (path, source, language) in [
        ("A.java", "class A { int value() { return 7; } }", "java"),
        (
            "a.ts",
            "function value(): number { return 7; }",
            "typescript",
        ),
        (
            "a.mts",
            "function value(): number { return 7; }",
            "typescript",
        ),
        (
            "a.cts",
            "function value(): number { return 7; }",
            "typescript",
        ),
        (
            "a.tsx",
            "const element = <A/>; function value(): number { return 7; }",
            "typescript",
        ),
        ("a.js", "function value() { return 7; }", "javascript"),
        ("a.mjs", "function value() { return 7; }", "javascript"),
        ("a.cjs", "function value() { return 7; }", "javascript"),
        (
            "a.jsx",
            "const element = <A/>; function value() { return 7; }",
            "javascript",
        ),
    ] {
        let result = registry.lower(&request(path, source)).unwrap();
        assert_eq!(
            result.snapshot.documents.values().next().unwrap().language,
            language
        );
        assert!(constant(&result).is_some(), "{path}");
    }
}

#[test]
fn integer_and_number_semantics_are_not_conflated() {
    let java = lower(
        "A.java",
        "class A { long value() { return 9007199254740993L; } }",
    );
    assert_eq!(
        constant(&java),
        Some(&Literal::Integer {
            decimal: "9007199254740993".into()
        })
    );
    let js = lower("a.js", "function value() { return 9007199254740993; }");
    assert_eq!(
        constant(&js),
        Some(&Literal::FloatBits {
            hex: format!("{:016x}", 9007199254740992f64.to_bits())
        })
    );
    let bigint = lower(
        "a.ts",
        "function value(): bigint { return 9007199254740993n; }",
    );
    assert_eq!(
        constant(&bigint),
        Some(&Literal::Integer {
            decimal: "9007199254740993".into()
        })
    );
}

#[test]
fn java_limits_and_legacy_octal_do_not_silently_change_meaning() {
    for source in [
        "class A { int value() { return 2147483648; } }",
        "class A { int value() { return 1L; } }",
        "class A { int value() { return 010; } }",
    ] {
        let result = lower("A.java", source);
        assert!(constant(&result).is_none());
    }
    let result = lower("A.java", "class A { int value() { return -2147483648; } }");
    assert_eq!(
        constant(&result),
        Some(&Literal::Integer {
            decimal: "-2147483648".into()
        })
    );
    assert!(constant(&lower("a.js", "function value() { return 010; }")).is_none());
}

#[test]
fn printing_delegation_and_branches_are_opaque_not_pure() {
    for (path, source) in [
        (
            "A.java",
            "class A { void authorize() { System.out.println(\"hello world\"); } }",
        ),
        (
            "a.ts",
            "function authorize() { return provider.authorize(); }",
        ),
        (
            "a.js",
            "function authorize() { if (ready) return true; return false; }",
        ),
    ] {
        let result = lower(path, source);
        assert!(!result.snapshot.functions.is_empty());
        assert!(result
            .snapshot
            .functions
            .values()
            .all(|f| f.blocks.values().any(|b| matches!(
                b.terminator,
                Terminator::Opaque { .. } | Terminator::Invoke { .. }
            ))));
        assert!(!result
            .snapshot
            .documents
            .values()
            .next()
            .unwrap()
            .gaps
            .is_empty());
    }
}

#[test]
fn default_parameters_unknown_types_async_and_getters_are_not_erased() {
    for source in [
        "function value(x = charge()) { return true; }",
        "async function value() { return true; }",
        "const a = { get value() { return true; } };",
        "class A { constructor() { return true; } }",
        "function value(): Custom { return true; }",
    ] {
        assert!(constant(&lower("a.ts", source)).is_none(), "{source}");
    }
    assert!(constant(&lower(
        "A.java",
        "class A { Object value() { return true; } }"
    ))
    .is_none());
}

#[test]
fn literals_retain_bytes_and_source_provenance() {
    let source = "function value(): string { return \"hello world\"; }";
    let result = lower("a.ts", source);
    assert_eq!(
        constant(&result),
        Some(&Literal::Utf8 {
            value: "hello world".into()
        })
    );
    let i = &result
        .snapshot
        .functions
        .values()
        .next()
        .unwrap()
        .blocks
        .values()
        .next()
        .unwrap()
        .instructions[0];
    assert_eq!(
        &source[i.source.start_byte as usize..i.source.end_byte as usize],
        "\"hello world\""
    );
    result.snapshot.validate(&result.sources).unwrap();
}

#[test]
fn syntax_recovery_does_not_produce_trusted_literals() {
    let result = lower(
        "a.ts",
        "function value(): number { return 7; } !!! broken (",
    );
    assert!(constant(&result).is_none());
    assert!(result
        .snapshot
        .documents
        .values()
        .next()
        .unwrap()
        .gaps
        .iter()
        .any(|g| g.reason.contains("syntax errors")));
}

#[test]
fn arrows_and_booleans_are_supported_with_explicit_module_scope_gap() {
    for (path, source) in [
        ("a.ts", "const value = (): boolean => true;"),
        ("a.js", "function value() { return false; }"),
    ] {
        let result = lower(path, source);
        assert!(matches!(constant(&result), Some(Literal::Bool { .. })));
        assert!(!result.constructs.is_empty());
        assert!(!result
            .snapshot
            .documents
            .values()
            .next()
            .unwrap()
            .gaps
            .is_empty());
    }
}

#[test]
fn registry_rejects_conflicts_unknown_paths_and_empty_source() {
    let all = builtin_adapters();
    assert!(Registry::new(vec![all[0], all[0]]).is_err());
    assert!(Registry::builtins()
        .unwrap()
        .lower(&request("unknown.xyz", "x"))
        .is_err());
    assert!(Registry::builtins()
        .unwrap()
        .lower(&request("a.js", ""))
        .is_err());
    assert!(Registry::builtins()
        .unwrap()
        .lower(&request("../a.js", "function value(){return true;}"))
        .is_err());
}

#[test]
fn registry_rejects_extension_conflicts_between_different_adapter_ids() {
    static CONFLICT: TreeAdapter = TreeAdapter {
        metadata: Metadata {
            id: "other-java",
            extensions: &["java"],
            adapter_version: "v1",
            semantics: "v1",
            semantic_scope: "test",
        },
        grammar: || tree_sitter_java::LANGUAGE.into(),
        declarations: &[],
        profile: Profile::Java,
    };
    let java = builtin_adapters()
        .into_iter()
        .find(|a| a.metadata().id == "java")
        .unwrap();
    assert!(Registry::new(vec![java, &CONFLICT]).is_err());
}

#[test]
fn custom_adapter_cannot_substitute_an_unrelated_valid_snapshot() {
    struct WrongRevision;
    static WRONG: WrongRevision = WrongRevision;
    impl LanguageAdapter for WrongRevision {
        fn metadata(&self) -> Metadata {
            builtin_adapters()
                .into_iter()
                .find(|a| a.metadata().id == "javascript")
                .unwrap()
                .metadata()
        }
        fn lower(&self, request: &Request) -> Result<Lowered, String> {
            let mut result = lower("a.js", &request.source);
            result.snapshot.revision = "different".into();
            Ok(result)
        }
    }
    assert!(Registry::new(vec![&WRONG])
        .unwrap()
        .lower(&request("a.js", "function value(){return 7;}"))
        .unwrap_err()
        .contains("bound to request"));
}

#[test]
fn number_bits_match_independent_node_execution() {
    use std::process::Command;
    // This test is deliberately not silently skipped if the runtime is unavailable.
    let output=Command::new("node").arg("-e").arg("const b=Buffer.alloc(8); b.writeDoubleBE(9007199254740993); console.log(b.toString('hex'));").output().expect("Node is required for source-fidelity tests");
    assert!(output.status.success());
    let result = lower("a.js", "function value() { return 9007199254740993; }");
    assert_eq!(
        constant(&result),
        Some(&Literal::FloatBits {
            hex: String::from_utf8(output.stdout).unwrap().trim().into()
        })
    );
}

#[test]
fn java_long_matches_independent_java_source_execution() {
    use std::process::Command;
    let source="class Oracle { static long value() { return 9007199254740993L; } public static void main(String[] args) { System.out.println(value()); } }";
    let directory = std::env::temp_dir().join(format!("cie-java-oracle-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("Oracle.java");
    std::fs::write(&path, source).unwrap();
    let output = Command::new("java")
        .arg(&path)
        .output()
        .expect("Java 17+ with compiler module required for fidelity tests");
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_dir(&directory).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        constant(&lower("Oracle.java", source)),
        Some(&Literal::Integer {
            decimal: String::from_utf8(output.stdout).unwrap().trim().into()
        })
    );
}

#[test]
fn typescript_number_matches_node_type_stripping_execution() {
    use std::process::Command;
    let source = "function value(): number { return -0; }";
    let path =
        std::env::temp_dir().join(format!("cie-typescript-oracle-{}.ts", std::process::id()));
    std::fs::write(&path,format!("{source}\nconst b=Buffer.alloc(8); b.writeDoubleBE(value()); console.log(b.toString('hex'));" )).unwrap();
    let output = Command::new("node")
        .arg("--experimental-strip-types")
        .arg(&path)
        .output()
        .expect("Node with TypeScript stripping required for fidelity tests");
    std::fs::remove_file(&path).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        constant(&lower("a.ts", source)),
        Some(&Literal::FloatBits {
            hex: String::from_utf8(output.stdout).unwrap().trim().into()
        })
    );
}
