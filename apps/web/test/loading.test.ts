// Loading states: the pure timing/phase rules plus the source-level wiring that keeps the canvas from claiming
// emptiness while work is in flight. The live behaviour is exercised in test/e2e/loading.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { COMPOSING_CAPTION, EMPTY_NO_QUESTION, canvasPhase, emptyStageCopy, jobPhaseText, skeletonVisible } from "../src/loading.ts";

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");

test("a skeleton waits out a fast reply and holds once it is drawn", () => {
  assert.equal(skeletonVisible(false, null, 1000), false, "never pending: never a skeleton");
  assert.equal(skeletonVisible(true, 1000, 1100), false, "pending for 100ms: not yet (fast answers must not flash)");
  assert.equal(skeletonVisible(true, 1000, 1150), true, "pending at the delay: shown");
  assert.equal(skeletonVisible(true, 1000, 9000), true, "still pending much later: still shown");
  assert.equal(skeletonVisible(false, 1000, 1400), true, "data landed right after drawing: held for the minimum");
  assert.equal(skeletonVisible(false, 1000, 1550), false, "minimum elapsed: gone");
});

test("the canvas is composing, showing a view, or genuinely empty — never empty while pending", () => {
  assert.equal(canvasPhase({ hasView: true, pending: true }), "view", "an existing view is kept while a new question composes");
  assert.equal(canvasPhase({ hasView: true, pending: false }), "view");
  assert.equal(canvasPhase({ hasView: false, pending: true }), "composing");
  assert.equal(canvasPhase({ hasView: false, pending: false }), "empty");
  assert.equal(COMPOSING_CAPTION, "Composing a map for your question…");
  assert.equal(emptyStageCopy(true), EMPTY_NO_QUESTION);
  assert.notEqual(emptyStageCopy(false), EMPTY_NO_QUESTION, "an unindexed repository is told to index first");
});

test("long jobs report their phase in words", () => {
  assert.match(jobPhaseText({ kind: "index", state: "QUEUED" }), /Indexing the repository — waiting to start/);
  assert.equal(jobPhaseText({ kind: "index", state: "RUNNING" }), "Indexing the repository…");
  assert.equal(jobPhaseText({ kind: "concepts", state: "RUNNING" }), "Reading the code with the model…");
});

test("the empty-state copy is gated by the canvas phase, not shown whenever there is no view", () => {
  const app = read("../src/App.tsx");
  assert.match(app, /canvasPhase\(\{ hasView: !!view, pending \}\)/, "the canvas phase is derived once");
  assert.match(app, /phase === "composing" \? <CanvasSkeleton/, "the composing phase draws a skeleton");
  assert.match(app, /phase === "composing" \? COMPOSING_CAPTION/, "the caption switches to the composing message");
  assert.doesNotMatch(app, /This map is empty on purpose/, "the misleading copy is no longer emitted unconditionally");
  assert.match(app, /emptyStageCopy\(indexed\)/, "the empty stage uses the phase-aware copy");
});

test("panels that fetch on open draw a skeleton rather than a bare loading line", () => {
  const skeleton = read("../src/Skeleton.tsx");
  assert.match(skeleton, /role="status" aria-busy="true" aria-label=\{label\}/, "the shared skeleton names its busy region");
  for (const [file, label] of [["VisualsGallery.tsx", "visuals catalogue"], ["InsightsPanel.tsx", "tab"], ["InvestigationPanel.tsx", "evidence"], ["DefectPanel.tsx", "findings"]] as const) {
    const src = read(`../src/${file}`);
    assert.match(src, /<Loading pending=/, `${file} shows a skeleton`);
    assert.match(src, new RegExp(`label=[^>]*${label}`, "i"), `${file} names what is loading`);
  }
});
