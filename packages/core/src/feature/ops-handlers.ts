// Gateway handlers for task 3.S.
import type { Service } from "../service.ts";
import { FeatureError, guarded } from "./errors.ts";
import { anomalyChecklist, operationalAssessment, operationalReadiness } from "./operations.ts";
import type { Handlers } from "./routes.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { FeatureRecord } from "./types.ts";
import { defaultValidationPlan, validationPlanHash } from "./validation.ts";

const obj = (b: unknown): Record<string, any> => { if (!b || typeof b !== "object" || Array.isArray(b)) throw new FeatureError("INVALID_SCHEMA", "the request body must be an object"); return b as Record<string, any>; };

export function opsHandlers(_svc: Service, fs: SqliteFeatureStore, owned: (id: string, actor: string) => FeatureRecord): Handlers {
  return {
    "C32/assessOperationalReadiness": (c, b) => guarded(c, () => {
      const x = obj(b); const cand = typeof x.patchBindingHash === "string" ? fs.getCandidateByBinding(x.patchBindingHash) : null;
      if (!cand) throw new FeatureError("NOT_FOUND", "no such candidate"); const rec = owned(cand.requestId, c.actor.principalId);
      if (x.contractHash !== rec.contract?.hash || cand.binding.contractHash !== rec.contract?.hash) throw new FeatureError("STALE_REVISION", "the contract changed; reload");
      if (cand.status !== "MATERIALIZED" || rec.workspace.candidateHash !== cand.bindingHash) throw new FeatureError("STALE_REVISION", "this candidate is no longer the current one");
      if (x.planHash !== validationPlanHash(rec.validationPlan ?? defaultValidationPlan(rec, cand))) throw new FeatureError("STALE_REVISION", "the validation plan changed; reload");
      const r = operationalReadiness(cand, rec);
      return { status: r.status === "PASS" || r.status === "NOT_APPLICABLE" ? "COMPLETE" : "PARTIAL", value: operationalAssessment(r, `ops:${cand.bindingHash.split(":").pop()!.slice(0, 16)}`), evidenceIds: [cand.id], diagnostics: r.gaps } as const;
    }),
    "C22/investigateProductionAnomaly": (c, b) => guarded(c, () => { const x = obj(b); owned(x.requestId, c.actor.principalId); if (typeof x.deploymentId !== "string" || !x.deploymentId) throw new FeatureError("INVALID_SCHEMA", "deploymentId is required"); return anomalyChecklist({ requestId: x.requestId, deploymentId: x.deploymentId, evidenceIds: Array.isArray(x.evidenceIds) ? x.evidenceIds : [] }); }),
  };
}
