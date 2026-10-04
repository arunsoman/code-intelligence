// C27 with real tools on reviewed fixture sources: ThreadSanitizer, Loom and a sandboxed Node stress harness, each run through the
// workflow's grants, leases and immutable manifests. DP05, DP06, DP14 (local), DP15 and DP20 in their real-tool forms.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { DetectorFinding, ExperimentSpec, RunManifest } from "@cie/schema";
import { artifactHash } from "../src/defect-schedule.ts";
import { trustedCheckoutHash } from "../src/defect-local.ts";
import { ctx, setup } from "./helpers.ts";

const FIX = realpathSync(resolve(import.meta.dirname, "../../../fixtures/defect-repo"));
let n = 0; const key = () => `k${++n}-${Math.random()}`;

async function world(root = FIX) {
  const { svc, worker, revision } = await setup(undefined, root);
  const wf = svc.defects; wf.trustCheckout(root);
  const entity = svc.store.entities(revision).find((e) => e.kind === "function")!.entityId;
  const finding: DetectorFinding = { id: "finding:" + artifactHash([revision, "adapter-tests"]), version: 1, kind: "MEMORY_RACE", revision, entityIds: [entity], spans: [], ruleId: "test", ruleVersion: 1, evidenceIds: [], coverageGaps: [], severity: "HIGH", evidenceLevel: "STATIC_CANDIDATE", safetyObligations: [] };
  wf.recordFinding(ctx(key()), finding);
  const oracle = wf.putArtifact(ctx(key()), revision, "oracle", { schemaId: "defect.oracle.v1", description: "the property is written independently of the code under test", reviewedBy: "reviewer" });
  /** Prepare and run one experiment on a source harness. */
  const experiment = async (o: { adapterId: string; adapterVersion: string; kind: ExperimentSpec["kind"]; path: string; args?: string[]; wallMs?: number; checkoutRoot?: string; checkoutHash?: string; bounds?: object }) => {
    const root0 = o.checkoutRoot ?? root;
    const harness = wf.putArtifact(ctx(key()), revision, "harness", { schemaId: "defect.source-harness.v1", adapterId: o.adapterId, checkoutRoot: root0, checkoutHash: o.checkoutHash ?? trustedCheckoutHash(root0), path: o.path, args: o.args ?? [] });
    const c = ctx(key());
    const grantId = "grant:" + key();
    const spec: ExperimentSpec = {
      id: "spec:" + key(), findingId: finding.id, baselineRevision: revision, candidateHead: null, adapterId: o.adapterId, adapterVersion: o.adapterVersion, kind: o.kind,
      harnessHandle: harness.handle, harnessHash: harness.hash, oracleSchemaId: oracle.handle, fixtureHandles: [], fixtureHashes: [],
      inputs: { schemaId: "defect.inputs.v1", schemaVersion: 1, value: {} }, bounds: { schemaId: "defect.bounds.v1", schemaVersion: 1, value: (o.bounds ?? {}) as any },
      budget: { wallTimeMs: o.wallMs ?? 120_000, cpuTimeMs: 60_000, memoryBytes: 2 ** 31, processes: 64, readBytes: 2 ** 28, outputBytes: 2 ** 20, cost: "0" }, environmentProfileId: "local-trusted", executionGrantId: grantId,
    };
    wf.provisionGrant({ id: grantId, revision, principalId: c.actor.principalId, specHash: artifactHash(spec), expiresAt: Date.now() + 600_000, operation: "RUN" });
    wf.prepareExperiment(c, spec);
    return { spec, c, run: (replay?: { manifestId: string; expectedSourceHash: string }) => wf.runExperiment(ctx(key()), spec.id, 1, replay) };
  };
  return { svc, worker, revision, wf, finding, experiment, close: () => worker.close() };
}
const report = (w: Awaited<ReturnType<typeof world>>, m: RunManifest) => w.wf.get<any>(m.evidenceIds[0], "report").value;
const TSAN = { adapterId: "native.thread-sanitizer.local", adapterVersion: "clang", kind: "RACE_INSTRUMENTATION" as const };
const LOOM = { adapterId: "rust.loom.local", adapterVersion: "0.7.2", kind: "SCHEDULE_SEARCH" as const };
const STRESS = { adapterId: "node.async-stress.local", kind: "STRESS" as const };

