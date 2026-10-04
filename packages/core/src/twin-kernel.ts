// F10/WP-06 — bounded discrete-event kernel for the workflow twin model.
// Invariants (C27 §6, F10-D2): simulated time never goes backwards; ties are broken by a versioned
// sequence comparator; resource capacity is acquired and released exactly; queues, events and runtime
// are bounded and exhaustion is reported, never hidden.
import type { ModelStation, ServiceTimeSource, TwinModelSpec } from "@cie/schema";
import { eventKeyedRandom } from "./twin.ts";

export interface Arrival { requestId: string; atMs: number; operation: string; attributes: Record<string, string> }
export interface KernelOptions {
  seed: string;
  maxEvents: number;
  maxSimTimeMs: number;
  /** Requests that arrive before warm-up end are excluded from the reported metrics. */
  warmupMs?: number;
  maxCompletions?: number;
}

export interface SimulationMetrics {
  offered: number; completed: number; failed: number; timedOut: number; dropped: number; retried: number;
  throughput: number; p50: number; p95: number; p99: number; mean: number;
  errorRate: number; completedWorkRate: number;
  /** Latency over all offered requests, failures and timeouts included (censored at the run end). */
  allRequestsP95: number;
  utilisation: Record<string, number>; peakQueue: Record<string, number>;
}
export interface SimulationOutcome extends SimulationMetrics {
  eventsProcessed: number;
  bounded: { eventsExhausted: boolean; timeExhausted: boolean; queueExhausted: boolean };
  perStationCompletions: Record<string, number>;
  /** Per-request terminal results, for building an outcomes artifact. */
  perRequest: { requestId: string; outcome: "SUCCESS" | "ERROR" | "TIMEOUT" | "CANCELLED"; latencyMs: number; retries: number }[];
}

type EventKind = "ARRIVE" | "DEPART" | "TIMEOUT" | "FAULT";
interface ServiceEvent { atMs: number; seq: number; kind: EventKind; requestId: string; stationId: string; visit: number; attempt: number }
interface RequestState {
  requestId: string; operation: string; attributes: Record<string, string>;
  stationId: string; visit: number; attempt: number; startedAtMs: number; arrivalAtMs: number; heldResource: string | null;
  outcome: "SUCCESS" | "ERROR" | "TIMEOUT" | null;
}
interface Queued { requestId: string; stationId: string; visit: number; attempt: number; enqueuedAtMs: number }

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);

/** Sample a service time from a source, given the current concurrency at the station's resource. */
export function sampleServiceTime(source: ServiceTimeSource, concurrency: number, rng: () => number): number {
  switch (source.kind) {
    case "FIXED": return source.ms;
    case "EXPONENTIAL": return -Math.log(1 - rng()) * source.meanMs;
    case "LOGNORMAL": {
      const u1 = Math.max(1e-12, rng()), u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.max(0, source.meanMs * Math.exp(source.sigma * z - (source.sigma * source.sigma) / 2));
    }
    case "EMPIRICAL": { const i = Math.min(source.samplesMs.length - 1, Math.floor(rng() * source.samplesMs.length)); return source.samplesMs[i]; }
    case "CONTENTION": return source.baseMeanMs * (1 + source.factor * Math.pow(Math.max(0, concurrency - 1), source.exponent));
  }
}

