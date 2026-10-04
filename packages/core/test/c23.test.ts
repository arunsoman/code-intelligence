import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { History } from "../src/history.ts";
import { ctx, demoRepo, setup } from "./helpers.ts";

const edit = (dir: string, rel: string, f: (s: string) => string) => writeFileSync(join(dir, rel), f(readFileSync(join(dir, rel), "utf8")));
const reindex = async (svc: any, dir: string) => { const r = await svc.ingestRepository(ctx(), { repoPath: dir }); assert.ok(r.ok); return r.value.id as string; };
const commit = (dir: string, msg: string, date: string) => execFileSync("git", ["-C", dir, "-c", "user.name=Sam", "-c", "user.email=s@x", "commit", "-qam", msg, "--date", date], { env: { ...process.env, GIT_COMMITTER_DATE: date } });
const CHARGE = "function:src/payments/payment-service.ts#charge";

test("architectural change with a tiny text diff: one swapped call is reported as a transaction bypass, with what was reached before, and no cause is asserted", async () => {
  const dir = demoRepo();
  const { svc, worker, revision: base } = await setup(undefined, dir);
  edit(dir, "src/payments/payment-service.ts", (s) => s.replace("await ledger.reserve(accountId, amount);", "await ledger.adjustBalance(accountId, -amount);"));
  const head = await reindex(svc, dir);
  const diff = execFileSync("git", ["-C", dir, "diff", "--numstat"], { encoding: "utf8" }).trim().split("\n");
  assert.equal(diff.length, 1);
  assert.match(diff[0], /^1\t1\t/, "the text diff is one line");
  const h = new History(svc.store, svc.registry);
  const cs = h.compare(base, head);
  assert.equal(cs.textDiff.symbolsTouched, 1);
  const kinds = cs.consequences.map((c) => c.kind);
  assert.ok(kinds.includes("TRANSACTION_BYPASS"), kinds.join());
  const bypass = cs.consequences.find((c) => c.kind === "TRANSACTION_BYPASS")!;
  assert.match(bypass.text, /charge now reaches adjustBalance, which writes balance outside a transaction/);
  assert.ok(cs.consequences.some((c) => c.kind === "CALL_REMOVED" && /charge no longer calls reserve/.test(c.text)));
  assert.ok(cs.consequences.some((c) => c.kind === "CALL_ADDED" && /charge now calls adjustBalance/.test(c.text)));
  assert.ok(cs.consequences.some((c) => c.kind === "TRANSACTION_RESTORED" || c.kind === "WRITE_REACH_CHANGED"), "and what it stopped reaching");
  for (const c of cs.consequences) {
    assert.ok(c.evidenceIds.length > 0 && c.evidenceIds.every((id) => svc.store.evidence(head, id)), "each consequence cites stored evidence");
    assert.doesNotMatch(c.text, /\b(because|due to|caused|so that|in order to)\b/i, "a consequence says what is true, never why");
    assert.notEqual(c.displayMode, "HIDDEN");
  }
  assert.ok(cs.claims.every((c) => c.displayMode !== "FACT" || c.gates.find((g) => g.gate === "GROUNDING")!.status === "PASS"));
  // The blast radius reaches the controller that calls charge.
  const br = cs.blastRadius.find((b) => b.entityId === CHARGE)!;
  assert.ok(br.dependents >= 1 && br.files.some((f) => f.includes("payments-controller")));
  const impact = h.assessChangeImpact(cs).find((i) => i.entityId === CHARGE)!;
  assert.ok(impact.owners.includes("Dana") || impact.owners.length > 0);
  worker.close();
});

test("test-impact comparison: tests that reached the changed code before and no longer do are listed, as are the ones that now do", async () => {
  const dir = demoRepo();
  const { svc, worker, revision: base } = await setup(undefined, dir);
  edit(dir, "src/payments/payment-service.ts", (s) => s.replace("await ledger.reserve(accountId, amount);", "await ledger.adjustBalance(accountId, -amount);"));
  const head = await reindex(svc, dir);
  const cs = new History(svc.store, svc.registry).compare(base, head);
  // The one test that calls charge reached reserve through it; now it reaches adjustBalance instead.
  const forCharge = cs.testImpact.find((t) => t.entityId === CHARGE);
  assert.ok(!forCharge || forCharge.lost.length === 0, "tests still reach charge itself");
  const reserve = "function:src/ledger/ledger.ts#reserve";
  // Compare directly: tests reaching reserve in each revision.
  const { testsReaching } = await import("../src/testartifacts.ts");
  const before = testsReaching(svc.store, base, reserve).map((t) => t.name), after = testsReaching(svc.store, head, reserve).map((t) => t.name);
  assert.ok(before.length > 0 && after.length === 0, `before ${before} / after ${after}`);
  const adj = "function:src/ledger/ledger.ts#adjustBalance";
  assert.equal(testsReaching(svc.store, base, adj).length, 0);
  assert.ok(testsReaching(svc.store, head, adj).length > 0);
  // A change set over the callee shows the tests that lost it.
  edit(dir, "src/ledger/ledger.ts", (s) => s.replace("export async function reserve(id: string, amount: number) {", "export async function reserve(id: string, amount: number) {\n  void 0;"));
  const head2 = await reindex(svc, dir);
  const cs2 = new History(svc.store, svc.registry).compare(base, head2);
  const r = cs2.testImpact.find((t) => t.entityId === reserve);
  assert.ok(r && r.lost.length > 0 && r.gained.length === 0, JSON.stringify(cs2.testImpact));
  assert.ok(cs2.consequences.some((c) => c.kind === "TESTS_LOST" && /reserve/.test(c.text)));
  worker.close();
});

