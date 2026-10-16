use super::*;
use std::collections::VecDeque;
#[derive(Clone)]
struct Continuation {
    result: Option<ValueId>,
    normal: BlockId,
    exceptional: ExceptionalExit,
    target: FunctionId,
    location: Location,
    source: Span,
}
#[derive(Clone)]
struct Frame {
    function: FunctionId,
    block: BlockId,
    pc: usize,
    values: BTreeMap<ValueId, Literal>,
    continuation: Option<Continuation>,
}
#[derive(Clone)]
struct State {
    stack: Vec<Frame>,
    trace: Vec<Event>,
    steps: usize,
}
enum Progress {
    Continue,
    Fork(Vec<State>),
    Return(Literal),
    Raise,
    Unknown(String),
}
fn frame(
    snapshot: &Snapshot,
    id: &FunctionId,
    args: Vec<Literal>,
    continuation: Option<Continuation>,
) -> Frame {
    let f = &snapshot.functions[id];
    Frame {
        function: id.clone(),
        block: f.entry.clone(),
        pc: 0,
        values: f.parameters.iter().cloned().zip(args).collect(),
        continuation,
    }
}
fn event(state: &mut State, location: &Location, source: &Span, kind: EventKind) {
    state.trace.push(Event {
        location: location.clone(),
        source: source.clone(),
        event: kind,
    });
}
fn lookup(state: &State, value: &ValueId) -> Result<Literal, String> {
    state
        .stack
        .last()
        .unwrap()
        .values
        .get(value)
        .cloned()
        .ok_or_else(|| format!("value {} unavailable on this path", value.0))
}
fn jump(state: &mut State, target: &BlockId) {
    let frame = state.stack.last_mut().unwrap();
    frame.block = target.clone();
    frame.pc = 0;
}
fn exceptional(
    state: &mut State,
    exit: &ExceptionalExit,
    location: &Location,
    source: &Span,
) -> Progress {
    event(
        state,
        location,
        source,
        EventKind::Effect {
            effect: Effect::Raise,
        },
    );
    let mut exit = exit.clone();
    loop {
        match exit {
            ExceptionalExit::Block { target } => {
                jump(state, &target);
                event(
                    state,
                    location,
                    source,
                    EventKind::Exception { handled: true },
                );
                return Progress::Continue;
            }
            ExceptionalExit::Propagate => {
                let f = state.stack.pop().unwrap();
                if let Some(cont) = f.continuation {
                    exit = cont.exceptional
                } else {
                    event(
                        state,
                        location,
                        source,
                        EventKind::Exception { handled: false },
                    );
                    return Progress::Raise;
                }
            }
        }
    }
}
fn model(
    snapshot: &Snapshot,
    state: &State,
    m: &ExternalModel,
    normal: Option<(&Option<ValueId>, &BlockId, &ExceptionalExit)>,
) -> Result<Vec<State>, String> {
    let mut paths = vec![];
    for outcome in &m.outcomes {
        let mut path = state.clone();
        event(
            &mut path,
            &m.location,
            &m.source,
            EventKind::Model { id: m.id.clone() },
        );
        let effects = match outcome {
            ModelOutcome::Return { effects, .. } | ModelOutcome::Raise { effects } => effects,
        };
        for effect in effects {
            event(
                &mut path,
                &m.location,
                &m.source,
                EventKind::Effect {
                    effect: effect.clone(),
                },
            );
        }
        match outcome {
            ModelOutcome::Return { value, .. } => {
                if let Some((result, target, _)) = normal {
                    if let (Some(id), Some(value)) = (result, value) {
                        path.stack
                            .last_mut()
                            .unwrap()
                            .values
                            .insert(id.clone(), value.clone());
                    }
                    jump(&mut path, target);
                } else {
                    let f = path.stack.last_mut().unwrap();
                    f.values.extend(m.outputs.clone());
                    f.pc += 1;
                }
            }
            ModelOutcome::Raise { .. } => {
                let exit = if let Some((_, _, exit)) = normal {
                    exit.clone()
                } else {
                    snapshot.functions[&m.location.function].blocks[&m.location.block]
                        .instructions
                        .iter()
                        .find(|i| Some(&i.id) == m.location.instruction.as_ref())
                        .unwrap()
                        .exceptional
                        .clone()
                        .unwrap()
                };
                // An empty stack marks an exceptional root outcome; process it at the next dispatch.
                let _ = exceptional(&mut path, &exit, &m.location, &m.source);
            }
        }
        paths.push(path);
    }
    Ok(paths)
}
fn advance(
    snapshot: &Snapshot,
    models: &BTreeMap<Location, &ExternalModel>,
    state: &mut State,
    budget: &Budget,
) -> Result<Progress, String> {
    if state.stack.is_empty() {
        return Ok(Progress::Raise);
    }
    let f = state.stack.last().unwrap();
    let function = &snapshot.functions[&f.function];
    let b = &function.blocks[&f.block];
    let location = Location {
        function: f.function.clone(),
        block: f.block.clone(),
        instruction: b.instructions.get(f.pc).map(|i| i.id.clone()),
    };
    let source = b
        .instructions
        .get(f.pc)
        .map(|i| &i.source)
        .unwrap_or(&b.source)
        .clone();
    event(state, &location, &source, EventKind::Step);
    if let Some(i) = b.instructions.get(state.stack.last().unwrap().pc) {
        if let Some(m) = models.get(&location) {
            if let Action::Opaque { inputs, .. } = &i.action {
                for v in inputs {
                    lookup(state, v)?;
                }
            }
            return Ok(Progress::Fork(model(snapshot, state, m, None)?));
        }
        let mut output = None;
        match &i.action {
            Action::Constant { result, literal } => {
                output = Some((result.clone(), literal.clone()))
            }
            Action::Copy { result, operand } => {
                output = Some((result.clone(), lookup(state, operand)?))
            }
            Action::Unary {
                result,
                operand,
                operator,
            } => {
                output = Some((
                    result.clone(),
                    values::unary(operator, &lookup(state, operand)?, &function.values[result])?,
                ))
            }
            Action::Binary {
                result,
                left,
                right,
                operator,
            } => match values::binary(
                operator,
                &lookup(state, left)?,
                &lookup(state, right)?,
                &function.values[result],
            )? {
                values::Arithmetic::Value(v) => output = Some((result.clone(), v)),
                values::Arithmetic::Raise => {
                    return if let Some(exit) = &i.exceptional {
                        Ok(exceptional(state, exit, &location, &source))
                    } else {
                        Err("arithmetic exception lacks IR exceptional continuation".into())
                    }
                }
            },
            Action::Write { resource, value } => {
                lookup(state, value)?;
                event(
                    state,
                    &location,
                    &source,
                    EventKind::Effect {
                        effect: Effect::Write(resource.0.clone()),
                    },
                );
            }
            Action::Read { .. } => {
                return Err("memory read value unavailable; no concrete heap model".into())
            }
            Action::Opaque { reason, .. } => return Err(format!("opaque operation: {reason}")),
        }
        if i.exceptional.is_some()
            && !matches!(
                &i.action,
                Action::Binary {
                    operator: BinaryOp::Divide | BinaryOp::Remainder,
                    ..
                }
            )
        {
            return Err("operation's exceptional condition is not concretely modeled".into());
        }
        if let Some((id, value)) = output {
            values::typed(&value, &function.values[&id])?;
            state.stack.last_mut().unwrap().values.insert(id, value);
        }
        state.stack.last_mut().unwrap().pc += 1;
        return Ok(Progress::Continue);
    }
    match &b.terminator {
        Terminator::Goto { target } => {
            jump(state, target);
            Ok(Progress::Continue)
        }
        Terminator::Branch {
            condition,
            then_block,
            else_block,
        } => {
            let Literal::Bool { value } = lookup(state, condition)? else {
                return Err("nonboolean branch".into());
            };
            jump(state, if value { then_block } else { else_block });
            Ok(Progress::Continue)
        }
        Terminator::Opaque { reason, .. } => Err(format!("opaque terminator: {reason}")),
        Terminator::Raise { value } => {
            if let Some(value) = value {
                lookup(state, value)?;
            }
            Ok(exceptional(
                state,
                &ExceptionalExit::Propagate,
                &location,
                &source,
            ))
        }
        Terminator::Return { value } => {
            let value = if let Some(v) = value {
                lookup(state, v)?
            } else {
                Literal::Unit
            };
            values::typed(&value, &function.return_type)?;
            event(
                state,
                &location,
                &source,
                EventKind::Return {
                    value: value.clone(),
                },
            );
            let f = state.stack.pop().unwrap();
            if let Some(cont) = f.continuation {
                if let Some(id) = cont.result {
                    state
                        .stack
                        .last_mut()
                        .unwrap()
                        .values
                        .insert(id, value.clone());
                }
                event(
                    state,
                    &cont.location,
                    &cont.source,
                    EventKind::CallReturn {
                        target: cont.target,
                        value,
                    },
                );
                jump(state, &cont.normal);
                Ok(Progress::Continue)
            } else {
                Ok(Progress::Return(value))
            }
        }
        Terminator::Invoke {
            result,
            call,
            normal,
            exceptional,
        } => {
            for v in &call.arguments {
                lookup(state, v)?;
            }
            if let Some(m) = models.get(&location) {
                return Ok(Progress::Fork(model(
                    snapshot,
                    state,
                    m,
                    Some((result, normal, exceptional)),
                )?));
            }
            let Binding::Resolved { targets, .. } = &call.binding else {
                return Err("unresolved call has no authoritative exact-site model".into());
            };
            if state.stack.len() >= budget.max_call_depth {
                return Ok(Progress::Unknown("call-depth budget exhausted".into()));
            }
            if targets.len() != 1 {
                return Err(
                    "ambiguous candidate target set is not a feasible concrete choice".into(),
                );
            }
            let args: Vec<_> = call
                .arguments
                .iter()
                .map(|v| lookup(state, v))
                .collect::<Result<_, _>>()?;
            let mut paths = vec![];
            for target in targets {
                let mut path = state.clone();
                let continuation = Continuation {
                    result: result.clone(),
                    normal: normal.clone(),
                    exceptional: exceptional.clone(),
                    target: target.clone(),
                    location: location.clone(),
                    source: source.clone(),
                };
                path.stack
                    .push(frame(snapshot, target, args.clone(), Some(continuation)));
                paths.push(path);
            }
            Ok(Progress::Fork(paths))
        }
    }
}
fn failures(
    c: &Contract,
    args: &[Literal],
    returned: Option<&Literal>,
    trace: &[Event],
) -> Vec<(usize, String)> {
    let mut failed = vec![];
    for (index, o) in c.obligations.iter().enumerate() {
        if returned.is_none() && !matches!(o, Obligation::OrderedEffects { .. }) {
            continue;
        }
        let unit = Literal::Unit;
        let value = returned.unwrap_or(&unit);
        let valid = match o {
            Obligation::Ensures { predicate } => values::evaluate(predicate, args, Some(value)),
            Obligation::RequiresEffect { effect, when } => Ok(!when.matches(value)
                || trace
                    .iter()
                    .any(|e| matches!(&e.event,EventKind::Effect{effect:e} if e==effect))),
            Obligation::RequiresCallResult {
                target,
                accepted,
                when,
            } => {
                if !when.matches(value) {
                    Ok(true)
                } else {
                    trace
                        .iter()
                        .rev()
                        .find_map(|e| {
                            if let EventKind::CallReturn { target: t, value } = &e.event {
                                if target == t {
                                    return Some(values::equal(value, accepted));
                                }
                            }
                            None
                        })
                        .unwrap_or(Ok(false))
                }
            }
            Obligation::NoExceptionToSuccess { success } => {
                Ok(!matches!(value,Literal::Bool{value:v} if v==success)
                    || !trace
                        .iter()
                        .any(|e| matches!(e.event, EventKind::Exception { handled: true })))
            }
            Obligation::OrderedEffects { first, then } => {
                let mut seen = false;
                let mut valid = true;
                for e in trace {
                    if let EventKind::Effect { effect } = &e.event {
                        if effect == then && !seen {
                            valid = false
                        }
                        if effect == first {
                            seen = true
                        }
                    }
                }
                Ok(valid)
            }
        };
        match valid {
            Ok(true) => {}
            Ok(false) => failed.push((
                index,
                "contract obligation is false on this concrete represented path".into(),
            )),
            Err(reason) => failed.push((index, format!("unsupported predicate: {reason}"))),
        }
    }
    failed
}
fn record(
    finding: &mut Finding,
    args: &[Literal],
    trace: &[Event],
    failures: Vec<(usize, String)>,
    limits: (&Budget, &mut usize, &mut bool),
) {
    let (budget, saved_events, exhausted) = limits;
    for (obligation, explanation) in failures {
        if explanation.starts_with("unsupported predicate") {
            finding.unknown_paths += 1;
            finding.gaps.insert(explanation);
            continue;
        }
        finding.violations_observed += 1;
        if finding.counterexamples.len() < budget.max_counterexamples
            && trace.len() <= budget.max_saved_events.saturating_sub(*saved_events)
        {
            *saved_events += trace.len();
            finding.counterexamples.push(Counterexample {
                arguments: args.to_vec(),
                obligation,
                explanation,
                trace: trace.to_vec(),
            });
        } else {
            *exhausted = true;
            finding.counterexamples_truncated = true;
            finding
                .gaps
                .insert("counterexample evidence budget exhausted".into());
        }
    }
}
pub(super) fn run(
    snapshot: &Snapshot,
    registry: &Registry,
    c: &Contract,
    budget: &Budget,
    steps: &mut usize,
    saved_events: &mut usize,
    finding: &mut Finding,
) {
    let models: BTreeMap<_, _> = registry
        .models
        .iter()
        .map(|m| (m.location.clone(), m))
        .collect();
    let mut exhausted = false;
    let count = c
        .domains
        .iter()
        .try_fold(1usize, |n, d| n.checked_mul(d.len()));
    let total = count.unwrap_or(usize::MAX);
    let cases = total.min(budget.max_cases);
    if total > budget.max_cases {
        exhausted = true;
        finding
            .gaps
            .insert("input-domain case budget exhausted".into());
    }
    finding.assumptions.insert(
        "finite declared Cartesian input domain only; no unbounded or runtime guarantee".into(),
    );
    finding.assumptions.insert(format!(
        "source producer {}; environment {}",
        snapshot.producer_version, snapshot.environment_digest
    ));
    for d in snapshot.documents.values() {
        for gap in &d.gaps {
            finding.assumptions.insert(format!(
                "{}:{}..{}: {}",
                d.path, gap.source.start_byte, gap.source.end_byte, gap.reason
            ));
        }
    }
    for case in 0..cases {
        if *steps >= budget.max_steps {
            exhausted = true;
            finding
                .gaps
                .insert("global execution step budget exhausted".into());
            break;
        }
        let mut n = case;
        let args: Vec<_> = c
            .domains
            .iter()
            .map(|d| {
                let value = d[n % d.len()].clone();
                n /= d.len();
                value
            })
            .collect();
        finding.cases_started += 1;
        if let Some(pre) = &c.precondition {
            match values::evaluate(pre, &args, None) {
                Ok(false) => continue,
                Ok(true) => {}
                Err(gap) => {
                    finding.unknown_paths += 1;
                    finding.gaps.insert(gap);
                    continue;
                }
            }
        }
        let mut queue = VecDeque::from([State {
            stack: vec![frame(snapshot, &c.function, args.clone(), None)],
            trace: vec![],
            steps: 0,
        }]);
        while let Some(mut state) = queue.pop_front() {
            if *steps >= budget.max_steps
                || state.steps >= budget.max_path_steps
                || state.trace.len() >= budget.max_trace_events
            {
                exhausted = true;
                finding.unknown_paths += 1;
                finding
                    .gaps
                    .insert("execution work/path/trace budget exhausted".into());
                continue;
            }
            *steps += 1;
            state.steps += 1;
            let progress = advance(snapshot, &models, &mut state, budget);
            if state.trace.len() > budget.max_trace_events {
                exhausted = true;
                finding.unknown_paths += 1;
                finding.gaps.insert("trace budget exhausted".into());
                continue;
            }
            match progress {
                Ok(Progress::Continue) => queue.push_back(state),
                Ok(Progress::Fork(paths)) => {
                    for p in paths {
                        if queue.len() >= budget.max_pending_paths
                            || p.trace.len() > budget.max_trace_events
                        {
                            exhausted = true;
                            finding.unknown_paths += 1;
                            finding.gaps.insert("pending-path budget exhausted".into());
                        } else {
                            queue.push_back(p)
                        }
                    }
                }
                Ok(Progress::Return(value)) => {
                    finding.normal_paths += 1;
                    record(
                        finding,
                        &args,
                        &state.trace,
                        failures(c, &args, Some(&value), &state.trace),
                        (budget, saved_events, &mut exhausted),
                    );
                }
                Ok(Progress::Raise) => {
                    finding.exceptional_paths += 1;
                    record(
                        finding,
                        &args,
                        &state.trace,
                        failures(c, &args, None, &state.trace),
                        (budget, saved_events, &mut exhausted),
                    );
                }
                Ok(Progress::Unknown(gap)) => {
                    exhausted = true;
                    finding.unknown_paths += 1;
                    finding.gaps.insert(gap);
                }
                Err(gap) => {
                    finding.unknown_paths += 1;
                    finding.gaps.insert(gap);
                }
            }
        }
    }
    for m in &registry.models {
        finding.assumptions.insert(format!(
            "external model {}: {} @ {} ({:?})",
            m.id, m.provenance.reference, m.provenance.version, m.provenance.authority
        ));
    }
    if finding.normal_paths == 0 {
        finding.gaps.insert("no completed normal path within the precondition/domain; obligations are not certified vacuously".into());
    }
    finding.completion = if exhausted {
        Completion::BudgetExhausted
    } else if finding.unknown_paths > 0 || finding.normal_paths == 0 {
        Completion::Partial
    } else {
        Completion::CompleteWithinModel
    };
    finding.conclusion = if !c.provenance.authority.normative() {
        Conclusion::Candidate
    } else if !finding.counterexamples.is_empty() {
        Conclusion::ViolatedWithinModel
    } else if finding.completion == Completion::CompleteWithinModel {
        Conclusion::SatisfiedWithinDomain
    } else {
        Conclusion::Unknown
    };
}
