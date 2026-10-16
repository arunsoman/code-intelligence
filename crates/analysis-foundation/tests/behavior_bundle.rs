use analysis_foundation::{behavior::*, languages::*, semantic_ir::*, Completion, Effect};
use std::collections::{BTreeMap, BTreeSet};
fn lower(path: &str, source: &str) -> Lowered {
    RegistryAlias::builtins()
        .unwrap()
        .lower(&Request {
            path: path.into(),
            source: source.into(),
            revision: "r1".into(),
            environment_digest: "env1".into(),
        })
        .unwrap()
}
use analysis_foundation::behavior::Registry as Contracts;
use analysis_foundation::languages::Registry as RegistryAlias;
fn boolean(value: bool) -> Literal {
    Literal::Bool { value }
}
fn integer(value: i64) -> Literal {
    Literal::Integer {
        decimal: value.to_string(),
    }
}
fn provenance() -> Provenance {
    Provenance {
        authority: Authority::ApprovedSpecification,
        reference: "spec:authorization#1".into(),
        version: "v1".into(),
    }
}
fn function(l: &Lowered, name: &str) -> FunctionId {
    l.snapshot
        .functions
        .iter()
        .find(|(_, f)| {
            let bytes = &l.sources[&f.source.document];
            let source = std::str::from_utf8(
                &bytes[f.source.start_byte as usize..f.source.end_byte as usize],
            )
            .unwrap();
            source
                .split('{')
                .next()
                .unwrap()
                .contains(&format!("{name}("))
        })
        .unwrap()
        .0
        .clone()
}
fn registry(
    l: &Lowered,
    name: &str,
    domains: Vec<Vec<Literal>>,
    obligations: Vec<Obligation>,
) -> Contracts {
    Contracts {
        schema: analysis_foundation::behavior::SCHEMA.into(),
        revision: "r1".into(),
        environment_digest: "env1".into(),
        contracts: vec![Contract {
            id: "contract-1".into(),
            key: "auth".into(),
            label: None,
            function: function(l, name),
            provenance: provenance(),
            supersedes: BTreeSet::new(),
            domains,
            precondition: None,
            obligations,
        }],
        models: vec![],
    }
}
fn ensures_argument() -> Obligation {
    Obligation::Ensures {
        predicate: Predicate::Equal {
            left: Operand::Return,
            right: Operand::Argument { index: 0 },
        },
    }
}
fn required() -> Obligation {
    Obligation::RequiresEffect {
        effect: Effect::Write("authorization".into()),
        when: ReturnGuard::Bool { value: true },
    }
}
fn checked(l: &Lowered, r: &Contracts) -> Report {
    check(&l.snapshot, &l.sources, r, &Default::default()).unwrap()
}
fn model_opaque_and_calls(l: &Lowered, r: &mut Contracts, call_effects: Vec<Effect>) {
    for (id, f) in &l.snapshot.functions {
        for (bid, b) in &f.blocks {
            for i in &b.instructions {
                if let Action::Opaque { outputs, .. } = &i.action {
                    assert!(outputs.is_empty());
                    r.models.push(ExternalModel {
                        id: format!("lookup-{}", i.id.0),
                        location: Location {
                            function: id.clone(),
                            block: bid.clone(),
                            instruction: Some(i.id.clone()),
                        },
                        source: i.source.clone(),
                        provenance: provenance(),
                        outputs: BTreeMap::new(),
                        outcomes: vec![ModelOutcome::Return {
                            value: None,
                            effects: vec![],
                        }],
                    });
                }
            }
            if let Terminator::Invoke {
                call:
                    CallSite {
                        binding: Binding::Unresolved { .. },
                        ..
                    },
                result,
                ..
            } = &b.terminator
            {
                r.models.push(ExternalModel {
                    id: format!("call-{}", bid.0),
                    location: Location {
                        function: id.clone(),
                        block: bid.clone(),
                        instruction: None,
                    },
                    source: b.source.clone(),
                    provenance: provenance(),
                    outputs: BTreeMap::new(),
                    outcomes: vec![ModelOutcome::Return {
                        value: result.as_ref().map(|_| boolean(true)),
                        effects: call_effects.clone(),
                    }],
                });
            }
        }
    }
}
#[test]
fn unconditional_success_has_concrete_false_input_counterexample() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(boolean allowed){return true;}}",
    );
    let r = registry(
        &l,
        "authorize",
        vec![vec![boolean(false), boolean(true)]],
        vec![ensures_argument()],
    );
    let p = checked(&l, &r);
    let f = &p.findings[0];
    assert_eq!(f.conclusion, Conclusion::ViolatedWithinModel);
    assert_eq!(f.completion, Completion::CompleteWithinModel);
    assert_eq!(f.cases_started, 2);
    assert_eq!(f.counterexamples[0].arguments, vec![boolean(false)]);
    assert!(!f.counterexamples[0].trace.is_empty());
}
#[test]
fn faithful_delegation_is_satisfied_only_within_explicit_domain() {
    let l=lower("A.java","class A {private static boolean gate(boolean x){return x;} static boolean authorize(boolean allowed){return gate(allowed);}}");
    let r = registry(
        &l,
        "authorize",
        vec![vec![boolean(false), boolean(true)]],
        vec![ensures_argument()],
    );
    let p = checked(&l, &r);
    assert_eq!(p.findings[0].conclusion, Conclusion::SatisfiedWithinDomain);
    assert_eq!(p.findings[0].normal_paths, 2);
    assert!(p.findings[0]
        .assumptions
        .iter()
        .any(|s| s.contains("finite")));
}
#[test]
fn ignored_failure_result_is_reported_but_propagation_passes() {
    for (body, expected) in [
        ("gate();return true;", Conclusion::ViolatedWithinModel),
        ("return gate();", Conclusion::SatisfiedWithinDomain),
    ] {
        let l=lower("A.java",&"class A {private static boolean gate(){return false;} static boolean authorize(){BODY}}".replace("BODY",body));
        let r = registry(
            &l,
            "authorize",
            vec![],
            vec![Obligation::RequiresCallResult {
                target: function(&l, "gate"),
                accepted: boolean(true),
                when: ReturnGuard::Bool { value: true },
            }],
        );
        assert_eq!(checked(&l, &r).findings[0].conclusion, expected);
    }
}
#[test]
fn print_only_requires_explicit_models_and_never_name_based_effects() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){System.out.println(\"hello world\");return true;}}",
    );
    let mut r = registry(&l, "authorize", vec![], vec![required()]);
    assert_eq!(checked(&l, &r).findings[0].conclusion, Conclusion::Unknown);
    model_opaque_and_calls(&l, &mut r, vec![Effect::Emit("stdout".into())]);
    let p = checked(&l, &r);
    assert_eq!(p.findings[0].conclusion, Conclusion::ViolatedWithinModel);
    assert!(p.findings[0]
        .assumptions
        .iter()
        .any(|s| s.contains("external model")));
}
#[test]
fn authoritative_effect_model_satisfies_delegating_call() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){provider();return true;}}",
    );
    let mut r = registry(&l, "authorize", vec![], vec![required()]);
    model_opaque_and_calls(&l, &mut r, vec![Effect::Write("authorization".into())]);
    assert_eq!(
        checked(&l, &r).findings[0].conclusion,
        Conclusion::SatisfiedWithinDomain
    );
}
#[test]
fn unavailable_provider_is_unknown_not_missing_effect() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){provider();return true;}}",
    );
    let r = registry(&l, "authorize", vec![], vec![required()]);
    let p = checked(&l, &r);
    assert_eq!(p.findings[0].conclusion, Conclusion::Unknown);
    assert!(p.findings[0].counterexamples.is_empty());
}
#[test]
fn branch_bypass_has_replayable_true_path() {
    let l=lower("A.java","class A {static boolean authorize(boolean bypass){if(bypass){return true;}provider();return true;}}");
    let mut r = registry(
        &l,
        "authorize",
        vec![vec![boolean(false), boolean(true)]],
        vec![required()],
    );
    model_opaque_and_calls(&l, &mut r, vec![Effect::Write("authorization".into())]);
    let p = checked(&l, &r);
    assert_eq!(
        p.findings[0].counterexamples[0].arguments,
        vec![boolean(true)]
    );
}
#[test]
fn observed_test_and_hypothesis_never_certify_defect_or_correctness() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){return true;}}",
    );
    for authority in [Authority::TestObservation, Authority::Hypothesis] {
        let mut r = registry(&l, "authorize", vec![], vec![required()]);
        r.contracts[0].provenance.authority = authority;
        let p = checked(&l, &r);
        assert_eq!(p.findings[0].conclusion, Conclusion::Candidate);
        assert!(!p.findings[0].counterexamples.is_empty());
    }
}
#[test]
fn active_contract_conflict_is_unknown_until_explicit_supersession() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){return true;}}",
    );
    let mut r = registry(&l, "authorize", vec![], vec![required()]);
    let mut newer = r.contracts[0].clone();
    newer.id = "new".into();
    r.contracts.push(newer);
    assert!(checked(&l, &r)
        .findings
        .iter()
        .all(|f| f.conclusion == Conclusion::Unknown));
    r.contracts[1].supersedes.insert("contract-1".into());
    assert_eq!(checked(&l, &r).findings.len(), 1);
    r.contracts[1].provenance.authority = Authority::Hypothesis;
    assert!(check(&l.snapshot, &l.sources, &r, &Default::default()).is_err());
}
#[test]
fn registry_rejects_stale_binding_duplicate_ids_and_cycles() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){return true;}}",
    );
    let r = registry(&l, "authorize", vec![], vec![required()]);
    let mut bad = r.clone();
    bad.revision = "old".into();
    assert!(check(&l.snapshot, &l.sources, &bad, &Default::default()).is_err());
    let mut bad = r.clone();
    bad.contracts.push(bad.contracts[0].clone());
    assert!(check(&l.snapshot, &l.sources, &bad, &Default::default()).is_err());
    let mut bad = r.clone();
    let mut other = bad.contracts[0].clone();
    other.id = "other".into();
    other.supersedes.insert("contract-1".into());
    bad.contracts[0].supersedes.insert("other".into());
    bad.contracts.push(other);
    assert!(check(&l.snapshot, &l.sources, &bad, &Default::default()).is_err());
}
#[test]
fn labels_do_not_change_semantic_identity() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){return true;}}",
    );
    let mut r = registry(&l, "authorize", vec![], vec![required()]);
    let first = checked(&l, &r).findings[0].semantic_digest.clone();
    r.contracts[0].label = Some("LLM supplied name".into());
    assert_eq!(checked(&l, &r).findings[0].semantic_digest, first);
}
#[test]
fn work_domain_call_depth_and_trace_limits_are_not_success() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(boolean x){return x;}}",
    );
    let r = registry(
        &l,
        "authorize",
        vec![vec![boolean(false), boolean(true)]],
        vec![ensures_argument()],
    );
    for b in [
        Budget {
            max_cases: 1,
            ..Default::default()
        },
        Budget {
            max_steps: 0,
            ..Default::default()
        },
        Budget {
            max_trace_events: 1,
            ..Default::default()
        },
        Budget {
            max_path_steps: 0,
            ..Default::default()
        },
    ] {
        let p = check(&l.snapshot, &l.sources, &r, &b).unwrap();
        assert_eq!(p.findings[0].completion, Completion::BudgetExhausted);
        assert_ne!(p.findings[0].conclusion, Conclusion::SatisfiedWithinDomain);
    }
    let l=lower("A.java","class A {private static boolean gate(){return gate();}static boolean authorize(){return gate();}}");
    let r = registry(&l, "authorize", vec![], vec![required()]);
    let p = check(
        &l.snapshot,
        &l.sources,
        &r,
        &Budget {
            max_call_depth: 3,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(p.findings[0].completion, Completion::BudgetExhausted);
}
#[test]
fn finite_domain_does_not_generalize_and_empty_precondition_is_not_vacuous_proof() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(boolean x){return true;}}",
    );
    let mut r = registry(
        &l,
        "authorize",
        vec![vec![boolean(true)]],
        vec![ensures_argument()],
    );
    assert_eq!(
        checked(&l, &r).findings[0].conclusion,
        Conclusion::SatisfiedWithinDomain
    );
    r.contracts[0].precondition = Some(Predicate::Equal {
        left: Operand::Argument { index: 0 },
        right: Operand::Literal {
            value: boolean(false),
        },
    });
    assert_eq!(checked(&l, &r).findings[0].conclusion, Conclusion::Unknown);
}
#[test]
fn java_i32_overflow_has_language_correct_wrapping() {
    let l = lower("A.java", "class A {static int add(int x){return x+1;}}");
    let r = registry(
        &l,
        "add",
        vec![vec![integer(i32::MAX as i64)]],
        vec![Obligation::Ensures {
            predicate: Predicate::Equal {
                left: Operand::Return,
                right: Operand::Literal {
                    value: integer(i32::MIN as i64),
                },
            },
        }],
    );
    assert_eq!(
        checked(&l, &r).findings[0].conclusion,
        Conclusion::SatisfiedWithinDomain
    );
}
#[test]
fn javascript_nan_is_not_equal_to_itself() {
    let l = lower(
        "a.ts",
        "function authorize(x:number):boolean{return x === x;}",
    );
    // Typed TS annotation makes the finite runtime-input assumption explicit.
    let l = if l
        .snapshot
        .functions
        .values()
        .next()
        .unwrap()
        .parameters
        .is_empty()
    {
        l
    } else {
        lower(
            "a.ts",
            "function authorize(x:number):boolean{return x === x;}",
        )
    };
    let nan = Literal::FloatBits {
        hex: "7ff8000000000000".into(),
    };
    let r = registry(
        &l,
        "authorize",
        vec![vec![nan]],
        vec![Obligation::Ensures {
            predicate: Predicate::Equal {
                left: Operand::Return,
                right: Operand::Literal {
                    value: boolean(false),
                },
            },
        }],
    );
    assert_eq!(
        checked(&l, &r).findings[0].conclusion,
        Conclusion::SatisfiedWithinDomain
    );
}
#[test]
fn candidates_are_bounded_unverified_and_do_not_invent_rules() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(int x){if(x<0){return false;}return true;}}",
    );
    let c = candidates::extract(&l.snapshot, 1);
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].validation, "unverified");
    assert!(c[0].observation_scope.contains("no execution"));
    let r = registry(
        &l,
        "authorize",
        vec![vec![integer(-1)]],
        vec![Obligation::Ensures {
            predicate: Predicate::Equal {
                left: Operand::Return,
                right: Operand::Literal {
                    value: boolean(false),
                },
            },
        }],
    );
    assert!(checked(&l, &r).candidates.iter().any(|c| c.kind == "guard"));
}
#[test]
fn malformed_registry_and_wrong_predicate_types_are_rejected() {
    assert!(Contracts::parse(br#"{"schema":"x","extra":true}"#).is_err());
    let l = lower(
        "A.java",
        "class A {static boolean authorize(boolean x){return x;}}",
    );
    let mut r = registry(
        &l,
        "authorize",
        vec![vec![boolean(true)]],
        vec![ensures_argument()],
    );
    r.contracts[0].domains = vec![vec![integer(1)]];
    assert!(check(&l.snapshot, &l.sources, &r, &Default::default()).is_err());
    r.contracts[0].domains = vec![vec![boolean(true)]];
    r.contracts[0].precondition = Some(Predicate::Equal {
        left: Operand::Return,
        right: Operand::Literal {
            value: boolean(true),
        },
    });
    assert!(check(&l.snapshot, &l.sources, &r, &Default::default()).is_err());
}

fn catching_fixture(success: bool) -> (Lowered, Contracts) {
    let mut l=lower("A.java","class A {private static boolean gate(){return false;} static boolean authorize(){return gate();}}");
    let gate = function(&l, "gate");
    let auth = function(&l, "authorize");
    let f = l.snapshot.functions.get_mut(&gate).unwrap();
    f.blocks
        .values_mut()
        .find(|b| matches!(b.terminator, Terminator::Return { .. }))
        .unwrap()
        .terminator = Terminator::Raise { value: None };
    let f = l.snapshot.functions.get_mut(&auth).unwrap();
    let source = f.source.clone();
    f.blocks
        .values_mut()
        .find_map(|b| {
            if let Terminator::Invoke { exceptional, .. } = &mut b.terminator {
                *exceptional = ExceptionalExit::Block {
                    target: "handler".into(),
                };
                Some(())
            } else {
                None
            }
        })
        .unwrap();
    let v: ValueId = "handler-result".into();
    f.values.insert(v.clone(), Type::Bool);
    f.blocks.insert(
        "handler".into(),
        Block {
            instructions: vec![Instruction {
                id: "handler-value".into(),
                source: source.clone(),
                exceptional: None,
                action: Action::Constant {
                    result: v.clone(),
                    literal: boolean(success),
                },
            }],
            terminator: Terminator::Return { value: Some(v) },
            source,
        },
    );
    let r = registry(
        &l,
        "authorize",
        vec![],
        vec![Obligation::NoExceptionToSuccess { success: true }],
    );
    (l, r)
}
#[test]
fn ir_exception_to_success_is_detected_while_safe_failure_passes() {
    for (success, expected) in [
        (true, Conclusion::ViolatedWithinModel),
        (false, Conclusion::SatisfiedWithinDomain),
    ] {
        let (l, r) = catching_fixture(success);
        let p = checked(&l, &r);
        assert_eq!(p.findings[0].conclusion, expected);
        if success {
            assert!(p.findings[0].counterexamples[0]
                .trace
                .iter()
                .any(|e| matches!(e.event, EventKind::Exception { handled: true })));
        }
    }
}
#[test]
fn exceptional_continuation_cannot_consume_a_missing_call_result() {
    let (mut l, r) = catching_fixture(true);
    let id = function(&l, "authorize");
    let f = l.snapshot.functions.get_mut(&id).unwrap();
    let normal = f
        .blocks
        .values()
        .find_map(|b| {
            if let Terminator::Invoke { normal, .. } = &b.terminator {
                Some(normal.clone())
            } else {
                None
            }
        })
        .unwrap();
    for b in f.blocks.values_mut() {
        if let Terminator::Invoke { exceptional, .. } = &mut b.terminator {
            *exceptional = ExceptionalExit::Block {
                target: normal.clone(),
            };
        }
    }
    let p = checked(&l, &r);
    assert_eq!(p.findings[0].conclusion, Conclusion::Unknown);
    assert!(p.findings[0].gaps.iter().any(|g| g.contains("unavailable")));
}
#[test]
fn effect_sequence_checks_order_and_source_provenance() {
    for (order, expected) in [
        (vec!["debit", "deliver"], Conclusion::SatisfiedWithinDomain),
        (vec!["deliver", "debit"], Conclusion::ViolatedWithinModel),
    ] {
        let mut l = lower(
            "A.java",
            "class A {static boolean authorize(){return true;}}",
        );
        let f = l.snapshot.functions.values_mut().next().unwrap();
        let b = f.blocks.values_mut().next().unwrap();
        let value = match &b.instructions[0].action {
            Action::Constant { result, .. } => result.clone(),
            _ => panic!(),
        };
        for (n, resource) in order.iter().enumerate() {
            b.instructions.push(Instruction {
                id: InstructionId(format!("effect-{n}")),
                source: b.source.clone(),
                exceptional: None,
                action: Action::Write {
                    resource: ResourceId((*resource).into()),
                    value: value.clone(),
                },
            })
        }
        let r = registry(
            &l,
            "authorize",
            vec![],
            vec![Obligation::OrderedEffects {
                first: Effect::Write("debit".into()),
                then: Effect::Write("deliver".into()),
            }],
        );
        let p = checked(&l, &r);
        assert_eq!(p.findings[0].conclusion, expected);
        assert!(p.findings[0]
            .counterexamples
            .iter()
            .flat_map(|ce| &ce.trace)
            .all(|e| e.source.start_byte < e.source.end_byte));
    }
}
#[test]
fn nondeterministic_external_outcomes_and_frontier_limits_are_explicit() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){return provider();}}",
    );
    let mut r = registry(&l, "authorize", vec![], vec![required()]);
    model_opaque_and_calls(&l, &mut r, vec![Effect::Write("authorization".into())]);
    let call = r
        .models
        .iter_mut()
        .find(|m| m.location.instruction.is_none())
        .unwrap();
    call.outcomes.push(ModelOutcome::Return {
        value: Some(boolean(true)),
        effects: vec![],
    });
    let p = checked(&l, &r);
    assert_eq!(p.findings[0].normal_paths, 2);
    assert_eq!(p.findings[0].conclusion, Conclusion::ViolatedWithinModel);
    let p = check(
        &l.snapshot,
        &l.sources,
        &r,
        &Budget {
            max_pending_paths: 1,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(p.findings[0].completion, Completion::BudgetExhausted);
}
#[test]
fn untrusted_stale_and_mistyped_models_are_rejected() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){return provider();}}",
    );
    let mut r = registry(&l, "authorize", vec![], vec![required()]);
    model_opaque_and_calls(&l, &mut r, vec![]);
    let mut bad = r.clone();
    bad.models[0].provenance.authority = Authority::TestObservation;
    assert!(check(&l.snapshot, &l.sources, &bad, &Default::default()).is_err());
    let mut bad = r.clone();
    bad.models[0].source.start_byte += 1;
    assert!(check(&l.snapshot, &l.sources, &bad, &Default::default()).is_err());
    let call = r
        .models
        .iter_mut()
        .find(|m| m.location.instruction.is_none())
        .unwrap();
    call.outcomes = vec![ModelOutcome::Return {
        value: Some(integer(3)),
        effects: vec![],
    }];
    assert!(check(&l.snapshot, &l.sources, &r, &Default::default()).is_err());
}
#[test]
fn infeasible_boolean_branch_does_not_produce_counterexample() {
    let l=lower("A.java","class A {static boolean authorize(boolean allowed){if(allowed){if(!allowed){return false;}return true;}return false;}}");
    let r = registry(
        &l,
        "authorize",
        vec![vec![boolean(false), boolean(true)]],
        vec![ensures_argument()],
    );
    let p = checked(&l, &r);
    assert_eq!(p.findings[0].conclusion, Conclusion::SatisfiedWithinDomain);
    assert!(p.findings[0].counterexamples.is_empty());
}
#[test]
fn branch_joins_are_unknown_and_never_fabricated_witnesses() {
    let l=lower("A.java","class A {static boolean authorize(boolean allowed){boolean result=false;if(allowed){result=true;}return result;}}");
    let r = registry(
        &l,
        "authorize",
        vec![vec![boolean(false), boolean(true)]],
        vec![ensures_argument()],
    );
    assert_eq!(checked(&l, &r).findings[0].conclusion, Conclusion::Unknown);
}
#[test]
fn counterexample_survives_exhaustion_of_later_cases() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(boolean allowed){return true;}}",
    );
    let r = registry(
        &l,
        "authorize",
        vec![vec![boolean(false), boolean(true)]],
        vec![ensures_argument()],
    );
    let p = check(
        &l.snapshot,
        &l.sources,
        &r,
        &Budget {
            max_cases: 1,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(p.findings[0].completion, Completion::BudgetExhausted);
    assert_eq!(p.findings[0].conclusion, Conclusion::ViolatedWithinModel);
}
#[test]
fn normal_return_contract_does_not_certify_exception_only_function() {
    let (mut l, r) = catching_fixture(false);
    let auth = function(&l, "authorize");
    let f = l.snapshot.functions.get_mut(&auth).unwrap();
    for b in f.blocks.values_mut() {
        if let Terminator::Invoke { exceptional, .. } = &mut b.terminator {
            *exceptional = ExceptionalExit::Propagate;
        }
    }
    let p = checked(&l, &r);
    assert_eq!(p.findings[0].exceptional_paths, 1);
    assert_eq!(p.findings[0].conclusion, Conclusion::Unknown);
}
#[test]
fn source_oracles_independently_confirm_return_counterexample_and_delegation() {
    use std::process::Command;
    let js=Command::new("node").arg("-e").arg("function authorize(x){return true;}console.log(JSON.stringify([authorize(false),authorize(true)]));").output().unwrap();
    assert!(js.status.success());
    assert_eq!(String::from_utf8(js.stdout).unwrap().trim(), "[true,true]");
    let dir = std::env::temp_dir().join(format!("cie-behavior-oracle-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("A.java");
    std::fs::write(&path,"class A {private static boolean gate(boolean x){return x;}static boolean authorize(boolean x){return gate(x);}public static void main(String[]args){System.out.println(authorize(false)+\",\"+authorize(true));}}").unwrap();
    let java = Command::new("java").arg(&path).output().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    assert!(
        java.status.success(),
        "{}",
        String::from_utf8_lossy(&java.stderr)
    );
    assert_eq!(String::from_utf8(java.stdout).unwrap().trim(), "false,true");
}

#[test]
fn hypothesis_cannot_block_authoritative_contract_by_sharing_its_key() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){return true;}}",
    );
    let mut r = registry(&l, "authorize", vec![], vec![required()]);
    let mut hypothesis = r.contracts[0].clone();
    hypothesis.id = "hypothesis".into();
    hypothesis.provenance.authority = Authority::Hypothesis;
    r.contracts.push(hypothesis);
    let p = checked(&l, &r);
    assert_eq!(p.findings[0].conclusion, Conclusion::ViolatedWithinModel);
    assert_eq!(p.findings[1].conclusion, Conclusion::Candidate);
}
#[test]
fn evidence_limits_are_explicit_and_do_not_certify_unrecorded_witnesses() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){return true;}}",
    );
    let r = registry(&l, "authorize", vec![], vec![required()]);
    for b in [
        Budget {
            max_counterexamples: 0,
            ..Default::default()
        },
        Budget {
            max_saved_events: 0,
            ..Default::default()
        },
    ] {
        let p = check(&l.snapshot, &l.sources, &r, &b).unwrap();
        let f = &p.findings[0];
        assert_eq!(f.violations_observed, 1);
        assert!(f.counterexamples_truncated);
        assert_eq!(f.completion, Completion::BudgetExhausted);
        assert_eq!(f.conclusion, Conclusion::Unknown);
    }
}
#[test]
fn global_evidence_budget_is_shared_across_contracts() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){return true;}}",
    );
    let mut r = registry(&l, "authorize", vec![], vec![required()]);
    let size = checked(&l, &r).findings[0].counterexamples[0].trace.len();
    let mut second = r.contracts[0].clone();
    second.id = "second".into();
    second.key = "other".into();
    r.contracts.push(second);
    let p = check(
        &l.snapshot,
        &l.sources,
        &r,
        &Budget {
            max_saved_events: size,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(p.findings[0].conclusion, Conclusion::ViolatedWithinModel);
    assert_eq!(p.findings[1].conclusion, Conclusion::Unknown);
    assert!(p.findings[1].counterexamples_truncated);
}
#[test]
fn noncanonical_literals_and_out_of_range_domain_values_are_rejected() {
    let l = lower("A.java", "class A {static int authorize(int x){return x;}}");
    let mut r = registry(
        &l,
        "authorize",
        vec![vec![integer(0)]],
        vec![ensures_argument()],
    );
    for decimal in ["-0", "2147483648", "+1"] {
        r.contracts[0].domains[0] = vec![Literal::Integer {
            decimal: decimal.into(),
        }];
        assert!(check(&l.snapshot, &l.sources, &r, &Default::default()).is_err());
    }
}
#[test]
fn stale_source_is_rejected_before_contract_execution() {
    let (mut l, r) = catching_fixture(true);
    l.sources.values_mut().next().unwrap().push(b' ');
    assert!(check(&l.snapshot, &l.sources, &r, &Default::default()).is_err());
}

#[test]
fn model_output_maps_reject_repeated_json_keys() {
    let raw=br#"{"schema":"cie.behavior-contracts.v1","revision":"r1","environmentDigest":"env1","contracts":[],"models":[{"id":"m","location":{"function":"f","block":"b","instruction":"i"},"source":{"document":"d","startByte":0,"endByte":1},"provenance":{"authority":"approvedSpecification","reference":"spec","version":"1"},"outputs":{"v":{"kind":"bool","value":true},"v":{"kind":"bool","value":false}},"outcomes":[] }]}"#;
    assert!(Contracts::parse(raw)
        .unwrap_err()
        .contains("duplicate semantic IR map identity"));
}
#[test]
fn conflict_context_changes_semantic_digest_but_labels_do_not() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){return true;}}",
    );
    let mut r = registry(&l, "authorize", vec![], vec![required()]);
    let before = checked(&l, &r).findings[0].semantic_digest.clone();
    let mut second = r.contracts[0].clone();
    second.id = "second".into();
    r.contracts.push(second);
    assert_ne!(checked(&l, &r).findings[0].semantic_digest, before);
    let before = checked(&l, &r).findings[0].semantic_digest.clone();
    r.contracts[1].label = Some("renamed label".into());
    assert_eq!(checked(&l, &r).findings[0].semantic_digest, before);
}
#[test]
fn binary32_rounding_and_signed_zero_have_ieee_semantics() {
    // Manually supplied IR tests binary32 arithmetic; source Java float lowering is not claimed.
    let mut l = lower("a.ts", "function add(x:number):number{return x+x;}");
    for f in l.snapshot.functions.values_mut() {
        f.return_type = Type::Float {
            format: FloatFormat::Binary32,
        };
        for ty in f.values.values_mut() {
            if matches!(ty, Type::Float { .. }) {
                *ty = Type::Float {
                    format: FloatFormat::Binary32,
                };
            }
        }
    }
    let one = Literal::FloatBits {
        hex: format!("{:08x}", 1f32.to_bits()),
    };
    let two = Literal::FloatBits {
        hex: format!("{:08x}", 2f32.to_bits()),
    };
    let r = registry(
        &l,
        "add",
        vec![vec![one]],
        vec![Obligation::Ensures {
            predicate: Predicate::Equal {
                left: Operand::Return,
                right: Operand::Literal { value: two },
            },
        }],
    );
    assert_eq!(
        checked(&l, &r).findings[0].conclusion,
        Conclusion::SatisfiedWithinDomain
    );
    let l = lower(
        "a.ts",
        "function authorize(x:number):boolean{return x === 0;}",
    );
    let zero = Literal::FloatBits {
        hex: format!("{:016x}", (-0f64).to_bits()),
    };
    let r = registry(
        &l,
        "authorize",
        vec![vec![zero]],
        vec![Obligation::Ensures {
            predicate: Predicate::Equal {
                left: Operand::Return,
                right: Operand::Literal {
                    value: boolean(true),
                },
            },
        }],
    );
    assert_eq!(
        checked(&l, &r).findings[0].conclusion,
        Conclusion::SatisfiedWithinDomain
    );
}

