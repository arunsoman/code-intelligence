// Task 2.M — gateway handlers and the PERFORMANCE gate driver (PF-027–031, 044, 032; AT-17–21, 34).
//   C26/assessPerformanceRisk  pure predicate over the diff
//   C27/runPairedBenchmark     durable runner-lane job; P4 baseline cache and P5 exclusive lease live in this closure
//   C26/evaluatePerformance    S11 statistics over a stored experiment, restricted to the caller's own requests
// A developer machine is NOT a representative environment unless the host says so (hooks.environment): without that, every
// assessment is UNVALIDATED (AT-19) and the PERFORMANCE gate is a gap, never a pass.
import { createHash } from "node:crypto";
import type { Service } from "../service.ts";
import { PRIORITY } from "../jobs.ts";
import { loadAuthority } from "./authority.ts";
import { loadFeatureConfig } from "./config.ts";
import { FeatureError, guarded, guardedAsync } from "./errors.ts";
import type { RunCheck } from "./gates.ts";
import { LocalRunner } from "./runner.ts";
import { assessPerformanceRisk, evaluateExperiment, evaluatePerformance, loadPerfRegistry, runPairedBenchmark, DEFAULT_ANALYSIS_POLICY, defaultAnalysisPolicyHash, type BaselineCache, type PerfCachedBaseline, type PerfLease } from "./perf.ts";
import type { Handlers } from "./routes.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { CandidateRecord, FeatureRecord, PairedExperiment, RunResult, Runner } from "./types.ts";

export interface PerfHooks {
  /** Runner for benchmark repetitions. Default: the local runner (permission model). */
  runner?: (fence: () => boolean) => Runner;
  /** Is this host a representative environment for the workload? Default: no. */
  environment?: () => { representative: boolean };
  lease?: PerfLease; baselineCache?: BaselineCache; now?: () => number;
}

/** In-process exclusive lease: the first benchmark measures; a concurrent one proceeds but is labelled contended (P5). */
export function memoryLease(): PerfLease { let held = false; return { tryAcquire: () => (held ? false : (held = true)), release: () => { held = false; } }; }
export function memoryBaselineCache(): BaselineCache { const m = new Map<string, PerfCachedBaseline>(); return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) }; }

const budgetsOf = (reg: ReturnType<typeof loadPerfRegistry>) => (id: string) => reg.budgets[id] ?? null;
function authorityOf(root: string) { try { return loadAuthority(root, loadFeatureConfig(root).authorityFile); } catch (e) { throw new FeatureError("INVALID_SCHEMA", `authority or feature configuration is invalid: ${(e as Error).message}`); } }
function registryOf(root: string) { try { return loadPerfRegistry(root); } catch (e) { throw new FeatureError("INVALID_SCHEMA", `.cie/perf.json is invalid: ${(e as Error).message}`); } }

const incomplete = (reason: string): RunResult => ({ status: "INFRA_ERROR", exitCode: null, stdout: "", stderr: "", truncated: false, isolation: "LOCAL_PERMISSION_MODEL", omissions: ["the verdict is computed from a stored paired experiment; nothing is executed here"], usage: { wallMs: 0 }, reason });

/** Owns PERFORMANCE checks: evaluates the candidate's stored experiment against its declared budgets. */
export function perfRunCheck(fs: SqliteFeatureStore, candidate: CandidateRecord, request: FeatureRecord): RunCheck {
  return async (check) => {
    if (check.kind !== "PERFORMANCE") return undefined;
    const exps = fs.listEvidence(candidate.id).filter((e) => e.performance).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const latest = exps[0]?.performance as PairedExperiment | undefined;
    if (!latest) return incomplete("no paired benchmark has been run for this candidate (C27/runPairedBenchmark)");
    if (latest.bindingHash !== candidate.bindingHash) return incomplete("the stored paired experiment belongs to a different candidate");
    let reg, auth; try { reg = registryOf(request.repositoryId); auth = authorityOf(request.repositoryId); } catch (e) { return incomplete((e as Error).message); }
    const policy = latest.analysisPolicyHash === defaultAnalysisPolicyHash() ? DEFAULT_ANALYSIS_POLICY : null;
    if (!policy) return incomplete("the analysis policy behind the experiment is not on record; the statistics cannot be recomputed");
    const a = evaluateExperiment(latest, { budgetIds: latest.budgetIds, budgets: budgetsOf(reg), authority: auth, policy });
    const stdout = JSON.stringify({ schemaVersion: 1, assessment: a, experimentId: latest.id });
    const base = { exitCode: null, stdout, stderr: "", truncated: false, isolation: "LOCAL_PERMISSION_MODEL" as const, omissions: ["the verdict is computed from a stored paired experiment; nothing is executed here"], usage: { wallMs: 0 } };
    if (a.state === "WITHIN_BUDGET") return { ...base, status: "PASSED", exitCode: 0 };
    if (a.state === "REGRESSION") return { ...base, status: "FAILED", exitCode: 1, reason: a.reasons.concat(a.verdicts?.flatMap((v) => v.reasons) ?? []).slice(0, 4).join("; ") };
    return { ...base, status: "INFRA_ERROR", reason: `PERFORMANCE ${a.state}: ${a.reasons.concat(a.verdicts?.flatMap((v) => v.reasons) ?? []).slice(0, 3).join("; ")}` };
  };
}

