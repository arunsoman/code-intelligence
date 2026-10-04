import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetectorFinding, ExperimentSpec } from "@cie/schema";
import { DEFECT_SCHEMAS, RunManifestSchema } from "@cie/schema";
import { Store } from "../src/store.ts";
import { DefectWorkflow } from "../src/defect-workflow.ts";
import { artifactHash, exploreSchedules, type IndependentOracle, type ScheduleHarness } from "../src/defect-schedule.ts";
import { comparePairedBenchmarks, type BenchmarkTrial, type ComparisonPolicy } from "../src/defect-benchmark.ts";
import { analyzeWaits, computeExclusiveCosts, reconstructCriticalPath, type TimedSpan } from "../src/defect-performance.ts";
import { detectMemoryRaces } from "../src/defects.ts";
import { ctx } from "./helpers.ts";

const read = (ref: string) => ({ ref });
const buggy: ScheduleHarness = {
  schemaId: "defect.schedule.v1", initial: { balance: 0, a: 0, b: 0 },
  tasks: ["a", "b"].map((id) => ({ id, instructions: [
    { op: "SET", target: id, value: read("balance") }, { op: "AWAIT" },
    { op: "SET", target: "balance", value: { op: "ADD", left: read(id), right: 1 } },
  ] })),
};
const fixed: ScheduleHarness = {
  ...buggy, tasks: ["a", "b"].map((id) => ({ id, instructions: [
    { op: "AWAIT" }, { op: "SET", target: "balance", value: { op: "ADD", left: read("balance"), right: 1 } },
  ] })),
};
const oracle: IndependentOracle = { schemaId: "defect.oracle.v1", description: "Both completed increments must be retained", reviewedBy: "fixture-reviewer", condition: { op: "EQ", left: read("balance"), right: 2 }, checkAt: "COMPLETION" };
const bounds = { maxSchedules: 100, maxSteps: 20 };

test("DP04/12: async lost update reproduces, replays, and the fixed model preserves the original oracle", async () => {
  const base = await exploreSchedules(buggy, oracle, bounds);
  assert.equal(base.status, "PROPERTY_FAILED");
  assert.equal(base.state!.balance, 1);
  const replay = await exploreSchedules(buggy, oracle, bounds, { replay: base.schedule! });
  assert.deepEqual(replay.schedule, base.schedule);
  assert.equal(replay.status, "PROPERTY_FAILED");
  const candidate = await exploreSchedules(fixed, oracle, bounds, { replay: base.schedule! });
  assert.equal(candidate.status, "SUCCEEDED");
  assert.equal(candidate.oracleHash, base.oracleHash);
  const broad = await exploreSchedules(fixed, oracle, bounds);
  assert.equal(broad.completedSearch, true);
  assert.ok(broad.exploredSchedules > 1);
  assert.equal(broad.status, "SUCCEEDED");
});

test("DP20: incomplete bounds and cancellation never produce an exhaustive success", async () => {
  const limited = await exploreSchedules(fixed, oracle, { maxSchedules: 1, maxSteps: 20 });
  assert.equal(limited.status, "BUDGET_STOPPED");
  assert.equal(limited.completedSearch, false);
  const signal = new AbortController(); signal.abort();
  assert.equal((await exploreSchedules(fixed, oracle, bounds, { signal: signal.signal })).status, "CANCELLED");
  await assert.rejects(exploreSchedules(fixed, { ...oracle, reviewedBy: "" }, bounds));
  await assert.rejects(exploreSchedules(fixed, oracle, bounds, { replay: ["not-a-task"] }));
});

test("DP03: transitive synchronization suppresses a race and mixed atomic accesses do not", () => {
  const common = { accessPath: "balance", mode: "WRITE" as const, atomic: false, evidenceIds: ["ev"], aliasState: "RESOLVED" as const };
  const a = { ...common, id: "a", entityId: "one", contextId: "one", concurrentWith: ["two"], happensBefore: ["middle"] };
  const middle = { ...common, id: "middle", entityId: "sync", contextId: "one", concurrentWith: [], happensBefore: ["b"] };
  const b = { ...common, id: "b", entityId: "two", contextId: "two", concurrentWith: ["one"], happensBefore: [] };
  assert.equal(detectMemoryRaces("rev", [a, middle, b]).filter((f) => f.entityIds.includes("one")).length, 0);
  assert.equal(detectMemoryRaces("rev", [{ ...a, happensBefore: [] }, { ...b, atomic: true }]).length, 1);
});

