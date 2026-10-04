import assert from "node:assert/strict";
import { test } from "node:test";
import { problems } from "../../../scripts/status.ts";

test("ledger: every item marked done names tests that exist, and every blocked item says what it needs", () => {
  assert.deepEqual(problems(), []);
});
