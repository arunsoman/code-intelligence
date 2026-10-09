// Pointer and pending feedback: the pure convention plus the source-level wiring that the browser test cannot
// reach without a live app. The visual states themselves are exercised in test/e2e/button-feedback.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buttonFeedback } from "../src/button.ts";

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");

test("button feedback: a pending button keeps its classes, announces aria-busy and shows a spinner", () => {
  assert.deepEqual(buttonFeedback({}), { className: undefined, "aria-busy": undefined, spinner: false });
  assert.deepEqual(buttonFeedback({ className: "secondary", busy: true }), { className: "secondary pending", "aria-busy": "true", spinner: true });
  assert.deepEqual(buttonFeedback({ className: "secondary", busy: false }), { className: "secondary", "aria-busy": undefined, spinner: false });
});

test("button feedback: hover, pressed and pending states are defined for every button kind, and reduced motion is respected", () => {
  const css = read("../src/styles.css");
  assert.match(css, /button:not\(:disabled\):hover \{/, "primary buttons react to hover");
  assert.match(css, /button:not\(:disabled\):active \{/, "primary buttons react to press");
  assert.match(css, /button\.secondary:not\(:disabled\):hover \{/, "secondary buttons react to hover");
  assert.match(css, /button\.secondary:not\(:disabled\):active \{/, "secondary buttons react to press");
  assert.match(css, /button\.link:not\(:disabled\):hover \{/, "link buttons react to hover");
  assert.match(css, /button\.link:not\(:disabled\):active \{/, "link buttons react to press");
  assert.match(css, /button\.pending:disabled \{[^}]*opacity: 1/, "a pending button is not merely faded");
  assert.match(css, /button \.spinner \{[^}]*animation:/, "the pending affordance is a spinner, not just a label");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?button \.spinner \{ animation: none/, "reduced motion stops the spinner animation");
});

test("button feedback: the work-starting buttons use the convention", () => {
  const app = read("../src/App.tsx");
  const chat = read("../src/ChatPanel.tsx");
  const insights = read("../src/InsightsPanel.tsx");
  for (const [name, src] of [["App", app], ["ChatPanel", chat], ["InsightsPanel", insights]] as const) {
    assert.match(src, /import \{ buttonFeedback \} from "\.\/button\.ts";/, `${name} imports the convention`);
    assert.match(src, /buttonFeedback\(/, `${name} uses the convention`);
    assert.match(src, /<span className="spinner" aria-hidden="true" \/>/, `${name} renders the spinner`);
  }
  // Index, Extract concepts and Save in App; Send in the chat; Re-index in the insights drawer.
  assert.ok([...app.matchAll(/buttonFeedback\(/g)].length >= 3, "App covers its three slow buttons");
  assert.match(app, /"Update index" : "Index"/);
  // The concept button's label depends on the chosen method, so it comes from MODE_INFO; the convention still has to wrap it.
  assert.match(app, /extractFb\.spinner && <span className="spinner" aria-hidden="true" \/>\}\{MODE_INFO\.hierarchy\.button/, "the concept button shows the spinner and the hierarchy button label");
  assert.match(read("../src/concept-hierarchy-view.ts"), /button: "Build concept hierarchy"/);
  assert.match(app, /Save investigation/);
  assert.match(chat, /Send<\/button>/);
  assert.match(insights, /Re-index<\/button>/);
});
