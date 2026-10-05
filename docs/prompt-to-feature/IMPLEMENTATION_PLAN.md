# Prompt-to-feature: feasibility review and implementation plan

Source: `Prompt-to-feature.md` v1.3 (80 requirements PF-001–080, 84 scenarios AT-01–84). Reviewed 2026-10-05 against the repo at `cf06dc0`.

> **Wave 3 status (2026-10-05, uncommitted): 3.P–3.U implemented with tests; see §12.**
>
> **Wave 0 status (2026-10-05, branch `feature/prompt-to-feature`, uncommitted): T0.1–T0.4 done. See §11 for what the audit changed.**

## 1. Verdict

**Feasible only as the spec's own "first slice" (§26, §28, §42, §48). Not feasible as a single build.** The full text asks for most of C01–C32 to grow new behaviour at once, plus a Rust/Node canonical-hash protocol, a six-stage wizard, a SAST/dependency/licence gate, paired benchmarks, an issue-sync projection, concurrent-request leases and a model-drift suite. The spec already says so (§28.1 hard constraint, §48 "first delivery"). The plan below turns that into ordered work.

The repo gives a useful base, and one large gap: **nothing generates code yet.**

| Need | What exists (verified by reading the repo) | Gap |
|---|---|---|
| Exact edits, approvals, compile/test, patch hash | `changes.ts` `ChangeEngine`: `TextEdit{baseHash,expected}`, status machine, `unifiedDiff`, tests run under `node --permission` | Intents are only RENAME / DELETE_UNUSED / ADD_CALL / DELETE_CALL / REPLACE_SPAN. **No new-file, multi-file or generated edit.** Test runner is Node-only. |
| Isolated checkout | `pr-analysis.ts` detached `git worktree`, symlink-escape guard; `campaign-runner.ts` overlays candidate on worktree; `defect-isolation.ts` docker runner | Isolation guarantees are not audited (spec §5/§39.3 says audit before reuse). |
| Persistence | `store.ts` / `storage.ts`: SQLite (`node:sqlite`) with `migrations.ts`, backup/GC | No feature tables. |
| Jobs | `jobs.ts`: durable jobs, progress, cancel with commit point, `priority` | **One job runs at a time** (single parser process). No fencing tokens, no runner caps. |
| Journal, audit, redaction, access | `journal.ts`, `events.ts`, `redact.ts`, `policy.ts`, `access.ts`, `tenants.ts` | No decision/authority binding model. |
| Draft PR | `gh-forge.ts` (injectable runner, draft-only, find-before-create), `pr-publish.ts`, `pr-gate.ts` | No issue binding/sync. |
| Perf | `defect-performance.ts`, `twin-*.ts`, `profiling.ts` | Not a paired baseline/candidate harness with population checks. |
| LLM | `llm-router.ts`, `packages/model` | No invocation provenance record, no local-only egress rule on fallback. |
| UI | `apps/web` (React; panels, `arrange.ts` layout, a11y tests, e2e) | No Build tab, wizard, file/diff viewer, dashboard. |
| Hashing | `sha256` used ad hoc in `artifacts.ts`, `changes.ts` | No `pf-canon-v1`; no Rust implementation in `crates/worker`. |
| Product stance | `README.md` lists "intent→code generation, agent mode, PR view" as **excluded** | This capability reverses that. README and ledger must change. |

## 2. Concerns found and how this plan resolves them

### 2.1 Ambiguities and internal inconsistencies in the spec

