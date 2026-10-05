import type { Service } from "../service.ts";
import { Cancelled, PRIORITY } from "../jobs.ts";
import { FeatureError, guarded, guardedAsync } from "./errors.ts";
import { LocalRunner } from "./runner.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { CandidateRecord, FeatureRecord, Outcome, ValidationPage } from "./types.ts";
import type { RunCheck } from "./gates.ts";
import type { Handlers } from "./routes.ts";
import { computeEligibility, defaultValidationPlan, runFeatureValidation, validationHash, validationPlanHash } from "./validation.ts";
export function validationHandlers(svc: Service, fs: SqliteFeatureStore, owned: (id: string, actor: string) => FeatureRecord, driver?: (candidate: CandidateRecord, request: FeatureRecord) => RunCheck | undefined): Handlers {
  const bound = (hash: string, actor: string) => { if (typeof hash !== "string" || !hash) throw new FeatureError("INVALID_SCHEMA", "candidateBindingHash is required"); const candidate = fs.getCandidateByBinding(hash); if (!candidate) throw new FeatureError("NOT_FOUND", "no such candidate"); return { candidate, request: owned(candidate.requestId, actor) }; };
  return {
    "C27/runValidation": (ctx, body) => guarded(ctx, () => {
      const { candidate, request } = bound(body.patchBindingHash, ctx.actor.principalId);
      const plan = request.validationPlan ?? defaultValidationPlan(request, candidate);
      if (validationPlanHash(plan) !== body.validationPlanHash) throw new FeatureError("STALE_REVISION", "the validation plan changed; reload before running");
      if (!body.budget || !Number.isSafeInteger(body.budget.wallMs) || body.budget.wallMs < 1 || body.budget.wallMs > 1800000) throw new FeatureError("INVALID_SCHEMA", "a bounded validation wall budget is required");
      const job = svc.jobs.enqueue(ctx, { kind: "feature-validate", lane: "runner", priority: PRIORITY.VALIDATION, fenceKey: `validation:${request.requestId}`, params: { repositoryId: request.repositoryId, analysisId: request.requestId, headHash: validationHash("pf.ValidationJob", { candidate: candidate.bindingHash, plan: body.validationPlanHash, key: ctx.idempotencyKey }) }, run: async (c, control) => {
        const abort = new AbortController(); const unsubscribe = control.onCancel(() => abort.abort());
        try { return await guardedAsync(c, async () => {
          control.checkpoint();
          const runner = new LocalRunner({ fence: () => control.holdsFence?.() ?? true });
          const evidence = await runFeatureValidation({ store: fs, runner, runCheck: driver?.(candidate, request), beforeSave: () => { if (control.holdsFence && !control.holdsFence()) throw new Cancelled(); control.checkpoint(); } }, { candidateId: candidate.id, plan, actor: c.actor.principalId, wallMs: body.budget.wallMs, signal: abort.signal });
          control.checkpoint(); control.commit();
          return { status: evidence.every((e) => e.results.every((r) => r.status === "PASS" || r.status === "NOT_APPLICABLE")) ? "COMPLETE" : "PARTIAL", value: evidence.flatMap((e) => e.results), evidenceIds: evidence.map((e) => e.id), diagnostics: evidence.flatMap((e) => e.coverage.gaps) };
        }); } finally { unsubscribe(); }
      } });
      return { jobId: job.id };
    }),
    "C27/queryValidationResults": (ctx, body) => guarded(ctx, (): Outcome<ValidationPage> => {
      const { candidate, request } = bound(body.candidateHash, ctx.actor.principalId);
      if (body.contractHash !== request.contract?.hash) throw new FeatureError("STALE_REVISION", "contract changed");
      const all = fs.listEvidence(candidate.id).filter((e) => !e.verdict);
      const plan = request.validationPlan ?? defaultValidationPlan(request, candidate);
      const decision = computeEligibility({ request, candidate, plan, evidence: all, decisions: fs.listDecisions(request.requestId) });
      const results = all.flatMap((e) => e.results.map((r) => candidate.status !== "MATERIALIZED" || e.manifest.contractHash !== request.contract?.hash || e.manifest.harnessHash !== validationPlanHash(plan) ? { ...r, status: "STALE" as const } : r)).filter((r) => (!body.filters?.status || body.filters.status === r.status) && (!body.filters?.kind || body.filters.kind === r.kind));
      const scope = validationHash("pf.ValidationPage", { binding: body.candidateHash, contract: body.contractHash, filters: body.filters ?? {}, results });
      const parts = body.cursor?.split("|"); const offset = parts ? Number(parts[1]) : 0;
      if (parts && (parts[0] !== scope || !Number.isSafeInteger(offset) || offset < 0)) throw new FeatureError("STALE_REVISION", "result cursor is stale");
      return { status: decision.eligibility === "VERIFIED_WITHIN_SCOPE" ? "COMPLETE" : "PARTIAL", value: { results: results.slice(offset, offset + 100), ...(offset + 100 < results.length ? { nextCursor: `${scope}|${offset + 100}` } : {}), coverage: { state: decision.eligibility === "VERIFIED_WITHIN_SCOPE" ? "COMPLETE_WITHIN_SCOPE" : "PARTIAL", gaps: decision.reasons } }, evidenceIds: all.map((e) => e.id), diagnostics: decision.reasons };
    }),
    "C16/verifyFeature": (ctx, body) => guarded(ctx, () => {
      const { candidate, request } = bound(body.patchBindingHash, ctx.actor.principalId);
      if (body.contractHash !== request.contract?.hash) throw new FeatureError("STALE_REVISION", "contract changed");
      if (!Array.isArray(body.validationIds) || !Array.isArray(body.performanceAssessmentIds) || !Array.isArray(body.unresolvedFindingIds)) throw new FeatureError("INVALID_SCHEMA", "explicit evidence and unresolved-finding IDs are required");
      const ids = new Set<string>([...body.validationIds, ...body.performanceAssessmentIds]);
      const evidence = fs.listEvidence(candidate.id).filter((e) => !e.verdict && (ids.has(e.id) || e.results.some((r) => ids.has(r.id))));
      return computeEligibility({ request, candidate, plan: request.validationPlan ?? defaultValidationPlan(request, candidate), evidence, decisions: fs.listDecisions(request.requestId), unresolvedFindingIds: body.unresolvedFindingIds, purpose: body.purpose });
    }),
  };
}
