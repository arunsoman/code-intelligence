import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FencingRegistry, JobRunner, PRIORITY } from "../src/jobs.ts";
import { auditRunner, escapingSymlinks, LocalRunner, nodeTestCapabilities } from "../src/feature/runner.ts";
import { Store } from "../src/store.ts";
import { ctx } from "./helpers.ts";

const sandbox = () => { const b = mkdtempSync(join(tmpdir(), "pf-run-")); const root = join(b, "co"), scratch = join(b, "sc"); mkdirSync(root); mkdirSync(scratch); return { b, root, scratch }; };

test("PF-020/038 audit: every negative probe is stopped by the local runner, and the omissions are disclosed with the report", async () => {
  const r = new LocalRunner();
  const report = await auditRunner(r);
  const failed = report.checks.filter((c) => !c.enforced);
  assert.deepEqual(failed, [], JSON.stringify(failed));
  assert.ok(report.audited);
  assert.ok(report.checks.length >= 14);
  assert.equal(report.isolation, "LOCAL_PERMISSION_MODEL");
  assert.ok(report.omissions.some((o) => /no container or VM/.test(o)), "the class is never presented as a container");
  assert.ok(report.omissions.some((o) => /memory/.test(o)));
});

test("a passing run reports PASSED with its output and the runner's omissions", async () => {
  const { root, scratch } = sandbox();
  writeFileSync(join(root, "a.js"), `console.log("hello")`);
  const res = await new LocalRunner().run({ capabilities: nodeTestCapabilities(root, scratch), argv: ["node", join(root, "a.js")], cwd: root });
  assert.equal(res.status, "PASSED"); assert.equal(res.exitCode, 0); assert.equal(res.stdout.trim(), "hello");
  assert.ok(res.omissions.length >= 3); assert.ok(res.usage.wallMs >= 0);
});

test("a failing run is FAILED with the exit code; a missing binary is INFRA_ERROR, not a test failure", async () => {
  const { root, scratch } = sandbox();
  writeFileSync(join(root, "f.js"), `process.exit(3)`);
  const runner = new LocalRunner();
  const caps = { ...nodeTestCapabilities(root, scratch), commands: [["node"], ["definitely-not-a-binary"]] };
  assert.equal((await runner.run({ capabilities: caps, argv: ["node", join(root, "f.js")], cwd: root })).exitCode, 3);
  assert.equal((await runner.run({ capabilities: caps, argv: ["node", join(root, "f.js")], cwd: root })).status, "FAILED");
  const missing = await new LocalRunner({ hostHas: { unshare: true } }).run({ capabilities: caps, argv: ["definitely-not-a-binary"], cwd: root });
  assert.equal(missing.status, "INFRA_ERROR"); assert.match(missing.reason ?? "", /could not start/);
});

test("a request cannot widen the boundary: roots, cwd and limits are validated before anything starts", async () => {
  const { root, scratch, b } = sandbox();
  const runner = new LocalRunner();
  const base = nodeTestCapabilities(root, scratch);
  writeFileSync(join(root, "ok.js"), "console.log(1)");
  const go = (caps: typeof base, over: Record<string, unknown> = {}) => runner.run({ capabilities: caps, argv: ["node", join(root, "ok.js")], cwd: root, ...over } as any);
  assert.equal((await go(base)).status, "PASSED", "the control request passes, so each refusal below is caused by what it changes");
  for (const [name, caps, over] of [
    ["relative root", { ...base, readRoots: ["co"] }, {}], ["filesystem root", { ...base, readRoots: ["/"] }, {}], ["shallow root", { ...base, writeRoots: ["/tmp"] }, {}],
    ["missing root", { ...base, readRoots: [join(b, "nope")] }, {}], ["cwd outside", base, { cwd: b }], ["no wall limit", { ...base, limits: { ...base.limits, wallMs: 0 } }, {}],
    ["huge wall limit", { ...base, limits: { ...base.limits, wallMs: 10 ** 9 } }, {}], ["huge output", { ...base, limits: { ...base.limits, outputBytes: 10 ** 9 } }, {}],
    ["network allowlist", { ...base, network: { allow: ["example.com"] } }, {}], ["empty argv", base, { argv: [] }], ["NUL in argv", base, { argv: ["node", "a\0b"] }],
    ["not allowlisted", { ...base, commands: [["npm"]] }, {}],
  ] as const) { const res = await go(caps as any, over as any); assert.equal(res.status, "REFUSED", name); assert.ok(res.reason, name); assert.equal(res.exitCode, null, name); }
  for (const flag of ["--eval", "--require", "-r", "--import", "--allow-child-process", "--allow-net", "--permission", "--inspect"]) {
    const res = await runner.run({ capabilities: base, argv: ["node", flag, "x", join(root, "ok.js")], cwd: root }); assert.equal(res.status, "REFUSED", flag); assert.match(res.reason ?? "", /node flag not allowed/, flag);
  }
  for (const k of ["NODE_OPTIONS", "LD_PRELOAD", "PATH", "HOME", "GIT_SSH_COMMAND", "lower"]) assert.equal((await go(base, { env: { [k]: "x" } })).status, "REFUSED", k);
  assert.equal((await go({ ...base, secretRefs: ["MY_TOKEN"] }, { env: { MY_TOKEN: "x" } })).status, "PASSED", "a granted secret reference is passed");
});

