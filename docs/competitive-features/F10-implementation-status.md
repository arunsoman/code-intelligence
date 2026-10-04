# F10 implementation status

Tracks what has landed for **F10 — Bounded workflow digital twin** and what remains.
F10 is a P3 spec whose full definition of done requires a real reference service, a load generator and
dedicated hardware (§15.4). This slice lands the complete *logic* pipeline — data model, discrete-event
kernel, workload generator, baseline fit, structure selection, paired experiment runner, validation
certificates, applicability gating, sensitivity, race exploration, orchestration and persistence —
tested end-to-end against deterministic native adapters.

## Landed in this slice

### Data model and pure rules

| File | What | Status |
|---|---|---|
| `packages/schema/src/twin.ts` | Full vocabulary and interfaces: result/intervention/metric/domain/gate (G0–G8) vocabularies; `WorkloadSpec`, `EnvironmentSpec`, `TwinSnapshot`, `TwinStructure`, `TwinModelSpec`/`ModelStation`/`ModelResource`/`ServiceTimeSource`, `StructureCandidate`, `ValidationScope`/`ValidationCertificate`, `CalibrationRun`, `ModelArtifact`, `OutcomesRecord`/`Artifact`, `TrialMetrics`, `RunCell`, `ExperimentPlan`, `TwinReport`, `MetricPrediction`, `ApplicabilityRequest`/`Decision`, `PredictionResult`, `RaceWindow`/`RaceFinding`, `Twin`; zod wire schemas. | ✅ |
| `packages/core/src/twin.ts` | Pure rules: twin/binding hashes, workload/environment/scope validation, event-keyed streams, `checkApplicability`, `deriveAllowedClass`, `verifyResultClass`, `validateComparisonPolicy`, gate/holdout evaluation, `canIssueCertificate`, demand/wait double-count, material-unresolved derivation. | ✅ |
| `packages/schema/src/index.ts`, `packages/core/src/index.ts` | Re-export the twin model and every rule/module. | ✅ |

### Pipeline modules (the F10 work packages)

| WP | File | What | Status |
|---|---|---|---|
| WP-06 | `packages/core/src/twin-kernel.ts` | Typed bounded discrete-event kernel: binary min-heap keyed by `(atMs, seq)`, monotonic time, deterministic tie-break, capacity acquire/release, bounded queues/events, retry/timeout/fault handling, per-request outcomes, utilisation/peak-queue/throughput/p95. | ✅ |
| WP-04 | `packages/core/src/twin-workload.ts` | Event-keyed arrival generation (keyed by request index only, F10-D1), open-loop streams, `workloadHash`, `fixtureFromRecords`. | ✅ |
| WP-03 | `packages/core/src/twin-baseline.ts` | Poisson vs piecewise arrival fit with diagnostics, exclusive demand vs wait split (black-box handling), observed baseline, size-correlated resampling, size↔demand correlation. | ✅ |
| WP-07 | `packages/core/src/twin-model.ts` | `modelSpecFromBaseline`, `fitParameters`, four structure candidates (FIXED/CONTENTION/CACHE_DEPENDENCE/RETRY_AMPLIFICATION), `applyIntervention`, `modelError`. | ✅ |
| WP-05 | `packages/core/src/twin-experiment.ts` | `NativeAdapter` contract, trial metrics keeping failures in the population, generator-validity checks (saturation/coordinated omission/instrumentation/hash), interleaved paired runner with retained artifacts and comparable-pair filtering, population rules. | ✅ |
| WP-08 | `packages/core/src/twin-validation.ts` | Gates G0–G8, immutable hashed locked predictions, prediction-before-measurement check, held-out assembly, certificate issuance/invalidation/usability, model/fit hashes. | ✅ |
| WP-10 | `packages/core/src/twin-sensitivity.ts` | Assumption sweep with sign-reversal/fragility detection, abstention, partial reports. | ✅ |
| WP-11 | `packages/core/src/twin-races.ts` | Candidate race windows (untransacted writers, async shared state, lock-order cycles), bounded exploration over the reviewed schedule DSL, replay, bounded wording. | ✅ |
| WP-09 | `packages/core/src/twin-engine.ts` | C27 orchestration: `createTwin`, `buildFixture`, `fitModel` (with calibration history), `validateInterventionClass`, `runPairedExperiment`, `checkApplicability`, `predictScenario`, `sensitivity`, `raceWindows`/`exploreRace`, `invalidate`, plus reads. | ✅ |
| WP-02 | `packages/core/src/twin-persistence.ts` + `migrations.ts` | Migration 31 (`twins`, `twin_versions`, `twin_baselines`, `workload_fixtures`, `environment_specs`, `model_artifacts`, `calibration_runs`, `validation_certificates`, `twin_experiments`, `twin_run_cells`, `twin_reports`, `schedule_explorations`, `prediction_records`) and a save/load adapter for the whole `TwinStore`. | ✅ |
| — | `packages/core/src/twin-native-fake.ts` | Deterministic native adapter used to exercise the runner without hardware; supports forced saturation/instrumentation and per-request behaviour overrides. | ✅ |

### Tests

