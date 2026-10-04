// The policy matrix keeps its height at the source level too, so the invariant is guarded even where no browser runs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");

test("the policy matrix keeps its height: explanation and key collapse, headers wrap, the grid grows", () => {
  const matrix = read("../src/MatrixView.tsx");
  const consequences = read("../src/Consequences.tsx");
  const css = read("../src/styles.css");
  assert.doesNotMatch(matrix, /\bclip\(/, "headers are no longer truncated in the component");
  assert.match(matrix, /<details>[\s\S]*What the symbols mean/, "the full symbol key is behind a disclosure");
  assert.match(matrix, /className="matrix-key"/, "a compact key stays visible");
  assert.match(consequences, /<details className="consequences">/, "\"what this means\" is a disclosure, not a fixed block");
  assert.match(css, /\.matrix-scroll \{[^}]*flex: 1 1 auto/, "the grid takes the remaining height");
  assert.match(css, /\.matrix \.colhead \.lbl[^{]*\{[^}]*overflow-wrap: anywhere/, "column headers wrap");
});
