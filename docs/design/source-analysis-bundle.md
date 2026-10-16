# Source analysis bundle 1

This bundle combines supported source control flow and shared analysis consumers.
It applies after P03b (`b5711fc`); the alternative cumulative patch applies after
P02a (`38158aa`) and includes P03a/P03b. Apply one alternative, never both.

## Public interface

`source_analysis::analyze(snapshot, sources, budget)` validates source hashes and
IR shape before deriving `cie.source-analysis.v1`. Its input digest includes the
analysis version, checked IR digest and budget. `source_analysis::slice` provides
bounded forward/backward dependency slices. The standalone worker exposes
`semanticAnalyze request.json`, using the same source request as `semanticLower`.
This is not wired into application answers, charts or incremental indexing.

Java, TypeScript and JavaScript adapters are enabled by default, with v4 semantic
metadata. Adding adapter files still uses automatic discovery. Language support
means the documented subset, not arbitrary source-level semantic equivalence.

## Supported source semantics

- Existing expressions/calls plus boolean if/else, early returns and blocks.
- Supported while/for forms, assignment updates and explicit loop edges.
- Same-typed branch joins and loop-carried values have opaque typed definitions:
  their exact path-specific values are unknown, never fabricated constants.
- Uncaught throws have exceptional exits. Simple JS/TS catch directs call/lookup
  exceptions to a handler with conservative local-state invalidation.
- Java typed catch, finally, break/continue, heterogeneous returns, complex
  hoisting/shadowing and unsupported constructs retain explicit opaque gaps.
- Source-level implicit coercion and complex dynamic dispatch remain unsupported.

## Shared projections

Instruction-level CFG edges distinguish normal, true/false, exceptional and
unknown outcomes. Immediate dominators and postdominators use bounded worklists.
No-exit regions retain a liveness gap. Graph edges do not establish feasibility.
Static def-use, structural control dependence and conservative all-resources
memory alias edges support slices; resource spelling never proves independence.
Invoke-result availability is restricted to its normal continuation.

Resolved-call SCCs use iterative traversal; monotone potential-effect summaries
propagate per-effect operation and call evidence. Summaries carry opaque/model
assumptions. Unreachable callsites are excluded from effect propagation; declared
call SCCs can include detached IR blocks. Caller-indexed propagation avoids
rescanning every call edge for each function. This is not a persistent incremental
cache or an implementation of every future abstract domain.

`must_effects` is null: must-effects are not computed. Return controls are direct
structural dependencies, not logical path predicates. Exit reachability is a
structural property, not proof of success, failure, termination or a business bug.
Per-effect evidence is present; assumptions remain summary-level, so F045 remains
partial. External contract/model dependencies and general transfer interfaces
remain future work.

## Resource bounds

Function count is checked before projection; oversized function counts return an
error. Per-function node/dependency limits and global algorithm-step limits report
BudgetExhausted. Step counts measure worklist/traversal operations, not total CPU,
allocation or host parsing time. Slices separately expose truncation. Partial
maps and summaries must not be treated as completed proofs.
