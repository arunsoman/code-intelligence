import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const dir = join(import.meta.dirname, "../src/build");
const tsx = readFileSync(join(dir, "BuildFeature.tsx"), "utf8"), css = readFileSync(join(dir, "build.css"), "utf8");

// UX-64/66/67/87: the original overlap and clipping came from global rules written for other panels (header, footer, .dirs, .modal).
test("the Build dialog uses its own layout classes, never the global header/footer/.dirs/.modal rules", () => {
  for (const bad of [/<header[\s>]/, /<footer[\s>]/, /className="dirs"/, /className="modal[\s"]/, /className="btn[\s"]/, /overflowX|overflow-x:\s*scroll/]) assert.ok(!bad.test(tsx), `BuildFeature.tsx must not use ${bad}`);
});

test("no pane scrolls sideways, the dialog never exceeds the viewport, and narrow screens stack into one scroll", () => {
  assert.match(css, /\.bf-dialog \{[^}]*width: min\(96vw, 1100px\)/);
  assert.ok(!/overflow-x:\s*(auto|scroll)/.test(css), "horizontal scrolling is never enabled");
  assert.equal((css.match(/overflow-x: hidden/g) ?? []).length >= 3, true);
  assert.match(css, /@media \(max-width: 1000px\)[\s\S]*\.bf-body \{ display: block; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible \{ outline: 2px solid/);
});

test("exactly one primary-styled button in the dialog: everything else is secondary or ghost", () => {
  const plain = [...tsx.matchAll(/<button\b([^>]*)>/g)].map((m) => m[1]!).filter((a) => !/className="[^"]*(secondary|bf-ghost)/.test(a) && !/className=\{`secondary/.test(a));
  assert.equal(plain.length, 1, `expected a single unclassed (primary) button, found ${plain.length}: ${plain.join(" | ").slice(0, 200)}`);
  assert.match(plain[0]!, /onClick=\{runPrimary\}/);
});
