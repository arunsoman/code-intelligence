// Canonical form: the identity a concept keeps across revisions. Order-insensitive, name-insensitive,
// and the histogram shift is the anchored-rename rule's second gate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, canonicalMotifHash, histogramShift } from "../src/concept-hierarchy/canonicalize.ts";

test("the hash is stable under key, array and feature ordering", () => {
  const a = canonicalMotifHash({ motifs: ["guarded-write"], features: { "motif:guarded-write": 1, "op:sub": 1 }, compositionRule: "guarded-write+op:sub" });
  const b = canonicalMotifHash({ motifs: ["guarded-write"], features: { "op:sub": 1, "motif:guarded-write": 1 }, compositionRule: "guarded-write+op:sub" });
  assert.equal(a, b);
  const c = canonicalMotifHash({ motifs: ["loop-accumulate", "guarded-write"], features: {}, compositionRule: null });
  const d = canonicalMotifHash({ motifs: ["guarded-write", "loop-accumulate"], features: {}, compositionRule: null });
  assert.equal(c, d);
});

test("different shapes hash differently; the canonical JSON is deterministic too", () => {
  const debit = canonicalMotifHash({ motifs: ["guarded-write"], features: { "op:sub": 1 }, compositionRule: "guarded-write+op:sub" });
  const credit = canonicalMotifHash({ motifs: ["guarded-write"], features: { "op:add": 1 }, compositionRule: "guarded-write+op:add" });
  assert.notEqual(debit, credit);
  assert.equal(canonicalJson({ motifs: ["b", "a"], features: { y: 1, x: 2 }, compositionRule: null }), '{"compositionRule":null,"features":{"x":2,"y":1},"motifs":["a","b"]}');
});

test("histogram shift: identical is zero, disjoint is one, partial is between", () => {
  assert.equal(histogramShift({}, {}), 0);
  assert.equal(histogramShift({ a: 2 }, { a: 2 }), 0);
  assert.equal(histogramShift({ a: 1 }, { b: 1 }), 1);
  const half = histogramShift({ a: 1, b: 1 }, { a: 1, b: 2 });
  assert.ok(half > 0 && half < 1, `partial shift ${half}`);
  assert.equal(histogramShift({ a: 1 }, { a: 1, b: 1 }), 1 / 3);
});
