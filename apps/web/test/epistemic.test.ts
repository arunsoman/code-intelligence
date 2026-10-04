import assert from "node:assert/strict";
import { test } from "node:test";
import { epistemicSummary } from "../src/epistemic.ts";

test("evidence summary excludes hidden elements and keeps uncertain categories separate", () => {
  const result = epistemicSummary([
    { displayMode: "FACT" }, { displayMode: "FACT" }, { displayMode: "INFERENCE" },
    { displayMode: "HYPOTHESIS" }, { displayMode: "FOG" }, { displayMode: "HIDDEN" },
  ]);
  assert.equal(result.total, 5);
  assert.deepEqual(result.items.map((x) => [x.label, x.count, x.percent]), [
    ["Fact", 2, 40], ["Inference", 1, 20], ["Hypothesis", 1, 20], ["Fog", 1, 20],
  ]);
  assert.equal(epistemicSummary([]).total, 0);
  assert.ok(epistemicSummary([]).items.every((x) => x.percent === 0));
});
