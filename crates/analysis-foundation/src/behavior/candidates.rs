//! Observed IR patterns are candidates, never authoritative business rules.
use super::*;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub semantic_id: String,
    pub kind: String,
    pub revision: String,
    pub function: FunctionId,
    pub location: Location,
    pub source: Span,
    pub expression: serde_json::Value,
    pub validation: &'static str,
    pub observation_scope: &'static str,
}
pub fn extract(snapshot: &Snapshot, limit: usize) -> Vec<Candidate> {
    let mut out = vec![];
    for (id, f) in &snapshot.functions {
        for (bid, b) in &f.blocks {
            if out.len() >= limit {
                return out;
            }
            let mut add = |kind: &str,
                           instruction: Option<InstructionId>,
                           source: &Span,
                           expression: serde_json::Value| {
                if out.len() >= limit {
                    return;
                }
                let location = Location {
                    function: id.clone(),
                    block: bid.clone(),
                    instruction,
                };
                let semantic_id = source_digest(
                    &serde_json::to_vec(&(
                        CHECKER,
                        &snapshot.revision,
                        &location,
                        kind,
                        &expression,
                    ))
                    .unwrap(),
                );
                out.push(Candidate{semantic_id,kind:kind.into(),revision:snapshot.revision.clone(),function:id.clone(),location,source:source.clone(),expression,validation:"unverified",observation_scope:"represented IR syntax only; no execution frequency, reachability or normative claim"});
            };
            for i in &b.instructions {
                if let Action::Binary { .. } = &i.action {
                    add(
                        "calculation",
                        Some(i.id.clone()),
                        &i.source,
                        serde_json::to_value(&i.action).unwrap(),
                    );
                }
            }
            match &b.terminator {
                Terminator::Branch { condition, .. } => add(
                    "guard",
                    None,
                    &b.source,
                    serde_json::json!({"condition":condition}),
                ),
                Terminator::Invoke { result, call, .. } => {
                    add(
                        if result.is_none() {
                            "discardedCallResult"
                        } else {
                            "call"
                        },
                        None,
                        &b.source,
                        serde_json::to_value(call).unwrap(),
                    );
                }
                Terminator::Return { value } => add(
                    "return",
                    None,
                    &b.source,
                    serde_json::json!({"value":value}),
                ),
                _ => {}
            }
        }
    }
    out
}
