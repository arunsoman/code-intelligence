// Gateway handlers for task 2.K, and the driver factory 2.J's runValidation uses so the SECURITY and DEPENDENCY gates run
// as real checks instead of reporting "validation adapter unavailable".
import { createHash } from "node:crypto";
import type { Service } from "../service.ts";
import { PRIORITY } from "../jobs.ts";
import { loadAuthority } from "./authority.ts";
import { loadFeatureConfig } from "./config.ts";
import type { AdvisoryAdapter } from "./dependencies.ts";
import { FeatureError, guarded, guardedAsync } from "./errors.ts";
import { composeRunChecks, dependencyGate, dependencyReview, gateRunCheck, scannerPlanHashOf, securityAssessment, securityGate, type GateContext, type RunCheck } from "./gates.ts";
import type { Handlers } from "./routes.ts";
import { loadSecurityPolicy, securityPolicyHash, type SecurityTools } from "./security.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { CandidateRecord, FeatureRecord, Outcome, Runner } from "./types.ts";
import { browserRunCheck } from "./browser-gate.ts";
import { perfRunCheck } from "./perf-handlers.ts";

/** Injectable tools. Empty by default: with none configured the gates say INCOMPLETE rather than pretend. */
export interface GateHooks { tools?: SecurityTools; advisories?: AdvisoryAdapter[]; now?: () => string; /** An audited container or VM runner for browser journeys; without one the BROWSER gate is INCOMPLETE. */ browserRunner?: Runner }

export function gateContextFor(hooks: GateHooks, candidate: CandidateRecord, request: FeatureRecord): GateContext {
  const root = request.repositoryId;
  let auth = { bindings: [] as { id: string; scope: any; principals: string[] }[] };
  try { auth = loadAuthority(root, loadFeatureConfig(root).authorityFile); } catch (e) { throw new FeatureError("INVALID_SCHEMA", `authority or feature configuration is invalid: ${(e as Error).message}`); }
  let policy; try { policy = loadSecurityPolicy(root); } catch (e) { throw new FeatureError("INVALID_SCHEMA", `.cie/security.json is invalid: ${(e as Error).message}`); }
  return { candidate, request, repoRoot: root, auth, policy, tools: hooks.tools, advisories: hooks.advisories, now: hooks.now?.() };
}

/** The driver 2.J passes to runFeatureValidation for this candidate. */
export const gateDriverFor = (hooks: GateHooks, fs: SqliteFeatureStore) => (candidate: CandidateRecord, request: FeatureRecord): RunCheck => composeRunChecks(gateRunCheck(gateContextFor(hooks, candidate, request)), browserRunCheck(request.repositoryId, hooks.browserRunner), perfRunCheck(fs, candidate, request));

export function securityHandlers(svc: Service, fs: SqliteFeatureStore, owned: (id: string, actor: string) => FeatureRecord, hooks: GateHooks = {}): Handlers {
  const bound = (hash: unknown, actor: string) => {
    if (typeof hash !== "string" || !hash) throw new FeatureError("INVALID_SCHEMA", "patchBindingHash is required");
    const candidate = fs.getCandidateByBinding(hash); if (!candidate) throw new FeatureError("NOT_FOUND", "no such candidate");
    return { candidate, request: owned(candidate.requestId, actor) };
  };
  const fresh = (candidate: CandidateRecord, request: FeatureRecord) => {
    const cur = fs.getCandidate(candidate.id);
    if (!cur || cur.status !== "MATERIALIZED" || request.workspace.candidateHash !== candidate.bindingHash) throw new FeatureError("STALE_REVISION", "this candidate is no longer the current one; reload before running the gate");
  };
  return {
    // Long operation: the scan runs as a job so a large candidate never holds the gateway; the result is a SecurityAssessment.
    "C27/runSecurityValidation": (ctx, body) => guarded(ctx, () => {
      const { candidate, request } = bound(body?.patchBindingHash, ctx.actor.principalId); fresh(candidate, request);
      const gc = gateContextFor(hooks, candidate, request);
      if (scannerPlanHashOf(gc.policy, gc.tools, gc.advisories) !== body.scannerPlanHash) throw new FeatureError("STALE_REVISION", "the scanner plan changed (policy or tools); reload before running");
      if (!body.budget || !Number.isSafeInteger(body.budget.wallMs) || body.budget.wallMs < 1 || body.budget.wallMs > 1_800_000) throw new FeatureError("INVALID_SCHEMA", "a bounded wall budget is required");
      const work = createHash("sha256").update(`${candidate.bindingHash}\0${body.scannerPlanHash}\0${ctx.idempotencyKey}`).digest("hex");
      const job = svc.jobs.enqueue(ctx, { kind: "feature-validate", lane: "runner", priority: PRIORITY.VALIDATION, fenceKey: `security:${request.requestId}`, params: { repositoryId: request.repositoryId, analysisId: request.requestId, headHash: work }, run: async (c, control) => {
        const abort = new AbortController(); const stop = control.onCancel(() => abort.abort()); const timer = setTimeout(() => abort.abort(), body.budget.wallMs);
        try { return await guardedAsync(c, async () => {
          control.checkpoint();
          const report = await securityGate(gc, abort.signal);
          if (abort.signal.aborted) throw new FeatureError("BUDGET_EXCEEDED", "the security scan exceeded its budget");
          control.checkpoint(); control.commit();
          return securityAssessment(report, `security:${candidate.bindingHash.split(":").pop()!.slice(0, 16)}`);
        }); } finally { clearTimeout(timer); stop(); }
      } });
      return { jobId: job.id };
    }),
    "C25/reviewDependencyDiff": (ctx, body) => guardedAsync(ctx, async () => {
      const { candidate, request } = bound(body?.patchBindingHash, ctx.actor.principalId); fresh(candidate, request);
      const gc = gateContextFor(hooks, candidate, request);
      if (body.policyHash !== securityPolicyHash(gc.policy)) throw new FeatureError("STALE_REVISION", "the dependency policy changed; reload before reviewing");
      if (!Array.isArray(body.inventoryHashes)) throw new FeatureError("INVALID_SCHEMA", "inventoryHashes must be a list");
      const report = await dependencyGate(gc);
      return { status: report.status === "PASS" ? "COMPLETE" : "PARTIAL", value: dependencyReview(report, `deps:${candidate.bindingHash.split(":").pop()!.slice(0, 16)}`), evidenceIds: [candidate.id], diagnostics: report.gaps } satisfies Outcome<ReturnType<typeof dependencyReview>>;
    }),
  };
}
