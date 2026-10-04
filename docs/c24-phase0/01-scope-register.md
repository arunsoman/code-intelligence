# C24 Runtime Causality — Phase 0 · Scope register

Status: working baseline for the C24 causality extension. Integrates the seven baseline corrections to the earlier assessment.
Design baseline: `C24_Runtime_Causality_Detailed_Design.md` v1.0 (4 Oct 2026). Existing implementation: `packages/core/src/runtime.ts`
(preserved v1 contract — ingest/attribute/queryWindow/replay/recordMarker/notifyRelevantContext — 9 tests, green).

## 1. Definition of done (frozen for this phase)

Phase 1 "done" = design §20 first implementation slice, verifiable by §19's suite:

1. RC01–RC28 acceptance fixtures each produce their required result through the implemented engine.
2. Checker-mutation suite: every gate named in §19, when removed, causes at least one test to fail.
3. Preserved v1 C24 APIs remain green (existing `c24.test.ts` unchanged).
4. `c24.causality.v2` schemas, migration, gateway permission table and C18 claim-transition rules stay frozen
   except through a new registered schema version (§20 freeze list).
5. Acceptance report states exactly what passed, under which fixtures and limits (correction #7).

## 2. In scope (first slice)

- Authenticated intake for T0 (spans/deployment) and T1 (messaging/database contextual records) with source trust,
  process epochs, attempt identities, dedup by identity hash; backpressure and bounded slices.
- Deployment/build/source attribution v2: deployment revision sets, per-event revision attribution, exact/candidate/unknown
  preserved from the existing `attribute` tiers; never forced onto the current checkout.
- Relationship builder for: PROGRAM_ORDER, SPAWN, SEND_RECEIVE, COMPLETE_JOIN, READS_FROM, REQUEST_RESPONSE,
  CONTEXT_ASSOCIATION (context layer only), WAITS_FOR (wait layer, separate typed record).
- Consistency checking with deterministic quarantine of contradictory ordering components (no first-edge-wins).
- Time quality (BOUNDED/LOCAL_MONOTONIC_ONLY/UNKNOWN/CONTRADICTORY), gap nodes, coverage certificates (conservative).
- Versioned snapshots, bounded slice/ancestor queries, edge explanation, correction/invalidation/freshness propagation.
- Mechanism-evidence assembly consumed by C22/C26; causal claims routed through C16/C18 gates.
- Web: first-slice views (execution DAG with explain-edge, critical-path waterfall with covered/unexplained,
  cause-hypothesis hand-off to the existing investigation board). Full swimlanes/wait-for-graph view follow later phases.

## 3. Synthetic adapters, and what they do NOT establish (correction #6)

Message-broker, scheduler/task, and pool/lock knowledge enter phase 1 through synthetic adapter fixtures. They validate
**engine semantics** (identity/attempt/wait-layer/quarantine handling). They do NOT establish real adapter coverage,
production instrumentation correctness, or measured overhead. Real T2 (lock/task/data-version) adapters are deferred; the
design's own limit stands — full low-level causality cannot be promised from basic traces.

## 4. Deferred (explicit gaps, may remain as disclosed limitations)

Real OTLP collector ingestion; retention automation; multi-tenant scale claims; real C27 experiment execution
(`linkInterventionEvidence` gates wiring now, real reports later); swimlane/waterfall-view completeness beyond the
first-slice depth; measured instrumentation overhead.

## 5. Release rule (corrected baseline, binding)

Mandatory correctness and security gates must pass: RC20 authorization, RC11 quarantine (no silent contradiction drop),
RC17/RC24 freshness, RC22 recovery, RC23 redaction/revocation, RC02–RC07 no-fabrication, RC15 no double counting,
RC14 no absence-based exoneration, RC26–RC28 claim gates. Unsupported capabilities may remain explicit gaps, but a
**failing implemented guarantee cannot be relabeled as unsupported**. GapNodes are acceptable only where the required
behavior is safe degradation.

## 6. Decision points (user-owned; defaults applied until overridden)

| # | Decision | Default in force |
|---|---|---|
| D1 | T2 real adapters in "done"? | Deferred; synthetic adapters for semantics |
| D2 | §17 view depth | First-slice views (DAG+explain, waterfall, board hand-off) |
| D3 | Claims route through existing C18 gates | Yes; new claim classes registered |
| D4 | Web panel in "done" | Yes, first-slice depth |
| D5 | Fixture review | Self-authored + independent-oracle-derived expectations; human review pass is open (phase-0 limitation) |

## 7. Corrections register (integrated)

1. Risk-reduction checkpoints, not calibrated percentages — no quantified gains are claimed anywhere in these documents.
2. Confidence statements narrow to bounded implementation properties; telemetry completeness, causal interpretation and
   real-world applicability remain uncertain (design §21).
3. Independent validation requires a separate oracle/reviewer/independently derived expectations — fixtures below state
   their derivation method; algorithm-bearing expectations are re-verified against independent oracles.
4. GapNode acceptance restricted to safe degradation (§5 above).
5. Claim transitions test permitted AND prohibited paths, including the never-promote rule for execution evidence.
6. Synthetic adapters validate engine semantics only.
7. Acceptance reports factual: commands, results, mutations detected, unresolved failures, adapter limitations.