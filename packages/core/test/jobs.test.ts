import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { StubProvider } from "@cie/model";
import type { ModelProvider, ModelRequest } from "@cie/schema";
import { JobRunner, type JobControl } from "../src/jobs.ts";
import { buildHandler } from "../src/server.ts";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { WorkerClient } from "../src/worker.ts";
import { ctx, demoRepo, FIXTURE, setup } from "./helpers.ts";

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 10)); } };

test("jobs: enqueue returns at once, runs to SUCCEEDED with the same result a direct call gives; the same key or the same work is not queued twice", async () => {
  const store = new Store(":memory:");
  const worker = new WorkerClient();
  const svc = new Service(store, worker, new StubProvider());
  const c = ctx("same-key");
  const t0 = Date.now();
  const first = svc.enqueueJob(c, { kind: "index", repoPath: FIXTURE });
  assert.ok(first.ok && Date.now() - t0 < 200 && ["QUEUED", "RUNNING"].includes(first.value.state), "returns before the work is done");
  const again = svc.enqueueJob(ctx("another-key"), { kind: "index", repoPath: FIXTURE });
  assert.ok(again.ok && again.value.id === first.value.id && again.value.deduped, "same work already waiting is not queued twice");
  const replay = svc.enqueueJob(c, { kind: "index", repoPath: FIXTURE });
  assert.ok(replay.ok && replay.value.id === first.value.id, "same idempotency key, same job");
  const done = await svc.jobs.settled(first.value.id);
  assert.equal(done.state, "SUCCEEDED");
  assert.equal((done.result!.value as { fileCount: number }).fileCount, store.latestRevision()!.fileCount);
  assert.ok(done.startedAt && done.finishedAt && done.phase === "done");
  // Extraction as a job reports progress and ends with cards stored.
  const ext = svc.enqueueJob(ctx(), { kind: "concepts" });
  assert.ok(ext.ok);
  const e = await svc.jobs.settled(ext.value.id);
  assert.equal(e.state, "SUCCEEDED");
  assert.ok((e.result!.value as { cards: unknown[] }).cards.length > 0 && store.concepts(store.latestRevision()!.id).length > 0);
  worker.close();
});

test("jobs: cancelling during a model call stops at once, abandons the call's answer, and leaves nothing saved", async () => {
  class Slow implements ModelProvider {
    readonly name = "slow"; readonly model = "x"; readonly hosted = false;
    started = gate(); release = gate(); inner = new StubProvider(); extractCalls = 0;
    async generate(req: ModelRequest) {
      if (req.purpose !== "EXTRACT") return this.inner.generate(req);
      this.extractCalls++; this.started.open(); await this.release.p; return this.inner.generate(req);
    }
  }
  const slow = new Slow();
  const { svc, worker } = await setup(slow, demoRepo());
  const before = { cards: svc.store.concepts(svc.store.latestRevision()!.id).length, claims: svc.store.db.prepare("select count(*) n from claims").get() as { n: number } };
  const job = svc.enqueueJob(ctx(), { kind: "concepts" });
  assert.ok(job.ok);
  await slow.started.p;
  assert.equal(svc.getJob(ctx(), { jobId: job.value.id }).ok && (svc.getJob(ctx(), { jobId: job.value.id }) as any).value.phase, "extracting");
  const t0 = Date.now();
  const cancelled = svc.cancelJob(ctx(), { jobId: job.value.id });
  assert.ok(cancelled.ok && cancelled.value.cancelled);
  const done = await svc.jobs.settled(job.value.id);
  assert.equal(done.state, "CANCELLED");
  assert.ok(Date.now() - t0 < 1000, "did not wait for the model");
  // The model answers late; nothing happens.
  slow.release.open();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(svc.getJob(ctx(), { jobId: job.value.id }).ok && (svc.getJob(ctx(), { jobId: job.value.id }) as any).value.state, "CANCELLED");
  assert.equal(svc.store.concepts(svc.store.latestRevision()!.id).length, before.cards, "no cards written");
  assert.deepEqual(svc.store.db.prepare("select count(*) n from claims").get(), before.claims, "no claims written");
  assert.equal(slow.extractCalls, 1, "no further chunks were sent after the cancel");
  worker.close();
});

