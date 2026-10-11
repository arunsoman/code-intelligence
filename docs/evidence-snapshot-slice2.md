# Evidence architecture: slice 2

Base: 5fb8e6e. Compatible with the complete G6 canvas patch; no renderer changes.

## What changes

Model-backed question retrieval collects a question-scoped, access-filtered evidence snapshot before prompt trimming. Collection includes the bounded investigated neighborhood and up to 160 supplementary declarations drawn from the registered charts' combined requirements. Selected-file declarations rank before broader candidates. Collection identity excludes diagram choice, prompt size, elapsed timings and presentation notes, and includes revision, question, entity/fact/relationship content, evidence/source hashes, binding, unresolved diagnostics and investigation gaps.

The snapshot owns a deep copy of its evidence. Migration 50 persists the collection as an internal checkpoint; deleting its revision cascades deletion. This is not a freshness or authorization cache: retrieval still checks current source and access. No public endpoint exposes saved raw collections, and this slice does not reuse checkpoints across later requests.

Both answer and chart generation continue to consume the same bounded model projection. The original collection survives context reduction. `EvidenceBundle.projection` and `ViewSpec.evidenceProjection` identify the collection and list omitted entities, relationships and facts, including shortened facts. Chart-specific declaration supplementation can select only entities already collected. Larger requests can therefore require a new investigation rather than silently enlarging their truth universe.

`ViewSpec.findings` supplies stable, typed findings with subjects and evidence IDs. Current, resolved static relationships and facts become `static-evidence` findings; unresolved facts and stale evidence do not. Accepted source-answer statements are separately marked `citation-checked`, which explicitly does not mean their natural-language semantics have been independently proved. Findings and coverage are redacted again at the response boundary.

`ViewSpec.evidenceCoverage` always says bounded static coverage, never exhaustive. Snapshot omission and prompt omission are distinct. Existing investigation gaps still use the current UI gap panel; this patch adds contracts without redesigning that panel.

## Query algebra

`EvidenceSet` uses present, absent and unknown. An omitted membership is unknown. Union, intersection and directional difference follow three-valued logic. A minus B cannot include a known member of A unless exclusion from B is established; reversing operands gives B minus A. Operands from different snapshots are rejected.

`EvidenceSetExpression` supports nested union/intersection/difference, explicit member references, and incoming/outgoing relationships. The evaluator runs against one immutable collection with a 128-expression-node limit. A relationship query supplies positive evidence only: it cannot infer absence from a bounded neighborhood. Explicit absent values must be justified by the producer; the evaluator never invents them.

## Limits and next slice

This is the evidence and algebra foundation, not automatic natural-language compound-query planning. The next planner slice must bind named subquestions, build typed expressions, present ambiguity choices, produce membership explanations, and pass canonical findings into every chart compiler. Prose and chart models still run independently over the same projection; structural validation of prose remains pending.

Snapshots remain bounded by existing investigation/retrieval limits, source excerpt limits and the declaration cap. They are not whole-repository or runtime proofs. Specialized causal/runtime/native routes are not yet converted to this snapshot engine. Persisted snapshots are checkpoints, not a cross-tab reuse API; safe reuse needs access/freshness checks, invalidation and retention policy. No new user zoom or fisheye controls are introduced.

## Validation

Run setup, typecheck, the snapshot/investigation tests and retrieval/chart regression suites. Tests cover all 27 three-valued binary cases, directional difference, mixed-snapshot rejection, nested-expression budgets, collection ownership, prompt omission, stable chart-independent identity, persistence and denied source.