| # | Issue | Resolution (binding for implementers) |
|---|---|---|
| S1 | Version labels disagree (v1.3 header, "Revision 1.1 DoD" in §36.3, "v1.2" in §48). | v1.3 is the baseline. DoD = §27 + PF-041–080 + AT-31–84 where applicable. Fix text in W4. |
| S2 | §18 lists ~20 entity types; §28 allows five record families. | Fixed mapping (§3 below). Entities become typed payloads inside the five families, not tables. |
| S3 | Component IDs (C16 gate, C28 proposals…) vs repo files. | Phase 0 produces the mapping register; spec C-numbers are ownership labels, not services (§21 says so). |
| S4 | §15.1 "four cases" vs §30.3 profile. | §30.3 `pf-perf-core-v1` governs. |
| S5 | "Applicable" mandatory gates with no predicate table (§39.1). | **Three risk tiers** (see §2.4). Tier chosen deterministically from the diff (touches executable/config/auth/data/dependency?). Docs-only and copy-only can be NOT_APPLICABLE; anything else cannot. Tool missing → INCOMPLETE. |
| S6 | "Independent oracle" is required but nothing says where it comes from in a prompt-only request. | Oracle origin is a field: `USER_EXAMPLE`, `POLICY`, `EXISTING_TEST`, `REVIEWED_FIXTURE`, `GENERATED_UNREVIEWED`. A criterion backed only by `GENERATED_UNREVIEWED` can reach at most `PASS_UNREVIEWED_ORACLE` and the feature cannot be VERIFIED_WITHIN_SCOPE. The Clarify stage asks the user to confirm examples. |
| S7 | Who is an "authorized owner" (§3, §7.2)? App is local, single-user by default. | Authority bindings come from `.cie/authority.json` (scope → principals) plus `tenants.ts`. Default single-user: requester may decide business scope; **policy/access/security changes stay BLOCKED until a binding names someone.** No inference from job titles. |
| S8 | §29 needs duplicate-key, lone-surrogate and `-0` rejection, but `JSON.parse` hides all three, and Rust `&str` cannot hold lone surrogates. | Canon functions take *validated values*. A strict JSON ingress parser (token level, TS) rejects the three cases; Rust uses the same vectors through `serde_json` with a raw-token pre-check. Vectors include these as reject cases. |
| S9 | §29.2 content root over a whole repo is expensive. | Hash raw bytes with SHA-256 once per file, cache by git blob id → sha256 in `artifacts.ts` store; recompute only changed paths. Manifest sorted by path. Exclusion list declared per repo, validated not to cover source/config. |
| S10 | "Next" button vs "Continue with ready work" (§43.1/43.4). | Stage navigation is free for reading; **effectful buttons are separate** (Build candidate, Run validation, Export patch, Create draft PR). "Next" never starts one. |
| S11 | Statistical method for performance is unspecified (§15.2 "confidence method"). | Predeclared: ≥10 repetitions per case (configurable), p50/p95/p99, bootstrap CI on the difference; INCONCLUSIVE if CI crosses the budget limit; budgets without authority → UNVALIDATED. Method hash goes in `analysisPolicyHash`. |
| S12 | §19 `Job<…>` everywhere vs `jobs.ts` serial execution. | Keep one durable job type; `JobSpec` already has an optional `priority`: define its classes (interactive > validation > bulk) and add a runner pool (default 2, configurable) separate from the parser slot. Fencing tokens added to jobs (needed for AT-24, AT-57). |
| S13 | Mandatory GitHub issue before mutation (§35) vs offline dev/tests. | Tracking mode config: `MANDATORY` (default for CREATE_DRAFT_PR), `OPTIONAL`, `OFFLINE_UNSYNCED`. Tests inject a scripted forge as `gh-forge.ts` already allows. Never claims a trail that is unsynced. |
| S14 | SAST/dependency/licence tools may not exist on the host. | Adapter interface + built-in secret scanner and lockfile differ. Missing adapter → INCOMPLETE (spec §31, AT-62). No tool is made a hard dependency. |
| S15 | Rust role is only specified for deterministic extraction (§20). | Rust is used for **one thing in the slice**: the canon implementation and vector parity. No new RPC operations in slice 1. |
| S16 | Graph renderer scope (§44) vs "no elaborate graph renderer" (§48). | Slice ships the accessible list plus one layered requirement→component→file graph via existing `arrange.ts`. Edge classes and filters are data-driven; no new layout algorithm. |
| S17 | Target stacks. | Slice 1 supports **TypeScript/Node apps with npm test** (demo: `fixtures/payments-repo`). Other build systems are reported UNSUPPORTED with a concrete reason. Support matrix is stored and shown. |

### 2.2 Performance concerns (builder and target)

| # | Risk | Mitigation built into tasks |
|---|---|---|
| P1 | Rehashing the repo on every candidate edit. | S9 cache; incremental content root. |
| P2 | Sending whole repo to the model. | Progressive retrieval via `retrieval.ts`; per-stage token budgets; context packs recorded in the invocation record. |
| P3 | Full validation after every repair. | Staged short-circuit: compile → static/security → targeted tests → affected regressions → browser → perf. No perf run on a non-building candidate. Test selection from graph impact; **unknown coverage → run the full suite** (spec §33). |
| P4 | Baseline benchmark P0 repeated per candidate. | Cache P0 by (base commit, workload, environment, toolchain). Reuse only on full-identity match. |
| P5 | Runner and benchmark contending for CPU (spec §14.1). | Benchmarks hold an exclusive resource lease; builder work is paused/coalesced during measurement or the run is labelled "contended". |
| P6 | UI polling (existing panels poll at 1.5 s). | Version-gated reads (`workspaceVersion` → 304-style empty response); SSE not required. Virtualised file/test lists; cursor pagination; log ring buffer with explicit truncation. |
| P7 | Issue sync hitting GitHub secondary rate limits. | Outbox with coalescing (≥ 1 comment per 10 s per request, milestone events only), backoff on RATE_LIMITED (`GhError` already has the state). |
| P8 | SQLite write amplification from events. | Events are milestone-level (spec §35.3), batched in one transaction with the state change (outbox). |
| P9 | Change-graph size. | Default graph is requirements→components→files only; tests/evidence expand on selection; bounded traversal in `graph.ts`. |

### 2.3 Security and safety concerns

- **Isolation is unaudited** (spec §5, §39.3). Task T1.F audits and adds negative tests (path traversal, symlink escape, env leak, network, fork bomb, oversize output) before any generated code is executed. Generated code never runs outside it.
- **Prompt/repo injection** (PF-040, AT-26): retrieved text goes into model context as data only; tool capability set is fixed at task creation and cannot be widened by model output. Tested with a poisoned README.
- **Egress** (PF-053, AT-42): provider fallback is a policy check, not a retry. Local-only sessions never fall back to cloud.
- **Issue projection**: redaction is deterministic code at the authorization boundary, not a model decision; destination privacy is checked before the first write.
- **Secrets**: scanner results store redacted locations only; issue projection passes `redact.ts` plus a new "private-prompt" rule (AT-35, AT-44).
- **Draft only**: reuse `gh-forge.ts` which cannot merge. Patch *apply* runs only in an isolated worktree on exact base.

### 2.4 Applicability tiers (resolves S5)

