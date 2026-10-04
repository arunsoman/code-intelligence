// The Team panel's controls are asserted at the source level: the React shell is not rendered by tests, but the
// regressions this guards against are structural (placeholder-only fields, a wrapped button, an unlabelled select).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const src = readFileSync(join(import.meta.dirname, "../src/InsightsPanel.tsx"), "utf8");
const team = src.slice(src.indexOf("function Team("), src.indexOf("function Evaluation("));

test("the Team panel labels every field visibly and does not leave placeholder-only inputs", () => {
  assert.match(team, /<label htmlFor="pname">New person<\/label>/, "the person field has a visible label");
  assert.match(team, /<label htmlFor="deny">Folders to hide, comma separated<\/label>/, "the deny field has a visible label");
  assert.match(team, /<label htmlFor="wssel">Investigation to share<\/label>/, "the investigation select has a visible label");
  assert.doesNotMatch(team, /htmlFor="(?:pname|deny|wssel)" className="sr"/, "no label is screen-reader-only any more");
});

test("the Team panel uses a switch, an inline add, and its own field layout", () => {
  assert.match(team, /role="switch"/, "team features is a switch, not a wrapped button");
  assert.match(team, /aria-checked=\{teamOn\}/, "the switch reports its state");
  assert.match(team, /<div className="inline">\s*<input id="pname"[\s\S]{0,200}?Add person/, "Add person sits inline with its field");
  assert.match(team, /<div className="field">/, "fields are grouped with their labels");
  assert.match(team, /<div className="team-panel">/, "the panel is scoped so its CSS cannot leak");
  assert.match(src, /import "\.\/team\.css"/, "the panel's layout rides with it");
});
