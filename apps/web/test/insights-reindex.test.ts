// A re-index started inside the Insights drawer must not leave the app pinned to the revision it first loaded.
// The live behaviour is checked in test/e2e/insights-reindex.test.ts; this guards the wiring without a browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");

test("a re-index inside the Insights drawer refreshes the app so reopening shows the new revision", () => {
  const panel = read("../src/InsightsPanel.tsx");
  const app = read("../src/App.tsx");
  assert.match(panel, /const \[revision\] = useState\(openedRevision\)/, "the drawer keeps the revision it was opened on");
  assert.match(panel, /onReindexed\?\.\(\)/, "a finished re-index tells the app to refresh");
  assert.match(app, /onReindexed=\{refresh\}/, "the app refreshes so the next opening gets the new revision");
});
