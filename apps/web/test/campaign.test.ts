// F08 UI copy and presentation rules (§12.2): a hidden remainder is never counted, no aggregate success score is ever
// shown, and a compatibility mode that was not evaluated never reads "compatible".
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAMPAIGN_COPY, CHILD_STATE_ORDER, compatibilityLabel, compatibilityTone, countRows, progressText, stateCell } from "../src/campaign-summary.ts";

test("F08 copy: never a single success score, and an unevaluated mode is not 'compatible'", () => {
  assert.equal(compatibilityLabel("NOT_EVALUATED"), "not evaluated");
  assert.notEqual(compatibilityLabel("NOT_EVALUATED"), "compatible");
  assert.equal(compatibilityLabel("NOT_EVALUABLE"), "not evaluable");
  assert.equal(compatibilityLabel("PASSED"), "passed");
  assert.equal(compatibilityTone("NOT_EVALUATED"), "muted");
  assert.equal(compatibilityTone("FAILED"), "bad");
  assert.doesNotMatch(CAMPAIGN_COPY.completed, /succeeded|success rate|health score/i);
  assert.match(CAMPAIGN_COPY.completed, /not merged or deployed/);
});

test("F08 children counts are listed per state, never collapsed into a health score", () => {
  const rows = countRows({ REVIEW_READY: 3, FAILED: 1, EXCLUDED: 1 });
  assert.deepEqual(rows, [
    { state: "REVIEW_READY", count: 3 },
    { state: "FAILED", count: 1 },
    { state: "EXCLUDED", count: 1 },
  ]);
  assert.equal("total" in rows, false, "there is no total field");
  assert.equal("passPercent" in rows, false);
});

test("F08 state cells carry text plus a glyph, never a colour alone, and progress is a count", () => {
  for (const s of CHILD_STATE_ORDER) {
    const cell = stateCell(s);
    assert.ok(cell.label.length > 0 && cell.glyph.length > 0, `${s} has text and a glyph`);
  }
  assert.equal(stateCell("FAILED").tone, "bad");
  assert.equal(stateCell("PUBLISHED").tone, "ok");
  assert.match(progressText(2, 5), /2 of 5/);
  assert.equal(CAMPAIGN_COPY.hiddenNote, "You can see the repositories you have access to.");
});
