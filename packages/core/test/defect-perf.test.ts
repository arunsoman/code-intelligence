// DP08 / DP09 / DP10 on real indexed code: what is a candidate, what is refused as unsafe, how a change to locking is judged, and how
// candidates are ranked by a named workload without mistaking a missing measurement for a fast function.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { DetectorFinding } from "@cie/schema";
import type { TimedSpan } from "../src/defect-performance.ts";
import { detectPerformance, rankByWorkload, type Profile } from "../src/defect/perf.ts";
import { setup } from "./helpers.ts";

const FIX = resolve(import.meta.dirname, "../../../fixtures/defect-repo");
const fnOf = (f: DetectorFinding) => f.entityIds[0].replace(/^.*#/, "");
async function scan(repo = FIX) {
  const { svc, worker, revision } = await setup(undefined, repo);
  const rev = svc.store.revision(revision)!;
  return { svc, worker, revision, rev, findings: detectPerformance(svc.store, rev) };
}
const by = (fs: DetectorFinding[], rule: string, fn?: string) => fs.filter((f) => f.ruleId === `defect.${rule}` && (!fn || fnOf(f) === fn));
const id = (name: string) => `function:src/perf/orders.ts#${name}`;

test("DP08: a loop condition is a candidate only through the same safety gates as any move: getters, aliased objects and mutated state are refused; a pure bound is a candidate that still needs a benchmark", async () => {
  const { worker, findings } = await scan();
  const loops = by(findings, "loop-condition-reevaluated");
  const get = (fn: string) => loops.find((f) => fnOf(f) === fn)!;
  const detail = (f: DetectorFinding) => JSON.parse(f.witness!.detail.replace(/^[^{]*/, ""));
  assert.equal(detail(get("pureBound")).safeCandidate, true, "a pure builtin of a plain number is invariant");
  assert.ok(get("pureBound").safetyObligations.some((o) => /Benchmark the actual build; no improvement has been measured/.test(o.description)), "even a safe candidate asks for a benchmark");
  for (const unsafe of ["invariantLooking", "mutatingLoop", "summarize"]) {
    const f = get(unsafe);
    assert.equal(detail(f).safeCandidate, false, `${unsafe} is refused`);
    assert.ok(f.coverageGaps.some((g) => /Not proposed for change: the safety gates do not pass/.test(g)));
  }
  assert.ok(get("invariantLooking").coverageGaps.some((g) => /purity or call effects are unresolved/.test(g)), "a call on a caller's object might be a getter or change");
  assert.ok(get("mutatingLoop").coverageGaps.some((g) => /alias identity is unresolved|loop-mutated state/.test(g)), "the body changes what the condition reads");
  assert.ok(get("pureBound").safetyObligations.some((o) => /exception timing and empty-loop/.test(o.description)));
  worker.close();
});

test("DP09: lock-per-iteration and I/O-in-lock are found; moving the I/O out of the lock resolves the second; coarsening the lock resolves the first but makes the hold longer, and is reported as that", async () => {
  const before = await scan();
  const lp = by(before.findings, "lock-per-iteration", "lockedWrites"), io = by(before.findings, "io-in-critical-section", "lockedWrites");
  assert.equal(lp.length, 1); assert.equal(io.length, 1);
  assert.ok(lp[0].safetyObligations.some((o) => /does not hold it across I\/O or long work/.test(o.description)) && lp[0].safetyObligations.some((o) => /protected invariant holds between iterations/.test(o.description)));
  assert.ok(io[0].safetyObligations.some((o) => /still consistent if the I\/O moves outside it/.test(o.description)));
  assert.equal(by(before.findings, "io-in-critical-section", "lockedDecision").length + by(before.findings, "lock-per-iteration", "lockedDecision").length, 0, "the control: the lock covers only the decision, so neither pattern is present");
  // Coarsening: one lock around the loop.
  const coarse = by(before.findings, "lock-held-across-io-loop", "coarsenedWrites");
  assert.equal(coarse.length, 1, "the coarsened version holds one lock across every I/O call");
  assert.equal(by(before.findings, "lock-per-iteration", "coarsenedWrites").length, 0, "so the per-iteration finding is gone");
  assert.match(coarse[0].witness!.detail, /held across a loop of I\/O calls/);
  // The change as a patch: lockedWrites becomes coarsenedWrites. Re-run the detectors on the edited code and compare finding sets.
  const dir = mkdtempSync(join(tmpdir(), "cie-perf-")); cpSync(FIX, dir, { recursive: true });
  const f = join(dir, "src/perf/orders.ts");
  writeFileSync(f, readFileSync(f, "utf8").replace("for (const it of items) { await lock.runExclusive(async () => { await db.update(it); }); }", "await lock.runExclusive(async () => { for (const it of items) { await db.update(it); } });"));
  const after = await scan(dir);
  const rules = (fs: DetectorFinding[]) => new Set(by(fs, "lock-per-iteration", "lockedWrites").map(() => "lock-per-iteration").concat(by(fs, "io-in-critical-section", "lockedWrites").map(() => "io-in-critical-section"), by(fs, "lock-held-across-io-loop", "lockedWrites").map(() => "lock-held-across-io-loop")));
  assert.deepEqual([...rules(before.findings)].sort(), ["io-in-critical-section", "lock-per-iteration"]);
  assert.deepEqual([...rules(after.findings)].sort(), ["lock-held-across-io-loop"], "the per-iteration lock is resolved; the lock is now held across the whole loop");
  // Narrowing: do the decision under the lock and the I/O outside it.
  writeFileSync(f, readFileSync(f, "utf8").replace("await lock.runExclusive(async () => { for (const it of items) { await db.update(it); } });", "const chosen = await lock.runExclusive(async () => items.slice()); for (const it of chosen) { await db.update(it); }"));
  const narrowed = await scan(dir);
  assert.equal([...rules(narrowed.findings)].length, 0, "with the I/O outside the lock, no lock finding remains for that function");
  before.worker.close(); after.worker.close(); narrowed.worker.close();
});

const span = (o: Partial<TimedSpan> & { id: string; startMs: number; endMs: number }, rev: string, w: string): TimedSpan => ({ parentId: null, entityId: null, revision: rev, buildHash: "b".repeat(64), workloadHash: w, clock: "c1", category: "OTHER", ...o });

test("DP10: static candidates are ranked by what a named workload spent in them; the order follows the workload; missing, wrong-revision and absent measurements are never read as 'fast'", async () => {
  const { worker, rev, findings } = await scan();
  const n1 = by(findings, "n-plus-one", "loadOrders")[0];
  assert.ok(n1 && n1.evidenceLevel === "STATIC_CANDIDATE");
  assert.equal(by(findings, "n-plus-one", "loadOrdersBatched").length, 0, "the batched control is not an N+1");
  assert.equal(findings.filter((f) => fnOf(f) === "summarize" && f.kind === "REPEATED_EXTERNAL_CALL").length, 0, "CPU-only code is not an external-call finding");
  assert.ok(by(findings, "serial-independent-awaits", "serial").length === 1, "two awaits that do not depend on each other");
  const cand = [n1, ...by(findings, "loop-condition-reevaluated", "summarize")];
  assert.equal(cand.length, 2);
  // Unmeasured: static, with the reason.
  const none = rankByWorkload(cand, null);
  assert.ok(none.every((r) => r.evidenceLevel === "STATIC_CANDIDATE" && r.measuredExclusiveMs === null && /No workload was measured/.test(r.why)));
  // Workload A: few ids, so the N+1 is cheap and the CPU loop dominates.
  const A = "a".repeat(64), B = "c".repeat(64), r = rev.id;
  const workload = (w: string, queries: number, queryMs: number, cpuMs: number): Profile => ({
    revision: r, buildHash: "b".repeat(64), workloadHash: w,
    spans: [
      span({ id: "req", startMs: 0, endMs: 10_000 }, r, w),
      span({ id: "load", parentId: "req", entityId: id("loadOrders"), startMs: 0, endMs: queries * queryMs + 2, category: "IO" }, r, w),
      ...Array.from({ length: queries }, (_, i) => span({ id: `q${i}`, parentId: "load", startMs: i * queryMs + 1, endMs: (i + 1) * queryMs + 1, category: "IO" }, r, w)),
      span({ id: "sum", parentId: "req", entityId: id("summarize"), startMs: 5000, endMs: 5000 + cpuMs, category: "CPU" }, r, w),
    ],
  });
  const a = rankByWorkload(cand, workload(A, 5, 4, 300));
  assert.equal(fnOf(a[0].finding), "summarize", "the CPU loop dominates a small workload");
  assert.ok(a.every((x) => x.evidenceLevel === "MEASURED" && x.workloadHash === A));
  assert.ok(a[0].measuredExclusiveMs! > a[1].measuredExclusiveMs!);
  const b = rankByWorkload(cand, workload(B, 500, 4, 300));
  assert.equal(fnOf(b[0].finding), "loadOrders", "the same code, a larger workload: the N+1 now dominates, and the order says which workload it is for");
  assert.ok(b[0].shareOfWorkload! > a[1].shareOfWorkload!);
  assert.match(b[0].why, /self time in workload cccccccc/);
  // The N+1 is charged for what its unattributed child queries cost on its behalf, not for waiting on nothing.
  assert.ok(Math.abs(b[0].measuredExclusiveMs! - (500 * 4 + 2 - 500 * 4 + 500 * 4)) < 5, `measured ${b[0].measuredExclusiveMs}`);
  // A function the workload never touched is not exonerated.
  const partial = rankByWorkload(cand, { ...workload(A, 5, 4, 300), spans: workload(A, 5, 4, 300).spans.filter((s) => s.entityId !== id("summarize")) });
  const unseen = partial.find((x) => fnOf(x.finding) === "summarize")!;
  assert.equal(unseen.evidenceLevel, "STATIC_CANDIDATE");
  assert.match(unseen.why, /not evidence it is fast/);
  assert.equal(partial[partial.length - 1], unseen, "unmeasured candidates go after every measured one");
  // A profile from another revision says nothing about this code.
  const wrong = rankByWorkload(cand, { ...workload(A, 5, 4, 300), revision: "some-other-revision" });
  assert.ok(wrong.every((x) => x.evidenceLevel === "STATIC_CANDIDATE" && /another revision/.test(x.why)));
  // Connection waits are charged to the code that waits for them, in their own category, not summed with their children.
  const waits = rankByWorkload([...by(findings, "n-plus-one", "loadOrders")], { ...workload(A, 5, 4, 300), spans: [...workload(A, 5, 4, 300).spans, span({ id: "pool", parentId: "load", startMs: 22, endMs: 622, category: "POOL" }, r, A)] });
  assert.ok(waits[0].measuredExclusiveMs! >= 600, "a 600 ms pool wait under loadOrders is part of what loadOrders spent");
  worker.close();
});