test("DP07/11: duplicate and overlapping spans do not multiply costs; clock uncertainty is recorded", () => {
  const span = (id: string, startMs: number, endMs: number, parentId: string | null): TimedSpan => ({ id, startMs, endMs, parentId, entityId: "e", revision: "r", buildHash: "b", workloadHash: "w", clock: "one", category: "CPU" });
  const root = span("root", 0, 100, null), a = span("a", 10, 70, "root"), b = span("b", 50, 90, "root");
  assert.equal(computeExclusiveCosts([root, a, b, a]).spans.find((s) => s.id === "root")!.exclusiveMs, 20);
  assert.match(computeExclusiveCosts([root, { ...a, clock: "two" }]).spans.find((s) => s.id === "root")!.gaps.join(" "), /clock/);
  assert.throws(() => computeExclusiveCosts([root, { ...root, endMs: 99 }]), /duplicate/);
  const critical = reconstructCriticalPath([{ id: "a", durationMs: 5 }, { id: "b", durationMs: 20 }, { id: "c", durationMs: 10 }, { id: "d", durationMs: 3 }], [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]);
  assert.deepEqual(critical.path, ["a", "b", "d"]); assert.equal(critical.durationMs, 28);
});

test("DP02: a consistent wait cycle records timeout escapes and multiple-resource limitations", () => {
  const snapshot = { captureId: "capture", revision: "r", stable: true, resources: [{ id: "L1", instances: 1, owners: ["a"] }, { id: "L2", instances: 1, owners: ["b"] }], waits: [{ taskId: "a", resourceId: "L2", blocking: true, escapes: [] }, { taskId: "b", resourceId: "L1", blocking: true, escapes: [] }] };
  assert.equal(analyzeWaits(snapshot).cycles[0].assessment, "STABLE_BLOCKING_CYCLE");
  assert.equal(analyzeWaits({ ...snapshot, waits: [{ ...snapshot.waits[0], escapes: ["TIMEOUT"] }, snapshot.waits[1]] }).cycles[0].assessment, "POTENTIAL_WAIT_CYCLE");
  assert.match(analyzeWaits({ ...snapshot, resources: [{ ...snapshot.resources[0], instances: 2 }, snapshot.resources[1]] }).gaps.join(" "), /multiple-instance/);
});

const policy: ComparisonPolicy = { id: "p", primaryMetric: "p95", direction: "LOWER", minimumPairs: 6, minimumImprovement: 0.05, confidenceLevel: 0.95, regressionLimits: { errors: { direction: "LOWER", maximumRelativeRegression: 0 }, memory: { direction: "LOWER", maximumRelativeRegression: 0.05 }, p99: { direction: "LOWER", maximumRelativeRegression: 0.05 } } };
const trials = (side: string, times: number[], extra: Partial<BenchmarkTrial> = {}): BenchmarkTrial[] => times.map((p95, i) => ({ runId: `${side}-${i}`, pairId: `${i}`, workloadHash: artifactHash("w"), environmentHash: artifactHash("e"), oracleHash: artifactHash("o"), buildSettingsHash: artifactHash("b"), instrumented: false, correctnessPassed: true, metrics: { p95, p99: 200, memory: 100, errors: 0 }, ...extra }));
test("DP13: paired uncertainty, tail/error regression and mismatched workloads control benchmark verdicts", () => {
  const b = trials("b", [100, 100, 100, 100, 100, 100]);
  const c = trials("c", [90, 90, 90, 90, 90, 90]);
  assert.equal(comparePairedBenchmarks(b, c, policy).verdict, "IMPROVED");
  assert.equal(comparePairedBenchmarks(b, trials("c", [50, 150, 50, 150, 50, 150]), policy).verdict, "INCONCLUSIVE");
  assert.equal(comparePairedBenchmarks(b, c.map((x) => ({ ...x, metrics: { ...x.metrics, errors: 1 } })), policy).verdict, "REGRESSED");
  assert.equal(comparePairedBenchmarks(b, c.map((x) => ({ ...x, metrics: { ...x.metrics, p99: 250 } })), policy).verdict, "REGRESSED");
  assert.equal(comparePairedBenchmarks(b, c.map((x) => ({ ...x, environmentHash: artifactHash("other") })), policy).verdict, "INCONCLUSIVE");
  assert.equal(comparePairedBenchmarks(b, [...c, c[0]], policy).verdict, "INCONCLUSIVE");
});

