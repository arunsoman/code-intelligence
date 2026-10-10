import { test } from "node:test";
import assert from "node:assert/strict";
import { compiledRace } from "../../../packages/core/test/race-fixture.ts";
import renderer from "../src/plugins/renderers/race-timeline.renderer.ts";
import { rendererForView } from "../src/plugins/renderers/index.ts";
import { basePositions } from "../src/graph.ts";

test("race renderer draws time-proportional rows with station chips and wait lead-ins", () => {
  const view = compiledRace().view, before = structuredClone(view);
  const r = renderer.render(view, 5, basePositions(view), new Set());
  assert.equal(rendererForView(view).id, "race-timeline");
  const scene = r.race!;
  assert.equal(scene.stations.length, 5, "one lane chip per station of the model");
  assert.equal(scene.rows.length, view.race!.requests.length);
  assert.ok(scene.rows.every((row, i, a) => i === 0 || row.y > a[i - 1].y), "rows are ordered");
  for (const b of scene.blocks) {
    assert.ok(b.w >= 2, "service blocks keep a visible width");
    assert.ok(b.waitW >= 0 && b.waitW <= b.x - scene.plotX + 1, "wait lead-ins never precede the plot");
    assert.ok(b.x + b.w <= scene.plotX + scene.plotW + 1, "blocks stay inside the time window");
  }
  assert.deepEqual(view, before, "rendering preserves the replay spec");
});

test("replay rows without drawable stations never invent geometry", () => {
  const view = compiledRace().view;
  view.nodes = view.nodes.slice(0, 0);
  const r = renderer.render(view, 5, basePositions(view), new Set());
  assert.equal(r.race, undefined);
});

test("old saved race views fall back to the generic graph surface", () => {
  const view = compiledRace().view;
  delete view.race;
  const r = renderer.render(view, 5, basePositions(view), new Set());
  assert.equal(r.race, undefined);
});

test("the text alternative names the result class, metrics, every request and every gap", () => {
  const view = compiledRace().view;
  const text = renderer.textAlternative(view);
  assert.match(text, /model prediction/i);
  assert.match(text, /simulated time, not production timing/);
  assert.match(text, /p95/);
  assert.match(text, /TIMEOUT/);
  assert.match(text, /Gap: /);
});
