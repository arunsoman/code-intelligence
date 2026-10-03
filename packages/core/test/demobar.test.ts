import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReport, runDemoBar } from "../src/demobar.ts";

test("the six-point MVP demo bar passes end to end with zero provenance violations (offline model)", { timeout: 120_000 }, async () => {
  const r = await runDemoBar();
  const text = formatReport(r);
  assert.equal(r.steps.length, 6, text);
  for (const s of r.steps) assert.ok(s.pass, `step ${s.id} failed: ${s.detail}\n${text}`);
  assert.deepEqual(r.provenanceViolations, [], text);
  assert.ok(r.medianSynthesisMs < 10_000, text);
  assert.ok(r.passed, text);
});
