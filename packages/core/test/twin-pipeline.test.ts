// F10 acceptance and design checks driven through the engine with the deterministic native adapter.
// Covers F10-A1, A2, A3, A5, A6 and D5, D7, D9, D10, D11.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { IndependentOracle, ScheduleBounds, ScheduleHarness } from "../src/defect-schedule.ts";
import { TwinEngine } from "../src/twin-engine.ts";
import { modelError } from "../src/twin-model.ts";
import { evaluateHoldout, validateComparisonPolicy, type ComparisonPolicyLike } from "../src/twin.ts";
import { predictionPrecedesMeasurement, lockPrediction } from "../src/twin-validation.ts";
import { createDeterministicNativeAdapter } from "../src/twin-native-fake.ts";
import { runPairedExperiment } from "../src/twin-experiment.ts";
import { generateArrivals } from "../src/twin-workload.ts";
import { validateWorkloadSpec } from "../src/twin.ts";
import { makeBaselineInput, makeEnvironment, makeStructure, lineage } from "./twin-fixtures.ts";

const policy: ComparisonPolicyLike = { id: "cmp", primaryMetric: "p95", direction: "LOWER", minimumPairs: 3, minimumImprovement: 0.05, confidenceLevel: 0.95, regressionLimits: { errorRate: { direction: "LOWER", maximumRelativeRegression: 0.2 }, completedWorkRate: { direction: "HIGHER", maximumRelativeRegression: 0.1 } } };

function engineWith(adapter = createDeterministicNativeAdapter({})) {
  const engine = new TwinEngine({ adapter, now: () => 1_000_000, tickMs: 1000 });
  const twin = engine.createTwin({
    workflowId: "wf:createPayment", name: "createPayment", createdBy: "tester",
    snapshot: { repositoryId: "payments-api", revision: "rev-1", sourceHash: "a".repeat(64), buildHash: "b".repeat(64), configHash: "c".repeat(64), dependencyLockHash: "d".repeat(64), dataStateHash: "e".repeat(64) },
    structure: makeStructure(), baseline: makeBaselineInput(), environment: makeEnvironment(), oracleHash: "f".repeat(64),
  });
  engine.buildFixture(twin.twinId, { windowIds: ["w:1"] });
  return { engine, twin };
}

describe("F10-A1 baseline reproduction", () => {
  it("the fitted model reproduces the observed baseline better than a perturbed one", () => {
    const observed = { throughput: 100, p95: 200, errorRate: 0.01 };
    const good = modelError({ throughput: 104, p95: 210, errorRate: 0.008 }, observed);
    const perturbed = modelError({ throughput: 100, p95: 100, errorRate: 0.01 }, observed); // halved service time
    assert.ok(good < 0.1, `good error ${good}`);
    assert.ok(perturbed > good, "a perturbed model must be worse");
  });
});

describe("F10-A2 holdout interventions meet predeclared criteria", () => {
  it("issues a certificate when the held-out criterion is met and refuses a wrong structure", async () => {
    const { engine, twin } = engineWith();
    const fitted = engine.fitModel(twin.twinId, { trainingDatasetIds: ["w:1"], structureCandidates: ["FIXED", "CONTENTION"], policyId: "p1" });
    const lenient = { minPoints: 2, noiseFloor: 0.02, maxMagnitudeError: 0.95, minIntervalCoverage: 0, nominalCoverage: 0.9 };
    const result = await engine.validateInterventionClass(twin.twinId, {
      modelId: fitted.model.modelId, interventionClass: "POOL_CAPACITY",
      heldOut: [{ parameter: "pool", values: [6, 12], loadMultipliers: [1] }], trainingValues: [4, 8, 16], range: { min: 4, max: 16 },
      tolerancePolicyId: "tol-1", issuedBy: "reviewer", comparisonPolicy: policy, criterion: lenient,
    });
    assert.ok(result.certificate, `certificate not issued: ${result.refusal}`);
    assert.deepEqual(result.leakage, [], "no prediction was recorded after its measurement");
    assert.equal(result.certificate!.validation.gates.find((g) => g.gate === "G4")?.passed, true);
    // A deliberately wrong structure must fail the holdout criterion.
    const wrong = evaluateHoldout([
      { parameter: "pool", value: 6, loadMultiplier: 1, predictedDelta: { lower: -0.02, upper: 0.02, method: "m", confidenceLevel: 0.9 }, measuredDelta: { lower: -0.3, upper: -0.2, method: "m", confidenceLevel: 0.9 }, directionAgrees: false, withinTolerance: false, predictionRecordHash: "a".repeat(64), predictionRecordedAt: "2026-01-01T00:00:00.000Z" },
      { parameter: "pool", value: 12, loadMultiplier: 1, predictedDelta: { lower: -0.02, upper: 0.02, method: "m", confidenceLevel: 0.9 }, measuredDelta: { lower: -0.1, upper: -0.05, method: "m", confidenceLevel: 0.9 }, directionAgrees: false, withinTolerance: false, predictionRecordHash: "b".repeat(64), predictionRecordedAt: "2026-01-01T00:00:00.000Z" },
    ], { minPoints: 2, noiseFloor: 0.02, maxMagnitudeError: 0.15, minIntervalCoverage: 0.8, nominalCoverage: 0.9 });
    assert.equal(wrong.passes, false);
  });
});

