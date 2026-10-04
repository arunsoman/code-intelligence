import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

test("a function that calls the same target at two places cites both call sites on its calls edge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bug-")); mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), `export function g(n: number) { return n + 1; }\nexport function f(n: number) {\n  const x = g(n);\n  const y = g(x);\n  return y;\n}\n`);
  const { svc, worker, revision } = await setup(undefined, dir);
  const rels = svc.store.allRelationships(revision).filter((r) => r.kind === "calls" && r.from.endsWith("#f") && r.to.endsWith("#g"));
  assert.equal(rels.length, 1, "one calls edge f → g");
  const spans = new Set(rels[0].evidence.map((e) => (e.location as any).span.startByte));
  assert.equal(spans.size, 2, `the edge cites ${spans.size} call site(s); the source has two (lines 3 and 4)`);
  worker.close();
});