test("jobs: cancelling during the parse ends the parser, saves no revision, and the replacement worker still works", async () => {
  const store = new Store(":memory:");
  const worker = new WorkerClient();
  const svc = new Service(store, worker, new StubProvider());
  // A repository big enough that the parse is still running when the cancel lands: gate the worker's reply instead of racing it.
  const real = worker.index.bind(worker);
  const reached = gate();
  (worker as any).index = (...a: Parameters<typeof real>) => { reached.open(); return new Promise<never>(() => {}) as Promise<any>; /* never answers: only abort() can end this job */ };
  let aborts = 0;
  const realAbort = worker.abort.bind(worker);
  worker.abort = () => { aborts++; realAbort(); };
  const job = svc.enqueueJob(ctx(), { kind: "index", repoPath: FIXTURE });
  assert.ok(job.ok);
  await reached.p;
  const c = svc.cancelJob(ctx(), { jobId: job.value.id });
  assert.ok(c.ok && c.value.cancelled);
  const done = await svc.jobs.settled(job.value.id);
  assert.equal(done.state, "CANCELLED");
  assert.equal(aborts, 1);
  assert.equal(store.latestRevision(), null, "no revision was saved");
  // The real thing: a request in flight is rejected with CANCELLED, and the new process answers.
  (worker as any).index = real;
  const inflight = real(FIXTURE).then(() => "finished", (e) => (e as any).api?.code);
  realAbort();
  assert.equal(await inflight, "CANCELLED");
  assert.ok(await worker.ping());
  assert.ok((await real(FIXTURE)).entities.length > 0, "a fresh parse works after an abort");
  worker.close();
});

test("jobs: a queued job can be cancelled before it starts; jobs run one at a time in order", async () => {
  const store = new Store(":memory:");
  const runner = new JobRunner(store);
  const g = gate(); const order: string[] = [];
  const run = (name: string, wait?: Promise<void>) => async (_c: unknown, _j: JobControl) => { order.push(`start ${name}`); if (wait) await wait; order.push(`end ${name}`); return { ok: true as const, value: name, metadata: { requestId: "r", completeness: "COMPLETE" as const, warnings: [] } }; };
  const a = runner.enqueue(ctx("a"), { kind: "index", params: { repoPath: "/a" }, run: run("a", g.p) });
  const b = runner.enqueue(ctx("b"), { kind: "index", params: { repoPath: "/b" }, run: run("b") });
  const c = runner.enqueue(ctx("c"), { kind: "index", params: { repoPath: "/c" }, run: run("c") });
  await until(() => order.includes("start a"));
  assert.equal(runner.get(b.id)!.state, "QUEUED", "b waits while a runs");
  const x = runner.cancel(b.id)!;
  assert.ok(x.cancelled && x.job.state === "CANCELLED");
  g.open();
  await runner.settled(c.id);
  assert.deepEqual(order, ["start a", "end a", "start c", "end c"], "b never ran");
  assert.equal((await runner.settled(a.id)).state, "SUCCEEDED");
});

test("jobs: past the commit point a cancel is refused and the job finishes whole", async () => {
  const store = new Store(":memory:");
  const runner = new JobRunner(store);
  const g = gate(); const committed = gate(); let finished = false;
  const j = runner.enqueue(ctx(), { kind: "concepts", params: { revision: "r" }, run: async (_c, control) => {
    control.checkpoint(); control.commit(); committed.open(); await g.p; finished = true;
    return { ok: true as const, value: "saved", metadata: { requestId: "r", completeness: "COMPLETE" as const, warnings: [] } };
  } });
  await committed.p;
  const r = runner.cancel(j.id)!;
  assert.equal(r.cancelled, false);
  assert.match(r.reason!, /saving its result/);
  assert.ok(runner.get(j.id)!.committing);
  g.open();
  const done = await runner.settled(j.id);
  assert.equal(done.state, "SUCCEEDED");
  assert.ok(finished);
  // And a finished job cannot be cancelled either.
  assert.equal(runner.cancel(j.id)!.cancelled, false);
  assert.equal(runner.cancel("job:nope"), null);
});