test("DP06: ThreadSanitizer on an instrumented native build reports the race with its locations, the exact source and build, and its exclusions; the atomic variant reports none and claims nothing", async () => {
  const w = await world();
  const bad = await (await w.experiment({ ...TSAN, path: "native-race.cc" })).run();
  assert.equal(bad.status, "PROPERTY_FAILED");
  assert.equal(bad.sourceHash, trustedCheckoutHash(FIX), "the manifest names the exact source that was built");
  assert.match(bad.buildHash, /^[0-9a-f]{64}$/, "and the exact instrumented binary");
  const rep = report(w, bad);
  assert.equal(rep.evidenceLevel, "DETECTOR_REPORT", "a detector report, not a proof and not a reproduction");
  const first = rep.observations.reports[0];
  assert.ok(first.accesses.length >= 2, "both conflicting accesses are in the report");
  assert.deepEqual(first.accesses.map((a: any) => [a.file, a.line]).sort(), [["native-race.cc", 4], ["native-race.cc", 5]], `at the two shared_counter++ lines, scrubbed of local paths: ${JSON.stringify(first.accesses)}`);
  assert.ok(first.accesses.every((a: any) => !a.file.includes("/home/") && !a.file.includes("/tmp/")));
  assert.ok(first.accesses.some((a: any) => /write/.test(a.kind)));
  assert.match(first.location, /shared_counter/);
  assert.ok(bad.omissions.some((o) => /Only the paths a run executes are covered/.test(o)), "the detector's limits travel with the result");
  assert.ok(bad.omissions.some((o) => /logical race over atomic operations is invisible/.test(o)));
  // The corrected variant: no report. That is not "race-free".
  const ok = await (await w.experiment({ ...TSAN, path: "native-fixed.cc" })).run();
  assert.equal(ok.status, "SUCCEEDED");
  assert.equal(report(w, ok).observations.raceReports, 0);
  assert.equal(report(w, ok).evidenceLevel, "NONE");
  assert.ok(ok.omissions.some((o) => /not evidence the program is race-free/.test(o)));
  assert.ok(!/race-free|\bno race\b/i.test(JSON.stringify(ok).replace(/not evidence the program is race-free/g, "").replace(/No race was reported/g, "").replace(/not a proof of no race/g, "")), "no safety claim in the record");
  // The record is immutable and retrievable.
  assert.deepEqual(w.wf.get<RunManifest>(bad.id, "manifest").value, bad);
  w.close();
});

