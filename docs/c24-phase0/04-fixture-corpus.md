# C24 Phase 0 · Reviewed fixture corpus

Deliverable 4 of 5. 28 fixtures, one per acceptance id (RC01–RC28), in `packages/core/test/c24-causality-fixtures/`,
regenerable from `packages/core/test/generate-c24-fixtures.mjs` (the generator is the source; fixtures are artifacts).
Corpus validated by `packages/core/test/c24-phase0-fixtures.test.ts` (6/6 pass).

## Composition

| Class | Count | Ids |
|---|---|---|
| positive | 17 | RC01, RC02, RC03, RC05, RC06, RC07, RC09, RC12, RC13, RC15, RC17, RC18, RC25 (engine-behavior positives) |
| negative-control | 10 | RC08, RC11, RC19, RC20, RC21, RC22, RC23, RC26, RC27, RC28 |
| missing-data | 1 | RC04, plus missing-data aspects inside RC10/RC14/RC16/RC24 inputs |

Correction (baseline item: class mix): RC17 was re-classed from negative-control to positive — a source correction is
legitimate input whose correct propagation (invalidation before refresh) is the required behavior, not a rejection.

## Derivation policy (correction #3: expected results derived independently of the implementation)

Each fixture records `derivation.method` and the exact design rule it derives from:

| Method | Meaning | Fixtures |
|---|---|---|
| `hand` | expected result worked out from the design text's rules without running any phase-1 code | most |
| `oracle` | expected result computed/verified by the independent phase-0 oracles (Floyd–Warshall closure, integer-grid scan, permutation sweeps), cross-checked against the hand derivation | RC03, RC04*, RC11, RC15, plus oracle agreement for RC01's ordering outcome |
| `hand+oracle` | both, documented | RC26–RC28 (claim-gate oracles: real C16/C18 gate pipeline) |

*RC04's oracle agreement also demonstrates the boundary: certified concurrency requires a valid covering certificate.

## Negative controls (each asserts refusal/rejection/irreversibility)

RC20 forged trace context (UNTRUSTED_CONTEXT, no grant, no topology disclosure) · RC21 oversized slice (truncation +
continuation, no unbounded persistence) · RC22 crash boundaries (no duplicate authoritative result, no mixed snapshot) ·
RC23 revoked source/deleted handle (RESTRICTED, no historic recovery) · RC08 identity reuse across epochs (quarantine) ·
RC11 contradictory ordering (quarantine with retained provenance) · RC19 shared-dependency interference (population/spillover
limits retained) · RC26 LLM unsupported root cause (hypothesis-only, gates block display) · RC27 scope mismatch (no
promotion) · RC28 confounded before/after (observational only).

## Machine-checkable-now subset

RC01 (trusted relation retained over skew, contradiction disclosed), RC03, RC04, RC11 (permutation-invariant quarantine),
RC15 (union accounting) — their recorded expected results are reproduced by oracles in the corpus test at phase-0 time.
The remainder await the phase-1 engine; they are stated as assertions the engine must satisfy, not as outcomes already
observed.

## Review status (must be resolved before release)

Self-authored by the implementing agent with oracle-derived expectations where the expectation is computable. Per the
corrected baseline, this does not constitute independent validation: an external review pass (human reviewer or an
independently produced fixture set with its own expected results) is an open release-blocking item for phase 1.