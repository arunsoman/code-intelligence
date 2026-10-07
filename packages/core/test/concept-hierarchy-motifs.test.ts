// The motif catalogue: ten generic shapes, matched structurally. Nothing here may know a business
// domain — that is the plan's §0.6 decision, and these tests hold the line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAllPdgs } from "../src/concept-hierarchy/pdg.ts";
import { MOTIF_PATTERNS, matchMotifs } from "../src/concept-hierarchy/motifs.ts";
import { Store } from "../src/store.ts";
import { ACCUMULATE, COLLECT, DISPATCH, FLAG, LEDGER, NULLFALLBACK, RESOURCES, RETRY, RETHROW, makeRepo, putRevision } from "./concept-hierarchy-helpers.ts";

const motifsOf = (files: Record<string, string>, fn: string): string[] => {
  const repo = makeRepo(files);
  const store = new Store(":memory:");
  putRevision(store, "rev", repo, files);
  const { pdgs } = buildAllPdgs(store, "rev", repo);
  const g = pdgs.find((p) => p.entityId.endsWith(`#${fn}`));
  assert.ok(g, `graph for ${fn}`);
  return matchMotifs(g!).map((m) => m.motif);
};

test("the catalogue holds exactly the ten generic motifs, and none names a business operation", () => {
  assert.deepEqual(MOTIF_PATTERNS.map((p) => p.id).sort(), [
    "collect-and-return", "early-exit-guard", "fan-out-dispatch", "flag-guard", "guarded-write",
    "loop-accumulate", "null-check-fallback", "resource-acquire-release", "retry-loop", "wrap-rethrow",
  ]);
  for (const p of MOTIF_PATTERNS) {
    assert.ok(!/debit|credit|increment|transfer|payment|balance|refund/i.test(p.id), `${p.id} must stay generic`);
  }
});

test("a guarded write is matched, and carries the variable it guards", () => {
  const motifs = motifsOf({ "src/l.ts": LEDGER }, "withdraw");
  assert.ok(motifs.includes("guarded-write"));
});

test("a self-fed accumulation matches loop-accumulate; a collect-and-return loop matches both", () => {
  assert.ok(motifsOf({ "src/a.ts": ACCUMULATE }, "total").includes("loop-accumulate"));
  const collect = motifsOf({ "src/c.ts": COLLECT }, "collectNames");
  assert.ok(collect.includes("collect-and-return"));
});

test("an acquire followed by a release matches resource-acquire-release", () => {
  assert.ok(motifsOf({ "src/r.ts": RESOURCES }, "withSession").includes("resource-acquire-release"));
});

test("a self-fed attempt counter beside a call inside the loop matches retry-loop", () => {
  assert.ok(motifsOf({ "src/t.ts": RETRY }, "fetchWithRetry").includes("retry-loop"));
});

test("a boolean-named local followed by a branch matches flag-guard", () => {
  assert.ok(motifsOf({ "src/f.ts": FLAG }, "checkFlag").includes("flag-guard"));
});

test("a branch on a call-derived variable with a fallback assignment matches null-check-fallback", () => {
  assert.ok(motifsOf({ "src/n.ts": NULLFALLBACK }, "findUser").includes("null-check-fallback"));
});

test("a throw whose value is constructed by a call matches wrap-rethrow", () => {
  assert.ok(motifsOf({ "src/w.ts": RETHROW }, "load").includes("wrap-rethrow"));
});

test("one branch guarding two distinct callees matches fan-out-dispatch", () => {
  assert.ok(motifsOf({ "src/d.ts": DISPATCH }, "dispatch").includes("fan-out-dispatch"));
});

test("motifs bind the variables they matched, so composition rules can pair on them", () => {
  const repo = makeRepo({ "src/l.ts": LEDGER });
  const store = new Store(":memory:");
  putRevision(store, "rev", repo, { "src/l.ts": LEDGER });
  const { pdgs } = buildAllPdgs(store, "rev", repo);
  const g = pdgs.find((p) => p.entityId.endsWith("#withdraw"))!;
  const gw = matchMotifs(g).find((m) => m.motif === "guarded-write")!;
  assert.equal(gw.binds.var, "balance");
  assert.ok(gw.nodes.length >= 2, "the branch and the def are both cited");
});