test("jobs: work left RUNNING by a process that exited is marked FAILED on start-up, not shown as running forever", async () => {
  const store = new Store(":memory:");
  const first = new JobRunner(store);
  const g = gate();
  const j = first.enqueue(ctx(), { kind: "index", params: { repoPath: "/x" }, run: async () => { await g.p; return { ok: true as const, value: 1, metadata: { requestId: "r", completeness: "COMPLETE" as const, warnings: [] } }; } });
  await until(() => store.job(j.id)!.state === "RUNNING");
  const second = new JobRunner(store); // a new process opening the same database
  const after = second.get(j.id)!;
  assert.equal(after.state, "FAILED");
  assert.match(after.error!.message, /server stopped/);
  g.open();
});

test("jobs: the gateway exposes enqueue, getJob, listJobs and cancelJob; enqueue and cancel need an idempotency key", async () => {
  const { svc, worker } = await setup();
  const srv = createServer(buildHandler(svc));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, key?: string) => fetch(`${base}/api/v1/components/C07/${path}`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  try {
    assert.equal((await post("enqueue", { kind: "index", repoPath: FIXTURE })).status, 400);
    const e = await post("enqueue", { kind: "index", repoPath: FIXTURE }, "k1");
    assert.equal(e.status, 200);
    const id = e.body.value.id as string;
    await svc.jobs.settled(id);
    assert.equal((await post("getJob", { jobId: id })).body.value.state, "SUCCEEDED");
    assert.ok((await post("listJobs", {})).body.value.some((j: any) => j.id === id));
    assert.equal((await post("getJob", { jobId: "job:none" })).status, 404);
    assert.equal((await post("cancelJob", { jobId: id }, "k2")).body.value.cancelled, false);
    assert.equal((await post("enqueue", { kind: "bogus" }, "k3")).status, 400);
  } finally { srv.close(); worker.close(); }
});

test("jobs: cancelling after some chunks finished still leaves no cards and no claims behind", async () => {
  process.env.CIE_CHUNK_TOKEN_BUDGET = "400"; // forces several small chunks
  try {
    class Second implements ModelProvider {
      readonly name = "second"; readonly model = "x"; readonly hosted = false;
      calls = 0; blocked = gate(); release = gate(); inner = new StubProvider();
      async generate(req: ModelRequest) {
        if (req.purpose !== "EXTRACT") return this.inner.generate(req);
        if (++this.calls === 2) { this.blocked.open(); await this.release.p; }
        return this.inner.generate(req);
      }
    }
    const model = new Second();
    const { svc, worker } = await setup(model, demoRepo());
    const rev = svc.store.latestRevision()!.id;
    const claimsBefore = svc.store.db.prepare("select count(*) n from claims").get();
    const job = svc.enqueueJob(ctx(), { kind: "concepts" });
    assert.ok(job.ok);
    await model.blocked.p;
    assert.ok(model.calls >= 2, "one chunk had already been answered");
    const j = svc.jobs.get(job.value.id)!;
    assert.ok((j.done ?? 0) >= 1 && (j.total ?? 0) >= 2, `progress shows ${j.done} of ${j.total}`);
    assert.ok(svc.cancelJob(ctx(), { jobId: job.value.id }).ok);
    assert.equal((await svc.jobs.settled(job.value.id)).state, "CANCELLED");
    assert.deepEqual(svc.store.db.prepare("select count(*) n from claims").get(), claimsBefore, "claims from the finished chunk were not kept");
    assert.equal(svc.store.concepts(rev).length, 0);
    model.release.open();
    worker.close();
  } finally { delete process.env.CIE_CHUNK_TOKEN_BUDGET; }
});
