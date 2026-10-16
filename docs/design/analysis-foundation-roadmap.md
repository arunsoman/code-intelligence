# CIE Rust analysis foundation — implementation checklist

Updated: 2026-10-16. Scope: the new IR-based behavior, rule, concept and
conformance pathway. This is not a retrospective audit of all CIE features.

## How this checklist is maintained

- `[x]` means implemented and validated in a delivered patch, within the scope
  stated here. It does not mean merged, deployed or enabled in the application.
- `[ ]` means pending. Partial implementations remain unchecked, with a note.
- Stable task IDs survive patch regrouping. Patch numbers after P01 are planned
  packages, not fixed estimates or promises of one-turn delivery.
- Every implementation patch updates this file, adds its validation record and
  records newly discovered limitations. Never close an item on design alone.
- If pulling upstream changes the implementation, recheck affected completed
  items; reopen them when regression evidence warrants it.
- Do not use task counts as a percentage of engineering effort.

## Patch ledger

| Patch | Scope | Delivery | Integration / enablement | Validation |
| --- | --- | --- | --- | --- |
| P01 | Initial Rust operation-inventory foundation | Delivered as `cie-rust-analysis-foundation.patch`, base `4a748fd` | Local implementation; upstream merge not checked; standalone worker command only | 164 workspace tests passed, including 13 new tests; release build and crate Clippy passed |
| P02 | Semantic IR schema and trust boundary, F019–F028 | Delivered as `cie-p02-semantic-ir.patch`, based on P01 / local baseline `3d13731` | Library only; no source adapter or application switch | 21 new semantic IR tests; 185 workspace tests passed; release build and crate Clippy passed |
| P02a | Default Java/TS/JS adapters and automatic file discovery, F172–F180 | Delivered as `cie-default-language-adapters.patch`, after P02 / local base `48f1ba2` | Standalone library/worker; literal-return subset only | 200 workspace tests passed, source execution oracles and file-only discovery smoke passed |
| P03a | Straight-line expressions and source fidelity, F036 and F181–F185 | Delivered as `cie-p03a-expressions.patch`, after P02a / base `38158aa` | Library/standalone worker; wider P03 still pending | 213 workspace tests passed; source execution comparisons and golden vectors |
| Remaining P03–P19 | Planned below | Pending | Pending | Pending |

P01 code: `crates/analysis-foundation`; worker command: `analysisFoundation`.
Evidence: `docs/testing/2026-10-16-rust-analysis-foundation.md`.
Boundary: `docs/design/rust-analysis-foundation.md`.

## Operating principles

Source/build evidence is authoritative input. Semantic IR is the canonical
analysis representation only for semantics its producers preserve. The existing
similarity IR is lossy and cannot be silently promoted to verification IR.

Facts, inferred hypotheses, contracts and checked conclusions remain distinct.
Missing code is unknown, not pure behavior. Potential effects are not guaranteed
effects. A call is not evidence of successful execution or a committed outcome.
LLM labels cannot change facts, membership, contracts or proof status.

Java, TypeScript and JavaScript are registered by default in the new semantic
pathway (P02a), with literal-return lowering and explicit opaque regions. P03
expands those adapters; Python is an additional adapter rather than a prerequisite.
Existing broad indexing support does not imply complete new semantic coverage.
Each language keeps a construct/capability matrix; Java/Spring and dynamic/async
TS/JS semantics remain P09/P17 work.

## P01 — Initial reusable Rust boundary: delivered

- [x] F001 Create an independently consumable Rust workspace library.
- [x] F002 Define versioned snapshot/function/operation/source records.
- [x] F003 Require revision, semantics and environment version inputs.
- [x] F004 Validate nonempty identities, duplicate IDs, source ranges and call targets.
- [x] F005 Reject unknown input fields and unsupported schema versions.
- [x] F006 Represent read/write/emit/raise/return and statically bound calls.
- [x] F007 Represent unknown operations and unresolved calls with reasons.
- [x] F008 Preserve producer coverage gaps and propagate callee gaps.
- [x] F009 Compute transitive represented potential effects with a fixed-point worklist.
- [x] F010 Handle recursive call cycles without recursive stack traversal.
- [x] F011 Carry summary-level operation evidence IDs through delegation.
- [x] F012 Expose explicit propagation budgets and exhaustion status.
- [x] F013 Produce deterministic inventory fingerprints and revision-aware run digests.
- [x] F014 Plan invalidation through old/new reverse call edges, including deletions.
- [x] F015 Invalidate on semantics/environment changes; distinguish revision refresh.
- [x] F016 Expose the library through a standalone worker JSON command.
- [x] F017 Test print-only inventory, delegation, recursion, unknowns and invalidation.
- [x] F018 Test worker success/error output and run required Rust checks.

