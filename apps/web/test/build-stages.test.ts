import assert from "node:assert/strict";
import { test } from "node:test";
import { EFFECTFUL_ACTIONS, STAGES } from "../src/build/stages.ts";

test("Build feature: six stages in the specified order, each with a distinct primary action", () => {
  assert.deepEqual(STAGES.map((s) => s.id), ["DESCRIBE", "CLARIFY", "PLAN", "CHANGES", "VALIDATE", "DELIVER"]);
  assert.equal(new Set(STAGES.map((s) => s.primary)).size, 6);
});
test("Build feature: effectful actions are separate and none is called Next", () => {
  assert.deepEqual([...EFFECTFUL_ACTIONS], ["Build candidate", "Run validation", "Export patch", "Create draft PR"]);
  assert.ok(![...EFFECTFUL_ACTIONS, ...STAGES.map((s) => s.primary)].some((a) => /^next$/i.test(a)));
});
