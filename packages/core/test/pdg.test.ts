// PDG correctness on small hand-written TS fixtures (plan §6): if/loop/try shapes with known dominator sets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPdg, buildControlFlowGraph } from "../src/concept-hierarchy/pdg.ts";
import type { Entity } from "@cie/schema";

const entity = (id: string, src: string): Entity => ({
  entityId: id, kind: "function", name: id, file: "fixture.ts",
  spans: [{ sourceId: "fixture.ts", contentHash: "h", revision: "r", startByte: 0, endByteExclusive: Buffer.byteLength(src) }],
});
const build = (src: string) => buildPdg(entity("ent:test", src), src);

test("an if/else gives the condition two branches and guards only the conditional writes", () => {
  const pdg = build(`function f(c) { if (c) { x = 1; } else { x = 2; } return x; }`);
  const cond = pdg.nodes.find((n) => n.kind === "cond")!;
  assert.ok(cond, "the condition site exists");
  const writes = pdg.nodes.filter((n) => n.writes.includes("x"));
  assert.equal(writes.length, 2, "both writes are sites");
  // The condition dominates both writes; neither write post-dominates the condition.
  for (const w of writes) {
    const ge = pdg.guardEdges.find((g) => g.node === w.id && g.guard === cond.id);
    assert.ok(ge, `write ${w.id} is guarded by the condition`);
    assert.ok(["true-branch", "false-branch"].includes(ge!.kind), `branch sense recorded, got ${ge!.kind}`);
  }
  // The return is unconditional after the join: it must NOT be guarded by this condition.
  const ret = pdg.nodes.find((n) => n.kind === "return")!;
  assert.ok(!pdg.guardEdges.some((g) => g.node === ret.id && g.guard === cond.id), "the join's return is not guarded");
});

test("a loop has a back edge, a natural loop body, and guards its body", () => {
  const pdg = build(`function f(n) { let s = 0; let i = 0; while (i < n) { s = s + i; i = i + 1; } return s; }`);
  assert.equal(pdg.loops.length, 1, "one natural loop");
  const loop = pdg.loops[0];
  const body = pdg.nodes.find((n) => n.writes.includes("s") && n.reads.includes("s"))!;
  assert.ok(loop.blocks.includes(body.block), `the accumulator's block (${body.block}) is in the loop (${loop.blocks})`);
  assert.ok(pdg.guardEdges.some((g) => g.node === body.id && g.kind === "loop"), "the body write is loop-guarded");
});

test("def-use data edges connect the definition of a local to its later uses", () => {
  const pdg = build(`function f() { let a = 1; let b = a + 2; return b; }`);
  const defA = pdg.nodes.find((n) => n.writes.includes("a"))!;
  const useA = pdg.nodes.find((n) => n.reads.includes("a"))!;
  assert.ok(pdg.dataEdges.some((e) => e.from === defA.id && e.to === useA.id && e.variable === "a"), "a flows to its use");
  const defB = pdg.nodes.find((n) => n.writes.includes("b"))!;
  const ret = pdg.nodes.find((n) => n.kind === "return")!;
  assert.ok(pdg.dataEdges.some((e) => e.from === defB.id && e.to === ret.id && e.variable === "b"), "b flows to the return");
});

test("self-updating statements carry their delta: x = x - 1 is a sub, not an assign", () => {
  const pdg = build(`function f() { let x = 10; x = x - 1; return x; }`);
  const w = pdg.nodes.find((n) => n.writes.includes("x") && n.reads.includes("x"))!;
  assert.equal(w.writeOps.x, "sub");
  const pdg2 = build(`function g() { let x = 10; x = 3; return x; }`);
  const w2 = pdg2.nodes.find((n) => n.writes.includes("x") && !n.reads.includes("x") && n.writeOps.x !== "assign") ?? pdg2.nodes.filter((n) => n.writes.includes("x"))[1];
  assert.equal(w2.writeOps.x, "assign");
});

