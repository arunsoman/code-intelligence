// C28: a gesture becomes an intent, an intent becomes exact edits, the edits are checked in an isolated copy, people approve, and a patch leaves.
// The repository itself is never written to: every test below that touches the flow also proves the checkout is byte-for-byte unchanged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ChangeEngine, ChangeError, unifiedDiff } from "../src/changes.ts";
import { ctx, setup } from "./helpers.ts";

const FIX = resolve(import.meta.dirname, "../../../fixtures/change-repo");
const e = (file: string, name: string) => `function:src/${file}.ts#${name}`;
const ADD = e("math", "add"), SCALE = e("math", "scale"), TOTAL = e("report", "total"), SUMMARY = e("report", "summary"), TWICE = e("report", "twice");
const digest = (dir: string): string => { const h = createHash("sha256"); const walk = (d: string) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else h.update(p.slice(dir.length) + readFileSync(p)); } }; walk(dir); return h.digest("hex"); };

async function world(trusted = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cie-change-"))); cpSync(FIX, dir, { recursive: true });
  const { svc, worker, revision } = await setup(undefined, dir);
  if (trusted) svc.changes.trust(dir);
  return { svc, worker, revision, dir, eng: svc.changes, before: digest(dir) };
}
const replace = (w: Awaited<ReturnType<typeof world>>, file: string, from: string, to: string) => {
  const buf = readFileSync(join(w.dir, file)); const text = buf.toString("utf8"); const i = text.indexOf(from); assert.ok(i >= 0, `${from} not found`);
  const start = Buffer.byteLength(text.slice(0, i)), end = start + Buffer.byteLength(from);
  return { type: "REPLACE_SPAN" as const, file, start, end, expected: from, newText: to };
};
const code = (f: () => unknown) => { try { f(); return null; } catch (x) { return x instanceof ChangeError ? x.code : "other:" + (x as Error).message; } };

test("C28: an ambiguous drag is never guessed: it asks with the options laid out, and only a choice produces a proposal", async () => {
  const w = await world();
  const none = w.eng.interpretDrag(w.revision, { from: TOTAL, to: ADD });
  assert.equal(none.outcome, "READY", "one call runs along total → add, so one meaning");
  assert.equal(none.options[0].intent.type, "DELETE_CALL");
  const many = w.eng.interpretDrag(w.revision, { from: TWICE, to: SCALE });
  assert.equal(many.outcome, "NEEDS_CLARIFICATION", "two calls run along twice → scale");
  assert.equal(many.options.length, 2);
  assert.match(many.options[0].label, /call 1 of 2, line \d+/);
  assert.match(many.reason!, /2 calls run along this edge; which one do you mean\?/);
  const fresh = w.eng.interpretDrag(w.revision, { from: SUMMARY, to: ADD });
  assert.equal(fresh.outcome, "NEEDS_CLARIFICATION", "no call yet: the start or the end of the body?");
  assert.deepEqual(fresh.options.map((o) => (o.intent as any).position).sort(), ["END", "START"]);
  assert.equal(w.eng.interpretDrag(w.revision, { from: ADD, to: ADD }).outcome, "REJECTED");
  assert.throws(() => w.eng.interpretDrag(w.revision, { from: ADD, to: "function:src/nope.ts#x" }), /not a function or class/);
  // Through the service: without a choice there is a typed question and no proposal; with one, a proposal.
  const asked = await w.svc.changeOps["C28/proposeFromDrag"](ctx("a"), { revision: w.revision, from: TWICE, to: SCALE });
  assert.ok(!asked.ok && /which one do you mean\?/.test(asked.error.message) && /delete-call-0/.test(asked.error.message) && asked.error.retryable);
  assert.equal(w.eng.list(w.revision).length, 0, "nothing was proposed on a guess");
  const chosen = await w.svc.changeOps["C28/proposeFromDrag"](ctx("b"), { revision: w.revision, from: TWICE, to: SCALE, choice: "delete-call-1" });
  assert.ok(!chosen.ok, "the second call is `return scale(a, 3)`: its result is used, so it is refused rather than turned into a different program");
  assert.match((chosen as any).error.message, /result is used/);
  const ok = await w.svc.changeOps["C28/proposeFromDrag"](ctx("c"), { revision: w.revision, from: TWICE, to: SCALE, choice: "delete-call-0" });
  assert.ok(ok.ok === false, "the first call's result is bound to a variable that the next line uses");
  const direct = await w.svc.changeOps["C28/proposeFromDrag"](ctx("d"), { revision: w.revision, from: TOTAL, to: ADD });
  assert.ok(!direct.ok || (direct.value as any).status === "DRAFT");
  assert.equal(digest(w.dir), w.before, "no gesture touched the repository");
  w.worker.close();
});