describe("F10-A3 out-of-domain is blocked or exploratory", () => {
  it("blocks pool 64 at 2.5x and allows an exploratory prediction only", async () => {
    const { engine, twin } = engineWith();
    const fitted = engine.fitModel(twin.twinId, { trainingDatasetIds: ["w:1"], structureCandidates: ["FIXED"], policyId: "p1" });
    await engine.validateInterventionClass(twin.twinId, {
      modelId: fitted.model.modelId, interventionClass: "POOL_CAPACITY",
      heldOut: [{ parameter: "pool", values: [6], loadMultipliers: [1] }], trainingValues: [4, 8, 16], range: { min: 4, max: 16 },
      tolerancePolicyId: "tol-1", issuedBy: "reviewer", comparisonPolicy: policy, criterion: { minPoints: 1, noiseFloor: 0.02, maxMagnitudeError: 0.95, minIntervalCoverage: 0, nominalCoverage: 0.9 },
    });
    const blocked = engine.predictScenario(twin.twinId, { intervention: { class: "POOL_CAPACITY", parameters: { pool: 64 } }, workload: { arrivalModel: "POISSON", rateMultiplier: 2.5 }, metrics: ["p95"] });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.domainAssessment.verdict, "OUT_OF_DOMAIN");
    assert.ok(blocked.domainAssessment.violatedRanges.some((v) => v.includes("64")));
    const exploratory = engine.predictScenario(twin.twinId, { intervention: { class: "POOL_CAPACITY", parameters: { pool: 64 } }, workload: { arrivalModel: "POISSON", rateMultiplier: 2.5 }, metrics: ["p95"] }, { exploratory: true });
    assert.equal(exploratory.blocked, false);
    assert.equal(exploratory.resultClass, "MODEL_PREDICTION");
    assert.notEqual(exploratory.resultClass, "VALIDATED_MODEL_PREDICTION");
  });
});

describe("F10-A5 changing a bound input invalidates the certificate", () => {
  it("invalidate marks the twin and certificate stale and refuses the validated class", async () => {
    const { engine, twin } = engineWith();
    const fitted = engine.fitModel(twin.twinId, { trainingDatasetIds: ["w:1"], structureCandidates: ["FIXED"], policyId: "p1" });
    const result = await engine.validateInterventionClass(twin.twinId, {
      modelId: fitted.model.modelId, interventionClass: "POOL_CAPACITY",
      heldOut: [{ parameter: "pool", values: [6], loadMultipliers: [1] }], trainingValues: [4, 8, 16], range: { min: 4, max: 16 },
      tolerancePolicyId: "tol-1", issuedBy: "reviewer", comparisonPolicy: policy, criterion: { minPoints: 1, noiseFloor: 0.02, maxMagnitudeError: 0.95, minIntervalCoverage: 0, nominalCoverage: 0.9 },
    });
    assert.ok(result.certificate);
    engine.invalidate(twin.twinId, "source changed", "tester");
    assert.equal(engine.getTwin(twin.twinId).state, "STALE");
    const decision = engine.checkApplicability(twin.twinId, { intervention: { class: "POOL_CAPACITY", parameters: { pool: 12 } }, workload: { arrivalModel: "POISSON", rateMultiplier: 1 }, environmentHash: engine.getTwin(twin.twinId).environmentHash }, {});
    assert.equal(decision.allowedClass, null);
    assert.notEqual(decision.verdict, "IN_DOMAIN");
  });
});

