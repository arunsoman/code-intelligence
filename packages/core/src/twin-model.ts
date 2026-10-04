// F10/WP-07 — model construction, parameters and structure candidates.
// The model structure comes from the workflow structure plus declared resources; unknown behaviour stays
// unknown. Structure selection is recorded as history, and the data used to choose a structure is never
// the untouched holdout (C27 §7).
import type { EnvironmentSpec, InterventionClass, ModelParameters, ModelStation, StructureCandidate, StructureCandidateId, TwinModelSpec, TwinStructure } from "@cie/schema";
import type { ObservedBaseline } from "./twin-baseline.ts";

export const MODEL_ADAPTER_ID = "cie.twin.dES";
export const MODEL_ADAPTER_VERSION = "1";

/** Build a base model spec whose service means come from the observed demands. */
export function modelSpecFromBaseline(structure: TwinStructure, baseline: ObservedBaseline, env: EnvironmentSpec): TwinModelSpec {
  const poolSize = (resourceId: string) => env.poolSizes[resourceId] ?? env.poolSizes["default"] ?? 8;
  const resources = structure.resources.map((r) => ({
    id: r.id, kind: r.kind,
    capacity: r.kind === "CPU" ? env.cores : r.capacity ?? poolSize(r.id),
    queuePolicy: "FIFO" as const, queueLimit: 10_000,
  }));
  const resourceIdFor = (stationId: string) => structure.stations.find((s) => s.id === stationId)?.resourceIds[0] ?? null;
  const stations: ModelStation[] = structure.stations.map((s): ModelStation => {
    const mean = baseline.demands[s.id] ?? baseline.demands[s.name] ?? 5;
    const isExternal = structure.externals.some((e) => e.id === s.id);
    return {
      id: s.id, name: s.name, resourceId: resourceIdFor(s.id),
      service: { kind: "FIXED" as const, ms: isExternal ? 0 : mean },
      routing: routingForStructure(structure, s.id),
      ...(isExternal ? { external: { latencyMs: { kind: "FIXED" as const, ms: mean }, errorProbability: 0 } } : {}),
    };
  });
  return { schemaId: "workflow.twin.model.v1", entryStationId: structure.entryStationId, stations, resources, rng: "sha256-keyed/v1", tieComparator: "sequence/v1", faults: [] };
}

function routingForStructure(structure: TwinStructure, stationId: string): { to: string; probability: number }[] {
  const branches = structure.branches.filter((b) => b.stationId === stationId);
  if (!branches.length) return [];
  // Branches carry a probability source; when the structure only names successors, spread evenly.
  const grouped = new Map<string, number>();
  for (const b of branches) grouped.set(b.to, (grouped.get(b.to) ?? 0) + 1);
  const total = [...grouped.values()].reduce((a, b) => a + b, 0);
  return [...grouped].map(([to, n]) => ({ to, probability: n / total }));
}

export function fitParameters(structure: TwinStructure, baseline: ObservedBaseline): ModelParameters {
  const serviceMeans: Record<string, number> = {};
  for (const s of structure.stations) serviceMeans[s.id] = baseline.demands[s.id] ?? baseline.demands[s.name] ?? 5;
  const externalLatency: Record<string, number> = {}, externalError: Record<string, number> = {};
  for (const e of structure.externals) { externalLatency[e.id] = baseline.demands[e.id] ?? 10; externalError[e.id] = 0; }
  return { serviceMeans, contentionFactor: 0, contentionExponent: 1, cacheHit: {}, retryAmplification: 1, externalLatency, externalError };
}

/** The four structure candidates kept in the calibration history. */
export function structureCandidates(base: TwinModelSpec, params: ModelParameters): StructureCandidate[] {
  const withService = (id: StructureCandidateId, description: string, map: (mean: number, stationId: string) => TwinModelSpec["stations"][number]["service"], p: ModelParameters): StructureCandidate => ({
    id, description, parameters: p,
    spec: { ...base, stations: base.stations.map((s) => ({ ...s, service: map(params.serviceMeans[s.id] ?? 5, s.id) })) },
  });
  return [
    withService("FIXED", "Service times fixed at the observed mean", (mean) => ({ kind: "FIXED", ms: mean }), params),
    withService("CONTENTION", "Service times inflated by a fitted contention function of concurrency", (mean) => ({ kind: "CONTENTION", baseMeanMs: mean, factor: params.contentionFactor, exponent: params.contentionExponent }), params),
    { ...withService("CACHE_DEPENDENCE", "With cache-hit dependence by key class", (mean) => ({ kind: "FIXED", ms: mean }), params), spec: { ...base, stations: base.stations.map((s, i) => i === 0 ? { ...s, cache: { keyClass: "k0", hitProbability: params.cacheHit["k0"] ?? 0.2 } } : s) } },
    withService("RETRY_AMPLIFICATION", "With retry amplification", (mean) => ({ kind: "FIXED", ms: mean * params.retryAmplification }), params),
  ];
}

/** Apply a resource intervention to a spec (the only certified class in the first release). */
export function applyIntervention(spec: TwinModelSpec, klass: InterventionClass, parameters: Record<string, number>): TwinModelSpec {
  if (klass === "POOL_CAPACITY") {
    const pool = parameters["pool"];
    if (pool === undefined) return spec;
    return { ...spec, resources: spec.resources.map((r) => (r.kind === "POOL" ? { ...r, capacity: pool } : r)) };
  }
  if (klass === "WORKER_CONCURRENCY") {
    const workers = parameters["workers"];
    if (workers === undefined) return spec;
    return { ...spec, resources: spec.resources.map((r) => (r.kind === "QUEUE" || r.kind === "CPU" ? { ...r, capacity: workers } : r)) };
  }
  // OFFERED_LOAD changes only the arrival multiplier, handled by the caller.
  return spec;
}

/** Normalised error of a model run against an observed vector; lower is better. */
export function modelError(sim: { throughput: number; p95: number; errorRate: number }, observed: { throughput: number; p95: number; errorRate: number }): number {
  const rel = (a: number, b: number) => (Math.abs(b) > 1e-9 ? Math.abs(a - b) / Math.abs(b) : Math.abs(a - b));
  return (rel(sim.throughput, observed.throughput) + rel(sim.p95, observed.p95) + Math.abs(sim.errorRate - observed.errorRate)) / 3;
}