Acceptance met for normalized inventories only. No source lowering, business
contract checking, durable cache, application routing or complete semantic IR
is claimed by these checkmarks.

## P02 — Semantic IR schema and trust boundary: delivered

Depends on P01. Deliver a versioned semantic representation without breaking
inventory consumers; do not extend unordered inventory hashing to ordered code.

- [x] F019 Define typed value, operand, basic-block and instruction identities.
- [x] F020 Preserve exact constants and their language types; define numeric encoding.
- [x] F021 Represent operators, parameters, returns and memory/resource locations.
- [x] F022 Represent normal and exceptional successors with edge kinds.
- [x] F023 Separate function declaration, call-site target set and binding evidence.
- [x] F024 Represent opaque/unsupported instructions and omitted regions explicitly.
- [x] F025 Bind every document to verified source bytes, language and lowering version.
- [x] F026 Check file-digest consistency, references, block ownership and terminators.
- [x] F027 Define schema compatibility, migration/rejection and serialization vectors.
- [x] F028 Document which semantics are guaranteed, approximated or unsupported.

Acceptance: malformed graphs rejected; changing a predicate, constant, edge or
environment changes the relevant digest; ordered semantics survive round trips.

## P03 — First source adapter and translation-fidelity suite

Depends on P02/P02a. Expand the default Java/TS/JS adapters first; add Python
through the same file-discovered interface. Literal-return lowering already exists
as a narrow partial implementation; the full task scopes below remain open.

- [ ] F029 Lower declarations, parameters, constants, expressions and returns.
- [ ] F030 Lower assignment, conditionals and supported loop forms.
- [ ] F031 Lower calls and distinguish resolved builtins from rebound names.
- [ ] F032 Lower supported raise/try/except/finally semantics and early exits.
- [ ] F033 Keep nested functions separate and model supported lexical bindings.
- [ ] F034 Emit explicit gaps for dynamic dispatch, reflection and unsupported features.
- [ ] F035 Account for every encountered construct as lowered, opaque or excluded.
- [x] F036 Add golden source-to-IR fixtures with byte-accurate provenance (initial Java/TS/JS straight-line subset, P03a).
- [ ] F037 Compare selected source executions with an independent IR execution oracle.
- [ ] F038 Test nonpositive quantities, NaN, bypass mutation and unresolved overloads.

Acceptance: print-only and delegating functions are analyzed from actual source;
tests exercise exceptional behavior; unmodeled semantics cannot silently disappear.

## P04 — Shared analysis projections and compositional summaries

Depends on P02/P03. Analysis representations remain separate projections.

- [ ] F039 Derive CFG and dominator/post-dominator relations with exception handling.
- [ ] F040 Derive def-use/value flow and explicit memory-alias approximations.
- [ ] F041 Derive program-dependence and forward/backward slicing projections.
- [ ] F042 Build call graph SCCs and versioned per-function summaries.
- [ ] F043 Preserve path conditions, return-value dependencies and exception outcomes.
- [ ] F044 Separate potential effects from must-effects; define supported inference rules.
- [ ] F045 Attach evidence and assumptions per effect/property, not only per summary.
- [ ] F046 Propagate unresolved target sets and external-model dependencies.
- [ ] F047 Define reusable transfer-function/worklist interfaces for supported analyses.

Acceptance: wrapper summaries cite the correct callee/path; alias uncertainty and
unreachable-path limitations remain explicit; recursion produces bounded results.

## P05 — Contract registry and result semantics

Depends on P02; checking uses P04. Contracts are not inferred facts.