test("symlink escape: refused before the run, and a link created during a run that had write access fails it", async () => {
  const { root, scratch, b } = sandbox();
  writeFileSync(join(b, "secret"), "s");
  const runner = new LocalRunner({ hostHas: { unshare: true } });
  const caps = { ...nodeTestCapabilities(root, scratch), commands: [["node"], ["ln"]] };
  // node itself cannot create a link under scoped permissions (audited); another tool can, so the post-run scan matters for it
  const after = await runner.run({ capabilities: caps, argv: ["ln", "-s", join(b, "secret"), join(scratch, "link")], cwd: root });
  assert.equal(after.status, "FAILED", "exit code 0, but the run is not a pass"); assert.ok(after.violations?.[0]?.includes("link"), "the violation is reported"); assert.match(after.reason ?? "", /escapes the granted roots/);
  writeFileSync(join(root, "ok.js"), "console.log(1)");
  const before = await runner.run({ capabilities: caps, argv: ["node", join(root, "ok.js")], cwd: root });
  assert.equal(before.status, "REFUSED", "the leftover link now blocks the next run");
  assert.ok(escapingSymlinks([scratch]).length === 1);
  assert.deepEqual(escapingSymlinks([root]), []);
  symlinkSync("root-internal", join(root, "inner")); writeFileSync(join(root, "root-internal"), "x");
  assert.deepEqual(escapingSymlinks([root]), [], "a link that stays inside the roots is fine");
});

test("limits: wall clock kills the whole group, output is capped, abort cancels", async () => {
  const { root, scratch } = sandbox();
  writeFileSync(join(root, "slow.js"), `setInterval(() => {}, 1000)`);
  const runner = new LocalRunner();
  const slow = await runner.run({ capabilities: nodeTestCapabilities(root, scratch, { wallMs: 400 }), argv: ["node", join(root, "slow.js")], cwd: root });
  assert.equal(slow.status, "TIMEOUT"); assert.ok(slow.usage.wallMs < 4000);
  const ac = new AbortController(); setTimeout(() => ac.abort(), 200);
  const cancelled = await runner.run({ capabilities: nodeTestCapabilities(root, scratch), argv: ["node", join(root, "slow.js")], cwd: root }, ac.signal);
  assert.equal(cancelled.status, "CANCELLED");
  const pre = new AbortController(); pre.abort();
  assert.equal((await runner.run({ capabilities: nodeTestCapabilities(root, scratch), argv: ["node", join(root, "slow.js")], cwd: root }, pre.signal)).status, "CANCELLED");
});

test("network DENY is never silently dropped: a command it cannot isolate is refused when the host has no namespace", async () => {
  const { root, scratch } = sandbox();
  const caps = { ...nodeTestCapabilities(root, scratch), commands: [["node"], ["true"]] };
  const noNs = new LocalRunner({ hostHas: { unshare: false } });
  const res = await noNs.run({ capabilities: caps, argv: ["true"], cwd: root });
  assert.equal(res.status, "REFUSED"); assert.match(res.reason ?? "", /network access cannot be denied/);
  const withNs = new LocalRunner({ hostHas: { unshare: true } });
  const ok = await withNs.run({ capabilities: caps, argv: ["true"], cwd: root });
  assert.ok(["PASSED", "INFRA_ERROR"].includes(ok.status));
  if (ok.status === "PASSED") assert.ok(ok.omissions.some((o) => /not enforced for non-node/.test(o)), "the missing filesystem boundary is disclosed");
  assert.ok(!new LocalRunner({ hostHas: { prlimit: false } }).omissions.every((o) => !/CPU-time/.test(o)), "a missing cpu limit is disclosed");
});

test("AT-24/57 a fencing token that is no longer current refuses the run, and one lost mid-run discards its result", async () => {
  const { root, scratch } = sandbox();
  writeFileSync(join(root, "w.js"), `setTimeout(() => console.log("late"), 300)`);
  const reg = new FencingRegistry(); const t1 = reg.acquire("surface:payments");
  const runner = new LocalRunner({ fence: (t) => reg.isCurrent("surface:payments", t) });
  const req = (token: number) => ({ capabilities: nodeTestCapabilities(root, scratch), argv: ["node", join(root, "w.js")], cwd: root, fencingToken: token });
  const midRun = runner.run(req(t1));
  setTimeout(() => reg.acquire("surface:payments"), 100);
  const lost = await midRun;
  assert.equal(lost.status, "CANCELLED"); assert.match(lost.reason ?? "", /lease was lost/);
  const stale = await runner.run(req(t1));
  assert.equal(stale.status, "REFUSED"); assert.match(stale.reason ?? "", /before the run started/);
  assert.equal((await runner.run(req(reg.acquire("surface:payments")))).status, "PASSED");
});