#[test]
fn handled_raise_is_a_represented_effect_with_provenance() {
    let (l, mut r) = catching_fixture(false);
    r.contracts[0].obligations = vec![Obligation::RequiresEffect {
        effect: Effect::Raise,
        when: ReturnGuard::Always,
    }];
    assert_eq!(
        checked(&l, &r).findings[0].conclusion,
        Conclusion::SatisfiedWithinDomain
    );
}
#[test]
fn protocol_order_is_checked_on_exceptional_completed_paths_too() {
    let (mut l, mut r) = catching_fixture(false);
    let auth = function(&l, "authorize");
    let f = l.snapshot.functions.get_mut(&auth).unwrap();
    for b in f.blocks.values_mut() {
        if let Terminator::Invoke { exceptional, .. } = &mut b.terminator {
            *exceptional = ExceptionalExit::Propagate;
        }
    }
    r.contracts[0].obligations = vec![Obligation::OrderedEffects {
        first: Effect::Write("required-before-raise".into()),
        then: Effect::Raise,
    }];
    let p = checked(&l, &r);
    assert_eq!(p.findings[0].conclusion, Conclusion::ViolatedWithinModel);
    assert_eq!(p.findings[0].exceptional_paths, 1);
}

#[test]
fn conflicting_hypotheses_remain_unverified_candidates() {
    let l = lower(
        "A.java",
        "class A {static boolean authorize(){return true;}}",
    );
    let mut r = registry(&l, "authorize", vec![], vec![required()]);
    r.contracts[0].provenance.authority = Authority::Hypothesis;
    let mut second = r.contracts[0].clone();
    second.id = "second".into();
    r.contracts.push(second);
    let p = checked(&l, &r);
    assert!(p
        .findings
        .iter()
        .all(|f| f.conclusion == Conclusion::Candidate && f.completion == Completion::Partial));
}
