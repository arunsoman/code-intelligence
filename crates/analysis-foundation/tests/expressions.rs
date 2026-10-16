use analysis_foundation::{languages::*, semantic_ir::*};
use std::{
    collections::BTreeMap,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq)]
enum Value {
    Integer(i64),
    Number(f64),
    Bool(bool),
    Text(String),
    Unit,
}

#[test]
fn java_final_parameter_and_local_reassignment_stay_opaque() {
    for source in [
        "class A { int value(final int x){ x=2; return x; } }",
        "class A { int value(){ final\nint x=1; x=2; return x; } }",
    ] {
        let result = lower("A.java", source);
        assert!(result
            .snapshot
            .functions
            .values()
            .all(|f| matches!(f.blocks[&f.entry].terminator, Terminator::Opaque { .. })));
    }
}
fn lower(path: &str, source: &str) -> Lowered {
    Registry::builtins()
        .unwrap()
        .lower(&Request {
            path: path.into(),
            source: source.into(),
            revision: "r1".into(),
            environment_digest: "env1".into(),
        })
        .unwrap()
}

#[test]
fn source_to_ir_golden_vectors_preserve_order_values_and_spans() {
    for (path, source, golden) in [
        (
            "Expr.java",
            include_str!("fixtures/expressions/Expr.java"),
            include_str!("fixtures/expressions/Expr.java.ir.json"),
        ),
        (
            "value.ts",
            include_str!("fixtures/expressions/value.ts"),
            include_str!("fixtures/expressions/value.ts.ir.json"),
        ),
        (
            "value.js",
            include_str!("fixtures/expressions/value.js"),
            include_str!("fixtures/expressions/value.js.ir.json"),
        ),
    ] {
        let result = Registry::builtins()
            .unwrap()
            .lower(&Request {
                path: path.into(),
                source: source.into(),
                revision: "golden-p03a".into(),
                environment_digest: "golden-env".into(),
            })
            .unwrap();
        assert_eq!(
            result.snapshot,
            serde_json::from_str::<Snapshot>(golden).unwrap()
        );
        result.snapshot.validate(&result.sources).unwrap();
        for function in result.snapshot.functions.values() {
            for instruction in &function.blocks[&function.entry].instructions {
                let s = &source
                    [instruction.source.start_byte as usize..instruction.source.end_byte as usize];
                assert!(!s.is_empty());
                assert!(!s.contains("return"));
            }
        }
    }
}
fn modeled(result: &Lowered) -> &Function {
    result
        .snapshot
        .functions
        .values()
        .find(|f| matches!(f.blocks[&f.entry].terminator, Terminator::Return { .. }))
        .expect("modeled body")
}
fn evaluate(result: &Lowered, args: Vec<Value>) -> Value {
    let f = modeled(result);
    let mut values: BTreeMap<ValueId, Value> = f.parameters.iter().cloned().zip(args).collect();
    let normalize = |v: i64, t: &Type| match t {
        Type::Integer { bits: Some(32), .. } => i64::from(v as i32),
        _ => v,
    };
    for instruction in &f.blocks[&f.entry].instructions {
        let (id, value) = match &instruction.action {
            Action::Constant { result, literal } => (
                result,
                match literal {
                    Literal::Integer { decimal } => Value::Integer(decimal.parse().unwrap()),
                    Literal::FloatBits { hex } => {
                        Value::Number(f64::from_bits(u64::from_str_radix(hex, 16).unwrap()))
                    }
                    Literal::Bool { value } => Value::Bool(*value),
                    Literal::Utf8 { value } => Value::Text(value.clone()),
                    _ => panic!("test oracle subset"),
                },
            ),
            Action::Copy { result, operand } => (result, values[operand].clone()),
            Action::Unary {
                result,
                operand,
                operator,
            } => (
                result,
                match (operator, &values[operand]) {
                    (UnaryOp::Not, Value::Bool(v)) => Value::Bool(!v),
                    (UnaryOp::Negate, Value::Integer(v)) => {
                        Value::Integer(normalize(v.wrapping_neg(), &f.values[result]))
                    }
                    (UnaryOp::Negate, Value::Number(v)) => Value::Number(-v),
                    _ => panic!("unexpected unary"),
                },
            ),
            Action::Binary {
                result,
                left,
                right,
                operator,
            } => (
                result,
                match (&values[left], &values[right], operator) {
                    (Value::Integer(a), Value::Integer(b), BinaryOp::Add) => {
                        Value::Integer(normalize(a.wrapping_add(*b), &f.values[result]))
                    }
                    (Value::Integer(a), Value::Integer(b), BinaryOp::Subtract) => {
                        Value::Integer(normalize(a.wrapping_sub(*b), &f.values[result]))
                    }
                    (Value::Integer(a), Value::Integer(b), BinaryOp::Multiply) => {
                        Value::Integer(normalize(a.wrapping_mul(*b), &f.values[result]))
                    }
                    (Value::Integer(a), Value::Integer(b), BinaryOp::LessThan) => {
                        Value::Bool(a < b)
                    }
                    (Value::Number(a), Value::Number(b), BinaryOp::Add) => Value::Number(a + b),
                    (Value::Number(a), Value::Number(b), BinaryOp::Subtract) => {
                        Value::Number(a - b)
                    }
                    (Value::Number(a), Value::Number(b), BinaryOp::Multiply) => {
                        Value::Number(a * b)
                    }
                    (Value::Number(a), Value::Number(b), BinaryOp::LessThan) => Value::Bool(a < b),
                    (a, b, BinaryOp::Equal) => Value::Bool(a == b),
                    _ => panic!("unexpected binary"),
                },
            ),
            _ => panic!("unexpected operation"),
        };
        values.insert(id.clone(), value);
    }
    match &f.blocks[&f.entry].terminator {
        Terminator::Return { value: Some(v) } => values[v].clone(),
        Terminator::Return { value: None } => Value::Unit,
        _ => panic!("unexpected terminator"),
    }
}

