// Gateway handlers for the Wave 1 operations (B, C, D, E, F, H). Each handler checks the caller owns the request, delegates to the
// owning module and maps FeatureError to a typed ApiError. Anything not registered here still answers with its stub (routes.ts).
import { createHash } from "node:crypto";
import type { CallContext } from "@cie/schema";
import type { Service } from "../service.ts";
import { PRIORITY } from "../jobs.ts";
import { loadAuthority, type AuthorityConfig } from "./authority.ts";
import { confirmAcceptance } from "./acceptance.ts";
import { confirmReleasePlan, draftReleasePlan } from "./declarations.ts";
import { cancelFeature } from "./cancel.ts";
import { materializeCandidate, readCandidateFile, refreshStaleness, type CandidateDeps, type FeatureEdit } from "./candidate.ts";
import { loadFeatureConfig, type FeatureConfig } from "./config.ts";
import { recordDecision, requestIdOf, reviseContract } from "./decisions.ts";
import { FeatureError, guarded } from "./errors.ts";
import { FeatureModelAdapter, ModelGenerationError } from "./model.ts";
import { discoverFeatureContext, submitFeature, type IntakeDeps } from "./intake.ts";
import { advanceStage, reconcileAll, resumeRequest } from "./lifecycle.ts";
import type { Handlers } from "./routes.ts";
import { SqliteFeatureStore } from "./store.ts";
import { compileChangeGraph, featureReview } from "./presentation.ts";
import { validationHandlers } from "./validation-handlers.ts";
import { gateDriverFor, securityHandlers, type GateHooks } from "./security-handlers.ts";
import { perfHandlers, type PerfHooks } from "./perf-handlers.ts";
import { issueHandlers, type IssueHooks } from "./issue-handlers.ts";
import { patchHandlers } from "./delivery-handlers.ts";
import { builderHandlers } from "./builder-handlers.ts";
import { coordinationHandlers } from "./coordination-handlers.ts";
import { pipelineHandlers, type PipelineHooks } from "./pipeline-handlers.ts";
import { opsHandlers } from "./ops-handlers.ts";
import { publishHandlers, type PublishHooks } from "./publish-handlers.ts";
import { requirementHandlers, type RequirementHooks } from "./requirement-handlers.ts";
import type { FeatureRecord, FeatureWorkspace, Id, Outcome } from "./types.ts";

const str = (v: unknown, what: string): string => { if (typeof v !== "string" || !v) throw new FeatureError("INVALID_SCHEMA", `${what} is required`); return v; };
const obj = (b: unknown): Record<string, any> => { if (!b || typeof b !== "object" || Array.isArray(b)) throw new FeatureError("INVALID_SCHEMA", "the request body must be an object"); return b as Record<string, any>; };

