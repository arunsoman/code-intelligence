use analysis_foundation::{languages::*, semantic_ir::*};
use std::{collections::BTreeMap, process::Command};
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
fn only(result: &Lowered) -> &Function {
    assert_eq!(result.snapshot.functions.len(), 1);
    result.snapshot.functions.values().next().unwrap()
}
fn invoke_count(f: &Function) -> usize {
    f.blocks
        .values()
        .filter(|b| matches!(b.terminator, Terminator::Invoke { .. }))
        .count()
}

#[test]
fn unknown_provider_return_is_an_invoke_not_success() {
    let result = lower(
        "a.ts",
        "function authorize(payment: number): boolean { return provider.authorize(payment); }",
    );
    let f = only(&result);
    assert_eq!(invoke_count(f), 1);
    let Terminator::Invoke {
        call,
        normal,
        exceptional,
        result: value,
    } = &f.blocks[&f.entry].terminator
    else {
        panic!()
    };
    assert!(matches!(call.binding, Binding::Unresolved { .. }));
    assert!(matches!(exceptional, ExceptionalExit::Propagate));
    assert_eq!(f.values[value.as_ref().unwrap()], Type::Bool);
    assert!(matches!(
        f.blocks[normal].terminator,
        Terminator::Return { .. }
    ));
    assert!(result
        .snapshot
        .documents
        .values()
        .next()
        .unwrap()
        .gaps
        .iter()
        .any(|g| g.reason.contains("outcome are not established")));
}

#[test]
fn print_only_java_preserves_call_and_discarded_result() {
    let result = lower(
        "A.java",
        "class A { void authorize(){ System.out.println(\"hello world\"); } }",
    );
    let f = only(&result);
    assert_eq!(invoke_count(f), 1);
    let Terminator::Invoke { result, call, .. } = &f.blocks[&f.entry].terminator else {
        panic!()
    };
    assert!(result.is_none());
    assert!(matches!(call.binding, Binding::Unresolved { .. }));
    assert_eq!(call.arguments.len(), 1);
    assert_eq!(f.return_type, Type::Unit);
}

#[test]
fn java_unique_private_static_delegation_resolves_to_actual_identity() {
    let result=lower("A.java","class A { private static int helper(int x){return x+1;} static int value(int x){return helper(x);} }");
    let f = result
        .snapshot
        .functions
        .values()
        .find(|f| invoke_count(f) > 0)
        .unwrap();
    let Terminator::Invoke { call, .. } = &f.blocks[&f.entry].terminator else {
        panic!()
    };
    let Binding::Resolved { targets, .. } = &call.binding else {
        panic!("expected private static binding")
    };
    assert_eq!(targets.len(), 1);
    assert!(result
        .snapshot
        .functions
        .contains_key(targets.first().unwrap()));
    result.snapshot.validate(&result.sources).unwrap();
}

#[test]
fn java_overloads_virtual_and_explicit_receivers_remain_unresolved() {
    for source in [
        "class A { private static int helper(int x){return x;} private static long helper(long x){return x;} static int value(int x){return helper(x);} }",
        "class A { int helper(int x){return x;} int value(int x){return helper(x);} }",
        "class A { private static int helper(int x){return x;} int value(int x){return this.helper(x);} }",
    ] {
        let result=lower("A.java",source);
        assert!(result.snapshot.functions.values().flat_map(|f|f.blocks.values()).filter_map(|b|match &b.terminator {Terminator::Invoke {call,..}=>Some(call),_=>None}).all(|c|matches!(c.binding,Binding::Unresolved {..})));
        assert!(result.snapshot.functions.values().any(|f|invoke_count(f)>0));
    }
}

#[test]
fn javascript_local_shadowing_and_rebinding_never_resolve_by_name() {
    let result = lower(
        "a.js",
        "function helper(){return true;} function value(helper){return helper();}",
    );
    assert!(result
        .snapshot
        .functions
        .values()
        .flat_map(|f| f.blocks.values())
        .filter_map(|b| match &b.terminator {
            Terminator::Invoke { call, .. } => Some(call),
            _ => None,
        })
        .all(|c| matches!(c.binding, Binding::Unresolved { .. })));
}

