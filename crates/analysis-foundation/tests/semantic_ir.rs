use analysis_foundation::semantic_ir::*;
use std::collections::{BTreeMap, BTreeSet};

#[test]
fn golden_wire_vector_and_digest_are_stable() {
    let s: Snapshot = serde_json::from_str(include_str!("fixtures/semantic-v1.json")).unwrap();
    let sources = BTreeMap::from([("d".into(), include_bytes!("fixtures/value.py").to_vec())]);
    assert_eq!(
        s.checked_digest(&sources).unwrap(),
        include_str!("fixtures/semantic-v1.sha256").trim()
    );
    let reserialized: serde_json::Value =
        serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
    assert_eq!(
        reserialized,
        serde_json::from_str::<serde_json::Value>(include_str!("fixtures/semantic-v1.json"))
            .unwrap()
    );
}

#[test]
fn duplicate_wire_map_identities_are_rejected_before_overwrite() {
    let (s, _) = fixture();
    let wire = serde_json::to_string(&s).unwrap();
    let function_wire = serde_json::to_string(&s.functions[&FunctionId::from("f")]).unwrap();
    let needle = format!("\"f\":{function_wire}");
    let duplicated = wire.replace(&needle, &format!("{needle},{needle}"));
    assert_ne!(wire, duplicated);
    assert!(serde_json::from_str::<Snapshot>(&duplicated)
        .unwrap_err()
        .to_string()
        .contains("duplicate semantic IR"));
}

