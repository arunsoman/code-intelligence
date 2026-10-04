import { ScriptedRouter } from "./scripted-router.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ctx, demoRepo, setup, traceFor } from "./helpers.ts";

const hotness = (v: any, name: string) => v.nodes.find((n: any) => n.label === name)?.factors?.find((f: any) => f.factor === "RUNTIME_HOTNESS");
const override = (v: any, name: string) => v.nodes.find((n: any) => n.label === name)?.factors?.find((f: any) => f.factor === "USER_OVERRIDE");

test("reported exceptions make code hot, weighted by frame position and repetition, with RUNTIME evidence", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const before = await svc.ask(ctx(), { question: "how do fraud checks and payments work", revision });
  assert.ok(before.ok);
  const cold = hotness(before.value.view, "checkFraud");
  const wasCold = cold.normalizedScore;
  for (let i = 0; i < 3; i++) assert.ok(svc.reportException(ctx(), { trace: traceFor(repo), source: "api-server" }).ok);
  const after = await svc.ask(ctx(), { question: "how do fraud checks and payments work", revision });
  assert.ok(after.ok);
  const h = hotness(after.value.view, "checkFraud");
  assert.ok(h.normalizedScore > wasCold, `${h.normalizedScore} > ${wasCold}`);
  assert.match(h.reason, /top frame of 3 reported FraudRejectedError exception\(s\) \(api-server\)/);
  assert.equal(svc.store.evidence(revision, h.evidenceIds[0])!.class, "RUNTIME");
  const top = hotness(after.value.view, "checkFraud").normalizedScore, third = hotness(after.value.view, "createPayment")?.normalizedScore ?? 0;
  assert.ok(top > third, "the top frame is hotter than a frame further up the stack");
  // Dismissing the exception cools the code again.
  const id = (svc.listExceptions(ctx(), {}) as any).value[0].id;
  svc.dismissException(ctx(), { id });
  const cooled = await svc.ask(ctx(), { question: "how do fraud checks and payments work", revision });
  assert.ok(cooled.ok && hotness(cooled.value.view, "checkFraud").normalizedScore === wasCold);
  worker.close();
});

test("failing tests make the code they exercise hot, two hops deep", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const r = await svc.ask(ctx(), { question: "how do fraud checks and payments work", revision });
  assert.ok(r.ok);
  const direct = hotness(r.value.view, "checkFraud");
  assert.match(direct.reason, /called directly by the failing test “flags large amounts”/);
  assert.equal(svc.store.evidence(revision, direct.evidenceIds[0])!.class, "TEST");
  const indirect = hotness(r.value.view, "velocity");
  assert.match(indirect.reason, /reached by the failing test/);
  assert.ok(direct.normalizedScore > indirect.normalizedScore);
  worker.close();
});

test("hot code does not hijack unrelated questions", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  svc.reportException(ctx(), { trace: traceFor(repo) });
  const r = await svc.ask(ctx(), { question: "how do refunds work", revision });
  assert.ok(r.ok);
  assert.ok(!r.value.view.nodes.some((n) => n.label === "checkFraud"), "hotness ranks; it does not select");
  worker.close();
});

test("overrides persist per repository: pin forces CRITICAL and presence, boost ranks up, demote ranks down, reset undoes", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const q = "how do refunds work";
  const base = await svc.ask(ctx(), { question: q, revision });
  assert.ok(base.ok);
  const baseScore = base.value.view.nodes.find((n) => n.label === "handleRefund")!.score!;
  assert.ok(!base.value.view.nodes.some((n) => n.label === "checkFraud"));

  assert.ok(svc.setOverride(ctx(), { revision, entityId: "function:src/payments/fraud.ts#checkFraud", mode: "pin" }).ok);
  const pinned = await svc.ask(ctx(), { question: q, revision });
  assert.ok(pinned.ok);
  const pn = pinned.value.view.nodes.find((n) => n.label === "checkFraud")!;
  assert.ok(pn && pn.tier === "CRITICAL", "a pinned element is always shown, as CRITICAL");
  assert.match(override(pinned.value.view, "checkFraud").reason, /pinned by you/);

  svc.setOverride(ctx(), { revision, entityId: "function:src/refunds/refund-worker.ts#handleRefund", mode: "boost" });
  const boosted = await svc.ask(ctx(), { question: q, revision });
  assert.ok(boosted.ok && boosted.value.view.nodes.find((n) => n.label === "handleRefund")!.score! > baseScore);
  svc.setOverride(ctx(), { revision, entityId: "function:src/refunds/refund-worker.ts#handleRefund", mode: "demote" });
  const demoted = await svc.ask(ctx(), { question: q, revision });
  assert.ok(demoted.ok && (demoted.value.view.nodes.find((n) => n.label === "handleRefund")?.score ?? 0) < baseScore);
  svc.setOverride(ctx(), { revision, entityId: "function:src/refunds/refund-worker.ts#handleRefund", mode: null });
  svc.setOverride(ctx(), { revision, entityId: "function:src/payments/fraud.ts#checkFraud", mode: null });
  const reset = await svc.ask(ctx(), { question: q, revision });
  assert.ok(reset.ok && reset.value.view.nodes.find((n) => n.label === "handleRefund")!.score === baseScore);
  assert.ok(!reset.value.view.nodes.some((n) => n.label === "checkFraud"));

  // They survive re-indexing because entity ids are stable.
  svc.setOverride(ctx(), { revision, entityId: "function:src/payments/fraud.ts#checkFraud", mode: "pin" });
  const again = await svc.ingestRepository(ctx(), { repoPath: repo });
  assert.ok(again.ok);
  assert.equal((svc.listOverrides(ctx(), {}) as any).value.length, 1);
  assert.ok(!svc.setOverride(ctx(), { revision, entityId: "function:nope#x", mode: "pin" }).ok);
  assert.ok(!svc.setOverride(ctx(), { revision, entityId: "function:src/payments/fraud.ts#checkFraud", mode: "weird" as any }).ok);
  worker.close();
});

test("chat commands: pin / boost / demote / reset by name; a similarly-worded question is still a question", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  svc.router = new ScriptedRouter({ "pin checkFraud": { label: "pin", target: "checkFraud" }, "reset checkFraud": { label: "unpin", target: "checkFraud" }, "reset password flow": { label: "unpin", target: "password flow" }, demote: { label: "demote", target: "" }, "how do refunds work": { label: "SemanticMap", target: "" } });
  const q = await svc.converse(ctx(), { text: "how do refunds work", revision });
  assert.ok(q.ok && q.value.kind === "view");
  const v0 = q.value.view;
  const pin = await svc.converse(ctx(), { text: "pin checkFraud", view: v0 });
  assert.ok(pin.ok && pin.value.kind === "view" && pin.value.view.nodes.some((n) => n.label === "checkFraud") && pin.value.view.version === v0.version + 1);
  assert.match(pin.value.message, /Pinned checkFraud/);
  const reset = await svc.converse(ctx(), { text: "reset checkFraud", view: pin.value.view });
  assert.ok(reset.ok && reset.value.kind === "view" && !reset.value.view.nodes.some((n) => n.label === "checkFraud"));
  const asQuestion = await svc.converse(ctx(), { text: "reset password flow", view: v0 });
  assert.ok(asQuestion.ok && asQuestion.value.kind === "view", "no element called that, so it is answered as a question");
  const sel = await svc.converse(ctx(), { text: "demote", view: v0, selection: [v0.nodes[0].id] });
  assert.ok(sel.ok && sel.value.kind === "view" && /Demoted/.test(sel.value.message), "with a selection and no name, the selection is the target");
  worker.close();
});
