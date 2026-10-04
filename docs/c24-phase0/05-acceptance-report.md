# C24 Phase 0 · Acceptance report

Deliverable 5 of 5. Factual only: commands run, exact results, mutations detected, unresolved failures, limitations.
No confidence figures (correction #7 — a finite suite does not quantify overall reliability).

## Commands and results (4 Oct 2026)

| Command | Result |
|---|---|
| `node --test test/c24-phase0-algorithms.test.ts` | **11 pass, 0 fail** |
| `node --test test/c24-phase0-claim-gates.test.ts` | **5 pass, 0 fail** |
| `node --test test/c24-phase0-fixtures.test.ts` | **6 pass, 0 fail** |
| All three together | **22 pass, 0 fail** (~0.5 s) |
| `node --test test/c24.test.ts` (preserved v1 contract) | **9 pass, 0 fail** |
| `node --test test/c22.test.ts` (unaffected acceptance suite) | **34 pass, 0 fail** |
| `node --test test/c22-proposer.test.ts` | **4 pass, 0 fail** |
| `node --test test/claims.test.ts` (unit portion) | C18 gate units pass; **1 pre-existing/in-flight failure in the `converse` integration test** — see "Unresolved" below |
| `npx tsc -p tsconfig.json --noEmit` | **0 errors** at time of report; tree under concurrent edit (below) |
| Full `node --test test/*.test.ts` | run truncated at the 900 s cap (~226 assertions observed before cap); not used as evidence — targeted suites above are |

## What was produced

| Output | Location |
|---|---|
| 1 · Scope register (corrections integrated; release rule; decision points D1–D5 with defaults) | `docs/c24-phase0/01-scope-register.md` |
| 2 · Contract closure: `c24.causality.v2` schemas frozen; migration 20 (8 tables) applied and verified; permission split; claim-transition rules | `packages/schema/src/index.ts`; `packages/core/src/migrations.ts` (v20); `docs/c24-phase0/02-contract-closure.md` |
| 3 · Algorithm evidence: deterministic quarantine, certified partial-order queries, overlap-accounting — with oracles and mutation detection | `packages/core/src/c24/{ordering,path-accounting}.ts`; `packages/core/test/c24-phase0-algorithms.test.ts` |
| 4 · Fixture corpus: 28 fixtures (17 positive / 10 negative-control / 1 missing-data-primary), derivation method recorded per fixture; validation test | `packages/core/test/c24-causality-fixtures/`; `generate-c24-fixtures.mjs`; `c24-phase0-fixtures.test.ts` |
| 5 · This report | `docs/c24-phase0/05-acceptance-report.md` |

## Mutations detected (§19 checker principle, demonstrated on phase-0 gates)

| Gate removed | Detector that fails | Evidence |
|---|---|---|
| Cycle-quarantine (SCC reconciliation) | mutated output accepts a cycle (oracle shows self-reachability); RC11 property/fixture fail | `checker mutation: removing the cycle-quarantine gate is caught` |
| Certificate validity for CONCURRENT_CERTIFIED | mutated variant returns CONCURRENT_CERTIFIED for `valid: false`; RC04 test fails for it | `checker mutation: removing the certificate gate on CONCURRENT_CERTIFIED is caught` |
| Union (overlap-aware) accounting | summing variant returns 110 vs required 100; RC15 test fails for it | `checker mutation: summing instead of unioning is caught by the no-double-count property` |

## Independently derived expectations (correction #3)

- Algorithm-bearing fixtures (RC01 ordering outcome, RC03, RC04, RC11, RC15): expected results reproduced by oracles
  implemented differently from the code under test (Floyd–Warshall closure; integer-grid scan; permutation sweeps).
- Claim-gate expected results (RC26–RC28): asserted both ways (permitted AND prohibited) against the real C16/C18 gate
  pipeline — including execution-evidence-alone never reaching intervention-grade display.
- **Open release-blocking item**: the corpus is self-authored; an independent reviewer pass (human, or a separately
  authored fixture set) is required before release — recorded in `04-fixture-corpus.md`.

## Unresolved failures (none within phase-0 scope; observed outside it)

1. `claims.test.ts` "converse: question → view, trace → investigation…" fails: the test imports
   `../src/llm-router.ts` — part of an **in-flight concurrent refactor of the router/visuals layer** (untracked
   `llm-router.ts`/`scripted-router.ts` were written seconds before the run; `router.ts`/`route.ts` staged-deleted).
   Attributed to that WIP, not to phase-0 work; re-verify once the refactor settles.
2. The working tree is being edited concurrently (obs mtimes on `visuals.ts`, `llm-router.ts`,
   `scripted-router.ts` during this phase). The full-suite snapshot above should be re-taken after the refactor lands.

## Adapter limitations stated plainly (correction #6)

No real OTLP collector, broker, scheduler, pool/lock, profiler or deployment pipeline is exercised in phase 0. The
synthetic fixtures validate engine-level identity, ordering, quarantine, wait-layer, correction and trust semantics.
They establish nothing about production instrumentation correctness, telemetry completeness, measured overhead, or real
adapter coverage. Per design §21: these sources describe foundations; they do not establish this implementation's
correctness against real telemetry.

## Limits of this evidence

A passing finite suite under synthetic fixtures does not quantify reliability, generalize to unseen telemetry, or
certify real-world applicability (baseline correction #2). It demonstrates: the three load-bearing algorithms are
implementable and mutation-detectable; the contract (schemas/migrations/permissions/claim rules) is frozen and
load-bearing parts verified; 28 acceptance fixtures exist with recorded expectations. Phase 1 converts the remaining
fixtures from stated expectations into observed engine behavior.

## Fixed en route (reported for transparency)

`packages/core/src/overlays.ts(15)`: pre-existing typecheck error in uncommitted WIP (TS 5.9 does not narrow
`{kind:"CodeLocation"; span}` against a trailing index-signature union member) — fixed with an explicit typed access,
semantics unchanged; typecheck returned to 0 errors project-wide.

## Phase 1 (observed engine behavior)

Phase 1 implemented the v2 causality extension on top of the preserved v1 `Runtime`, converting all 28 phase-0 fixtures
from stated expectations into observed engine behavior (`test/c24-causality.test.ts`, 30 tests, all passing):

- **Engine**: `CausalityEngine` over migration v21 (`c24_wait_relations`, `c24_relation_certs`, `c24_artifacts`,
  `c24_experiment_reports`) — normalization with trust levels and delivered identity (dedup hash; per-source-version
  idempotent intake); proposal builder (delivery-key SEND/RECEIVE pairing with redelivery kept distinct, awaited
  completion joins, explicit childTask spawn, version-identity READS_FROM, request/response, strand-certified PROGRAM
  ORDER, adapter certificates with cross-epoch lock-generation quarantine); phase-0 order reconciler and wait-layer
  cycle analysis with canonical (rotation-invariant) cycle identity; coverage certificates (non-exhaustive certificates
  surface a material MISSING_EVENT gap phrased as absence-not-exoneration); claim discipline through the existing C18
  gates; experiment linking (only gated scopes/workload/revision match); source invalidation (no historic payload
  recovery), late-arrival versioned corrections, replay playback, snapshots with watermarks and per-snapshot update
  sequences.
- **Gateway surface**: `service.ts` exposes `c24v2` catalogue ops (query/reconstruction and mechanism/claim reads);
  privileged operations (adapter registration, event intake, corrections, source invalidation) are wired server-side
  only under `/api/v2/components/C24/…` (route now accepts C22 and C24 components).
- **Crash-safety evidence (RC22)**: a dedicated crash-child harness (`test/fixtures/c24-child.ts`) exercised
  SIGKILL at two failpoints (`c24-after-source-cursor`, `c24-before-projection-commit`); in both cases no mixed
  snapshot was committed, and replaying the same batch in a fresh process yielded exactly two authoritative events
  (dedup) and one snapshot.
- **Result**: 99/99 tests across `c24-causality` (30), `c24` v1 (9), phase-0 algorithms (11), claim gates (5),
  fixtures (6), C22 regression (34 + 4 proposer); typecheck 0 errors project-wide.

**What this does not establish** (unchanged from phase 0): no real adapter (OTLP collector, broker, scheduler,
pool/lock, profiler, deployment pipeline) is exercised; the suite does not quantify reliability; independent human
review of the 28-fixture corpus remains an open release-blocking item; the full-project suite re-verification remains
pending the separately in-flight router refactor (unrelated to this work).
