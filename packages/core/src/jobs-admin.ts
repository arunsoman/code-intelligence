// Operational surface: health/version, backup/gc/delete, and the background job queue (C07).
import { dirname, isAbsolute, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { ApiResult, CallContext, JobView } from "@cie/schema";
import { backup as backupStore, deleteRepository as deleteRepo, gc as gcStore, type DeleteReport, type GcReport } from "./storage.ts";
import { API_VERSION, MIN_EXTENSION, health as healthOf, restoreDrill, type Health, type RestoreDrill } from "./ops.ts";
import { actor, fail, ok, storageFailure } from "./service.ts";
import type { Service } from "./service.ts";

export class JobsAdmin {
  declare readonly svc: Service;
  constructor(svc: Service) { Object.defineProperty(this, "svc", { value: svc, enumerable: false }); }
  private get store() { return this.svc.store; }

  /** `task_flags.publish` is the independent switch for the only write that leaves this machine. */
  tasksPublicationEnabled(): boolean {
    try {
      const row = this.store.db.prepare("select publish from task_flags limit 1").get() as { publish: number } | undefined;
      return Number(row?.publish ?? 0) === 1;
    } catch { return false; }
  }

  /** History analysis is off only when the deployment says so; reads never touch the model. */
  historyEnabled(): boolean { return process.env.CIE_HISTORY !== "off"; }

  async health(ctx: CallContext, _req: Record<string, never> = {}): Promise<ApiResult<Health>> {
    return ok(ctx, await healthOf({ store: this.store, ping: () => this.svc.worker.ping(), model: { name: this.svc.model.name, model: this.svc.model.model, lastError: this.svc.modelError }, dbPath: this.store.path }));
  }

  /** What an editor extension needs to decide whether it can talk to this server. */
  version(ctx: CallContext, _req: Record<string, never> = {}): ApiResult<{ api: string; minExtension: string; schema: number }> {
    return ok(ctx, { api: API_VERSION, minExtension: MIN_EXTENSION, schema: Number((this.store.db.prepare("select coalesce(max(version),0) v from schema_version").get() as { v: number }).v) });
  }

  /** A consistent copy of the database, written beside it under backups/. `name` is a plain file name, never a path. */
  backup(ctx: CallContext, req: { name?: string }): ApiResult<{ path: string; revisions: number; drill: RestoreDrill }> {
    const name = (req.name ?? `cie-${new Date().toISOString().replace(/[:.]/g, "-")}`).replace(/[^A-Za-z0-9._-]/g, "_");
    if (this.store.path === ":memory:") return fail(ctx, { code: "INVALID_SCHEMA", message: "an in-memory database cannot be backed up", retryable: false });
    const dir = join(dirname(this.store.path), "backups");
    try {
      mkdirSync(dir, { recursive: true });
      const b = backupStore(this.store, join(dir, `${name}.db`));
      // A backup nobody has restored is a hope. Prove this one before saying it exists.
      const drill = restoreDrill(b.path);
      this.store.audit(actor(ctx), "storage.backup", b.path, { revisions: b.revisions, drillOk: drill.ok });
      return ok(ctx, { ...b, drill });
    } catch (e) { return fail(ctx, storageFailure(e)); }
  }

  /** Remove revisions nothing refers to. `dryRun` says what would go without removing it. */
  gc(ctx: CallContext, req: { dryRun?: boolean; minAgeDays?: number }): ApiResult<GcReport> {
    const r = gcStore(this.store, { dryRun: req.dryRun ?? true, minAgeMs: Math.max(0, req.minAgeDays ?? 0) * 86_400_000 });
    if (!r.dryRun) this.store.audit(actor(ctx), "storage.gc", "(revisions)", { removed: r.removed.length, kept: Object.keys(r.kept).length });
    return ok(ctx, r);
  }

  /** Delete a repository and everything derived from it. The caller must repeat the path, so it cannot happen by accident. */
  deleteRepository(ctx: CallContext, req: { repoRoot: string; confirm: string }): ApiResult<DeleteReport> {
    if (!req.repoRoot || req.confirm !== req.repoRoot) return fail(ctx, { code: "INVALID_SCHEMA", message: "to delete, repeat the repository path in `confirm`", retryable: false });
    if (!this.store.hasRepo(req.repoRoot)) return fail(ctx, { code: "NOT_FOUND", message: "unknown repository", retryable: false });
    try {
      try { const rid = this.svc.search.repositoryOfRoot(req.repoRoot)?.repositoryId; if (rid) this.svc.search.purgeRepository(rid); } catch { /* purge failure never blocks deletion of the base data */ }
      return ok(ctx, deleteRepo(this.store, req.repoRoot, actor(ctx)));
    } catch (e) { return fail(ctx, storageFailure(e)); }
  }

  // ---------------------------------------------------------------- C07 jobs
  /** Start indexing, concept extraction, or hierarchy building in the background. Returns the job at once; poll getJob for progress. */
  enqueueJob(ctx: CallContext, req: { kind: "index" | "concepts" | "concept-hierarchy"; repoPath?: string; revision?: string }): ApiResult<JobView & { deduped?: boolean }> {
    if (req.kind === "index") {
      if (!req.repoPath || !isAbsolute(req.repoPath)) return fail(ctx, { code: "INVALID_SCHEMA", message: "repoPath must be an absolute path", retryable: false });
      const repoPath = req.repoPath;
      return ok(ctx, this.svc.jobs.enqueue(ctx, { kind: "index", params: { repoPath }, run: (jctx, control) => this.svc.ingestRepository(jctx, { repoPath }, control) }));
    }
    if (req.kind === "concepts") {
      return fail(ctx, { code: "NOT_IMPLEMENTED", message: "Concept cards have been retired. Use concept-hierarchy to build concepts.", retryable: false });
    }
    if (req.kind === "concept-hierarchy") {
      const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
      if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; index a repository first", retryable: false });
      return ok(ctx, this.svc.jobs.enqueue(ctx, { kind: "concept-hierarchy", params: { revision: rev.id, repoPath: rev.repoRoot }, run: (jctx, control) => this.svc.buildConceptHierarchy(jctx, { revision: rev.id }, control) }));
    }
    return fail(ctx, { code: "INVALID_SCHEMA", message: "kind must be index, concepts or concept-hierarchy", retryable: false });
  }

  getJob(ctx: CallContext, req: { jobId: string }): ApiResult<JobView> {
    const j = this.svc.jobs.get(req.jobId);
    return j ? ok(ctx, j) : fail(ctx, { code: "NOT_FOUND", message: "no such job", retryable: false });
  }

  listJobs(ctx: CallContext, req: { limit?: number }): ApiResult<JobView[]> {
    return ok(ctx, this.svc.jobs.list(Math.min(Math.max(req.limit ?? 20, 1), 50)));
  }

  /** Ask a job to stop. Before it starts saving, it stops and nothing is kept; once it is saving, it is left to finish. */
  cancelJob(ctx: CallContext, req: { jobId: string }): ApiResult<{ job: JobView; cancelled: boolean; reason?: string }> {
    const r = this.svc.jobs.cancel(req.jobId);
    if (!r) return fail(ctx, { code: "NOT_FOUND", message: "no such job", retryable: false });
    this.store.audit(actor(ctx), "job.cancel", req.jobId, { kind: r.job.kind, cancelled: r.cancelled });
    return ok(ctx, r);
  }
}
