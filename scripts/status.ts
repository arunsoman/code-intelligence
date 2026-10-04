// Prints the component ledger and fails unless every acceptance item is done and backed by a test that exists.
// An item is "done" only when each test title it names is found in a test file; "blocked" must say what it needs.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LedgerItem { item: string; tests: string[]; state: "done" | "open" | "blocked"; needs?: string }
export interface Ledger { [id: string]: { title: string; items: LedgerItem[] } }

const root = join(import.meta.dirname, "..");
export const ledger: Ledger = JSON.parse(readFileSync(join(root, "docs/ledger.json"), "utf8"));

function walk(dir: string, out: string[] = []) {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f === "target" || f === "dist" || f.startsWith(".")) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
export function testTitles(): string[] {
  const titles: string[] = [];
  for (const f of walk(root)) {
    if (/\.test\.ts$/.test(f)) for (const m of readFileSync(f, "utf8").matchAll(/^\s*test\((["'`])((?:\\.|(?!\1).)*)\1/gm)) titles.push(m[2]);
    else if (f.endsWith(".rs")) for (const m of readFileSync(f, "utf8").matchAll(/#\[test\]\s*(?:async\s+)?fn\s+(\w+)/g)) titles.push(`rust:${m[1]}`);
  }
  return titles;
}

/** Problems with the ledger itself: a done item with no test, a test that does not exist, a blocked item with no stated need. */
export function problems(): string[] {
  const titles = testTitles();
  const out: string[] = [];
  for (const [id, c] of Object.entries(ledger)) for (const it of c.items) {
    if (it.state === "done") {
      if (it.tests.length === 0) out.push(`${id} "${it.item}": marked done with no test`);
      for (const t of it.tests) if (!titles.some((x) => x.includes(t))) out.push(`${id} "${it.item}": no test titled like "${t}"`);
    }
    if (it.state === "blocked" && !it.needs) out.push(`${id} "${it.item}": blocked without saying what it needs`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let done = 0, total = 0, open = 0, blocked = 0;
  for (const [id, c] of Object.entries(ledger)) {
    const d = c.items.filter((i) => i.state === "done").length, b = c.items.filter((i) => i.state === "blocked").length;
    done += d; blocked += b; open += c.items.length - d - b; total += c.items.length;
    const state = d === c.items.length ? "DONE   " : b && d + b === c.items.length ? "BLOCKED" : "OPEN   ";
    console.log(`${id} ${state} ${d}/${c.items.length}  ${c.title}`);
    if (process.argv.includes("-v")) for (const i of c.items) if (i.state !== "done") console.log(`      ${i.state === "blocked" ? "BLOCKED" : "open   "} ${i.item}${i.needs ? `  (needs: ${i.needs})` : ""}`);
  }
  const bad = problems();
  for (const p of bad) console.log("LEDGER PROBLEM:", p);
  console.log(`\n${done}/${total} acceptance items done, ${blocked} blocked, ${open} open`);
  process.exit(bad.length || open || blocked ? 1 : 0);
}
