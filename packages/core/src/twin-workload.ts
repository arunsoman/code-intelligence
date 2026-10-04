// F10/WP-04 — workload fixture generator with event-keyed streams.
// Arrivals are a function of the request index only, so a candidate that performs more internal
// draws still sees identical arrivals and request attributes (F10-D1).
import { createHash } from "node:crypto";
import type { ArrivalModel, RequestRecord, WorkloadSpec } from "@cie/schema";
import { eventKeyedRandom } from "./twin.ts";
import type { Arrival } from "./twin-kernel.ts";

export const WORKLOAD_GENERATOR_VERSION = "twin.workload.v1";

export interface GeneratedWorkload {
  workloadHash: string;
  seed: string;
  multiplier: number;
  scheduledRatePerSec: number;
  requests: Arrival[];
  truncatedAtMs: number;
  /** True when the request cap was hit before the duration elapsed. */
  capped: boolean;
}

const h = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Hash the fixture identity: spec bytes, generator version and stream definitions. */
export function workloadHash(spec: WorkloadSpec): string {
  return h({ spec, generator: WORKLOAD_GENERATOR_VERSION, streams: [...spec.streams].sort((a, b) => a.name.localeCompare(b.name)) });
}

function rateAt(model: ArrivalModel, tSec: number): number {
  switch (model.model) {
    case "FIXED_RATE": case "POISSON": return model.ratePerSec ?? model.segments?.[0]?.ratePerSec ?? 1;
    case "PIECEWISE": {
      const seg = model.segments?.find((s) => tSec >= s.fromSec && tSec < s.toSec) ?? model.segments?.[model.segments.length - 1];
      return seg?.ratePerSec ?? 1;
    }
    case "BURSTY": case "REPLAY": return model.ratePerSec ?? model.burst?.offRate ?? 1;
  }
}

/**
 * Generate the arrival stream and request attributes. Open-loop: arrivals are scheduled regardless of
 * any response. `multiplier` scales the offered rate; it never multiplies observed latency.
 */
export function generateArrivals(spec: WorkloadSpec, multiplier: number, seed: string, options: { maxRequests?: number } = {}): GeneratedWorkload {
  if (!(multiplier > 0)) throw new Error("load multiplier must be positive");
  const maxRequests = options.maxRequests ?? 200_000;
  const durationMs = spec.durationSec * 1000;
  const requests: Arrival[] = [];
  let tMs = 0;
  let capped = false;
  // Bursty state is a Markov chain over rate levels; transitions are keyed by request index.
  let bursting = false;
  for (let i = 0; requests.length < maxRequests; i++) {
    const id = `req-${i}`;
    let effectiveRate: number;
    if (spec.arrival.model === "BURSTY" && spec.arrival.burst) {
      const move = eventKeyedRandom(seed, "burst", id, bursting ? "on->off" : "off->on");
      if (bursting ? move < spec.arrival.burst.pOnToOff : move < spec.arrival.burst.pOffToOn) bursting = !bursting;
      effectiveRate = (bursting ? spec.arrival.burst.onRate : spec.arrival.burst.offRate) * multiplier;
    } else {
      effectiveRate = rateAt(spec.arrival, tMs / 1000) * multiplier;
    }
    if (!(effectiveRate > 0)) { capped = true; break; }
    let interarrivalMs: number;
    if (spec.arrival.model === "FIXED_RATE") interarrivalMs = 1000 / effectiveRate;
    else interarrivalMs = (-Math.log(1 - eventKeyedRandom(seed, "arrivals", id, "interarrival")) * 1000) / effectiveRate;
    tMs += interarrivalMs;
    if (tMs > durationMs) break;
    const opDraw = eventKeyedRandom(seed, "attributes", id, "operation");
    let acc = 0, operation = spec.operationMix[spec.operationMix.length - 1].operation;
    for (const o of spec.operationMix) { acc += o.share; if (opDraw < acc) { operation = o.operation; break; } }
    const payloadSizeBucket = Math.floor(eventKeyedRandom(seed, "attributes", id, "payloadSize") * 5);
    const keyClass = `k${Math.floor(eventKeyedRandom(seed, "attributes", id, "keyClass") * 8)}`;
    requests.push({ requestId: id, atMs: tMs, operation, attributes: { operation, payloadSizeBucket: String(payloadSizeBucket), keyClass } });
  }
  return { workloadHash: workloadHash(spec), seed, multiplier, scheduledRatePerSec: spec.arrival.ratePerSec ? spec.arrival.ratePerSec * multiplier : requests.length / Math.max(1, spec.durationSec), requests, truncatedAtMs: tMs, capped: requests.length >= maxRequests };
}

/**
 * Build a workload fixture from observed request records. Summaries only: distributions, mix, key skew,
 * arrival shape and duration. Production payloads never appear here.
 */
export function fixtureFromRecords(records: RequestRecord[], opts: { windowIds: string[]; durationSec: number; allowlist: boolean; openLoop?: boolean }): { spec: WorkloadSpec; records: RequestRecord[] } {
  const byOperation = new Map<string, number>();
  for (const r of records) byOperation.set(r.operation, (byOperation.get(r.operation) ?? 0) + 1);
  const total = records.length || 1;
  const operationMix = [...byOperation].map(([operation, n]) => ({ operation, share: n / total })).sort((a, b) => b.share - a.share);
  const meanLatency = records.length ? records.reduce((a, r) => a + Object.values(r.demands).reduce((x, y) => x + y, 0), 0) / records.length : 1;
  // A single-rate Poisson fit is the honest default; the baseline analysis replaces it with a piecewise fit when the series drifts.
  const ratePerSec = records.length / Math.max(1, opts.durationSec);
  const payloadBuckets = records.map((r) => r.payloadSizeBucket);
  const keyClasses = [...new Set(records.map((r) => r.keyClass))];
  const spec: WorkloadSpec = {
    arrival: { model: "POISSON", ratePerSec },
    operationMix: operationMix.length ? operationMix : [{ operation: "default", share: 1 }],
    streams: [
      { name: "arrivals", purpose: "inter-arrival draws", distribution: { kind: "exponential", parameters: { meanMs: 1000 / Math.max(1e-9, ratePerSec) } } },
      { name: "attributes", purpose: "operation, payload size and key class", distribution: { kind: "categorical", parameters: { operations: operationMix.length, payloadBuckets: new Set(payloadBuckets).size, keyClasses: keyClasses.length } } },
    ],
    loadMultipliers: [0.5, 1, 1.6],
    durationSec: opts.durationSec,
    warmupSec: Math.min(60, opts.durationSec * 0.1),
    openLoop: opts.openLoop ?? true,
    derivedFrom: { windowIds: opts.windowIds, labelAllowlistApplied: opts.allowlist },
  };
  void meanLatency;
  return { spec, records };
}