function world() {
  const store = new Store(":memory:");
  store.putBatch({ revision: "rev", gitHead: null, repoRoot: "/fixture/defect", analyzerVersion: "test", entities: [], relationships: [], facts: [], diagnostics: [] });
  const workflow = new DefectWorkflow(store);
  const finding: DetectorFinding = { id: "finding", version: 1, kind: "LOGICAL_RACE", revision: "rev", entityIds: [], spans: [], ruleId: "test", ruleVersion: 1, evidenceIds: [], coverageGaps: [], severity: "HIGH", evidenceLevel: "STATIC_CANDIDATE", safetyObligations: [] };
  workflow.recordFinding(ctx(), finding);
  const h = workflow.putArtifact(ctx(), "rev", "harness", buggy);
  const o = workflow.putArtifact(ctx(), "rev", "oracle", oracle);
  const spec: ExperimentSpec = { id: "spec", findingId: finding.id, baselineRevision: "rev", candidateHead: null, adapterId: "cie.async-schedule", adapterVersion: "1", kind: "SCHEDULE_SEARCH", harnessHandle: h.handle, harnessHash: h.hash, oracleSchemaId: o.handle, fixtureHandles: [], fixtureHashes: [], inputs: { schemaId: "defect.inputs.v1", schemaVersion: 1, value: {} }, bounds: { schemaId: "defect.bounds.v1", schemaVersion: 1, value: bounds }, budget: { wallTimeMs: 10000, cpuTimeMs: 10000, memoryBytes: 10000000, processes: 1, readBytes: 1000000, outputBytes: 1000000, cost: "0" }, environmentProfileId: "node", executionGrantId: "grant" };
  workflow.prepareExperiment(ctx(), spec);
  const authorize = () => workflow.provisionGrant({ id: "grant", revision: "rev", principalId: "t", operation: "RUN", specHash: artifactHash(spec), expiresAt: Date.now() + 60000 });
  return { store, workflow, spec, authorize };
}

test("DP12/18: run requires an exact grant, persists an immutable manifest and deduplicates retry", async () => {
  const w = world();
  await assert.rejects(w.workflow.runExperiment(ctx(), "spec", 1), /Grant/);
  w.authorize();
  const command = ctx("run-once");
  const [a, b] = await Promise.all([w.workflow.runExperiment(command, "spec", 1), w.workflow.runExperiment(command, "spec", 1)]);
  assert.equal(a.id, b.id); assert.equal(a.status, "PROPERTY_FAILED");
  assert.ok(RunManifestSchema.safeParse(a).success);
  const retry = await w.workflow.runExperiment(command, "spec", 1);
  assert.deepEqual(retry, a);
  assert.equal(w.workflow.list("rev", "manifest").length, 1);
  const replay = await w.workflow.runExperiment(ctx(), "spec", 1, { manifestId: a.id, expectedSourceHash: a.sourceHash });
  assert.equal(replay.status, "PROPERTY_FAILED");
  assert.equal(replay.oracleHash, a.oracleHash);
  await assert.rejects(w.workflow.runExperiment(ctx(), "spec", 1, { manifestId: a.id, expectedSourceHash: artifactHash("other") }), /Replay/);
  w.workflow.revokeGrant("grant");
  await assert.rejects(w.workflow.runExperiment(ctx(), "spec", 1), /revoked/);
  w.store.db.close();
});

test("DP14/18: executable-looking model operations are rejected and artifacts cascade with their revision", () => {
  const w = world();
  assert.throws(() => w.workflow.prepareExperiment(ctx(), { ...w.spec, adapterId: "shell" }), /installed adapter/);
  assert.equal(DEFECT_SCHEMAS["defect.v1.experimentSpec"].safeParse({ ...w.spec, shell: "echo surprise" }).success, false);
  w.store.db.prepare("delete from revisions where id = ?").run("rev");
  for (const table of ["defect_records", "defect_outbox", "defect_commands", "defect_attempts", "defect_grants"]) assert.equal((w.store.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n, 0);
  assert.throws(() => w.workflow.get("finding"), /not found/);
  w.store.db.close();
});
