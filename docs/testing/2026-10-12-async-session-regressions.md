# Async and session regression investigation

Date: 2026-10-12

Base: `8a907b6235b5f8e734c306a2d4a51c7acc73fe93` (`origin/main`). Local earlier patches are preserved on a checkpoint branch; this patch is based directly on pulled upstream.

## Confirmed defects and fixes

| ID | Severity | Reproduction / impact | Fix | Regression evidence |
|---|---|---|---|---|
| AS-01 | High | The action lease ended at the analysis deadline (or the fixed 120-second cap), discarding final results. | Reserve 15 seconds for finalization; preserve fencing and request/model deadlines. | conversation-actions.test.ts: deadline finalization and long requests |
| AS-02 | High | Thrown model failures discarded the turn; a null first-call timeout could fall through into expired fallback analysis. | Return a saved unresolved investigation on deadline/failure; retain fallback only for an early empty first reply. | answer-validation.test.ts: thrown and null timeout regressions |
| AS-03 | High | A model adapter ignoring AbortSignal could leave writer/reviewer calls pending indefinitely. | Race model calls against a hard deadline, abort cooperatively, ignore late completion, and consume late failures. | model-deadline.test.ts: ignored abort, method binding, zero budget and late rejection |
| AS-04 | High | A cached read through one session manager overwrote newer completed turns from another manager. | Reload unowned reads from storage; do not persist unchanged read-only session state. | session-read-race.test.ts: stale reader regression reproduced before the fix |
| AS-05 | Medium | Chat Show-result buttons changed the canvas without selecting the corresponding workspace tab. | Activate the matching cached workspace tab when showing a chat result. | chat-analysis.test.ts: Tests canvas and selected response tab agree |

## Validation results

| Run | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Broad patched unit/integration sweep | 1807 | 1691 | 106 | 10 |
| Clean upstream unit/integration comparison | 1826 | 1710 | 106 | 10 |
| Focused async/session regression run | 31 | 31 | 0 | 0 |
| Rust workspace | 103 | 103 | 0 | 0 |
| Final headless chat / compound / sequence regression run | 4 | 4 | 0 | 0 |

New failing test names relative to clean upstream: **0**. The 106 broad-suite failures remain unresolved; this is not a green release gate. Total registered test counts differed between runs, so the baseline comparison uses failing test names rather than subtracting pass totals.

Type checking, the plugin registry check and the web build passed. The web build reports its existing large-bundle warnings.

The broad sweep used `node --test --test-force-exit --test-timeout=30000 --test-concurrency=8` across core, model, evidence, canon, web, VS Code and reporter tests. Force-exit was needed because failed inherited tests kept child test processes alive. Native/compiler-dependent tests are subject to the available container environment.

Headless Chromium 141 exercised actual chat result switching, keyboard interaction, evidence inspection, camera restoration, direct/transitive set membership and reuse of response snapshots. The chat browser fixture was updated to build the required hierarchy, expand collapsed repository controls, select a workspace tab explicitly, and focus a graph node before inspecting it.

Two additional browser checks remain blocked by inherited test assumptions: the investigation-board test expects the older navigation/dialog UI, and the workspace-recovery test did not reach its Back-to-parent control. These are not included in the four passing final headless checks and require separate triage.

Observed inherited failure categories include a stale golden graph (the parser now emits a field), container `/proc` process visibility, and repository-question fixtures missing the required concept hierarchy. Other failures have not all been individually classified. They are listed below rather than being assumed harmless.

The new writer/reviewer hard deadline enforces completion even for non-cooperative adapters. It does not kill arbitrary adapter work already in flight; late completion cannot enter the chat flow. The finalization grace does not extend analysis budgets and does not let a superseded owner write.

## Remaining broad-suite failures