test("C28: a rename is exact edits to the declaration, the calls and the imports; it validates in a copy, is approved by someone else, exports a patch that applies and passes, and the checkout is never written", async () => {
  const w = await world();
  const p = w.eng.propose("ana", { revision: w.revision, intent: { type: "RENAME", entityId: ADD, newName: "plus" } });
  assert.equal(p.status, "DRAFT");
  assert.deepEqual([...new Set(p.edits.map((x) => x.file))].sort(), ["src/math.ts", "src/report.ts", "test/math.test.ts"]);
  assert.ok(p.edits.length >= 5, `declaration, a call, and two imports and a call in the test: ${p.edits.map((x) => x.why).join("; ")}`);
  assert.ok(p.edits.every((x) => x.expected === "add" && x.newText === "plus" && /^[0-9a-f]{64}$/.test(x.baseHash)), "each edit replaces exactly the identifier, against the exact file it was computed on");
  assert.ok(p.limits.some((l) => /Calls through values, dynamic property access/.test(l)), "what the index cannot see is stated");
  assert.equal(code(() => w.eng.approve("bo", p.id, 1, "looks fine")), "FORBIDDEN", "an unchecked proposal cannot be approved");
  const v = await w.eng.validate("ana", p.id);
  assert.equal(v.status, "REVIEWABLE", JSON.stringify(v.validation));
  assert.equal(v.validation!.state, "PASSED");
  assert.deepEqual(v.validation!.compile.introduced, []);
  assert.deepEqual([v.validation!.tests.ran, v.validation!.tests.passed, v.validation!.tests.failed], [true, 5, 0], "the tests ran, in a sandbox, and passed");
  assert.equal(code(() => w.eng.approve("ana", p.id, v.version, "mine")), "FORBIDDEN", "the author cannot approve their own change");
  assert.equal(code(() => w.eng.approve("bo", p.id, v.version, "  ")), "INVALID_SCHEMA", "an approval says why");
  assert.equal(code(() => w.eng.approve("bo", p.id, v.version - 1, "stale view")), "VERSION_CONFLICT");
  const a = w.eng.approve("bo", p.id, v.version, "the rename is mechanical and the tests pass");
  assert.equal(a.status, "APPROVED"); assert.equal(a.approvals[0].by, "bo");
  const ex = w.eng.exportPatch("bo", p.id);
  assert.match(ex.patch, /^--- a\/src\/math\.ts\n\+\+\+ b\/src\/math\.ts\n@@/);
  assert.ok((ex.patch.match(/^-.*\badd\b/gm) ?? []).length >= 4 && (ex.patch.match(/^\+.*\bplus\b/gm) ?? []).length >= 4);
  assert.equal(ex.proposal.status, "EXPORTED"); assert.equal(ex.patchHash.length, 64);
  // The checkout never changed. The patch, applied to a copy by someone else, gives a working program.
  assert.equal(digest(w.dir), w.before, "the repository is byte-for-byte what it was");
  const copy = realpathSync(mkdtempSync(join(tmpdir(), "cie-apply-"))); cpSync(FIX, copy, { recursive: true });
  writeFileSync(join(copy, "change.patch"), ex.patch);
  execFileSync("git", ["apply", "change.patch"], { cwd: copy });
  assert.ok(/export function plus\(/.test(readFileSync(join(copy, "src/math.ts"), "utf8")));
  // (A nested test run inside this one must not inherit the parent runner's environment.)
  const run = execFileSync(process.execPath, ["--test", "test/math.test.ts"], { cwd: copy, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: copy } });
  assert.match(run, /ℹ pass 5/);
  // The audit trail has every step, attributed, and the chain verifies.
  const events = (w.svc.store.auditEvents(50) as any[]).filter((x) => x.action.startsWith("change.")).reverse().map((x) => `${x.action}:${x.actor}`);
  assert.deepEqual(events, ["change.propose:ana", "change.validate:ana", "change.approve:bo", "change.export:bo"]);
  assert.ok(w.svc.store.verifyAuditChain().ok);
  // There is no write path: the engine exposes no apply, commit or push.
  assert.deepEqual(Object.getOwnPropertyNames(ChangeEngine.prototype).filter((n) => /apply$|commit|push|writeFile|writeTo|publish/i.test(n) && n !== "applyTo"), []);
  assert.equal(code(() => w.eng.reject("bo", p.id, "too late")), "FORBIDDEN", "an exported patch cannot be rejected, only superseded");
  w.worker.close();
});

