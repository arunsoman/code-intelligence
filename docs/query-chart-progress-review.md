# Query and chart implementation progress review

Reviewed 2026-10-09 against `plans/code-explainer-query-chart-implementation.md` and the current working tree. The progress review is complete for this snapshot; the implementation is incomplete. Statuses below describe inspected code, and runtime claims are limited to the checks listed under verification evidence.

## Immediate runtime failure: repaired

The running server logged `no such table: chat_sessions` for both C15/conversation and C15/converse. The existing database was already at version 42; its version 40 was named `pr-impact-reports`. The new conversation migration reused version 40 and was therefore skipped by the migration runner's maximum-version check. Restarting alone would not have fixed this.

- Moved the additive conversation migration to version 43.
- Applied migration 43 to the running application's database without resetting its data.
- Verified C15/conversation on port 4317 succeeds.
- Submitted the exact question `what is this project about?` to C15/converse: `ok: true`, S27, one node. The request no longer fails with STORAGE_FAILURE. This sparse chart remains an answer-quality limitation; hosted use is disabled for the selected repository.
- Added upgrade coverage for existing version-42 databases and databases with sessions created under the earlier version-40 migration. Existing history and transcripts survive.

## Work package tracking

### Follow-up: project-purpose answer

The reported `what is this project about?` response was a diagram caption because classified intent 1 bypassed the overview-answer path. The first correction used the README; the user rejected that approach and required inference from source. That correction has now been replaced.

`Service.ask` now runs a distinct `SOURCE_OVERVIEW` task before rendering the chart. `project-purpose.ts` samples production operations and collaborators across modules, reads current source spans, and includes source excerpts, calls and behavioral facts. Documents are excluded. It rechecks source hashes, excludes inaccessible paths, bounds the sample and rejects ungrounded output references. The model uses the existing egress/budget gateway; the offline fallback makes limited inferences from supported operations and static calls rather than copying repository documentation. Each accepted statement becomes an inference claim with source evidence and is attached to the view's inspectable consequences. Current core/web TypeScript checks pass. The source snapshot was refreshed, and requested revision now takes precedence over an older displayed view's revision. The planned S27/S1 pair and broader context/navigation work remain incomplete.

The running server completed the exact question with a source-derived overview identifying a code-intelligence platform and explaining repository indexing, concept extraction, defect/search UI and PR analysis. The completed response was retrieved through C15/conversation and includes source file/line citations. The direct curl probe timed out at 60 seconds before completion; the durable response confirmed completion afterward. End-to-end latency remains a limitation, and this check does not certify a broader regression suite.

| Package | Status | Critical remaining work |
| --- | --- | --- |
| WP0: session and active chart context | Partial | Server-minted open/close APIs, lifecycle refusal, pending-first turns, idempotent retries, recovery, concurrent-turn handling, retention and secret handling. The current implementation persists a JSON transcript/context row; it does not implement the planned protocol. |
| WP1: intent contract | Partial | Canonical prompt/label consistency and complete contract enforcement. |
| WP2: classifier | Partial | Correct map-command gate, classifier regression coverage and legacy compatibility. |
| WP3: subject resolver and planner | Partial | Reject unknown subjects; clarify missing subjects and tied referents instead of choosing arbitrarily. |
| WP4: S29 registration | Implemented in inspected code; runtime coverage missing | S29 is in the schema union and registry as `compiler: "missing"`; `askView` refuses it before generation. Add the prescribed regression coverage. Its compiler is deliberately deferred by the plan. |
| WP5: zoom choices | Scaffold | Integrate type-specific choices and enforce the six-choice limit; current side choices include a seventh key. |
| WP6: service integration | Partial | Use the bounded model envelope everywhere, durable chart transitions, choices/clarification responses, correct overview and source-reading behavior. |
| WP7: web integration | Partial | Lifecycle and retry plumbing; durable Show-as changes; menus, breadcrumbs and restoration of chart context. |
| WP8: assembled verification | Incomplete | Resolve chart-rendering failures and add the specified session/classifier/ambiguity/recovery tests. |
| WP9: legacy deletion | Deferred | Keep deferred until the assembled regression gate passes. |
| WP10: documentation and evaluation | Partial | Classifier evaluation artifact, README updates and reconciliation of chart capability statements. |

