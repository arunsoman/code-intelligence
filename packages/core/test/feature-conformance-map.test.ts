import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atRefs, buildConformance, parseResults, plainTitle, specRows, summary } from "../../../scripts/conformance.ts";
import { testTitles } from "../../../scripts/status.ts";

const root = join(import.meta.dirname, "../../..");
const spec = readFileSync(join(root, "Prompt-to-feature.md"), "utf8");
const json = (f: string) => JSON.parse(readFileSync(join(root, "docs/prompt-to-feature", f), "utf8"));

test("4.2 scenario references in titles: single, range and list forms, limited to AT-01–84", () => {
  assert.deepEqual(atRefs("AT-07 revising the contract"), ["AT-07"]); assert.deepEqual(atRefs("AT-74-77 build failures"), ["AT-74", "AT-75", "AT-76", "AT-77"]);
  assert.deepEqual(atRefs("AT-22/57 and AT-12/21/22 and AT-30/40"), ["AT-12", "AT-21", "AT-22", "AT-30", "AT-40", "AT-57"]); assert.deepEqual(atRefs("AT-14/AT-84 real Chrome"), ["AT-14", "AT-84"]);
  assert.deepEqual(atRefs("AT-99 does not exist, AT-00 neither, PF-077"), []);
});

test("4.2 the run parser reads pass, fail and skip lines, and a failure is never overwritten by a later pass of the same title", () => {
  const m = parseResults("  ✔ one (1.2ms)\n  ✖ two (3ms)\n  ﹣ three # SKIP\n  ✔ two (1ms)\nℹ tests 3\n"); assert.equal(m.get("one"), "PASS"); assert.equal(m.get("two"), "FAIL"); assert.equal(m.get("three"), "SKIPPED");
  assert.equal(plainTitle('AT-04 \\"all\\" needs a scope'), 'AT-04 "all" needs a scope');
});

test("4.2 status rules: PASS needs every citing test to pass, a failure is FAIL, no run is SKIPPED, a deferral overrides PASS but never FAIL, no test and no deferral is UNTESTED", () => {
  const fake = "| AT-01 | a | b | PF-001 |\n| AT-02 | c | d | PF-002 |\n| AT-03 | e | f |\n| AT-04 | g | h |\n| AT-05 | i | j |\n";
  const titles = ["AT-01 passes", "AT-02 fails", "AT-03 never ran", "mapped test for four"];
  const rows = buildConformance(fake, titles, new Map([["AT-01 passes", "PASS"], ["AT-02 fails", "FAIL"], ["mapped test for four", "PASS"]]), { "AT-02": "later", "AT-04": "partial" }, { "AT-04": ["mapped test"] });
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [["AT-01", "PASS"], ["AT-02", "FAIL"], ["AT-03", "SKIPPED"], ["AT-04", "DEFERRED"], ["AT-05", "UNTESTED"]]);
  assert.equal(rows[3]!.tests.length, 1); assert.deepEqual(summary(rows), { PASS: 1, FAIL: 1, SKIPPED: 1, DEFERRED: 1, UNTESTED: 1 });
});

test("4.2 the spec has exactly AT-01–84, the committed map and deferrals name real scenarios and tests, and every deferral gives a reason", () => {
  const rows = specRows(spec); assert.deepEqual(rows.map((r) => r.id), Array.from({ length: 84 }, (_, i) => `AT-${String(i + 1).padStart(2, "0")}`));
  const ids = new Set(rows.map((r) => r.id)); const titles = testTitles().map(plainTitle);
  const deferred = json("deferred.json") as Record<string, string>, mapped = json("at-map.json") as Record<string, string[]>;
  for (const [id, why] of Object.entries(deferred)) { assert.ok(ids.has(id), `${id} is not a scenario`); assert.ok(why.trim().length > 20, `${id} needs a real reason`); }
  for (const [id, parts] of Object.entries(mapped)) { assert.ok(ids.has(id), `${id} is not a scenario`); for (const p of parts) assert.ok(titles.some((t) => t.includes(p)), `${id}: no test is titled like "${p}"`); }
});

test("4.2 the committed conformance report accounts for every scenario: none is UNTESTED, none FAILED, and it was generated from the current spec", () => {
  const report = json("conformance.json") as { id: string; status: string; scenario: string }[]; const rows = specRows(spec);
  assert.equal(report.length, 84); assert.deepEqual(report.map((r) => r.scenario), rows.map((r) => r.scenario), "regenerate with: node scripts/conformance.ts --run");
  assert.deepEqual(report.filter((r) => r.status === "UNTESTED" || r.status === "FAIL" || r.status === "SKIPPED").map((r) => `${r.id} ${r.status}`), []);
  assert.ok(report.every((r) => ["PASS", "DEFERRED"].includes(r.status)));
});
