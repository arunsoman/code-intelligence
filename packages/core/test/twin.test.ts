// F10 design-level and acceptance checks for the pure twin rules:
//  - applicability / domain gating (F10-A3)
//  - result-class enforcement in two places (F10-A6)
//  - comparison policy must retain failures (F10-A4)
//  - holdout acceptance and certificate gating (F10-A2)
//  - binding invalidation (F10-A5)
//  - event-keyed streams (F10-D1)
//  - demand/wait double counting (F10-D3)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApplicabilityRequest, EnvironmentSpec, GateResult, HeldOutIntervention, ValidationCertificate, WorkloadSpec } from "@cie/schema";
import {
  allCertificateGatesPass, canIssueCertificate, certificateBindingMatches, checkApplicability,
  computeBindingHash, computeTwinHash, deriveAllowedClass, evaluateHoldout, eventKeyedDraws,
  eventKeyedInt, eventKeyedRandom, findDemandWaitDoubleCounting, materialUnresolvedStations,
  validateComparisonPolicy, validateEnvironmentSpec, validateWorkloadSpec, verifyResultClass,
  type ComparisonPolicyLike,
} from "../src/twin.ts";

const hash = (c: string) => c.repeat(64).slice(0, 64);

function certificate(over: Partial<ValidationCertificate> = {}): ValidationCertificate {
  return {
    certificateId: "vc-1", twinId: "twin-1", twinVersion: 1, modelId: "model-1",
    bindingHash: hash("a"),
    scope: {
      metrics: ["p95", "throughput", "errorRate"],
      interventionClass: "POOL_CAPACITY",
      ranges: [{ parameter: "pool", min: 4, max: 16 }],
      workload: { arrivalModel: "POISSON", rateMultiplier: { min: 0.5, max: 1.6 }, mixTolerance: 0.05 },
      environmentClass: { environmentHash: hash("b"), allowedDifferences: [] },
      assumptionsChecked: [{ id: "db-latency", statement: "DB latency does not degrade with concurrency", checkedRange: [0, 16], evidenceIds: ["ev-1"] }],
      materialUnresolved: [],
    },
    validation: {
      gates: [],
      heldOutInterventions: [],
      intervalCoverage: { nominal: 0.9, observed: 0.8, trials: 5 },
    },
    state: "VALID", issuedAt: "2026-10-04T00:00:00.000Z", issuedBy: "reviewer",
    ...over,
  };
}

function request(over: Partial<ApplicabilityRequest> = {}): ApplicabilityRequest {
  return {
    intervention: { class: "POOL_CAPACITY", parameters: { pool: 12 } },
    workload: { arrivalModel: "POISSON", rateMultiplier: 1.4 },
    metrics: ["p95"],
    environmentHash: hash("b"),
    assumptions: [{ id: "db-latency", value: 12 }],
    ...over,
  };
}

const gates = (passed = true): GateResult[] => (["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"] as GateResult["gate"][]).map((gate) => ({ gate, passed, detail: "", evidenceIds: [] }));

describe("F10-A3 out-of-domain requests are blocked or explicitly exploratory", () => {
  it("returns IN_DOMAIN with the validated class inside the certified range", () => {
    const d = checkApplicability(certificate(), hash("a"), request());
    assert.equal(d.verdict, "IN_DOMAIN");
    assert.equal(d.allowedClass, "VALIDATED_MODEL_PREDICTION");
    assert.equal(d.blocked, false);
  });

  it("blocks a pool beyond the validated range and names the violated range", () => {
    const d = checkApplicability(certificate(), hash("a"), request({ intervention: { class: "POOL_CAPACITY", parameters: { pool: 64 } }, workload: { arrivalModel: "POISSON", rateMultiplier: 2.5 } }));
    assert.equal(d.verdict, "OUT_OF_DOMAIN");
    assert.equal(d.allowedClass, null);
    assert.equal(d.blocked, true);
    assert.ok(d.violatedRanges.some((v) => v.includes("pool=64") && v.includes("4–16")));
    assert.ok(d.violatedRanges.some((v) => v.includes("2.5×")));
  });

  it("the exploratory path yields MODEL_PREDICTION and never the validated class", () => {
    const d = checkApplicability(certificate(), hash("a"), request({ intervention: { class: "POOL_CAPACITY", parameters: { pool: 64 } } }), { exploratory: true });
    assert.equal(d.verdict, "OUT_OF_DOMAIN");
    assert.equal(d.allowedClass, "MODEL_PREDICTION");
    assert.equal(d.blocked, false);
    assert.notEqual(d.allowedClass, "VALIDATED_MODEL_PREDICTION");
  });
});

