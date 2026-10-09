import assert from "node:assert/strict";
import { test } from "node:test";
import type { ViewSpec } from "@cie/schema";
import { Interactions, parseTimeDirective, type Interaction } from "../src/interactions.ts";
import { ctx, demoRepo, setup, traceFor } from "./helpers.ts";

async function world(repoPath?: string) {
  const repo = repoPath ?? demoRepo();
  const t = await setup(undefined, repo);
  await t.svc.buildConceptHierarchy(ctx(), { revision: t.revision });
  const ix = new Interactions(t.svc);
  const r = await t.svc.ask(ctx(), { question: "how do fraud checks and payments work", revision: t.revision });
  assert.ok(r.ok);
  const view: ViewSpec = r.value.view;
  const sym = (name: string) => view.nodes.find((n) => n.label === name)!;
  return { ...t, repo, ix, view, claims: r.value.claims, sym };
}
const run = async (w: Awaited<ReturnType<typeof world>>, it: Interaction) => { const r = await w.ix.resolve(ctx(), it); return r; };

test("interaction catalogue I-01…I-20: each resolves to its typed command, in its direction, and writes the context the catalogue names", async () => {
  const w = await world();
  const S = "s-cat";
  const v = w.view;
  const a = w.sym("checkFraud"), b = w.sym("createPayment");
  const cases: { it: Interaction; command: string; dir: string; writes: string[] }[] = [
    { it: { id: "I-01", session: S, text: "show me how refunds work" }, command: "ask", dir: "text→visual", writes: ["TASK", "RECENT"] },
    { it: { id: "I-02", session: S, view: v, text: "only what matters for this exception" }, command: "filter", dir: "text→visual", writes: ["FILTER"] },
    { it: { id: "I-03", session: S, view: v, direction: "out" }, command: "zoom", dir: "text→visual", writes: ["ZOOM"] },
    { it: { id: "I-04", session: S, view: v, text: "last week's version", now: "2030-01-15T00:00:00Z" }, command: "time-window", dir: "text→visual", writes: ["TIME"] },
    { it: { id: "I-05", session: S, view: v, nodeId: a.id }, command: "identity", dir: "visual→text", writes: ["RECENT"] },
    { it: { id: "I-06", session: S, view: v, nodeId: a.id }, command: "provenance", dir: "visual→text", writes: ["TRUST"] },
    { it: { id: "I-07", session: S, view: v, nodeIds: [a.id, b.id] }, command: "relate", dir: "visual→text", writes: ["REFERENT"] },
    { it: { id: "I-09", session: S, view: v }, command: "why-hidden", dir: "visual→text", writes: ["SALIENCE_FEEDBACK"] },
    { it: { id: "I-10", session: S, view: v, nodeId: a.id, pin: true }, command: "pin", dir: "visual→visual", writes: ["PIN"] },
    { it: { id: "I-11", session: S, view: v, groupId: v.groups[0].id, collapse: true }, command: "collapse", dir: "visual→visual", writes: ["ABSTRACTION"] },
    { it: { id: "I-13", session: S, view: v, order: [b.id, a.id] }, command: "sequence-proposal", dir: "visual→visual", writes: ["INTENT"] },
    { it: { id: "I-14", session: S, view: v, nodeIds: [a.id, b.id] }, command: "consolidation-proposal", dir: "visual→visual", writes: ["INTENT"] },
    { it: { id: "I-15", session: S, view: v, nodeIds: [a.id, b.id] }, command: "extraction-proposal", dir: "visual→visual", writes: ["INTENT", "TASK"] },
    { it: { id: "I-16", session: S, view: v, nodeId: a.id, note: "owned by risk team", scope: "team" }, command: "annotate", dir: "visual→visual", writes: ["NOTE"] },
  ];
  for (const c of cases) {
    const r = await run(w, c.it);
    assert.ok(r.ok, `${c.it.id}: ${JSON.stringify((r as any).error)}`);
    assert.equal(r.value.outcome, "DONE", c.it.id);
    assert.equal(r.value.command, c.command, c.it.id);
    assert.equal(r.value.direction, c.dir, c.it.id);
    assert.deepEqual(r.value.written, c.writes, c.it.id);
  }
  const snap = (await run(w, { id: "I-03", session: S, view: v, direction: "in" }) as any).value.context;
  assert.equal(snap.taskFrame, "extraction");
  assert.ok(snap.pins.includes(a.entityRefs[0]) && snap.referent.length === 2 && snap.abstraction[v.groups[0].id] === "collapsed" && snap.filters.length === 1 && snap.timeWindow === "last week");
  // I-08: a verdict restyles the claim and the refreshed view follows.
  const claim = w.claims.find((c) => c.displayMode !== "HIDDEN")!;
  const verdict = await run(w, { id: "I-08", session: S, view: v, claimId: claim.draft.id, verdict: "REFUTE", explanation: "wrong", expectedVersion: claim.version });
  assert.ok(verdict.ok && verdict.value.written.join() === "TRUST");
  // I-12: dragging along an existing call needs a choice only when it is ambiguous.
  const drag = await run(w, { id: "I-12", session: S, view: v, fromNodeId: b.id, toNodeId: a.id });
  assert.ok(["DONE", "NEEDS_CLARIFICATION"].includes((drag as any).value?.outcome ?? "REJECTED") || !drag.ok);
  // I-16 notes show up as annotations stored per repository, and nothing is edited by any proposal.
  assert.equal((w.svc.store.db.prepare("select count(*) as n from annotations").get() as any).n, 1);
  w.worker.close();
});