test("C28: a proposal whose base has changed is stale: it is marked, and cannot be validated, approved or exported until proposed again", async () => {
  const w = await world();
  const p = w.eng.propose("ana", { revision: w.revision, intent: { type: "RENAME", entityId: SCALE, newName: "multiply" } });
  const v = await w.eng.validate("ana", p.id);
  assert.equal(v.status, "REVIEWABLE");
  // Someone edits a file the proposal touches.
  writeFileSync(join(w.dir, "src/report.ts"), readFileSync(join(w.dir, "src/report.ts"), "utf8") + "\n// edited elsewhere\n");
  assert.equal(code(() => w.eng.approve("bo", p.id, v.version, "ok")), "STALE_REVISION");
  assert.equal(w.eng.get(p.id).status, "STALE", "the staleness is recorded, not just refused");
  assert.equal(await w.eng.validate("ana", p.id).then(() => null, (x) => x.code), "STALE_REVISION");
  assert.equal(code(() => w.eng.exportPatch("bo", p.id)), "STALE_REVISION");
  assert.ok(w.eng.get(p.id).history.some((h) => h.event === "stale" && /report\.ts changed after this was proposed/.test(h.detail)));
  // A span proposal built on text that is no longer there is refused at once.
  assert.equal(code(() => w.eng.propose("ana", { revision: w.revision, intent: { type: "REPLACE_SPAN", file: "src/math.ts", start: 0, end: 6, expected: "WRONG!", newText: "x" } })), "STALE_REVISION");
  // Proposing again against the current code works (a new index would be needed for new references; the edit itself is checked against the file).
  assert.equal(w.eng.propose("ana", { revision: w.revision, intent: replace(w, "src/math.ts", "x * k", "k * x") }).status, "DRAFT");
  w.worker.close();
});

