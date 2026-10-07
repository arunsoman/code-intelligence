// Naming (plan §0.7): the model only names. The cache is keyed by conceptId + canonicalMotifHash +
// modelVersion + promptVersion; traversal is post-order; failure falls back; and — the hard review
// gate — no naming path ever writes a claim or verdict row.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SemanticConcept } from "@cie/schema";
import { nameConcepts, type NamingAdapter } from "../src/concept-hierarchy/naming.ts";
import { Store } from "../src/store.ts";

const concept = (id: string, kind: string, members: string[], compositionRule: string | null = null): SemanticConcept => ({
  id, revision: "rev", kind, label: null, namedBy: null, members, evidenceIds: [],
  canonicalMotifHash: `hash-${id}`, compositionRule, features: { "motif:x": 1 },
  soundness: { tier: "supported", basis: "b" }, source: compositionRule ? "COMPOSITION" : "MOTIF",
});

const countingAdapter = (names: Record<string, string> | null): NamingAdapter & { calls: number } => {
  const adapter = {
    calls: 0,
    modelVersion: "stub/test-model",
    async name(req: { items: { conceptId: string }[] }) {
      adapter.calls++;
      if (names === null) return null;
      return req.items.filter((i) => names[i.conceptId]).map((i) => ({ conceptId: i.conceptId, name: names[i.conceptId] }));
    },
  };
  return adapter;
};

test("model names are attached and cached; a second run with the same shapes asks the model nothing", async () => {
  const store = new Store(":memory:");
  const adapter = countingAdapter({ "sc:1": "withdraw funds", "sc:2": "top up" });
  const first = await nameConcepts(store, { concepts: [concept("sc:1", "debit-form", ["function:a.ts#wa"], "guarded-write+op:sub"), concept("sc:2", "credit-form", ["function:a.ts#dp"], "guarded-write+op:add")], arch: [], adapter });
  assert.equal(first.named, 2);
  assert.equal(first.cacheHits, 0);
  const labels = new Map(first.concepts.map((c) => [c.id, [c.label, c.namedBy]]));
  assert.deepEqual(labels.get("sc:1"), ["withdraw funds", "MODEL"]);

  const second = await nameConcepts(store, { concepts: [concept("sc:1", "debit-form", ["function:a.ts#wa"], "guarded-write+op:sub"), concept("sc:2", "credit-form", ["function:a.ts#dp"], "guarded-write+op:add")], arch: [], adapter });
  assert.equal(second.cacheHits, 2, "both names came from the cache");
  assert.equal(adapter.calls, 1, "the adapter was called once in total");
});

test("a changed shape (different canonical hash) asks again; a changed model version does too", async () => {
  const store = new Store(":memory:");
  const adapter = countingAdapter({ "sc:1": "take out" });
  await nameConcepts(store, { concepts: [concept("sc:1", "debit-form", ["function:a.ts#wa"], "guarded-write+op:sub")], arch: [], adapter });
  const changed = { ...concept("sc:1", "debit-form", ["function:a.ts#wa"], "guarded-write+op:sub"), canonicalMotifHash: "hash-changed" };
  const r2 = await nameConcepts(store, { concepts: [changed], arch: [], adapter });
  assert.equal(r2.cacheHits, 0, "the cache key carries the canonical hash");
  const r3 = await nameConcepts(store, { concepts: [concept("sc:1", "debit-form", ["function:a.ts#wa"], "guarded-write+op:sub")], arch: [], adapter: { ...adapter, modelVersion: "stub/other-model" } });
  assert.equal(r3.cacheHits, 0, "the cache key carries the model version");
});

