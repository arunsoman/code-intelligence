// F05-A5 gate: the presentation verifier. Every claim that can be made without the worker must hold, and every
// dishonest pathway must be refused here — a modeled number through a measured template, a window-overlap claim
// worded as per-request, a measured item whose artifact is not in the store, values outside their population.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  TemplateRegistry, builtinTemplates, claimStrength, manifestHash, metricItem, templateProblems, verifyMetricPresentation,
  type MetricItem, type VerificationContext,
} from "../src/profiles-present.ts";

const OK_WINDOW = { fromNs: 1_000_000_000, toNs: 2_000_000_000 };
const itemOf = (over: Partial<MetricItem> = {}): MetricItem => ({
  itemId: "mi:x", locator: "src/tax.js#taxOf", claimId: null, templateId: "profile.hotspot.self", templateVersion: 1,
  value: 0.18, unit: "share", basis: "MEASURED_PROFILE", populationHash: "pop:abc", window: { fromNs: OK_WINDOW.fromNs, toNs: OK_WINDOW.toNs },
  sampleCount: 240, populationValue: 1, artifactHash: "artifact:0001", uncertainty: null, caveatIds: [], certificateId: null,
  ...over,
});

const CX: VerificationContext = {
  templateOf: (id, v) => {
    if (v !== 1) return null;
    if (id === "profile.hotspot.self" || id === "profile.hotspot.total") return { claimClass: "MEASURED_PROFILE" };
    if (id === "profile.window.population" || id === "profile.window.coverage") return { claimClass: "POPULATION_OVERLAP" };
    return null;
  },
  artifactExists: (h) => h === "artifact:0001",
  unitOfArtifact: (h) => (h === "artifact:0001" ? "microseconds" : null),
  populationOf: (h) => (h === "pop:abc" ? { sampleCount: 240, window: OK_WINDOW } : null),
  evidenceExists: (_rev, id) => id === "ev:known",
  revision: "rev:1",
};

const verified = (items: MetricItem[], cx = CX) => verifyMetricPresentation(items, cx);
const reasonsFor = (items: MetricItem[], cx = CX) => verified(items, cx).flatMap((c) => c.reasons);

describe("profile presentation · template registry", () => {
  test("registers the built-in templates and keeps them immutable per id+version", () => {
    const r = new TemplateRegistry();
    for (const t of builtinTemplates()) r.register(t);
    assert.ok((r.all().length) >= (6));
    assert.strictEqual(r.of("profile.hotspot.self", 1)!.claimClass, "MEASURED_PROFILE");
    // same content again is a no-op; different content at the same identity is refused
    const t = r.of("profile.hotspot.self", 1)!;
    assert.strictEqual(r.register({ id: t.id, version: t.version, claimClass: t.claimClass, text: t.text }).hash, t.hash);
    assert.throws(() => r.register({ id: t.id, version: t.version, claimClass: t.claimClass, text: "different" }), /immutable/);
  });

  test("refuses templates whose wording is stronger than their claim class", () => {
    assert.ok(String(templateProblems({ id: "x.pop", version: 1, claimClass: "POPULATION_OVERLAP", text: "this request caused a tax call due to sampling" }).map((d) => d.code)).includes("UNSAFE_WORDING"));
    const modeled = templateProblems({ id: "x.modeled", version: 1, claimClass: "MODELED", text: "the model says it is measured as 40%" });
    assert.ok(String(modeled.map((d) => d.code)).includes("UNSAFE_WORDING"));
    // the one allowed mention: "not measured"
    assert.deepStrictEqual(templateProblems({ id: "profile.modeled.note", version: 1, claimClass: "MODELED", text: "modelled, not measured: {statement}" }), []);
  });

  test("claim classes are strictly ordered; a template moving classes must move a version", () => {
    assert.ok((claimStrength("MODELED")) < (claimStrength("ESTIMATED")));
    assert.ok((claimStrength("ESTIMATED")) < (claimStrength("OBSERVED_TRACE")));
    assert.ok((claimStrength("OBSERVED_TRACE")) < (claimStrength("POPULATION_OVERLAP")));
    assert.ok((claimStrength("POPULATION_OVERLAP")) < (claimStrength("MEASURED_PROFILE")));
  });
});

describe("profile presentation · verifyMetricPresentation (F05-A5)", () => {
  test("accepts a fully-cited measured item", () => {
    const [check] = verified([itemOf()]);
    assert.strictEqual(check.verdict, "VERIFIED");
    assert.deepStrictEqual(check.reasons, []);
  });

  test("refuses a modeled number presented through a measured template", () => {
    const [check] = verified([itemOf({ basis: "MODELED" })]);
    assert.strictEqual(check.verdict, "REJECTED");
    assert.match(check.reasons.join(" "), /never appear as a measured/);
    assert.match(check.reasons.join(" "), /F05-A5/);
  });

  test("refuses a measured item whose artifact is not in the store", () => {
    const [check] = verified([itemOf({ artifactHash: "artifact:gone" })]);
    assert.strictEqual(check.verdict, "REJECTED");
    assert.match(check.reasons.join(" "), /traceable/);
  });

  test("refuses a measured item with a unit that is not the artifact's declared unit", () => {
    assert.match(reasonsFor([itemOf({ unit: "objects" })]).join(" "), /declared unit/);
    assert.deepStrictEqual(reasonsFor([itemOf({ unit: "microseconds", artifactHash: "artifact:0001" })]), []);
  });

  test("refuses a window-overlap claim worded per-request and missing the grade caveat (F05-D8)", () => {
    const it1 = itemOf({ basis: "POPULATION_OVERLAP", templateId: "profile.window.population", locator: "this request spent time in taxOf" });
    const out = verified([it1, itemOf({ basis: "POPULATION_OVERLAP", templateId: "profile.window.population", caveatIds: ["grade:WINDOW_OVERLAP"] })]);
    assert.strictEqual(out[0].verdict, "REJECTED");
    assert.match(out[0].reasons.join(" "), /this request/);
    assert.match(out[0].reasons.join(" "), /grade/);
    assert.strictEqual(out[1].verdict, "VERIFIED");
  });

  test("refuses values that do not fit inside their population and windows outside it", () => {
    assert.match(reasonsFor([itemOf({ populationValue: 1, value: 1.2 })]).join(" "), /does not fit inside its population/);
    assert.match(reasonsFor([itemOf({ window: { fromNs: 99e9, toNs: 100e9 } })]).join(" "), /window/);
  });

  test("refuses cited evidence that does not exist in the shown revision", () => {
    assert.match(reasonsFor([itemOf({ certificateId: "ev:unknown" })]).join(" "), /does not exist in this revision/);
    assert.deepStrictEqual(reasonsFor([itemOf({ certificateId: "ev:known" })]), []);
  });

  test("the manifest hash is blinded to item ids and stable across re-ordering", () => {
    const a = itemOf(), b = itemOf({ locator: "src/b.js#c", value: 0.3 });
    assert.strictEqual(manifestHash([a, b]), manifestHash([b, a]));
    assert.strictEqual(manifestHash([itemOf({ itemId: "mi:other" })]), manifestHash([itemOf({ itemId: "mi:irrelevant" })]));
  });
});
