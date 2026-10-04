// F10 WP-02: the engine's store survives a save/load cycle. A certificate must still be usable after a
// reload, which only holds if the twin/model/fixture/environment hashes round-trip exactly.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { TwinEngine } from "../src/twin-engine.ts";
import { loadTwinStore, saveTwinStore } from "../src/twin-persistence.ts";
import { createDeterministicNativeAdapter } from "../src/twin-native-fake.ts";
import { makeBaselineInput, makeEnvironment, makeStructure, lineage } from "./twin-fixtures.ts";
import type { IndependentOracle, ScheduleBounds, ScheduleHarness } from "../src/defect-schedule.ts";

const comparisonPolicy = { id: "cmp", primaryMetric: "p95" as const, direction: "LOWER" as const, minimumPairs: 3, minimumImprovement: 0.05, confidenceLevel: 0.95, regressionLimits: { errorRate: { direction: "LOWER" as const, maximumRelativeRegression: 0.2 }, completedWorkRate: { direction: "HIGHER" as const, maximumRelativeRegression: 0.1 } } };

describe("F10 WP-02 twin store persistence", () => {
  it("round-trips twins, fixtures, models, certificates, plans and race findings", async () => {
    const disk = new Store(":memory:");
    const engine = new TwinEngine({ adapter: createDeterministicNativeAdapter({}), now: () => 1_000_000, tickMs: 1000 });
    const twin = engine.createTwin({
      workflowId: "wf:createPayment", name: "createPayment", createdBy: "tester",
      snapshot: { repositoryId: "payments-api", revision: "rev-1", sourceHash: "a".repeat(64), buildHash: "b".repeat(64), configHash: "c".repeat(64), dependencyLockHash: "d".repeat(64), dataStateHash: "e".repeat(64) },
      structure: makeStructure(), baseline: makeBaselineInput(), environment: makeEnvironment(), oracleHash: "f".repeat(64),
    });
    engine.buildFixture(twin.twinId, { windowIds: ["w:1"] });
    const fitted = engine.fitModel(twin.twinId, { trainingDatasetIds: ["w:1"], structureCandidates: ["FIXED", "CONTENTION"], policyId: "p1" });
    const validation = await engine.validateInterventionClass(twin.twinId, {
      modelId: fitted.model.modelId, interventionClass: "POOL_CAPACITY",
      heldOut: [{ parameter: "pool", values: [6], loadMultipliers: [1] }], trainingValues: [4, 8, 16], range: { min: 4, max: 16 },
      tolerancePolicyId: "tol-1", issuedBy: "reviewer", comparisonPolicy, criterion: { minPoints: 1, noiseFloor: 0.02, maxMagnitudeError: 0.95, minIntervalCoverage: 0, nominalCoverage: 0.9 },
    });
    assert.ok(validation.certificate);
    const run = await engine.runPairedExperiment(twin.twinId, { modelId: fitted.model.modelId, intervention: { class: "POOL_CAPACITY", parameters: { pool: 12 } }, loadMultiplier: 1, repetitions: 3, comparisonPolicy });
    assert.ok(engine.store.plans.has(run.plan.planId));

    const harness: ScheduleHarness = { schemaId: "defect.schedule.v1", initial: { balance: 100 }, tasks: [{ id: "A", instructions: [{ op: "SET", target: "balance", value: { op: "SUB", left: { ref: "balance" }, right: 20 } }] }] };
    const bounds: ScheduleBounds = { maxSchedules: 50, maxSteps: 32 };
    const oracle: IndependentOracle = { schemaId: "defect.oracle.v1", description: "bounded", reviewedBy: "reviewer", condition: { op: "LE", left: 90, right: { ref: "balance" } }, checkAt: "EVERY_STEP" };
    const windows = engine.raceWindows(twin.twinId, lineage);
    const finding = await engine.exploreRace(twin.twinId, { window: windows[0], harness, oracle, bounds, adapterCapability: { supportsReplay: true, modelsWeakMemory: false, knownExclusions: [] } });

    saveTwinStore(disk.db, engine.store);
    const loaded = loadTwinStore(disk.db);

    assert.deepEqual([...loaded.twins.keys()].sort(), [...engine.store.twins.keys()].sort());
    assert.deepEqual([...loaded.fixtures.keys()].sort(), [...engine.store.fixtures.keys()].sort());
    assert.deepEqual([...loaded.environments.keys()].sort(), [...engine.store.environments.keys()].sort());
    assert.deepEqual([...loaded.models.keys()].sort(), [...engine.store.models.keys()].sort());
    assert.deepEqual([...loaded.certificates.keys()].sort(), [...engine.store.certificates.keys()].sort());
    assert.deepEqual([...loaded.calibrations.keys()].sort(), [...engine.store.calibrations.keys()].sort());
    assert.deepEqual([...loaded.plans.keys()].sort(), [...engine.store.plans.keys()].sort());
    assert.deepEqual([...loaded.races.keys()].sort(), [...engine.store.races.keys()].sort());
    assert.equal(loaded.predictions.all().length, engine.store.predictions.all().length);
    assert.deepEqual(loaded.races.get(finding.explorationId), finding, "race finding round-trips exactly");
    assert.deepEqual(loaded.plans.get(run.plan.planId), run.plan, "experiment plan and cells round-trip exactly");

    // A reloaded certificate must still bind: the hashes it rests on survived.
    const reloaded = new TwinEngine({ store: loaded });
    assert.equal(reloaded.getCertificate(validation.certificate!.certificateId).state, "VALID");
    const decision = reloaded.checkApplicability(twin.twinId, { intervention: { class: "POOL_CAPACITY", parameters: { pool: 12 } }, workload: { arrivalModel: "POISSON", rateMultiplier: 1 }, metrics: ["p95"] });
    assert.equal(decision.verdict, "IN_DOMAIN");
    assert.equal(decision.allowedClass, "VALIDATED_MODEL_PREDICTION");

    // And a second save is idempotent.
    saveTwinStore(disk.db, loaded);
    const again = loadTwinStore(disk.db);
    assert.deepEqual([...again.twins.keys()].sort(), [...loaded.twins.keys()].sort());
    assert.equal((disk.db.prepare("select count(*) n from twin_run_cells").get() as { n: number }).n, run.plan.cells.length);
    disk.db.close();
  });
});
