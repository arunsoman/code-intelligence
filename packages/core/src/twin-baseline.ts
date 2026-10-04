// F10/WP-03 — observed baseline: arrival process fit, demand-versus-wait separation, request records.
// Waiting is never sampled as service time: a span categorised LOCK/POOL/QUEUE is a wait, and a station
// whose wait cannot be separated is a BLACK_BOX with restricted intervention applicability (C27 §6).
import type { ArrivalModel, RequestRecord } from "@cie/schema";
import { eventKeyedRandom } from "./twin.ts";

export type SpanCategory = "CPU" | "IO" | "LOCK" | "POOL" | "QUEUE" | "OTHER";
export interface ObservedSpan {
  id: string; requestId: string; parentId: string | null; stationId: string; entityId: string;
  startMs: number; endMs: number; category: SpanCategory; samplingRate: number; instance: string;
}
export interface ArrivalDiagnostics {
  method: "POISSON" | "PIECEWISE" | "BURSTY" | "FIXED_RATE";
  observedRatePerSec: number;
  binRates: number[];
  variability: number;
  varianceToMeanRatio: number;
  stationary: boolean;
  note: string;
}
export interface ObservedBaseline {
  arrival: ArrivalModel;
  arrivalDiagnostics: ArrivalDiagnostics;
  requests: RequestRecord[];
  demands: Record<string, number>;
  waits: Record<string, number>;
  blackBoxStations: string[];
  coverage: { windowIds: string[]; requestsObserved: number; estimatedTotal: number; samplingRate: number; revision: string; instances: string[] };
  outcomeCounts: Record<string, number>;
}

/** Fit an arrival process, keeping the diagnostics that justified the choice (D5: fitted, piecewise when non-stationary). */
export function fitArrivalModel(timestampsMs: number[], durationSec: number, bins = 10): { model: ArrivalModel; diagnostics: ArrivalDiagnostics } {
  const sorted = [...timestampsMs].sort((a, b) => a - b);
  const observedRatePerSec = sorted.length / Math.max(1e-9, durationSec);
  if (sorted.length === 0) {
    return { model: { model: "FIXED_RATE", ratePerSec: 0 }, diagnostics: { method: "FIXED_RATE", observedRatePerSec: 0, binRates: [], variability: 0, varianceToMeanRatio: 0, stationary: true, note: "No arrivals observed; the fixture carries an explicit zero rate rather than an assumption." } };
  }
  const binWidthSec = durationSec / bins;
  const binRates = Array.from({ length: bins }, (_, b) => {
    const lo = b * binWidthSec * 1000, hi = (b + 1) * binWidthSec * 1000;
    return sorted.filter((t) => t >= lo && t < hi).length / Math.max(1e-9, binWidthSec);
  });
  const mean = binRates.reduce((a, b) => a + b, 0) / binRates.length;
  const variance = binRates.reduce((a, b) => a + (b - mean) ** 2, 0) / binRates.length;
  const variability = mean > 0 ? Math.sqrt(variance) / mean : 0;
  // For a homogeneous Poisson process the count variance equals the mean; the ratio is a crude but honest check.
  const counts = binRates.map((r) => r * binWidthSec);
  const countMean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const countVar = counts.reduce((a, b) => a + (b - countMean) ** 2, 0) / counts.length;
  const varianceToMeanRatio = countMean > 0 ? countVar / countMean : 0;
  const stationary = variability < 0.35;
  if (stationary) {
    return { model: { model: "POISSON", ratePerSec: observedRatePerSec }, diagnostics: { method: "POISSON", observedRatePerSec, binRates, variability, varianceToMeanRatio, stationary, note: `Rate is roughly stationary (bin CV ${variability.toFixed(2)}); a homogeneous Poisson fit is used.` } };
  }
  const segments = binRates.map((rate, b) => ({ fromSec: b * binWidthSec, toSec: (b + 1) * binWidthSec, ratePerSec: rate }));
  return { model: { model: "PIECEWISE", segments }, diagnostics: { method: "PIECEWISE", observedRatePerSec, binRates, variability, varianceToMeanRatio, stationary, note: `The rate drifts (bin CV ${variability.toFixed(2)}); a piecewise-constant model is used rather than a single rate.` } };
}