- [ ] F048 Define preconditions, postconditions, effect and protocol obligations.
- [ ] F049 Record authority: approved specification, explicit annotation, test or hypothesis.
- [ ] F050 Preserve provenance/version and distinguish observed from normative behavior.
- [ ] F051 Support repository contracts with schema validation and scope binding.
- [ ] F052 Define conflicts, supersession and ambiguous binding behavior.
- [ ] F053 Separate completion status from candidate/verified/violated/unknown conclusions.
- [ ] F054 Store assumptions, analysis scope and counterexample evidence with conclusions.
- [ ] F055 Keep labels outside immutable semantic identity and contract predicates.

Acceptance: an inferred naming expectation cannot certify a defect or override
an explicit contract; timeout/unknown cannot be converted to success.

## P06 — First end-to-end behavioral anomaly slice

Depends on P03–P05. Target authorization anomalies before broad concept mining.

- [ ] F056 Detect print-only/empty implementations against explicit effect obligations.
- [ ] F057 Detect unconditional success under a supported authorization contract.
- [ ] F058 Accept legitimate delegation when its obligations can be established.
- [ ] F059 Detect caller paths that ignore a supported failure result.
- [ ] F060 Detect supported exception-to-success transformations.
- [ ] F061 Detect branch paths that bypass required authorization.
- [ ] F062 Report unavailable provider behavior as unknown rather than absent.
- [ ] F063 Keep name/implementation mismatch as a separately marked suspicion.
- [ ] F064 Add positive/negative fixtures and independently inspect counterexamples.

Acceptance: demonstrate actual source → IR → summary → contract result with source
links. Include at least one valid wrapper and one unknown external implementation.

## P07 — Solver-backed predicates and refinement

Depends on P04–P06. Add targeted precision after a useful basic detector exists.

- [ ] F065 Define supported SMT encoding with language-correct arithmetic semantics.
- [ ] F066 Add initiation/preservation checks for supported candidate invariants.
- [ ] F067 Check counterexample path feasibility within the declared model.
- [ ] F068 Add targeted abstraction refinement for supported spurious paths.
- [ ] F069 Map SAT/UNSAT/unknown/timeout to scoped conclusions correctly.
- [ ] F070 Include solver/model versions, assumptions and query digests in evidence.
- [ ] F071 Add numeric boundary, nullability, alias and exception regression cases.
- [ ] F072 Bound solver time/memory and preserve partial findings on exhaustion.

Acceptance: impossible paths are not presented as confirmed defects; bounded
checks do not imply unbounded proofs; model assumptions are inspectable.

## P08 — Durable incremental execution and recovery

Depends on P02/P04; apply the mechanism to P06 before expanding it.

- [ ] F073 Persist IR/projection/summary artifacts with versioned content keys.
- [ ] F074 Apply invalidation plans and retract stale facts/results atomically.
- [ ] F075 Extend dependencies beyond calls to resources, contracts and binding/config inputs.
- [ ] F076 Define stable identity and split/merge/rename lineage behavior.
- [ ] F077 Checkpoint completed analysis work and safely resume interrupted runs.
- [ ] F078 Reject incompatible checkpoints and refresh revision provenance on reuse.
- [ ] F079 Bound bytes, nodes, work, wall time and cancellation independently.
- [ ] F080 Add crash/reload/corruption/cancellation recovery tests.
- [ ] F081 Compare incremental results with clean recomputation after edits and deletions.
- [ ] F082 Test shared-resource changes and added/removed call targets.

Acceptance: interrupted runs cannot publish complete results; old findings disappear
after deletion; incremental and clean runs agree under the same configuration.

## P09 — Java/Spring adapter and wallet integration

Depends on P02–P06. Required before claiming coverage of the original wallet case.

- [ ] F083 Lower the selected Java subset with exact constants and exceptional flow.
- [ ] F084 Resolve supported overloads, inheritance and injection bindings with evidence.
- [ ] F085 Model relevant Spring proxies/configuration and flag unsupported bindings.
- [ ] F086 Represent transaction demarcation, commit/rollback and uncertain boundaries.
- [ ] F087 Represent scheduled jobs, retries and asynchronous handoffs explicitly.
- [ ] F088 Model persistence/provider boundaries through declared adapters/contracts.
- [ ] F089 Add source/IR fidelity and conformance tests for Java/Spring constructs.
- [ ] F090 Run a bounded wallet investigation and report exact coverage/missing evidence.

