# Dedicated sequence renderer and stale-route fix

Apply `sequence-renderer-incremental.patch` after all five preceding patches. This patch changes S28; S2 remains the existing reserve swimlane notation.

## Compiler and contract

An optional versioned `SequenceSpec` travels with the ViewSpec and survives response persistence/export. It retains participant node IDs, message edge IDs, order numbers, sync/async/return/self kind, fragment membership, and alt/opt/loop/exception/par frames. The compiler keeps only current-evidence interactions with retained endpoints. Unknown endpoints, unavailable evidence/frames, and duplicate order numbers produce explicit gaps. Repeated messages are distinct, including self messages.

All sequence edges and ordering are labelled inference. Indexed source evidence is a prerequisite, not proof of runtime timing, return behavior, branch semantics or actual parallel execution. Parallel frames explicitly describe rows as display order. This slice does not add runtime traces or sentence-level entailment checks.

S28 now selects the `sequence` renderer through the generated plugin registry. Old saved S28 views without sequence metadata use the compatible graph surface; fresh requests get the dedicated surface. Chart contract version remains chart.v2 with the additive par fragment kind, while the S28 compiler descriptor version advances to 4.

## Interactive SVG

Participants occupy columns; messages occupy vertically ordered rows and lifelines extend downward. Return/async arrow patterns, self-call paths and control frames preserve their notation. Repeated interactions are not merged by graph zoom. Long labels reserve row/header space; self-call labels reserve right-hand space. Discontiguous fragment membership creates separate frames rather than enclosing unrelated messages. Nested fragment trees/branch operand partitions are not represented by the current flat plan contract.

Participant/message selection and inspection use existing source/evidence drawers. Tab, arrow keys, Home/End, Enter, Space, pan/zoom and box selection are supported. Box selection selects participant headers. The camera saves/restores through the existing response workspace. A message table supplies an accessible text alternative with evidence actions. Message ordering remains fixed while navigating or zooming.

The circular preview captures only the hovered/focused participant or message before rendering, retains the automatic outer/inner geometry and offers pause/resume. It is a detail card, not a distorted rendering of nearby elements. Preview settings are not exposed. The SVG view preserves its camera on resize; Fit explicitly reframes it, subject to a readable zoom floor and panning for large diagrams.

## Geometry defect

Re-layout previously retained obsolete edge waypoints when a moved graph no longer required a routed detour. An old Race Window route then crossed another node. Re-layout now keeps an existing route only when it still clears current node geometry; the relationship, evidence and source snapshot remain intact. A regression test covers this failure.

The broad layout quality test reaches an existing Ownership crossing-limit failure after the Race Window obstruction is removed. Independent before/after measurements found eight Ownership crossings at level 3 in both versions (limit six). The threshold was not loosened. This patch does not claim the whole geometry suite passes.

## Verification

Run:

```bash
npm run typecheck
node --test packages/core/test/sequence-compiler.test.ts apps/web/test/sequence-renderer.test.ts packages/core/test/plugin-architecture.test.ts packages/core/test/answer-workflow.test.ts apps/web/test/fisheye.test.ts apps/web/test/response-workspace.test.ts packages/core/test/query-context.test.ts
node --test apps/web/test/layout.test.ts
npm run web:build
node --test apps/web/test/e2e/sequence.test.ts
```

The browser test exercises a real indexed repository and stub-generated sequence via the application, including evidence inspection, captured hover, keyboard and tab camera restoration. It skips when the existing test harness's Chrome executable is absent. Chromium installation was attempted in this environment, but its downloaded archive was invalid, so no browser interaction success is claimed.