Performance applicability is a separate predicate from the tier: P0–P3 run when the change is performance-applicable (touches a request path, query, job, loop over data, or a shared resource), which can happen at T1. Progressive cases (concurrent load, slow clients, degradation) run **only** when a §30.3 risk trigger fires, and the trigger that fired is recorded.


| Tier | Trigger (from the actual diff) | Mandatory gates |
|---|---|---|
| T0 | Only docs/comments/copy text | Identity binding, secret scan, attribution. Others NOT_APPLICABLE with rationale. |
| T1 | UI/API change, no auth/data/dependency/config effect | + build, targeted tests, browser if UI, security scan, dependency diff, operational note. |
| T2 | Touches access, data/schema, dependencies, external effects, concurrency or runtime config | + full affected regressions, `pf-perf-core-v1` (promotes progressive cases per §30.3 triggers), release/revert plan, abuse/rate-limit check. |

## 3. Five record families (the only new persistence in slice 1)

| Family | Holds (spec entities as typed payloads) |
|---|---|
| FeatureRecord | request, prompt ref, issue binding, source revision, contract versions, requirements, criteria, assumptions, findings, OverlapAssessment/BehaviourMapping, ReleasePlan, FeatureWorkspace, mutation leases |
| DecisionRecord | questions, answers, authority binding, waivers, dispositions |
| CandidateRecord | PatchBinding, file inventory (FileMutation), oracle hashes, ModelInvocation refs, PatchExport |
| EvidenceRecord | RunManifest, ValidationResult, security/dependency/perf/operational results, coverage + gaps |
| EventRecord | request-scoped ordered events, outbox state, sync receipts |

Each has an explicit `schemaVersion`; relations are indexed foreign keys. The `pf-canon-v1` hash is stored with every immutable payload.

## 4. Out of slice 1 (explicitly deferred, to be listed in docs as unsupported)

Multi-repo campaigns, calibrated simulation, non-Node build systems, production migrations, real deployment adapters, post-deployment telemetry (PF-050 is schema-only), full concurrent-request coordination beyond in-process leases (PF-063 partial), consumer inventory beyond static references (PF-065 partial), exhaustive capability catalog. Each deferred PF/AT is marked `AUDITED_GAP` in the readiness register, never silently dropped.

## 5. Execution rules for agents

1. **One worktree per agent** (`isolation: "worktree"`); merge in the order given. Never edit another task's files.
2. **Directory ownership.** New code lives in `packages/core/src/feature/<area>/`, `apps/web/src/build/`, `crates/worker/src/canon.rs`. Tests in `packages/core/test/feature-<area>.test.ts` (run with `node --test`).
3. **Shared hot files** (`server.ts`, `service.ts`, `App.tsx`, `migrations.ts`, `docs/ledger.json`) are edited **once, in T0.2**, to add empty registration points (`feature/routes.ts`, `build/BuildFeature.tsx`, reserved migration numbers per task, ledger fragments dir). Later tasks only edit their own module.
4. **Ledger.** "Done" means ledger items backed by tests (project convention). Each task writes `docs/prompt-to-feature/ledger/<task>.json` listing PF/AT items and the test names; W4 merges them into `docs/ledger.json`, which is keyed by component (`C01`…`C32`, each with `items[{item,tests,state}]`); a fragment therefore names the owning component per item. No item is marked done without a passing test.
5. **Contracts first.** Interfaces from §19/§36/§40/§47 are frozen as TypeScript types + stubs in T0.2; implementers may add optional fields but not change signatures without a Wave-0 amendment.
6. Each task finishes with `npm run typecheck` and its own test file green; W4 runs the full `npm test`.
7. No task may claim "verified", "no regression" or "bug-free" in UI/text that the eligibility function (T2.J) does not compute.

## 6. Task graph

```
W0 (sequential)  T0.1 audit ─▶ T0.2 contracts+scaffold ─▶ T0.3 canon (TS) ─▶ T0.4 Rust parity GATE
                                      │
W1 (parallel)    ┌────┬────┬────┬────┼────┬────┬────┐
                 1.A  1.B  1.C  1.D  1.E  1.F  1.G  1.H
                 │    │    │    │    │    │    │    │
W2 (parallel)    2.I  2.J  2.K  2.L  2.M  2.N  2.O
W3 (parallel)    3.P  3.Q  3.R  3.S  3.T  3.U
W4 (sequential)  4.1 end-to-end slice ─▶ 4.2 conformance + ledger ─▶ 4.3 docs/README/QA
```

### Wave 0 — sequential, one agent

**T0.1 Phase-0 audit and readiness register** (PF-041)
- Deliver `docs/prompt-to-feature/readiness.json`: one row per PF (symbol proposed, actual file/symbol, status from §28.2, tests, isolation notes, reuse/extend/new, gap). Seed it with §1 table above. Confirm `changes.ts`, `jobs.ts`, `pr-analysis.ts`, `defect-isolation.ts`, `gh-forge.ts`, `llm-router.ts`, `retrieval.ts` claims by reading and running their tests. Produce one **runnable baseline**: `fixtures/payments-repo` via `scripts_make_demo_repo.sh`, `npm test` result recorded.
- Done when: every PF has a row; baseline result recorded; no row marked IMPLEMENTED.

