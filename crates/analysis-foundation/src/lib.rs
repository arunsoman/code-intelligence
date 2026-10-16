//! Versioned analysis boundary. Effects describe represented operations, never successful
//! business outcomes. Producers must report omitted semantics as gaps.
pub mod languages;
pub mod semantic_ir;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub const SCHEMA: &str = "cie.analysis-foundation.v1";
pub const ANALYZER: &str = "represented-effects.v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub schema: String,
    pub revision: String,
    /// Includes producer, lowering and language-semantics versions.
    pub semantics: String,
    /// Build configuration, dependency bindings and environment model digest.
    pub environment_digest: String,
    pub functions: Vec<Function>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Function {
    /// Producer-owned identity; independent of display labels.
    pub id: String,
    pub source: Source,
    /// Empty only when the producer accounts for every construct in this scope.
    pub gaps: BTreeSet<String>,
    pub operations: Vec<Operation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub file: String,
    pub content_digest: String,
    pub start_byte: u64,
    pub end_byte: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    pub id: String,
    pub source: Source,
    pub action: Action,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    /// A statically bound target in this snapshot, not a name-based guess.
    Call {
        target: String,
    },
    /// Models dynamic calls, unavailable code and external calls without a body.
    UnresolvedCall {
        reason: String,
    },
    Read {
        resource: String,
    },
    Write {
        resource: String,
    },
    Emit {
        resource: String,
    },
    Return,
    Raise,
    Unknown {
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", content = "resource", rename_all = "camelCase")]
pub enum Effect {
    Read(String),
    Write(String),
    Emit(String),
    Raise,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Potential represented effects, not a path-feasibility or must-effect claim.
    pub effects: BTreeSet<Effect>,
    /// Operation IDs supporting effects, including transitive callees.
    pub evidence: BTreeSet<String>,
    pub gaps: BTreeSet<String>,
    pub completion: Completion,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Completion {
    CompleteWithinModel,
    Partial,
    BudgetExhausted,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub schema: &'static str,
    pub analyzer: &'static str,
    pub revision: String,
    pub input_digest: String,
    pub steps: usize,
    pub summaries: BTreeMap<String, Summary>,
}

fn nonempty(s: &str) -> bool {
    !s.trim().is_empty()
}

impl Snapshot {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != SCHEMA {
            return Err("unsupported foundation schema".into());
        }
        if !nonempty(&self.revision)
            || !nonempty(&self.semantics)
            || !nonempty(&self.environment_digest)
        {
            return Err("revision, semantics and environmentDigest are required".into());
        }
        let mut ids = BTreeSet::new();
        let mut ops = BTreeSet::new();
        for f in &self.functions {
            if !nonempty(&f.id) || !ids.insert(&f.id) {
                return Err("empty or duplicate function ID".into());
            }
            validate_source(&f.source)?;
            if f.gaps.iter().any(|g| !nonempty(g)) {
                return Err("empty coverage gap".into());
            }
            for op in &f.operations {
                if !nonempty(&op.id) || !ops.insert(&op.id) {
                    return Err("empty or duplicate operation ID".into());
                }
                validate_source(&op.source)?;
                if op.source.file != f.source.file
                    || op.source.content_digest != f.source.content_digest
                    || op.source.start_byte < f.source.start_byte
                    || op.source.end_byte > f.source.end_byte
                {
                    return Err(format!("operation outside function source: {}", op.id));
                }
                let text = match &op.action {
                    Action::Call { target } => Some(target),
                    Action::UnresolvedCall { reason } | Action::Unknown { reason } => Some(reason),
                    Action::Read { resource }
                    | Action::Write { resource }
                    | Action::Emit { resource } => Some(resource),
                    _ => None,
                };
                if text.is_some_and(|s| !nonempty(s)) {
                    return Err("empty operation payload".into());
                }
            }
        }
        for f in &self.functions {
            for op in &f.operations {
                if let Action::Call { target } = &op.action {
                    if !ids.contains(target) {
                        return Err(format!("missing call target {target}; use unresolvedCall"));
                    }
                }
            }
        }
        Ok(())
    }

    /// Input-order-independent function identity for cache invalidation. Includes provenance.
    pub fn fingerprints(&self) -> Result<BTreeMap<String, String>, String> {
        self.validate()?;
        Ok(self
            .functions
            .iter()
            .map(|f| {
                let mut normalized = f.clone();
                normalized.operations.sort_by(|a, b| a.id.cmp(&b.id));
                (
                    f.id.clone(),
                    digest(&(
                        &self.schema,
                        &self.semantics,
                        &self.environment_digest,
                        normalized,
                    )),
                )
            })
            .collect())
    }
}

fn validate_source(s: &Source) -> Result<(), String> {
    if !nonempty(&s.file) || !nonempty(&s.content_digest) || s.start_byte >= s.end_byte {
        return Err("invalid source provenance or byte range".into());
    }
    Ok(())
}
fn digest(v: &impl Serialize) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(v).expect("serializable foundation DTO"))
    )
}

