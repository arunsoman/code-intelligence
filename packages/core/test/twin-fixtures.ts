// Shared F10 test fixtures: a synthetic workflow with a pool, a queue and an external boundary.
import type { EnvironmentSpec, TwinStructure } from "@cie/schema";
import type { BaselineInput, ObservedSpan } from "../src/twin-baseline.ts";

export function makeStructure(): TwinStructure {
  return {
    entryStationId: "api",
    stations: [
      { id: "api", name: "api", entityId: "e:api", evidence: "MEASURED", resourceIds: ["svc"], unresolved: false, material: false, category: "CPU" },
      { id: "fraud", name: "fraud.check", entityId: "e:fraud", evidence: "MEASURED", resourceIds: [], unresolved: false, material: false, category: "IO" },
      { id: "ledger", name: "ledger.reserve", entityId: "e:ledger", evidence: "MEASURED", resourceIds: ["db"], unresolved: false, material: false, category: "POOL" },
      { id: "publish", name: "events.publish", entityId: "e:publish", evidence: "MODELLED", resourceIds: ["queue"], unresolved: false, material: false, category: "QUEUE" },
    ],
    resources: [
      { id: "svc", kind: "CPU", capacity: null, source: "environment.cores" },
      { id: "db", kind: "POOL", capacity: 8, source: "config/db.poolSize" },
      { id: "queue", kind: "QUEUE", capacity: 4, source: "config/worker.concurrency" },
    ],
    branches: [
      { id: "b1", stationId: "api", probabilitySource: "measured", to: "fraud" },
      { id: "b2", stationId: "fraud", probabilitySource: "measured", to: "ledger" },
      { id: "b3", stationId: "ledger", probabilitySource: "measured", to: "publish" },
    ],
    externals: [{ id: "gateway", name: "gateway.authorize", matchingKeys: ["idempotencyKey"], unmatchedBehaviour: "fail closed with a gap" }],
    unresolved: [{ id: "u:dynamic", description: "dynamic dispatch in the router", material: false, stationId: "api" }],
  };
}

export function makeEnvironment(): EnvironmentSpec {
  return { platform: "linux-x64", runtimeVersion: "node-24", cores: 4, memoryBytes: 8 * 1024 ** 3, isolationProfile: "container/v1", clockModel: "monotonic", cachePolicy: "COLD", resetPolicy: "restart", poolSizes: { db: 8, queue: 4 }, permittedNetworkTargets: [], weakMemoryModel: false };
}

/** Build a synthetic observed baseline of `n` requests over `durationSec`, with service times per station. */
export function makeBaselineInput(n = 240, durationSec = 60): BaselineInput {
  const service: Record<string, [number, number]> = { api: [2, 4], fraud: [4, 8], ledger: [8, 20], publish: [3, 30] };
  const spans: ObservedSpan[] = [];
  const stepMs = (durationSec * 1000) / n;
  for (let i = 0; i < n; i++) {
    const arrival = i * stepMs;
    let cursor = arrival;
    for (const stationId of ["api", "fraud", "ledger", "publish"]) {
      const [lo, hi] = service[stationId];
      const latency = lo + ((i * 7 + stationId.length * 13) % Math.max(1, Math.round((hi - lo) * 10))) / 10;
      spans.push({ id: `sp:${i}:${stationId}`, requestId: `r${i}`, parentId: null, stationId, entityId: "createPayment", startMs: cursor, endMs: cursor + latency, category: "CPU", samplingRate: 1, instance: "i-1" });
      cursor += latency;
    }
  }
  return { spans, durationSec, windowIds: ["w:1"], revision: "rev-1", samplingRate: 1, outcomes: {} };
}

/** Two writers of `balance` that are not both inside a transaction, plus an async shared state hand-off. */
export const lineage = {
  writes: [
    { stateKey: "balance", stationId: "ledger", insideTransaction: false, insideLock: false },
    { stateKey: "balance", stationId: "publish", insideTransaction: false, insideLock: false },
  ],
  handoffs: [{ from: "ledger", to: "publish", sharedStateKeys: ["balance"] }],
  lockOrders: [
    { heldLockId: "db", acquiredLockId: "queue", path: "ledger->publish" },
    { heldLockId: "queue", acquiredLockId: "db", path: "publish->ledger" },
  ],
};
