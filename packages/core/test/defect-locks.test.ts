// DP01 / DP02 on real indexed code: held sets, releases, RAII, try-locks, timeouts, reentrancy and gate locks decide what is a
// candidate and what is not. Every finding cites the characters it came from; none claims a deadlock was observed.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { detectIndexedDefects } from "../src/defect-indexed.ts";
import { blank, scanFunction } from "../src/defect/source.ts";
import { ctx, setup } from "./helpers.ts";

const FIX = resolve(import.meta.dirname, "../../../fixtures/defect-repo");
const locksOf = (f: { witness?: { paths: string[][] } }) => [...new Set((f.witness?.paths ?? []).flatMap((p) => p.slice(1)))].sort();
const lockFindings = async (repo = FIX) => {
  const { svc, worker, revision } = await setup(undefined, repo);
  const r = detectIndexedDefects(svc.store, revision);
  return { svc, worker, revision, all: r.findings, locks: r.findings.filter((f) => f.kind === "DEADLOCK_CANDIDATE") };
};

test("DP01: a realizable lock inversion is a cited static candidate with both paths; a serialized cycle is retained but marked not realizable", async () => {
  const { svc, worker, revision, locks } = await lockFindings();
  const real = locks.find((f) => locksOf(f).join() === "accountA,accountB")!;
  assert.ok(real, "accountA/accountB inversion found");
  assert.equal(real.evidenceLevel, "STATIC_CANDIDATE");
  assert.equal(real.severity, "HIGH");
  assert.equal(real.ruleId, "defect.lock-order-cycle");
  const fnNames = real.entityIds.map((id) => id.replace(/^.*#/, "")).sort();
  assert.deepEqual(fnNames, ["transferAtoB", "transferBtoA"], "both acquisition paths are in the finding");
  assert.ok(real.spans.length === 2 && real.evidenceIds.length === 2);
  const snippets = real.evidenceIds.map((id) => { const r = svc.evidenceFor(ctx(), { revision, evidenceId: id }); assert.ok(r.ok); assert.equal(r.value.state, "CURRENT"); return r.value.snippet; });
  assert.ok(snippets.some((s) => /accountB\.acquire/.test(s)) && snippets.some((s) => /accountA\.acquire/.test(s)), `spans open onto the acquisitions: ${snippets.join(" | ")}`);
  assert.match(real.witness!.detail, /static candidate, not an observed deadlock/);
  assert.ok(!/observed deadlock occurs|was observed|deadlocked/i.test(JSON.stringify(real).replace(/not an observed deadlock/g, "")), "no observed-deadlock wording");
  assert.ok(real.coverageGaps.some((g) => /entry points can really run at the same time/.test(g)), "concurrency is stated as not established");
  assert.ok(real.safetyObligations.length >= 2 && real.safetyObligations.every((o) => o.state === "PENDING"));
  // The control: both orders always taken under one gate lock.
  const guarded = locks.find((f) => locksOf(f).join() === "ledgerA,ledgerB")!;
  assert.ok(guarded, "the guarded cycle is still reported");
  assert.equal(guarded.severity, "LOW");
  assert.ok(guarded.coverageGaps.some((g) => /not realizable as written: every path that takes these locks first takes ledgerGuard/.test(g)));
  assert.match(guarded.witness!.detail, /probably not realizable/);
  // Stable identity: same code, same ids.
  const again = detectIndexedDefects(svc.store, revision).findings.filter((f) => f.kind === "DEADLOCK_CANDIDATE").map((f) => f.id);
  assert.deepEqual(again, locks.map((f) => f.id));
  worker.close();
});

test("DP02: reentrant, try-lock and timeout controls keep their meaning; a non-reentrant self-acquisition is a candidate; Rust guards end with their block", async () => {
  const { worker, locks } = await lockFindings();
  const sets = locks.map((f) => locksOf(f).join());
  assert.ok(!sets.some((s) => /pool/.test(s)), "a reentrant lock taken twice by one flow is not a deadlock");
  assert.ok(!sets.some((s) => /tray/.test(s)), "an inversion whose second acquisition is a try-lock never blocks, so it is not a cycle");
  const timeout = locks.find((f) => locksOf(f).join() === "left,right")!;
  assert.ok(timeout && timeout.severity === "LOW", "a cycle whose wait gives up is reported, at low severity");
  assert.match(timeout.witness!.detail, /has a timeout/);
  const self = locks.find((f) => f.witness?.kind === "SELF_DEADLOCK" && locksOf(f).join() === "single")!;
  assert.ok(self, "a non-reentrant mutex taken again through a callee waits on itself");
  assert.equal(self.severity, "HIGH");
  assert.match(self.witness!.detail, /not declared reentrant/);
  const rust = locks.find((f) => locksOf(f).join() === "a,b")!;
  assert.ok(rust && rust.entityIds.some((id) => /a_then_b/.test(id)) && rust.entityIds.some((id) => /b_then_a/.test(id)));
  assert.ok(!rust.entityIds.some((id) => /scoped_a_then_b/.test(id)), "the Rust function whose first guard is dropped by its block is not part of the cycle");
  worker.close();
});

test("DP01/02: fixing the lock order removes the finding, and making a reentrant lock non-reentrant creates one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cie-defect-")); cpSync(FIX, dir, { recursive: true });
  const f = join(dir, "src/locks/transfer.ts");
  const text = readFileSync(f, "utf8");
  // Same two functions, now both take A before B.
  writeFileSync(f, text.replace(/export async function transferBtoA\(amount: number\) \{\n  const b = await accountB\.acquire\(\);\n  const a = await accountA\.acquire\(\);\n  try \{ return amount; \} finally \{ a\.release\(\); b\.release\(\); \}/, `export async function transferBtoA(amount: number) {\n  const a = await accountA.acquire();\n  const b = await accountB.acquire();\n  try { return amount; } finally { b.release(); a.release(); }`));
  const fixed = await lockFindings(dir);
  assert.ok(!fixed.locks.some((x) => locksOf(x).join() === "accountA,accountB"), "one global order: no cycle");
  assert.ok(fixed.locks.some((x) => locksOf(x).join() === "ledgerA,ledgerB"), "the other findings are unaffected");
  fixed.worker.close();
  writeFileSync(f, text.replace("export const pool = new ReentrantLock(\"pool\");", "export const pool = new Mutex(\"pool\");"));
  const broken = await lockFindings(dir);
  assert.ok(broken.locks.some((x) => x.witness?.kind === "SELF_DEADLOCK" && locksOf(x).join() === "pool"), "pool is no longer declared reentrant, so its nested acquisition is a candidate");
  broken.worker.close();
});