fn callers(s: &Snapshot) -> BTreeMap<String, BTreeSet<String>> {
    let mut result = BTreeMap::<String, BTreeSet<String>>::new();
    for f in &s.functions {
        for op in &f.operations {
            if let Action::Call { target } = &op.action {
                result
                    .entry(target.clone())
                    .or_default()
                    .insert(f.id.clone());
            }
        }
    }
    result
}

/// Fixed point over represented effects. A bounded run never reports completion on exhaustion.
pub fn analyze(s: &Snapshot, max_steps: usize) -> Result<Analysis, String> {
    let fingerprints = s.fingerprints()?;
    let mut summaries = BTreeMap::new();
    let mut targets = BTreeMap::<String, BTreeSet<String>>::new();
    for f in &s.functions {
        let mut summary = Summary {
            effects: BTreeSet::new(),
            evidence: BTreeSet::new(),
            gaps: f.gaps.clone(),
            completion: Completion::Partial,
        };
        for op in &f.operations {
            let effect = match &op.action {
                Action::Read { resource } => Some(Effect::Read(resource.clone())),
                Action::Write { resource } => Some(Effect::Write(resource.clone())),
                Action::Emit { resource } => Some(Effect::Emit(resource.clone())),
                Action::Raise => Some(Effect::Raise),
                Action::Call { target } => {
                    targets
                        .entry(f.id.clone())
                        .or_default()
                        .insert(target.clone());
                    summary.evidence.insert(op.id.clone());
                    None
                }
                Action::Unknown { reason } | Action::UnresolvedCall { reason } => {
                    summary.gaps.insert(format!("{}: {reason}", op.id));
                    None
                }
                Action::Return => None,
            };
            if let Some(effect) = effect {
                summary.effects.insert(effect);
                summary.evidence.insert(op.id.clone());
            }
        }
        summaries.insert(f.id.clone(), summary);
    }
    let reverse = callers(s);
    let mut queue: BTreeSet<String> = summaries.keys().cloned().collect();
    let mut steps = 0;
    while steps < max_steps {
        let Some(id) = queue.pop_first() else {
            break;
        };
        steps += 1;
        let mut next = summaries[&id].clone();
        for target in targets.get(&id).into_iter().flatten() {
            let callee = &summaries[target];
            next.effects.extend(callee.effects.iter().cloned());
            next.evidence.extend(callee.evidence.iter().cloned());
            next.gaps.extend(callee.gaps.iter().cloned());
        }
        if next != summaries[&id] {
            summaries.insert(id.clone(), next);
            queue.extend(reverse.get(&id).into_iter().flatten().cloned());
        }
    }
    for summary in summaries.values_mut() {
        summary.completion = if !queue.is_empty() {
            Completion::BudgetExhausted
        } else if summary.gaps.is_empty() {
            Completion::CompleteWithinModel
        } else {
            Completion::Partial
        };
    }
    Ok(Analysis {
        schema: SCHEMA,
        analyzer: ANALYZER,
        revision: s.revision.clone(),
        input_digest: digest(&(ANALYZER, &s.revision, fingerprints)),
        steps,
        summaries,
    })
}

/// Includes removed identities. Traverses OLD and NEW call edges so removed dependencies
/// cannot leave stale summaries. Revision-only changes require provenance refresh, not inference.
pub fn invalidated(old: &Snapshot, new: &Snapshot) -> Result<BTreeSet<String>, String> {
    let a = old.fingerprints()?;
    let b = new.fingerprints()?;
    let mut changed: BTreeSet<String> = a
        .keys()
        .chain(b.keys())
        .filter(|id| a.get(*id) != b.get(*id))
        .cloned()
        .collect();
    let mut reverse = callers(old);
    for (target, parents) in callers(new) {
        reverse.entry(target).or_default().extend(parents);
    }
    let mut queue: VecDeque<String> = changed.iter().cloned().collect();
    while let Some(id) = queue.pop_front() {
        for parent in reverse.get(&id).into_iter().flatten() {
            if changed.insert(parent.clone()) {
                queue.push_back(parent.clone());
            }
        }
    }
    Ok(changed)
}