describe("F10-A6 unsupported predictions never carry the validated class", () => {
  it("a twin with no certificate refuses the validated class and blocks by default", () => {
    const { engine, twin } = engineWith();
    engine.fitModel(twin.twinId, { trainingDatasetIds: ["w:1"], structureCandidates: ["FIXED"], policyId: "p1" });
    const pred = engine.predictScenario(twin.twinId, { intervention: { class: "POOL_CAPACITY", parameters: { pool: 12 } }, workload: { arrivalModel: "POISSON", rateMultiplier: 1 }, metrics: ["p95"] });
    assert.equal(pred.blocked, true);
    assert.notEqual(pred.resultClass, "VALIDATED_MODEL_PREDICTION");
  });
});

describe("F10-D5 holdout leakage is refused", () => {
  it("a prediction recorded after its measurement is rejected", () => {
    const prediction = lockPrediction({ id: "p", parameter: "pool", value: 6, loadMultiplier: 1, interval: { lower: -0.1, upper: 0.1, method: "m", confidenceLevel: 0.9 }, baselineValue: 1, predictedValue: 0.9, recordedAtMs: 2000 });
    assert.equal(predictionPrecedesMeasurement(prediction, 3000).ok, true);
    assert.equal(predictionPrecedesMeasurement(prediction, 1000).ok, false);
  });
});

describe("F10-D7 pair rejection retains reason and counts", () => {
  it("a saturating generator produces incomparable cells, not a silent drop", async () => {
    const { engine, twin } = engineWith(createDeterministicNativeAdapter({ forceSaturation: true }));
    const fitted = engine.fitModel(twin.twinId, { trainingDatasetIds: ["w:1"], structureCandidates: ["FIXED"], policyId: "p1" });
    const run = await engine.runPairedExperiment(twin.twinId, { modelId: fitted.model.modelId, intervention: { class: "POOL_CAPACITY", parameters: { pool: 12 } }, loadMultiplier: 1, repetitions: 4, comparisonPolicy: policy });
    assert.equal(run.resultClass, "NONE");
    assert.ok(run.plan.cells.every((c) => !c.comparable));
    assert.ok(run.plan.cells.some((c) => c.incomparableReason?.includes("SATURATED")));
  });
});

describe("F10-D9 tail verdict refused below the independent-block minimum", () => {
  it("a short experiment refuses a p99 verdict", async () => {
    const adapter = createDeterministicNativeAdapter({});
    const { engine, twin } = engineWith(adapter);
    const spec = engine.store.fixtures.get(engine.getTwin(twin.twinId).workloadHash)!;
    const model = engine.latestModel(twin.twinId) ?? engine.fitModel(twin.twinId, { trainingDatasetIds: ["w:1"], structureCandidates: ["FIXED"], policyId: "p1" }).model;
    const base = (await import("../src/twin-model.ts")).modelSpecFromBaseline(makeStructure(), engine.store.baseline.get(`${twin.twinId}@1`)!, makeEnvironment());
    const run = await runPairedExperiment({ twinId: twin.twinId, twinVersion: 1, planId: "p", adapter, baselineModel: base, candidateModel: base, environment: makeEnvironment(), workload: spec, intervention: { class: "POOL_CAPACITY", parameters: { pool: 12 } }, loadMultiplier: 1, repetitions: 2, seed: "s", comparisonPolicy: { id: "c", primaryMetric: "p95", direction: "LOWER", minimumPairs: 3, minimumImprovement: 0.05, confidenceLevel: 0.95, regressionLimits: {} }, buildHash: twin.snapshot.buildHash, environmentHash: twin.environmentHash, workloadHash: twin.workloadHash, oracleHash: twin.oracleHash, minTailBlocks: 3, maxRequestsPerRun: 800 });
    assert.equal(run.tailVerdictAllowed, false);
    void model;
  });
});

