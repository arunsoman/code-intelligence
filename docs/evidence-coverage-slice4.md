# Slice 4: source coverage and verified direct-call exclusions

Apply after slice 3. The upstream baseline is `6fa8b43` (slice 2); this patch contains only slice 4 changes.

## Behavior

An outgoing comparison such as `functions called by leftFlow but not rightFlow` now establishes exclusions when the relevant implementation has been fully inspected. A complete scan of `rightFlow` can prove that `leftHelper` is absent from its **direct static call sites**. The comparison includes the current source evidence so Inspect can show the basis for that exclusion.

The collection remains bounded. This is not a proof that a helper never executes, cannot be reached transitively, or is absent from the repository. Incoming comparisons still cannot establish missing callers from a neighborhood sample. Ordinary questions and other predicates retain their existing behavior.

## Coverage-driven investigation

- Reserve 65% of the cooperative investigation deadline for source inspection, rather than spending the entire deadline walking indexed relationships.
- Put explicitly bound operands before reachable helpers when inspecting source.
- Recover direct calls even when the index omits their edges. Prefer recovered direct targets over incoming caller context when the entity budget is full.
- Record per-operand `callObligations` as complete or unknown, and per-body `directCallCoverage` certificates with target IDs and revision-bound evidence.
- Keep completed body scans separate from deeper tracing limits: completing a caller's direct calls does not require completing every callee's implementation.

This is a bounded expansion policy, not an unlimited retry loop. Unsupported languages, inaccessible imports, stale source, parsing failures, missing implementations, unresolved dispatch and file/byte/time limits leave obligations unknown. Constructors, tagged templates, JSX and decorators conservatively prevent certification. Mutable bindings, including destructuring assignments and increments, cannot produce a certificate for the caller.

## Shared snapshot and proof handling

Certificates participate in snapshot identity and their evidence is persisted for inspection. Only certificates for retained subjects and targets enter a collection or model projection. Evaluation requires matching revisions, current static evidence, all subjects covered, and no contradictory or unresolved outgoing indexed call. Missing keys remain unknown; the existing three-valued set operators are unchanged.

Comparison tables list observed candidates, not every unrelated entity in the snapshot. Supported/Excluded/Unknown labels, chart tabs, primary narrative ownership, camera behavior and the captured hover lens retain the existing UI. A verified difference now has supported results where slice 3 could only show unknown candidates.

## Limits and later work

The source scanner supports immutable direct TypeScript/JavaScript bindings and relative imports. It does not certify runtime order, polymorphic dispatch, transitive closure, whole-repository incoming-call coverage, or arbitrary compound predicates. Expanding those requires separate coverage contracts and extractors; this certificate must not be reused as their absence proof. Native/runtime evidence routes are unchanged.