test("issue evidence gap: commits name issues and pull requests whose content is not available; the gap is stated, chronology is observed, and the narrative stays an inference", async () => {
  const dir = demoRepo();
  const { svc, worker, revision } = await setup(undefined, dir);
  edit(dir, "src/payments/fraud.ts", (s) => s + "\n// tightened\n");
  commit(dir, "Tighten fraud threshold after chargebacks (#231)", "2026-09-20T09:00:00Z");
  edit(dir, "src/payments/fraud.ts", (s) => s + "// again\n");
  commit(dir, "Handle velocity spikes, fixes #42", "2026-09-25T09:00:00Z");
  const rev = await reindex(svc, dir);
  void revision;
  const h = new History(svc.store, svc.registry);
  const a = h.archaeology(rev, "function:src/payments/fraud.ts#checkFraud");
  assert.ok(a.chronology.length >= 3);
  assert.deepEqual(a.chronology.map((c) => c.date), [...a.chronology.map((c) => c.date)].sort().reverse(), "newest first");
  for (const c of a.chronology) assert.ok(svc.store.evidence(rev, c.evidenceId), "chronology is evidenced");
  const gapRefs = a.gaps.map((g) => g.ref).sort();
  assert.deepEqual(gapRefs, ["PR #231", "issue #42"]);
  for (const g of a.gaps) { assert.equal(g.status, "NOT_AVAILABLE"); assert.match(g.gap, /content was not available, so the reason behind that change is not established/); }
  assert.ok(a.narrative.length > 0 && a.narrative.every((c) => c.displayMode !== "FACT"), "why is never fact");
  assert.ok(a.narrative.every((c) => c.draft.claimClass === "rationale" && /inference/.test(c.draft.rationaleSummary)));
  // A time window narrows the chronology.
  const narrow = h.archaeology(rev, "function:src/payments/fraud.ts#checkFraud", { from: "2026-09-22T00:00:00Z" });
  assert.deepEqual(narrow.chronology.map((c) => c.subject), ["Handle velocity spikes, fixes #42"]);
  worker.close();
});

test("merge and rename: a review thread follows its code through a rename and a confirmed merge, and keeps its history", async () => {
  const dir = demoRepo();
  const { svc, worker, revision: r1 } = await setup(undefined, dir);
  const h = new History(svc.store, svc.registry);
  const t1 = h.addThread("rita", { revision: r1, entityId: "function:src/payments/fraud.ts#checkFraud", text: "why 10k?" }).id;
  const t2 = h.addThread("rita", { revision: r1, entityId: CHARGE, text: "should this retry?" }).id;
  // Rename checkFraud (and its caller) in a "merged" revision.
  edit(dir, "src/payments/fraud.ts", (s) => s.replaceAll("checkFraud", "screenPayment")); edit(dir, "src/payments/payment-service.ts", (s) => s.replaceAll("checkFraud", "screenPayment"));
  edit(dir, "tests/payment-service.test.ts", (s) => s.replaceAll("checkFraud", "screenPayment"));
  const r2 = await reindex(svc, dir);
  const out = h.reanchorThreads(r2);
  assert.deepEqual(out, { moved: 1, kept: 1, orphaned: 0 });
  const rows = h.threads(svc.store.revision(r2)!.repoRoot);
  assert.equal(rows.find((r) => r.id === t1).entity_id, "function:src/payments/fraud.ts#screenPayment");
  assert.equal(rows.find((r) => r.id === t1).state, "OPEN");
  assert.equal(rows.find((r) => r.id === t2).entity_id, CHARGE);
  assert.deepEqual(h.threadHistory(t1).map((e) => e.event), ["CREATED", "REANCHORED"]);
  assert.equal(h.threadHistory(t1)[1].detail.from, "function:src/payments/fraud.ts#checkFraud");
  worker.close();
});

