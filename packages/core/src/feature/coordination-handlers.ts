// Gateway handlers for task 3.T.
import type { Service } from "../service.ts";
import type { AuthorityConfig } from "./authority.ts";
import { assessConcurrentChanges, integrateCandidates, assessRetirement, getMutationOrigins, relateRequests, reserveMutationSurfaces } from "./coordination.ts";
import { FeatureError, guarded, guardedAsync } from "./errors.ts";
import { GhIssueForge, type IssueForge } from "./issue-forge.ts";
import { syncCapabilityRelations } from "./relation-sync.ts";
import type { Handlers } from "./routes.ts";
import type { SqliteFeatureStore } from "./store.ts";

const obj = (b: unknown): Record<string, any> => { if (!b || typeof b !== "object" || Array.isArray(b)) throw new FeatureError("INVALID_SCHEMA", "the request body must be an object"); return b as Record<string, any>; };

export function coordinationHandlers(svc: Service, fs: SqliteFeatureStore, hooks: { forge?: IssueForge; now?: () => number; authOf?: (root: string) => AuthorityConfig; requireFence?: boolean } = {}): Handlers {
  const d = { fs, store: svc.store, now: hooks.now }; let forge = hooks.forge; const who = (c: { actor: { principalId: string } }) => c.actor.principalId;
  return {
    "C07/reserveMutationSurfaces": (c, b) => guarded(c, () => { const x = obj(b); return reserveMutationSurfaces(d, who(c), { requestId: x.requestId, surfaceIds: x.surfaceIds, expectedRevision: x.expectedRevision, ttlMs: x.ttlMs }); }),
    "C07/relateRequests": (c, b) => guarded(c, () => { const x = obj(b); return relateRequests(d, who(c), { fromRequestId: x.fromRequestId, toRequestId: x.toRequestId, relationship: x.relationship, sourceRefs: x.sourceRefs }); }),
    "C23/assessConcurrentChanges": (c, b) => guarded(c, () => { const x = obj(b); return assessConcurrentChanges(d, who(c), { requestIds: x.requestIds, candidateBindings: x.candidateBindings, snapshot: x.snapshot }); }),
    "C23/integrateCandidates": (c, b) => guarded(c, () => {
      const x = obj(b); if (!hooks.authOf) throw new FeatureError("BLOCKED", "integration needs the authority configuration");
      const target = fs.getRequest(x.targetRequestId); if (!target || target.createdBy !== who(c)) throw new FeatureError("NOT_FOUND", "no such request");
      return integrateCandidates({ ...d, auth: hooks.authOf(target.repositoryId), requireFence: hooks.requireFence }, who(c), { requestIds: x.requestIds, candidateBindings: x.candidateBindings, snapshot: x.snapshot, targetRequestId: x.targetRequestId, idempotencyKey: c.idempotencyKey, fence: x.fence });
    }),
    "C23/assessRetirement": (c, b) => guarded(c, () => { const x = obj(b); return assessRetirement(d, who(c), { requestId: x.requestId, candidateHash: x.candidateHash }); }),
    "C23/getMutationOrigins": (c, b) => guarded(c, () => { const x = obj(b); return getMutationOrigins(d, who(c), { repositoryId: x.repositoryId, path: x.path, revision: x.revision }); }),
    "C30/syncCapabilityRelations": (c, b) => guardedAsync(c, async () => { const x = obj(b); return syncCapabilityRelations({ ...d, forge: (forge ??= new GhIssueForge()) }, who(c), { requestId: x.requestId, assessmentId: x.assessmentId, relationIds: x.relationIds }); }),
  };
}
