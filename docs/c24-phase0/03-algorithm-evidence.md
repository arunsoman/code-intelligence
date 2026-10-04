# C24 Phase 0 · Algorithm evidence

Deliverable 3 of 5. Each load-bearing semantic exists as a pure function with (a) property tests, (b) an independent
brute-force oracle implemented differently from the code under test, and (c) a demonstrated mutation-detection case.
Code: `packages/core/src/c24/ordering.ts`, `packages/core/src/c24/path-accounting.ts`.
Tests: `packages/core/test/c24-phase0-algorithms.test.ts` (11/11 pass).

## 1. Deterministic contradiction quarantine — RC11 (`reconcileProposedOrdering`)

Semantics: every SCC (size > 1) among proposed EXECUTION_ORDER edges is quarantined *whole*; the DAG remainder is
accepted; every quarantined edge keeps its conflictId + full competing provenance (design §6/§13: quarantined with
provenance, never silently dropped; the cycle decision must not decide truth by ingest order).

- Property: same proposal set under 120 permutations (seeded shuffles) — identical accepted/quarantined/conflicts sets.
- Oracle: Floyd–Warshall transitive closure; a node is cyclic iff it reaches itself; every edge proposal's state must
  match the oracle's cyclicity of its endpoints (checked for a two-cycle overlapping a four-node graph).
- Mutation demonstration: an accept-everything variant produces an accepted cycle (a reaches itself under the oracle);
  the RC11 property test and the RC11 fixture test both fail for it. Gate proven necessary, not decorative.

## 2. Certified partial-order queries — RC03/RC04 (`orderRelation`)

Semantics: HAPPENS_BEFORE/HAPPENS_AFTER only along a bounded-breadth path of ordering edges; a hop-bound hit yields
UNKNOWN, never an inference from truncation; CONCURRENT_CERTIFIED only with a valid certificate covering BOTH endpoints;
scalar stamps (Lamport counters, wall clocks) are inputs to nothing here.

- Properties: smaller-stamp/earlier-clock pair without path → UNKNOWN with stated limitations; invalid certificate →
  UNKNOWN (forgery refused); certificate not covering endpoints → UNKNOWN; valid covering certificate →
  CONCURRENT_CERTIFIED; hop bound below path length → UNKNOWN.
- Oracle: Floyd–Warshall closure over a layered DAG; all 12 ordered pairs agree with the phase-0 implementation;
  self-order is UNKNOWN (nothing to order).
- Mutation demonstration: a copy with the `valid` gate removed returns CONCURRENT_CERTIFIED for a valid:false
  certificate — the RC04 test fails for it. Gate removal is caught.

## 3. Overlap-aware duration accounting — RC15 (`accountDurations`)

Semantics: covered time is the union of covered intervals within the observation window (design §9: nested/overlapping
durations are not summed); uncovered time stays UNEXPLAINED; impossible (non-finite/inverted) intervals are discarded
with a stated reason, never silently counted, never clipped into validity.

- Properties: nested parent/child → union 100 ms (sum would be 110); overlapping 0–60/40–80 → 80; inverted interval
  discarded with named reason; re-segmentation of the same coverage yields identical totals.
- Oracle: independent integer-grid scan (counts every covered unit tick); agrees with the union implementation on the
  fixture corpus and on split re-segmentations.
- Mutation demonstration: summing variant double-counts (110 vs 100) — the RC15 test's expectation fails for it.

## 4. What this evidence is and is not (correction #7)

It is: proof the semantics are implementable as pure functions; proof the planned suite detects the removal of each of
these three gates; a concrete contract phase 1's builder must satisfy under the same properties.

It is not: a statement about real telemetry behavior, about performance at §15's slice limits, or any quantitative
reliability claim. Those arrive with the phase-1 engine, its fixtures, and measured validation.