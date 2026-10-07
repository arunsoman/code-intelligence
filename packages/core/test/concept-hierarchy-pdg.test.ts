// The PDG builder: statement-grain nodes, flow/data/guard edges, operator capture on defs, and the
// bodyHash reuse that bounds the incremental blast radius.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildAllPdgs, buildPdgForFunction, clearPdgSourceCache } from "../src/concept-hierarchy/pdg.ts";
import { conceptConfig, setConceptConfigForTest } from "../src/concept-hierarchy/config.ts";
import { Store } from "../src/store.ts";
import { ACCUMULATE, LEDGER, makeRepo, putRevision } from "./concept-hierarchy-helpers.ts";

const graphOf = (pdgs: ReturnType<typeof buildAllPdgs>["pdgs"], name: string) => {
  const g = pdgs.find((p) => p.entityId.endsWith(`#${name}`));
  assert.ok(g, `a graph was built for ${name}`);
  return g!;
};

test("a guarded subtraction yields a branch node, a guarded def with op:sub, and data from the old value", () => {
  const repo = makeRepo({ "src/ledger.ts": LEDGER });
  const store = new Store(":memory:");
  putRevision(store, "rev-a", repo, { "src/ledger.ts": LEDGER });
  const { pdgs } = buildAllPdgs(store, "rev-a", repo);
  const g = graphOf(pdgs, "withdraw");
  const branch = g.nodes.find((n) => n.kind === "branch");
  assert.ok(branch, "the if condition became a branch node");
  assert.equal(branch!.name, "amount", "the branch carries the first identifier its condition read");
  const def = g.nodes.find((n) => n.kind === "def" && n.name === "balance" && n.op);
  assert.ok(def, "balance is redefined with a captured operator");
  assert.equal(def!.op, "op:sub");
  assert.ok(g.edges.some((e) => e.kind === "guard" && e.from === branch!.id && e.to === def!.id), "the def is guarded by the branch");
  assert.ok(g.edges.some((e) => e.kind === "data" && e.to === def!.id), "the new value is fed by the read of the old one");
  const feed = g.edges.find((e) => e.kind === "data" && e.to === def!.id)!;
  const feedNode = g.nodes.find((n) => n.id === feed.from)!;
  assert.equal(feedNode.kind, "use");
  assert.equal(feedNode.name, "balance", "the fed use is the variable's own old value");
  assert.ok(g.edges.every((e) => e.kind !== "guard" || g.nodes.some((n) => n.id === e.from)), "guard edges always start at a real node");
});

test("a self-fed accumulation (sum = sum + x) is visible in the graph; locals are tracked", () => {
  const repo = makeRepo({ "src/total.ts": ACCUMULATE });
  const store = new Store(":memory:");
  putRevision(store, "rev-a", repo, { "src/total.ts": ACCUMULATE });
  const { pdgs } = buildAllPdgs(store, "rev-a", repo);
  const g = graphOf(pdgs, "total");
  assert.ok(g.locals.includes("sum") && g.locals.includes("x"));
  const def = g.nodes.find((n) => n.kind === "def" && n.name === "sum" && n.op);
  assert.ok(def, "sum is redefined");
  assert.equal(def!.op, "op:add");
  const inc = g.edges.filter((e) => e.kind === "data" && e.to === def!.id);
  assert.ok(inc.some((e) => g.nodes.find((n) => n.id === e.from)?.name === "sum"), "the accumulation feeds itself");
});

test("graphHash is equal for structurally identical bodies in different files, bodyHash is not", () => {
  const doubled = LEDGER + "\nexport function withdraw2(balance: number, amount: number): number {\n  if (amount > 0 && amount <= balance) {\n    balance = balance - amount;\n  }\n  return balance;\n}\n";
  const repo = makeRepo({ "src/a.ts": LEDGER, "src/b.ts": doubled });
  const store = new Store(":memory:");
  putRevision(store, "rev-a", repo, { "src/a.ts": LEDGER, "src/b.ts": doubled });
  const { pdgs } = buildAllPdgs(store, "rev-a", repo);
  const a = graphOf(pdgs, "withdraw");
  const b = graphOf(pdgs, "withdraw2");
  assert.equal(a.graphHash, b.graphHash, "same shape, same canonical graph hash");
  assert.notEqual(a.bodyHash, b.bodyHash, "different source text, different body hash");
});

