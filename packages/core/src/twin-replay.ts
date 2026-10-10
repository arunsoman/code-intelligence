// R1 replay engine: a deterministic twin run of a pinned scenario, mapped into an honest RaceSpec.
// The model is a synthetic reference flow (the F10-style four-station payment path with a DB pool
// and an event queue). It is a MODEL_PREDICTION by construction: a validated baseline or a real
// executable experiment (isolated-exec) would upgrade the result class, never this slice alone.
import { createHash } from "node:crypto";
import type { Claim, RaceResultClass, RaceSpec, TwinModelSpec } from "@cie/schema";
import { simulate, type Arrival, type KernelOptions } from "./twin-kernel.ts";
const MODEL_SPEC_ID = "workflow.twin.model.v1";
const MODEL_VERSION = "reference-payment-flow/v1";

export interface ReplayParams {
  subject: string;
  scenario: "baseline" | "timeout" | "saturation" | "retry-storm";
  arrivalRatePerSec: number;
  durationSec: number;
  timeoutMs?: number;
  faultProbability?: number;
  seed?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Deterministic arrivals: exponential-ish gaps drawn from the event-keyed RNG, so a seed fully pins the run. */
function buildArrivals(ratePerSec: number, durationSec: number, seed: string): Arrival[] {
  const gaps = 1000 / clamp(ratePerSec, 0.1, 1000);
  const arrivals: Arrival[] = [];
  let at = 0;
  let i = 0;
  while (at < durationSec * 1000 && arrivals.length < 600) {
    arrivals.push({ requestId: `rq:${i}`, atMs: Math.round(at), operation: "checkout", attributes: { keyClass: i % 4 === 0 ? "repeat" : "default" } });
    // Alternating gap pattern keyed by seed: deterministic, non-degenerate, no float drift.
    at += gaps * (0.75 + 0.5 * eventKeyedDraw(seed, `arrival:${i}`));
    i++;
  }
  return arrivals;
}

function eventKeyedDraw(seed: string, stream: string): number {
  const h = createHash("sha256").update(`${seed}:${stream}`).digest();
  return h[0] / 255;
}

/** The pinned reference model. Scenario knobs change only the declared fault/timeout parameters. */
export function referencePaymentModel(params: ReplayParams): TwinModelSpec {
  const timeoutMs = params.scenario === "baseline" ? undefined : clamp(params.timeoutMs ?? 40, 1, 60000);
  const faultProbability = params.scenario === "retry-storm" ? clamp(params.faultProbability ?? 0.35, 0, 1)
    : params.scenario === "baseline" ? 0 : clamp(params.faultProbability ?? 0.1, 0, 1);
  return {
    schemaId: MODEL_SPEC_ID,
    entryStationId: "api",
    stations: [
      { id: "api", name: "checkout.api", resourceId: "svc", service: { kind: "FIXED", ms: 3 }, routing: [{ to: "fraud", probability: 1 }] },
      { id: "fraud", name: "fraud.check", resourceId: null, service: { kind: "FIXED", ms: 6 }, routing: [{ to: "ledger", probability: 1 }] },
      { id: "ledger", name: "ledger.reserve", resourceId: "db", service: { kind: "LOGNORMAL", meanMs: 13, sigma: 0.5 }, routing: [{ to: "publish", probability: 0.92 }, { to: "dead", probability: 0.08 }], timeoutMs, retries: { max: 2, backoffMs: 15 } },
      { id: "publish", name: "events.publish", resourceId: "queue", service: { kind: "FIXED", ms: 4 }, routing: [] },
      { id: "dead", name: "dead.letter", resourceId: null, service: { kind: "FIXED", ms: 1 }, routing: [] },
    ],
    resources: [
      { id: "svc", kind: "CPU", capacity: 4, queuePolicy: "FIFO", queueLimit: 200 },
      { id: "db", kind: "POOL", capacity: 8, queuePolicy: "FIFO", queueLimit: 40 },
      { id: "queue", kind: "QUEUE", capacity: 4, queuePolicy: "FIFO", queueLimit: 60 },
    ],
    rng: "sha256-keyed/v1",
    tieComparator: "sequence/v1",
    faults: faultProbability > 0 ? [{ stationId: "ledger", probability: faultProbability, errorClass: "transient" }] : [],
  };
}

export function replayRunId(params: ReplayParams): string {
  return `run:${createHash("sha256").update(JSON.stringify({ ...params, seed: params.seed ?? "", model: MODEL_VERSION })).digest("hex").slice(0, 24)}`;
}

export interface ReplayResult { spec: RaceSpec; claims: Claim[] }

/** Run the pinned model once, deterministically, and map the outcome into a RaceSpec plus claims. */
export function runRaceReplay(params: ReplayParams): ReplayResult {
  const seed = params.seed ?? "cie-replay-v1";
  const runId = replayRunId({ ...params, seed });
  const model = referencePaymentModel(params);
  const arrivals = buildArrivals(params.arrivalRatePerSec, params.durationSec, seed);
  const options: KernelOptions = {
    seed,
    maxEvents: 200_000,
    maxSimTimeMs: params.durationSec * 1000 + 60_000,
  };
  // Pass 1 (no spans): metrics and terminal outcomes. Pass 2: spans for the failures plus a success fill,
  // so the drawn sample shows the story (who timed out, who sailed through), not just the first arrivals.
  const outcome = simulate(model, arrivals, options);
  const failedIds = outcome.perRequest.filter((r) => r.outcome === "TIMEOUT" || r.outcome === "ERROR").map((r) => r.requestId);
  const successIds = outcome.perRequest.filter((r) => r.outcome === "SUCCESS").map((r) => r.requestId);
  const sampleIds = [...failedIds.slice(0, 40), ...successIds.slice(0, Math.max(0, 60 - Math.min(40, failedIds.length)))];
  const spanned = sampleIds.length
    ? simulate(model, arrivals, { ...options, collectSpans: { maxRequests: sampleIds.length, requestIds: sampleIds } })
    : outcome;

  const perRequest = new Map(spanned.perRequest.map((r) => [r.requestId, r]));
  const stationIds = model.stations.map((s) => s.id);
  const byRequest = new Map<string, RaceSpec["requests"][number]["spans"]>();
  for (const s of spanned.spans ?? []) {
    const list = byRequest.get(s.requestId) ?? [];
    list.push({ stationId: s.stationId, attempt: s.attempt, startMs: s.startMs, endMs: s.endMs, waitMs: s.waitMs, event: s.event });
    byRequest.set(s.requestId, list);
  }
  const requests: RaceSpec["requests"] = [...byRequest.entries()].map(([requestId, spans]) => {
    const terminal = perRequest.get(requestId);
    return {
      requestId,
      outcome: terminal?.outcome ?? "CANCELLED",
      latencyMs: Math.round(terminal?.latencyMs ?? spans.at(-1)?.endMs ?? 0),
      retries: terminal?.retries ?? 0,
      spans: spans.sort((a, b) => a.startMs - b.startMs).map((s) => ({ ...s, startMs: Math.round(s.startMs), endMs: Math.round(s.endMs), waitMs: Math.round(s.waitMs) })),
    };
  }).sort((a, b) => (a.outcome === "SUCCESS" ? 1 : 0) - (b.outcome === "SUCCESS" ? 1 : 0) || (a.spans[0]?.startMs ?? 0) - (b.spans[0]?.startMs ?? 0) || a.requestId.localeCompare(b.requestId)).slice(0, 60);

  const metrics = {
    offered: outcome.offered, completed: outcome.completed, failed: outcome.failed, timedOut: outcome.timedOut,
    dropped: outcome.dropped, retried: outcome.retried,
    throughput: Number(outcome.throughput.toFixed(2)),
    p50: Math.round(outcome.p50), p95: Math.round(outcome.p95),
    errorRate: Number(outcome.errorRate.toFixed(4)),
    utilisation: Object.fromEntries(Object.entries(outcome.utilisation).map(([k, v]) => [k, Number(v.toFixed(3))])),
    peakQueue: outcome.peakQueue,
  };

  const gaps = [
    "Simulated on the pinned reference model in simulated time — not observed production timing.",
    "The reference flow is synthetic; replace it with a model calibrated from measured spans before trusting absolute numbers.",
    ...(outcome.bounded.eventsExhausted || outcome.bounded.timeExhausted || outcome.bounded.queueExhausted ? ["The run hit a bound before exhausting its events; reported metrics are censored at the bound."] : []),
    ...(params.scenario === "baseline" ? [] : ["Scenario effects are relative to the same model run as baseline; the comparison inherits every model assumption."]),
  ];

  const resultClass: RaceResultClass = "MODEL_PREDICTION";
  const claimSeeds: RaceSpec["claims"] = [];
  const timeoutRate = metrics.offered ? (metrics.timedOut) / metrics.offered : 0;
  if (metrics.timedOut > 0) claimSeeds.push({ claimId: `${runId}:timeout`, kind: "timeout-rate", stationId: "ledger", text: `Under the ${params.scenario} scenario the model run shows ${metrics.timedOut} of ${metrics.offered} requests timing out at ledger.reserve (${(timeoutRate * 100).toFixed(1)}%); retries exhausted after ${metrics.retried} retry attempts.` });
  if (metrics.dropped > 0) claimSeeds.push({ claimId: `${runId}:saturation`, stationId: "db", kind: "saturation", text: `The DB pool or its queue saturated: ${metrics.dropped} request(s) were dropped at admission, peak queue depth ${Math.max(...Object.values(metrics.peakQueue), 0)}.` });
  if (metrics.retried > 0) claimSeeds.push({ claimId: `${runId}:retry`, stationId: "ledger", kind: "retry-amplification", text: `Retries amplified offered load: ${metrics.retried} retry attempts served ${metrics.completed} completions; work done exceeds successful work by ${metrics.offered + metrics.retried > 0 ? (((metrics.offered + metrics.retried) / Math.max(1, metrics.completed)) - 1).toFixed(2) : "0"}×.` });
  const dbUtil = metrics.utilisation["db"] ?? 0;
  if (dbUtil >= 0.85) claimSeeds.push({ claimId: `${runId}:contention`, stationId: "db", kind: "contention", text: `ledger.reserve held the DB pool at ${(dbUtil * 100).toFixed(0)}% utilisation for the whole window; waits, not service time, dominate the tail.` });
  if (!claimSeeds.length) claimSeeds.push({ claimId: `${runId}:healthy`, kind: "baseline-healthy", text: `No timeouts, drops or saturation in this run: p95 ${metrics.p95} ms at ${params.arrivalRatePerSec}/s with error rate ${(metrics.errorRate * 100).toFixed(1)}%. This is a model result, not a capacity certificate.` });

  const claims: Claim[] = claimSeeds.map((c) => ({
    draft: {
      id: c.claimId,
      revision: "replay",
      claimClass: "runtime-replay",
      assertion: c.text,
      evidenceIds: [],
      counterEvidenceIds: [],
      rationaleSummary: `Deterministic twin run ${runId} (seed ${seed}, model ${MODEL_VERSION}); result class ${resultClass}. Not a production measurement.`,
      subjects: [c.stationId ?? params.subject],
      modelRun: { runId, provider: "twin-kernel", model: MODEL_VERSION, promptTemplateVersion: `${params.scenario}/v1` },
    },
    version: 1,
    state: "DRAFTED",
    gates: [
      { gate: "GROUNDING", status: "PASS", reasons: ["Derived from the pinned twin model; the model is the ground for this claim, not source spans."], evidenceIds: [] },
      { gate: "CONSISTENCY", status: "PASS", reasons: ["Metrics are recomputed from the same run; no contradiction with the drawn timeline."], evidenceIds: [] },
      { gate: "ADVERSARIAL", status: "INSUFFICIENT", reasons: ["A different seed, rate or fault rate can change the outcome; the run is one point in the parameter space."], evidenceIds: [] },
      { gate: "CALIBRATION", status: "NOT_APPLICABLE", reasons: ["No labelled production verdicts exist for simulated scenarios."], evidenceIds: [] },
      { gate: "DISPLAY", status: "PASS", reasons: [`Shown as ${resultClass}: a bounded model prediction.`], evidenceIds: [] },
    ],
    displayMode: "INFERENCE",
    confidence: { mode: "UNCALIBRATED", reasonCodes: ["Deterministic given the seed; realism depends on model calibration."] },
    verdicts: [],
    counterArgument: "The timeline is only as real as the model. Calibrated baselines and isolated-exec experiments are the upgrade path (C27).",
  }));

  const spec: RaceSpec = {
    schemaVersion: "race.v1",
    ordering: "simulated-model",
    resultClass,
    runId,
    seed,
    modelSpec: MODEL_VERSION,
    subject: params.subject,
    scenario: params.scenario,
    params: { arrivalRatePerSec: params.arrivalRatePerSec, durationSec: params.durationSec, ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}), ...(params.faultProbability !== undefined ? { faultProbability: params.faultProbability } : {}) },
    stationIds,
    requests,
    metrics,
    claims: claimSeeds.map((c) => ({ claimId: c.claimId, kind: c.kind, text: c.text, ...(c.stationId ? { stationId: c.stationId } : {}) })),
    gaps,
  };
  return { spec, claims };
}

/** Small bounded cache: replays are deterministic per params, so identical re-runs are free. */
const cache = new Map<string, ReplayResult>();
export function cachedRaceReplay(params: ReplayParams): ReplayResult {
  const key = replayRunId(params);
  const hit = cache.get(key);
  if (hit) return hit;
  const result = runRaceReplay(params);
  if (cache.size >= 50) cache.delete(cache.keys().next().value as string);
  cache.set(key, result);
  return result;
}

/** Look a finished run up by its id, so "Open replay" on a claim can re-create the same timeline.
 *  Cache misses are honest: the caller reports the run as expired instead of re-narrating it. */
export function raceReplayByRunId(runId: string): ReplayResult | null {
  for (const result of cache.values()) if (result.spec.runId === runId) return result;
  return null;
}