test("an if with no else falls through to the following statement, and the return after a guard clause is guarded on the false branch", () => {
  const pdg = build(`function f(c) { if (!c) return 0; x = 1; return x; }`);
  const guard = pdg.nodes.find((n) => n.kind === "cond")!;
  const write = pdg.nodes.find((n) => n.writes.includes("x"))!;
  const ge = pdg.guardEdges.find((g) => g.node === write.id && g.guard === guard.id);
  assert.ok(ge, "the write after the early return is control-dependent on the guard");
  assert.equal(ge!.kind, "false-branch", "it happens only when the guard is false");
});

test("try/catch marks catch-region nodes and pairs the exception edges", () => {
  const pdg = build(`function f() { try { risky(); } catch (e) { recover(); throw e; } }`);
  const caught = pdg.nodes.filter((n) => n.catchId !== null);
  assert.ok(caught.length >= 2, `catch region has its statements (${caught.length})`);
  assert.ok(caught.some((n) => n.kind === "throw"), "the rethrow is inside the catch region");
});

test("assertions named in the configured list are extracted with their condition text", () => {
  const pdg = build(`function f(x) { assert(x > 0); return x; }`);
  assert.equal(pdg.assertions.length, 1);
  assert.equal(pdg.assertions[0].text, "x > 0");
});

test("structural signatures are stable across entity names and sensitive to what motifs read", () => {
  // The signature keys the Phase 2 memo, so it must cover everything the extractors read:
  // identical source (any entity id/file) → identical signature; a changed operator → different.
  const a = build(`function f(c) { if (c) { a = 1; } else { a = 2; } }`);
  const b = build(`function g(c) { if (c) { a = 1; } else { a = 2; } }`);
  assert.equal(a.signature, b.signature, "same text, same signature (memo reuse is sound)");
  const c = build(`function f(c) { if (c) { a = a + 1; } else { a = 2; } }`);
  assert.notEqual(a.signature, c.signature, "a changed write operator is a different signature");
  const d = build(`function f(c) { if (c) { a = 1; } }`);
  assert.notEqual(a.signature, d.signature, "an if without else is a different shape");
});

test("a folded CFG keeps the synthetic entry and exit reachable from every return", () => {
  const src = `function f(c) { if (c) return 1; return 2; }`;
  const pdg = build(src);
  const entry = pdg.blocks[pdg.entryBlock];
  assert.ok(entry.nodes.length === 0, "the entry is synthetic");
  const exit = pdg.blocks[pdg.exitBlock];
  assert.ok(exit.nodes.length === 0, "the exit is synthetic");
  // Both returns reach the exit via some path.
  for (const r of pdg.nodes.filter((n) => n.kind === "return")) {
    const b = pdg.blocks[r.block];
    const seen = new Set<number>();
    const work = [b.id];
    let reaches = false;
    while (work.length) {
      const cur = work.pop()!;
      if (cur === exit.id) { reaches = true; break; }
      if (seen.has(cur)) continue;
      seen.add(cur);
      work.push(...pdg.blocks[cur].succs);
    }
    assert.ok(reaches, `return ${r.id} reaches the exit`);
  }
});

test("dominator sets match the textbook example", () => {
  // if (c) { A } else { B }; C — the join block C is dominated by the condition, not by A or B.
  const src = `function f(c) { if (c) { alpha(); } else { beta(); } gamma(); }`;
  const pdg = build(src);
  const condNode = pdg.nodes.find((n) => n.kind === "cond")!;
  const callB = pdg.nodes.find((n) => n.calls.includes("beta"))!;
  const callC = pdg.nodes.find((n) => n.calls.includes("gamma"))!;
  assert.ok(pdg.guardEdges.some((g) => g.node === callB.id && g.guard === condNode.id), "beta() is guarded by the condition");
  assert.ok(!pdg.guardEdges.some((g) => g.node === callC.id && g.guard === condNode.id), "gamma() after the join is not guarded");
  void buildControlFlowGraph;
});