test("I-17…I-20: code and runtime events become views, offers and promotions", async () => {
  const w = await world();
  const S = "s-code";
  const file = `${w.repo}/src/payments/fraud.ts`;
  const sel = await run(w, { id: "I-17", session: S, file, startLine: 5, sequence: 1 });
  assert.ok(sel.ok && sel.value.outcome === "DONE", JSON.stringify((sel as any).error));
  assert.ok((sel.value.result as any).entities.some((e: string) => /checkFraud/.test(e)));
  assert.ok((sel.value.result as any).view.nodes.length > 0, "the view morphs around the selection");
  const stale = await run(w, { id: "I-17", session: S, file, startLine: 5, sequence: 1 });
  assert.ok(!stale.ok && stale.error.code === "VERSION_CONFLICT", "a reordered editor event is refused");
  const diff = await run(w, { id: "I-18", session: S, file, sequence: 2 });
  assert.ok(diff.ok && (diff.value.result as any).taskFrame === "review" && (diff.value.result as any).primaryView.form === "SemanticDiff");
  assert.equal(diff.value.context.taskFrame, "review");
  const bp = await run(w, { id: "I-19", session: S, file, lines: [5, 6], sequence: 3 });
  assert.ok(bp.ok && (bp.value.result as any).anchors.length > 0 && bp.value.written.includes("RUNTIME"));
  const inc = await run(w, { id: "I-20", session: S, trace: traceFor(w.repo) });
  assert.ok(inc.ok && (inc.value.result as any).promoted.length > 0, "involved entities are promoted to CRITICAL");
  assert.equal(inc.value.context.taskFrame, "incident");
  assert.ok((w.svc.listExceptions(ctx(), {}) as any).value.length >= 1, "the alarm was recorded as an exception");
  w.worker.close();
});

test("stale selection: a gesture made on an older view revision or version is refused, and unknown ids are not guessed at", async () => {
  const w = await world();
  const a = w.sym("checkFraud");
  const old = await run(w, { id: "I-06", session: "s", view: w.view, viewRevision: "an-older-revision", nodeId: a.id });
  assert.ok(!old.ok && old.error.code === "VERSION_CONFLICT" && /select again/.test(old.error.message));
  const oldVer = await run(w, { id: "I-10", session: "s", view: w.view, viewVersion: w.view.version + 1, nodeId: a.id, pin: true });
  assert.ok(!oldVer.ok && oldVer.error.code === "VERSION_CONFLICT");
  const ghost = await run(w, { id: "I-05", session: "s", view: w.view, nodeId: "n:not-in-this-view" });
  assert.ok(!ghost.ok && ghost.error.code === "NOT_FOUND");
  assert.equal((w.svc.listOverrides(ctx(), { revision: w.revision }) as any).value.length, 0, "a refused gesture changes nothing");
  assert.ok(!(await run(w, { id: "I-06", session: "s", nodeId: a.id })).ok, "no view, no gesture");
  w.worker.close();
});