test("S12 jobs: runner-lane jobs run in a bounded pool beside the parser slot; priority classes order the queue", async () => {
  const store = new Store(":memory:");
  const jobs = new JobRunner(store, { runnerPool: 2 });
  let active = 0, peak = 0; const gate: (() => void)[] = [];
  const mk = (lane: "runner" | "parser", priority: number, tag: string, order?: string[]) => jobs.enqueue(ctx(`idem-${tag}`), {
    kind: "feature-build", lane, priority, params: { repoPath: tag }, run: async () => {
      active++; peak = Math.max(peak, active); order?.push(tag);
      await new Promise<void>((r) => gate.push(r)); active--;
      return { ok: true, value: tag, metadata: { requestId: "r", completeness: "COMPLETE", warnings: [] } };
    },
  });
  const [a, b, c] = ["a", "b", "c"].map((t) => mk("runner", PRIORITY.VALIDATION, t));
  const p = mk("parser", PRIORITY.LIVE, "p");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(peak, 3, "two runner jobs and the parser job run at once");
  assert.equal(store.job(c!.id)!.state, "QUEUED", "the third runner job waits for a free slot");
  const pump = setInterval(() => { while (gate.length) gate.shift()!(); }, 10);
  await Promise.all([a, b, c, p].map((j) => jobs.settled(j!.id).then(() => 0)));
  clearInterval(pump);
  assert.equal(peak, 3);
  for (const j of [a, b, c, p]) assert.equal(store.job(j!.id)!.state, "SUCCEEDED");
  assert.ok(PRIORITY.INTERACTIVE > PRIORITY.VALIDATION && PRIORITY.VALIDATION > PRIORITY.LIVE && PRIORITY.LIVE > PRIORITY.BULK);
  assert.throws(() => new JobRunner(store, { runnerPool: 0 }), /runnerPool/);
  assert.throws(() => new JobRunner(store, { runnerPool: 99 }), /runnerPool/);
});

test("S12 jobs: a higher priority class jumps the queue within a lane", async () => {
  const store = new Store(":memory:"); const jobs = new JobRunner(store, { runnerPool: 1 });
  const order: string[] = []; let open!: () => void; const hold = new Promise<void>((r) => { open = r; });
  const mk = (tag: string, priority: number, wait = false) => jobs.enqueue(ctx(`i-${tag}`), { kind: "feature-build", lane: "runner", priority, params: { repoPath: tag }, run: async () => { order.push(tag); if (wait) await hold; return { ok: true, value: tag, metadata: { requestId: "r", completeness: "COMPLETE", warnings: [] } }; } });
  const first = mk("first", PRIORITY.BULK, true);
  await new Promise((r) => setTimeout(r, 30));
  const bulk = mk("bulk", PRIORITY.BULK), valid = mk("validation", PRIORITY.VALIDATION), inter = mk("interactive", PRIORITY.INTERACTIVE);
  open();
  for (const j of [first, bulk, valid, inter]) await jobs.settled(j!.id);
  assert.deepEqual(order, ["first", "interactive", "validation", "bulk"]);
});

test("AT-24/57 jobs: a job fenced out by a newer holder of the same key cannot commit and ends CANCELLED", async () => {
  const store = new Store(":memory:"); const jobs = new JobRunner(store, { runnerPool: 2 });
  let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
  const old = jobs.enqueue(ctx("old"), { kind: "feature-build", lane: "runner", fenceKey: "surface:x", params: { repoPath: "old" }, run: async (_c, control) => { await hold; control.commit(); return { ok: true, value: "old-committed", metadata: { requestId: "r", completeness: "COMPLETE", warnings: [] } }; } });
  await new Promise((r) => setTimeout(r, 30));
  const newer = jobs.enqueue(ctx("new"), { kind: "feature-build", lane: "runner", fenceKey: "surface:x", params: { repoPath: "new" }, run: async (_c, control) => { control.commit(); return { ok: true, value: "new-committed", metadata: { requestId: "r", completeness: "COMPLETE", warnings: [] } }; } });
  await jobs.settled(newer.id); release();
  const o = await jobs.settled(old.id);
  assert.equal(store.job(newer.id)!.state, "SUCCEEDED");
  assert.equal(o.state, "CANCELLED"); assert.match(o.message, /Replaced by a newer run/);
});