export function perfHandlers(svc: Service, fs: SqliteFeatureStore, owned: (id: string, actor: string) => FeatureRecord, hooks: PerfHooks = {}): Handlers {
  const lease = hooks.lease ?? memoryLease(), cache = hooks.baselineCache ?? memoryBaselineCache();
  const bound = (hash: unknown, actor: string) => {
    if (typeof hash !== "string" || !hash) throw new FeatureError("INVALID_SCHEMA", "patchBindingHash is required");
    const candidate = fs.getCandidateByBinding(hash); if (!candidate) throw new FeatureError("NOT_FOUND", "no such candidate");
    return { candidate, request: owned(candidate.requestId, actor) };
  };
  return {
    "C26/assessPerformanceRisk": (ctx, body) => guarded(ctx, () => {
      bound(body?.patchBindingHash, ctx.actor.principalId);
      return assessPerformanceRisk({ fs }, { contractHash: body.contractHash, patchBindingHash: body.patchBindingHash, runtimeEvidenceIds: Array.isArray(body.runtimeEvidenceIds) ? body.runtimeEvidenceIds : [] });
    }),
    "C27/runPairedBenchmark": (ctx, body) => guarded(ctx, () => {
      const { candidate, request } = bound(body?.patchBindingHash, ctx.actor.principalId);
      const reg = registryOf(request.repositoryId);
      if (!body.budget || !Number.isSafeInteger(body.budget.wallMs) || body.budget.wallMs < 1 || body.budget.wallMs > 3_600_000) throw new FeatureError("INVALID_SCHEMA", "a bounded benchmark wall budget is required");
      if (!reg.workloads[body.workloadHash]) throw new FeatureError("NOT_FOUND", `workload ${body.workloadHash} is not declared in .cie/perf.json`);
      if (!reg.measurementPlans[body.measurementPlanHash]) throw new FeatureError("NOT_FOUND", `measurement plan ${body.measurementPlanHash} is not declared in .cie/perf.json`);
      const work = createHash("sha256").update(`${candidate.bindingHash}\0${body.workloadHash}\0${body.measurementPlanHash}\0${ctx.idempotencyKey}`).digest("hex");
      const job = svc.jobs.enqueue(ctx, { kind: "feature-validate", lane: "runner", priority: PRIORITY.VALIDATION, fenceKey: `perf:${request.requestId}`, params: { repositoryId: request.repositoryId, analysisId: request.requestId, headHash: work }, run: async (c, control) => {
        const abort = new AbortController(); const stop = control.onCancel(() => abort.abort());
        try { return await guardedAsync(c, async () => {
          control.checkpoint();
          const fence = () => control.holdsFence?.() ?? true;
          const runner = hooks.runner?.(fence) ?? new LocalRunner({ fence });
          const exp = await runPairedBenchmark({ fs, runner, workload: (h) => reg.workloads[h] ?? null, measurementPlan: (h) => reg.measurementPlans[h] ?? null, baselineCache: cache, lease, environment: hooks.environment ?? (() => ({ representative: false })), now: hooks.now, commit: () => { control.checkpoint(); control.commit(); } },
            c.actor.principalId, { baselineSnapshot: body.baselineSnapshot, patchBindingHash: candidate.bindingHash, workloadHash: body.workloadHash, environmentHash: body.environmentHash, measurementPlanHash: body.measurementPlanHash, budget: body.budget, budgetIds: body.budgetIds, promotedBy: body.promotedBy });
          if (abort.signal.aborted) throw new FeatureError("BUDGET_EXCEEDED", "the benchmark was cancelled");
          return exp;
        }); } finally { stop(); }
      } });
      return { jobId: job.id };
    }),
    "C26/evaluatePerformance": (ctx, body) => guarded(ctx, () => {
      const actor = ctx.actor.principalId;
      const mine = (id: string) => {
        for (const rec of fs.listRequests(undefined, 1000)) { if (rec.createdBy !== actor) continue; for (const c of fs.listCandidates(rec.requestId)) for (const ev of fs.listEvidence(c.id)) if (ev.performance?.id === id) return { experiment: ev.performance as PairedExperiment, evidenceId: ev.id, requestId: rec.requestId }; }
        return null;
      };
      const found = typeof body?.pairedExperimentId === "string" ? mine(body.pairedExperimentId) : null;
      if (!found) throw new FeatureError("NOT_FOUND", `no paired experiment ${String(body?.pairedExperimentId)}`);
      const request = owned(found.requestId, actor);
      const reg = registryOf(request.repositoryId);
      return evaluatePerformance({ fs, budgets: budgetsOf(reg), authority: authorityOf(request.repositoryId), findExperiment: mine }, actor, { pairedExperimentId: body.pairedExperimentId, budgetIds: Array.isArray(body.budgetIds) ? body.budgetIds : [], analysisPolicyHash: body.analysisPolicyHash });
    }),
  };
}