export function simulate(spec: TwinModelSpec, arrivals: Arrival[], options: KernelOptions): SimulationOutcome {
  const stationById = new Map(spec.stations.map((s) => [s.id, s]));
  const resourceById = new Map(spec.resources.map((r) => [r.id, r]));
  if (!stationById.has(spec.entryStationId)) throw new Error(`entry station ${spec.entryStationId} is not in the model`);
  const warmup = options.warmupMs ?? 0;

  const inUse = new Map(spec.resources.map((r) => [r.id, 0]));
  const queues = new Map(spec.resources.map((r) => [r.id, [] as Queued[]]));
  const peakQueue = Object.fromEntries(spec.resources.map((r) => [r.id, 0]));
  const busyMs = Object.fromEntries(spec.resources.map((r) => [r.id, 0]));

  const requests = new Map<string, RequestState>();
  let seq = 0;
  // Binary min-heap keyed by (atMs, seq): simulated time is monotonic and ties are deterministic.
  const heap: ServiceEvent[] = [];
  const less = (a: ServiceEvent, b: ServiceEvent) => a.atMs < b.atMs || (a.atMs === b.atMs && a.seq < b.seq);
  const push = (e: Omit<ServiceEvent, "seq">) => {
    const item: ServiceEvent = { ...e, seq: seq++ };
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; }
  };
  const pop = (): ServiceEvent | undefined => {
    if (!heap.length) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]]; i = m;
      }
    }
    return top;
  };

  const bounded = { eventsExhausted: false, timeExhausted: false, queueExhausted: false };
  let eventsProcessed = 0;
  let simTime = 0;
  const successLatencies: number[] = [];
  const allLatencies: number[] = [];
  const terminalAt = new Map<string, number>();
  const perStationCompletions: Record<string, number> = {};
  const perRequest: SimulationOutcome["perRequest"] = [];
  let completed = 0, failed = 0, timedOut = 0, dropped = 0, retried = 0;
  const admitted: string[] = [];

  const rngFor = (requestId: string, stationId: string, visit: number, attempt: number, purpose: string) =>
    () => eventKeyedRandom(options.seed, `${stationId}:${visit}:${attempt}`, requestId, purpose);

  const scheduleService = (request: RequestState, station: ModelStation, concurrency: number) => {
    const rng = rngFor(request.requestId, station.id, request.visit, request.attempt, "service");
    let serviceMs = sampleServiceTime(station.service, concurrency, rng);
    if (station.cache) {
      const hit = eventKeyedRandom(options.seed, station.id, request.requestId, `cache:${request.attributes["keyClass"] ?? "default"}`) < station.cache.hitProbability;
      if (hit) serviceMs = 0;
    }
    const fault = spec.faults.find((f) => f.stationId === station.id);
    const faultHit = fault ? eventKeyedRandom(options.seed, station.id, request.requestId, `fault:${request.visit}:${request.attempt}`) < fault.probability : false;
    const timeout = station.timeoutMs !== undefined && serviceMs > station.timeoutMs;
    const effective = timeout ? station.timeoutMs! : serviceMs;
    request.startedAtMs = simTime;
    if (station.resourceId) busyMs[station.resourceId] = (busyMs[station.resourceId] ?? 0) + effective;
    if (timeout) push({ atMs: simTime + effective, kind: "TIMEOUT", requestId: request.requestId, stationId: station.id, visit: request.visit, attempt: request.attempt });
    else if (faultHit) push({ atMs: simTime + effective, kind: "FAULT", requestId: request.requestId, stationId: station.id, visit: request.visit, attempt: request.attempt });
    else push({ atMs: simTime + effective, kind: "DEPART", requestId: request.requestId, stationId: station.id, visit: request.visit, attempt: request.attempt });
  };

  const releaseAndDrain = (resourceId: string | null) => {
    if (!resourceId) return;
    inUse.set(resourceId, Math.max(0, inUse.get(resourceId)! - 1));
    const resource = resourceById.get(resourceId)!;
    const q = queues.get(resourceId)!;
    const next = resource.queuePolicy === "FIFO" ? q.shift() : q.pop();
    if (next) {
      inUse.set(resourceId, inUse.get(resourceId)! + 1);
      const request = requests.get(next.requestId)!;
      const station = stationById.get(next.stationId)!;
      request.heldResource = resourceId;
      scheduleService(request, station, inUse.get(resourceId)! - 1);
    }
  };

  const enqueue = (request: RequestState, station: ModelStation) => {
    if (!station.resourceId) { scheduleService(request, station, 0); return; }
    const resource = resourceById.get(station.resourceId)!;
    const used = inUse.get(resource.id)!;
    if (used < resource.capacity) { inUse.set(resource.id, used + 1); request.heldResource = resource.id; scheduleService(request, station, used); return; }
    const q = queues.get(resource.id)!;
    if (q.length >= resource.queueLimit) { bounded.queueExhausted = true; complete(request, "ERROR"); dropped++; return; }
    q.push({ requestId: request.requestId, stationId: station.id, visit: request.visit, attempt: request.attempt, enqueuedAtMs: simTime });
    peakQueue[resource.id] = Math.max(peakQueue[resource.id], q.length);
  };

  const complete = (request: RequestState, outcome: "SUCCESS" | "ERROR" | "TIMEOUT") => {
    if (request.outcome) return;
    request.outcome = outcome;
    terminalAt.set(request.requestId, simTime);
    perRequest.push({ requestId: request.requestId, outcome, latencyMs: simTime - request.arrivalAtMs, retries: request.attempt });
    if (simTime >= warmup) {
      successLatencies.push(simTime - request.arrivalAtMs);
      allLatencies.push(simTime - request.arrivalAtMs);
    }
    if (outcome === "SUCCESS") { completed++; perStationCompletions[request.stationId] = (perStationCompletions[request.stationId] ?? 0) + 1; }
    else if (outcome === "TIMEOUT") timedOut++;
    else failed++;
  };

  const retryOrFail = (request: RequestState, station: ModelStation, outcome: "ERROR" | "TIMEOUT") => {
    releaseAndDrain(request.heldResource); request.heldResource = null;
    if (station.retries && request.attempt < station.retries.max) {
      retried++;
      request.attempt += 1;
      push({ atMs: simTime + station.retries.backoffMs, kind: "ARRIVE", requestId: request.requestId, stationId: station.id, visit: request.visit, attempt: request.attempt });
    } else complete(request, outcome);
  };

  for (const a of [...arrivals].sort((x, y) => x.atMs - y.atMs)) {
    requests.set(a.requestId, { requestId: a.requestId, operation: a.operation, attributes: a.attributes, stationId: spec.entryStationId, visit: 0, attempt: 0, startedAtMs: a.atMs, arrivalAtMs: a.atMs, heldResource: null, outcome: null });
    if (a.atMs >= warmup) admitted.push(a.requestId);
    push({ atMs: a.atMs, kind: "ARRIVE", requestId: a.requestId, stationId: spec.entryStationId, visit: 0, attempt: 0 });
  }

  while (heap.length) {
    const e = pop()!;
    if (e.atMs < simTime) throw new Error(`kernel time went backwards: ${e.atMs} < ${simTime}`);
    simTime = e.atMs;
    eventsProcessed++;
    if (eventsProcessed > options.maxEvents) { bounded.eventsExhausted = true; break; }
    if (simTime > options.maxSimTimeMs) { bounded.timeExhausted = true; break; }
    if (options.maxCompletions !== undefined && terminalAt.size >= options.maxCompletions) break;
    const request = requests.get(e.requestId)!;
    if (request.outcome) continue;
    const station = stationById.get(e.stationId)!;
    if (e.kind === "ARRIVE") { request.stationId = e.stationId; request.visit = e.visit; request.attempt = e.attempt; enqueue(request, station); continue; }
    if (e.kind === "TIMEOUT" || e.kind === "FAULT") { retryOrFail(request, station, e.kind === "TIMEOUT" ? "TIMEOUT" : "ERROR"); continue; }
    // DEPART: route onward, or finish.
    releaseAndDrain(request.heldResource); request.heldResource = null;
    const routing = station.routing.filter((r) => !r.attributeEquals || request.attributes[r.attributeEquals.attribute] === r.attributeEquals.value);
    const total = routing.reduce((a, b) => a + b.probability, 0);
    if (total <= 0) { complete(request, "SUCCESS"); continue; }
    const draw = eventKeyedRandom(options.seed, station.id, request.requestId, `route:${request.visit}`) * total;
    let acc = 0, next: string | null = null;
    for (const r of routing) { acc += r.probability; if (draw <= acc) { next = r.to; break; } }
    if (!next || !stationById.has(next)) { complete(request, "SUCCESS"); continue; }
    push({ atMs: simTime, kind: "ARRIVE", requestId: request.requestId, stationId: next, visit: request.visit + 1, attempt: 0 });
  }

  // Requests still in the system when the bounds are hit are censored at the run end, never counted as success.
  for (const request of requests.values()) if (!request.outcome) perRequest.push({ requestId: request.requestId, outcome: "CANCELLED", latencyMs: Math.max(0, simTime - request.arrivalAtMs), retries: request.attempt });
  const observedTerminal = completed + failed + timedOut + dropped;
  const censored = Math.max(0, admitted.length - observedTerminal);
  for (let i = 0; i < censored; i++) allLatencies.push(Math.max(0, simTime - warmup));
  successLatencies.sort((a, b) => a - b);
  allLatencies.sort((a, b) => a - b);
  const durationSec = Math.max(1e-9, (simTime - warmup) / 1000);
  const utilisation: Record<string, number> = {};
  for (const r of spec.resources) utilisation[r.id] = Math.min(1, (busyMs[r.id] ?? 0) / Math.max(1e-9, (simTime - warmup) * Math.max(1, r.capacity)));
  const offered = admitted.length;
  const errors = failed + timedOut + censored;
  const meanSuccess = successLatencies.length ? successLatencies.reduce((a, b) => a + b, 0) / successLatencies.length : 0;
  return {
    offered, completed, failed, timedOut, dropped, retried,
    throughput: completed / durationSec,
    p50: percentile(successLatencies, 0.5), p95: percentile(successLatencies, 0.95), p99: percentile(successLatencies, 0.99), mean: meanSuccess,
    errorRate: offered ? errors / offered : 0,
    completedWorkRate: offered ? completed / offered : 1,
    allRequestsP95: percentile(allLatencies, 0.95),
    utilisation, peakQueue,
    eventsProcessed, bounded, perStationCompletions, perRequest,
  };
}

/** Structural validation of a model spec before it runs. */
export function validateModelSpec(spec: TwinModelSpec): string[] {
  const problems: string[] = [];
  if (spec.schemaId !== "workflow.twin.model.v1") problems.push("unknown model schema");
  const stationIds = new Set(spec.stations.map((s) => s.id));
  const resourceIds = new Set(spec.resources.map((r) => r.id));
  if (!stationIds.has(spec.entryStationId)) problems.push("entry station is missing");
  for (const s of spec.stations) {
    if (s.resourceId && !resourceIds.has(s.resourceId)) problems.push(`station ${s.id} references an unknown resource`);
    for (const r of s.routing) if (!stationIds.has(r.to)) problems.push(`station ${s.id} routes to unknown station ${r.to}`);
  }
  for (const r of spec.resources) if (!Number.isInteger(r.capacity) || r.capacity < 0) problems.push(`resource ${r.id} has an invalid capacity`);
  for (const f of spec.faults) if (!stationIds.has(f.stationId)) problems.push(`fault references unknown station ${f.stationId}`);
  return problems;
}
