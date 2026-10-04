// The level-of-detail rules, as properties: text stays readable across a whole zoom sweep, a gesture switches once, nothing flickers, and the
// camera ends up where the person was looking.
import assert from "node:assert/strict";
import { test } from "node:test";
import { POLICY, fontPx, levelMove, panFor, pullInside, resolveAnchor, visibility, zoomAfterSwitch, zoomForPx } from "../src/legibility.ts";

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

test("levels move by label size and by the direction of the gesture, not by relative zoom", () => {
  assert.equal(levelMove(zoomForPx(12), "out", 3, 6), "none", "12 px is readable");
  assert.equal(levelMove(zoomForPx(9.9), "out", 3, 6), "coarser");
  assert.equal(levelMove(zoomForPx(9.9), "in", 3, 6), "none", "zooming in on a small view (a level chosen with the stepper) does not aggregate it");
  assert.equal(levelMove(zoomForPx(16.5), "in", 3, 6), "finer");
  assert.equal(levelMove(zoomForPx(16.5), "out", 3, 6), "none");
  assert.equal(levelMove(zoomForPx(5), "out", 0, 6), "none", "nothing coarser than level 0");
  assert.equal(levelMove(zoomForPx(30), "in", 6, 6), "none", "nothing finer than the last level");
});

test("after a switch the labels are readable again: coarser fits the new content when it can, never above the target size, never below the hard minimum", () => {
  const t = zoomForPx(POLICY.targetPx), floor = zoomForPx(POLICY.landingMinPx);
  assert.equal(zoomAfterSwitch("coarser", 5), t, "small content: the target size, all of it visible");
  assert.equal(zoomAfterSwitch("coarser", 1.0), 1.0, "content that fits at a smaller zoom than the target: fit it");
  assert.equal(zoomAfterSwitch("coarser", 0.2), floor, "huge content: the landing minimum (just above the aggregate threshold), the rest is announced as off-screen");
  assert.equal(zoomAfterSwitch("finer", 0.2), t);
  assert.ok(fontPx(zoomAfterSwitch("coarser", 0.2)) > POLICY.aggregateBelowPx);
});

test("property: sweeping the zoom out and in through random content never shows unreadable text after a switch, switches once per gesture and does not flicker", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed), levels = 2 + Math.floor(r() * 5), max = levels;
    let level = max, zoom = zoomForPx(12 + r() * 4), switches = 0;
    const trace: string[] = [];
    // zoom out in 2.3% steps (a wheel tick), then back in
    for (const dir of ["out", "in"] as const) {
      for (let i = 0; i < 400; i++) {
        zoom *= dir === "out" ? 0.977 : 1 / 0.977;
        const move = levelMove(zoom, dir, level, max);
        if (move === "none") continue;
        level += move === "coarser" ? -1 : 1;
        zoom = zoomAfterSwitch(move, 0.2 + r() * 3);
        switches++; trace.push(`${dir}:${move}:L${level}`);
        assert.ok(fontPx(zoom) >= POLICY.hardMinPx - 1e-9, `seed ${seed}: ${fontPx(zoom).toFixed(1)} px after a switch`);
        assert.ok(fontPx(zoom) <= POLICY.targetPx + 1e-9, `seed ${seed}: larger than the target after a switch`);
        // the very next tick must not switch again
        const next = levelMove(zoom * (dir === "out" ? 0.977 : 1 / 0.977), dir, level, max);
        assert.equal(next, "none", `seed ${seed}: switched twice in a row (${trace.join(" ")})`);
      }
    }
    assert.ok(level >= 0 && level <= max);
    assert.ok(switches <= 2 * max + 2, `seed ${seed}: ${switches} switches for ${max} levels: ${trace.join(" ")}`);
  }
});

test("the thresholds leave a hysteresis band: a switch from either side lands well inside it", () => {
  const out = zoomAfterSwitch("coarser", 9), inn = zoomAfterSwitch("finer", 0.1);
  assert.ok(fontPx(out) > POLICY.aggregateBelowPx && fontPx(out) < POLICY.expandAbovePx);
  assert.ok(fontPx(inn) > POLICY.aggregateBelowPx && fontPx(inn) < POLICY.expandAbovePx);
  assert.ok(POLICY.expandAbovePx / POLICY.aggregateBelowPx >= 1.5, "a gesture of at least 50% is needed to go from one edge of the band to the other");
});

test("the anchor is the new node that contains most of what the person was looking at", () => {
  const nodes = [{ id: "g1", members: ["a", "b", "c"], x: 0, y: 0 }, { id: "g2", members: ["d"], x: 100, y: 0 }];
  assert.equal(resolveAnchor(["b", "c"], nodes)?.id, "g1", "several nodes merge: the group");
  assert.equal(resolveAnchor(["a", "b", "d"], nodes)?.id, "g1", "the group with more of the old elements wins");
  assert.equal(resolveAnchor(["d", "a"], nodes)?.id, "g2", "equal counts: the group holding the first id passed");
  const fine = [{ id: "a", members: ["a"], x: 1, y: 1 }, { id: "b", members: ["b"], x: 2, y: 2 }];
  assert.equal(resolveAnchor(["b", "a"], fine)?.id, "b", "a group expanding: ties go to the first id passed, which is the selected or focused one");
  assert.equal(resolveAnchor(["zzz"], fine), null, "nothing survives: the caller falls back");
  assert.equal(resolveAnchor([], fine), null);
});

test("the camera puts the anchor where it was on screen, then moves the least needed to bring the drawing in", () => {
  const pan = panFor({ x: 100, y: 50 }, { x: 400, y: 300 }, 2);
  assert.deepEqual(pan, { x: 200, y: 200 });
  // a drawing from model x 0..300 at zoom 2 spans 200..800 in an 700 wide view: too far right, pulled left to leave the padding
  const pulled = pullInside(pan, { x1: 0, y1: 0, x2: 300, y2: 150 }, 2, 700, 600, 20);
  assert.deepEqual({ lo: 0 * 2 + pulled.x, hi: 300 * 2 + pulled.x }, { lo: 80, hi: 680 });
  // a drawing larger than the viewport is left alone on that axis
  assert.deepEqual(pullInside({ x: -500, y: 10 }, { x1: 0, y1: 0, x2: 2000, y2: 10 }, 1, 800, 600, 20).x, -500);
});

test("visibility counts whole nodes outside, nodes cut by the edge, and the visible share of the drawing", () => {
  const boxes = [{ x1: 10, y1: 10, x2: 60, y2: 40 }, { x1: 750, y1: 10, x2: 850, y2: 40 }, { x1: 100, y1: 700, x2: 160, y2: 730 }];
  const v = visibility(boxes, 800, 600);
  assert.deepEqual({ total: v.total, inView: v.inView, offscreen: v.offscreen, clipped: v.clipped }, { total: 3, inView: 2, offscreen: 1, clipped: 1 });
  assert.ok(v.drawingInViewPct < 100 && v.drawingInViewPct > 0);
  assert.equal(visibility([], 800, 600).drawingInViewPct, 100);
  assert.equal(visibility([{ x1: 0, y1: 0, x2: 800, y2: 600 }], 800, 600).drawingInViewPct, 100);
});