test("unchanged functions reuse the previous graph wholesale; changed ones are rebuilt", () => {
  const repo = makeRepo({ "src/ledger.ts": LEDGER, "src/total.ts": ACCUMULATE });
  const store = new Store(":memory:");
  putRevision(store, "rev-a", repo, { "src/ledger.ts": LEDGER, "src/total.ts": ACCUMULATE });
  const first = buildAllPdgs(store, "rev-a", repo);
  assert.equal(first.reused, 0);
  assert.equal(first.pdgs.length, 3, "withdraw, deposit, total");

  const editedLedger = LEDGER.replace("balance = balance - amount;", "balance = balance - amount - 1;");
  writeFileSync(join(repo, "src/ledger.ts"), editedLedger);
  putRevision(store, "rev-b", repo, { "src/ledger.ts": editedLedger, "src/total.ts": ACCUMULATE });
  const second = buildAllPdgs(store, "rev-b", repo, first.pdgs);
  assert.equal(second.reused, 2, "deposit and total are reused without touching disk");
  assert.equal(second.pdgs.length, 3);
  const firstWithdraw = first.pdgs.find((p) => p.entityId.endsWith("#withdraw"))!;
  const rebuilt = second.pdgs.find((p) => p.entityId.endsWith("#withdraw"))!;
  assert.notEqual(rebuilt.bodyHash, firstWithdraw.bodyHash, "the edit changed withdraw's body hash");
  assert.notEqual(rebuilt, firstWithdraw, "withdraw got a fresh graph");
  assert.equal(second.pdgs.find((p) => p.entityId.endsWith("#total")), first.pdgs.find((p) => p.entityId.endsWith("#total")), "total is literally the same object, not a copy");
});

test("the function budget is honoured: past it functions are skipped and reported", () => {
  setConceptConfigForTest({ pdgMaxFunctions: { value: 1, status: "uncalibrated", note: "test" } });
  try {
    const repo = makeRepo({ "src/ledger.ts": LEDGER });
    const store = new Store(":memory:");
    putRevision(store, "rev-a", repo, { "src/ledger.ts": LEDGER });
    const r = buildAllPdgs(store, "rev-a", repo);
    assert.equal(r.pdgs.length, 1);
    assert.equal(r.skipped.length, 1, "only one function is past the one-graph budget");
    assert.deepEqual(r.skipped, ["function:src/ledger.ts#withdraw"], "stable order: deposit sorts first and is graphed");
  } finally { setConceptConfigForTest(null); }
  assert.equal(conceptConfig().pdgMaxFunctions.value, 5000);
});

test("functions whose source cannot be located are reported as unresolved, not crashed on", () => {
  const repo = makeRepo({ "src/ledger.ts": LEDGER });
  const store = new Store(":memory:");
  putRevision(store, "rev-a", repo, { "src/ledger.ts": LEDGER });
  const ghost = { entityId: "function:src/ghost.ts#nope", kind: "function", name: "nope", file: "src/ghost.ts", spans: [] };
  store.db.prepare("insert into entities values (?,?,?,?,?,?)").run("rev-a", ghost.entityId, ghost.kind, ghost.name, ghost.file, JSON.stringify(ghost));
  clearPdgSourceCache();
  const r = buildAllPdgs(store, "rev-a", repo);
  assert.deepEqual(r.unresolved, ["function:src/ghost.ts#nope"]);
  assert.equal(r.pdgs.length, 2, "withdraw and deposit are still graphed");
});

test("an oversized function is truncated and marked so", () => {
  setConceptConfigForTest({ pdgMaxStatements: { value: 3, status: "uncalibrated", note: "test" } });
  try {
    const repo = makeRepo({ "src/ledger.ts": LEDGER });
    const store = new Store(":memory:");
    putRevision(store, "rev-a", repo, { "src/ledger.ts": LEDGER });
    const { pdgs } = buildAllPdgs(store, "rev-a", repo);
    const g = graphOf(pdgs, "withdraw");
    assert.equal(g.truncated, true);
    assert.ok(g.statements <= 3);
  } finally { setConceptConfigForTest(null); }
});

test("buildPdgForFunction returns null for an entity outside any readable source tree", () => {
  const repo = makeRepo({ "src/ledger.ts": LEDGER });
  assert.equal(buildPdgForFunction(repo, { entityId: "function:src/missing.ts#f", kind: "function", name: "f", file: "src/missing.ts", spans: [] }), null);
});