Acceptance: no conclusion based solely on method names or annotations; unresolved
transaction/provider behavior remains a gap. Banking semantics require contracts.

## P10 — Rule and protocol inference

Depends on P04/P05/P07. Inference generates candidates for validation.

- [ ] F091 Extract local guards, calculation expressions and state-transition predicates.
- [ ] F092 Infer supported API sequencing/resource-lifecycle candidate obligations.
- [ ] F093 Detect contradictory checks and inconsistent error-handling patterns.
- [ ] F094 Separate statistical support from logical verification status.
- [ ] F095 Record training/observation scope and prevent absence-of-observation claims.
- [ ] F096 Validate supported candidates; retain unverified candidates distinctly.
- [ ] F097 Deduplicate equivalent supported predicates without merging different assumptions.
- [ ] F098 Measure candidate precision and false positives against reviewed examples.

Acceptance: repeated buggy behavior cannot become an authoritative specification;
every inferred rule has a derivation and an explicit validation state.

## P11 — Formal concept extraction

Depends on P04/P10. Use local bounded contexts before global enumeration.

- [ ] F099 Define formal object/attribute/incidence projections from verified facts.
- [ ] F100 Implement closure operators and test formal-concept identities.
- [ ] F101 Derive overlapping behavior/resource/role concepts with provenance.
- [ ] F102 Define implication scope; do not equate context implications with invariants.
- [ ] F103 Bound attributes/concepts/work and report partial enumeration.
- [ ] F104 Handle insertions and deletions; compare with clean local recomputation.
- [ ] F105 Add clone, crosscutting concern and ambiguous-attribute fixtures.
- [ ] F106 Preserve source evidence for each membership and shared attribute.

Acceptance: deterministic scoped results, explicit caps and multiple membership;
no claim that all possible semantic concepts have been enumerated.

## P12 — Structural hierarchy model selection

Depends on P04/P11. Research-backed candidates must earn production selection.

- [ ] F107 Construct directed typed multilayer graphs with evidence and coverage.
- [ ] F108 Assemble reviewed decomposition examples and holdout evaluation cases.
- [ ] F109 Implement directory/simple clustering baselines and a software-specific comparison.
- [ ] F110 Prototype nested degree-corrected SBM/MDL inference against those baselines.
- [ ] F111 Evaluate utility hubs, overlapping roles, small groups and correlated layers.
- [ ] F112 Measure partition quality, stability, runtime and memory across multiple starts.
- [ ] F113 Select the production method from measured tradeoffs; record rejected options.
- [ ] F114 Add incremental updates, ancestor changes and fallback global recomputation.
- [ ] F115 Present structural groups as candidates, with business-context evidence separate.
- [ ] F116 Preserve graph/lattice relationships instead of forcing every type into one tree.

Acceptance: publish evaluation data and uncertainty; do not equate a lower MDL
score with proven business correctness or compare incompatible encodings blindly.

## P13 — Restricted LLM naming

Depends on stable records from P06/P11; useful before P12 is complete.

- [ ] F117 Define an immutable naming input with IDs and evidence-backed summaries.
- [ ] F118 Restrict output to known IDs and validated labels with bounded lengths.
- [ ] F119 Reject added facts, memberships, parent changes and proof-status changes.
- [ ] F120 Provide deterministic fallback labels and retry/cancellation handling.
- [ ] F121 Cache labels by relevant semantic digest, model, prompt and locale versions.
- [ ] F122 Test prompt injection in source names/comments and malformed naming output.
- [ ] F123 Evaluate label usefulness separately from structural/conformance accuracy.

Acceptance: disabling the LLM leaves the same analysis records and relationships;
only labels differ. Naming failure cannot block analysis completion.

## P14 — Existing CIE store and answer integration

Depends on P05/P06; concepts can be integrated when P11 becomes available.

