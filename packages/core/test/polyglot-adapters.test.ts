// Real tools on reviewed fixture sources for Go, Java and Python: the Go race detector, the JVM's own deadlock report, and a Python hang watchdog.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { goRaceAdapter, jvmDeadlockAdapter, pyHangAdapter, parseGoRaces, parseJvmDeadlock, parsePyHang, trustedCheckoutHash, LOCAL_ADAPTERS, type LocalBudget, type SourceHarness } from "../src/defect-local.ts";

const ROOT = realpathSync(resolve(import.meta.dirname, "../../../fixtures/polyglot-harness"));
const HASH = trustedCheckoutHash(ROOT);
const BUDGET: LocalBudget = { wallMs: 120_000, memoryBytes: 2 ** 30, outputBytes: 2 ** 20, processes: 32 };
const harness = (adapterId: string, path: string, args: string[]): SourceHarness => ({ schemaId: "defect.source-harness.v1", adapterId, checkoutRoot: ROOT, checkoutHash: HASH, path, args });

test("Go race detector: a planted data race is reported with its goroutines and location, the mutex-guarded version is not, and the run says what it cannot show", async (t) => {
  const p = goRaceAdapter.probe();
  if (!p.available) return t.skip(p.reason);
  const racy = await goRaceAdapter.run(harness(goRaceAdapter.id, "go/go.mod", ["TestRacyCounter"]), BUDGET);
  assert.equal(racy.status, "PROPERTY_FAILED");
  assert.equal(racy.evidenceLevel, "DETECTOR_REPORT");
  const reports = racy.observations.reports as { access: string; location: string | null; goroutines: number }[];
  assert.ok(reports.length >= 1 && reports.every((r) => r.goroutines >= 2 && /counter\.go:\d+/.test(r.location ?? "")), JSON.stringify(reports));
  assert.ok(racy.replay[0].includes("go test -race"));
  assert.ok(!racy.stdout.includes(ROOT) && !racy.stderr.includes(ROOT), "absolute paths are scrubbed");
  const safe = await goRaceAdapter.run(harness(goRaceAdapter.id, "go/go.mod", ["TestSafeCounter"]), BUDGET);
  assert.equal(safe.status, "SUCCEEDED");
  assert.equal(safe.evidenceLevel, "NONE");
  assert.ok(safe.exclusions.some((e) => /does not show the code is race-free/.test(e)));
});

test("JVM deadlock probe: opposite lock orders are reported by the JVM itself with the threads and monitors involved; ordered locks finish; a program that never ends is not called a deadlock", async (t) => {
  const p = jvmDeadlockAdapter.probe();
  if (!p.available) return t.skip(p.reason);
  const dead = await jvmDeadlockAdapter.run(harness(jvmDeadlockAdapter.id, "java/Deadlock.java", ["2500"]), BUDGET);
  assert.equal(dead.status, "PROPERTY_FAILED");
  assert.equal(dead.evidenceLevel, "DETECTOR_REPORT");
  assert.ok((dead.observations.deadlocks as number) >= 1);
  assert.deepEqual((dead.observations.threads as string[]).sort(), ["backward", "forward"]);
  assert.ok((dead.observations.locks as string[]).some((l) => /Object/.test(l)));
  const ok = await jvmDeadlockAdapter.run(harness(jvmDeadlockAdapter.id, "java/Ordered.java", ["2500"]), BUDGET);
  assert.equal(ok.status, "SUCCEEDED");
  assert.equal(ok.observations.deadlocks, 0);
  assert.ok(ok.exclusions.some((e) => /no deadlock occurred in this execution/.test(e)));
  const waiting = await jvmDeadlockAdapter.run(harness(jvmDeadlockAdapter.id, "java/Sleeper.java", ["1500"]), BUDGET);
  assert.equal(waiting.status, "BUDGET_STOPPED");
  assert.equal(waiting.observations.deadlocks, 0);
  assert.equal(waiting.evidenceLevel, "NONE");
  assert.ok(waiting.exclusions.some((e) => /may be slow, waiting or livelocked/.test(e)));
  // Settle times outside the bounds, and a harness that is not Java, are refused.
  await assert.rejects(jvmDeadlockAdapter.run(harness(jvmDeadlockAdapter.id, "java/Ordered.java", ["5"]), BUDGET), /settle time/);
  await assert.rejects(jvmDeadlockAdapter.run(harness(jvmDeadlockAdapter.id, "python/ordered.py", ["2500"]), BUDGET), /single-file Java/);
});