#[test]
fn nested_calls_preserve_lookup_and_argument_order() {
    let source = "function value(){return obj.authorize(arg());}";
    let result = lower("a.js", source);
    let f = only(&result);
    assert_eq!(invoke_count(f), 2);
    let entry = &f.blocks[&f.entry];
    assert_eq!(entry.instructions.len(), 2);
    let texts: Vec<_> = entry
        .instructions
        .iter()
        .map(|i| &source[i.source.start_byte as usize..i.source.end_byte as usize])
        .collect();
    assert_eq!(texts, vec!["obj.authorize", "arg"]);
    let Terminator::Invoke {
        call: inner,
        normal,
        ..
    } = &entry.terminator
    else {
        panic!()
    };
    let Binding::Unresolved { evidence, .. } = &inner.binding else {
        panic!()
    };
    assert_eq!(
        &source[evidence.start_byte as usize..evidence.end_byte as usize],
        "arg()"
    );
    assert!(matches!(
        f.blocks[normal].terminator,
        Terminator::Invoke { .. }
    ));
    assert!(entry
        .instructions
        .iter()
        .all(|i| matches!(i.exceptional, Some(ExceptionalExit::Propagate))));
}

#[test]
fn multiple_calls_keep_distinct_values_and_continuations() {
    let result = lower(
        "a.ts",
        "function value(): number { let x: number = first(); x = second(x); return x; }",
    );
    let f = only(&result);
    assert_eq!(invoke_count(f), 2);
    result.snapshot.validate(&result.sources).unwrap();
    let outputs: Vec<_> = f
        .blocks
        .values()
        .filter_map(|b| match &b.terminator {
            Terminator::Invoke { result, .. } => result.as_ref(),
            _ => None,
        })
        .collect();
    assert_eq!(outputs.len(), 2);
    assert_ne!(outputs[0], outputs[1]);
}

#[test]
fn optional_spread_and_exception_handlers_are_not_unconditional_calls() {
    for source in [
        "function value(){return obj?.authorize();}",
        "function value(){return authorize(...args);}",
        "function value(){try{return authorize();}catch(e){return false;}}",
    ] {
        let result = lower("a.js", source);
        assert_eq!(invoke_count(only(&result)), 0);
        assert!(matches!(
            only(&result).blocks[&only(&result).entry].terminator,
            Terminator::Opaque { .. }
        ));
    }
}

#[test]
fn invalid_arity_and_promotions_do_not_create_false_resolved_bindings() {
    let narrow=lower("A.java","class A { private static int helper(byte x){return 7;} static int value(){return helper(1);} }");
    assert!(narrow
        .snapshot
        .functions
        .values()
        .flat_map(|f| f.blocks.values())
        .filter_map(|b| match &b.terminator {
            Terminator::Invoke { call, .. } => Some(call),
            _ => None,
        })
        .all(|c| matches!(c.binding, Binding::Unresolved { .. })));
    let result=lower("A.java","class A { private static long helper(long x){return x;} static long value(int x){return helper(x);} }");
    assert!(result
        .snapshot
        .functions
        .values()
        .flat_map(|f| f.blocks.values())
        .filter_map(|b| match &b.terminator {
            Terminator::Invoke { call, .. } => Some(call),
            _ => None,
        })
        .all(|c| matches!(c.binding, Binding::Unresolved { .. })));
    let result=lower("A.java","class A { private static int helper(int x){return x;} static int value(){return helper();} }");
    assert!(result
        .snapshot
        .functions
        .values()
        .flat_map(|f| f.blocks.values())
        .filter_map(|b| match &b.terminator {
            Terminator::Invoke { call, .. } => Some(call),
            _ => None,
        })
        .all(|c| matches!(c.binding, Binding::Unresolved { .. })));
}

#[test]
fn unresolved_throwing_call_has_no_normal_result_on_exception_edge() {
    let result = lower("a.ts", "function value(): number { return provider(); }");
    let f = only(&result);
    let Terminator::Invoke {
        result: Some(value),
        normal,
        exceptional,
        ..
    } = &f.blocks[&f.entry].terminator
    else {
        panic!()
    };
    assert!(matches!(exceptional, ExceptionalExit::Propagate));
    assert_eq!(
        f.blocks[normal].terminator,
        Terminator::Return {
            value: Some(value.clone())
        }
    );
}