describe("F10-A6 unsupported predictions never carry VALIDATED_MODEL_PREDICTION", () => {
  it("(i) no certificate: only MODEL_PREDICTION when exploratory", () => {
    const blocked = checkApplicability(null, hash("a"), request());
    assert.equal(blocked.allowedClass, null);
    const exploratory = checkApplicability(null, hash("a"), request(), { exploratory: true });
    assert.equal(exploratory.allowedClass, "MODEL_PREDICTION");
    assert.equal(exploratory.verdict, "INSUFFICIENT_EVIDENCE");
  });

  it("(ii) a stale certificate refuses the validated class", () => {
    const d = checkApplicability(certificate({ state: "STALE", invalidationReason: "source changed" }), hash("a"), request());
    assert.equal(d.verdict, "INSUFFICIENT_EVIDENCE");
    assert.equal(d.allowedClass, null);
    assert.ok(d.reasons.some((r) => r.includes("STALE")));
  });

  it("(iii) an uncertified metric (p99) is out of domain", () => {
    const d = checkApplicability(certificate(), hash("a"), request({ metrics: ["p99"] }));
    assert.equal(d.verdict, "INSUFFICIENT_EVIDENCE");
    assert.ok(d.reasons.some((r) => r.includes("p99")));
  });

  it("(iv) an uncertified intervention class is refused", () => {
    const d = checkApplicability(certificate(), hash("a"), request({ intervention: { class: "WORKER_CONCURRENCY", parameters: { pool: 12 } } }));
    assert.equal(d.verdict, "INSUFFICIENT_EVIDENCE");
    assert.ok(d.reasons.some((r) => r.includes("WORKER_CONCURRENCY")));
  });

  it("(v) C16 re-derivation rejects a tampered stored class", () => {
    const derived = deriveAllowedClass({ certificateState: "VALID", bindingMatches: false, verdict: "OUT_OF_DOMAIN", exploratory: false, executableModel: true });
    assert.equal(derived, null);
    const check = verifyResultClass("VALIDATED_MODEL_PREDICTION", derived);
    assert.equal(check.ok, false);
    assert.ok(check.reason?.includes("VALIDATED_MODEL_PREDICTION"));
    // the honest path
    const good = deriveAllowedClass({ certificateState: "VALID", bindingMatches: true, verdict: "IN_DOMAIN", exploratory: false, executableModel: true });
    assert.equal(good, "VALIDATED_MODEL_PREDICTION");
    assert.equal(verifyResultClass("VALIDATED_MODEL_PREDICTION", good).ok, true);
  });
});

describe("F10-A5 a changed bound input invalidates the certificate", () => {
  it("binding mismatch marks the certificate unusable and refuses the validated class", () => {
    const cert = certificate();
    const changed = hash("c");
    assert.equal(certificateBindingMatches(cert, changed), false);
    const d = checkApplicability(cert, changed, request());
    assert.equal(d.verdict, "INSUFFICIENT_EVIDENCE");
    assert.equal(d.allowedClass, null);
  });

  it("binding hash is sensitive to every bound input", () => {
    const base = computeBindingHash({ twinHash: hash("1"), modelSpecHash: hash("2"), fitHash: hash("3"), workloadHashes: [hash("4")], environmentHash: hash("5"), oracleHash: hash("6"), sourceHash: hash("7"), buildHash: hash("8"), policyIds: ["p1"] });
    const changed = computeBindingHash({ twinHash: hash("1"), modelSpecHash: hash("2"), fitHash: hash("3"), workloadHashes: [hash("4")], environmentHash: hash("9"), oracleHash: hash("6"), sourceHash: hash("7"), buildHash: hash("8"), policyIds: ["p1"] });
    assert.notEqual(base, changed);
  });
});

