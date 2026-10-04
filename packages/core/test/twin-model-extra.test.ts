// F10-D4 (resampling preserves structure), F10-D6 (structure selection), and the baseline/calibration
// diagnostics that justify the fitted arrival model and the chosen structure.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RequestRecord, WorkloadSpec } from "@cie/schema";
import { buildObservedBaseline, fitArrivalModel, resampleRequestRecords, sizeDemandCorrelation } from "../src/twin-baseline.ts";
import { fitParameters, modelError, modelSpecFromBaseline, structureCandidates } from "../src/twin-model.ts";
import { generateArrivals } from "../src/twin-workload.ts";
import { simulate } from "../src/twin-kernel.ts";
import { makeBaselineInput, makeEnvironment, makeStructure } from "./twin-fixtures.ts";

const record = (sizeBucket: number, demand: number): RequestRecord => ({ operation: "op", payloadSizeBucket: sizeBucket, keyClass: "k", demands: { svc: demand }, waits: {}, outcome: "SUCCESS", retryCount: 0, censored: false });

describe("F10-D4 resampling a request population", () => {
  it("preserves the size-to-demand correlation by resampling whole records", () => {
    const records = Array.from({ length: 200 }, (_, i) => record(i % 5, (i % 5) * 25 + 5));
    const before = sizeDemandCorrelation(records);
    const after = sizeDemandCorrelation(resampleRequestRecords(records, 800, "seed-a"));
    assert.ok(before > 0.98, `before ${before}`);
    assert.ok(after > 0.98, `after ${after}`);
  });
});

describe("F10-D6 structure selection under load", () => {
  it("prefers the contention structure over a constant service time when the observed tail is inflated", () => {
    const structure = makeStructure();
    const env = makeEnvironment();
    const baseline = buildObservedBaseline(makeBaselineInput());
    const base = modelSpecFromBaseline(structure, baseline, env);
    const params = fitParameters(structure, baseline);
    const fixed = structureCandidates(base, params).find((c) => c.id === "FIXED")!;
    const contended = { ...base, stations: base.stations.map((s) => ({ ...s, service: { kind: "CONTENTION" as const, baseMeanMs: params.serviceMeans[s.id] ?? 5, factor: 0.4, exponent: 1 } })) };
    const workload: WorkloadSpec = { arrival: baseline.arrival, operationMix: [{ operation: "op", share: 1 }], streams: [{ name: "a", purpose: "x", distribution: { kind: "exponential", parameters: { rate: 4 } } }], loadMultipliers: [1], durationSec: 60, warmupSec: 6, openLoop: true, derivedFrom: { windowIds: ["w"], labelAllowlistApplied: true } };
    const arrivals = generateArrivals(workload, 30, "seed-load", { maxRequests: 3000 }).requests;
    const fixedRun = simulate(fixed.spec, arrivals, { seed: "s", maxEvents: 1_000_000, maxSimTimeMs: 10_000_000 });
    const contendedRun = simulate(contended, arrivals, { seed: "s", maxEvents: 1_000_000, maxSimTimeMs: 10_000_000 });
    assert.ok(contendedRun.p95 >= fixedRun.p95, "contention must inflate the tail, not shrink it");
    const observed = { throughput: fixedRun.throughput, p95: contendedRun.p95, errorRate: 0 };
    assert.ok(modelError(contendedRun, observed) < modelError(fixedRun, observed), "the correct structure must fit better");
  });
});

describe("baseline and calibration diagnostics", () => {
  it("selects a piecewise arrival model when the rate is non-stationary", () => {
    const timestamps = [...Array.from({ length: 100 }, (_, i) => i * 100), ...Array.from({ length: 300 }, (_, i) => 10_000 + i * 25)];
    const { model, diagnostics } = fitArrivalModel(timestamps, 60);
    assert.equal(model.model, "PIECEWISE");
    assert.ok(diagnostics.binRates.length >= 2);
    assert.ok(diagnostics.note.length > 0);
  });

  it("keeps a single stationary rate when arrivals are homogeneous", () => {
    const timestamps = Array.from({ length: 200 }, (_, i) => i * 300);
    const { model } = fitArrivalModel(timestamps, 60);
    assert.ok(model.model === "POISSON" || model.model === "FIXED_RATE");
  });

  it("the fitted model keeps a service mean per station and reports a calibration error", () => {
    const baseline = buildObservedBaseline(makeBaselineInput());
    const params = fitParameters(makeStructure(), baseline);
    for (const s of makeStructure().stations) assert.ok((params.serviceMeans[s.id] ?? 0) > 0, `${s.id} has a mean`);
    assert.ok(modelError({ throughput: 100, p95: 200, errorRate: 0.01 }, { throughput: 100, p95: 200, errorRate: 0.01 }) === 0);
  });
});
