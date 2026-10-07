import { Store } from "../src/store.ts";
import { SqliteFeatureStore } from "../src/feature/store.ts";
import { eventFor } from "../src/feature/lifecycle.ts";
import type { FeatureRecord } from "../src/feature/types.ts";

export const SNAP = { repositoryId: "repo", commitHash: "c".repeat(40), contentRootHash: "pf-canon-v1/pf.contentRoot@1:" + "a".repeat(64), indexGeneration: 1, toolchainHash: "t" };
export function record(over: Partial<FeatureRecord> = {}): FeatureRecord {
  const requestId = over.requestId ?? `req:${Math.random().toString(36).slice(2)}`;
  const workspace = { requestId, stage: "DESCRIBE" as const, blockers: [], runningJobIds: [], workspaceVersion: 0, ...(over.workspace ?? {}) };
  return {
    schemaVersion: 1, requestId, repositoryId: "repo", mode: "PLAN", state: "RECEIVED", promptRef: { artifactId: "a", contentHash: "h".repeat(64), redactedPreview: "add csv export" },
    inputRefs: [], source: SNAP, contractVersion: 0, tasks: [], blockers: [], issue: { repository: "", syncState: "UNBOUND", lastSyncedSequence: 0, projectionRevision: 0 },
    version: 0, createdBy: "u", createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z", ...over,
    workspace,
  };
}
export function fresh() {
  const store = new Store(":memory:"); const fs = new SqliteFeatureStore(store);
  const make = (over: Partial<FeatureRecord> = {}, key = Math.random().toString(36)) => { const r = record(over); return fs.createRequest(r, eventFor(r, "FeatureSubmitted", "u"), key).record; };
  return { store, fs, make };
}