## Fixes made during this review

1. Preserve an explicitly selected empty ER chart through converse; it previously fell back to a different map.
2. Translate native gallery V-codes into form selection instead of submitting invalid chart IDs. Preserve S-codes and the generic chart option.
3. Preserve full saved transcripts; removed destructive 200-turn and 6,000-character caps. Model context must be bounded independently of transcript storage.
4. Correct web TypeScript errors and include the web tsconfig in the root typecheck command.
5. Repair the deployed-database conversation migration collision described above.

## Remaining substantive findings

- **Hosted-access enforcement:** `Service.classifyIntent()` calls `router.classify()` directly with the question and referent labels, without checking `allowHosted`. `OllamaRouter.classify()` forwards that payload to a cloud model when configured. Chart generation's later offline fallback does not protect this earlier call. The recommendation endpoint already has an explicit allow/audit gate; apply equivalent enforcement to classification. This is a source-confirmed bypass; no external payload was sent to reproduce it during this review.
- **Retry and crash correctness:** turns are immediately marked complete, with transcript and chart updates saved separately. Repeating a request can duplicate turns; crashes can leave partial state. Implement the pending/recovery protocol before relying on durable conversations.
- **Premature topic changes:** classification calls `transitionContext(target, intentId)` before the target is grounded or a chart succeeds. A model-supplied target can clear the old referents/breadcrumb even when the requested chart subsequently fails. Resolve the subject first and commit context changes together with the completed response.
- **Overview and level consistency:** intent 33 is excluded from topic transitions even though the plan requires a fresh context. The projected compiler sets every generated view to level 5, which the session manager copies into its referents; `zoomLevelOf()` is imported but unused. A C4 overview can therefore carry the source-level depth rather than level 0, breaking level-scoped reference and zoom decisions.
- **Context isolation:** Show-as uses the direct ask path, bypassing conversation persistence. A chart switch can leave the server referent ledger on the previous chart.
- **Revision handling:** requested revision precedence was corrected during the source-purpose follow-up. Context replacement still loses navigation history without the planned warning.
- **Referent correctness:** tied same-turn referents resolve to the last item rather than ambiguity. Selection node IDs and entity IDs are not consistently compared. Missing or invented subjects can still produce plans.
- **Model budget:** `buildModelContext()` is not used by the service; its current output can exceed the specified total budget. A persistent session alone does not enforce a safe model context window.
- **Command classification:** the broad map gate captures ordinary words such as `boost` in a question, while missing commands such as `why not ledger`.
- **Chart semantics:** the projected compiler flattens typed output into generic graph nodes/edges. Matrix outputs and notation-specific roles are not consistently preserved. An explicit gap card is useful but does not demonstrate that the notation renders properly.
- **Session lifecycle:** unknown/foreign identifiers create separate empty sessions instead of following the planned refusal contract. Tested principal/tenant isolation prevents transcript disclosure, but lifecycle behavior remains incomplete.
- **Spring/JPA coverage:** passing Spring tests cover controllers, injection and transactions. They do not prove entity extraction across field/getter access and relationship ownership cases.

## Evidence and acceptance audit

These are substantive acceptance checks from the plan, rather than a count of files added. Source locations are relative to this report.

