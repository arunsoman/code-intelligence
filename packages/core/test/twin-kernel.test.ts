// F10-D2 — discrete-event kernel invariants: monotonic time, deterministic ties, ownership-consistent
// release, bounded queues and events. Plus generator-validity and outcomes/trial-metric rules.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TwinModelSpec } from "@cie/schema";
import { sampleServiceTime, simulate, validateModelSpec } from "../src/twin-kernel.ts";
import { checkGeneratorValidity, enforcePopulationRules, metricsFromOutcomes } from "../src/twin-experiment.ts";
import type { OutcomesArtifact, OutcomesRecord } from "@cie/schema";

const spec = (over: Partial<TwinModelSpec> = {}): TwinModelSpec => ({
  schemaId: "workflow.twin.model.v1", entryStationId: "api",
  stations: [
    { id: "api", name: "api", resourceId: null, service: { kind: "FIXED", ms: 2 }, routing: [{ to: "db", probability: 1 }] },
    { id: "db", name: "db", resourceId: "pool", service: { kind: "FIXED", ms: 10 }, routing: [] },
  ],
  resources: [{ id: "pool", kind: "POOL", capacity: 2, queuePolicy: "FIFO", queueLimit: 1000 }],
  rng: "sha256-keyed/v1", tieComparator: "sequence/v1", faults: [],
  ...over,
});
const arrivals = (n: number, gapMs = 5) => Array.from({ length: n }, (_, i) => ({ requestId: `r${i}`, atMs: i * gapMs, operation: "op", attributes: {} }));

describe("F10-D2 kernel invariants", () => {
  it("is deterministic: the same seed and arrivals give the same result", () => {
    const a = simulate(spec(), arrivals(40), { seed: "s1", maxEvents: 100000, maxSimTimeMs: 1_000_000 });
    const b = simulate(spec(), arrivals(40), { seed: "s1", maxEvents: 100000, maxSimTimeMs: 1_000_000 });
    assert.deepEqual(a.perRequest, b.perRequest);
    assert.equal(a.completed, b.completed);
    assert.equal(a.p95, b.p95);
  });

  it("respects resource capacity and never exceeds utilisation 1", () => {
    const result = simulate(spec(), arrivals(200, 3), { seed: "s2", maxEvents: 500000, maxSimTimeMs: 1_000_000 });
    assert.ok(result.utilisation["pool"] <= 1 + 1e-9, `utilisation ${result.utilisation["pool"]}`);
    assert.ok(result.peakQueue["pool"] <= 1000);
  });

  it("bounds a full queue and reports it, never silently", () => {
    const result = simulate(spec({ resources: [{ id: "pool", kind: "POOL", capacity: 1, queuePolicy: "FIFO", queueLimit: 2 }] }), arrivals(50, 1), { seed: "s3", maxEvents: 100000, maxSimTimeMs: 1_000_000 });
    assert.equal(result.bounded.queueExhausted, true);
    assert.ok(result.dropped > 0);
    assert.equal(result.errorRate > 0, true);
  });

  it("reports event-budget exhaustion rather than pretending success", () => {
    const result = simulate(spec(), arrivals(200, 1), { seed: "s4", maxEvents: 10, maxSimTimeMs: 1_000_000 });
    assert.equal(result.bounded.eventsExhausted, true);
    assert.ok(result.completedWorkRate < 1);
  });

  it("sampleServiceTime is deterministic given the same draw", () => {
    const rng = () => 0.5;
    assert.equal(sampleServiceTime({ kind: "EXPONENTIAL", meanMs: 10 }, 1, rng), sampleServiceTime({ kind: "EXPONENTIAL", meanMs: 10 }, 1, rng));
    assert.equal(sampleServiceTime({ kind: "FIXED", ms: 7 }, 1, rng), 7);
    assert.ok(sampleServiceTime({ kind: "CONTENTION", baseMeanMs: 10, factor: 0.5, exponent: 1 }, 3, rng) > 10);
  });

  it("validateModelSpec rejects unknown stations and resources", () => {
    assert.deepEqual(validateModelSpec(spec()), []);
    assert.ok(validateModelSpec(spec({ entryStationId: "nope" })).some((p) => p.includes("entry")));
    assert.ok(validateModelSpec(spec({ stations: [{ id: "api", name: "api", resourceId: "missing", service: { kind: "FIXED", ms: 1 }, routing: [] }] })).some((p) => p.includes("unknown resource")));
  });
});

describe("F10-A4 outcomes and population rules", () => {
  const record = (over: Partial<OutcomesRecord>): OutcomesRecord => ({ requestId: "r", operation: "op", intendedAtMs: 0, sentAtMs: 0, completedAtMs: 10, outcome: "SUCCESS", retryCount: 0, intendedLatencyMs: 10, observedLatencyMs: 10, generatorDelayMs: 0, correctnessPassed: true, instrumented: false, ...over });
  const artifact = (records: OutcomesRecord[]): OutcomesArtifact => ({ hash: "h", role: "TWIN_CANDIDATE", buildHash: "b", environmentHash: "e", workloadHash: "w", oracleHash: "o", scheduledRatePerSec: 100, achievedRatePerSec: 100, generatorSaturated: false, coordinatedOmissionDetected: false, instrumentationPresent: false, records });

  it("keeps failures and timeouts in the all-requests latency and completed-work rate", () => {
    const records = [...Array.from({ length: 100 }, (_, i) => record({ requestId: `s${i}`, intendedLatencyMs: 50 })), ...Array.from({ length: 15 }, (_, i) => record({ requestId: `t${i}`, outcome: "TIMEOUT", intendedLatencyMs: 900 }))];
    const m = metricsFromOutcomes(artifact(records), { durationSec: 10 });
    assert.ok(m.completedWorkRate < 0.9, `completedWorkRate ${m.completedWorkRate}`);
    assert.ok(m.errorRate > 0.1);
    assert.ok(m.allRequestsP95 > m.successOnlyP95);
  });

  it("rejects a generator that saturated, omitted, or was instrumented", () => {
    const saturated = { ...artifact([]), achievedRatePerSec: 50 };
    assert.ok(checkGeneratorValidity(saturated, { environmentHash: "e", buildHash: "b", workloadHash: "w", oracleHash: "o" }).some((p) => p.problem === "SATURATED"));
    const instrumented = { ...artifact([]), instrumentationPresent: true };
    assert.ok(checkGeneratorValidity(instrumented, { environmentHash: "e", buildHash: "b", workloadHash: "w", oracleHash: "o" }).some((p) => p.problem === "INSTRUMENTED"));
    const mismatched = { ...artifact([]), environmentHash: "other" };
    assert.ok(checkGeneratorValidity(mismatched, { environmentHash: "e", buildHash: "b", workloadHash: "w", oracleHash: "o" }).some((p) => p.problem === "HASH_MISMATCH"));
  });

  it("a candidate that completes less work is not IMPROVED", () => {
    const baseline = metricsFromOutcomes(artifact(Array.from({ length: 100 }, (_, i) => record({ requestId: `s${i}` }))), { durationSec: 10 });
    const candidate = metricsFromOutcomes(artifact([...Array.from({ length: 80 }, (_, i) => record({ requestId: `s${i}` })), ...Array.from({ length: 20 }, (_, i) => record({ requestId: `t${i}`, outcome: "TIMEOUT" }))]), { durationSec: 10 });
    const rule = enforcePopulationRules(baseline, candidate, { errorRateDelta: 0.02, completedWorkDelta: 0.005 });
    assert.notEqual(rule.verdict, "OK");
  });
});
