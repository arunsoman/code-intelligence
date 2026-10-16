//! Explicit contract authority and finite-domain checking. No name-based specification.
pub mod candidates;
mod execute;
mod values;
use crate::{semantic_ir::*, Completion, Effect};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
pub const SCHEMA: &str = "cie.behavior-contracts.v1";
pub const CHECKER: &str = "cie.finite-behavior.v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Authority {
    ApprovedSpecification,
    ExplicitAnnotation,
    TestObservation,
    Hypothesis,
}
impl Authority {
    pub fn normative(&self) -> bool {
        matches!(self, Self::ApprovedSpecification | Self::ExplicitAnnotation)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provenance {
    pub authority: Authority,
    pub reference: String,
    pub version: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operand {
    Argument { index: usize },
    Return,
    Literal { value: Literal },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Predicate {
    Equal { left: Operand, right: Operand },
    LessThan { left: Operand, right: Operand },
    Not { value: Box<Predicate> },
    And { values: Vec<Predicate> },
    Or { values: Vec<Predicate> },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ReturnGuard {
    Always,
    Bool { value: bool },
}
impl ReturnGuard {
    fn matches(&self, value: &Literal) -> bool {
        match self {
            Self::Always => true,
            Self::Bool { value: b } => matches!(value,Literal::Bool{value} if b==value),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Obligation {
    Ensures {
        predicate: Predicate,
    },
    RequiresEffect {
        effect: Effect,
        when: ReturnGuard,
    },
    RequiresCallResult {
        target: FunctionId,
        accepted: Literal,
        when: ReturnGuard,
    },
    NoExceptionToSuccess {
        success: bool,
    },
    OrderedEffects {
        first: Effect,
        then: Effect,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contract {
    pub id: String,
    pub key: String,
    pub label: Option<String>,
    pub function: FunctionId,
    pub provenance: Provenance,
    pub supersedes: BTreeSet<String>,
    /// Cartesian product; conclusions never extend beyond these input values.
    pub domains: Vec<Vec<Literal>>,
    pub precondition: Option<Predicate>,
    pub obligations: Vec<Obligation>,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Location {
    pub function: FunctionId,
    pub block: BlockId,
    pub instruction: Option<InstructionId>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ModelOutcome {
    Return {
        value: Option<Literal>,
        effects: Vec<Effect>,
    },
    Raise {
        effects: Vec<Effect>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalModel {
    pub id: String,
    pub location: Location,
    pub source: Span,
    pub provenance: Provenance,
    /// Exact output values only for opaque instruction models; none for call models.
    #[serde(deserialize_with = "crate::semantic_ir::unique_map")]
    pub outputs: BTreeMap<ValueId, Literal>,
    pub outcomes: Vec<ModelOutcome>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registry {
    pub schema: String,
    pub revision: String,
    pub environment_digest: String,
    pub contracts: Vec<Contract>,
    pub models: Vec<ExternalModel>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    pub max_contracts: usize,
    pub max_cases: usize,
    pub max_steps: usize,
    pub max_path_steps: usize,
    pub max_pending_paths: usize,
    pub max_call_depth: usize,
    pub max_trace_events: usize,
    pub max_counterexamples: usize,
    pub max_saved_events: usize,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            max_contracts: 1000,
            max_cases: 4096,
            max_steps: 1_000_000,
            max_path_steps: 10000,
            max_pending_paths: 1024,
            max_call_depth: 64,
            max_trace_events: 10000,
            max_counterexamples: 16,
            max_saved_events: 100000,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Conclusion {
    SatisfiedWithinDomain,
    ViolatedWithinModel,
    Unknown,
    Candidate,
}
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EventKind {
    Step,
    Effect { effect: Effect },
    CallReturn { target: FunctionId, value: Literal },
    Exception { handled: bool },
    Return { value: Literal },
    Model { id: String },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub location: Location,
    pub source: Span,
    pub event: EventKind,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counterexample {
    pub arguments: Vec<Literal>,
    pub obligation: usize,
    pub explanation: String,
    pub trace: Vec<Event>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub contract: Contract,
    pub source: Span,
    pub contract_id: String,
    pub semantic_digest: String,
    pub function: FunctionId,
    pub conclusion: Conclusion,
    pub completion: Completion,
    pub cases_started: usize,
    pub normal_paths: usize,
    pub exceptional_paths: usize,
    pub unknown_paths: usize,
    pub assumptions: BTreeSet<String>,
    pub gaps: BTreeSet<String>,
    pub counterexamples: Vec<Counterexample>,
    pub violations_observed: usize,
    pub counterexamples_truncated: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub checker: &'static str,
    pub revision: String,
    pub input_digest: String,
    pub steps: usize,
    pub findings: Vec<Finding>,
    pub candidates: Vec<candidates::Candidate>,
    pub candidates_truncated: bool,
}

fn text(s: &str) -> Result<(), String> {
    if s.trim().is_empty() || s.len() > 4096 {
        Err("empty or oversized identity/provenance".into())
    } else {
        Ok(())
    }
}
fn effect(e: &Effect) -> Result<(), String> {
    match e {
        Effect::Read(s) | Effect::Write(s) | Effect::Emit(s) => text(s),
        Effect::Raise => Ok(()),
    }
}
fn provenance(p: &Provenance) -> Result<(), String> {
    text(&p.reference)?;
    text(&p.version)
}
fn literal_type(l: &Literal, t: &Type) -> bool {
    values::typed(l, t).is_ok()
}
fn operand_type(o: &Operand, f: &Function, pre: bool) -> Result<Type, String> {
    match o {
        Operand::Argument { index } => f
            .parameters
            .get(*index)
            .map(|v| f.values[v].clone())
            .ok_or("argument index out of range".into()),
        Operand::Return if pre => Err("precondition cannot refer to return".into()),
        Operand::Return => Ok(f.return_type.clone()),
        Operand::Literal { value } => {
            let t = values::natural_type(value)?;
            values::typed(value, &t)?;
            Ok(t)
        }
    }
}
fn predicate(p: &Predicate, f: &Function, pre: bool, depth: usize) -> Result<(), String> {
    if depth > 32 {
        return Err("predicate nesting limit".into());
    }
    match p {
        Predicate::Equal { left, right } | Predicate::LessThan { left, right } => {
            let a = operand_type(left, f, pre)?;
            let b = operand_type(right, f, pre)?;
            // Integer literals are contextual: fixed-width contract values must fit the operand.
            let compatible = a == b
                || matches!(left,Operand::Literal{value} if literal_type(value,&b))
                || matches!(right,Operand::Literal{value} if literal_type(value,&a));
            if !compatible {
                return Err("predicate operand types disagree".into());
            }
            if matches!(p, Predicate::LessThan { .. })
                && !matches!(a, Type::Integer { .. } | Type::Float { .. })
            {
                return Err("unsupported ordered predicate type".into());
            }
            Ok(())
        }
        Predicate::Not { value } => predicate(value, f, pre, depth + 1),
        Predicate::And { values } | Predicate::Or { values } => {
            if values.is_empty() || values.len() > 64 {
                return Err("predicate arity limit".into());
            }
            for p in values {
                predicate(p, f, pre, depth + 1)?
            }
            Ok(())
        }
    }
}
impl Registry {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("contract registry byte limit".into());
        }
        serde_json::from_slice(bytes).map_err(|e| e.to_string())
    }
    fn validate(&self, snapshot: &Snapshot, budget: &Budget) -> Result<(), String> {
        if self.schema != SCHEMA
            || self.revision != snapshot.revision
            || self.environment_digest != snapshot.environment_digest
        {
            return Err("registry schema/revision/environment mismatch".into());
        }
        if self.contracts.len() > budget.max_contracts || self.models.len() > 4096 {
            return Err("registry count limit".into());
        }
        let mut ids = BTreeMap::new();
        for c in &self.contracts {
            text(&c.id)?;
            text(&c.key)?;
            if let Some(label) = &c.label {
                text(label)?;
            }
            provenance(&c.provenance)?;
            if ids.insert(c.id.clone(), c).is_some() {
                return Err("duplicate contract id".into());
            }
            let f = snapshot
                .functions
                .get(&c.function)
                .ok_or("unknown contract function")?;
            if c.domains.len() != f.parameters.len()
                || c.domains.iter().any(|d| d.is_empty() || d.len() > 4096)
                || c.obligations.is_empty()
                || c.obligations.len() > 128
            {
                return Err("invalid contract domain/obligation arity".into());
            }
            for (p, d) in f.parameters.iter().zip(&c.domains) {
                for l in d {
                    if !literal_type(l, &f.values[p]) {
                        return Err("domain literal does not fit parameter".into());
                    }
                }
            }
            if let Some(p) = &c.precondition {
                predicate(p, f, true, 0)?
            }
            for o in &c.obligations {
                match o {
                    Obligation::RequiresEffect { effect: e, .. } => effect(e)?,
                    Obligation::OrderedEffects { first, then } => {
                        effect(first)?;
                        effect(then)?;
                    }
                    _ => {}
                }
                match o {
                    Obligation::Ensures { predicate: p } => predicate(p, f, false, 0)?,
                    Obligation::RequiresEffect { when, .. }
                    | Obligation::RequiresCallResult { when, .. }
                        if matches!(when, ReturnGuard::Bool { .. })
                            && f.return_type != Type::Bool =>
                    {
                        return Err("boolean return guard on nonboolean function".into())
                    }
                    Obligation::NoExceptionToSuccess { .. } if f.return_type != Type::Bool => {
                        return Err("success check requires boolean return".into())
                    }
                    Obligation::RequiresCallResult {
                        target, accepted, ..
                    } => {
                        let callee = snapshot
                            .functions
                            .get(target)
                            .ok_or("unknown call obligation target")?;
                        if !literal_type(accepted, &callee.return_type) {
                            return Err("accepted result type mismatch".into());
                        }
                    }
                    _ => {}
                }
            }
        }
        for c in &self.contracts {
            for old in &c.supersedes {
                let old = ids.get(old).ok_or("superseded contract missing")?;
                if old.function != c.function
                    || old.key != c.key
                    || old.id == c.id
                    || (!c.provenance.authority.normative() && old.provenance.authority.normative())
                {
                    return Err("invalid contract supersession".into());
                }
            }
            let mut frontier: Vec<_> = c.supersedes.iter().collect();
            let mut seen = BTreeSet::new();
            while let Some(id) = frontier.pop() {
                if id == &c.id {
                    return Err("cyclic contract supersession".into());
                }
                if seen.insert(id) {
                    frontier.extend(ids[id].supersedes.iter());
                }
            }
        }
        let mut locations = BTreeSet::new();
        let mut mids = BTreeSet::new();
        for m in &self.models {
            text(&m.id)?;
            provenance(&m.provenance)?;
            if !m.provenance.authority.normative() {
                return Err("external models require normative authority".into());
            }
            if !mids.insert(&m.id)
                || !locations.insert(&m.location)
                || m.outcomes.is_empty()
                || m.outcomes.len() > 64
            {
                return Err("duplicate/oversized external model".into());
            }
            let f = snapshot
                .functions
                .get(&m.location.function)
                .ok_or("model function missing")?;
            let b = f
                .blocks
                .get(&m.location.block)
                .ok_or("model block missing")?;
            let (source, outputs, result, may_raise) = if let Some(id) = &m.location.instruction {
                let i = b
                    .instructions
                    .iter()
                    .find(|i| &i.id == id)
                    .ok_or("model instruction missing")?;
                let Action::Opaque { outputs, .. } = &i.action else {
                    return Err("only opaque instructions may be modeled".into());
                };
                (&i.source, outputs.clone(), None, i.exceptional.is_some())
            } else {
                let Terminator::Invoke {
                    result,
                    call:
                        CallSite {
                            binding: Binding::Unresolved { .. },
                            ..
                        },
                    ..
                } = &b.terminator
                else {
                    return Err("only unresolved invokes may be modeled".into());
                };
                (&b.source, vec![], result.as_ref(), true)
            };
            if source != &m.source
                || outputs.iter().cloned().collect::<BTreeSet<_>>()
                    != m.outputs.keys().cloned().collect()
            {
                return Err("model source/output binding mismatch".into());
            }
            for (v, l) in &m.outputs {
                if !literal_type(l, &f.values[v]) {
                    return Err("model output type mismatch".into());
                }
            }
            for outcome in &m.outcomes {
                let effects = match outcome {
                    ModelOutcome::Return { effects, .. } | ModelOutcome::Raise { effects } => {
                        effects
                    }
                };
                for e in effects {
                    effect(e)?;
                }
                match outcome {
                    ModelOutcome::Return { value, effects } => {
                        if let Some(v) = result {
                            if !value
                                .as_ref()
                                .is_some_and(|l| literal_type(l, &f.values[v]))
                            {
                                return Err("model call result type mismatch".into());
                            }
                        } else if value.is_some() {
                            return Err("uncaptured/instruction model cannot return a value".into());
                        }
                        if effects.len() > 128 {
                            return Err("model effect limit".into());
                        }
                    }
                    ModelOutcome::Raise { effects } => {
                        if !may_raise || effects.len() > 128 {
                            return Err("model has unsupported exceptional outcome".into());
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
pub fn check(
    snapshot: &Snapshot,
    sources: &Sources,
    registry: &Registry,
    budget: &Budget,
) -> Result<Report, String> {
    let ir = snapshot.checked_digest(sources)?;
    registry.validate(snapshot, budget)?;
    let mut findings = vec![];
    let mut steps = 0;
    let mut saved_events = 0;
    let mut semantic_registry = registry.clone();
    for contract in &mut semantic_registry.contracts {
        contract.label = None;
    }
    let superseded: BTreeSet<_> = registry
        .contracts
        .iter()
        .flat_map(|c| c.supersedes.iter())
        .collect();
    for c in &registry.contracts {
        if superseded.contains(&c.id) {
            continue;
        }
        let conflict = registry.contracts.iter().any(|other| {
            other.id != c.id
                && !superseded.contains(&other.id)
                && other.function == c.function
                && other.key == c.key
                && other.provenance.authority.normative() == c.provenance.authority.normative()
        });
        let digest = source_digest(
            &serde_json::to_vec(&(CHECKER, &ir, &c.id, &semantic_registry, budget)).unwrap(),
        );
        let mut finding = Finding {
            contract: c.clone(),
            source: snapshot.functions[&c.function].source.clone(),
            contract_id: c.id.clone(),
            semantic_digest: digest,
            function: c.function.clone(),
            conclusion: Conclusion::Unknown,
            completion: Completion::Partial,
            cases_started: 0,
            normal_paths: 0,
            exceptional_paths: 0,
            unknown_paths: 0,
            assumptions: BTreeSet::new(),
            gaps: BTreeSet::new(),
            counterexamples: vec![],
            violations_observed: 0,
            counterexamples_truncated: false,
        };
        if conflict {
            if !c.provenance.authority.normative() {
                finding.conclusion = Conclusion::Candidate;
            }
            finding
                .gaps
                .insert("conflicting active contracts for the same function/key".into());
        } else {
            execute::run(
                snapshot,
                registry,
                c,
                budget,
                &mut steps,
                &mut saved_events,
                &mut finding,
            );
        }
        findings.push(finding);
    }
    let mut candidates = candidates::extract(snapshot, 10001);
    let candidates_truncated = candidates.len() > 10000;
    candidates.truncate(10000);
    Ok(Report {
        checker: CHECKER,
        revision: snapshot.revision.clone(),
        input_digest: source_digest(&serde_json::to_vec(&(CHECKER, ir, registry, budget)).unwrap()),
        steps,
        findings,
        candidates,
        candidates_truncated,
    })
}