#[test]
fn operators_are_typed_and_participate_in_digest() {
    let (mut s, b) = fixture();
    let mut binary = instruction(&mut s).clone();
    binary.id = "binary".into();
    binary.action = Action::Binary {
        result: "out".into(),
        left: "v".into(),
        right: "v".into(),
        operator: BinaryOp::Add,
    };
    function(&mut s).values.insert("out".into(), int());
    function(&mut s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap()
        .instructions
        .push(binary);
    let before = s.checked_digest(&b).unwrap();
    if let Action::Binary { operator, .. } = &mut function(&mut s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap()
        .instructions[1]
        .action
    {
        *operator = BinaryOp::Subtract;
    }
    assert_ne!(before, s.checked_digest(&b).unwrap());
    if let Action::Binary { operator, .. } = &mut function(&mut s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap()
        .instructions[1]
        .action
    {
        *operator = BinaryOp::And;
    }
    assert!(s.validate(&b).is_err());
}

#[test]
fn branch_edge_changes_participate_in_digest() {
    let (mut s, b) = literal_snapshot(Literal::Bool { value: true }, Type::Bool);
    let ret = Block {
        source: span(),
        instructions: vec![],
        terminator: Terminator::Return {
            value: Some("v".into()),
        },
    };
    function(&mut s).blocks.insert("yes".into(), ret.clone());
    function(&mut s).blocks.insert("no".into(), ret);
    function(&mut s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap()
        .terminator = Terminator::Branch {
        condition: "v".into(),
        then_block: "yes".into(),
        else_block: "no".into(),
    };
    let before = s.checked_digest(&b).unwrap();
    function(&mut s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap()
        .terminator = Terminator::Branch {
        condition: "v".into(),
        then_block: "no".into(),
        else_block: "yes".into(),
    };
    assert_ne!(before, s.checked_digest(&b).unwrap());
}

fn span() -> Span {
    Span {
        document: "d".into(),
        start_byte: 0,
        end_byte: 6,
    }
}
fn int() -> Type {
    Type::Integer {
        bits: Some(64),
        signed: true,
    }
}
fn fixture() -> (Snapshot, Sources) {
    let bytes = b"abcdef".to_vec();
    let instruction = Instruction {
        id: "i".into(),
        source: span(),
        exceptional: None,
        action: Action::Constant {
            result: "v".into(),
            literal: Literal::Integer {
                decimal: "9007199254740993".into(),
            },
        },
    };
    let f = Function {
        source: span(),
        parameters: vec![],
        return_type: int(),
        values: BTreeMap::from([("v".into(), int())]),
        entry: "entry".into(),
        blocks: BTreeMap::from([(
            "entry".into(),
            Block {
                source: span(),
                instructions: vec![instruction],
                terminator: Terminator::Return {
                    value: Some("v".into()),
                },
            },
        )]),
    };
    let doc = Document {
        path: "fixture.py".into(),
        sha256: source_digest(&bytes),
        language: "python".into(),
        lowering_version: "test-v1".into(),
        semantics_version: "test-only".into(),
        gaps: vec![],
    };
    (
        Snapshot {
            schema: SCHEMA.into(),
            revision: "r1".into(),
            producer_version: "test-v1".into(),
            environment_digest: "env1".into(),
            documents: BTreeMap::from([("d".into(), doc)]),
            functions: BTreeMap::from([("f".into(), f)]),
        },
        BTreeMap::from([("d".into(), bytes)]),
    )
}
fn function(s: &mut Snapshot) -> &mut Function {
    s.functions.get_mut(&FunctionId::from("f")).unwrap()
}
fn instruction(s: &mut Snapshot) -> &mut Instruction {
    &mut function(s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap()
        .instructions[0]
}
fn literal_snapshot(literal: Literal, ty: Type) -> (Snapshot, Sources) {
    let (mut s, b) = fixture();
    function(&mut s).return_type = ty.clone();
    function(&mut s).values.insert("v".into(), ty);
    instruction(&mut s).action = Action::Constant {
        result: "v".into(),
        literal,
    };
    (s, b)
}

#[test]
fn round_trip_preserves_large_integer_exactly() {
    let (s, b) = fixture();
    s.validate(&b).unwrap();
    let wire = serde_json::to_string(&s).unwrap();
    assert!(wire.contains("9007199254740993"));
    let decoded: Snapshot = serde_json::from_str(&wire).unwrap();
    assert_eq!(s, decoded);
    assert_eq!(s.checked_digest(&b), decoded.checked_digest(&b));
}

#[test]
fn exact_float_bits_preserve_nan_payload_and_signed_zero() {
    for bits in ["8000000000000000", "7ff8000000000042"] {
        let (s, b) = literal_snapshot(
            Literal::FloatBits { hex: bits.into() },
            Type::Float {
                format: FloatFormat::Binary64,
            },
        );
        s.validate(&b).unwrap();
        let decoded: Snapshot = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
        assert_eq!(decoded, s);
    }
    let (a, b) = literal_snapshot(
        Literal::FloatBits {
            hex: "0000000000000000".into(),
        },
        Type::Float {
            format: FloatFormat::Binary64,
        },
    );
    let (c, _) = literal_snapshot(
        Literal::FloatBits {
            hex: "8000000000000000".into(),
        },
        Type::Float {
            format: FloatFormat::Binary64,
        },
    );
    assert_ne!(a.checked_digest(&b), c.checked_digest(&b));
}

#[test]
fn decimal_and_unbounded_integer_round_trip() {
    for (l, t) in [
        (
            Literal::Decimal {
                unscaled: "12345".into(),
                scale: 2,
            },
            Type::Decimal {
                precision: 5,
                scale: 2,
            },
        ),
        (
            Literal::Integer {
                decimal: "99999999999999999999999999999999999999999999999999".into(),
            },
            Type::Integer {
                bits: None,
                signed: true,
            },
        ),
    ] {
        let (s, b) = literal_snapshot(l, t);
        s.validate(&b).unwrap();
        assert_eq!(
            s,
            serde_json::from_value::<Snapshot>(serde_json::to_value(&s).unwrap()).unwrap()
        );
    }
}

#[test]
fn rejects_bad_literal_encodings_types_and_ranges() {
    for l in [
        Literal::Integer {
            decimal: "01".into(),
        },
        Literal::Integer {
            decimal: "-0".into(),
        },
        Literal::Integer {
            decimal: "1e3".into(),
        },
        Literal::Integer {
            decimal: "9223372036854775808".into(),
        },
        Literal::Bool { value: true },
    ] {
        let (s, b) = literal_snapshot(l, int());
        assert!(s.validate(&b).is_err());
    }
    for (l, t) in [
        (
            Literal::FloatBits { hex: "NaN".into() },
            Type::Float {
                format: FloatFormat::Binary64,
            },
        ),
        (
            Literal::Decimal {
                unscaled: "12345".into(),
                scale: 2,
            },
            Type::Decimal {
                precision: 4,
                scale: 2,
            },
        ),
        (
            Literal::Integer {
                decimal: "-1".into(),
            },
            Type::Integer {
                bits: Some(8),
                signed: false,
            },
        ),
        (
            Literal::Integer {
                decimal: "1".into(),
            },
            Type::Integer {
                bits: Some(129),
                signed: true,
            },
        ),
    ] {
        let (s, b) = literal_snapshot(l, t);
        assert!(s.validate(&b).is_err());
    }
}

#[test]
fn source_bytes_must_match_digest_and_document_set() {
    let (s, mut b) = fixture();
    b.insert("d".into(), b"abcdeg".to_vec());
    assert!(s.validate(&b).unwrap_err().contains("digest"));
    b.clear();
    assert!(s.validate(&b).is_err());
}

#[test]
fn rejects_bad_document_paths_versions_and_span_ownership() {
    let (s, b) = fixture();
    for path in ["/tmp/x", "../x", "a/../x", "a\\b", "a//b"] {
        let mut bad = s.clone();
        bad.documents.get_mut(&DocumentId::from("d")).unwrap().path = path.into();
        assert!(bad.validate(&b).is_err());
    }
    let mut bad = s.clone();
    bad.producer_version = "".into();
    assert!(bad.validate(&b).is_err());
    let mut bad = s;
    instruction(&mut bad).source.end_byte = 7;
    assert!(bad.validate(&b).is_err());
}

#[test]
fn rejects_utf8_split_and_reversed_spans() {
    let (mut s, mut b) = fixture();
    let bytes = "aédef".as_bytes().to_vec();
    s.documents.get_mut(&DocumentId::from("d")).unwrap().sha256 = source_digest(&bytes);
    b.insert("d".into(), bytes);
    instruction(&mut s).source.start_byte = 2;
    assert!(s.validate(&b).is_err());
    instruction(&mut s).source.start_byte = 5;
    instruction(&mut s).source.end_byte = 4;
    assert!(s.validate(&b).is_err());
}

#[test]
fn rejects_dangling_values_duplicate_defs_and_instruction_ids() {
    let (mut s, b) = fixture();
    function(&mut s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap()
        .terminator = Terminator::Return {
        value: Some("missing".into()),
    };
    assert!(s.validate(&b).is_err());
    let (mut s, b) = fixture();
    let i = instruction(&mut s).clone();
    function(&mut s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap()
        .instructions
        .push(i);
    assert!(s.validate(&b).is_err());
    let (mut s, b) = fixture();
    function(&mut s).parameters.push("v".into());
    assert!(s.validate(&b).is_err());
    let (mut s, b) = fixture();
    function(&mut s).values.insert("orphan".into(), int());
    assert!(s.validate(&b).is_err());
}

fn invocation() -> (Snapshot, Sources) {
    let (mut s, b) = fixture();
    let callee = s.functions[&FunctionId::from("f")].clone();
    s.functions.insert("callee".into(), callee);
    function(&mut s).blocks.insert(
        "done".into(),
        Block {
            source: span(),
            instructions: vec![],
            terminator: Terminator::Return {
                value: Some("v".into()),
            },
        },
    );
    let entry = function(&mut s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap();
    entry.instructions.clear();
    entry.terminator = Terminator::Invoke {
        result: Some("v".into()),
        call: CallSite {
            arguments: vec![],
            binding: Binding::Resolved {
                targets: BTreeSet::from(["callee".into()]),
                evidence: span(),
            },
        },
        normal: "done".into(),
        exceptional: ExceptionalExit::Propagate,
    };
    (s, b)
}

#[test]
fn resolved_calls_have_explicit_normal_and_exceptional_edges() {
    let (s, b) = invocation();
    s.validate(&b).unwrap();
    let wire = serde_json::to_value(&s).unwrap();
    assert_eq!(
        wire["functions"]["f"]["blocks"]["entry"]["terminator"]["exceptional"]["kind"],
        "propagate"
    );
    assert_eq!(s, serde_json::from_value::<Snapshot>(wire).unwrap());
}

#[test]
fn rejects_missing_targets_arity_and_result_mismatches() {
    let (mut s, b) = invocation();
    s.functions.remove(&FunctionId::from("callee"));
    assert!(s.validate(&b).is_err());
    let (mut s, b) = invocation();
    s.functions
        .get_mut(&FunctionId::from("callee"))
        .unwrap()
        .parameters
        .push("v".into());
    assert!(s.validate(&b).is_err());
    let (mut s, b) = invocation();
    s.functions
        .get_mut(&FunctionId::from("callee"))
        .unwrap()
        .return_type = Type::Bool;
    assert!(s.validate(&b).is_err());
}

#[test]
fn unresolved_calls_and_opaque_regions_survive_round_trip() {
    let (mut s, b) = invocation();
    if let Terminator::Invoke { call, .. } = &mut function(&mut s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap()
        .terminator
    {
        call.binding = Binding::Unresolved {
            reason: "dynamic provider".into(),
            evidence: span(),
        };
    }
    s.documents
        .get_mut(&DocumentId::from("d"))
        .unwrap()
        .gaps
        .push(Gap {
            source: span(),
            reason: "reflection".into(),
        });
    s.validate(&b).unwrap();
    assert_eq!(
        s,
        serde_json::from_value::<Snapshot>(serde_json::to_value(&s).unwrap()).unwrap()
    );
    let (mut s, b) = fixture();
    instruction(&mut s).action = Action::Opaque {
        reason: "unsupported expression".into(),
        inputs: vec![],
        outputs: vec!["v".into()],
    };
    s.validate(&b).unwrap();
    instruction(&mut s).action = Action::Opaque {
        reason: "".into(),
        inputs: vec![],
        outputs: vec!["v".into()],
    };
    assert!(s.validate(&b).is_err());
}

#[test]
fn rejects_cross_function_edges_missing_entry_and_bad_exception_targets() {
    let (mut s, b) = fixture();
    function(&mut s).entry = "missing".into();
    assert!(s.validate(&b).is_err());
    let (mut s, b) = invocation();
    if let Terminator::Invoke { exceptional, .. } = &mut function(&mut s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap()
        .terminator
    {
        *exceptional = ExceptionalExit::Block {
            target: "absent".into(),
        };
    }
    assert!(s.validate(&b).is_err());
    let (mut s, b) = fixture();
    instruction(&mut s).exceptional = Some(ExceptionalExit::Block {
        target: "foreign".into(),
    });
    assert!(s.validate(&b).is_err());
}

#[test]
fn explicit_instruction_exception_edge_is_validated_and_hashed() {
    let (mut s, b) = fixture();
    let old = s.checked_digest(&b).unwrap();
    instruction(&mut s).exceptional = Some(ExceptionalExit::Propagate);
    s.validate(&b).unwrap();
    assert_ne!(old, s.checked_digest(&b).unwrap());
}

#[test]
fn branch_requires_boolean_and_wire_uses_camel_case_fields() {
    let (mut s, b) = fixture();
    function(&mut s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap()
        .terminator = Terminator::Branch {
        condition: "v".into(),
        then_block: "entry".into(),
        else_block: "entry".into(),
    };
    assert!(s.validate(&b).is_err());
    function(&mut s).values.insert("v".into(), Type::Bool);
    instruction(&mut s).action = Action::Constant {
        result: "v".into(),
        literal: Literal::Bool { value: true },
    };
    s.validate(&b).unwrap();
    let wire = serde_json::to_value(&s).unwrap();
    assert_eq!(
        wire["functions"]["f"]["blocks"]["entry"]["terminator"]["thenBlock"],
        "entry"
    );
}

#[test]
fn instruction_order_is_semantic_input_not_sorted_by_id() {
    let (mut s, b) = fixture();
    let mut second = instruction(&mut s).clone();
    second.id = "second".into();
    second.action = Action::Write {
        resource: "stdout".into(),
        value: "v".into(),
    };
    function(&mut s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap()
        .instructions
        .push(second);
    let before = s.checked_digest(&b).unwrap();
    function(&mut s)
        .blocks
        .get_mut(&BlockId::from("entry"))
        .unwrap()
        .instructions
        .reverse();
    assert_ne!(before, s.checked_digest(&b).unwrap());
}

#[test]
fn constant_operator_environment_and_revision_changes_affect_digest() {
    let (s, b) = fixture();
    let original = s.checked_digest(&b).unwrap();
    for change in 0..4 {
        let mut next = s.clone();
        match change {
            0 => next.revision = "r2".into(),
            1 => next.environment_digest = "env2".into(),
            2 => {
                next.documents
                    .get_mut(&DocumentId::from("d"))
                    .unwrap()
                    .semantics_version = "sem2".into()
            }
            _ => {
                instruction(&mut next).action = Action::Constant {
                    result: "v".into(),
                    literal: Literal::Integer {
                        decimal: "1".into(),
                    },
                }
            }
        }
        assert_ne!(original, next.checked_digest(&b).unwrap());
    }
}

#[test]
fn schema_unknown_fields_and_wrong_enum_values_are_rejected() {
    let (s, b) = fixture();
    let mut bad = s.clone();
    bad.schema = "cie.semantic-ir.v2".into();
    assert!(bad.validate(&b).is_err());
    for pointer in [
        "/extra",
        "/functions/f/extra",
        "/functions/f/blocks/entry/instructions/0/action/extra",
    ] {
        let mut wire = serde_json::to_value(&s).unwrap();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        wire.pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert(key.into(), true.into());
        assert!(serde_json::from_value::<Snapshot>(wire).is_err());
    }
}
