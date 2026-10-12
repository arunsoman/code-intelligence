// C26 Phase A: report-only defect detection requests, benchmark comparison, and the background detection job.
import { DefectDetectionInputSchema } from "@cie/schema";
import type { ApiResult, BenchmarkPolicy, BenchmarkResult, CallContext, DefectDetectionInput, DetectorFinding, JobView } from "@cie/schema";
import { policyFor } from "./access.ts";
import { compareBenchmark, detectDefects } from "./defects.ts";
import { detectIndexedDefects } from "./defect-indexed.ts";
import { artifactHash } from "./defect-schedule.ts";
import { fail, ok } from "./service.ts";
import type { Service } from "./service.ts";

export class DefectRequests {
  declare readonly svc: Service;
  constructor(svc: Service) { Object.defineProperty(this, "svc", { value: svc, enumerable: false }); }
  private get store() { return this.svc.store; }

  /** C26 Phase A is deliberately report-only: callers supply registered semantic facts for a pinned indexed revision. */
  detectDefects(ctx: CallContext, req: DefectDetectionInput): ApiResult<{ findings: DetectorFinding[]; truncated: boolean }> {
    const parsed = DefectDetectionInputSchema.safeParse(req);
    if (!parsed.success) return fail(ctx, { code: "INVALID_SCHEMA", message: "Invalid defect.v1 detection request", retryable: false });
    req = parsed.data;
    if (ctx.deadlineMs <= Date.now()) return fail(ctx, { code: "DEADLINE_EXCEEDED", message: "The detection deadline has expired", retryable: false });
    if (ctx.expectedRevision && ctx.expectedRevision !== req.revision) return fail(ctx, { code: "STALE_REVISION", message: "The requested revision differs from the expected revision", retryable: false });
    if (!req || typeof req.revision !== "string" || !this.store.revision(req.revision)) return fail(ctx, { code: "NOT_FOUND", message: "the pinned revision is not indexed or is no longer accessible", retryable: false });
    if ((req.lockOrders && !Array.isArray(req.lockOrders)) || (req.memoryAccesses && !Array.isArray(req.memoryAccesses))) return fail(ctx, { code: "INVALID_SCHEMA", message: "lockOrders and memoryAccesses must be arrays", retryable: false });
    const facts = [...(req.lockOrders ?? []), ...(req.memoryAccesses ?? [])];
    const entityIds = new Set(this.store.entities(req.revision).map((e) => e.entityId));
    const policy = policyFor(this.store, this.store.revision(req.revision)!.repoRoot);
    const files = new Map(this.store.entities(req.revision).map((e) => [e.entityId, e.file]));
    for (const fact of facts) {
      if (!fact || typeof fact.id !== "string" || typeof fact.entityId !== "string" || !entityIds.has(fact.entityId)) return fail(ctx, { code: "INVALID_SCHEMA", message: `fact ${fact?.id ?? "(unknown)"} cites an entity outside the pinned revision`, retryable: false });
      if (policy.deniedEntity(fact.entityId, (id) => files.get(id))) return fail(ctx, { code: "FORBIDDEN", message: "The request includes inaccessible entities", retryable: false });
      if (!Array.isArray(fact.evidenceIds) || fact.evidenceIds.length === 0 || fact.evidenceIds.some((id) => typeof id !== "string" || !this.store.evidence(req.revision, id))) return fail(ctx, { code: "EVIDENCE_MISSING", message: `fact ${fact.id} must cite evidence in the pinned revision`, retryable: false });
      for (const id of fact.evidenceIds) {
        const evidence = this.store.evidence(req.revision, id)!;
        if (evidence.state !== "CURRENT") return fail(ctx, { code: "EVIDENCE_STALE", message: "The request cites evidence that is not current", retryable: false });
        if (policy.deniedEntity(evidence.sourceId, (x) => files.get(x))) return fail(ctx, { code: "FORBIDDEN", message: "The request cites inaccessible evidence", retryable: false });
      }
      if (fact.span && fact.span.revision !== req.revision) return fail(ctx, { code: "STALE_REVISION", message: `fact ${fact.id} has a source span from another revision`, retryable: false });
    }
    const supplied = req.lockOrders !== undefined || req.memoryAccesses !== undefined;
    const value = supplied ? detectDefects(req.revision, { lockOrders: req.lockOrders, memoryAccesses: req.memoryAccesses, maxFacts: req.budget?.maxFacts, maxFindings: req.budget?.maxFindings }) : detectIndexedDefects(this.store, req.revision, req.budget);
    const gaps = supplied ? ["Caller-supplied semantic facts have not been independently resolved by the language adapter."] : (value as ReturnType<typeof detectIndexedDefects>).coverageGaps;
    return ok(ctx, value, { revision: req.revision, completeness: "PARTIAL", warnings: [...gaps, ...(value.truncated ? ["The configured analysis bound was reached; findings are incomplete."] : [])] });
  }

  compareDefectBenchmarks(ctx: CallContext, req: { baseline: number[]; candidate: number[]; policy: BenchmarkPolicy }): ApiResult<BenchmarkResult> {
    if (!req || !Array.isArray(req.baseline) || !Array.isArray(req.candidate) || req.baseline.length > 10000 || req.candidate.length > 10000 || !req.policy || !Number.isFinite(req.policy.minimumImprovement) || req.policy.minimumImprovement <= 0 || !Number.isFinite(req.policy.maximumRegression) || req.policy.maximumRegression < 0 || !Number.isSafeInteger(req.policy.minimumSamples) || req.policy.minimumSamples < 1) {
      return fail(ctx, { code: "INVALID_SCHEMA", message: "baseline, candidate, and a valid comparison policy are required", retryable: false });
    }
    return ok(ctx, compareBenchmark(req.baseline, req.candidate, req.policy));
  }

  startDefectDetection(ctx: CallContext, req: DefectDetectionInput): ApiResult<JobView> {
    const parsed = DefectDetectionInputSchema.safeParse(req);
    if (!parsed.success || !ctx.idempotencyKey) return fail(ctx, { code: "INVALID_SCHEMA", message: "A valid detection request and idempotency key are required", retryable: false });
    req = parsed.data;
    if (!this.store.revision(req.revision)) return fail(ctx, { code: "NOT_FOUND", message: "Revision is not accessible", retryable: false });
    const scoped = { ...ctx, idempotencyKey: `defect:${artifactHash([ctx.actor.tenantId, ctx.actor.principalId, ctx.idempotencyKey])}` };
    const hash = artifactHash(req), prior = this.store.jobByIdempotencyKey(scoped.idempotencyKey);
    if (prior && prior.params.defectRequestHash !== hash) return fail(ctx, { code: "VERSION_CONFLICT", message: "Idempotency key was used for a different detection request", retryable: false });
    return ok(ctx, this.svc.jobs.enqueue(scoped, { kind: "defect-detect", params: { revision: req.revision, repoPath: this.store.revision(req.revision)!.repoRoot, defectRequestHash: hash }, run: async (c, control) => {
      control.checkpoint();
      const result = this.detectDefects(c, req);
      if (!result.ok) return result;
      control.commit();
      for (const f of result.value.findings) this.svc.defects.recordFinding({ ...c, idempotencyKey: `${c.idempotencyKey}:${f.id}` }, f);
      return ok(c, result.value.findings, { revision: req.revision, completeness: result.metadata.completeness, warnings: result.metadata.warnings });
    } }));
  }
}
