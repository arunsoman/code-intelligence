use analysis_foundation::*;
use std::collections::BTreeSet;

fn source() -> Source {
    Source {
        file: "fixture.py".into(),
        content_digest: "source-v1".into(),
        start_byte: 0,
        end_byte: 100,
    }
}
fn function(id: &str, actions: Vec<Action>) -> Function {
    Function {
        id: id.into(),
        source: source(),
        gaps: BTreeSet::new(),
        operations: actions
            .into_iter()
            .enumerate()
            .map(|(i, action)| Operation {
                id: format!("{id}/{i}"),
                source: source(),
                action,
            })
            .collect(),
    }
}
fn snapshot(functions: Vec<Function>) -> Snapshot {
    Snapshot {
        schema: SCHEMA.into(),
        revision: "r1".into(),
        semantics: "fixture-v1".into(),
        environment_digest: "env1".into(),
        functions,
    }
}
fn call(id: &str) -> Action {
    Action::Call { target: id.into() }
}
fn emit() -> Action {
    Action::Emit {
        resource: "stdout".into(),
    }
}

#[test]
fn name_does_not_imply_authorization() {
    let s = snapshot(vec![function("authorize", vec![emit(), Action::Return])]);
    let result = analyze(&s, 100).unwrap();
    assert_eq!(
        result.summaries["authorize"].effects,
        BTreeSet::from([Effect::Emit("stdout".into())])
    );
    assert_eq!(
        result.summaries["authorize"].completion,
        Completion::CompleteWithinModel
    );
}

#[test]
fn delegation_propagates_effects_and_operation_evidence() {
    let s = snapshot(vec![
        function("a", vec![call("b")]),
        function("b", vec![call("c")]),
        function("c", vec![emit()]),
    ]);
    let result = analyze(&s, 100).unwrap();
    assert!(result.summaries["a"]
        .effects
        .contains(&Effect::Emit("stdout".into())));
    assert_eq!(
        result.summaries["a"].evidence,
        BTreeSet::from(["a/0".into(), "b/0".into(), "c/0".into()])
    );
}

#[test]
fn unknown_callee_is_not_an_empty_pure_function() {
    let s = snapshot(vec![
        function("a", vec![call("b")]),
        function(
            "b",
            vec![Action::UnresolvedCall {
                reason: "provider unavailable".into(),
            }],
        ),
    ]);
    let result = analyze(&s, 100).unwrap();
    assert_eq!(result.summaries["a"].completion, Completion::Partial);
    assert!(result.summaries["a"]
        .gaps
        .iter()
        .any(|g| g.contains("provider unavailable")));
}

#[test]
fn recursion_converges_without_erasing_effects() {
    let s = snapshot(vec![
        function("a", vec![call("b")]),
        function("b", vec![call("a"), emit()]),
    ]);
    let result = analyze(&s, 100).unwrap();
    assert!(result.steps < 100);
    assert_eq!(result.summaries["a"].effects, result.summaries["b"].effects);
}

#[test]
fn budget_exhaustion_is_explicit() {
    let s = snapshot(vec![
        function("a", vec![call("b")]),
        function("b", vec![emit()]),
    ]);
    for budget in [0, 1] {
        let result = analyze(&s, budget).unwrap();
        assert!(result
            .summaries
            .values()
            .all(|s| s.completion == Completion::BudgetExhausted));
    }
}

#[test]
fn deleted_callee_and_old_callers_are_invalidated() {
    let old = snapshot(vec![
        function("a", vec![call("b")]),
        function("b", vec![emit()]),
        function("unrelated", vec![]),
    ]);
    let new = snapshot(vec![function("a", vec![]), function("unrelated", vec![])]);
    assert_eq!(
        invalidated(&old, &new).unwrap(),
        BTreeSet::from(["a".into(), "b".into()])
    );
}

#[test]
fn effect_change_invalidates_transitive_callers_and_reanalysis_matches_facts() {
    let old = snapshot(vec![
        function("a", vec![call("b")]),
        function("b", vec![emit()]),
    ]);
    let mut new = old.clone();
    new.functions[1].operations[0].action = Action::Write {
        resource: "ledger".into(),
    };
    assert_eq!(invalidated(&old, &new).unwrap().len(), 2);
    let result = analyze(&new, 100).unwrap();
    assert_eq!(
        result.summaries["a"].effects,
        BTreeSet::from([Effect::Write("ledger".into())])
    );
}

#[test]
fn environment_and_semantics_changes_invalidate_every_function() {
    let old = snapshot(vec![function("a", vec![]), function("b", vec![])]);
    for change_semantics in [true, false] {
        let mut new = old.clone();
        if change_semantics {
            new.semantics = "v2".into();
        } else {
            new.environment_digest = "env2".into();
        }
        assert_eq!(invalidated(&old, &new).unwrap().len(), 2);
    }
}

#[test]
fn revision_refresh_and_input_order_are_distinguished_from_semantic_changes() {
    let old = snapshot(vec![
        function("a", vec![emit(), Action::Return]),
        function("b", vec![]),
    ]);
    let mut new = old.clone();
    new.functions.reverse();
    new.functions[1].operations.reverse();
    assert_eq!(
        analyze(&old, 100).unwrap().input_digest,
        analyze(&new, 100).unwrap().input_digest
    );
    new.revision = "r2".into();
    assert!(invalidated(&old, &new).unwrap().is_empty());
    assert_ne!(
        analyze(&old, 100).unwrap().input_digest,
        analyze(&new, 100).unwrap().input_digest
    );
}

#[test]
fn rejects_missing_targets_duplicates_and_bad_spans() {
    let missing = snapshot(vec![function("a", vec![call("missing")])]);
    assert!(analyze(&missing, 100)
        .unwrap_err()
        .contains("unresolvedCall"));
    let duplicate = snapshot(vec![function("a", vec![]), function("a", vec![])]);
    assert!(duplicate.validate().is_err());
    let mut bad = snapshot(vec![function("a", vec![emit()])]);
    bad.functions[0].operations[0].source.end_byte = 101;
    assert!(bad.validate().is_err());
    bad.functions[0].operations[0].source = source();
    let duplicate_op = bad.functions[0].operations[0].clone();
    bad.functions[0].operations.push(duplicate_op);
    assert!(bad.validate().is_err());
}

#[test]
fn rejects_unknown_wire_fields_and_versions() {
    let s = snapshot(vec![]);
    let mut json = serde_json::to_value(&s).unwrap();
    json["label"] = "trust me".into();
    assert!(serde_json::from_value::<Snapshot>(json).is_err());
    let mut bad = s;
    bad.schema = "future".into();
    assert!(bad.validate().is_err());
}

#[test]
fn producer_coverage_gap_propagates() {
    let mut s = snapshot(vec![function("a", vec![call("b")]), function("b", vec![])]);
    s.functions[1]
        .gaps
        .insert("exception lowering unsupported".into());
    assert_eq!(
        analyze(&s, 100).unwrap().summaries["a"].completion,
        Completion::Partial
    );
}