- [ ] F124 Map records into existing evidence/store contracts with compatibility tests.
- [ ] F125 Retain revision, coverage, assumptions and per-claim evidence across transport.
- [ ] F126 Route relevant questions to the new analysis pathway under explicit configuration.
- [ ] F127 Produce supported partial answers without inventing missing outcomes.
- [ ] F128 Expose continuation actions targeting exact unresolved work.
- [ ] F129 Prevent stale results being mixed with fresh source revisions.
- [ ] F130 Add shadow comparison, rollback and enablement documentation.
- [ ] F131 Validate real question → source analysis → answer in a supported repository.

Acceptance: the new pathway is demonstrably consumed; existing CIE validation
does not discard supported findings merely because another claim is unknown.

## P15 — Charts and evidence navigation

Depends on P14; hierarchy views additionally depend on P11/P12.

- [ ] F132 Derive chart content from the same immutable answer evidence snapshot.
- [ ] F133 Represent branches, unknown calls, gaps and incomplete recovery visibly.
- [ ] F134 Distinguish observed/inferred/verified relationships in chart legends.
- [ ] F135 Navigate concept → behavior → operation → source and evidence.
- [ ] F136 Show overlapping concepts and alternate structural grouping without false nesting.
- [ ] F137 Validate chart semantics against source records for each enabled chart type.
- [ ] F138 Test browser reload, continuation, semantic zoom and large-result interaction.

Acceptance: charts cannot imply a successful refund where evidence establishes
only a call or an unknown result; answer and chart revisions always match.

## P16 — Distributed recovery models and execution validation

Depends on P07/P09; runtime adapters may be built alongside static work.

- [ ] F139 Specify debit, top-up, refund and recovery state machines with authority.
- [ ] F140 Separate safety from liveness; record fairness/provider/scheduler assumptions.
- [ ] F141 Capture execution lineage and correlate traces with source/IR revisions.
- [ ] F142 Add targeted provider timeout/rejection/ambiguous-result fault scenarios.
- [ ] F143 Inject refund failure, crash-before/after-commit and scheduler interruption.
- [ ] F144 Exercise midnight/date boundaries, delayed callbacks and missing gateway logs.
- [ ] F145 Exercise duplicate callbacks, duplicate recovery and concurrent retries.
- [ ] F146 Assert effective ledger outcomes and idempotency, not only status strings.
- [ ] F147 Minimize and replay failing schedules with explicit scope/bounds.
- [ ] F148 Compare static findings, model counterexamples and runtime observations.

Acceptance: reproduce at least one seeded stranded-debit defect and verify its
fix under declared scenarios. Passing finite tests does not prove eventual recovery.

## P17 — Remaining language capability expansion

Depends on P02–P06. Each adapter is a separate possible patch package.

- [ ] F149 Deliver TypeScript/JavaScript capability matrix and fidelity-tested adapter.
- [ ] F150 Cover JS promises/rejections, closures and dynamic property/call gaps explicitly.
- [ ] F151 Deliver Rust capability matrix and fidelity-tested adapter.
- [ ] F152 Distinguish Rust Result, panic, ownership and unsafe/FFI model boundaries.
- [ ] F153 Deliver Go capability matrix and fidelity-tested adapter.
- [ ] F154 Cover Go goroutines/channels, defer and panic/recover within declared scope.
- [ ] F155 Test cross-language external calls and mixed-repository coverage reporting.

Acceptance: capabilities are advertised per construct/language, not a blanket
“supports language” label. Unsupported concurrency or FFI remains visible.

## P18 — Performance, scale and quality gates

Measure from P03 onward; this package consolidates optimizations after profiling.

- [ ] F156 Establish cold/warm/incremental baselines on small, medium and large repositories.
- [ ] F157 Record p50/p95 latency, peak memory, invalidation fanout and cache reuse.
- [ ] F158 Include low-end laptop measurements and fixed resource configurations.
- [ ] F159 Benchmark edits, deletions, renames, dependency updates and global changes.
- [ ] F160 Profile storage, serialization, projections, solving, concepts and naming separately.
- [ ] F161 Set measured regression thresholds and publish raw benchmark artifacts.
- [ ] F162 Audit evidence precision, conclusion calibration and false-positive rates.
- [ ] F163 Run name-obfuscation tests: analysis facts must not follow misleading labels.
- [ ] F164 Add schema fuzzing, parser malformed-input tests and independent fixture review.