test("Python hang watchdog: a lock-order hang is dumped with each thread's stack; a script that finishes is a success that says it proves nothing", async (t) => {
  const p = pyHangAdapter.probe();
  if (!p.available) return t.skip(p.reason);
  const hung = await pyHangAdapter.run(harness(pyHangAdapter.id, "python/deadlock.py", ["2000"]), BUDGET);
  assert.equal(hung.status, "PROPERTY_FAILED");
  assert.equal(hung.evidenceLevel, "DETECTOR_REPORT");
  assert.equal(hung.observations.hung, true);
  const threads = hung.observations.threads as { name: string; at: string }[];
  assert.ok(threads.filter((x) => /deadlock\.py:\d+ in (forward|backward)/.test(x.at)).length === 2, JSON.stringify(threads));
  assert.ok(hung.exclusions.some((e) => /A hang is reported, not diagnosed/.test(e)));
  const fine = await pyHangAdapter.run(harness(pyHangAdapter.id, "python/ordered.py", ["4000"]), BUDGET);
  assert.equal(fine.status, "SUCCEEDED");
  assert.equal(fine.observations.hung, false);
  assert.ok(fine.exclusions.some((e) => /no hang occurred in this execution/.test(e)));
});

test("the new adapters refuse a checkout that changed since it was reviewed, and wrong harness shapes", async () => {
  const stale = { ...harness(goRaceAdapter.id, "go/go.mod", ["TestSafeCounter"]), checkoutHash: "0".repeat(64) };
  await assert.rejects(goRaceAdapter.run(stale, BUDGET), /changed since it was reviewed/);
  await assert.rejects(goRaceAdapter.run(harness(goRaceAdapter.id, "go/counter.go", ["TestSafeCounter"]), BUDGET), /its go\.mod/);
  await assert.rejects(goRaceAdapter.run(harness(goRaceAdapter.id, "go/go.mod", ["Test; rm -rf /"]), BUDGET), /Name one test/);
  await assert.rejects(goRaceAdapter.run(harness(goRaceAdapter.id, "go/go.mod", ["TestSafeCounter", "../../etc"]), BUDGET), /package must be/);
  await assert.rejects(pyHangAdapter.run(harness(pyHangAdapter.id, "java/Ordered.java", ["2000"]), BUDGET), /reviewed script/);
  await assert.rejects(pyHangAdapter.run({ ...harness(pyHangAdapter.id, "../polyglot-defects/python/shop/transfers.py", ["2000"]) }, BUDGET));
});

test("the parsers read what the tools print, and the adapters are registered with the languages they cover", () => {
  const races = parseGoRaces("==================\nWARNING: DATA RACE\nWrite at 0x1 by goroutine 7:\n  x.f()\n      /a/b/c.go:12 +0x1\n\nPrevious read at 0x1 by goroutine 8:\n  x.g()\n      /a/b/c.go:20 +0x2\n==================\n--- FAIL: TestX\nFAIL", (p) => p.replace("/a/b/", ""));
  assert.deepEqual(races.reports, [{ access: "Write", location: "c.go:12", goroutines: 2 }]);
  assert.equal(races.failed, true);
  assert.equal(parseGoRaces("ok  \tx\t0.01s", (p) => p).reports.length, 0);
  const jvm = parseJvmDeadlock('Found one Java-level deadlock:\n=============================\n"backward":\n  waiting to lock monitor 0x1 (object 0x2, a java.lang.Object),\n  which is held by "forward"\n"forward":\n  waiting to lock monitor 0x3 (object 0x4, a java.lang.Object),\n  which is held by "backward"\n\nFound 1 deadlock.\n');
  assert.equal(jvm.deadlocks, 1); assert.deepEqual(jvm.threads.sort(), ["backward", "forward"]);
  assert.equal(parseJvmDeadlock("no problems").deadlocks, 0);
  const py = parsePyHang('Timeout (0:00:02)!\nThread 0x00007f (most recent call first):\n  File "/r/deadlock.py", line 9 in forward\n\nCurrent thread 0x00007e (most recent call first):\n  File "/r/deadlock.py", line 22 in <module>\n');
  assert.equal(py.hung, true); assert.equal(py.threads.length, 2); assert.match(py.threads[0].at, /deadlock\.py:9 in forward/);
  const langs = new Set(LOCAL_ADAPTERS.flatMap((a) => a.languageIds));
  for (const l of ["go", "java", "python"]) assert.ok(langs.has(l), l);
});

test("the defect workflow offers the Go, Java and Python adapters for their languages, and still lists the ones it cannot run, with reasons", async () => {
  const { setup } = await import("./helpers.ts");
  const { svc, worker } = await setup(undefined, ROOT);
  const caps = (lang: string) => (svc.defects as any).capabilities?.(lang)?.map((c: any) => c.id) ?? (svc.defects as any).listCapabilities?.(lang)?.map((c: any) => c.id);
  assert.ok(caps("go")?.includes("go.race-detector.local"), JSON.stringify(caps("go")));
  assert.ok(caps("java")?.includes("jvm.deadlock-probe.local"));
  assert.ok(caps("python")?.includes("python.hang-watchdog.local"));
  const missing = (svc.defects as any).listUnavailable().map((u: any) => u.id);
  assert.ok(missing.includes("jvm.jcstress") && missing.includes("jvm.lincheck"), "schedule-search tools for the JVM are still named as unavailable");
  worker.close();
});
