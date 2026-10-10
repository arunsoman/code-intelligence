import { PRIORITY } from "../jobs.ts";
import { policyFor } from "../access.ts";
import type { Service } from "../service.ts";
import type { AuthorityConfig } from "./authority.ts";
import { refreshStaleness } from "./candidate.ts";
import { loadFeatureConfig } from "./config.ts";
import { DockerRunner, dockerAvailable } from "./docker-runner.ts";
import { FeatureError, guarded, guardedAsync } from "./errors.ts";
import type { RunCheck } from "./gates.ts";
import { FeatureModelAdapter } from "./model.ts";
import type { PipelineHooks } from "./pipeline-handlers.ts";
import { prepareFeature } from "./prepare-feature.ts";
import { LocalRunner } from "./runner.ts";
import type { Handlers } from "./routes.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { CandidateRecord, FeatureRecord } from "./types.ts";
import { buildAndRepair, importTestReport, validationReport } from "./workbench.ts";

export function workbenchHandlers(svc: Service, fs: SqliteFeatureStore, owned: (id: string, actor: string) => FeatureRecord, authOf: (repo: string) => AuthorityConfig, hooks: PipelineHooks, driver?: (candidate: CandidateRecord, request: FeatureRecord) => RunCheck | undefined): Handlers {
  const accessible = (request: FeatureRecord) => {
    if (!svc.store.latestRevision(request.repositoryId)) throw new FeatureError("NOT_FOUND", "Repository access is unavailable");
    const policy = policyFor(svc.store, request.repositoryId);
    if (fs.listCandidates(request.requestId).some((c) => Object.keys(c.contents ?? {}).some((p) => policy.denied(p)))) throw new FeatureError("FORBIDDEN", "Candidate source access changed; start a new request with accessible files");
    return request;
  };
  const read = (id: string, actor: string) => {
    const request = accessible(owned(id, actor));
    refreshStaleness({ fs, store: svc.store, auth: authOf(request.repositoryId) }, actor, request.requestId);
    return fs.getRequest(request.requestId)!;
  };
  return {
    "C02/prepareFeaturePlan": (c, b) => guarded(c, () => {
      const request = read(b?.requestId, c.actor.principalId);
      const job = svc.jobs.enqueue(c, { kind: "feature-build", lane: "runner", priority: PRIORITY.VALIDATION, fenceKey: `workbench:${request.requestId}`, params: { repositoryId: request.repositoryId, analysisId: request.requestId }, run: async (ctx, control) => {
        const abort = new AbortController(), unsubscribe = control.onCancel(() => abort.abort());
        try { return await guardedAsync(ctx, async () => {
          const adapter = hooks.adapter?.(request.requestId) ?? new FeatureModelAdapter(fs, request.requestId, { egress: loadFeatureConfig(request.repositoryId).egress });
          control.progress({ phase: "planning", message: "Checking requirements, overlap and impact" });
          const result = await prepareFeature(fs, svc.store, ctx.actor.principalId, request.requestId, adapter, () => control.checkpoint(), abort.signal);
          control.checkpoint(); control.commit(); return result;
        }); } finally { unsubscribe(); }
      } });
      return { jobId: job.id };
    }),
    "C27/getFeatureWorkbench": (c, b) => guarded(c, () => {
      const request = read(b?.requestId, c.actor.principalId);
      return { reports: request.workbench?.reports ?? [], runs: (request.workbench?.runs ?? []).map((r) => { const job = svc.store.job(r.jobId); return { ...r, jobState: job?.state, interrupted: ["GENERATING", "VALIDATING", "REPAIRING"].includes(r.phase) && (!job || ["FAILED", "CANCELLED"].includes(job.state)) }; }) };
    }),
    "C27/importFeatureTestReport": (c, b) => guarded(c, () => importTestReport(fs, read(b?.requestId, c.actor.principalId), b?.report)),
    "C27/exportFeatureValidationReport": (c, b) => guarded(c, () => {
      const request = read(b?.requestId, c.actor.principalId), candidate = fs.getCandidateByBinding(b?.candidateHash);
      if (!candidate || candidate.requestId !== request.requestId) throw new FeatureError("NOT_FOUND", "No such candidate");
      return validationReport(fs, request, candidate);
    }),
    "C28/buildFeatureCandidate": (c, b) => guarded(c, () => {
      if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => !["requestId", "candidateHash", "reportId", "maxRepairs", "wallMs", "syntheticTestData"].includes(k))) throw new FeatureError("INVALID_SCHEMA", "Invalid build request");
      const request = read(b.requestId, c.actor.principalId);
      for (const key of ["candidateHash", "reportId"]) if (b[key] !== undefined && (typeof b[key] !== "string" || !b[key])) throw new FeatureError("INVALID_SCHEMA", `${key} must be a nonempty string`);
      if (b.syntheticTestData !== undefined && typeof b.syntheticTestData !== "boolean") throw new FeatureError("INVALID_SCHEMA", "syntheticTestData must be boolean");
      const maxRepairs = b.maxRepairs ?? 3, wallMs = b.wallMs ?? 600000;
      if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 3 || !Number.isSafeInteger(wallMs) || wallMs < 1000 || wallMs > 1800000) throw new FeatureError("INVALID_SCHEMA", "Build budget is 0–3 repairs and 1–1800 seconds");
      if (!c.idempotencyKey) throw new FeatureError("INVALID_SCHEMA", "An idempotency key is required");
      const auth = authOf(request.repositoryId), cfg = loadFeatureConfig(request.repositoryId);
      if (!cfg.supportedStacks.includes("typescript-node-npm")) throw new FeatureError("BLOCKED", "This builder currently supports TypeScript/Node/npm");
      const job = svc.jobs.enqueue(c, { kind: "feature-build", lane: "runner", priority: PRIORITY.VALIDATION, fenceKey: `workbench:${request.requestId}`, params: { repositoryId: request.repositoryId, analysisId: request.requestId }, run: async (ctx, control) => {
        const abort = new AbortController(), unsubscribe = control.onCancel(() => abort.abort());
        try { return await guardedAsync(ctx, async () => {
          const runner = hooks.runner?.() ?? (dockerAvailable() ? new DockerRunner({ fence: () => control.holdsFence?.() ?? true }) : new LocalRunner({ fence: () => control.holdsFence?.() ?? true }));
          const adapter = hooks.adapter?.(request.requestId) ?? new FeatureModelAdapter(fs, request.requestId, { egress: cfg.egress });
          const result = await buildAndRepair({ fs, store: svc.store, auth, runner, propose: (i) => adapter.proposeEdits(i), checkpoint: () => { control.checkpoint(); if (control.holdsFence && !control.holdsFence()) throw new FeatureError("STALE_REVISION", "Build ownership was lost"); }, progress: (phase, message) => control.progress({ phase, message }), runCheckFor: driver }, ctx.actor.principalId, { requestId: request.requestId, jobId: job.id, candidateHash: b.candidateHash, reportId: b.reportId, maxRepairs, wallMs, syntheticTestData: b.syntheticTestData, signal: abort.signal });
          control.checkpoint(); control.commit(); return result;
        }); } finally { unsubscribe(); }
      } });
      return { jobId: job.id };
    }),
  };
}