// Test-only bounded execution for resolved int calls, independent of production lowering.
fn execute(snapshot: &Snapshot, id: &FunctionId, args: Vec<i64>, fuel: &mut usize) -> Option<i64> {
    if *fuel == 0 {
        return None;
    }
    *fuel -= 1;
    let f = &snapshot.functions[id];
    let mut values: BTreeMap<_, _> = f.parameters.iter().cloned().zip(args).collect();
    let mut block = f.entry.clone();
    loop {
        if *fuel == 0 {
            return None;
        }
        *fuel -= 1;
        for i in &f.blocks[&block].instructions {
            let (out, value) = match &i.action {
                Action::Constant {
                    result,
                    literal: Literal::Integer { decimal },
                } => (result, decimal.parse().ok()?),
                Action::Binary {
                    result,
                    left,
                    right,
                    operator: BinaryOp::Add,
                } => (
                    result,
                    i64::from((values[left] as i32).wrapping_add(values[right] as i32)),
                ),
                Action::Copy { result, operand } => (result, values[operand]),
                _ => return None,
            };
            values.insert(out.clone(), value);
        }
        match &f.blocks[&block].terminator {
            Terminator::Return { value: Some(v) } => return values.get(v).copied(),
            Terminator::Invoke {
                result,
                call:
                    CallSite {
                        arguments,
                        binding: Binding::Resolved { targets, .. },
                    },
                normal,
                ..
            } => {
                let args = arguments.iter().map(|v| values[v]).collect();
                let value = execute(snapshot, targets.first()?, args, fuel)?;
                if let Some(v) = result {
                    values.insert(v.clone(), value);
                }
                block = normal.clone();
            }
            _ => return None,
        }
    }
}

#[test]
fn resolved_java_delegation_agrees_with_actual_source_execution() {
    let source="class CallsOracle { private static int inc(int x){return x+1;} static int value(int x){int y=inc(x);return inc(y);} public static void main(String[] args){System.out.println(value(40));} }";
    let result = lower("CallsOracle.java", source);
    let id = result
        .snapshot
        .functions
        .iter()
        .find(|(_, f)| {
            source[f.source.start_byte as usize..f.source.end_byte as usize]
                .starts_with("static int value")
        })
        .unwrap()
        .0;
    assert_eq!(execute(&result.snapshot, id, vec![40], &mut 100), Some(42));
    let dir = std::env::temp_dir().join(format!("cie-calls-java-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("CallsOracle.java");
    std::fs::write(&path, source).unwrap();
    let output = Command::new("java").arg(&path).output().unwrap();
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(dir).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "42");
}

#[test]
fn getter_and_nested_argument_source_order_matches_ir_phase_order() {
    let script="let trace=[]; let obj={get authorize(){trace.push('lookup');return x=>{trace.push('call');return x;};}};function arg(){trace.push('arg');return 7;}function value(){return obj.authorize(arg());}value();console.log(trace.join(','));";
    let output = Command::new("node").args(["-e", script]).output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "lookup,arg,call"
    );
    let result = lower("a.js", "function value(){return obj.authorize(arg());}");
    assert_eq!(invoke_count(only(&result)), 2);
}

#[test]
fn unresolved_callee_is_not_executed_by_test_interpreter() {
    let result = lower(
        "A.java",
        "class A { static int value(){return unavailable();} }",
    );
    let id = result.snapshot.functions.keys().next().unwrap();
    assert_eq!(execute(&result.snapshot, id, vec![], &mut 100), None);
}

#[test]
fn direct_eval_cannot_leave_an_old_local_constant_as_a_fact() {
    let source = "function value(){let x=1;eval('x=2');return x;}";
    // Single-quoted strings are outside the literal subset, so use supported quotes.
    let source = source.replace("'x=2'", "\"x=2\"");
    let result = lower("a.js", &source);
    let f = only(&result);
    assert_eq!(invoke_count(f), 1);
    let returned = f
        .blocks
        .values()
        .find_map(|b| match &b.terminator {
            Terminator::Return { value: Some(v) } => Some(v),
            _ => None,
        })
        .unwrap();
    assert!(matches!(f.values[returned], Type::Opaque { .. }));
    let output = Command::new("node")
        .args(["-e", &format!("{source};console.log(value());")])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "2");
}

#[test]
fn receiver_lookup_can_invalidate_argument_locals_before_call() {
    let result = lower("a.js", "function value(obj,x){return obj.authorize(x);}");
    let f = only(&result);
    let Terminator::Invoke { call, .. } = &f.blocks[&f.entry].terminator else {
        panic!()
    };
    assert_ne!(call.arguments[0], f.parameters[1]);
    let Action::Opaque { inputs, .. } = &f.blocks[&f.entry].instructions[0].action else {
        panic!()
    };
    assert!(inputs.contains(&f.parameters[0]));
    assert!(matches!(f.values[&call.arguments[0]], Type::Opaque { .. }));
}

#[test]
fn binding_to_an_opaque_body_does_not_prove_success() {
    let source =
        "class A { private static int helper(){return 1/0;} static int value(){return helper();} }";
    let result = lower("A.java", source);
    let (id, _) = result
        .snapshot
        .functions
        .iter()
        .find(|(_, f)| invoke_count(f) > 0)
        .unwrap();
    assert_eq!(execute(&result.snapshot, id, vec![], &mut 100), None);
}
