// F09 data-model and policy validation tests (F09-D1, D2).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_THRESHOLDS,
  defaultDetailPolicy,
  detailPolicyFor,
  detailSummary,
  invalidPolicies,
  semanticMapPolicy,
  validatePolicy,
  type DetailPolicy,
} from "../src/detail.ts";

test("every form has a valid detail policy (F09-A7 / D1)", () => {
  const bad = invalidPolicies();
  assert.deepEqual(bad, [], `invalid policies: ${JSON.stringify(bad)}`);
});

test("default policy has no aggregation and hides labels below the hard minimum", () => {
  const p = defaultDetailPolicy("CausalGraph");
  assert.equal(p.formId, "CausalGraph");
  assert.equal(p.aggregationSupported, false);
  assert.equal(p.levels.length, 0);
  assert.equal(p.labelFallback, "HIDE");
  assert.equal(p.defaultLevel, 0);
});

test("semantic map policy declares seven levels and valid thresholds", () => {
  const p = semanticMapPolicy();
  assert.equal(p.levels.length, 7);
  assert.equal(p.levels[6].name, "Detail");
  assert.equal(p.aggregationSupported, true);
  const v = validatePolicy(p);
  assert.equal(v.ok, true);
});

test("policy validator rejects out-of-order thresholds", () => {
  const p: DetailPolicy = { ...semanticMapPolicy(), hardMinPx: 12 };
  const v = validatePolicy(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("hardMinPx")));
});

test("policy validator rejects LABEL_ONLY caveat channels (F09-D2)", () => {
  const p: DetailPolicy = { ...semanticMapPolicy(), caveatChannels: { warning: "LABEL_ONLY" } };
  const v = validatePolicy(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("LABEL_ONLY")));
});

test("policy validator rejects aggregation mismatch", () => {
  const p: DetailPolicy = { ...defaultDetailPolicy("CausalGraph"), levels: [{ n: 0, name: "X", hint: "x", aggregation: null, labelClasses: {} }] };
  const v = validatePolicy(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("non-aggregation forms")));
});

test("policy validator rejects duplicate or empty level names", () => {
  const p: DetailPolicy = {
    ...semanticMapPolicy(),
    levels: [
      { n: 0, name: "A", hint: "a", aggregation: null, labelClasses: {} },
      { n: 1, name: "A", hint: "b", aggregation: null, labelClasses: {} },
    ],
  };
  const v = validatePolicy(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("duplicate")));
});

test("detail summary exposes level count and fallback per form", () => {
  assert.deepEqual(detailSummary("SemanticMap"), { formId: "SemanticMap", aggregationSupported: true, levelCount: 7, labelFallback: "HIDE" });
  assert.deepEqual(detailSummary("CausalGraph"), { formId: "CausalGraph", aggregationSupported: false, levelCount: 0, labelFallback: "HIDE" });
});

test("runtime overlay inherits semantic map policy", () => {
  const p = detailPolicyFor("RuntimeOverlay");
  assert.equal(p.formId, "RuntimeOverlay");
  assert.equal(p.levels.length, 7);
});

test("DEFAULT_THRESHOLDS match the original legibility policy", () => {
  assert.equal(DEFAULT_THRESHOLDS.aggregateBelowPx, 10);
  assert.equal(DEFAULT_THRESHOLDS.hardMinPx, 9);
  assert.equal(DEFAULT_THRESHOLDS.landingMinPx, 10.5);
  assert.equal(DEFAULT_THRESHOLDS.targetPx, 11.5);
  assert.equal(DEFAULT_THRESHOLDS.expandCandidateMinPx, 16);
});