test("when the model fails or answers nothing, a mechanical FALLBACK label is stored, never a silence", async () => {
  const store = new Store(":memory:");
  const dead = countingAdapter(null);
  const r = await nameConcepts(store, { concepts: [concept("sc:1", "loop-accumulate", ["function:c.ts#total"])], arch: [], adapter: dead });
  assert.equal(r.named, 0);
  assert.equal(r.fallback, 1);
  const c = r.concepts[0];
  assert.ok(c.label && c.label.includes("loop-accumulate"));
  assert.equal(c.namedBy, "FALLBACK");
  const throwing = { modelVersion: "x", name: async () => { throw new Error("down"); } };
  const r2 = await nameConcepts(store, { concepts: [concept("sc:2", "flag-guard", ["function:d.ts#check"])], arch: [], adapter: throwing });
  assert.equal(r2.concepts[0].namedBy, "FALLBACK");
});

test("traversal is post-order: plain concepts are named before the concepts composed from them", async () => {
  const store = new Store(":memory:");
  const seenOrder: string[] = [];
  const adapter: NamingAdapter = {
    modelVersion: "stub/test-model",
    async name(req) {
      for (const i of req.items) seenOrder.push(i.conceptId);
      return req.items.map((i) => ({ conceptId: i.conceptId, name: `name ${i.conceptId}` }));
    },
  };
  await nameConcepts(store, {
    concepts: [
      concept("sc:transfer", "transfer-form", ["function:a.ts#wa", "function:a.ts#dp"], "complementary-pair"),
      concept("sc:plain", "loop-accumulate", ["function:b.ts#t"]),
    ],
    arch: [], adapter,
  });
  assert.deepEqual(seenOrder, ["sc:plain", "sc:transfer"], "composed last, so its parts are already named");
});

test("naming never touches the claims or verdicts tables, whatever happens", async () => {
  const store = new Store(":memory:");
  const adapter = countingAdapter({ "sc:1": "withdraw funds" });
  await nameConcepts(store, { concepts: [concept("sc:1", "debit-form", ["function:a.ts#wa"], "guarded-write+op:sub")], arch: [], adapter });
  await nameConcepts(store, { concepts: [concept("sc:2", "credit-form", ["function:b.ts#dp"], "guarded-write+op:add")], arch: [], adapter: countingAdapter(null) });
  const claims = store.db.prepare("select count(*) as n from claims").get() as { n: number };
  const verdicts = store.db.prepare("select count(*) as n from verdicts").get() as { n: number };
  assert.equal(claims.n, 0, "no claim rows");
  assert.equal(verdicts.n, 0, "no verdict rows");
  assert.ok(store.namingCacheCount() >= 2, "labels live in the naming cache");
  // and the module never imports the claim machinery: no import line may reference it
  const namingSource = await (await import("node:fs")).promises.readFile(new URL("../src/concept-hierarchy/naming.ts", import.meta.url), "utf8");
  const importLines = namingSource.split("\n").filter((l) => l.startsWith("import "));
  assert.ok(importLines.length > 0);
  assert.ok(importLines.every((l) => !/claims|gateClaim|verdicts/i.test(l)), "naming.ts must not import the claim machinery");
});

test("packages are named through NAME_ARCH and cached under their own key space", async () => {
  const store = new Store(":memory:");
  const adapter = countingAdapter({ "arch:pkg:packages/core": "core engine" });
  const arch = [
    { id: "arch:pkg:packages/core", revision: "rev", kind: "package" as const, name: "core", path: "packages/core", parent: "arch:repo", memberEntityIds: [], children: [] },
    { id: "arch:mod:packages/core/src/store.ts", revision: "rev", kind: "module" as const, name: "store.ts", path: "packages/core/src/store.ts", parent: "arch:pkg:packages/core", memberEntityIds: [], children: [] },
  ];
  const r1 = await nameConcepts(store, { concepts: [], arch, adapter });
  const pkg = r1.arch.find((n) => n.id === "arch:pkg:packages/core")!;
  assert.equal(pkg.name, "core engine");
  const mod = r1.arch.find((n) => n.id === "arch:mod:packages/core/src/store.ts")!;
  assert.equal(mod.name, "store.ts", "only packages are renamed");
  const r2 = await nameConcepts(store, { concepts: [], arch, adapter });
  assert.equal(r2.cacheHits, 1, "the package name is cached");
  assert.equal(adapter.calls, 1);
});