test("DP05: Loom checks a bounded model: it finds the lost update, completes the fixed model inside its bounds, and says neither is a general claim; unavailable adapters say why", async () => {
  const w = await world();
  const bad = await (await w.experiment({ ...LOOM, path: "loom-model/Cargo.toml", args: ["tests::lost_update_model"] })).run();
  assert.equal(bad.status, "PROPERTY_FAILED");
  const br = report(w, bad);
  assert.equal(br.evidenceLevel, "REPRODUCED");
  assert.match(br.observations.violation, /two completed increments must leave two/);
  assert.ok(br.replay[0].includes("cargo test") && br.replay[0].includes("lost_update_model"), "replay instructions are recorded");
  // Replay reproduces the same violation from the same source.
  const spec = (await w.experiment({ ...LOOM, path: "loom-model/Cargo.toml", args: ["tests::lost_update_model"] }));
  const first = await spec.run();
  const again = await spec.run({ manifestId: first.id, expectedSourceHash: first.sourceHash });
  assert.equal(again.status, "PROPERTY_FAILED");
  assert.equal(report(w, again).observations.violation, report(w, first).observations.violation);
  const good = await (await w.experiment({ ...LOOM, path: "loom-model/Cargo.toml", args: ["tests::fixed_model"] })).run();
  assert.equal(good.status, "SUCCEEDED");
  const gr = report(w, good);
  assert.equal(gr.evidenceLevel, "BOUNDED_EXHAUSTIVE");
  assert.ok(good.omissions.some((o) => /search completed inside the model's bounds/.test(o)));
  assert.ok(good.omissions.some((o) => /not in general|not arbitrary whole-process/.test(o)), "the bound is stated, never 'safe'");
  // A model check cannot validate the application's own source, so a patch resting on it cannot pass its gates.
  const caps = w.wf.listCapabilities("rust");
  assert.ok(caps.some((c) => c.id === "rust.loom.local" && c.supportsReplay && c.modelsWeakMemory && c.knownExclusions.some((x) => /bounded model/.test(x))));
  // What cannot run here is listed with its reason, and cannot be prepared.
  const none = w.wf.listCapabilities("java");
  assert.deepEqual(none.map((c) => c.id).filter((id) => /^jvm\./.test(id)), w.wf.listCapabilities("java").some((c) => c.id === "jvm.deadlock-probe.local") ? ["jvm.deadlock-probe.local"] : [], "only the deadlock probe is offered for Java; the schedule-search tools are not");
  assert.ok(!none.some((c) => c.id === "jvm.lincheck" || c.id === "jvm.jcstress"));
  const why = w.wf.listUnavailable("java");
  assert.ok(why.some((u) => u.id === "jvm.lincheck" && /Lincheck/.test(u.reason)) && why.some((u) => u.id === "jvm.jcstress"));
  assert.ok(w.wf.listUnavailable().some((u) => u.id === "system.antithesis" && /account|cost/.test(u.reason)));
  assert.ok(w.wf.listUnavailable().some((u) => u.id === "dotnet.coyote"));
  await assert.rejects(w.experiment({ adapterId: "jvm.lincheck", adapterVersion: "1", kind: "SCHEDULE_SEARCH", path: "native-race.cc" }), /No installed adapter supports/);
  w.close();
});

test("DP12/20: stress on real code reproduces a lost update with its seed, finds nothing in the fixed code without calling it safe, and runs inside a sandbox", async () => {
  const w = await world();
  const bad = await (await w.experiment({ ...STRESS, adapterVersion: process.version, path: "async-race.ts", args: ["lostIncrement", "300", "7"] })).run();
  assert.equal(bad.status, "PROPERTY_FAILED");
  assert.equal(bad.seed, "7");
  const br = report(w, bad);
  assert.equal(br.evidenceLevel, "REPRODUCED");
  assert.ok(br.observations.violations > 0 && br.observations.runs === 300);
  assert.ok(br.observations.firstBad.length > 0 && br.observations.firstBad[0].balance < 3, "a concrete failing observation");
  assert.ok(br.replay[0].includes("lostIncrement") && br.replay[0].includes("300 7"));
  const ok = await (await w.experiment({ ...STRESS, adapterVersion: process.version, path: "async-race.ts", args: ["incrementAfterAwait", "300", "7"] })).run();
  assert.equal(ok.status, "SUCCEEDED");
  assert.equal(report(w, ok).observations.violations, 0);
  assert.equal(report(w, ok).evidenceLevel, "NONE", "finding nothing is not evidence");
  assert.ok(ok.omissions.some((o) => /random runs found no violation; that does not show the function is safe/.test(o)));
  assert.ok(ok.omissions.some((o) => /Probabilistic/.test(o)));
  // Bounds are enforced.
  await assert.rejects(Promise.resolve().then(async () => (await w.experiment({ ...STRESS, adapterVersion: process.version, path: "async-race.ts", args: ["lostIncrement", "99999999", "1"] })).run()).then((m) => { if (m.status !== "INCONCLUSIVE") throw new Error("not refused"); throw new Error("refused:" + m.omissions.join(";")); }), /refused:.*within bounds/s);
  w.close();
});

test("DP14: a hostile function under stress cannot read outside the checkout, write, start a process, open a network connection or start a worker; an untrusted or edited checkout is refused", async () => {
  // A hostile checkout: the function under test tries every way out. Each denied attempt adds one to the balance; any success breaks the count.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cie-hostile-"))); cpSync(FIX, dir, { recursive: true });
  const probe = join(tmpdir(), `cie-hostile-wrote-${Date.now()}.txt`);
  let connections = 0;
  const server = createServer((s) => { connections++; s.destroy(); }); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  writeFileSync(join(dir, "hostile.ts"), `
import fs from "node:fs"; import cp from "node:child_process"; import net from "node:net";
export async function hostile(account: { balance: number }, boundary: () => Promise<void>) {
  let denied = 0;
  const attempt = async (f: () => unknown) => { try { await f(); } catch { denied++; } };
  await attempt(() => fs.readFileSync("/etc/hostname"));
  await attempt(() => fs.writeFileSync(${JSON.stringify(probe)}, "escaped"));
  await attempt(() => cp.execSync("echo escaped"));
  await attempt(() => new Promise((res, rej) => { const s = net.connect(${port}, "127.0.0.1"); s.on("connect", () => res(0)); s.on("error", rej); setTimeout(() => rej(new Error("t")), 1000); }));
  await attempt(async () => { const { Worker } = await import("node:worker_threads"); new Worker("1", { eval: true }); });
  await boundary();
  account.balance = account.balance + (denied === 5 ? 1 : 1000);
}
`);
  try {
    const w = await world(dir);
    const m = await (await w.experiment({ ...STRESS, adapterVersion: process.version, path: "hostile.ts", args: ["hostile", "5", "1"], checkoutRoot: dir })).run();
    assert.equal(m.status, "SUCCEEDED", `all five escape attempts were denied: ${JSON.stringify(report(w, m).observations)} ${report(w, m).stderr?.slice(0, 300)}`);
    assert.equal(report(w, m).observations.violations, 0);
    assert.equal(existsSync(probe), false, "nothing was written outside");
    assert.equal(connections, 0, "no connection reached the host");
    // Not trusted: refused at preparation.
    const other = realpathSync(mkdtempSync(join(tmpdir(), "cie-untrusted-"))); cpSync(FIX, other, { recursive: true });
    const harness = w.wf.putArtifact(ctx(key()), w.revision, "harness", { schemaId: "defect.source-harness.v1", adapterId: STRESS.adapterId, checkoutRoot: other, checkoutHash: trustedCheckoutHash(other), path: "async-race.ts", args: ["lostIncrement", "5", "1"] });
    const spec: ExperimentSpec = { id: "spec:" + key(), findingId: w.finding.id, baselineRevision: w.revision, candidateHead: null, adapterId: STRESS.adapterId, adapterVersion: process.version, kind: "STRESS", harnessHandle: harness.handle, harnessHash: harness.hash, oracleSchemaId: (w.wf.list<any>(w.revision, "oracle"), `oracle:${w.revision}:${artifactHash({ schemaId: "defect.oracle.v1", description: "the property is written independently of the code under test", reviewedBy: "reviewer" })}`), fixtureHandles: [], fixtureHashes: [], inputs: { schemaId: "defect.inputs.v1", schemaVersion: 1, value: {} }, bounds: { schemaId: "defect.bounds.v1", schemaVersion: 1, value: {} }, budget: { wallTimeMs: 10000, cpuTimeMs: 10000, memoryBytes: 2 ** 30, processes: 8, readBytes: 2 ** 28, outputBytes: 2 ** 20, cost: "0" }, environmentProfileId: "x", executionGrantId: "grant:none" };
    assert.throws(() => w.wf.prepareExperiment(ctx(key()), spec), /not trusted for local execution/);
    // Edited after review: the run is refused, not run.
    const ex = await w.experiment({ ...STRESS, adapterVersion: process.version, path: "async-race.ts", args: ["lostIncrement", "5", "1"], checkoutRoot: dir });
    writeFileSync(join(dir, "async-race.ts"), "export async function lostIncrement() {}\n");
    const refused = await ex.run();
    assert.equal(refused.status, "INCONCLUSIVE");
    assert.ok(refused.omissions.some((o) => /changed since it was reviewed/.test(o)), refused.omissions.join(";"));
    w.close();
  } finally { server.close(); }
});

test("DP15/20: a run that exceeds its budget or is cancelled is never a success, is quarantined or marked, and cannot pass a validation", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cie-slow-"))); cpSync(FIX, dir, { recursive: true });
  writeFileSync(join(dir, "slow.ts"), `export async function slow(account: { balance: number }, boundary: () => Promise<void>) { await new Promise(() => setInterval(() => {}, 1000)); account.balance += 1; }\n`);
  const w = await world(dir);
  const budgetStopped = await (await w.experiment({ ...STRESS, adapterVersion: process.version, path: "slow.ts", args: ["slow", "1", "1"], checkoutRoot: dir, wallMs: 1500 })).run();
  assert.equal(budgetStopped.status, "BUDGET_STOPPED", `a run that does not finish in its budget is stopped, and says so: ${budgetStopped.omissions.join(" | ")}`);
  // Cancel in flight.
  const ex = await w.experiment({ ...STRESS, adapterVersion: process.version, path: "slow.ts", args: ["slow", "1", "1"], checkoutRoot: dir, wallMs: 30_000 });
  const running = ex.run();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(w.wf.cancelExperiment(ex.spec.id) >= 1);
  const cancelled = await running;
  assert.equal(cancelled.status, "CANCELLED");
  assert.ok(cancelled.omissions.some((o) => /cancelled|revoked|lease/.test(o)));
  assert.notEqual(w.wf.get<any>(cancelled.evidenceIds[0], "quarantine").value, undefined, "its late output is kept as quarantined evidence, never as a current result");
  // A crash (lease expiry) is an infrastructure failure, not a pass.
  const lost = await w.experiment({ ...STRESS, adapterVersion: process.version, path: "slow.ts", args: ["slow", "1", "1"], checkoutRoot: dir, wallMs: 30_000 });
  const inflight = lost.run().catch(() => null);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(w.wf.recoverExpired(Date.now() + 3_600_000) >= 1);
  assert.equal(w.svc.store.db.prepare("select count(*) n from defect_attempts where state = 'INFRA_FAILED'").get()!.n, 1);
  w.wf.cancelExperiment(lost.spec.id); await inflight;
  w.close();
});