export function featureHandlers(svc: Service, opts: { gates?: GateHooks; perf?: PerfHooks; issues?: IssueHooks; requirements?: RequirementHooks; publish?: PublishHooks; builder?: { routes?: readonly import("../llm-router.ts").GenerationRouter[] }; pipeline?: PipelineHooks; requireFence?: boolean } = {}): Handlers {
  const fs = new SqliteFeatureStore(svc.store);
  const isActive = (id: string) => { const j = svc.store.job(id); return !!j && (j.state === "QUEUED" || j.state === "RUNNING"); };
  try { reconcileAll(fs, "system", isActive); } catch { /* a closed or older database: nothing to reconcile */ }

  const cfgOf = (root: string): FeatureConfig => { try { return loadFeatureConfig(root); } catch (e) { throw new FeatureError("INVALID_SCHEMA", `feature configuration is invalid: ${(e as Error).message}`); } };
  const authOf = (root: string): AuthorityConfig => { try { return loadAuthority(root, cfgOf(root).authorityFile); } catch (e) { if (e instanceof FeatureError) throw e; throw new FeatureError("INVALID_SCHEMA", `authority file is invalid: ${(e as Error).message}`); } };
  const intake: IntakeDeps = { fs, store: svc.store, config: cfgOf };
  const owned = (requestId: Id, actor: Id): FeatureRecord => {
    const rec = fs.getRequest(str(requestId, "requestId"));
    // A request that is not yours reads as absent, so ids cannot be probed.
    if (!rec || rec.createdBy !== actor) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
    return rec;
  };
  const who = (c: CallContext) => c.actor.principalId;

  return {
    ...validationHandlers(svc, fs, owned, gateDriverFor(opts.gates ?? {}, fs)),
    ...perfHandlers(svc, fs, owned, opts.perf ?? {}),
    ...issueHandlers(svc, fs, owned, opts.issues ?? {}),
    ...requirementHandlers(svc, fs, owned, opts.requirements ?? {}),
    ...securityHandlers(svc, fs, owned, opts.gates ?? {}),
    ...patchHandlers(svc, fs, owned),
    ...opsHandlers(svc, fs, owned),
    ...pipelineHandlers(svc, fs, { gates: opts.gates, publish: opts.publish, adapter: opts.requirements?.adapter, ...opts.pipeline }),
    ...builderHandlers(svc, fs, opts.builder),
    ...coordinationHandlers(svc, fs, { forge: opts.issues?.forge, authOf, requireFence: opts.requireFence }),
    ...publishHandlers(svc, fs, opts.publish ?? {}),
    "C19/compileChangeGraph": (c, b) => guarded(c, () => {
      const x = obj(b); const rec = owned(x.requestId, who(c));
      const cand = x.candidateHash ? fs.getCandidateByBinding(x.candidateHash) : null;
      if (x.candidateHash && (!cand || cand.requestId !== rec.requestId)) throw new FeatureError("NOT_FOUND", "no such candidate for this request");
      return compileChangeGraph(rec, featureReview(fs, rec, cand, svc.store).files, { candidateHash: x.candidateHash, filters: x.filters, cursor: x.cursor, budget: x.budget ?? { nodes: 90 } });
    }),
    "C02/submitFeature": (c, b) => guarded(c, () => { const x = obj(b); return submitFeature(intake, who(c), { inputRefs: x.inputRefs ?? [], text: x.text, repositoryId: str(x.repositoryId, "repositoryId"), mode: x.mode, budget: x.budget, idempotencyKey: c.idempotencyKey }); }),
    "C10/discoverFeatureContext": (c, b) => guarded(c, () => { const x = obj(b); owned(x.requestId, who(c)); return discoverFeatureContext(intake, who(c), { requestId: x.requestId, snapshot: x.snapshot ?? fs.getRequest(x.requestId)!.source, retrievalBudget: x.retrievalBudget }); }),
    "C02/resumeRequest": (c, b) => guarded(c, () => { const x = obj(b); owned(x.requestId, who(c)); return resumeRequest(fs, x.requestId, who(c), isActive); }),
    "C02/recordDecision": (c, b) => guarded(c, () => {
      const x = obj(b); const requestId = requestIdOf(str(x.contractId, "contractId")); const rec = owned(requestId, who(c));
      return recordDecision(fs, authOf(rec.repositoryId), who(c), { requestId, expectedContractVersion: x.expectedVersion, questionId: str(x.questionId, "questionId"), answer: x.answer, kind: x.kind, authorityBindingId: x.authorityBindingId, rationale: x.rationale, waiver: x.waiver, supersedes: x.supersedes, idempotencyKey: c.idempotencyKey });
    }),
    "C15/reviseContract": (c, b) => guarded(c, () => {
      const x = obj(b); const requestId = requestIdOf(str(x.contractId, "contractId")); const rec = owned(requestId, who(c));
      if (!Array.isArray(x.decisionIds)) throw new FeatureError("INVALID_SCHEMA", "decisionIds must be a list");
      return reviseContract(fs, authOf(rec.repositoryId), who(c), { requestId, expectedVersion: x.expectedVersion, decisionIds: x.decisionIds });
    }),
    "C15/draftReleasePlan": (c, b) => guarded(c, () => { const x = obj(b); const requestId = requestIdOf(str(x.contractId, "contractId")); owned(requestId, who(c)); return draftReleasePlan(fs, who(c), { requestId, plan: x.plan }); }),
    "C15/confirmReleasePlan": (c, b) => guarded(c, () => { const x = obj(b); const requestId = requestIdOf(str(x.contractId, "contractId")); const rec = owned(requestId, who(c)); return confirmReleasePlan(fs, authOf(rec.repositoryId), who(c), { requestId }); }),
    "C15/confirmAcceptance": (c, b) => guarded(c, () => {
      const x = obj(b); const requestId = requestIdOf(str(x.contractId, "contractId")); const rec = owned(requestId, who(c));
      return confirmAcceptance(fs, authOf(rec.repositoryId), who(c), { requestId, expectedVersion: x.expectedVersion, criteria: x.criteria, rationale: x.rationale, idempotencyKey: c.idempotencyKey });
    }),
    // Long operation: returns a durable job id at once; the job result is the PatchBinding (spec §19).
    "C28/materializeCandidate": (c, b) => guarded(c, () => {
      const x = obj(b); const rec = owned(x.requestId, who(c));
      if (!Array.isArray(x.edits)) throw new FeatureError("INVALID_SCHEMA", "edits must be a list");
      const d: CandidateDeps = { fs, store: svc.store, auth: authOf(rec.repositoryId), requireFence: opts.requireFence };
      const work = createHash("sha256").update(JSON.stringify([x.edits, x.scope ?? null, c.idempotencyKey])).digest("hex");
      const job = svc.jobs.enqueue(c, {
        kind: "feature-build", lane: "runner", priority: PRIORITY.VALIDATION, fenceKey: `surface:${rec.requestId}`, params: { repositoryId: rec.repositoryId, analysisId: rec.requestId, headHash: work },
        run: async (ctx, control) => {
          control.checkpoint(); control.commit(); // building writes the candidate in one step; a replaced holder is refused here
          return guarded(ctx, () => materializeCandidate(d, who(c), { requestId: rec.requestId, snapshot: x.snapshot, edits: x.edits as FeatureEdit[], scope: x.scope, invocationIds: x.invocationIds, idempotencyKey: c.idempotencyKey, fence: x.fence }).candidate.binding);
        },
      });
      return { jobId: job.id, result: undefined };
    }),
    "C28/readCandidateFile": (c, b) => guarded(c, () => {
      const x = obj(b); const cand = fs.getCandidateByBinding(str(x.candidateHash, "candidateHash"));
      if (!cand) throw new FeatureError("NOT_FOUND", "no such candidate"); const rec = owned(cand.requestId, who(c));
      return readCandidateFile({ fs, store: svc.store, auth: authOf(rec.repositoryId) }, { candidateHash: x.candidateHash, path: x.path, range: x.range, representation: x.representation ?? "CANDIDATE", download: x.download === true });
    }),
    // 1.G's frozen C14 signature, bound to the caller's own request by the adapter.
    "C14/recordModelInvocation": (c, b) => guarded(c, () => {
      const x = obj(b); const rec = owned(x.requestId, who(c));
      if (!x.modelIdentity || typeof x.modelIdentity !== "object" || !Array.isArray(x.inputRefs) || typeof x.outputHash !== "string") throw new FeatureError("INVALID_SCHEMA", "modelIdentity, inputRefs and outputHash are required");
      try { return new FeatureModelAdapter(fs, rec.requestId, { egress: cfgOf(rec.repositoryId).egress }).recordModelInvocation(c, { modelIdentity: x.modelIdentity, inputRefs: x.inputRefs, parameters: x.parameters ?? {}, outputHash: x.outputHash }); }
      catch (e) { if (e instanceof ModelGenerationError) throw new FeatureError(e.code === "FORBIDDEN" ? "FORBIDDEN" : e.code === "INVOCATION_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "INVALID_SCHEMA", e.code); throw e; }
    }),
    "C07/cancelFeature": (c, b) => guarded(c, () => { const x = obj(b); owned(x.requestId, who(c)); return cancelFeature(fs, svc.jobs, who(c), { requestId: x.requestId, reason: x.reason }); }),
    // Version-gated read (plan P6): a caller that already has `sinceWorkspaceVersion` gets NOT_MODIFIED instead of the whole workspace.
    "C01/openFeatureWorkspace": (c, b) => guarded(c, (): Outcome<FeatureWorkspace> => {
      const x = obj(b); let rec = owned(x.requestId, who(c));
      if (rec.workspace.candidateHash && refreshStaleness({ fs, store: svc.store, auth: authOf(rec.repositoryId) }, who(c), rec.requestId).length) rec = fs.updateRequest(rec.requestId, rec.version, { ...rec, workspace: { ...rec.workspace, workspaceVersion: rec.workspace.workspaceVersion + 1 } });
      if (x.sinceWorkspaceVersion === rec.workspace.workspaceVersion) return { status: "COMPLETE", evidenceIds: [], diagnostics: ["NOT_MODIFIED"] };
      const cand = rec.workspace.candidateHash ? fs.getCandidateByBinding(rec.workspace.candidateHash) : null;
      return { status: "COMPLETE", evidenceIds: [], diagnostics: [], value: { ...rec.workspace, contractVersion: rec.contractVersion, state: rec.state, mode: rec.mode, candidateStatus: cand?.status, issueRef: rec.issue.number ? `${rec.issue.repository}#${rec.issue.number}` : undefined, review: featureReview(fs, rec, cand, svc.store) } };
    }),
    "C02/advanceWizard": (c, b) => guarded(c, (): Outcome<FeatureWorkspace> => {
      const x = obj(b); owned(x.requestId, who(c));
      return { status: "COMPLETE", value: advanceStage(fs, x.requestId, who(c), x.targetStage, x.expectedWorkspaceVersion), evidenceIds: [], diagnostics: [] };
    }),
  };
}
