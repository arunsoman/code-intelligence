// Gateway handlers for task 3.Q (patch export, destination check, isolated apply).
import type { Service } from "../service.ts";
import { PRIORITY } from "../jobs.ts";
import { FeatureError, guarded } from "./errors.ts";
import { applyPatchCandidate, checkPatchDestination, exportFeaturePatch } from "./patch-export.ts";
import type { Handlers } from "./routes.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { FeatureRecord } from "./types.ts";

const obj = (b: unknown): Record<string, any> => { if (!b || typeof b !== "object" || Array.isArray(b)) throw new FeatureError("INVALID_SCHEMA", "the request body must be an object"); return b as Record<string, any>; };

export function patchHandlers(svc: Service, fs: SqliteFeatureStore, _owned: (id: string, actor: string) => FeatureRecord): Handlers {
  const deps = { fs, store: svc.store };
  const who = (c: { actor: { principalId: string } }) => c.actor.principalId;
  return {
    "C28/exportFeaturePatch": (c, b) => guarded(c, () => { const x = obj(b); return exportFeaturePatch(deps, who(c), { candidateHash: x.candidateHash, decisionId: x.decisionId, format: x.format, exportPolicyHash: x.exportPolicyHash }); }),
    "C28/checkPatchDestination": (c, b) => guarded(c, () => { const x = obj(b); return checkPatchDestination(deps, who(c), { exportId: x.exportId, destinationSnapshot: x.destinationSnapshot, dirtyState: x.dirtyState ?? [] }); }),
    // Long operation: the job result is the ApplicationReceipt. The destination is never written; the result lands in a new scratch copy.
    "C28/applyPatchCandidate": (c, b) => guarded(c, () => {
      const x = obj(b); const key = c.idempotencyKey;
      const job = svc.jobs.enqueue(c, {
        kind: "feature-apply", lane: "runner", priority: PRIORITY.VALIDATION, fenceKey: `apply:${x.exportId}`, params: { repositoryId: x.destinationSnapshot?.repositoryId ?? "", analysisId: String(x.exportId), headHash: key },
        run: async (ctx, control) => { control.checkpoint(); control.commit(); return guarded(ctx, () => applyPatchCandidate(deps, who(c), { exportId: x.exportId, destinationSnapshot: x.destinationSnapshot, assessmentId: x.assessmentId, capabilities: x.capabilities ?? [], dirtyState: x.dirtyState, idempotencyKey: key })); },
      });
      return { jobId: job.id, result: undefined };
    }),
  };
}