| File | Covers | Tests |
|---|---|---|
| `packages/core/test/twin.test.ts` | F10-A2, A3, A4, A5, A6, D1, D3 + spec/structure/hash validation | 28 ✅ |
| `packages/core/test/twin-kernel.test.ts` | F10-D2 kernel invariants; F10-A4 outcomes/population; generator validity | 9 ✅ |
| `packages/core/test/twin-pipeline.test.ts` | F10-A1, A2, A3, A5, A6, A7; D5, D7, D9, D10, D11 | 13 ✅ |
| `packages/core/test/twin-model-extra.test.ts` | F10-D4 resampling, F10-D6 structure selection, baseline/calibration diagnostics | 5 ✅ |
| `packages/core/test/twin-migrations.test.ts` | WP-02 schema applies and rolls back | 1 ✅ |
| `packages/core/test/twin-persistence.test.ts` | WP-02 store round-trip; a reloaded certificate still binds and gates | 1 ✅ |

`node --test packages/core/test/twin*.test.ts` → **57 passing**.

### What works now

1. **Baseline reproduction (F10-A1).** `buildObservedBaseline` fits the arrival process (Poisson or
   piecewise with diagnostics), splits demand from wait, and `fitParameters`/`modelError` score the model
   against the observed vector; a perturbed service time scores strictly worse.
2. **Holdout acceptance and issuance (F10-A2).** `validateInterventionClass` locks every held-out
   prediction *before* measuring it (`leakage` is provably empty), runs the paired experiment through the
   adapter, evaluates direction/magnitude/coverage against the predeclared criterion, and issues a
   certificate only when gates G0–G4, G6–G8 and the holdout pass.
3. **Domain gating (F10-A3).** `checkApplicability` blocks out-of-domain points by default
   (`allowedClass: null`); `exploratory: true` downgrades to `MODEL_PREDICTION`.
4. **Comparison population (F10-A4).** `metricsFromOutcomes` keeps failures/timeouts in
   `completedWorkRate`/`allRequestsP95`; `validateComparisonPolicy` rejects a plan policy that omits
   `errorRate` or `completedWorkRate`.
5. **Invalidation (F10-A5).** `computeBindingHash` covers model spec, fit, workload(s), environment,
   oracle, source/build and policy ids; changing a bound input makes the certificate `STALE` and refuses
   the validated class — *including after a persistence reload*.
6. **Result-class enforcement (F10-A6).** `deriveAllowedClass` is the single derivation; a twin with no
   certificate can never return `VALIDATED_MODEL_PREDICTION`.
7. **Race findings (F10-A7).** Bounded exploration against a named-reviewer oracle returns a reproducible
   schedule with a hash, the bounds in the wording, and the explicit non-claim; an unreviewed oracle is
   refused.
8. **Kernel invariants (F10-D2).** Same seed ⇒ same result; utilisation ≤ 1; a full queue is reported, not
   hidden; event-budget exhaustion is reported rather than reported as success.
9. **D4/D5/D6/D7/D9/D10/D11.** Size↔demand correlation is preserved by whole-record resampling; a
   prediction recorded after its measurement is rejected; a wrong structure fits worse; a saturating
   generator yields incomparable cells with a reason; a short experiment refuses a tail verdict;
   sensitivity reports fragility; fixtures carry summaries, never payloads.
10. **Persistence (WP-02).** The whole store round-trips through SQLite and the reloaded certificate still
    binds and gates.

## Not yet implemented

| WP | Title | Remaining |
|---|---|---|
| WP-00 | Prerequisites (`defect.v2` manifest roles; F05 profile/trace plumbing) | `RunRole` `TWIN_*`/`MODEL_*` values are not yet emitted by the existing defect manifest writer |
| WP-01 | Reference service + load generator + variance study | Requires a real service and hardware (§15.4) |
| WP-05 | Real open-loop generator | Deterministic fake adapter provided; the production generator driver is not |
| WP-12 | Twin workspace UI | Not started (surfaces for twin list, certificate scope, prediction class labels, race findings, sensitivity tornado) |
| WP-13 | Real-input demonstration, mutation controls, evaluation report | Unit acceptance is in place; the real workload run is not |
| WP-09 | Service/C16 wiring | Pure functions and the engine are done; HTTP operations and the C16 display/export re-derivation are not yet wired into `service.ts` |

## Suggested next steps

1. **WP-09 wiring**: expose `TwinEngine` operations as C27 service endpoints and call `deriveAllowedClass`
   in C16 at display/export so a stored class cannot outlive its certificate.
2. **WP-00/WP-05**: emit `TWIN_BASELINE`/`TWIN_CANDIDATE`/`MODEL_TRAINING`/`MODEL_HOLDOUT` run-manifest
   roles and back `NativeAdapter` with the real load generator.
3. **WP-12**: build the twin workspace over the reports and certificates the engine already produces.
4. **WP-13**: run the reference workflow under the production generator and record the evaluation.

## Notes

- `comparePairedBenchmarks` was intentionally left unchanged: the new population requirement is enforced
  at *plan time* by `validateComparisonPolicy`, so existing callers/tests that use their own regression
  metrics keep working.
- The persistence schema is a superset of the F10 §6.2 proposal: `twin_baselines`, `prediction_records`,
  and `plan_json`/`finding_json` columns were added so the engine's in-memory store round-trips exactly
  (the proposal's normalised columns are still populated for queryability).
- Pre-existing type errors in `packages/core/src/forms/profile.ts`, `packages/core/src/service.ts` and
  some profile tests are unrelated to this slice (work in progress from another change).
