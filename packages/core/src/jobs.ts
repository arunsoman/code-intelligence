// C07 job runner. Indexing and concept extraction can take minutes, so they run as jobs: enqueue returns at once,
// progress is polled, and cancel works. One job runs at a time (there is one parser process), the rest wait as QUEUED.
//
// What "cancel" means, exactly:
//   before the commit point   the work stops now. A waiting model call is abandoned (its answer is dropped), the parser
//                             process is ended and replaced, and nothing was written, so there is nothing to undo.
//   after the commit point    refused. The result is being written in one step; stopping would leave half of it.
// A job left RUNNING by a process that has since exited is marked FAILED on start-up: it cannot resume, and saying so
// is better than showing a spinner forever.
import { randomUUID } from "node:crypto";
import type { ApiError, ApiResult, CallContext, JobKind, JobView } from "@cie/schema";
import type { Store } from "./store.ts";

export class Cancelled extends Error { constructor() { super("cancelled"); } }

/** What a running job is handed so it can report progress and honour a cancel at safe points. */
export interface JobControl {
  /** Throws Cancelled if a cancel was requested and the job has not reached its commit point. */
  checkpoint(): void;
  /** Waits for `p`, but returns (by throwing Cancelled) the moment a cancel arrives instead of waiting for it. */
  guard<T>(p: Promise<T>): Promise<T>;
  progress(p: { phase: string; message?: string; done?: number; total?: number }): void;
  /** From here a cancel is refused. Call immediately before the single write that makes the result visible. */
  commit(): void;
  /** Run `fn` if a cancel arrives (for example to end the parser process). Returns a function that withdraws it. */
  onCancel(fn: () => void): () => void;
}

export type JobBody = (ctx: CallContext, control: JobControl) => Promise<ApiResult<unknown>>;
export interface JobSpec { kind: JobKind; params: JobView["params"]; run: JobBody }

interface Live { control: JobControl; requestCancel: () => boolean }

const FAILED_ON_RESTART: ApiError = { code: "CANCELLED", message: "The server stopped while this was running. Start it again; nothing from the interrupted run was saved.", retryable: true };

export class JobRunner {
  private store: Store;
  private bodies = new Map<string, JobSpec & { ctx: CallContext }>();
  private live = new Map<string, Live>();
  private running = false;
  private waiters: (() => void)[] = [];

  constructor(store: Store) {
    this.store = store;
    for (const j of store.activeJobs()) store.saveJob({ ...j, state: "FAILED", cancelRequested: false, committing: false, message: "Interrupted by a restart.", finishedAt: new Date().toISOString(), error: FAILED_ON_RESTART });
  }

  /** Queue a job and return at once. The same idempotency key returns the same job; the same work already waiting or running is not queued twice. */
  enqueue(ctx: CallContext, spec: JobSpec): JobView & { deduped?: boolean } {
    if (ctx.idempotencyKey) { const prior = this.store.jobByIdempotencyKey(ctx.idempotencyKey); if (prior) return { ...prior, deduped: true }; }
    const same = this.store.activeJobs().find((j) => j.kind === spec.kind && JSON.stringify(j.params) === JSON.stringify(spec.params));
    if (same) return { ...same, deduped: true };
    const job: JobView = {
      id: `job:${randomUUID()}`, kind: spec.kind, state: "QUEUED", cancelRequested: false, committing: false,
      phase: "queued", message: "Waiting for its turn.", params: spec.params, createdAt: new Date().toISOString(),
    };
    this.store.putJob(job, ctx.idempotencyKey || null);
    this.store.pruneJobs();
    this.bodies.set(job.id, { ...spec, ctx });
    queueMicrotask(() => void this.pump());
    return job;
  }

  get(id: string): JobView | null { return this.store.job(id); }
  list(limit = 20): JobView[] { return this.store.jobs(limit); }

