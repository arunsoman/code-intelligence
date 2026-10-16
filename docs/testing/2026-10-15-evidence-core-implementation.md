# Rust evidence core — first release implementation

Base: `f4c845cd649bb1625bb1f9f6a90682ed4125b72f`. This implements the PRD's **section 21 first implementation PR**, with conservative coverage declarations and a full-index fallback. It does **not** claim completion of the complete slices 0–8 roadmap. Existing product-specification and reviewer work are excluded from the diff.

## Delivered

- Rust `fact_normalize.rs`: check incompatible entity/fact/relationship/evidence ID collisions before the old deduper can mask them; union and sort evidence while preserving public IDs and legacy row order. Identical entities deduplicate. Default-off behavior remains the old indexing path.
- Rust `evidence_core.rs` and `producer_registry.rs`: versioned composite static-index producer, typed DTOs, namespace-separated canonical identities, support links, per-file partial coverage and explicit dynamic exclusions. Existing EvidenceRef classes and IDs remain unchanged; no observation is promoted to proof. The registry covers the existing worker collector, not new runtime/test/human producers.
- Optional `AnalysisBatch.evidenceCore`, omitted when disabled. Existing WorkerClient RPC, content handles, caller signatures and the TypeScript Store stay in place. No per-row RPC and no Rust SQLite writer.
- Strict Zod DTOs, independent source/revision/producer/content-identity checks, complete support-link reconciliation with embedded evidence, and persisted-row/manifest checks. Invalid mandatory metadata fails the revision; invalid optional metadata is discarded with a safe diagnostic.
- SQLite migration **54**: normalized producer runs, support links and coverage, with revision/run FKs, cascade deletion and lookup indexes. Full-index rows and sidecars commit in one existing transaction. Trigger-injected failures roll back all revision rows.
- Additive Store read APIs: `evidenceCoreProducerRuns`, `evidenceCoreLinks`, `evidenceCoreCoverage`. They check revocation and denied paths. Shadow mode stores metadata but does not expose it through these APIs. Historical revisions without sidecars return empty/unknown coverage.
- Enabled indexing ignores delta/unchanged reuse and regenerates a full batch, including when source bytes are unchanged. Store rejects direct delta writes while enabled, using existing `DeltaBaseError` handling. This avoids stale producer/coverage copying while native delta sidecars are deferred.
- Shared Rust/TypeScript canonical vectors, actual worker-to-Store integration tests, a repeatable synthetic benchmark, and 16 MiB / 100,000-record metadata limits. Exceeding a cap rejects indexing safely; it never silently drops links or reports complete coverage.

## Rollout and rollback

Defaults: `CIE_EVIDENCE_CORE_MODE=off`, `CIE_EVIDENCE_CORE_STRICT=0`, `CIE_EVIDENCE_CORE_COVERAGE_GATES=0`.

After applying the patch, run `bash scripts/setup-dev.sh` and `cargo build --release --locked`. Start the server with `CIE_EVIDENCE_CORE_MODE=shadow` to persist but hide sidecars, or `CIE_EVIDENCE_CORE_MODE=on CIE_EVIDENCE_CORE_STRICT=1` for strict testing. Restart the worker/server after changing flags; child workers inherit environment at spawn. Reindex to produce metadata for an existing repository.

Coverage gate value `1` is rejected: no proof rules are registered yet. Mode/version/boolean configuration is checked rather than silently coerced. Disabling the mode stops new emission and hides metadata; legacy data remains usable and sidecar tables may remain dormant. Migration 54 has a tested down step, but normal application rollback needs only the flag, not destructive DB downgrade.

## Important collision discovered

The existing sample repository produces two unresolved chained-call facts with the same ID but different UnknownValue reasons (`res.status(401).end` versus `res.status`). The old merge silently keeps the first. Enabled normalization rejects that incompatible identity with `INVALID_SCHEMA / EVIDENCE_CORE_ID_COLLISION`, as the PRD requires. Default-off indexing remains unchanged. This collision must be corrected in the originating analyzer with an explicit identity compatibility decision before enabling the feature broadly; this patch does not rewrite legacy IDs to hide it.

## Validation

- Required development setup completed (a missing Cargo component in the transient toolchain was repaired).
- `cargo build --release --locked`: passed.
- `cargo test --workspace --locked`: **137 passed**, no failures (3 harness + 134 worker tests).
- Typecheck and `git diff --check`: passed.
- Targeted Node suites: **42 tests: 40 passed, 1 failed, 1 skipped**. Suites: evidence-core, store-queries, incremental-index, calls-evidence, evidence-snapshot, re-evidence, feature-coverage, feature-store, twin-migrations.
- The sole failure is `#94B the local permission-model runner cannot observe coverage...`: this sandbox reports `REFUSED: this Node cannot deny network access and no network namespace is available` before the test's expected inspector refusal. It fails identically on untouched `f4c845c`. The test was not weakened.
- Nine new Node cases cover canonical contract parity; legacy input; atomic writes; denial/revocation; orphan/invalid coverage rejection; injected rollback; producer fencing; disabled delta/gates; off/shadow behavior; actual RPC compatibility and full recomputation; migration upgrade/downgrade; cascades; and stale persisted-manifest rejection (several assertions share a case).
- The real-worker fixture compares legacy entities/facts/relationships exactly, then checks changed-source full/fallback metadata equality. Rust tests additionally cover permutation-stable evidence unions, conflicting fact/evidence identities, conservative coverage and shared canonical vectors.

No model, browser renderer, live Mi-Pay deployment, disk-full simulation, worker-kill fault injection or full repository-wide regression sweep was run for this patch. Successful transaction rollback was tested by a SQLite abort trigger. This is not a claim that all acceptance criteria in the complete PRD have been met.

## Performance smoke report

Reproduce: `CIE_LOG_STDERR=0 CIE_LOG_FILE=off node tools/bench/evidence-core.ts`. The generated corpus is **60 files / 480 functions**, five samples per mode, fresh worker processes with a shared warm filesystem. These are measurements in the current shared environment, not 4-core/8-GiB acceptance results. Raw samples are in `2026-10-15-evidence-core-benchmark.json`.

| Median metric | Off | On |
| --- | ---: | ---: |
| Worker index milliseconds | 27.323 | 47.853 |
| Store insertion milliseconds | 20.382 | 72.713 |
| SQLite bytes | 4,382,720 | 5,156,864 |
| Metadata JSON bytes | omitted | 407,599 |
| Median of per-sample lookup p95, milliseconds | 0.049 | 0.098 |

DB growth is approximately **17.7%**. Worker indexing is approximately **1.75×**, exceeding the proposed **1.15×** target. Peak RSS cannot be certified here: `/proc` visibility makes the sampled worker RSS incomplete/unreliable. No 1.20× memory claim is made. Native delta acceleration, identity/serialization optimization and representative monorepo/cold-file-cache measurements remain rollout work. The mode stays off by default.

## Explicitly deferred

Native sidecar delta copy/invalidation; fine-grained per-language/analyzer capability coverage; registered derivations and proof/negative-claim promotion; runtime/test/RE/human adapters; snapshot contract extensions; feature VerifiedContextPackage; broad telemetry/shadow-verifier comparisons; production rollout and performance acceptance. No existing claim, feature authority, test-certification, source policy, UI or LLM gate was replaced.
