// The automated accessibility audit, run against the app's own markup and stylesheet.
// The heavy work (bundle with esbuild, render with react-dom/server) happens in the decisive child
// process `apps/web/test/a11y-run.js`; this test asserts its findings. The audit covers what can be
// asserted programmatically — structure, accessible names, labels, the live region, tabindex order,
// WCAG 2.1 contrast of every text and display-mode colour pair in both themes, tinted banner
// backgrounds included. It does NOT cover real screen-reader or trackpad behaviour; the last test
// and README say so in those words. Controls that appear only with a live view (toolbar, level
// group, toggles, dialogs) are convention-checked in the source instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

const run = JSON.parse(spawnSync(process.execPath, [join(here, "a11y-run.ts")], { encoding: "utf8" }).stdout || "{}");

test("a11y audit: the audit process itself runs cleanly", () => {
  assert.equal(run.renderError ?? null, null, `the audit child failed: ${run.renderError}`);
});

test("a11y audit: rendered markup keeps structure, accessible names, labels and the live region", () => {
  assert.equal(run.markupFindings?.length ?? 1, 0, `markup findings:\n${(run.markupFindings ?? []).map((f: { kind: string; detail: string }) => `${f.kind}: ${f.detail}`).join("\n")}`);
});

test("a11y audit: WCAG contrast of every text and display-mode colour pair in light, dark and high contrast", () => {
  const audit = run.contrastFindings ?? {};
  assert.deepEqual(audit.themes, ["light", "dark", "high contrast"]);
  assert.ok(audit.textPairs >= 27 && audit.uiPairs >= 12, `all themes scored in full (text ${audit.textPairs}, ui ${audit.uiPairs})`);
  assert.equal(audit.findings?.length ?? 1, 0, `contrast findings:\n${(audit.findings ?? []).map((f: { detail: string }) => f.detail).join("\n")}`);
});

test("index.html declares a language, a title and a viewport", () => {
  const indexHtml = readFileSync(join(webRoot, "index.html"), "utf8");
  assert.match(indexHtml, /<html[^>]*lang="en"/);
  assert.match(indexHtml, /<title>[^<]{3,}<\/title>/);
  assert.match(indexHtml, /<meta[^>]*name="viewport"/);
});

// These elements appear only once a view is composed, so they cannot be rendered by a static test.
// Their ARIA is asserted as a written convention in the source (and exercised during manual runs).
test("a11y audit: view-dependent controls follow the dialog/toolbar/toggle conventions in source", () => {
  const app = readFileSync(join(webRoot, "src/App.tsx"), "utf8");
  const canvas = readFileSync(join(webRoot, "src/Canvas.tsx"), "utf8");
  assert.match(app, /role="dialog"\s*aria-modal="true"/);
  assert.match(app, /role="toolbar" aria-label="Canvas tools"/);
  assert.match(app, /role="group" aria-label="Level of detail"/);
  assert.match(app, /aria-pressed=/);
  assert.match(canvas, /aria-describedby="canvas-help"/);
  assert.match(canvas, /role="application"/);
});

test("a11y audit: honestly documents what automation cannot replace", () => {
  const readme = readFileSync(join(here, "../../../README.md"), "utf8");
  assert.match(readme, /no real screen-reader/i);
  assert.match(readme, /trackpad/i);
});