describe("F10-A4 comparison policy keeps failures in the population", () => {
  const policy = (over: Partial<ComparisonPolicyLike> = {}): ComparisonPolicyLike => ({
    id: "p", primaryMetric: "p95", direction: "LOWER", minimumPairs: 3, minimumImprovement: 0.05, confidenceLevel: 0.95,
    regressionLimits: { errorRate: { direction: "LOWER", maximumRelativeRegression: 0.2 }, completedWorkRate: { direction: "HIGHER", maximumRelativeRegression: 0.1 } },
    ...over,
  });

  it("accepts a policy that includes errorRate and completedWorkRate", () => {
    assert.equal(validateComparisonPolicy(policy()).ok, true);
  });

  it("rejects a policy omitting errorRate and completedWorkRate", () => {
    const result = validateComparisonPolicy(policy({ regressionLimits: { p95: { direction: "LOWER", maximumRelativeRegression: 0.1 } } }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes("errorRate")));
      assert.ok(result.errors.some((e) => e.includes("completedWorkRate")));
    }
  });
});

describe("F10-A2 holdout acceptance and certificate gating", () => {
  const interval = (mid: number, half: number) => ({ lower: mid - half, upper: mid + half, method: "bootstrap", confidenceLevel: 0.9 });
  const point = (over: Partial<HeldOutIntervention> = {}): HeldOutIntervention => ({
    parameter: "pool", value: 6, loadMultiplier: 1,
    predictedDelta: interval(-0.24, 0.06), measuredDelta: interval(-0.21, 0.04),
    directionAgrees: true, withinTolerance: true,
    predictionRecordHash: hash("e"), predictionRecordedAt: "2026-10-04T00:00:00.000Z",
    ...over,
  });

  it("passes when direction, magnitude and coverage criteria hold", () => {
    const report = evaluateHoldout([point({ value: 6 }), point({ value: 12, predictedDelta: interval(0, 0.01), measuredDelta: interval(0, 0.01) }), point({ value: 1, predictedDelta: interval(0.2, 0.05), measuredDelta: interval(0.19, 0.04) })]);
    assert.equal(report.passes, true);
    assert.ok(report.coverage.observed >= 0.8);
  });

  it("a deliberately wrong structure (direction disagrees) fails", () => {
    const report = evaluateHoldout([point({ directionAgrees: false }), point({ value: 12, directionAgrees: false }), point({ value: 1 })]);
    assert.equal(report.passes, false);
    assert.ok(report.failures.some((f) => f.includes("direction")));
  });

  it("too few held-out points fails", () => {
    const report = evaluateHoldout([point()]);
    assert.equal(report.passes, false);
    assert.ok(report.failures.some((f) => f.includes("at least")));
  });

  it("a certificate can be issued only from passing required gates and a passing holdout", () => {
    const good = evaluateHoldout([point(), point({ value: 12, predictedDelta: interval(0, 0.01), measuredDelta: interval(0, 0.01) }), point({ value: 1, predictedDelta: interval(0.2, 0.05), measuredDelta: interval(0.19, 0.04) })]);
    assert.equal(canIssueCertificate(gates(true), good).ok, true);
    assert.equal(canIssueCertificate(gates(true).map((g) => (g.gate === "G4" ? { ...g, passed: false } : g)), good).ok, false);
    assert.equal(allCertificateGatesPass(gates(false)), false);
  });
});

describe("F10-D1 event-keyed streams are order independent", () => {
  it("adding an internal draw does not change existing arrivals or attributes", () => {
    const first = eventKeyedDraws("seed-1", "arrivals", "req-42", ["interarrival", "operation", "payloadSize"]);
    const second = eventKeyedDraws("seed-1", "arrivals", "req-42", ["interarrival", "operation", "payloadSize", "newInternalCall"]);
    assert.equal(first.interarrival, second.interarrival);
    assert.equal(first.operation, second.operation);
    assert.equal(first.payloadSize, second.payloadSize);
  });

  it("different requests and purposes get different draws", () => {
    assert.notEqual(eventKeyedRandom("s", "a", "r1", "x"), eventKeyedRandom("s", "a", "r2", "x"));
    assert.notEqual(eventKeyedRandom("s", "a", "r1", "x"), eventKeyedRandom("s", "a", "r1", "y"));
  });

  it("keyed integers are deterministic and inside the range", () => {
    for (let i = 0; i < 50; i++) {
      const v = eventKeyedInt("s", "a", `r${i}`, "bucket", 0, 4);
      assert.ok(v >= 0 && v <= 4 && Number.isSafeInteger(v));
    }
    assert.equal(eventKeyedInt("s", "a", "r1", "bucket", 0, 4), eventKeyedInt("s", "a", "r1", "bucket", 0, 4));
  });
});