test("DP01/02: the scanner understands what it claims to, and nothing inside comments or strings", () => {
  const ts = (body: string) => scanFunction(body, "ts");
  // comments and strings are not code
  const s0 = ts(`async function f() { // await a.acquire();\n  const s = "b.acquire()"; /* c.acquire() */ const g = await d.acquire(); g.release(); }`);
  assert.deepEqual(s0.acquisitions.map((a) => a.lock), ["d"]);
  assert.equal(blank("x // y\nz", "ts").includes("y"), false);
  // explicit release ends the hold; nested acquisition records what was held
  const s1 = ts(`async function f() { const a = await A.acquire(); const b = await B.acquire(); b.release(); a.release(); const c = await C.acquire(); c.release(); }`);
  assert.deepEqual(s1.acquisitions.map((x) => [x.lock, x.heldBefore.join("+")]), [["A", ""], ["B", "A"], ["C", ""]]);
  assert.equal(s1.locksHeldAtEnd.length, 0);
  // runExclusive holds exactly for its callback
  const s2 = ts(`async function f() { await M.runExclusive(async () => { const n = await N.acquire(); n.release(); }); const n2 = await N.acquire(); n2.release(); }`);
  assert.deepEqual(s2.acquisitions.map((x) => [x.lock, x.heldBefore.join("+"), x.kind]), [["M", "", "scoped"], ["N", "M", "blocking"], ["N", "", "blocking"]]);
  // ...and a lock acquired and never released stays held, so taking it again is nested
  const s2b = ts(`async function f() { await N.acquire(); await N.acquire(); }`);
  assert.deepEqual(s2b.acquisitions.map((x) => [x.lock, x.heldBefore.join("+"), x.reentrant]), [["N", "", false], ["N", "N", true]]);
  // timeouts and try-locks are recognised
  const s3 = ts(`async function f() { const a = await A.acquire(); const b = await B.acquire({ timeout: 5 }); const c = C.tryAcquire(); }`);
  assert.deepEqual(s3.acquisitions.map((x) => x.kind), ["blocking", "timeout", "try"]);
  // a lock named by a parameter is flagged as uncertain
  const s4 = ts(`async function f(lock) { const g = await lock.acquire(); g.release(); }`);
  assert.equal(s4.acquisitions[0].aliasUncertain, true);
  // Rust: a guard lives to the end of its block; drop() ends it early
  const r1 = scanFunction(`fn f(&self) { { let a = self.a.lock().unwrap(); } let b = self.b.lock().unwrap(); let c = self.c.lock().unwrap(); drop(c); let d = self.d.lock().unwrap(); }`, "rust");
  assert.deepEqual(r1.acquisitions.map((x) => [x.lock, x.heldBefore.join("+")]), [["a", ""], ["b", ""], ["c", "b"], ["d", "b"]]);
  // loops and awaits
  const s5 = ts(`async function f(ids) { for (const id of ids) { await db.query(id); } ids.forEach(async (x) => { await db.get(x); }); }`);
  assert.deepEqual(s5.loops.map((l) => l.kind), ["for", "iter"]);
  assert.ok(s5.calls.filter((c) => c.loops.length).length >= 2);
});