  /** Resolves when the job is no longer QUEUED or RUNNING. For tests and for callers that want a synchronous result. */
  async settled(id: string): Promise<JobView> {
    for (;;) {
      const j = this.store.job(id);
      if (!j) throw new Error("no such job");
      if (j.state !== "QUEUED" && j.state !== "RUNNING") return j;
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50).unref(); });
    }
  }

  cancel(id: string): { job: JobView; cancelled: boolean; reason?: string } | null {
    const job = this.store.job(id);
    if (!job) return null;
    if (job.state === "QUEUED") {
      this.bodies.delete(id);
      const done: JobView = { ...job, state: "CANCELLED", message: "Cancelled before it started.", finishedAt: new Date().toISOString() };
      this.store.saveJob(done);
      return { job: done, cancelled: true };
    }
    if (job.state !== "RUNNING") return { job, cancelled: false, reason: `It already ${job.state === "SUCCEEDED" ? "finished" : job.state === "FAILED" ? "failed" : "was cancelled"}.` };
    const live = this.live.get(id);
    if (!live || !live.requestCancel()) return { job: this.store.job(id) ?? job, cancelled: false, reason: "It is already saving its result, so it was left to finish rather than save half." };
    const asked = { ...(this.store.job(id) ?? job), cancelRequested: true, message: "Stopping…" };
    this.store.saveJob(asked);
    return { job: asked, cancelled: true };
  }

  private update(id: string, patch: Partial<JobView>) {
    const j = this.store.job(id);
    if (j) this.store.saveJob({ ...j, ...patch });
  }

  private async pump() {
    if (this.running) return;
    const next = this.store.activeJobs().find((j) => j.state === "QUEUED" && this.bodies.has(j.id));
    if (!next) return;
    this.running = true;
    const spec = this.bodies.get(next.id)!;
    this.bodies.delete(next.id);
    let cancelled = false, committed = false;
    let wake: (() => void) | null = null;
    const gone = new Promise<never>((_, rej) => { wake = () => rej(new Cancelled()); });
    gone.catch(() => {});
    const handlers = new Set<() => void>();
    const control: JobControl = {
      checkpoint: () => { if (cancelled && !committed) throw new Cancelled(); },
      guard: <T,>(p: Promise<T>) => { p.catch(() => {}); return cancelled && !committed ? Promise.reject(new Cancelled()) : Promise.race([p, gone]); },
      progress: (p) => this.update(next.id, { phase: p.phase, message: p.message ?? p.phase, done: p.done, total: p.total }),
      commit: () => { control.checkpoint(); committed = true; this.update(next.id, { committing: true, phase: "saving", message: "Saving the result…" }); },
      onCancel: (fn) => { handlers.add(fn); return () => { handlers.delete(fn); }; },
    };
    this.live.set(next.id, {
      control,
      requestCancel: () => {
        if (committed) return false;
        cancelled = true;
        for (const h of handlers) { try { h(); } catch { /* best effort */ } }
        wake?.();
        return true;
      },
    });
    this.update(next.id, { state: "RUNNING", startedAt: new Date().toISOString(), phase: "starting", message: "Starting…" });
    const finish = (patch: Partial<JobView>) => this.update(next.id, { ...patch, finishedAt: new Date().toISOString(), committing: false, cancelRequested: false });
    try {
      const r = await spec.run({ ...spec.ctx, deadlineMs: Date.now() + 30 * 60_000 }, control);
      if (r.ok) finish({ state: "SUCCEEDED", phase: "done", message: "Done.", result: { value: r.value, warnings: r.metadata.warnings } });
      else if (r.error.code === "CANCELLED") finish({ state: "CANCELLED", phase: "cancelled", message: "Cancelled. Nothing was saved." });
      else finish({ state: "FAILED", phase: "failed", message: r.error.message, error: r.error });
    } catch (e) {
      if (e instanceof Cancelled) finish({ state: "CANCELLED", phase: "cancelled", message: "Cancelled. Nothing was saved." });
      else finish({ state: "FAILED", phase: "failed", message: (e as Error).message, error: { code: "STORAGE_FAILURE", message: (e as Error).message, retryable: true } });
    } finally {
      this.live.delete(next.id);
      this.running = false;
      for (const w of this.waiters.splice(0)) w();
      queueMicrotask(() => void this.pump());
    }
  }
}
