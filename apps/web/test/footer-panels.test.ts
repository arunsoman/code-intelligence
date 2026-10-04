// Gaps and left-out candidates must not resize the canvas. The live behaviour is checked in
// test/e2e/footer-panels.test.ts; this guards the structure without a browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");

test("gaps and left-out candidates open out of flow so the canvas is not resized", () => {
  const app = read("../src/App.tsx");
  const css = read("../src/styles.css");
  assert.match(app, /className="link footer-toggle"/, "the disclosures are toggles in the footer");
  assert.match(app, /className="footer-panel" role="region"/, "their content is one named panel");
  assert.match(app, /aria-expanded=\{footerOpen\.gaps\}/, "the gaps toggle reports its state");
  assert.doesNotMatch(app, /<details><summary>\{view\.gaps\.length\}/, "the gap list is no longer an in-flow <details>");
  assert.match(css, /footer \{[^}]*position: relative/, "the panel is positioned against the footer");
  assert.match(css, /\.footer-panel \{[^}]*position: absolute/, "the panel is out of flow");
  assert.match(css, /\.footer-panel \{[^}]*max-height: 42vh/, "and height-bounded");
  assert.match(css, /\.footer-panel \{[^}]*overflow: auto/, "so it scrolls inside its own region");
});
