import assert from "node:assert/strict";
import { test } from "node:test";
import { scanFunction } from "../src/defect/source.ts";

test("scanning a long function takes time proportional to its length, not its length squared", () => {
  const body = (n: number) => `function big(lock: Mutex) {\n` + Array.from({ length: n }, (_, i) => `  helper${i % 7}(${i});\n`).join("") + `}\n`;
  const time = (n: number) => { const src = body(n); const t = performance.now(); const s = scanFunction(src, "ts"); assert.ok(s.calls.length >= n); return performance.now() - t; };
  time(500); // warm up
  const small = time(4000), large = time(16000);   // four times the code
  console.log(`  4,000 lines: ${small.toFixed(0)} ms, 16,000 lines: ${large.toFixed(0)} ms (x${(large / small).toFixed(1)})`);
  assert.ok(large < small * 8, `four times the code took ${(large / small).toFixed(1)} times as long (expected about 4)`);
});