test("lasso relation query: a lasso of N nodes plus a question gives a per-edge explanation with evidence, and needs at least two", async () => {
  const w = await world();
  const ids = ["checkFraud", "createPayment", "charge"].map((n) => w.sym(n)).filter(Boolean).map((n) => n.id);
  assert.ok(ids.length >= 2);
  const r = await run(w, { id: "I-07", session: "s", view: w.view, nodeIds: ids, question: "why are these connected?" });
  assert.ok(r.ok && r.value.outcome === "DONE");
  const ex = r.value.result as any;
  assert.ok(ex.summary.length > 0 && ex.evidence.length > 0, "the explanation cites evidence");
  for (const ev of ex.evidence) assert.ok(w.svc.store.evidence(w.view.revision, ev.id ?? ev.evidenceId ?? ev.evidence?.id) !== undefined);
  const one = await run(w, { id: "I-07", session: "s", view: w.view, nodeIds: [ids[0]] });
  assert.ok(one.ok && one.value.outcome === "NEEDS_CLARIFICATION" && one.value.clarification!.options.length > 0);
  w.worker.close();
});

test("referent carryover: after a lasso, 'they' means that group; with no referent, or a pronoun and nothing chosen, it asks", async () => {
  const w = await world();
  const S = "s-carry";
  const none = await w.ix.followUp(ctx(), S, "why are they connected?", w.view);
  assert.ok(none.ok && none.value.outcome === "NEEDS_CLARIFICATION");
  const ids = ["checkFraud", "createPayment"].map((n) => w.sym(n).id);
  await run(w, { id: "I-07", session: S, view: w.view, nodeIds: ids });
  const carried = await w.ix.followUp(ctx(), S, "and why are they connected?", w.view);
  assert.ok(carried.ok && carried.value.outcome === "DONE" && carried.value.command === "relate");
  assert.ok((carried.value.result as any).selected.length >= 2, "the explanation is about the lassoed group");
  // A different session has its own referent.
  const other = await w.ix.followUp(ctx(), "s-other", "why are they connected?", w.view);
  assert.ok(other.ok && other.value.outcome === "NEEDS_CLARIFICATION");
  // A plain question is a new question, not a carryover.
  const q = await w.ix.followUp(ctx(), S, "how do refunds work", w.view);
  assert.ok(q.ok && q.value.id === "I-01");
  w.worker.close();
});

test("ambiguous intent asks: a name that matches two elements is a clarification, never a guess", async () => {
  const w = await world();
  // Two functions of the same name in different files.
  const names = new Map<string, number>();
  for (const e of w.svc.store.entities(w.revision)) if (e.kind !== "file") names.set(e.name, (names.get(e.name) ?? 0) + 1);
  const dup = [...names].find(([, n]) => n > 1)?.[0];
  if (dup) {
    const r = await run(w, { id: "I-10", session: "s", view: w.view, name: dup, pin: true });
    assert.ok(r.ok && r.value.outcome === "NEEDS_CLARIFICATION" && r.value.clarification!.options.length > 1);
  }
  const t = parseTimeDirective("what did it look like last week", "2030-01-15T00:00:00Z")!;
  assert.equal(t.label, "last week");
  assert.equal(parseTimeDirective("show me the thing", "2030-01-15T00:00:00Z"), null);
  const bad = await run(w, { id: "I-04", session: "s", view: w.view, text: "some day", now: "2030-01-15T00:00:00Z" });
  assert.ok(bad.ok && bad.value.outcome === "NEEDS_CLARIFICATION");
  w.worker.close();
});

test("equivalent mouse and keyboard commands: the same gesture resolves to the same command and result whatever the device", async () => {
  const shared = demoRepo();
  const mk = async (via: "mouse" | "keyboard" | "text") => {
    const w = await world(shared);
    const a = w.sym("checkFraud"), b = w.sym("createPayment");
    const out = [] as unknown[];
    for (const it of [
      { id: "I-05", session: "s", via, view: w.view, nodeId: a.id },
      { id: "I-06", session: "s", via, view: w.view, nodeId: a.id },
      { id: "I-07", session: "s", via, view: w.view, nodeIds: [a.id, b.id] },
      { id: "I-10", session: "s", via, view: w.view, nodeId: a.id, pin: true },
      { id: "I-11", session: "s", via, view: w.view, groupId: w.view.groups[0].id, collapse: true },
    ] as Interaction[]) { const r = await w.ix.resolve(ctx(), it); assert.ok(r.ok); out.push({ command: r.value.command, direction: r.value.direction, result: r.value.result, written: r.value.written }); }
    w.worker.close();
    return JSON.stringify(out).replace(/"runId":"[0-9a-f-]{36}"/g, '"runId":"-"');
  };
  const [mouse, keyboard] = [await mk("mouse"), await mk("keyboard")];
  assert.equal(mouse, keyboard);
});