#[test]
fn typed_parameter_references_and_identity_preserve_values() {
    for (path, source, arg) in [
        (
            "A.java",
            "class A { int value(int x) { return x; } }",
            Value::Integer(17),
        ),
        (
            "a.ts",
            "function value(x: number): number { return x; }",
            Value::Number(17.0),
        ),
        (
            "a.js",
            "function value(x) { return x; }",
            Value::Text("hello".into()),
        ),
    ] {
        let result = lower(path, source);
        assert_eq!(evaluate(&result, vec![arg.clone()]), arg);
        result.snapshot.validate(&result.sources).unwrap();
    }
}

#[test]
fn straight_line_locals_and_reassignment_have_distinct_value_definitions() {
    let result = lower(
        "a.ts",
        "function value(x: number): number { let y = x + 3; y = y * 2; return y; }",
    );
    assert_eq!(
        evaluate(&result, vec![Value::Number(4.0)]),
        Value::Number(14.0)
    );
    assert!(modeled(&result).blocks[&modeled(&result).entry]
        .instructions
        .iter()
        .any(|i| matches!(i.action, Action::Copy { .. })));
}

#[test]
fn inferred_javascript_locals_and_operator_precedence_are_preserved() {
    let result = lower(
        "a.js",
        "function value() { const x = 2; let y = x + 3 * 4; y = y - 1; return y; }",
    );
    assert_eq!(evaluate(&result, vec![]), Value::Number(13.0));
}

#[test]
fn comparisons_and_unary_operations_preserve_types() {
    let result = lower(
        "A.java",
        "class A { boolean value(int x) { return x < 3; } }",
    );
    assert_eq!(
        evaluate(&result, vec![Value::Integer(2)]),
        Value::Bool(true)
    );
    let result = lower("a.ts", "function value(x: boolean): boolean { return !x; }");
    assert_eq!(
        evaluate(&result, vec![Value::Bool(true)]),
        Value::Bool(false)
    );
    let result = lower(
        "a.ts",
        "function value(x: number): number { return -(x + 1); }",
    );
    assert_eq!(
        evaluate(&result, vec![Value::Number(2.0)]),
        Value::Number(-3.0)
    );
    let result = lower("A.java", "class A { boolean value() { return 1 < 2; } }");
    assert_eq!(evaluate(&result, vec![]), Value::Bool(true));
}

#[test]
fn typescript_annotation_assumptions_are_visible() {
    let result = lower(
        "a.ts",
        "function value(x: number): number { return x + 1; }",
    );
    assert!(result
        .snapshot
        .documents
        .values()
        .next()
        .unwrap()
        .gaps
        .iter()
        .any(|g| g.reason.contains("annotations are model assumptions")));
}

