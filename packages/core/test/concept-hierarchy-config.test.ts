// Plan §8 review point: every threshold the hierarchy uses is declared, read through conceptConfig(),
// and explicitly marked uncalibrated. Nothing may quietly tune itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONCEPT_CONFIG, conceptConfig, parameterStatus, setConceptConfigForTest } from "../src/concept-hierarchy/config.ts";

test("every hierarchy threshold is declared and marked uncalibrated (namingPromptVersion is a counter, not a threshold)", () => {
  const status = parameterStatus();
  const expected = Object.keys(CONCEPT_CONFIG);
  assert.deepEqual(status.map((s) => s.parameter).sort(), [...expected].sort());
  for (const s of status) {
    if (s.parameter === "namingPromptVersion") {
      assert.equal(s.status, "calibrated", "a cache-version counter is exact by construction");
      continue;
    }
    assert.equal(s.status, "uncalibrated", `${s.parameter} must say uncalibrated until tuned against labelled data`);
  }
  for (const [name, c] of Object.entries(CONCEPT_CONFIG)) {
    assert.ok(c.note.length > 20, `${name} carries a note saying what it guards`);
  }
});

test("thresholds are read through conceptConfig(), and only tests may override them", () => {
  assert.equal(conceptConfig().jaccardStable.value, CONCEPT_CONFIG.jaccardStable.value);
  assert.equal(conceptConfig().fullRebuildThreshold.value, CONCEPT_CONFIG.fullRebuildThreshold.value);
  setConceptConfigForTest({ fullRebuildThreshold: { value: 0.9, status: "uncalibrated", note: "test override" } });
  assert.equal(conceptConfig().fullRebuildThreshold.value, 0.9);
  assert.equal(conceptConfig().jaccardStable.value, CONCEPT_CONFIG.jaccardStable.value, "unoverridden keys keep the declared value");
  setConceptConfigForTest(null);
  assert.equal(conceptConfig().fullRebuildThreshold.value, CONCEPT_CONFIG.fullRebuildThreshold.value);
});

test("the anchoring constants the plan names exist: T_stable, T_histogram, full-rebuild threshold", () => {
  assert.equal(typeof CONCEPT_CONFIG.jaccardStable.value, "number");
  assert.equal(typeof CONCEPT_CONFIG.histogramShift.value, "number");
  assert.equal(typeof CONCEPT_CONFIG.fullRebuildThreshold.value, "number");
  assert.ok(CONCEPT_CONFIG.jaccardStable.value > 0 && CONCEPT_CONFIG.jaccardStable.value < 1);
  assert.ok(CONCEPT_CONFIG.histogramShift.value > 0 && CONCEPT_CONFIG.histogramShift.value < 1);
  assert.ok(CONCEPT_CONFIG.fullRebuildThreshold.value > 0 && CONCEPT_CONFIG.fullRebuildThreshold.value <= 1);
});

test("tier-2/3 discovery is a signature-only stub: disabled by default, and it throws if ever called", async () => {
  assert.equal(CONCEPT_CONFIG.enableNmf.value, false);
  assert.equal(CONCEPT_CONFIG.enableFca.value, false);
  const { nmfTopics, fcaConcepts } = await import("../src/concept-hierarchy/tier2.ts");
  assert.throws(() => nmfTopics([{ a: 1 }], 2, 1), /tier-2 stub/);
  assert.throws(() => fcaConcepts({ "function:a.ts#f": ["guarded-write"] }), /tier-3 stub/);
});
