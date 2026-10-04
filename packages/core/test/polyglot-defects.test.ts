import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { detectIndexedDefects } from "../src/defect-indexed.ts";
import { Security } from "../src/security.ts";
import { scanFunction } from "../src/defect/source.ts";
import { setup } from "./helpers.ts";

const REPO = resolve(import.meta.dirname, "../../../fixtures/polyglot-defects");
async function world() {
  const t = await setup(undefined, REPO);
  const r: any = detectIndexedDefects(t.svc.store, t.revision);
  const findings: any[] = r.findings ?? r.value?.findings ?? [];
  const hits = (rule: string) => findings.filter((f) => f.ruleId === rule).flatMap((f) => f.entityIds.map((e: string) => e.replace(/^[a-z]+:.*#/, ""))).sort();
  return { ...t, findings, hits };
}
const analyzed = (t: Awaited<ReturnType<typeof world>>) => new Security(t.svc.store).analyze({ revision: t.revision });

test("lock-order inversions are found in Java (ReentrantLock and synchronized), Go (sync.Mutex with defer) and Python (with-blocks), scoped to their own class, package and module, and consistent order or try-locks are not", async () => {
  const t = await world();
  const cycles = t.findings.filter((f) => f.ruleId === "defect.lock-order-cycle");
  const names = cycles.map((f) => f.entityIds.map((e: string) => e.replace(/^[a-z]+:.*#/, "")).sort().join("+")).sort();
  assert.deepEqual(names, ["Bank.AlsoForward+Bank.Backward", "Transfers.alsoForward+Transfers.backward", "Transfers.leftRight+Transfers.rightLeft", "also_forward+backward"]);
  for (const f of cycles) {
    assert.ok(f.evidenceIds.length > 0 && f.evidenceIds.every((id: string) => t.svc.store.evidence(t.revision, id)), "each finding cites stored evidence");
    assert.equal(f.evidenceLevel, "STATIC_CANDIDATE");
    assert.ok(f.coverageGaps.length > 0, "and says what it did not see");
  }
  // The same lock names in three languages are three different locks: no cycle spans two languages.
  assert.ok(cycles.every((f) => new Set(f.entityIds.map((e: string) => e.split("#")[0].split(".").pop())).size === 1));
  assert.ok(!names.some((n) => /polite/.test(n)), "the try-lock with a timeout gives up instead of waiting");
  t.worker.close();
});

test("performance candidates: one query per element in Java, Go and Python (a loop and a comprehension), a lock held across I/O, and nothing for the batched versions", async () => {
  const t = await world();
  assert.deepEqual(t.hits("defect.n-plus-one"), ["Bank.Totals", "OrderService.totalOf", "names", "totals"]);
  assert.deepEqual(t.hits("defect.io-in-critical-section"), ["OrderService.quote"], "a network call inside a synchronized method");
  const all = t.findings.map((f) => f.entityIds[0] as string);
  for (const safe of ["totalBatch", "totals_batch", "loginMasked"]) assert.ok(!all.some((e) => e.endsWith(`#${safe}`) || e.endsWith(`.${safe}`)), safe);
  const nplus = t.findings.find((f) => f.ruleId === "defect.n-plus-one" && /totalOf/.test(f.entityIds[0]))!;
  assert.match(nplus.witness.detail, /blocks once per element of ids/, "Java, Go and Python calls block; the wording says so rather than 'awaited'");
  assert.ok(nplus.coverageGaps.some((g: string) => /judged from its name/.test(g)));
  t.worker.close();
});

test("resource lifecycle: unclosed streams, files, response bodies, tickers, connections, locks and thread pools are found; try-with-resources, defer, with and finally are understood", async () => {
  const t = await world();
  const got = t.findings.filter((f) => f.ruleId === "defect.resource-lifecycle").map((f) => `${f.entityIds[0].replace(/^[a-z]+:.*#/, "")}:${f.witness.paths[0][1]}`).sort();
  assert.deepEqual(got, ["OrderService.fireAndForget:executor", "OrderService.firstLine:file", "OrderService.guarded:lock", "count_rows:connection", "first_line:file", "guarded:lock", "poll:response", "poll:ticker", "readFirst:file"].sort());
  // The safe forms are absent, not merely down-ranked.
  for (const safe of ["firstLineSafely", "guardedSafely", "readFirstSafely", "first_line_safely", "guarded_safely"]) assert.ok(!got.some((g) => g.startsWith(`${safe}:`) || g.includes(`.${safe}:`)), safe);
  t.worker.close();
});

test("security rules in Java, Go and Python: secrets in logs (including f-strings and format arguments), and state changes reachable without an authorisation check, with declarations such as @PreAuthorize, @login_required and requireAuth(...) understood", async () => {
  const t = await world();
  const fs = analyzed(t);
  const pii = fs.filter((f) => f.ruleId === "R-PII-LOG").map((f) => f.summary).sort();
  assert.deepEqual(pii, [
    "OrderService.login logs email, password without masking it.", "login logs email, password without masking it.", "login logs email, password without masking it.", "login logs token without masking it.",
  ].sort());
  assert.ok(!pii.some((p) => /Masked|Safely|login_safely/.test(p)), "masked values and lengths are not secrets");
  const authz = fs.filter((f) => f.ruleId === "R-AUTHZ-GAP").map((f) => f.subject.split(">")[0].replace(/^[a-z]+:.*#/, "")).sort();
  assert.deepEqual(authz, ["OrderController.remove", "deleteHandler", "delete_item"]);
  for (const safe of ["OrderController.create", "OrderController.show", "admin_delete_item", "adminDeleteHandler"]) assert.ok(!authz.includes(safe), `${safe} is protected or read-only`);
  assert.ok(fs.every((f) => f.counterArgument.length > 0 && f.evidenceIds.every((id) => t.svc.store.evidence(t.revision, id))));
  assert.ok(fs.every((f) => f.state === "CANDIDATE"), "all are candidates until the alarm gate");
  t.worker.close();
});

test("the Python and brace-language scanners read what the detectors need: blocks by indentation, comprehensions, chained calls, locks declared as locks, Go's defer, Java's readLock()", () => {
  const py = scanFunction(`def f(self, ids):
    with self.lock:
        for i in ids:
            if i > 1:
                self.db.get(i)
    ys = [session.query(U).get(k) for k in ids]
    other.acquire(timeout=3)
    other.release()
`, "python", new Set());
  assert.deepEqual(py.loops.map((l) => l.kind), ["for", "iter"]);
  assert.equal(py.loops[0].iterable, "ids");
  assert.equal(py.ifs.length, 1);
  assert.deepEqual(py.acquisitions.map((a) => [a.lock, a.kind]), [["lock", "scoped"], ["other", "timeout"]]);
  const get = py.calls.find((c) => c.name === "get" && c.receiver === "self.db")!;
  assert.deepEqual(get.held, ["lock"]);
  assert.ok(py.calls.some((c) => c.name === "get" && c.receiver === "session.query" && c.loops.length === 1), "a call chained after another is seen, inside the comprehension");
  assert.deepEqual(py.releases.map((r) => r.lock), ["other"]);
  const known = scanFunction("def g():\n    with accounts:\n        work()\n", "python", new Set(["accounts"]));
  assert.equal(known.acquisitions.length, 1, "a name declared as a lock in the file is a lock whatever it is called");
  assert.equal(scanFunction("def g():\n    with open(p) as f:\n        work()\n", "python", new Set()).acquisitions.length, 0);
  const go = scanFunction("func (b *Bank) F() {\n\tb.mu.Lock()\n\tdefer b.mu.Unlock()\n\tfor _, id := range ids {\n\t\tb.db.Query(id)\n\t}\n}", "go");
  assert.deepEqual(go.locksHeldAtEnd, ["b.mu"], "a deferred unlock releases at return, so the lock is held for the body");
  assert.equal(go.loops[0].iterable, "ids");
  assert.deepEqual(go.calls.find((c) => c.name === "Query")!.held, ["b.mu"]);
  const jv = scanFunction("public void f() {\n  rw.readLock().lock();\n  try { synchronized (x) { g(); } } finally { rw.readLock().unlock(); }\n}", "java");
  assert.deepEqual(jv.acquisitions.map((a) => a.lock), ["rw.readLock", "x"]);
  assert.deepEqual(scanFunction("public synchronized void f() { g(); }", "java").acquisitions.map((a) => a.lock), ["this"], "a synchronized method holds this for the whole body");
});
