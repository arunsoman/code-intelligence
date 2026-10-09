import assert from "node:assert/strict";
import test from "node:test";
import { selectedChartId } from "../src/chart-selection.ts";

test("native gallery views select their form without sending a V-code as a chart ID", () => {
  for (const [code, formId] of [["V10", "RaceWindow"], ["V5", "DataLineage"], ["V12", "TestConfidence"]]) {
    assert.equal(selectedChartId({ code: code!, formId: formId! }), undefined);
  }
  assert.equal(selectedChartId({ code: "S16", formId: "GeneratedChart" }), "S16");
  assert.equal(selectedChartId({ code: "S2", formId: "TransactionJourney" }), "S2");
  assert.equal(selectedChartId({ code: "V19", formId: "GeneratedChart" }), "generic");
});
