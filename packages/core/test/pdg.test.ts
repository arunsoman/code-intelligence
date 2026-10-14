// PDG behavior on small TypeScript fixtures: real worker indexing (every entity carries its IR
// dump), then the graph phase routed to `worker irPdgs`. The fold is Rust; these tests pin its
// statement-graph API from the TypeScript side.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAllPdgs } from "../src/concept-hierarchy/pdg.ts";
import { Store } from "../src/store.ts";
import { makeRepo, putRevision } from "./concept-hierarchy-helpers.ts";

function build(src: string, name = "f") {
  const repo = makeRepo({ "fixture.ts": src });
  const store = new Store(":memory:");
  putRevision(store, "rev", repo, { "fixture.ts": src });
  const { pdgs, unresolved } = buildAllPdgs(store, "rev");
  const pdg = pdgs.find((p) => p.entityId === `function:fixture.ts#${name}`);
  assert.ok(pdg, `a PDG is built for ${name} (unresolved: ${unresolved.join(", ") || "none"})`);
  return pdg!;
}

test("if/else writes have guard edges and the statement after the join does not", () => {
  const pdg = build(`function f(c) { if (c) { x = 1; } else { x = 2; } return x; }`);
  const branch = pdg.nodes.find((node) => node.kind === "branch");
  assert.ok(branch, "the condition is represented by a branch node");

  const writes = pdg.nodes.filter((node) => node.kind === "def" && node.name === "x");
  assert.equal(writes.length, 2);
  for (const write of writes) {
    assert.ok(pdg.edges.some((edge) => edge.kind === "guard" && edge.from === branch!.id && edge.to === write.id));
  }

  const ret = pdg.nodes.find((node) => node.kind === "return");
  assert.ok(ret);
  assert.ok(!pdg.edges.some((edge) => edge.kind === "guard" && edge.from === branch!.id && edge.to === ret!.id));
});

test("loop body nodes are guarded by the loop condition", () => {
  const pdg = build(`function f(n) { let s = 0; while (n) { s = s + 1; } return s; }`);
  const branch = pdg.nodes.find((node) => node.kind === "branch");
  const update = pdg.nodes.find((node) => node.kind === "def" && node.name === "s" && node.op === "op:add");
  assert.ok(branch);
  assert.ok(update);
  assert.ok(pdg.edges.some((edge) => edge.kind === "guard" && edge.from === branch!.id && edge.to === update!.id));
});

test("local reads are linked to their defining nodes", () => {
  const pdg = build(`function f() { let a = 1; let b = a + 2; return b; }`);
  const defA = pdg.nodes.find((node) => node.kind === "def" && node.name === "a");
  const useA = pdg.nodes.find((node) => node.kind === "use" && node.name === "a");
  const defB = pdg.nodes.find((node) => node.kind === "def" && node.name === "b");
  const useB = pdg.nodes.find((node) => node.kind === "use" && node.name === "b");
  assert.ok(defA && useA && defB && useB);
  assert.ok(pdg.edges.some((edge) => edge.kind === "data" && edge.from === defA!.id && edge.to === useA!.id));
  assert.ok(pdg.edges.some((edge) => edge.kind === "data" && edge.from === defB!.id && edge.to === useB!.id));
});

test("reassignment captures its arithmetic operator and the previous value", () => {
  const pdg = build(`function f() { let x = 10; x = x - 1; return x; }`);
  const definitions = pdg.nodes.filter((node) => node.kind === "def" && node.name === "x");
  const update = definitions.find((node) => node.op === "op:sub");
  assert.equal(definitions.length, 2);
  assert.ok(update);

  const oldValueUse = pdg.nodes.find((node) => node.kind === "use" && node.name === "x");
  assert.ok(oldValueUse);
  assert.ok(pdg.edges.some((edge) => edge.kind === "data" && edge.from === oldValueUse!.id && edge.to === update!.id));
});

test("calls in a catch block and rethrows are represented as graph nodes", () => {
  const pdg = build(`function f() { try { risky(); } catch (e) { recover(); throw e; } }`);
  assert.ok(pdg.nodes.some((node) => node.kind === "call" && node.name === "risky"));
  assert.ok(pdg.nodes.some((node) => node.kind === "call" && node.name === "recover"));
  assert.ok(pdg.nodes.some((node) => node.kind === "throw"));
});

test("assertion calls are classified and receive data edges from their arguments", () => {
  const pdg = build(`function f(x) { assert(x > 0); return x; }`);
  const assertion = pdg.nodes.find((node) => node.kind === "assert");
  const value = pdg.nodes.find((node) => node.kind === "use" && node.name === "x");
  assert.ok(assertion);
  assert.ok(value);
  assert.ok(pdg.edges.some((edge) => edge.kind === "data" && edge.from === value!.id && edge.to === assertion!.id));
});

test("graph hashes ignore function identity and include captured operators", () => {
  const a = build(`function f(c) { if (c) { x = x + 1; } }`, "f");
  const b = build(`function g(c) { if (c) { x = x + 1; } }`, "g");
  const changed = build(`function h(c) { if (c) { x = x - 1; } }`, "h");
  assert.equal(a.graphHash, b.graphHash);
  assert.notEqual(a.graphHash, changed.graphHash);
});