Acceptance: report measured gains and tradeoffs; do not project the earlier motif
cache speedup onto the new semantic-analysis/concept pipeline.

## P19 — Rollout and completion review

Depends on the capabilities selected for release; broader research can remain gated.

- [ ] F165 Define supported release scope and exclusions explicitly.
- [ ] F166 Verify migration/rollback, schema compatibility and cache-version behavior.
- [ ] F167 Run end-to-end browser acceptance on the selected anomaly and wallet scenarios.
- [ ] F168 Verify default/feature-flag behavior and document which pathway is enabled.
- [ ] F169 Publish operational diagnostics for gaps, budgets, resume and stale results.
- [ ] F170 Reconcile this checklist against code, tests and upstream merge state.
- [ ] F171 Document residual risks and separate experimental algorithms from supported features.

Acceptance: no “complete extraction” claim without a defined construct universe
and measured accounting; no “verified” claim without its model and assumptions.

## P02a — Default languages and file-discovered extension: delivered

These additional tasks record the default-language requirement added after P02.
They do not close the broader adapter milestones prematurely.

- [x] F172 Define a reusable adapter trait and conflict-checked extension registry.
- [x] F173 Discover adapter source files automatically at Cargo build time.
- [x] F174 Register Java by default using its actual parser grammar.
- [x] F175 Register TypeScript and TSX by default with correct grammar selection.
- [x] F176 Register JavaScript and JSX by default using the JavaScript grammar.
- [x] F177 Lower the declared literal-return subset and preserve unsupported regions as gaps.
- [x] F178 Compare selected Java/TS/JS literal results with independent Java/Node execution.
- [x] F179 Expose adapter metadata and real-source lowering through worker commands.
- [x] F180 Exercise file-only registration by adding/removing a probe adapter during a build.

Acceptance evidence: `docs/testing/2026-10-16-default-language-adapters.md`.
Contract and extension instructions: `docs/design/language-adapters.md`.
No complete language semantics, source-level anomaly detection or answer routing
is claimed. New grammar dependencies still need Cargo changes and semantic tests.

## P03a — Straight-line expression slice: delivered

F029 remains partial: selected forms are implemented, broader declaration/type/
expression forms still require coverage. Calls, branches, loops and exceptions
are not implemented by this slice. Separate task IDs make the delivered boundary
visible without closing the whole P03 milestone.

- [x] F181 Lower supported parameter references, initialized locals and simple local reassignment.
- [x] F182 Lower selected unary, arithmetic and comparison expressions with typed operands.
- [x] F183 Discard candidate lowering on unsupported statements so side effects cannot vanish.
- [x] F184 Preserve explicit type assumptions and bump adapter/semantics versions for cache safety.
- [x] F185 Compare selected expression IR execution with independent Java/Node source execution.

Evidence: `docs/testing/2026-10-16-p03a-expressions.md`. Scope:
`docs/design/straight-line-expressions.md`. F036 golden snapshots are delivered
for this subset; no universal source-fidelity claim is made.

## Patch update template

For each delivered patch append a ledger row with:

1. Patch filename, upstream base and commit/PR when available.
2. Task IDs completed, remaining partial IDs and any reopened IDs.
3. Validation commands/results and links to retained evidence.
4. Supported language/construct scope and unresolved limitations.
5. Integration state: library-only, standalone, shadow, enabled or deployed.
6. Next eligible patch and dependencies that still block it.

## Immediate next patch

P03b: add explicit call/binding lowering and normal/exceptional continuations
within the remaining F029–F038 scope. Branches/loops and broader fidelity follow;
Python can be added independently. P03a delivered straight-line expressions. P02 is
implemented in `semantic_ir`; its source hashes, schema vectors and graph checks
establish model consistency, not translation correctness. P03 must prove the
first adapter's fidelity before P06 can claim source-level anomaly detection.

P02 evidence: `docs/testing/2026-10-16-p02-semantic-ir.md`; schema contract:
`docs/design/semantic-ir-v1.md`. Current checklist: 43 complete, 142 pending, 185 total;
these counts are task accounting, not engineering-effort percentages.