/** Split exclusive span cost into service demand and waiting. */
export function splitDemandWait(spans: ObservedSpan[]): { demands: Record<string, number>; waits: Record<string, number>; blackBox: string[] } {
  const byRequest = new Map<string, ObservedSpan[]>();
  for (const s of spans) byRequest.set(s.requestId, [...(byRequest.get(s.requestId) ?? []), s]);
  const demands: Record<string, number> = {}, waits: Record<string, number> = {};
  const blackBox = new Set<string>();
  let samples = 0;
  for (const group of byRequest.values()) {
    samples++;
    for (const s of group) {
      const children = group.filter((c) => c.parentId === s.id).map((c) => [Math.max(s.startMs, c.startMs), Math.min(s.endMs, c.endMs)] as [number, number]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
      let covered = 0, end = -Infinity;
      for (const [lo, hi] of children) { covered += Math.max(0, hi - Math.max(lo, end)); end = Math.max(end, hi); }
      const exclusive = s.endMs - s.startMs - covered;
      if (exclusive < 0) { blackBox.add(s.stationId); continue; }
      if (s.category === "LOCK" || s.category === "POOL" || s.category === "QUEUE") waits[s.stationId] = (waits[s.stationId] ?? 0) + exclusive;
      else demands[s.stationId] = (demands[s.stationId] ?? 0) + exclusive;
    }
  }
  for (const k of Object.keys(demands)) { demands[k] /= Math.max(1, samples); if (waits[k] !== undefined) waits[k] /= Math.max(1, samples); }
  for (const k of Object.keys(waits)) waits[k] /= Math.max(1, samples);
  return { demands, waits, blackBox: [...blackBox] };
}

export interface BaselineInput {
  spans: ObservedSpan[];
  durationSec: number;
  windowIds: string[];
  revision: string;
  samplingRate: number;
  outcomes?: Record<string, "SUCCESS" | "ERROR" | "TIMEOUT">;
}
/**
 * Build the observed baseline. Requests are stored as records so the model can resample whole requests
 * and preserve correlations; independent marginal distributions are a labelled fallback, never the default.
 */
export function buildObservedBaseline(input: BaselineInput): ObservedBaseline {
  const byRequest = new Map<string, ObservedSpan[]>();
  for (const s of input.spans) byRequest.set(s.requestId, [...(byRequest.get(s.requestId) ?? []), s]);
  // Arrivals are the earliest span per request (the entry), not every span, so the rate is not inflated.
  const arrivalTimestamps = input.spans.length ? [...byRequest.values()].map((g) => Math.min(...g.map((s) => s.startMs))) : [];
  const { model, diagnostics } = fitArrivalModel(arrivalTimestamps, input.durationSec);
  const requests: RequestRecord[] = [];
  const outcomeCounts: Record<string, number> = {};
  for (const [requestId, group] of byRequest) {
    const { demands, waits } = splitDemandWait(group);
    for (const k of Object.keys(demands)) demands[k] /= Math.max(1, group.length);
    for (const k of Object.keys(waits)) waits[k] /= Math.max(1, group.length);
    const outcome = input.outcomes?.[requestId] ?? "SUCCESS";
    outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
    requests.push({ operation: group[0]?.entityId ?? "default", payloadSizeBucket: 0, keyClass: "k0", demands, waits, outcome, retryCount: 0, censored: outcome === "TIMEOUT" });
  }
  const { demands, waits, blackBox } = splitDemandWait(input.spans);
  const instances = [...new Set(input.spans.map((s) => s.instance))];
  return {
    arrival: model,
    arrivalDiagnostics: diagnostics,
    requests,
    demands,
    waits,
    blackBoxStations: blackBox,
    coverage: { windowIds: input.windowIds, requestsObserved: byRequest.size, estimatedTotal: Math.round(byRequest.size / Math.max(1e-9, input.samplingRate)), samplingRate: input.samplingRate, revision: input.revision, instances },
    outcomeCounts,
  };
}

/** Resample whole request records, preserving the size↔demand correlation (F10-D4). */
export function resampleRequestRecords(records: RequestRecord[], count: number, seed: string): RequestRecord[] {
  if (!records.length) return [];
  const out: RequestRecord[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(eventKeyedRandom(seed, "resample", `r-${i}`, "index") * records.length);
    out.push(structuredClone(records[Math.min(records.length - 1, idx)]));
  }
  return out;
}

/** Pearson correlation between payload-size bucket and total demand, used to prove resampling preserved it. */
export function sizeDemandCorrelation(records: RequestRecord[]): number {
  if (records.length < 2) return 0;
  const xs = records.map((r) => r.payloadSizeBucket);
  const ys = records.map((r) => Object.values(r.demands).reduce((a, b) => a + b, 0));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  const denom = Math.sqrt(dx * dy);
  return denom > 0 ? num / denom : 0;
}
