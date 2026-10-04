# C24 Phase 0 · Contract closure

What is frozen before engine implementation, per design §20 ("Before integration, freeze event/edge/certificate schemas…").

## 1. Registered schemas — `c24.causality.v2`

Location: `packages/schema/src/index.ts` (section "C24 causality v2 (phase-0 contract closure)").

Enums (verbatim from design §11): `EventKind` (22), `EdgeKind` (12), `GraphLayer` (5), `EdgeState` (4),
`TimeQuality` (4), `SourceTrust` (3), `SamplingState` (5), `GapKind` (7), `CertificateState` (3),
`GraphConsistency` (3), `OrderRelation` (4), `MechanismKind` (8), `SegmentKind` (5), `CausalClaimLevel` (4),
`ClaimFreshness` (3).

DTOs: `RuntimeEvent` (+ `EventTime`, `EventQuality`, logical-clock ref), `RuntimeEdge`, `WaitRelation`,
`CoverageCertificate`, `GapNode`, `CausalClaimReference`, `RegisteredAttributes` (bounded: ≤32 keys, values ≤500 chars).
Zod-validated: `RuntimeEventSchema`, `RuntimeEdgeSchema`, `WaitRelationSchema`, `CoverageCertificateSchema`,
`GapNodeSchema`, `CausalClaimReferenceSchema`.

Deliberately NOT frozen yet (phase-1 outputs): the 16 gateway operation signatures (`registerAdapter` … `readUpdates`),
ExplanationRelation record, snapshot internals beyond the §11 fields frozen here. These arrive with the engine; this
document records that they are outstanding, not that they are agreed.

## 2. Migration — version 20 `c24-causality` (design §15)

`packages/core/src/migrations.ts`; verified applied (all 8 tables present in a fresh store):

| Table | Key/index | Purpose |
|---|---|---|
| c24_runtime_sources | id | adapter/schema/trust/watermark |
| c24_event_refs | unique(source, source_epoch, dedup_hash); trace index | minimized identity/time refs |
| c24_edge_versions | (id, version); ends index | edge versions, states, provenance |
| c24_attribution | (event_id, version) | per-event code attribution |
| c24_coverage | id | source-certified completeness |
| c24_snapshots | id | scope hash/version, event_seq |
| c24_derivations | (source_key, derived, derived_version) | correction/invalidation lineage |
| c24_updates | (snapshot_id, seq) | durable outbox/replay page |

## 3. Gateway permission split (phase-1 catalogue follows this table)

| Class | Operations | Gate |
|---|---|---|
| Privileged (intake/authority) | registerAdapter, ingestEvents, applyCorrection, invalidateSource | authenticated adapter identity; authority grant for revocation-class ops; never in the public catalogue |
| Scoped queries | reconstruct, querySlice, traceAncestors, checkOrder, explainRelation, criticalPath, getCoverage, getSnapshot, readUpdates, resolveAttribution | CallContext authorization + scope pinning (tenant, revision set, policy epoch), bounded |
| Delegating | buildMechanismEvidence | assembles evidence for C22/C26; cannot declare findings accepted |
| Delegating | linkInterventionEvidence | delegates state change to C18/C16 after scope verification (design §12) |

Raw collector intake and certificate issuance never appear on the public gateway (design §12).

## 4. C18 claim-transition rules (validated in `c24-phase0-claim-gates.test.ts`)

Claim classes registered for C24: `CAUSAL_EXECUTION_RELATION`, `CAUSAL_MECHANISM`, `CAUSAL_INTERVENTION`
(mapped onto CausalClaimLevel; C16 display gates unchanged).

| Transition | Evidence required | Allowed? |
|---|---|---|
| EXECUTION_RELATION → display | trusted adapter certificate/evidence, CURRENT | Yes — displays as INFERENCE, never FACT |
| EXECUTION_RELATION → MECHANISM_SUPPORTED | ownership/wait evidence (design §18 step 2) | Only with the wait/ownership path; relation alone is not mechanism evidence |
| anything → INTERVENTION_SUPPORTED | gated C27 experiment report matched to scope (workload, revision, cohort) + dependencyIds wired | Without the report dependency the claim stays hypothesis/hidden (RC26/RC27/RC28 asserted both ways) |
| correlation-only evidence → any causal promotion | — | Prohibited; CORRELATES_WITH stays in the association layer |

Enforcement lives in the existing gates (grounding requires cited evidence to exist and be CURRENT; the display
decide() never emits FACT without a human CONFIRM verdict, and even then it stays INFERENCE). The prohibited cases are
asserted as tests: no-experiment-dependency intervention claim (never FACT, reasons stated), forged evidence ids
(grounding FAIL), confounded before/after cohorts (INFERENCE-or-below with confounds recorded).

## 5. Open items carried to phase 1

- The 16 gateway op signatures + `CausalityUpdatePage`/`GraphSlice`/`RelationExplanation`/`CoverageReport` record shapes.
- ExplanationRelation typed record (design §11 close).
- Deterministic reconciliation wired into the real builder (phase-0 pure functions + oracles are the contract for it).
- Fixture independent human review (correction #3) — self-authored corpus with oracle-derived expectations is complete;
  a separate reviewer pass is outstanding and must happen before release.