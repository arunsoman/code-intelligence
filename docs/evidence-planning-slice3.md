# Evidence architecture: slice 3

Apply after `evidence-architecture-slice2-5fb8e6e.patch`. The current pulled repository base is `2eb2606` (complete G6 migration). This patch does not duplicate either predecessor.

## Operational result

Explicit two-operand call comparisons now run through the normal question and conversation APIs. Both operands bind before retrieval, their roots are investigated together, and the result is computed deterministically over one shared snapshot. The model does not decide set membership or write the comparison answer. Generated diagrams receive the proven result members plus operand context; unknown candidates remain in the comparison surface rather than becoming confirmed result nodes.

Examples:

| Question | Operation | Evidence domain |
| --- | --- | --- |
| `functions called by both leftFlow and rightFlow` | Intersection | Current direct static calls |
| `functions called by either leftFlow or rightFlow` | Union | Current direct static calls |
| `functions called by leftFlow but not rightFlow` | A minus B | Current direct static calls |
| `functions called by rightFlow but not leftFlow` | B minus A | Current direct static calls |
| `functions calling either leftFlow or rightFlow` | Union | Incoming current direct static calls |

The grammar also accepts show/list/find prefixes, method/helper/component wording, quoted identifiers and exact entity IDs. Ordinary `A and B` does not imply intersection. More than two operands, nested prose and unsupported predicates are not guessed. The existing typed algebra can evaluate nested expressions, but this conversational parser deliberately starts with a tested two-operand grammar.

Duplicate names and unresolved operands stop before retrieval. The response names permitted candidate IDs and asks for an exact operand. There is no automatic first-candidate selection. A dedicated clickable ambiguity picker remains a later UI step.

## Three-valued membership

The comparison records left, right and result membership separately, with current call-site evidence. The center area has an expandable, bounded-height table containing Supported, Excluded and Unknown states; Inspect opens the existing evidence drawer. Collapsing it restores chart space. The G6 canvas, zoom, hover preview and camera restoration retain their current controls.

A positive call in either operand proves union membership. Intersection needs positive calls in both. A missing relationship does not prove exclusion. Consequently, a left-only observed call remains unknown in A minus B, and a difference query can have zero established matches while still listing unknown candidates. Presence in B establishes exclusion from A minus B. The parser/evaluator does not yet produce certified negative call membership.

Comparison prose and membership are deterministic. Charts still use existing typed compilers and model/offline layout planning, with existing semantic limits. Static call evidence does not establish runtime invocation, frequency or interaction ordering.

## Safe supporting-chart reuse

`ResponseManifest.snapshotId` identifies the original collection. Supporting GeneratedChart and SemanticMap requests send that ID and the original manifest question, rather than a diagram's descriptive tab caption. They project the saved collection without keyword/semantic retrieval, source recovery or collecting new evidence.

Before reuse, the service verifies exact question and revision, current access policy and source revocation. It checks hashes/readability for all collected entity source spans and current code evidence, including source omitted from the last model prompt. Checks are deduplicated by source/hash. It repeats validation after asynchronous generation, refusing a result if source or access changed during the request. Invalid, absent, mismatched or stale snapshots produce explicit failures; the UI does not silently switch to a different evidence universe.

Each projection ranks bound roots and notation requirements, reports omissions, and honors the prompt budget. The collection ID stays fixed while projection/cache IDs may change. If bound evidence alone exceeds the prompt budget, generation stops with BUDGET_EXCEEDED.

Charts opened from the gallery now show their written answer in chat, retaining the chart caption as a collapsed trace.

The workspace refuses a completion with the wrong snapshot. Supporting manifests add limitations while preserving the primary question, explanation, interpretation and snapshot. Existing request cancellation/attempt guards, navigation and checkpoint restoration remain in place. Ordinary per-view prose can still vary with the projection; this patch preserves the primary response narrative rather than claiming all generated prose is identical.

Native specialized forms retain their own analysis routes. Their requests do not claim static snapshot reuse. Reuse is not an authorization cache, a complete repository snapshot, or a guarantee that uncollected files remain unchanged. It establishes that the collected source still matches its revision-bound evidence. Snapshot retention/eviction and generalized runtime/causal reuse remain future work.

## Validation

Tests cover grammar/direction, duplicate and missing names, worker-indexed conversation comparison, union/intersection/both differences, source citations, snapshot persistence/reuse, question/revision mismatch, denied paths, revocation, and source edits before and during generation. Workspace tests check primary narrative preservation and snapshot mismatch. A headless browser indexes a real fixture, verifies all membership states, opens call evidence, and switches to a sequence tab using the original question and snapshot. Existing G6, sequence, zoom and checkpoint interactions are also exercised.

## Next

- Evidence-coverage obligations and targeted collection when a comparison cannot prove exclusions or chart semantics.
- Certified negative membership for supported, fully inspected static domains; dynamic dispatch stays unknown.
- A validated planner for nested natural-language expressions and other relationship/fact predicates.
- Clickable operand clarification, generalized specialized-route integration, and snapshot retention/performance measurements.