| File | Failed cases |
|---|---:|
| `packages/core/test/c05.test.ts` | 1 |
| `packages/core/test/c07.test.ts` | 1 |
| `packages/core/test/c08.test.ts` | 1 |
| `packages/core/test/c12.test.ts` | 1 |
| `packages/core/test/c13.test.ts` | 2 |
| `packages/core/test/c14.test.ts` | 2 |
| `packages/core/test/c15.test.ts` | 6 |
| `packages/core/test/c17.test.ts` | 1 |
| `packages/core/test/c29.test.ts` | 5 |
| `packages/core/test/change-risk-git.test.ts` | 1 |
| `packages/core/test/claims.test.ts` | 6 |
| `packages/core/test/defect-adapters.test.ts` | 3 |
| `packages/core/test/demobar.test.ts` | 1 |
| `packages/core/test/diagnostics.test.ts` | 1 |
| `packages/core/test/diff-local-rename.test.ts` | 2 |
| `packages/core/test/editor.test.ts` | 3 |
| `packages/core/test/evidence-snapshot.test.ts` | 1 |
| `packages/core/test/exports.test.ts` | 1 |
| `packages/core/test/feature-coverage.test.ts` | 1 |
| `packages/core/test/feature-perf.test.ts` | 1 |
| `packages/core/test/feature-runner.test.ts` | 8 |
| `packages/core/test/feature-scaffold.test.ts` | 2 |
| `packages/core/test/journey-flow.test.ts` | 2 |
| `packages/core/test/ledger-claims.test.ts` | 1 |
| `packages/core/test/ledger.test.ts` | 1 |
| `packages/core/test/matrix.test.ts` | 4 |
| `packages/core/test/nestjs-framework.test.ts` | 2 |
| `packages/core/test/nextjs-framework.test.ts` | 1 |
| `packages/core/test/overview.test.ts` | 1 |
| `packages/core/test/pipeline.test.ts` | 5 |
| `packages/core/test/platform.test.ts` | 4 |
| `packages/core/test/polyglot-adapters.test.ts` | 1 |
| `packages/core/test/polyglot.test.ts` | 2 |
| `packages/core/test/profile-flow.test.ts` | 2 |
| `packages/core/test/route.test.ts` | 1 |
| `packages/core/test/runtime-sandbox.test.ts` | 2 |
| `packages/core/test/search-nav.test.ts` | 1 |
| `packages/core/test/task-flow.test.ts` | 1 |
| `packages/core/test/tenant.test.ts` | 4 |
| `packages/core/test/testartifacts.test.ts` | 1 |
| `packages/core/test/twin-migrations.test.ts` | 1 |
| `packages/core/test/visuals.test.ts` | 17 |
| `packages/core/test/workspace.test.ts` | 1 |

### Failure names

