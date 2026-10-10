import type { Store } from "../store.ts";
import { assessFeatureImpact, planClarifications } from "./clarify.ts";
import { checkRequirementConstraints, detectSemanticConflicts } from "./conflicts.ts";
import { discoverFeatureContext, snapshotOf } from "./intake.ts";
import { FeatureError } from "./errors.ts";
import type { FeatureModelAdapter } from "./model.ts";
import { alreadySupported, compareRequestedBehaviour, findRelatedCapabilities, overlapPolicyHash, verifyOverlap } from "./overlap.ts";
import { planFeatureChange } from "./plan.ts";
import { normalizeRequirements } from "./requirements.ts";
import type { SqliteFeatureStore } from "./store.ts";

/** Analysis only. Stops for questions; never generates edits or confirms expected outcomes for the user. */
export async function prepareFeature(fs: SqliteFeatureStore, store: Store, actor: string, requestId: string, adapter: FeatureModelAdapter, checkpoint: () => void, signal?: AbortSignal) {
  const req = () => { const r = fs.getRequest(requestId); if (!r || r.createdBy !== actor) throw new FeatureError("NOT_FOUND", "No such request"); return r; };
  checkpoint();
  if (!req().contract) {
    if (!req().assessment) {
      const discovery = discoverFeatureContext({ fs, store }, actor, { requestId, snapshot: snapshotOf(store, req().repositoryId), retrievalBudget: { files: 5000, tokens: 8000 } });
      if (!discovery.value || ["STALE", "FAILED"].includes(discovery.status)) throw new FeatureError("BLOCKED", discovery.diagnostics.join("; ") || "Repository discovery needs attention");
    }
    const r = req();
    if (!r.assessment) throw new FeatureError("BLOCKED", "Discovery did not record an assessment");
    const result = await normalizeRequirements({ fs, store, adapter: () => adapter }, actor, { requestId, sourceRefs: [], assessmentId: r.assessment.id, signal });
    if (!result.value) throw new FeatureError("PROVIDER_UNAVAILABLE", result.diagnostics.join("; "));
  }
  checkpoint(); signal?.throwIfAborted();
  const hash = req().contract!.hash, d = { fs, store }, constraints = { fs, repoRoot: () => req().repositoryId };
  const cons = await checkRequirementConstraints(constraints, actor, { contractHash: hash, policyHashes: [], invariantIds: [] });
  const conf = await detectSemanticConflicts(constraints, actor, { contractHash: hash, relatedSourceRefs: [], signal });
  checkpoint();
  const questions = planClarifications(fs, actor, { contractHash: hash, findingIds: [...(cons.value ?? []), ...(conf.value ?? [])].map((f) => f.id), obligationIds: [] });
  if (questions.value?.questions.length || req().blockers.length) return { status: "NEEDS_ANSWER", requestId, detail: "Answer the required questions before agreeing the plan" };
  const related = findRelatedCapabilities(d, actor, { contractHash: hash, snapshot: req().source, scope: "", budget: { files: 300 } });
  const comparison = compareRequestedBehaviour(d, actor, { contractHash: hash, capabilityRefs: related.value?.capabilities ?? [], evidenceIds: [] });
  if (comparison.value) verifyOverlap(d, actor, { assessmentId: comparison.value.id, policyHash: overlapPolicyHash(), evidenceIds: [] });
  if (alreadySupported(req())) return { status: "ALREADY_SUPPORTED", requestId, detail: "The repository already supports this feature within the assessed scope" };
  checkpoint();
  const impact = assessFeatureImpact(fs, store, actor, { contractHash: hash, snapshot: req().source });
  if (!impact.value || impact.status === "STALE") throw new FeatureError("STALE_REVISION", "Repository changed during planning");
  planFeatureChange(d, actor, { contractHash: hash, impactAssessmentId: impact.value.id, capabilities: [] });
  return { status: "READY", requestId, detail: "Review the plan and confirm its expected outcomes" };
}