**T0.2 Contracts and scaffold** (PF-041; S2/S3)
- `packages/core/src/feature/types.ts` (five record families + payload types from §18/§40/§47), `feature/api.ts` (typed stubs for §19/§36/§40/§47 functions that throw `NotImplemented`), `feature/routes.ts` registered once in `server.ts`, `apps/web/src/build/BuildFeature.tsx` stub registered once in `App.tsx` as a "Build feature" tab, reserved migrations (one number per task that persists), **frozen interfaces that Wave-1/2 tasks code against in parallel: `Runner` (1.F), `FeatureStore` (1.B), `RunManifest`/`ValidationResult` (2.J), `canonHash` (T0.3)**, `docs/prompt-to-feature/ledger/` dir, tier classifier signature, config loader for tracking mode / authority / budgets.
- Tests: migration up/down, types compile, route returns typed `NOT_IMPLEMENTED`.

**T0.3 `pf-canon-v1` (TypeScript) + strict ingress parser** (PF-042; AT-32 part)
- `feature/canon.ts`: algorithm §29.1 steps 1–8, `canonHash(schema, version, payload)`, raw-file hash, content-root manifest (§29.2) with blob-id cache. `fixtures/canon-vectors.json` with every vector in §29.3 plus S8 reject cases, **reviewed by a second agent/human before freezing**.
- Tests: all vectors; property test on key reordering.

**T0.4 Rust parity gate** (PF-042; AT-32) — moved here from Wave 1. `crates/worker/src/canon.rs` passes the same reviewed vectors as T0.3, and a CI check fails if the Node and Rust digests differ. `exactBindingEnabled` stays false until this passes; Wave 1 tasks may build against `canonHash` but no task may enable or claim exact-bound publication before the gate is green.

### Wave 1 — parallel (7 agents), each depends only on W0