| Requirement | Inspected evidence | Assessment |
| --- | --- | --- |
| Server-owned session identity, open/close, archived/unknown refusal | [server.ts](../packages/core/src/server.ts#L94), [manager](../packages/core/src/chat-session.ts#L64), [UI identity](../apps/web/src/App.tsx#L85) | Incomplete. Only converse/conversation are registered; UI mints IDs. Manager has an unexposed open helper, implicit creation and no close operation. |
| Session/turn/chart-context tables, bounded closed-context audit | [migration 43](../packages/core/src/migrations.ts#L962), [context transitions](../packages/core/src/chat-session.ts#L165) | Incomplete. One JSON-row table; replaced contexts are not retained as audited closed rows. |
| Actor/tenant isolation and stateless mode | [session load](../packages/core/src/chat-session.ts#L64), [converse wrapper](../packages/core/src/service.ts#L2619), [isolation regression](../packages/core/test/query-context.test.ts#L50) | Isolation demonstrated; refusal and stateless warning contracts missing. Missing session IDs create stored sessions. |
| Pending-first completion, recovery, replay, payload conflict and concurrent-turn rejection | [turn persistence](../packages/core/src/chat-session.ts#L131), [converse wrapper](../packages/core/src/service.ts#L2619), [API key](../apps/web/src/api.ts#L3) | Incomplete. Immediate complete turns; separate writes; no saved response replay or in-flight enforcement. Client does not retain the required turn key. |
| Transcript secret minimisation and policy retention | [persistence](../packages/core/src/chat-session.ts#L118) | Missing on the new session write path. Preserving transcripts fixes truncation but does not implement policy retention. |
| Model envelope ≤6 turns and total serialized budget | [builder](../packages/core/src/chat-session.ts#L214), [agent history](../packages/core/src/service.ts#L2691) | Incomplete. Builder unused and text unbounded; manual agent history has per-turn slicing but no total envelope bound. |
| Re-index invalidation, preserved navigation and repository-switch refusal | [session reconciliation](../packages/core/src/chat-session.ts#L106), service converse revision selection | Incomplete. Supplied revision now takes precedence; replacement still loses breadcrumbs, without required audit/warning/refusal. |
| All 34 registered intents and strict classifier transport | [intent registry](../packages/schema/src/intents.ts#L16), [classifier](../packages/core/src/llm-router.ts#L145) | Registry and transport exist. Canonical labels are rewritten rather than exact echoes validated; end-to-end query coverage missing. |
| Deterministic map gate with zero model calls | [gate](../packages/core/src/service.ts#L2539) | Contradicted. Broad regex gates into model-backed `readText`; command/question examples fail as recorded above. |
| Grounded subject ladder, ties and name-over-pronoun precedence | [resolver/planner](../packages/core/src/query-router.ts#L5), [query integration](../packages/core/src/service.ts#L2717) | Incomplete. Planner always returns a plan; tied recency resolves arbitrarily. Resolved referent is not reliably substituted into the query plan. |
| Versioned ledger events and restored snapshots | [schema](../packages/schema/src/intents.ts#L97), [manager persistence](../packages/core/src/chat-session.ts#L118) | Schema exists; no integrated LEDGER event/snapshot protocol or version rejection. Parsed persisted JSON is cast rather than validated against it. |
| S29 schema + honest refusal, no compiler | [CFG contract](../packages/schema/src/index.ts#L715), [registry](../packages/schema/src/index.ts#L948), [refusal](../packages/core/src/service.ts#L1860) | Present in source. Dedicated schema/refusal/no-model regression missing. Deferred compiler is not an implementation defect. |
| Context-specific ≤6 choices, typed zoom targets and source leaf | [zoom scaffold](../packages/core/src/zoom-map.ts#L1), [imports only](../packages/core/src/service.ts#L54) | Incomplete. Generic targets, seven side choices, missing integration and source-leaf action. |
| Chat zoom renders a new chart; breadcrumb roundtrip survives reload | [server zoom](../packages/core/src/service.ts#L2748), [UI zoom](../apps/web/src/App.tsx#L513), [restore](../apps/web/src/App.tsx#L93) | Contradicted. Server returns a zoom message; UI changes the camera level. Restored turns contain text, not chart/menu/breadcrumb restoration. |
| Intent 33 opens fresh context; chart levels match semantic depth | [continuity intents](../packages/core/src/chat-session.ts#L166), [projected compiler](../packages/core/src/chart-creator.ts#L956), [view-context update](../packages/core/src/chat-session.ts#L145) | Contradicted. Overview keeps old context; projected diagrams all report level 5 and the manager inherits it. |
| Structured clarify/new-intent UI, menu click and typed-letter handling | [newIntent result](../packages/core/src/service.ts#L2727), [ChatPanel](../apps/web/src/ChatPanel.tsx#L28) | Missing. Unsupported intent becomes a plain message, with no structured clarification menu. |
| Default S27 then S1; single-file class/call-graph pair | [overview/query](../packages/core/src/service.ts#L2706) | Incomplete. Legacy overview forces SemanticMap; classified intent 1 yields one chart, not the required pair. Live reported question produced only S27. |
| Show-as updates the active server context | [askForm](../apps/web/src/App.tsx#L555) | Contradicted. Direct C19/ask lacks session identity and bypasses conversation persistence. |
| Legacy tests and assembled regression gate | [scripted router](../packages/core/test/scripted-router.ts#L22), [existing browser zoom test](../apps/web/test/e2e/zoom.test.ts#L39) | Existing tests exercise legacy routing/camera zoom, not the new classifier/navigation contract. Planned intent-classifier and zoom-map test files are absent. Focused sweep has 26 failures. |
| Registry-only pipeline and deletion sequence after green gate | [remaining standard/generic registry](../packages/schema/src/index.ts#L943), [compiler branches](../packages/core/src/chart-creator.ts#L978) | Deferred correctly while the gate is not green. Existing v1/generic paths remain; do not describe pipeline unification as achieved. |
| Honest gallery capabilities, README and classifier evaluation artifact | [parity doc](chart-parity-and-completion.md), [gallery](../apps/web/src/VisualsGallery.tsx) | Partial. Evaluation JSON absent; README unchanged; stale capability mapping still needs reconciliation. |
| Optional design-doc pack | Plan appendix A.7; reporter export absent | Not implemented, explicitly optional and nonblocking. |

### Fix priority

- P1: enforce hosted-access settings, implement pending/replay atomicity, ground subjects before transitions, and fix revision/context isolation across Show-as and reload.
- P1: restore typed chart semantics before claiming matrix/UML/C4 parity.
- P2: implement bounded envelopes, ambiguity menus, chart navigation and source leaves; complete classifier and navigation acceptance coverage.
- P2: reconcile documentation and evaluate the assembled gate before deletion work.

The focus/isolation and retention regression checks prove only their named cases. They do not prove lifecycle refusal, bounded model context, pending-turn recovery, every chart's rendering, or all 34 canonical questions.

## Verification evidence

| Check | Result |
| --- | --- |
| Query-context, session-migration and gallery-selection regression tests | 6 passed, 0 failed |
| Focused chart-rendering/chart-creator/route/retrieval sweep | 25 passed, 26 failed out of 51 |
| Spring framework tests | 7 passed; JPA coverage remains incomplete |
| Core + web TypeScript checks, including the storage correction | Passed |
| Web production build | Passed, with CSS syntax and bundle-size warnings |
| `git diff --check` | Passed |
| Live storage endpoint and exact reported question | Both succeeded after migration 43 |

Some chart failures use stale fixture expectations; others expose missing matrices, edges and notation roles. Review each failure against the intended renderer contract before updating an assertion. The full repository test suite has not been certified green.

## Next implementation order

1. Enforce hosted-access policy on the classifier, then finish WP0's pending/idempotent/lifecycle protocol and wire all conversation and Show-as routes through it.
2. Enforce revision-aware, ambiguity-safe subject resolution and use one bounded model context on every routing/generation path.
3. Preserve typed chart semantics in the compiler and renderer, with representative evidence fixtures for each notation.
4. Complete choices/navigation and run the assembled regression suite before removing legacy paths.
