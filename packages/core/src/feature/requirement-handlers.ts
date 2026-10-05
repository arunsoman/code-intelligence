// Gateway handlers for task 2.I. Each operation is owner-scoped by construction: contracts and assessments are looked up among the
// caller's own requests, so another principal's ids read as absent.
import type { Service } from "../service.ts";
import { assessFeatureImpact, planClarifications } from "./clarify.ts";
import { checkRequirementConstraints, detectSemanticConflicts, type FindingProposer } from "./conflicts.ts";
import { FeatureError, guarded, guardedAsync } from "./errors.ts";
import type { Handlers } from "./routes.ts";
import { assessReuseImpact, compareRequestedBehaviour, findRelatedCapabilities, investigateOverlap, verifyOverlap } from "./overlap.ts";
import { planFeatureChange, planReuseChange } from "./plan.ts";
import { normalizeRequirements } from "./requirements.ts";
import type { FeatureModelAdapter } from "./model.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { FeatureRecord, Id } from "./types.ts";

export interface RequirementHooks { adapter?: (requestId: Id) => FeatureModelAdapter; proposer?: (requestId: Id, actor: Id) => FindingProposer | undefined }

export function requirementHandlers(svc: Service, fs: SqliteFeatureStore, owned: (id: string, actor: string) => FeatureRecord, hooks: RequirementHooks = {}): Handlers {
  const obj = (b: unknown): Record<string, any> => { if (!b || typeof b !== "object" || Array.isArray(b)) throw new FeatureError("INVALID_SCHEMA", "the request body must be an object"); return b as Record<string, any>; };
  const who = (c: { actor: { principalId: string } }) => c.actor.principalId;
  const od = { fs, store: svc.store };
  const cdeps = (actor: Id, requestHint?: Id) => ({ fs, repoRoot: (rec: FeatureRecord) => rec.repositoryId, proposer: hooks.proposer?.(requestHint ?? "", actor) });
  return {
    "C15/normalizeRequirements": (c, b) => guardedAsync(c, async () => { const x = obj(b); owned(x.requestId, who(c)); return normalizeRequirements({ fs, store: svc.store, adapter: hooks.adapter }, who(c), { requestId: x.requestId, sourceRefs: x.sourceRefs ?? [], assessmentId: x.assessmentId }); }),
    "C15/detectSemanticConflicts": (c, b) => guardedAsync(c, async () => { const x = obj(b); return detectSemanticConflicts(cdeps(who(c)), who(c), { contractHash: x.contractHash, relatedSourceRefs: x.relatedSourceRefs ?? [] }); }),
    "C25/checkRequirementConstraints": (c, b) => guardedAsync(c, async () => { const x = obj(b); return checkRequirementConstraints(cdeps(who(c)), who(c), { contractHash: x.contractHash, policyHashes: x.policyHashes ?? [], invariantIds: x.invariantIds ?? [] }); }),
    "C23/assessFeatureImpact": (c, b) => guarded(c, () => { const x = obj(b); return assessFeatureImpact(fs, svc.store, who(c), { contractHash: x.contractHash, snapshot: x.snapshot }); }),
    "C22/planClarifications": (c, b) => guarded(c, () => { const x = obj(b); return planClarifications(fs, who(c), { contractHash: x.contractHash, findingIds: x.findingIds ?? [], obligationIds: x.obligationIds ?? [] }); }),
    "C10/findRelatedCapabilities": (c, b) => guarded(c, () => { const x = obj(b); return findRelatedCapabilities(od, who(c), { contractHash: x.contractHash, snapshot: x.snapshot, scope: x.scope ?? "", budget: x.budget }); }),
    "C15/compareRequestedBehaviour": (c, b) => guarded(c, () => { const x = obj(b); return compareRequestedBehaviour(od, who(c), { contractHash: x.contractHash, capabilityRefs: x.capabilityRefs ?? [], evidenceIds: x.evidenceIds ?? [] }); }),
    "C22/investigateOverlap": (c, b) => guarded(c, () => { const x = obj(b); return investigateOverlap(od, who(c), { assessmentId: x.assessmentId, unknownIds: x.unknownIds ?? [], budget: x.budget }); }),
    "C23/assessReuseImpact": (c, b) => guarded(c, () => { const x = obj(b); return assessReuseImpact(od, who(c), { assessmentId: x.assessmentId, strategy: x.strategy, snapshot: x.snapshot }); }),
    "C28/planFeatureChange": (c, b) => guarded(c, () => { const x = obj(b); return planFeatureChange(od, who(c), { contractHash: x.contractHash, impactAssessmentId: x.impactAssessmentId, capabilities: x.capabilities ?? [] }); }),
    "C28/planReuseChange": (c, b) => guarded(c, () => { const x = obj(b); return planReuseChange(od, who(c), { contractHash: x.contractHash, verifiedAssessmentId: x.verifiedAssessmentId, capabilities: x.capabilities ?? [] }); }),
    "C16/verifyOverlap": (c, b) => guarded(c, () => { const x = obj(b); return verifyOverlap(od, who(c), { assessmentId: x.assessmentId, policyHash: x.policyHash, evidenceIds: x.evidenceIds ?? [] }); }),
  };
}
