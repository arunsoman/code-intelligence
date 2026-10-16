# Rust analysis foundation — first executable slice

Base: upstream main 4a748fd. Crate: `analysis-foundation`.

## Boundary

This library accepts a versioned, normalized **operation inventory**, not raw
source and not a complete semantic IR. It is the first reusable boundary for
IR producers and analysis consumers. No existing indexing, answer or chart
path is switched to this boundary by this patch.

The existing worker similarity IR blanks literals and normalizes constructs.
It cannot establish contract predicates or exact execution semantics. An
adapter must not silently reinterpret that IR as complete program semantics.

## Implemented

- Strict serde input records, explicit schema, semantics/environment versions.
- Function and operation identities, file digests and byte provenance.
- Calls to validated snapshot identities, unresolved calls with reasons,
  read/write/emit/raise/return/unknown operation categories.
- Producer coverage gaps; transitive propagation of unknown behavior.
- Deterministic monotone worklist summaries over represented potential effects.
  Cycles converge over finite effect/evidence/gap sets.
- Explicit work budget and budget-exhausted completion, separate from effects.
- Input-order-independent fingerprints and run input digest.
- Invalidation through the union of old/new reverse call graphs, including
  removed functions, changed bindings, semantics and environment versions.
- Standalone worker command and reusable library API.

## Run

```
cargo test -p analysis-foundation --locked
cargo run --locked -p worker -- analysisFoundation snapshot.json
```

The command accepts exactly one JSON file; its worklist budget is 100,000
function evaluations. Library consumers choose their own `max_steps`.
The budget bounds propagation evaluations, not input parsing, memory, or wall
clock time. Service callers must apply their existing input-size/time limits.

The input schema is defined by the public Rust DTOs. Required snapshot fields:
`schema: "cie.analysis-foundation.v1"`, `revision`, `semantics`,
`environmentDigest`, and `functions`. Functions have `id`, `source`, `gaps`,
and `operations`. Sources have `file`, `contentDigest`, `startByte`, `endByte`.
Operations have `id`, `source`, and tagged `action`, for example
`{"kind":"emit","resource":"stdout"}` or
`{"kind":"call","target":"provider-wrapper"}`.
Unavailable targets use `unresolvedCall` with a nonempty `reason`.

## Meaning and limits

Effects mean that an operation is represented in the supplied inventory or a
transitive callee. They do not mean the operation is reachable, occurs on all
paths, succeeds, commits, or satisfies a business contract. In particular,
writing a resource called `ledger` does not prove a refund. Resource names and
call bindings must be supplied by a trusted producer, not guessed from names.
`completeWithinModel` means propagation finished without supplied gaps; it is
not source completeness certification. Input digests are opaque producer
claims; source bytes are not reread or verified by this library.

Evidence is a summary-level set of supporting operation IDs, not per-effect
proof traces. Snapshots retain source mappings for those IDs. All summaries
are recomputed by `analyze`; `invalidated` supplies a plan for future cache
consumers, not a durable incremental cache. Revision-only changes do not
invalidate semantic summaries, but callers must refresh revision provenance.
Operations are unordered in this inventory; their sorting for fingerprints
must not be reused for future order-sensitive CFG representations.

## Next slices

1. Add fidelity-tested source/IR adapters, values, exact constants, explicit
   normal/exceptional CFG edges, types and language-specific semantics.
2. Add contracts with authority, and separate candidate/verified/violated/unknown
   conclusions. Test fake authorization, ignored rejection and exception paths.
3. Add persisted checkpoints, cache application/retraction and incremental versus
   clean-rebuild comparison; extend dependency tracking beyond calls.
4. Derive FCA contexts, structural graph projections and checked predicates.
   LLM naming consumes immutable records and cannot change facts or membership.

The print-only and delegation fixtures test normalized inventories, not Python
lowering or runtime authorization. This patch intentionally does not claim
end-to-end defect detection.