#[test]
fn effectful_or_unmodeled_statements_cannot_be_erased_by_a_return() {
    for source in [
        "function value(){ charge(); return 7; }",
        "function value(){ return 7; charge(); }",
        "function value(){ let x = provider(); return x; }",
        "function value(){ let x=1; if (ready) x=2; return x; }",
        "function value(){ let x=1; x+=1; return x; }",
        "function value(){ let x=1; obj.x=2; return x; }",
        "function value(){ let x=1; {let x=2;} return x; }",
        "function value(){ return unknown; }",
    ] {
        let result = lower("a.js", source);
        assert!(
            result
                .snapshot
                .functions
                .values()
                .all(|f| f.blocks.values().any(|b| matches!(
                    b.terminator,
                    Terminator::Opaque { .. } | Terminator::Invoke { .. }
                ))),
            "{source}"
        );
    }
}

#[test]
fn coercion_short_circuit_and_division_remain_opaque() {
    for (path, source) in [
        ("a.ts", "function value(x: number) { return x == 1; }"),
        ("a.ts", "function value(x: boolean) { return x && false; }"),
        ("a.js", "function value(x) { return x + 1; }"),
        ("a.ts", "function value() { return \"x\" + 1; }"),
        (
            "A.java",
            "class A { long value() { return 2147483647 + 1; } }",
        ),
        ("A.java", "class A { int value(int x) { return x / 0; } }"),
    ] {
        let result = lower(path, source);
        assert!(
            result
                .snapshot
                .functions
                .values()
                .all(|f| matches!(f.blocks[&f.entry].terminator, Terminator::Opaque { .. })),
            "{source}"
        );
    }
}

#[test]
fn const_reassignment_duplicate_bindings_and_use_before_definition_are_opaque() {
    for source in [
        "function value(){ const x=1; x=2; return x; }",
        "function value(){ const\nx=1; x=2; return x; }",
        "function value(){ let x=1; let x=2; return x; }",
        "function value(){ let y=x; let x=1; return y; }",
    ] {
        let result = lower("a.js", source);
        assert!(
            result
                .snapshot
                .functions
                .values()
                .all(|f| matches!(f.blocks[&f.entry].terminator, Terminator::Opaque { .. })),
            "{source}"
        );
    }
}

fn node_value(source: &str, call: &str, typescript: bool) -> String {
    let path = std::env::temp_dir().join(format!(
        "cie-expression-{}-{}-{}.{}",
        std::process::id(),
        NEXT_FILE.fetch_add(1, Ordering::Relaxed),
        if typescript { "ts" } else { "js" },
        if typescript { "ts" } else { "js" }
    ));
    std::fs::write(
        &path,
        format!("{source}\nconst value_={call}; console.log(JSON.stringify(value_));"),
    )
    .unwrap();
    let mut command = Command::new("node");
    if typescript {
        command.arg("--experimental-strip-types");
    }
    let output = command.arg(&path).output().unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[test]
fn source_execution_agrees_with_ir_for_js_and_ts_expression_chains() {
    let js = "function value(){ const x=2; let y=x+3*4; y=y-1; return y; }";
    assert_eq!(node_value(js, "value()", false), "13");
    assert_eq!(evaluate(&lower("a.js", js), vec![]), Value::Number(13.0));
    let ts = "function value(x: number): number { let y=x+3; y=y*2; return -y; }";
    assert_eq!(node_value(ts, "value(4)", true), "-14");
    assert_eq!(
        evaluate(&lower("a.ts", ts), vec![Value::Number(4.0)]),
        Value::Number(-14.0)
    );
}

#[test]
fn java_overflow_matches_source_execution() {
    let source="class ExprOracle { static int value(int x) { int y=x+1; return y; } public static void main(String[] args){System.out.println(value(2147483647));} }";
    let directory =
        std::env::temp_dir().join(format!("cie-expression-java-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("ExprOracle.java");
    std::fs::write(&path, source).unwrap();
    let output = Command::new("java").arg(&path).output().unwrap();
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(directory).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "-2147483648"
    );
    assert_eq!(
        evaluate(
            &lower("ExprOracle.java", source),
            vec![Value::Integer(i64::from(i32::MAX))]
        ),
        Value::Integer(i64::from(i32::MIN))
    );
}

#[test]
fn nan_strict_equality_matches_javascript_number_semantics() {
    let ts = "function value(x: number): boolean { return x === x; }";
    assert_eq!(node_value(ts, "value(NaN)", true), "false");
    assert_eq!(
        evaluate(&lower("a.ts", ts), vec![Value::Number(f64::NAN)]),
        Value::Bool(false)
    );
}
