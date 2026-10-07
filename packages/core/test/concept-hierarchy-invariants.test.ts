// Invariant tiers. The rule that matters (plan §8): "verified" comes ONLY from an explicit assertion
// on the guarded path; guards crossed by await or dynamic writes are "speculative"; structure alone is
// "supported".
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAllPdgs } from "../src/concept-hierarchy/pdg.ts";
import { LANGUAGE_SOUNDNESS_TIER, buildInvariants } from "../src/concept-hierarchy/invariants.ts";
import { Store } from "../src/store.ts";
import { ASSERTED, FLAG, GUARDED_AWAIT, LEDGER, makeRepo, putRevision } from "./concept-hierarchy-helpers.ts";

const invariantsOf = (files: Record<string, string>) => {
  const repo = makeRepo(files);
  const store = new Store(":memory:");
  putRevision(store, "rev-a", repo, files);
  const { pdgs } = buildAllPdgs(store, "rev-a", repo);
  return buildInvariants(store, "rev-a", pdgs);
};

test("a guarded write with no assertion and no hazard is supported, never verified", () => {
  const invs = invariantsOf({ "src/l.ts": LEDGER });
  const inv = invs.find((i) => i.subjectEntityId.endsWith("#withdraw") && i.variable === "balance");
  assert.ok(inv, JSON.stringify(invs.map((i) => [i.subjectEntityId, i.variable])));
  assert.equal(inv!.tier, LANGUAGE_SOUNDNESS_TIER.SUPPORTED);
  assert.match(inv!.basis, /structure only/);
  assert.equal(inv!.guardCondition, "amount");
});

test("an explicit assertion on the guarded path is the only route to verified", () => {
  const invs = invariantsOf({ "src/a.ts": ASSERTED });
  const inv = invs.find((i) => i.subjectEntityId.endsWith("#assertedWithdraw") && i.variable === "balance");
  assert.ok(inv, JSON.stringify(invs.map((i) => [i.subjectEntityId, i.variable])));
  assert.equal(inv!.tier, LANGUAGE_SOUNDNESS_TIER.VERIFIED);
  assert.match(inv!.basis, /explicit assertion/);
});

test("a guard crossed by an await demotes the invariant to speculative", () => {
  const invs = invariantsOf({ "src/g.ts": GUARDED_AWAIT });
  const inv = invs.find((i) => i.subjectEntityId.endsWith("#guardedAwait") && i.variable === "balance");
  assert.ok(inv);
  assert.equal(inv!.tier, LANGUAGE_SOUNDNESS_TIER.SPECULATIVE);
  assert.match(inv!.basis, /await/);
});

test("a dynamic property write under the guard demotes to speculative as well", () => {
  const files = {
    "src/d.ts": `export function dynWrite(obj: Record<string, number>, k: string) {\n  if (k) { obj[k] = 0; }\n}\n`,
  };
  const invs = invariantsOf(files);
  const inv = invs.find((i) => i.subjectEntityId.endsWith("#dynWrite"));
  assert.ok(inv, JSON.stringify(invs.map((i) => [i.subjectEntityId, i.variable])));
  assert.equal(inv!.tier, LANGUAGE_SOUNDNESS_TIER.SPECULATIVE);
  assert.match(inv!.basis, /dynamic property write/);
});

test("invariants are revision-bound and stable in id for the same shape", () => {
  const files = { "src/f.ts": FLAG };
  const a = invariantsOf(files);
  const b = invariantsOf(files);
  assert.deepEqual(a.map((i) => i.id).sort(), b.map((i) => i.id).sort());
  assert.ok(a.every((i) => i.revision === "rev-a"));
  assert.ok(a.every((i) => i.id.startsWith("inv:")));
});