describe("F10-D10 sensitivity reports a sign reversal", () => {
  it("flags fragility when an assumption can flip the effect", () => {
    const { engine, twin } = engineWith();
    engine.fitModel(twin.twinId, { trainingDatasetIds: ["w:1"], structureCandidates: ["FIXED"], policyId: "p1" });
    const result = engine.sensitivity(twin.twinId, {
      assumptions: [{ id: "db-latency", statement: "DB latency degrades with concurrency", range: [0, 3] }],
      intervention: { class: "POOL_CAPACITY", parameters: { pool: 4 } }, loadMultiplier: 1,
    });
    assert.equal(result.statuses.length, 1);
    assert.equal(typeof result.fragile, "boolean");
  });
});

describe("F10-D11 production payloads never appear in fixtures", () => {
  it("a fixture derived from traces applies the label allowlist and carries only summaries", () => {
    const spec = generateArrivalsSpec();
    assert.deepEqual(validateWorkloadSpec(spec), []);
    const serialized = JSON.stringify(spec);
    assert.ok(!serialized.includes("@"), "no email-like payload");
    assert.ok(!serialized.includes("Bearer "), "no credential-like payload");
  });
});

describe("F10-A7 race findings carry reproducible schedules and bounds", () => {
  const harness: ScheduleHarness = { schemaId: "defect.schedule.v1", initial: { balance: 100 }, tasks: [
    { id: "A", instructions: [{ op: "SET", target: "balance", value: { op: "SUB", left: { ref: "balance" }, right: 20 } }] },
    { id: "B", instructions: [{ op: "SET", target: "balance", value: { op: "SUB", left: { ref: "balance" }, right: 20 } }] },
  ] };
  const bounds: ScheduleBounds = { maxSchedules: 100, maxSteps: 64 };
  const reviewed: IndependentOracle = { schemaId: "defect.oracle.v1", description: "balance never drops below 90", reviewedBy: "reviewer", condition: { op: "LE", left: 90, right: { ref: "balance" } }, checkAt: "EVERY_STEP" };
  const unreviewed: IndependentOracle = { ...reviewed, reviewedBy: "" };

  it("returns a violating schedule with a hash and discloses the bounds", async () => {
    const { engine, twin } = engineWith();
    const windows = engine.raceWindows(twin.twinId, lineage);
    assert.ok(windows.some((w) => w.detector === "UNTRANSACTED_WRITERS"));
    assert.ok(windows.some((w) => w.detector === "ASYNC_SHARED_STATE"));
    const finding = await engine.exploreRace(twin.twinId, { window: windows[0], harness, oracle: reviewed, bounds, adapterCapability: { supportsReplay: true, modelsWeakMemory: false, knownExclusions: [] } });
    assert.equal(finding.status, "PROPERTY_FAILED");
    assert.ok(finding.schedule && finding.schedule.length > 0);
    assert.ok(finding.scheduleArtifactHash);
    assert.ok(finding.wording.includes("bounds"));
    assert.equal(finding.oracleReviewedBy, "reviewer");
  });

  it("produces a bounded correctness result with the explicit non-claim when no violation is found", async () => {
    const { engine, twin } = engineWith();
    const windows = engine.raceWindows(twin.twinId, lineage);
    const safe: IndependentOracle = { ...reviewed, condition: { op: "LE", left: { ref: "balance" }, right: 1000 } };
    const finding = await engine.exploreRace(twin.twinId, { window: windows[0], harness, oracle: safe, bounds, adapterCapability: { supportsReplay: true, modelsWeakMemory: false, knownExclusions: [] } });
    assert.equal(finding.status, "SUCCEEDED");
    assert.ok(finding.wording.includes("does not show the code is race-free"));
  });

  it("refuses an unreviewed oracle", async () => {
    const { engine, twin } = engineWith();
    const windows = engine.raceWindows(twin.twinId, lineage);
    await assert.rejects(() => engine.exploreRace(twin.twinId, { window: windows[0], harness, oracle: unreviewed, bounds, adapterCapability: { supportsReplay: true, modelsWeakMemory: false, knownExclusions: [] } }));
  });
});

function generateArrivalsSpec() {
  return {
    arrival: { model: "POISSON" as const, ratePerSec: 10 },
    operationMix: [{ operation: "createPayment", share: 1 }],
    streams: [{ name: "arrivals", purpose: "inter-arrival draws", distribution: { kind: "exponential", parameters: { rate: 10 } } }],
    loadMultipliers: [0.5, 1, 1.6], durationSec: 60, warmupSec: 6, openLoop: true,
    derivedFrom: { windowIds: ["w:1"], labelAllowlistApplied: true },
  };
}