| Task | Scope | PF / AT | Key files |
|---|---|---|---|
| **1.B Feature store, journal, lifecycle** | Tables via reserved migration; request state machine (§22) with compare-and-swap pointers; ready/blocked flags; event + outbox in one transaction; `resumeRequest`; crash reconciliation | PF-001–003, 037, 039; AT-27, 48 | feature/store.ts, feature/lifecycle.ts |
| **1.C Intake and discovery** | `submitFeature`, target/outcome-mode resolution, artifact ingest, `discoverFeatureContext` using existing indexer/retrieval; **coverage record** (§30.1, states, NOT_FOUND_WITHIN_SEARCHED_SCOPE); tier classification of plan; repo support matrix (S17) | PF-001, 002, 004, 043; AT-01, 33 | feature/intake.ts, feature/discovery.ts |
| **1.D Decisions and authority** | DecisionRecord, authority bindings (S7), optimistic versioning with conflict → new finding, scoped authority checks, instruction-injection guard on retrieved text | PF-012, 014, 036, 040; AT-07, 26, 27 | feature/decisions.ts, feature/authority.ts |
| **1.E Candidate engine** | Extend `ChangeEngine` or add `feature/candidate.ts` wrapping it: new-file/multi-file/delete/rename edits with `baseHash`, isolated materialisation, `PatchBinding`, FileMutation inventory with attribution, original/candidate **oracle hash** and weakened-assertion check (`compareOracles`), staleness on any edit | PF-020, 021, 055; AT-13, 22, 45, 29 | feature/candidate.ts |
| **1.F Runner and isolation audit** | Audit `changes.ts`/`defect-isolation.ts`/`isolated-exec.ts`; one `Runner` interface (command allowlist, fs roots, network deny by default, CPU/mem/time/output caps, secret refs); runner pool and priority classes in `jobs.ts`; negative tests (S: traversal, symlink, env leak, fork bomb); fencing tokens | PF-020, 032, 038, 068; AT-24, 25 | feature/runner.ts, jobs.ts (only here) |
| **1.G Model generation adapter** | Structured prompt→requirements→contract draft→edit plan via `llm-router`; `ModelInvocation` records (provider, resolvedVersion or UNKNOWN, prompt-template hash, input/output hashes); per-stage token budgets; egress policy and fallback rule | PF-005, 006, 052, 053; AT-41, 42 | feature/model.ts |
| **1.H Wizard shell** | Build tab with six stages, persistent workspace, `advanceWizard` with version check, status banner (`IMPLEMENTED — VALIDATION INCOMPLETE` etc.), jobs groups (Running/Ready/Blocked/Failed/Needs answer). Driven by fixture data until backend lands | PF-069, 070, 043; AT-67, 68, 69 | apps/web/src/build/* |

Merge order: 1.B, 1.D, 1.F, then 1.C, 1.E, 1.G, 1.H (1.E uses 1.F's runner interface; 1.C/1.G use 1.B store).

### Wave 2 — parallel (7 agents), after W1

| Task | Scope | PF / AT | Depends |
|---|---|---|---|
| **2.I Requirements, conflicts, questions, overlap** | Atomic normalisation; deterministic checks (access, scope, invariants) then model-proposed findings classified POTENTIAL/CONFIRMED with witness; question batching (2–3), dependency-aware blocking; bounded manual/tool-assisted overlap comparison (§37, relationships and strategies); OverlapAssessment stored in FeatureRecord | PF-005–011, 013, 015, 018, 057–062; AT-02–06, 49–54, 60 | 1.B, 1.C, 1.D, 1.G |
| **2.J Validation orchestrator and eligibility** | `RunManifest` binding; criterion→check mapping; capture complete outcomes incl. skips/timeouts/infra errors; baseline health classification; oracle-origin rule (S6); **single pure `computeEligibility()`** deriving VERIFIED_WITHIN_SCOPE / REVIEW_ONLY_INCOMPLETE / BLOCKED; staged short-circuit (P3); waiver ≠ PASS | PF-024, 026, 034, 035, 066, 067; AT-12, 21, 22, 63, 64, 65, 74–77 | 1.B, 1.E, 1.F |
| **2.K Security, dependency, provenance gate** | Built-in secret scan, SAST adapter interface, lockfile/dependency diff with install-script and licence fields, advisory adapter (offline → INCOMPLETE), known-source provenance record; policy for blocking/suppressions | PF-045–047; AT-35, 36, 62 | 1.E, 1.F |
| **2.L Browser validation harness** | Real-interaction journeys for UI features (role, viewport), a11y checks, evidence that is not a screenshot alone; reuse `apps/web/test/e2e` + `a11y-run.ts` patterns | PF-025; AT-14, 84 | 1.F, 1.H |
| **2.M Performance profile** | `pf-perf-core-v1` P0–P3 harness, budgets with authority, population check (errors kept), paired manifests, S11 statistics, P4 baseline cache, P5 exclusive lease, risk-trigger promotion, states WITHIN_BUDGET…UNVALIDATED | PF-027–031, 044, 032; AT-17–21, 34 | 1.E, 1.F, 2.J (manifest) |
| **2.N Wizard stages: Clarify, Plan, Changes** | Questions inline, overlap report, criteria/plan view, change graph + accessible list, file viewer (candidate/baseline/diff, truncation), requirement↔line links | PF-064, 071, 072, 075; AT-70, 71, 73 | 1.H, 1.B, 1.E |
| **2.O Issue trail** | `bindRequestIssue`/`syncRequestMilestones` via `gh-forge`; projection built from an **allowlist of fields** (never free-form model text) and passed through a deterministic redaction step enforced at the C03 boundary, with a test that a seeded secret/PII prompt never reaches the outgoing payload; outbox coalescing (P7); reconcile after timeout; labels from repo conventions; closure semantics; human-edit divergence detection | PF-054, 056, 080; AT-43, 44, 46, 47, 48 | 1.B, 1.D |

### Wave 3 — parallel (6 agents), after W2

| Task | Scope | PF / AT |
|---|---|---|
| **3.P Validate and Deliver UI** | Dashboard (baseline vs candidate, per-target builds, per-test origin/status, test↔criterion↔file associations with basis), diagnostics + repair loop that cannot weaken oracles, stale banners | PF-073, 074, 076; AT-72, 74–77 |
| **3.Q Patch export and destination** | (operation is `C28/exportFeaturePatch`) Unified diff, `git diff --binary` patch, manifest bundle, `checkPatchDestination` (dry run), `applyPatchCandidate` in isolated worktree on exact base, unsafe-path/binary/submodule blocks, receipts to issue | PF-077, 078; AT-78–82 |
| **3.R Draft PR and review iteration** | `publishFeaturePR` bound to decision/head hash, draft only, receipts + reconcile; reviewer feedback ingestion, classification, scoped revalidation, same-PR update, out-of-order event handling | PF-035, 036, 051; AT-22, 23, 30, 40 |
| **3.S Operations and release plan** | Operational applicability + checks (metrics/log redaction/abuse/queue signals), ReleasePlan (flags, kill switch, revert as new candidate), post-deploy evidence schema only | PF-048–050; AT-37, 38, 39 |
| **3.T Concurrency and lifecycle** | In-process mutation leases with fencing, request relations (DUPLICATES/DEPENDS_ON…), integrated-candidate re-verification, replacement/retirement checklist with unknown-consumer gap | PF-063, 065; AT-55–57, 59 |
| **3.U Builder drift and model evaluation** | `ModelIdentityChanged` impact, builder conformance suite (short/long input, conflicts, permissions, oracle preservation, tool misuse), conflict-detector precision/recall report on labelled fixtures | PF-052; AT-41 |

### Wave 4 — sequential

- **4.1 End-to-end slice.** On the demo payments repo: prompt "Add CSV export to transactions" → clarify → plan → candidate → validate (build, tests, browser, security, perf core) → patch + draft PR (scripted forge). Includes denied-role, cross-tenant and revoked-permission cases from §25. Reuse/no-change variant (AT-60).
- **4.2 Conformance and ledger.** Run AT-01–84; each is PASS, FAIL, or `DEFERRED` with reason (never skipped silently). Merge ledger fragments into `docs/ledger.json`; update readiness register statuses (IMPLEMENTED_UNVALIDATED vs VALIDATED only with evidence).
- **4.3 Docs and QA.** README (replace the "excluded" statement), unsupported-coverage list (§27), spec text fixes (S1), QA pass with a11y and low-resource profile numbers **measured** on a declared machine (spec §16 forbids invented targets).

## 7. Requirement coverage

| PF | Task | PF | Task | PF | Task |
|---|---|---|---|---|---|
| 001–003 | 1.B, 1.C | 027–031 | 2.M | 057–062 | 2.I |
| 004, 043 | 1.C | 032 | 1.F, 2.M | 063, 065 | 3.T |
| 005–006 | 1.G, 2.I | 033 | 1.H, 2.N, 3.P | 064 | 2.N |
| 007–011, 013, 015 | 2.I | 034–035 | 2.J, 3.R | 066–067 | 2.J |
| 012, 014, 036, 040 | 1.D | 037, 039 | 1.B | 068 | 1.F |
| 016–017 | 2.I + 4.1 (access matrix tests) | 038 | 1.F | 069–070 | 1.H |
| 018 | 2.I, 1.E | 041 | T0.1, T0.2 | 071–072, 075 | 2.N |
| 019 | 1.B, 2.J | 042 | T0.3, 1.A | 073–074, 076 | 3.P |
| 020–021 | 1.E | 044 | 2.M | 077–078 | 3.Q |
| 022–023 | 2.I, 2.J | 045–047 | 2.K | 079 | 2.N, 3.P |
| 024–026 | 2.J, 2.L | 048–050 | 3.S | 080 | 2.O |
| 051 | 3.R | 052–053 | 1.G, 3.U | 054–056 | 2.O, 1.E |

PF-016/017 (access enforcement) are properties of the *generated* feature; they have no owning task of their own and are proven by the 4.1 scenarios plus 2.I's access-matrix checks. Do not mark them done from unit tests of the builder.

## 8. Decisions I assumed (change before starting W1 if wrong)

1. Slice 1 targets TypeScript/Node apps only (S17).
2. Default tracking mode is `MANDATORY` for CREATE_DRAFT_PR and `OPTIONAL` for PLAN/BUILD_PREVIEW.
3. Model egress defaults to local-only unless the project config opts in to a cloud provider.
4. Single-user authority default (S7): policy-changing decisions stay blocked until `.cie/authority.json` names a principal.
5. Performance statistics follow S11 (≥10 runs, bootstrap CI).
6. T2 features cannot be marked verified without a representative environment; otherwise `PERFORMANCE UNVALIDATED`.

## 9. Audit of this plan (reviewer pass) and status

Checks run, and what they found. Fixes are already applied above.

| # | Check | Result | Action |
|---|---|---|---|
| A1 | Every PF-001–080 has an owning task (§7) | Pass. PF-016/017 have no task of their own by design; proven only through 4.1. | Stated in §7. |
| A2 | Parallel tasks do not need each other's unmerged code | **Fail, fixed.** 1.E needed 1.F's runner; 1.C/1.G needed 1.B's store; 2.M needed 2.J's manifest. | T0.2 now freezes `Runner`, `FeatureStore`, `RunManifest`, `canonHash`. |
| A3 | Shared hot files edited by one task only | Pass after T0.2 registration points. `jobs.ts` is touched only by 1.F. | n/a |
| A4 | Claims about the repo | Mostly verified by reading code. **Two corrections:** `jobs.ts` already has `priority`; `ledger.json` is keyed by component. Not verified: that existing tests currently pass, and that `changes.ts` can take new-file edits without a rewrite. | Wording fixed; both become T0.1 exit checks. |
| A5 | AT-01–84 each have a home | Mostly. Gaps: AT-16, AT-66, AT-31, AT-58, AT-61. | AT-16: add a small-data-change variant to 4.1. AT-66: `DEFERRED` (slice has no external effects). AT-31: 4.2 asserts no task depends on a generic framework. AT-58 goes to 2.M; AT-61 to 2.L/2.N. |
| A6 | Spec rules that contradict each other | Resolved in §2.1. Residual risk: S6 (oracle origin) makes "verified" harder to reach than the spec's text implies. | Flagged for your decision below. |
| A7 | Invented numeric targets | None. Latency/RAM targets are measured in 4.3, per spec §16. | n/a |
| A8 | Anything implemented or run | No. This review read the spec and repo only; it did not run the test suite or change code. | T0.1 records the baseline first. |

### Status

**The plan is ready to start implementation at Wave 0.** It is not ready to hand to eight parallel agents until T0.1–T0.3 are done, because Wave 1 depends on the frozen contracts and the baseline.

- Ready now: T0.1 (audit + baseline), then T0.2, then T0.3, by one agent.
- Needs your confirmation before Wave 1: the six assumptions in §8, especially #3 (local-only model egress) and S6 (a prompt-only feature cannot be VERIFIED without user-confirmed examples).
- Known risk: the largest unknown is 1.E/1.G, the first code generation in this product. If T0.1 shows `ChangeEngine` cannot take new-file edits cleanly, 1.E becomes a new module rather than an extension, which is a larger task than the table suggests.

## 10. Review of external comments on the spec

| Claim | Valid? | Evidence and effect on plan |
|---|---|---|
| `pf-canon-v1` is well-specified | **Partly.** It is detailed, but runtimes cannot express some of its rejections (duplicate keys, lone surrogates, `-0` after `JSON.parse`; Rust `&str` cannot hold lone surrogates). | Handled by S8 (strict ingress parser, shared reject vectors). |
| Node/Rust parity must pass before exact-bound publication | **Valid** (§29.1, line 644). | It is *not* in the §26 Phase 0 exit evidence (line 602); only §48 says to settle the identity protocol before coding. Made an explicit gate: new T0.4. |
| "Next" must not imply approval or verification; banners persistent | **Valid** (§43.1, §43.2, §30.2). | S10 and AT-68/69 cover it; 1.H must render the banner on every stage and keep effectful actions separate from Next. |
| Keep progressive perf cases risk-triggered | **Valid** (§30.3 triggers). | Plan previously tied perf to tier T2 only; corrected in §2.4 to a separate predicate with recorded trigger. |
| Bounded manual overlap is enough; similarity must not gate | **Valid** (§42.1; §37.4 line 959). | Already reflected in 2.I; no similarity score feeds `computeEligibility()`. |
| Redaction enforced by C03, not model judgment | **Mostly valid.** §36.1 assigns C03 "gates/redacts"; the "not model judgment" wording is the commenter's, but it follows from §35.2 and §39.3. | 2.O now uses an allowlist projection plus deterministic redaction, with a seeded-secret test. |
| Long tables hard to read | True for the spec and for §2 of this plan; editorial only. | No change; split in the repo version if desired. |
| Counts are inventory, not accuracy | **Valid** (§48 says so). | No change. |
| Status stays "proposed, not audited" until Phase 0 completes | **Valid** (line 5; §28.2). | The readiness register starts with no row above `AUDITED_*`. |

## 11. Wave 0 result and plan corrections

### What was done

| Task | Result | Evidence |
|---|---|---|
| T0.1 audit + baseline | `readiness.json`: 80 rows (71 AUDITED_GAP, 7 AUDITED_PRESENT, 2 IMPLEMENTED_UNVALIDATED, 0 VALIDATED). Baseline at `cf06dc0`: 785 unit + 16 e2e Node tests and 47 Rust tests, all passing, before any change. | `docs/prompt-to-feature/readiness.json`, `gen_readiness.py` |
| T0.2 contracts + scaffold | Five record families and ~45 typed operations (`feature/types.ts`, `api.ts`), stub routes registered once in `server.ts`, migration 33, config loader, tier classifier, "Build feature" header button + modal shell. | `feature-scaffold.test.ts` (8), `build-stages.test.ts` (2) |
| T0.3 canon (TS) | `feature/canon.ts` with strict ingress parser, sets, decimals, raw hash, content root; 75 vectors in `fixtures/canon/`. | `feature-canon.test.ts` (80) |
| T0.4 Rust parity gate | `crates/worker/src/canon.rs` passes the same vectors; `scripts/canon-parity.mjs` writes an attestation; `exactBindingEnabled()` is true only for the current vectors with both runtimes passing. Currently **enabled: true (75 vectors)**. | `cargo test -p worker canon`, `canon-parity.json` |

Typecheck is clean. The full `npm test` has not been re-run since the changes (only the new and touched test files).

### What the audit found that the plan got wrong

The first pass missed `execution.ts`, the F07 task→candidate→validate→draft-PR pipeline (`Tasks`, `C28/prepareChange`, `reviewPropertyChange`, `approveCandidate`, `createGrant`, `publishDraftPR`). It already has most of what tasks 1.E, 1.F, 2.J and 3.R describe. Corrections:

| Task | Was | Now |
|---|---|---|
| 1.E candidate engine | "extend `ChangeEngine` or new module" | **Extend `Tasks`/F07.** It already has `CREATE_FILE`/`DELETE_FILE`/`REPLACE_SPAN` edits with exact quoted bytes, admission rules, a scratch tree, a `PatchBinding` with `originalOracleHash`/`candidateOracleHash`, oracle-weakening detection and property-change review. `ChangeEngine` (`changes.ts`) is the older, byte-range rename engine and is not the base. Work: a `BUILD_FEATURE` task kind, feature scope rules, and allowing tests/dependencies where the contract authorises them (admission currently blocks test files, CI config and lockfiles unless `allowTestEdits`, and `allowNewDependencies` is the literal `false`). |
| 1.F runner | Build `Runner` and audit isolation | Existing isolation is `LOCAL_PERMISSION_MODEL` with no CPU/memory/pid limit (stated in `execution.ts`). The audit is mostly done; 1.F wraps `isolated-exec.ts`/`runTestsIn` behind the `Runner` interface, adds the missing limits where the host allows, and records omissions. Container and VM profiles exist in `defect-isolation.ts` (docker). |
| 2.J validation | New orchestrator | Reuse `validatePatch` roles and `RoleRunRecord`; add per-criterion mapping, oracle-origin rule and `computeEligibility()`. |
| 3.R publication | New publisher | Reuse `createGrant`/`pushCandidate`/`publishDraftPR` and `gh-forge.ts`; add contract+evidence binding. |
| 1.H wizard | "Build tab" | The app has no tabs; every feature is a header button opening a modal panel. "Build feature" follows that. Build on `TaskPanel.tsx`, which already enforces the §12.2 copy rules. |
| Hashing | n/a | `execution.ts` has its own `canonicalJson`/`bindingHashOf` (sorts with `localeCompare`, accepts floats, no domain separation). It stays as is for F07 bindings; feature records use `pf-canon-v1`. Per spec §29.3 identities are never relabelled. |

### Things Wave 0 decided that you should know

- **Path collisions** in `contentRoot` are detected under ASCII case folding only. Non-ASCII case folding and Unicode normalisation (composed vs decomposed names) are not detected, because Node and Rust would have to agree on full Unicode rules and `unicode-normalization` is not in the lockfile. Those names stay distinct, as §29.1 step 4 requires. Documented in `canon.ts`.
- **The attestation file is a guard against accidents, not tamper-proof.**
- **Vectors:** digests were computed independently (Python `hashlib`), but the canonical strings were written by the implementer and no human has reviewed them. `readiness.json` therefore keeps PF-042 at IMPLEMENTED_UNVALIDATED. The plan (T0.3) asked for review before freezing; that review is still open.
- `feature_records` is keyed by `request_id` with a unique `(created_by, idempotency_key)` index; events are unique by `event_id` and by `(request_id, sequence)`.
- **Operation rename:** the spec's `C28.exportPatch` collides with the existing change-proposal operation `C28/exportPatch`, so the feature version is `C28/exportFeaturePatch` (task 3.Q). A first full-suite run caught this: 8 gateway tests failed because my stub registration shadowed it, and my own "no collisions" test had only checked literal keys in `server.ts`. The test now calls every feature operation through the real gateway and requires it to answer with its own owning task.

## 12. Wave 3 result (2026-10-05)

Node suite: 1147 tests, all passing; `npm run typecheck` clean. The Chrome e2e suite and `cargo test` were not re-run for this wave.

| Task | What exists | Tests |
|---|---|---|
| 3.Q | `feature/patch-export.ts`: export bound to a decision recomputed now (REVIEW ONLY label when incomplete), git/plain/bundle formats, unsafe-path/NUL/case/VCS blocks, destination dry run, apply into a NEW copy on an exact base | `feature-delivery.test.ts` |
| 3.R | `feature/publish.ts` (draft only, push from CIE's own clone, find-before-create, same-PR update under a lease, deterministic commits so a crash retry adopts), `feature/review-feedback.ts` (fixed-rule classification, redaction, idempotent, older/unknown head, scoped revalidation) | `feature-publish.test.ts` |
| 3.S | `feature/operations.ts`: static operational checks (basis stated), release-plan rules by tier, OPERATIONAL gate driver, revert planning, schema-only post-deploy | `feature-operations.test.ts` |
| 3.T | migration 34, `feature/coordination.ts` (leases with fencing tokens, relations, concurrent-candidate assessment, origins, retirement), `feature/relation-sync.ts` | `feature-coordination.test.ts` |
| 3.U | `feature/builder-eval.ts`: conformance suite, per-identity evaluations (persisted), `unevaluatedModels` gap in `computeEligibility`, drift impact, detector report on `fixtures/conflict-eval` | `feature-builder.test.ts` |
| 3.P | `feature/test-links.ts`, `feature/dashboard.ts` (Validate/Deliver read models in `FeatureReview`), repair-weakening guard in `candidate.ts`, `apps/web/src/build/DeliverStages.tsx` + `deliver-view.ts` | `feature-dashboard.test.ts`, `build-deliver*.test.ts` |

Decisions to know about:
- Operations added beyond the frozen list: `C07/relateRequests`, `C23/assessRetirement`. Job kind `feature-apply` added to the schema.
- `computeEligibility` gained an optional `unevaluatedModels` input, threaded through every caller. Candidates with no model invocations are unaffected.
- A repair candidate is compared with the previous candidate's tests as well as the repository's: weakening a test the earlier candidate added is a property change (`REPAIR_*` kinds) and blocks verification.
- `checkPatchDestination` accepts a snapshot without `contentRootHash` ("as it is now"); the assessment id binds the result to that root and apply refuses any other.
- Honest gaps are in the ledger fragments (`ledger/3.*.json`, state `blocked` with what each needs): binary files, lease enforcement at candidate commit, no operation that validates an integrated candidate, no real model or GitHub exercised, no browser e2e of the new stages.

## 13. Wave 4 progress: the slice runs (2026-10-05)

Blockers found before starting 4.1, and what changed:

| Blocker | Resolution |
|---|---|
| Nothing ran the steps in order or moved the request through its states | `feature/pipeline.ts`: `runFeaturePipeline` records every step, stops at the first open question, and reports the eligibility function's own word |
| `fixtures/payments-repo` has no `package.json` and its test file has no runner, so it has no build or test targets | New buildable fixture `fixtures/transactions-app` (real `build` and `test` scripts); `scripts_make_demo_repo.sh <dir> <fixture>` accepts a fixture name |
| No container-class runner; the plan's CONTAINER profile was unimplemented | `feature/docker-runner.ts` (`DockerRunner`) with its own audit probes: non-root, read-only root, pid and memory limits, no network, same flag/env refusals as `LocalRunner` |
| A generated oracle can never become a reviewed one, so nothing could be verified | `feature/acceptance.ts`: a person confirms expected outcomes by a recorded decision (`C15/confirmAcceptance`) |
| Plan builder declared the environment `UNKNOWN`, so eligibility could only be BLOCKED or REVIEW ONLY | `validationPlanFor`: uses the repository's own scripts and takes the environment, test data and performance applicability as explicit declarations (never upgraded by the driver) |

Result: with `DockerRunner` the demo reaches `VERIFIED_WITHIN_SCOPE` (build and tests run in `node:24-alpine` on the candidate's exact bytes, baseline HEALTHY, user's tree untouched). That run **declares performance not applicable and the report says the change was not measured**. Without that declaration the only open gap is performance. `.cie/security.json` in the fixture sets `requireExternalSast: false` (a repository decision; the pattern rules still run).

Still open for Wave 4: performance measurement on the demo, browser gate on a UI feature, an operation exposing the driver (4.1); the AT-01–84 traceability map and run (4.2); README, spec fixes and measured numbers (4.3). See `ledger/4.1.json` and issues #88–#90.
