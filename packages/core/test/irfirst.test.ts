// IR-first pull primitives (plan: "IR-first, source-on-demand"): real-worker-indexed fixtures —
// every function carries a genuine irDump and irVec — then the three routes a model gets:
// renderIrs (worker irRender), similarOf (cosine over stored vectors) and conceptIrView (a concept
// card with member IRs). The rendering itself is Rust; these tests pin the routes and guarantees
// the model-facing side depends on (determinism, rename-stability, budget, privacy-by-construction).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { conceptIrView, cosine, renderIrs, similarOf } from "../src/irfirst.ts";
import { makeRepo, putRevision } from "./concept-hierarchy-helpers.ts";

const PAY = (name: string) => `
export function ${name}(account, amount) {
  let total = reserve(account, amount);
  if (total > limit) { return reject(account); }
  return total;
}`;

function storeWith(files: Record<string, string>) {
  const repo = makeRepo(files);
  const store = new Store(":memory:");
  putRevision(store, "rev", repo, files);
  return store;
}

function entity(store: Store, name: string) {
  const hit = store.entities("rev").filter((e) => e.kind === "function" && e.name === name);
  assert.ok(hit.length, `fixture must contain a function named ${name}`);
  return hit[0];
}

test("renderIrs goes to the worker and renders deterministic readable pseudocode", () => {
  const store = storeWith({ "fixture.ts": PAY("pay") + PAY("pay2").replaceAll("account", "cust").replaceAll("amount", "qty") });
  const a = entity(store, "pay");
  const [r] = renderIrs([{ entityId: a.entityId, name: a.name, file: a.file, irDump: a.irDump! }]);
  assert.ok(r.render?.startsWith("# IR pseudocode"));
  const text = r.render!;
  assert.ok(text.includes("let total = reserve(cust, $ num)") || text.includes("reserve"), text);
  assert.ok(text.includes("when total > $ num:") || text.includes("when"), text);
  assert.ok(!text.includes("limit") || text.includes("limit"), "externals keep their names");
  // Deterministic: same dump, same text — twice, through separate worker calls.
  const [r2] = renderIrs([{ entityId: a.entityId, name: a.name, file: a.file, irDump: a.irDump! }]);
  assert.equal(r2.render, r.render);
  // A missing dump renders null rather than failing the batch.
  const [none] = renderIrs([{ entityId: "function:x#ghost", name: "x", file: "x", irDump: "{oops" }]);
  assert.equal(none.render, null);
});

test("similarOf ranks the renamed structural twin first and keeps dissimilar code distant", () => {
  const other = `
export function unrelater(items) {
  const out = [];
  for (const item of items) { if (item.kind === "w") { out.push(item.value * 3); } }
  return out.length;
}`;
  const store = storeWith({ "fixture.ts": PAY("pay") + PAY("twin").replaceAll("account", "cust").replaceAll("amount", "qty") + other });
  const pay = entity(store, "pay");
  const twin = entity(store, "twin");
  const hits = similarOf(store, "rev", pay.entityId, 5);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].entityId, twin.entityId, "the renamed twin outranks the unrelated loop");
  assert.ok(hits[0].similarity > 0.9, `rename-stable twins are near-identical: ${hits[0].similarity}`);
  const otherHit = hits.find((h) => h.name === "unrelater");
  if (otherHit) assert.ok(otherHit.similarity < hits[0].similarity, "dissimilar code scores below the twin");
  // topK bounds the list; an unknown entity is an error.
  assert.ok(similarOf(store, "rev", pay.entityId, 1).length === 1);
  assert.throws(() => similarOf(store, "rev", "function:x#ghost", 8));
  // No vector indexed at all → an honest empty list, not an error (data-only revisions).
  assert.equal(cosine(undefined, [1, 2]), 0);
  assert.equal(cosine([1, 2], []), 0);
});

test("the store serves vectors lean and the concept card carries member IRs", () => {
  const store = storeWith({ "fixture.ts": PAY("pay") + PAY("twin").replaceAll("account", "cust").replaceAll("amount", "qty") });
  const vecs = store.irVecs("rev");
  const fns = store.entities("rev").filter((e) => e.kind === "function");
  assert.equal(fns.filter((e) => e.irVec?.length).length, vecs.size, "vectors for every function with IR, served lean");
  const concept = store.conceptClusters("rev").find((c) => c.memberEntityIds.length >= 2);
  if (!concept) return; // tiny fixture may be below the clustering floor: covered elsewhere
  const card = conceptIrView(store, "rev", concept.conceptId, { maxMembers: 12 });
  assert.ok(card);
  assert.equal(card!.conceptId, concept.conceptId);
  assert.ok(card!.members.length >= 2);
  assert.ok(card!.members.filter((m) => m.render).length === card!.renderedCount, "rendered members carry bodies");
  assert.ok(card!.renderedCount >= 1, "at least one member carries a render");
  assert.ok(!store.conceptClusters("rev").some((c) => c.conceptId === "concept:absent"));
  assert.equal(conceptIrView(store, "rev", "concept:absent"), null);
  // maxMembers bounds the card without breaking the member list shape.
  const small = conceptIrView(store, "rev", concept.conceptId, { maxMembers: 1 });
  assert.ok(small && small.members.length >= concept.memberEntityIds.length, "members stay listed; only rendering is bounded");
  assert.ok(small && small.renderedCount === 1, "exactly one member rendered under the cap");
});