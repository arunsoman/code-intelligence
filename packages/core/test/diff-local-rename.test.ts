import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ctx, setup } from "./helpers.ts";

const V1 = `export function total(prices: number[]) {\n  let sum = 0;\n  for (const p of prices) sum += p;\n  return sum;\n}\nexport function untouched() { return 1; }\n`;
// Only a local variable is renamed: no observable behaviour changed.
const V2_RENAME = `export function total(prices: number[]) {\n  let acc = 0;\n  for (const p of prices) acc += p;\n  return acc;\n}\nexport function untouched() { return 1; }\n`;
// The inverse: a real behavioural change (a new call) must still be reported.
const V2_BEHAVIOUR = `export function total(prices: number[]) {\n  let sum = 0;\n  for (const p of prices) sum += round(p);\n  return sum;\n}\nexport function round(n: number) { return Math.round(n); }\nexport function untouched() { return 1; }\n`;

function initRepo(dir: string, src: string) {
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/calc.ts"), src);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=s", "-c", "user.email=s@x", "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=s", "-c", "user.email=s@x", "commit", "-qm", "init"]);
}

async function changedLabels(next: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "bug-"));
  initRepo(dir, V1);
  const { svc, worker } = await setup(undefined, dir);
  writeFileSync(join(dir, "src/calc.ts"), next);
  const r2 = await svc.ingestRepository(ctx(), { repoPath: dir });
  assert.ok(r2.ok);
  const d = await svc.ask(ctx(), { question: "what changed since the last index", revision: r2.value.id, form: "SemanticDiff" } as any);
  assert.ok(d.ok);
  const changed = d.value.view.nodes.filter((n) => /-changed$/.test(n.role ?? ""));
  worker.close();
  return changed.map((n) => n.label);
}

test("renaming only a local variable is not reported as a changed symbol in the semantic diff", async () => {
  assert.deepEqual(await changedLabels(V2_RENAME), [], "no symbol's behaviour changed: only the name of a local variable did");
});

test("a real behavioural change is still reported as a changed symbol in the semantic diff", async () => {
  const labels = await changedLabels(V2_BEHAVIOUR);
  assert.ok(labels.includes("total"), `total changed its calls (${labels.join(", ")})`);
});
