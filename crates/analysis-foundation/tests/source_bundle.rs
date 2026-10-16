use analysis_foundation::{languages::*, semantic_ir::*, source_analysis as analysis, Completion};
use std::{
    collections::BTreeMap,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static FILE: AtomicU64 = AtomicU64::new(0);
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
fn report(result: &Lowered) -> analysis::Report {
    analysis::analyze(&result.snapshot, &result.sources, &Default::default()).unwrap()
}
fn only(result: &Lowered) -> &Function {
    assert_eq!(result.snapshot.functions.len(), 1);
    result.snapshot.functions.values().next().unwrap()
}

// Bounded test interpreter for exact branch paths; opaque/approximate regions are refused.
#[derive(Clone, Debug, PartialEq)]
enum V {
    N(f64),
    I(i64),
    B(bool),
}
fn run(result: &Lowered, arguments: Vec<V>) -> Result<V, String> {
    let f = only(result);
    let mut values: BTreeMap<_, _> = f.parameters.iter().cloned().zip(arguments).collect();
    let mut block = f.entry.clone();
    for _ in 0..1000 {
        for i in &f.blocks[&block].instructions {
            let (id, value) = match &i.action {
                Action::Constant { result, literal } => (
                    result,
                    match literal {
                        Literal::Integer { decimal } => V::I(decimal.parse().unwrap()),
                        Literal::FloatBits { hex } => {
                            V::N(f64::from_bits(u64::from_str_radix(hex, 16).unwrap()))
                        }
                        Literal::Bool { value } => V::B(*value),
                        _ => return Err("unsupported constant".into()),
                    },
                ),
                Action::Copy { result, operand } => (result, values[operand].clone()),
                Action::Binary {
                    result,
                    left,
                    right,
                    operator,
                } => (
                    result,
                    match (&values[left], &values[right], operator) {
                        (V::N(a), V::N(b), BinaryOp::LessThan) => V::B(a < b),
                        (V::I(a), V::I(b), BinaryOp::LessThan) => V::B(a < b),
                        (V::N(a), V::N(b), BinaryOp::Add) => V::N(a + b),
                        (V::I(a), V::I(b), BinaryOp::Add) => {
                            V::I(i64::from((*a as i32).wrapping_add(*b as i32)))
                        }
                        _ => return Err("unsupported arithmetic".into()),
                    },
                ),
                _ => return Err("opaque or unsupported operation".into()),
            };
            values.insert(id.clone(), value);
        }
        match &f.blocks[&block].terminator {
            Terminator::Return { value: Some(v) } => return Ok(values[v].clone()),
            Terminator::Raise { .. } => return Err("raise".into()),
            Terminator::Goto { target } => block = target.clone(),
            Terminator::Branch {
                condition,
                then_block,
                else_block,
            } => {
                let V::B(test) = values[condition] else {
                    return Err("nonboolean".into());
                };
                block = if test {
                    then_block.clone()
                } else {
                    else_block.clone()
                };
            }
            _ => return Err("call/unknown path".into()),
        }
    }
    Err("fuel".into())
}
fn node(source: &str, expression: &str) -> String {
    let path = std::env::temp_dir().join(format!(
        "cie-bundle-{}-{}.ts",
        std::process::id(),
        FILE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(
        &path,
        format!("{source}\nconsole.log(JSON.stringify({expression}));"),
    )
    .unwrap();
    let output = Command::new("node")
        .arg("--experimental-strip-types")
        .arg(&path)
        .output()
        .unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[test]
fn early_return_paths_match_actual_typescript_execution() {
    let source = "function value(x:number):number {if(x<0){return 0;}return x+1;}";
    let result = lower("a.ts", source);
    for (input, expected) in [(-2., 0.), (4., 5.)] {
        assert_eq!(run(&result, vec![V::N(input)]), Ok(V::N(expected)));
        assert_eq!(
            node(source, &format!("value({input})")),
            expected.to_string()
        );
    }
    let projected = report(&result);
    let function = projected.functions.values().next().unwrap();
    assert_eq!(function.returns.len(), 2);
    assert!(function
        .returns
        .iter()
        .all(|r| !r.structural_controls.is_empty()));
}
#[test]
fn java_branch_paths_match_actual_java_execution() {
    let method = "static int value(int x){if(x<0){return 0;}else{return x+1;}}";
    let source=format!("class BundleOracle {{ {method} public static void main(String[] args){{System.out.println(value(-2)+\",\"+value(4));}} }}");
    let dir = std::env::temp_dir().join(format!("cie-bundle-java-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("BundleOracle.java");
    std::fs::write(&path, &source).unwrap();
    let output = Command::new("java").arg(&path).output().unwrap();
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(dir).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "0,5");
    let result = lower("A.java", &format!("class A{{{method}}}"));
    assert_eq!(run(&result, vec![V::I(4)]), Ok(V::I(5)));
}
#[test]
fn branch_reassignment_uses_explicit_unknown_join() {
    let result = lower(
        "a.ts",
        "function value(flag:boolean):number {let x=1;if(flag){x=2;}else{x=3;}return x;}",
    );
    assert!(only(&result)
        .blocks
        .values()
        .flat_map(|b| &b.instructions)
        .any(|i| matches!(&i.action,Action::Opaque {reason,..} if reason.contains("join"))));
    assert!(report(&result)
        .functions
        .values()
        .next()
        .unwrap()
        .summary
        .gaps
        .iter()
        .any(|g| g.contains("join")));
}
#[test]
fn lexical_block_and_for_initializer_bindings_do_not_escape() {
    for source in [
        "function value(){ {let x=1;} return x;}",
        "function value(){for(let i=0;i<3;i=i+1){}return i;}",
    ] {
        let result = lower("a.js", source);
        assert!(matches!(
            only(&result).blocks[&only(&result).entry].terminator,
            Terminator::Opaque { .. }
        ));
    }
}
#[test]
fn while_counter_keeps_backedge_and_loop_uncertainty() {
    let result = lower(
        "a.js",
        "function value(){let i=0;while(i<3){i=i+1;}return i;}",
    );
    let f = only(&result);
    assert!(f
        .blocks
        .values()
        .any(|b| matches!(b.terminator, Terminator::Branch { .. })));
    let projected = report(&result);
    let p = projected.functions.values().next().unwrap();
    assert!(p.summary.gaps.iter().any(|g| g.contains("loop-carried")));
    assert!(run(&result, vec![]).is_err());
    assert_eq!(
        node(
            "function value(){let i=0;while(i<3){i=i+1;}return i;}",
            "value()"
        ),
        "3"
    );
}
#[test]
fn for_loop_update_is_not_silently_omitted() {
    let result = lower(
        "a.js",
        "function value(){let x=0;for(let i=0;i<3;i=i+1){x=x+1;}return x;}",
    );
    let f = only(&result);
    assert!(f
        .blocks
        .values()
        .any(|b| matches!(b.terminator, Terminator::Branch { .. })));
    assert!(
        f.blocks
            .values()
            .flat_map(|b| &b.instructions)
            .filter(|i| matches!(i.action, Action::Copy { .. }))
            .count()
            >= 2
    );
}
#[test]
fn literal_false_loop_follows_exact_false_path() {
    let source = "function value(){while(false){provider();}return 7;}";
    let result = lower("a.js", source);
    assert_eq!(run(&result, vec![]), Ok(V::N(7.)));
    assert_eq!(node(source, "value()"), "7");
}
#[test]
fn supported_catch_has_real_exception_edges() {
    let source = "function value():boolean {try{return provider();}catch(e){return false;}}";
    let result = lower("a.ts", source);
    assert!(only(&result).blocks.values().any(|b| matches!(
        b.terminator,
        Terminator::Invoke {
            exceptional: ExceptionalExit::Block { .. },
            ..
        }
    )));
    let projected = report(&result);
    let f = projected.functions.values().next().unwrap();
    assert!(f
        .graph
        .as_ref()
        .unwrap()
        .edges
        .iter()
        .any(|e| e.kind == analysis::Flow::Exceptional));
    assert_eq!(
        node(
            &format!("function provider(){{throw new Error();}}{source}"),
            "value()"
        ),
        "false"
    );
}
#[test]
fn finally_break_and_heterogeneous_returns_stay_opaque() {
    for source in [
        "function value(){try{return provider();}finally{cleanup();}}",
        "function value(){while(true){break;}return 7;}",
        "function value(flag:boolean){if(flag)return 7;else return false;}",
    ] {
        let result = lower("a.ts", source);
        assert!(matches!(
            only(&result).blocks[&only(&result).entry].terminator,
            Terminator::Opaque { .. }
        ));
    }
}
#[test]
fn uncaught_throw_retains_raise_and_opaque_allocation() {
    let result = lower("a.js", "function value(){throw new Error();}");
    assert!(only(&result)
        .blocks
        .values()
        .any(|b| matches!(b.terminator, Terminator::Raise { .. })));
    let projected = report(&result);
    let p = projected.functions.values().next().unwrap();
    assert!(p
        .summary
        .effects
        .contains_key(&analysis_foundation::Effect::Raise));
    assert!(p.summary.exceptional_exit_reachable);
}
#[test]
fn dominance_dataflow_control_and_slices_share_evidence() {
    let result = lower(
        "a.ts",
        "function value(x:number):number {if(x<0)return 0;return x+1;}",
    );
    let p = report(&result);
    let f = p.functions.values().next().unwrap();
    assert!(!f.immediate_dominators.is_empty());
    assert!(!f.immediate_postdominators.is_empty());
    assert!(f.dependencies.iter().any(|d| d.kind == "value"));
    assert!(f.dependencies.iter().any(|d| d.kind == "control"));
    let seed = &f.returns[1].site;
    let slice = analysis::slice(f, seed, true, 100).unwrap();
    assert!(slice.sites.contains(seed));
    assert!(slice.sites.len() > 1);
    assert!(!slice.truncated);
    assert!(!slice.gaps.is_empty());
    assert!(analysis::slice(f, seed, true, 0).unwrap().truncated);
    assert!(analysis::slice(f, "missing", true, 10).is_err());
}
#[test]
fn work_and_node_budgets_never_report_completion() {
    let result = lower("a.ts", "function value():number{return 7;}");
    for budget in [
        analysis::Budget {
            max_steps: 0,
            ..Default::default()
        },
        analysis::Budget {
            max_nodes_per_function: 1,
            ..Default::default()
        },
        analysis::Budget {
            max_dependencies: 0,
            ..Default::default()
        },
    ] {
        let p = analysis::analyze(&result.snapshot, &result.sources, &budget).unwrap();
        assert_eq!(p.completion, Completion::BudgetExhausted);
    }
}
#[test]
fn resolved_call_sccs_and_unknown_callee_gaps_are_compositional() {
    let source="class A {private static int one(int x){return two(x);} private static int two(int x){return one(x);} static int value(int x){return one(x);}}";
    let result = lower("A.java", source);
    let p = report(&result);
    assert!(p.call_sccs.iter().any(|c| c.len() == 2));
    assert!(p
        .functions
        .values()
        .all(|f| f.summary.must_effects.is_none()));
    let result=lower("A.java","class A {private static int helper(){return unavailable();} static int value(){return helper();}}");
    let p = report(&result);
    assert!(p.functions.values().all(|f| f
        .summary
        .gaps
        .iter()
        .any(|g| g.contains("unresolved call"))));
}
#[test]
fn report_serializes_deterministically_with_effect_evidence() {
    let result = lower("a.js", "function value(){throw new Error();}");
    let a = report(&result);
    let b = report(&result);
    assert_eq!(
        serde_json::to_value(&a).unwrap(),
        serde_json::to_value(&b).unwrap()
    );
    assert!(serde_json::to_string(&a).unwrap().contains("evidence"));
}

#[test]
fn represented_memory_effects_propagate_with_call_and_operation_evidence() {
    let mut result = lower(
        "A.java",
        "class A {private static int helper(){return 1;} static int value(){return helper();}}",
    );
    let helper = result
        .snapshot
        .functions
        .iter_mut()
        .find(|(_, f)| f.blocks.values().any(|b| !b.instructions.is_empty()))
        .unwrap()
        .1;
    let block = helper
        .blocks
        .values_mut()
        .find(|b| !b.instructions.is_empty())
        .unwrap();
    let constant = block.instructions[0].clone();
    let value = match &constant.action {
        Action::Constant { result, .. } => result.clone(),
        _ => panic!(),
    };
    block.instructions[0].action = Action::Read {
        result: value.clone(),
        resource: ResourceId("source".into()),
    };
    let mut write = constant;
    write.id = InstructionId("test-write".into());
    write.action = Action::Write {
        resource: ResourceId("destination".into()),
        value,
    };
    block.instructions.push(write);
    let p = report(&result);
    for f in p.functions.values() {
        assert!(f
            .summary
            .effects
            .contains_key(&analysis_foundation::Effect::Read("source".into())));
        assert!(f
            .summary
            .effects
            .contains_key(&analysis_foundation::Effect::Write("destination".into())));
    }
    assert!(p
        .functions
        .values()
        .any(|f| f.dependencies.iter().any(|d| d.kind == "may-alias")));
    assert!(p
        .functions
        .values()
        .any(|f| f.summary.effects.values().any(|e| e.len() > 1)));
}

#[test]
fn stale_source_is_rejected_before_projection() {
    let mut result = lower("a.ts", "function value():number{return 7;}");
    result.sources.values_mut().next().unwrap().push(b' ');
    assert!(analysis::analyze(&result.snapshot, &result.sources, &Default::default()).is_err());
}