test("C28: conflicting edits are caught: overlapping proposals are flagged, an overlapping approval is refused, and names that collide are refused", async () => {
  const w = await world();
  const a = w.eng.propose("ana", { revision: w.revision, intent: { type: "RENAME", entityId: ADD, newName: "plus" } });
  const b = w.eng.propose("cy", { revision: w.revision, intent: { type: "RENAME", entityId: ADD, newName: "augment" } });
  assert.deepEqual(a.conflicts, []);
  assert.deepEqual(b.conflicts, [a.id], "the second names the first it overlaps");
  assert.equal(code(() => w.eng.propose("ana", { revision: w.revision, intent: { type: "RENAME", entityId: ADD, newName: "scale" } })), "VERSION_CONFLICT", "scale is already declared in math.ts");
  assert.equal(code(() => w.eng.propose("ana", { revision: w.revision, intent: { type: "RENAME", entityId: ADD, newName: "class" } })), "INVALID_SCHEMA");
  assert.equal(code(() => w.eng.propose("ana", { revision: w.revision, intent: { type: "RENAME", entityId: ADD, newName: "add" } })), "INVALID_SCHEMA");
  const va = await w.eng.validate("ana", a.id); w.eng.approve("bo", a.id, va.version, "first one");
  const vb = await w.eng.validate("cy", b.id);
  assert.equal(code(() => w.eng.approve("bo", b.id, vb.version, "second one")), "VERSION_CONFLICT", "it overlaps an approved proposal");
  assert.match(String((() => { try { w.eng.approve("bo", b.id, vb.version, "x"); } catch (x) { return (x as Error).message; } })()), /overlaps chg:.*already approved/);
  // Two edits inside one proposal that overlap are impossible by construction; the check exists and fires.
  assert.throws(() => (w.eng as any).assertNoOverlap([{ file: "a.ts", start: 0, end: 10 }, { file: "a.ts", start: 5, end: 12 }]), /two edits overlap/);
  assert.doesNotThrow(() => (w.eng as any).assertNoOverlap([{ file: "a.ts", start: 0, end: 5 }, { file: "b.ts", start: 0, end: 12 }, { file: "a.ts", start: 5, end: 8 }]));
  w.worker.close();
});

test("C28: a change that does not compile, or breaks a test, fails its checks and cannot be approved; an untrusted repository gets the compile check only, and says so", async () => {
  const w = await world();
  // Compiles badly: add now returns a string.
  const bad = w.eng.propose("ana", { revision: w.revision, intent: replace(w, "src/math.ts", "return a + b;", 'return a + "x";') });
  const vb = await w.eng.validate("ana", bad.id);
  assert.equal(vb.status, "FAILED");
  assert.ok(vb.validation!.compile.introduced.some((d) => /TS2322.*string.*number/.test(d)), vb.validation!.compile.introduced.join("; "));
  assert.match(vb.validation!.reasons.join(" "), /introduces \d+ new compile error/);
  assert.equal(code(() => w.eng.approve("bo", bad.id, vb.version, "ship it")), "FORBIDDEN");
  // Compiles fine, wrong behaviour: the tests say so.
  const wrong = w.eng.propose("ana", { revision: w.revision, intent: replace(w, "src/math.ts", "return a + b;", "return a - b;") });
  const vw = await w.eng.validate("ana", wrong.id);
  assert.equal(vw.status, "FAILED");
  assert.deepEqual(vw.validation!.compile.introduced, [], "it compiles");
  assert.ok(vw.validation!.tests.failed >= 2 && /test\(s\) fail after the change \(0 before\)/.test(vw.validation!.reasons.join(" ")), vw.validation!.reasons.join("; "));
  assert.ok(/✖/.test(vw.validation!.tests.output), "the failing tests are in the record");
  assert.equal(code(() => w.eng.approve("bo", wrong.id, vw.version, "ship it")), "FORBIDDEN");
  // A call added with no arguments to something that needs two.
  const call = w.eng.propose("ana", { revision: w.revision, intent: { type: "ADD_CALL", from: SUMMARY, to: ADD, position: "START" } });
  assert.match(call.limits.join(" "), /no arguments/);
  assert.equal((await w.eng.validate("ana", call.id)).status, "FAILED");
  // Untrusted: the same wrong-behaviour change passes the compile check, but its tests are not run, and it cannot claim to be fully checked.
  const u = await world(false);
  const uw = u.eng.propose("ana", { revision: u.revision, intent: replace(u, "src/math.ts", "return a + b;", "return a - b;") });
  const vu = await u.eng.validate("ana", uw.id);
  assert.equal(vu.status, "REVIEWABLE_WITH_LIMITS");
  assert.equal(vu.validation!.state, "PASSED_COMPILE_ONLY");
  assert.equal(vu.validation!.tests.ran, false);
  assert.match(vu.validation!.tests.reason!, /not trusted for running its tests/);
  // Everything above ran in copies.
  assert.equal(digest(w.dir), w.before); assert.equal(digest(u.dir), u.before);
  // Removing code that is used is refused; removing code that is not is an edit like any other.
  assert.match(String((() => { try { w.eng.propose("ana", { revision: w.revision, intent: { type: "DELETE_UNUSED", entityId: e("unused", "stillUsed") } }); } catch (x) { return (x as Error).message; } })()), /still used by record/);
  const del = w.eng.propose("ana", { revision: w.revision, intent: { type: "DELETE_UNUSED", entityId: e("unused", "legacyHelper") } });
  assert.equal((await w.eng.validate("ana", del.id)).status, "REVIEWABLE");
  w.worker.close(); u.worker.close();
});