describe("F10-D3 demand/wait double counting is detected", () => {
  it("flags a station whose service time already includes wait and which also has a modelled queue", () => {
    const flagged = findDemandWaitDoubleCounting([
      { stationId: "ledger.reserve", serviceTimeIncludesWait: true, hasModelledQueue: true },
      { stationId: "fraud.check", serviceTimeIncludesWait: false, hasModelledQueue: true },
    ]);
    assert.deepEqual(flagged, ["ledger.reserve"]);
  });
});

describe("structure and spec validation", () => {
  const workload = (over: Partial<WorkloadSpec> = {}): WorkloadSpec => ({
    arrival: { model: "POISSON", ratePerSec: 120 },
    operationMix: [{ operation: "createPayment", share: 1 }],
    streams: [{ name: "arrivals", purpose: "inter-arrival draws", distribution: { kind: "exponential", parameters: { rate: 120 } } }],
    loadMultipliers: [0.5, 1, 1.6], durationSec: 540, warmupSec: 60, openLoop: true,
    derivedFrom: { windowIds: ["w1"], labelAllowlistApplied: true },
    ...over,
  });

  it("accepts a well-formed open-loop fixture", () => {
    assert.deepEqual(validateWorkloadSpec(workload()), []);
  });

  it("rejects a closed-loop fixture for capacity inference", () => {
    const problems = validateWorkloadSpec(workload({ openLoop: false }));
    assert.ok(problems.some((p) => p.path === "openLoop"));
  });

  it("rejects operation shares that do not sum to 1", () => {
    const problems = validateWorkloadSpec(workload({ operationMix: [{ operation: "a", share: 0.5 }, { operation: "b", share: 0.4 }] }));
    assert.ok(problems.some((p) => p.path === "operationMix"));
  });

  it("rejects a fixture derived from traces without the label allowlist", () => {
    const problems = validateWorkloadSpec(workload({ derivedFrom: { windowIds: ["w1"], labelAllowlistApplied: false } }));
    assert.ok(problems.some((p) => p.path === "derivedFrom.labelAllowlistApplied"));
  });

  it("rejects an invalid environment specification", () => {
    const env: EnvironmentSpec = { platform: "linux", runtimeVersion: "node-24", cores: 0, memoryBytes: 0, isolationProfile: "", clockModel: "monotonic", cachePolicy: "COLD", resetPolicy: "restart", poolSizes: { db: -1 }, permittedNetworkTargets: [], weakMemoryModel: false };
    const problems = validateEnvironmentSpec(env);
    assert.ok(problems.length >= 3);
  });

  it("material unresolved stations restrict the domain (on or flagged)", () => {
    const material = materialUnresolvedStations({ entryStationId: "e", stations: [], resources: [], branches: [], externals: [], unresolved: [{ id: "u1", description: "dynamic dispatch", material: true }, { id: "u2", description: "minor", material: false }] }, ["u2"]);
    assert.deepEqual(material.sort(), ["u1", "u2"]);
  });
});

describe("twin hash binds the whole snapshot", () => {
  const snapshot = { repositoryId: "payments-api", revision: "r1", sourceHash: hash("1"), buildHash: hash("2"), configHash: hash("3"), dependencyLockHash: hash("4"), dataStateHash: hash("5") };
  it("is deterministic and order-independent for baseline evidence", () => {
    const a = computeTwinHash({ snapshot, structureHash: hash("6"), baselineEvidenceIds: ["b", "a"], workloadHash: hash("7"), environmentHash: hash("8"), modelSpecHash: hash("9"), oracleHash: hash("d") });
    const b = computeTwinHash({ snapshot, structureHash: hash("6"), baselineEvidenceIds: ["a", "b"], workloadHash: hash("7"), environmentHash: hash("8"), modelSpecHash: hash("9"), oracleHash: hash("d") });
    assert.equal(a, b);
  });
  it("changes when the source changes", () => {
    const a = computeTwinHash({ snapshot, structureHash: hash("6"), baselineEvidenceIds: [], workloadHash: hash("7"), environmentHash: hash("8"), modelSpecHash: hash("9"), oracleHash: hash("d") });
    const b = computeTwinHash({ snapshot: { ...snapshot, sourceHash: hash("f") }, structureHash: hash("6"), baselineEvidenceIds: [], workloadHash: hash("7"), environmentHash: hash("8"), modelSpecHash: hash("9"), oracleHash: hash("d") });
    assert.notEqual(a, b);
  });
});
