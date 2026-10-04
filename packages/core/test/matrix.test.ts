import assert from "node:assert/strict";
import { test } from "node:test";
import type { Claim, MatrixCell, ViewSpec } from "@cie/schema";
import { provenanceAudit } from "../src/demobar.ts";
import { ctx, demoRepo, setup } from "./helpers.ts";

const claimsOf = (cs: Claim[]) => Object.fromEntries(cs.map((c) => [c.draft.id, c]));
async function ask(svc: any, revision: string, question: string, form: string) {
  const r = await svc.ask(ctx(), { question, revision, form });
  assert.ok(r.ok, JSON.stringify(r.error));
  return r.value as { view: ViewSpec; claims: Claim[] };
}
const cellOf = (v: ViewSpec, rowLabel: string, colLabel: string) => {
  const m = v.matrix!, r = m.rows.find((x) => x.label === rowLabel), c = m.cols.find((x) => x.label === colLabel);
  return r && c ? m.cells.find((x) => x.row === r.id && x.col === c.id) : undefined;
};

test("V15 matrix: routes by rules, with what each rule enforces, where a route gets around it, and what is only convention", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const { view: v, claims } = await ask(svc, revision, "Which policies are enforced and where do they have gaps?", "PolicyMap");
  const m = v.matrix!;
  assert.ok(m && m.rows.length >= 5 && m.cols.length >= 4);
  // The fully guarded route passes every rule; the unguarded ones skip them.
  const full = m.rows.find((r) => r.label === "createPayment → commit")!;
  assert.deepEqual(m.cols.filter((c) => c.role === "rule").map((c) => m.cells.find((x) => x.row === full.id && x.col === c.id)?.state), ["enforced", "enforced", "enforced", "enforced"]);
  assert.equal(full.heat, undefined, "a route that skips nothing carries no risk tint");
  const capture = m.rows.find((r) => r.label === "handleCapture → commit")!;
  assert.ok(capture.heat && /skips 4 of 4/.test(capture.heat.label));
  const heats = m.rows.map((r) => r.heat?.value ?? 0);
  assert.deepEqual(heats, [...heats].sort((a, b) => b - a), "rows with the most ways around come first");
  // Modes follow the graph: enforcement is an inference with the rule's claim; a way around is a hypothesis with the route's claim.
  const enforced = cellOf(v, "createPayment → commit", "InsufficientFunds")!;
  assert.equal(enforced.displayMode, "INFERENCE"); assert.ok(enforced.claimId && enforced.evidenceIds.length >= 2);
  const bypass = cellOf(v, "createPayment → reserve", "InsufficientFunds")!;
  assert.equal(bypass.state, "bypassed"); assert.equal(bypass.displayMode, "HYPOTHESIS"); assert.ok(bypass.claimId);
  assert.ok(m.cells.some((c) => c.state === "convention" && c.displayMode === "HYPOTHESIS"), "a rule held only by convention is shown as one");
  // The matrix and the graph are two drawings of one result: every bypass is also an escape-route edge, and vice versa.
  // (A route that starts and ends in one function has no edge to draw: the graph badges the node instead.)
  const escapes = new Set([...v.edges.filter((e) => e.kind === "escape route").map((e) => e.claimId), ...v.nodes.filter((n) => /^skips \d+ check/.test(n.badge ?? "")).flatMap((n) => n.claimIds)]);
  assert.deepEqual(new Set(m.cells.filter((c) => c.state === "bypassed").map((c) => c.claimId)), escapes);
  assert.deepEqual(provenanceAudit(svc, v, claimsOf(claims)), []);
  worker.close();
});

test("V12 matrix: behaviours by tests and properties, with how much of each behaviour a test reaches and what no test asserts", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const { view: v, claims } = await ask(svc, revision, "How well tested are our operations?", "TestConfidence");
  const m = v.matrix!;
  assert.ok(m && m.rows.length >= 2);
  assert.ok(m.cols.some((c) => c.role === "test") && m.cols.some((c) => c.role === "property"));
  const reach = m.cells.filter((c) => c.state === "protects" || c.state === "failing");
  assert.ok(reach.length > 0 && reach.every((c) => c.strength! > 0 && c.strength! <= 1 && c.displayMode === "FACT" && !c.claimId), "reach is static fact with a share, never a claim");
  assert.ok(m.cells.some((c) => c.state === "failing"), "a failing test is marked, not shown as protection");
  const gap = m.cells.find((c) => c.state === "gap")!;
  assert.equal(gap.displayMode, "HYPOTHESIS"); assert.ok(gap.claimId);
  const asserted = m.cells.find((c) => c.state === "asserted")!;
  assert.equal(asserted.displayMode, "INFERENCE"); assert.ok(asserted.claimId);
  // Same facts as the graph: each gap cell is a "missing for" edge.
  assert.deepEqual(new Set(m.cells.filter((c) => c.state === "gap").map((c) => c.claimId)), new Set(v.edges.filter((e) => e.kind === "missing for").map((e) => e.claimId)));
  // Every row says how confident the form is in the behaviour, in words as well as a tint.
  assert.ok(m.rows.every((r) => r.heat && /% confidence/.test(r.heat.label)));
  assert.deepEqual(provenanceAudit(svc, v, claimsOf(claims)), []);
  worker.close();
});

test("the provenance audit catches a matrix that lies: a claim shown as fact, a cell without a claim, a dangling row, an unexplained state", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const { view, claims } = await ask(svc, revision, "Which policies are enforced and where do they have gaps?", "PolicyMap");
  const audit = (mutate: (cells: MatrixCell[]) => void) => {
    const v: ViewSpec = JSON.parse(JSON.stringify(view)); mutate(v.matrix!.cells);
    return provenanceAudit(svc, v, claimsOf(claims));
  };
  assert.ok(audit((cs) => { cs.find((c) => c.state === "bypassed")!.displayMode = "FACT"; }).some((b) => /shown as FACT but backed by a model/.test(b)));
  assert.ok(audit((cs) => { delete cs.find((c) => c.state === "enforced")!.claimId; }).some((b) => /without a claim/.test(b)));
  assert.ok(audit((cs) => { cs[0].row = "row:nope"; }).some((b) => /does not exist/.test(b)));
  assert.ok(audit((cs) => { cs[0].state = "mystery"; }).some((b) => /not explained/.test(b)));
  assert.ok(audit((cs) => { cs[0].evidenceIds = []; }).some((b) => /cites no evidence/.test(b)));
  worker.close();
});

test("matrix cells as referents: a selected cell's row and column become 'these' for chat, and the answer is cited", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const { view: v } = await ask(svc, revision, "Which policies are enforced and where do they have gaps?", "PolicyMap");
  const m = v.matrix!;
  const row = m.rows.find((r) => r.label === "createPayment → reserve")!, col = m.cols.find((c) => c.label === "InsufficientFunds")!;
  const ids = [...new Set([...row.entityRefs, ...col.entityRefs])];
  assert.ok(ids.length >= 2, "a cell stands for at least two pieces of code");
  const r = await svc.converse(ctx(), { text: "why are these connected?", view: v, selection: [], revision, pins: ids });
  assert.ok(r.ok && r.value.kind === "explanation", JSON.stringify(r.ok ? r.value.kind : r.error));
  assert.ok(r.value.explanation.claims.every((c) => c.draft.evidenceIds.length > 0), "every claim in the answer cites evidence");
  // One cell with a single code reference is still askable ("explain this").
  const one = await svc.converse(ctx(), { text: "explain this", view: v, selection: [], revision, pins: [ids[0]] });
  assert.ok(one.ok && one.value.kind === "explanation");
  worker.close();
});