- `packages/core/test/c05.test.ts` — golden multi-language repository: a TypeScript and a Rust package index to exactly the reviewed graph, and the parser says which languages it reads and how far
- `packages/core/test/c07.test.ts` — bounded RAM: parser memory is measured, held under a stated ceiling, and an index that would pass the ceiling fails cleanly, saves nothing, and leaves the system working
- `packages/core/test/c08.test.ts` — deleting a repository also removes its identities, lineage, workspaces, annotations and context events
- `packages/core/test/c12.test.ts` — why-hidden query: a hidden element is explained from its factor scores, and an unknown name says nothing matches
- `packages/core/test/c13.test.ts` — missing source: a workspace whose repository is gone still restores everything that is not evidence, and says so
- `packages/core/test/c13.test.ts` — stale claims: a refuted claim and an edited source mark exactly what depended on them, and nothing is deleted
- `packages/core/test/c14.test.ts` — local-model feature degradation: when the hosted budget is exhausted the offline model answers, says why, and nothing is sent
- `packages/core/test/c14.test.ts` — with budget available the hosted provider is used and charged
- `packages/core/test/c15.test.ts` — a cloud quota failure explains the limit and local-model option while preserving facts
- `packages/core/test/c15.test.ts` — authentication question: the map holds the login path with static evidence, groups are inferences, and nothing inferred is shown as fact
- `packages/core/test/c15.test.ts` — insufficient evidence: a question the repository cannot answer yields an empty map that says so, and an explain with no path invents none
- `packages/core/test/c15.test.ts` — prompt injection: repository text that gives orders is data; a model that obeys it is gated, and nothing it forges is drawn
- `packages/core/test/c15.test.ts` — bounded steps: one question costs a fixed, small number of model calls, whatever the repository says
- `packages/core/test/c15.test.ts` — cancellation: a model that never answers does not hold the question past its deadline, and the answer degrades to facts with a warning
- `packages/core/test/c17.test.ts` — changed-model regression: a model that finds fewer seeded concepts is caught with a paired test; an unmeasured model is not trusted; a small difference is not called a regression
- `packages/core/test/c29.test.ts` — concurrent edits: a stale version is a conflict that says what changed, edits keep their author, rebase works only on disjoint things, and a resolution is explicit and logged
- `packages/core/test/c29.test.ts` — denied recipient: sharing cannot give anyone source access, a partly-denied recipient sees a cut-down copy, and edits about code they cannot read are refused
- `packages/core/test/c29.test.ts` — correction in a shared concept: a team confirmation or refutation is attributed and reaches everyone who can see the concept, and no one else
- `packages/core/test/c29.test.ts` — tenant boundary: another organisation cannot be shared with, cannot see a workspace exists, and has its own store where it does not
- `packages/core/test/c29.test.ts` — handover with a source-access mismatch: the recipient gets what they may read and a count of what they may not; no access at all, a stale version or a non-owner stops it
- `packages/core/test/change-risk-git.test.ts` — the change-risk map reads git history for the whole repository at once, not by starting git once per file
- `packages/core/test/claims.test.ts` — audit log is hash-chained; tampering is detected; verdicts and asks are recorded
- `packages/core/test/claims.test.ts` — concept cards: capabilities, failure modes, invariants and async workflows, each grounded
- `packages/core/test/claims.test.ts` — egress: hosted models are blocked until the repo is opted in; secrets are scrubbed; everything is audited
- `packages/core/test/claims.test.ts` — converse: question → view, trace → investigation, steering, why-shown/hidden, resume
- `packages/core/test/claims.test.ts` — changesSince: re-index and report what changed in the repository since the investigation was saved
- `packages/core/test/claims.test.ts` — 'give me the project overview' builds a zoomed-out map of the project; zoom commands need a map
- `packages/core/test/defect-adapters.test.ts` — DP06: ThreadSanitizer on an instrumented native build reports the race with its locations, the exact source and build, and its exclusions; the atomic variant reports none and claims nothing
- `packages/core/test/defect-adapters.test.ts` — DP05: Loom checks a bounded model: it finds the lost update, completes the fixed model inside its bounds, and says neither is a general claim; unavailable adapters say why
- `packages/core/test/defect-adapters.test.ts` — DP14: a hostile function under stress cannot read outside the checkout, write, start a process, open a network connection or start a worker; an untrusted or edited checkout is refused
- `packages/core/test/demobar.test.ts` — the six-point MVP demo bar passes end to end with zero provenance violations (offline model)
- `packages/core/test/diagnostics.test.ts` — a real empty chart request emits a correlated retrieval, model and chart trace
- `packages/core/test/diff-local-rename.test.ts` — renaming only a local variable is not reported as a changed symbol in the semantic diff
- `packages/core/test/diff-local-rename.test.ts` — a real behavioural change is still reported as a changed symbol in the semantic diff
- `packages/core/test/editor.test.ts` — editor focus becomes referents: 'why are these connected?' works on pinned editor elements without a canvas selection
- `packages/core/test/editor.test.ts` — evidence carries an absolute path for open-in-editor links
- `packages/core/test/editor.test.ts` — live exceptions: a running app reports to the inbox; repeats collapse; the report maps onto the repository
- `packages/core/test/evidence-snapshot.test.ts` — snapshot migration rolls back and reapplies without rolling back older irreversible migrations
- `packages/core/test/exports.test.ts` — C30: revoked access reaches what was stored and what was queued: a stored export stops being readable, pending notices are cancelled, and nothing about the source is sent afterwards
- `packages/core/test/feature-coverage.test.ts` — #94B the local permission-model runner cannot observe coverage, says so, and no link is upgraded
- `packages/core/test/feature-perf.test.ts` — PF-029 a real run through the local runner: node executes the declared workload files and the S11 evaluation reads what they printed
- `packages/core/test/feature-runner.test.ts` — PF-020/038 audit: every negative probe is stopped by the local runner, and the omissions are disclosed with the report
- `packages/core/test/feature-runner.test.ts` — a passing run reports PASSED with its output and the runner's omissions
- `packages/core/test/feature-runner.test.ts` — a failing run is FAILED with the exit code; a missing binary is INFRA_ERROR, not a test failure
- `packages/core/test/feature-runner.test.ts` — a request cannot widen the boundary: roots, cwd and limits are validated before anything starts
- `packages/core/test/feature-runner.test.ts` — symlink escape: refused before the run, and a link created during a run that had write access fails it
- `packages/core/test/feature-runner.test.ts` — limits: wall clock kills the whole group, output is capped, abort cancels
- `packages/core/test/feature-runner.test.ts` — network DENY is never silently dropped: a command it cannot isolate is refused when the host has no namespace
- `packages/core/test/feature-runner.test.ts` — AT-24/57 a fencing token that is no longer current refuses the run, and one lost mid-run discards its result
- `packages/core/test/feature-scaffold.test.ts` — PF-041 scaffold: every operation has a unique key, an owner task and a typed NOT_FOUND stub that names it
- `packages/core/test/feature-scaffold.test.ts` — migration 33 creates the five record families, is reversible, and leaves older tables alone
- `packages/core/test/journey-flow.test.ts` — V4 journey marks conditions, else branches, loops and retry loops on the steps they affect, and says what it still does not know
- `packages/core/test/journey-flow.test.ts` — the same marks appear for Python code: conditions, loops and retry loops
- `packages/core/test/ledger-claims.test.ts` — low-confidence claims are never styled as facts: no estimate, and a distinct dotted hypothesis style exists on canvas
- `packages/core/test/ledger.test.ts` — ledger: every item marked done names tests that exist, and every blocked item says what it needs
- `packages/core/test/matrix.test.ts` — V15 matrix: routes by rules, with what each rule enforces, where a route gets around it, and what is only convention
- `packages/core/test/matrix.test.ts` — V12 matrix: behaviours by tests and properties, with how much of each behaviour a test reaches and what no test asserts
- `packages/core/test/matrix.test.ts` — the provenance audit catches a matrix that lies: a claim shown as fact, a cell without a claim, a dangling row, an unexplained state
- `packages/core/test/matrix.test.ts` — matrix cells as referents: a selected cell's row and column become 'these' for chat, and the answer is cited
- `packages/core/test/nestjs-framework.test.ts` — NestJS fixture: config values and env are extracted
- `packages/core/test/nestjs-framework.test.ts` — NestJS fixture: chat tools expose framework metadata
- `packages/core/test/nextjs-framework.test.ts` — Next.js fixture: tsconfig.json and env config values are extracted
- `packages/core/test/overview.test.ts` — project overview keeps Java visible beside a highly connected frontend, through both chat routes and zoom
- `packages/core/test/pipeline.test.ts` — auth question yields an auth-focused map with evidenced FACT edges
- `packages/core/test/pipeline.test.ts` — inferred edges carry grounded claims and are labeled INFERENCE
- `packages/core/test/pipeline.test.ts` — unmatched question stays empty instead of guessing
- `packages/core/test/pipeline.test.ts` — ungrounded model output is dropped and reported, never displayed
- `packages/core/test/pipeline.test.ts` — invalid provider output degrades to facts-only with a warning
- `packages/core/test/platform.test.ts` — C31: reference-count garbage collection removes only revisions nothing refers to, and a dry run removes nothing
- `packages/core/test/platform.test.ts` — C31: deletion propagation: deleting a repository removes every row derived from it, leaves other repositories alone, keeps only a content-free audit event
- `packages/core/test/platform.test.ts` — C32: dependency outages: a killed parser is replaced, a dead model degrades answers to facts, and health says which is down
- `packages/core/test/platform.test.ts` — C32: load and cost gates: the measured system is inside its budget, and a slower or hungrier one fails with the reason
- `packages/core/test/polyglot-adapters.test.ts` — the defect workflow offers the Go, Java and Python adapters for their languages, and still lists the ones it cannot run, with reasons
- `packages/core/test/polyglot.test.ts` — Java (Spring Boot), Go and Python: a polyglot repository indexes to exactly the reviewed graph, and the parser says it reads them
- `packages/core/test/polyglot.test.ts` — Spring Boot: calls through injected fields and parameters, same-package and cross-package references, @Transactional, @KafkaListener and a JUnit test are understood
- `packages/core/test/profile-flow.test.ts` — full chain (A1 + D2): a real --cpu-prof run is ingested, correlated to a windowed trace, and hotspots link back to entities
- `packages/core/test/profile-flow.test.ts` — deleteRepository purges the profile tables: links, per-revision mappings, artifacts keyed to them
- `packages/core/test/route.test.ts` — through the service: the model's reading builds the view, an explicit choice is never second-guessed, and no router means the plain map
- `packages/core/test/runtime-sandbox.test.ts` — NestJS runtime sandbox emits runtime facts
- `packages/core/test/runtime-sandbox.test.ts` — NestJS runtime introspection is scheduled as a job after indexing
- `packages/core/test/search-nav.test.ts` — F01-D6: revoking a repository removes its rows and invalidates a held cursor
- `packages/core/test/task-flow.test.ts` — deleting a repository takes its tasks, events, candidates, verdicts and publication rows with it
- `packages/core/test/tenant.test.ts` — C03: cross-tenant retrieval: a tenant cannot index, find, cite, explain or open another tenant's code, workspaces or claims
- `packages/core/test/tenant.test.ts` — C03: cross-tenant embeddings and caches: the same revision id in two tenants never shares vectors, history facts, overrides or concept cards
- `packages/core/test/tenant.test.ts` — C03: fail-closed egress: nothing leaves the machine when the policy is unknown, unreadable, unrecordable or the provider's nature is unclear
- `packages/core/test/tenant.test.ts` — C03: source-permission revocation: every derived thing becomes unreachable at once, running work is stopped, and then it is all deleted
- `packages/core/test/testartifacts.test.ts` — coverage and failing tests change what the gates and suspects say
- `packages/core/test/twin-migrations.test.ts` — F10 WP-02 twin schema applies and is reversible
- `packages/core/test/visuals.test.ts` — all seventeen forms are in the catalogue, each with a builder or a built-in route
- `packages/core/test/visuals.test.ts` — V4 transaction journey: lanes by module, steps in call order, failure exits, async hand-offs as hypotheses
- `packages/core/test/visuals.test.ts` — V5 data lineage: writers and readers of one field, transaction region, order-of-application risks
- `packages/core/test/visuals.test.ts` — V6 semantic diff: before and after side by side, with the consequences of what changed
- `packages/core/test/visuals.test.ts` — V7 archaeology: commits that shaped this code beside the constraints that still bind it
- `packages/core/test/visuals.test.ts` — V8 trust boundary: entries, gates, protected state, and unprotected paths as hypotheses with counter-arguments
- `packages/core/test/visuals.test.ts` — V15 policy map: rules enforced in code, escape routes around them, rules held only by convention
- `packages/core/test/visuals.test.ts` — V9 runtime overlay: reported exceptions and failing tests on the structure; frames outside the repository are fog
- `packages/core/test/visuals.test.ts` — V10 race windows: strands side by side, transaction brackets, flagged windows citing both statements
- `packages/core/test/visuals.test.ts` — V11 counterfactual: ghost removal, solid surroundings, consequences that are all hypotheses
- `packages/core/test/visuals.test.ts` — V12 test confidence: operations against the tests that reach them, with coverage and untested properties
- `packages/core/test/visuals.test.ts` — V13 ownership: formal vs de facto owners, bus factor, and a confirmation-pending claim for each de facto owner
- `packages/core/test/visuals.test.ts` — V14 concept atlas: concepts pinned onto the code that implements them, scatter, and missing enforcement
- `packages/core/test/visuals.test.ts` — V16 change-risk terrain: a composite per file with a shown formula, tunable weights, and missing data flagged
- `packages/core/test/visuals.test.ts` — the gallery reports what each visual needs and whether it is available
- `packages/core/test/visuals.test.ts` — V7 archaeology reads pull request references out of commit messages, and says the forge is not connected
- `packages/core/test/visuals.test.ts` — V9 runtime overlay gains measured latency from an ingested OpenTelemetry trace export
- `packages/core/test/workspace.test.ts` — save → reopen restores state; changed source marks evidence stale
