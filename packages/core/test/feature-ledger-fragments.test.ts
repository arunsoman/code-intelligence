import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { testTitles, type Ledger } from "../../../scripts/status.ts";

// Plan rule 4: each task writes a ledger fragment; W4 merges them into docs/ledger.json. Until then the fragments obey the
// same rule as the ledger: "done" names tests that exist, "blocked" says what it needs.
test("prompt-to-feature ledger fragments: every done item names tests that exist, every blocked item says what it needs", () => {
  const dir = join(import.meta.dirname, "../../../docs/prompt-to-feature/ledger");
  const titles = testTitles(); const bad: string[] = []; let files = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    files++;
    const frag = JSON.parse(readFileSync(join(dir, f), "utf8")) as Ledger;
    for (const [comp, c] of Object.entries(frag)) for (const it of c.items) {
      if (it.state === "done") { if (!it.tests.length) bad.push(`${f} ${comp} "${it.item}": done with no test`); for (const t of it.tests) if (!titles.some((x) => x.includes(t))) bad.push(`${f} ${comp}: no test titled like "${t}"`); }
      if (it.state === "blocked" && !it.needs) bad.push(`${f} ${comp} "${it.item}": blocked without saying what it needs`);
    }
  }
  assert.ok(files >= 5);
  assert.deepEqual(bad, []);
});