test("deleted symbols: a thread on removed code is kept, marked orphaned with where it was, and re-anchors if the code comes back", async () => {
  const dir = demoRepo();
  const { svc, worker, revision: r1 } = await setup(undefined, dir);
  const h = new History(svc.store, svc.registry);
  const gone = "function:src/ledger/ledger.ts#adjustBalance";
  const t = h.addThread("rita", { revision: r1, entityId: gone, text: "this should be transactional" }).id;
  const original = readFileSync(join(dir, "src/ledger/ledger.ts"), "utf8");
  edit(dir, "src/ledger/ledger.ts", (s) => s.slice(0, s.indexOf("// Used by background jobs")));
  edit(dir, "src/jobs/reconciler.ts", (s) => s.replace(/adjustBalance/g, "getAccount"));
  const r2 = await reindex(svc, dir);
  const cs = h.compare(r1, r2);
  assert.equal(cs.entities.find((e) => e.base === gone)!.change, "REMOVED");
  const out = h.reanchorThreads(r2);
  assert.equal(out.orphaned, 1);
  const row = h.threads(svc.store.revision(r2)!.repoRoot).find((r) => r.id === t);
  assert.equal(row.state, "ORPHANED");
  assert.equal(row.text, "this should be transactional", "the comment itself is untouched");
  const hist = h.threadHistory(t);
  assert.equal(hist.at(-1)!.event, "ORPHANED");
  assert.equal(hist.at(-1)!.detail.lastKnown, gone);
  // The function returns: the thread finds it again.
  writeFileSync(join(dir, "src/ledger/ledger.ts"), original);
  const r3 = await reindex(svc, dir);
  h.reanchorThreads(r3);
  assert.equal(h.threads(svc.store.revision(r3)!.repoRoot).find((r) => r.id === t).state, "OPEN");
  rmSync(join(dir, "tests"), { recursive: true, force: true });
  worker.close();
});

test("merge: when two functions are confirmed as merged into one, threads on either follow to the merged function; unconfirmed, they are orphaned rather than guessed", async () => {
  const { copyFixture } = await import("./helpers.ts");
  const dir = copyFixture();
  writeFileSync(join(dir, "src/steps.ts"), "export function a1() { return 1; }\nexport function a2() { return 2; }\nexport function a3() { return 3; }\nexport function a4() { return 4; }\n");
  const first = 'import { a1, a2, a3, a4 } from "./steps";\nexport function processFirst() { return a1() + a2(); }\nexport function processSecond() { return a3() + a4(); }\nexport function main() { return processFirst() + processSecond(); }\n';
  writeFileSync(join(dir, "src/proc.ts"), first);
  const { svc, worker, revision: r1 } = await setup(undefined, dir);
  const h = new History(svc.store, svc.registry);
  const ta = h.addThread("rita", { revision: r1, entityId: "function:src/proc.ts#processFirst", text: "a" }).id;
  const tb = h.addThread("rita", { revision: r1, entityId: "function:src/proc.ts#processSecond", text: "b" }).id;
  writeFileSync(join(dir, "src/proc.ts"), 'import { a1, a2, a3, a4 } from "./steps";\nexport function processEverything() { return a1() + a2() + a3() + a4(); }\nexport function main() { return processEverything(); }\n');
  const r2 = await reindex(svc, dir);
  // Not yet confirmed: nothing is guessed.
  const before = h.reanchorThreads(r2);
  assert.equal(before.orphaned, 2);
  const merge = svc.registry.proposals({ revision: r2 }).find((p) => p.kind === "MERGE")!;
  assert.ok(merge && merge.state === "PROPOSED");
  assert.ok(svc.registry.applyIdentityVerdict("dana", { proposalId: merge.id, verdict: "CONFIRM", expectedVersion: 1 }).ok);
  const after = h.reanchorThreads(r2);
  // Both parts' identities are retired into the first part's; the thread on the first follows, and the second follows its merged-into identity.
  assert.equal(after.orphaned, 0, "the thread on the part that was merged away is found through the merge history");
  const rows = h.threads(svc.store.revision(r2)!.repoRoot);
  assert.equal(rows.find((r) => r.id === ta).entity_id, "function:src/proc.ts#processEverything");
  assert.equal(rows.find((r) => r.id === ta).state, "OPEN");
  assert.equal(rows.find((r) => r.id === tb).entity_id, "function:src/proc.ts#processEverything");
  assert.equal(rows.find((r) => r.id === tb).state, "OPEN", "an orphaned thread comes back once its merge is confirmed");
  worker.close();
});