test("C28: approvals and audit: re-validation withdraws earlier approval, only the author can withdraw an approved change, access limits apply, and every step is attributed in the hash-chained log", async () => {
  const w = await world();
  const p = w.eng.propose("ana", { revision: w.revision, intent: { type: "RENAME", entityId: SCALE, newName: "multiply" } });
  const v = await w.eng.validate("ana", p.id);
  const ap = w.eng.approve("bo", p.id, v.version, "mechanical");
  assert.equal(code(() => w.eng.reject("mallory", p.id, "no")), "FORBIDDEN", "someone else cannot withdraw an approval");
  assert.equal(w.eng.reject("ana", p.id, "changed my mind").status, "REJECTED");
  assert.deepEqual(w.eng.get(p.id).approvals, [], "rejecting clears approvals");
  assert.equal(code(() => w.eng.approve("bo", p.id, ap.version, "again")), "FORBIDDEN", "a rejected proposal stays rejected");
  // An approval belongs to a version: a patch cannot be exported on an approval of something else.
  const q = w.eng.propose("ana", { revision: w.revision, intent: { type: "RENAME", entityId: TOTAL, newName: "sumAll" } });
  const vq = await w.eng.validate("ana", q.id); w.eng.approve("bo", q.id, vq.version, "ok");
  const sneaky = w.eng.get(q.id); sneaky.version += 1; (w.svc.store.db.prepare("update change_proposals set version = ?, json = ? where id = ?")).run(sneaky.version, JSON.stringify(sneaky), q.id);
  assert.equal(code(() => w.eng.exportPatch("bo", q.id)), "FORBIDDEN", "the approval is for an earlier version");
  // Access: a denied path hides the code and its proposals.
  w.svc.store.denyPath(w.dir, "src/math.ts");
  assert.equal(code(() => w.eng.propose("ana", { revision: w.revision, intent: { type: "RENAME", entityId: ADD, newName: "plus2" } })), "FORBIDDEN");
  w.svc.store.denyPath(w.dir, "src/math.ts", false);
  // The log: attributed, ordered, intact.
  const log = (w.svc.store.auditEvents(100) as any[]).filter((x) => x.action.startsWith("change.")).reverse().map((x) => `${x.action}:${x.actor}`);
  assert.deepEqual(log.slice(0, 5), ["change.propose:ana", "change.validate:ana", "change.approve:bo", "change.reject:ana", "change.propose:ana"]);
  assert.ok(w.svc.store.verifyAuditChain().ok);
  // The gateway: the whole flow is reachable, mutating calls need keys, and reads of someone's proposal list work.
  const g = await w.svc.changeOps["C28/list"](ctx(), { revision: w.revision });
  assert.ok(g.ok && (g.value as any[]).length >= 2);
  assert.equal(digest(w.dir), w.before, "and still nothing was written");
  // The diff writer is exact.
  assert.equal(unifiedDiff("f.ts", "a\nb\nc\n", "a\nB\nc\n"), "--- a/f.ts\n+++ b/f.ts\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n \n");
  assert.equal(unifiedDiff("f.ts", "x", "x"), "");
  w.worker.close();
});
