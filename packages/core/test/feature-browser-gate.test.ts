import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const report = JSON.parse(readFileSync(join(ROOT, "docs/prompt-to-feature/browser/report.json"), "utf8"));
const script = readFileSync(join(ROOT, "scripts/browser-gate.ts"), "utf8");

test("#94C the committed browser gate report names a pinned image, three viewports, axe results and a pass for every run", () => {
  assert.match(report.image.reference, /^mcr\.microsoft\.com\/playwright@sha256:[0-9a-f]{64}$/, "the image is pinned by digest");
  assert.ok(script.includes(report.image.reference), "the report names the image the script runs");
  assert.deepEqual(report.viewports, ["1366x768", "1920x1080", "1280x720"]);
  assert.equal(report.verdict, "PASS"); assert.equal(report.failed, 0);
  assert.equal(report.results.length, 9, "3 specs x 3 viewports");
  for (const vp of report.viewports) assert.ok(report.results.some((r: { project: string; status: string }) => r.project === vp && r.status === "passed"), `a run passed at ${vp}`);
  assert.ok(report.results.filter((r: { axe?: unknown[] }) => r.axe).every((r: { axe: { seriousOrCritical: unknown[] }[] }) => r.axe.every((a) => a.seriousOrCritical.length === 0)), "axe found nothing serious or critical");
  assert.ok(report.browser.every((b: string) => /^chromium /.test(b)) && report.browser.length >= 1, "the browser identity is recorded");
  assert.equal(report.traces.length, 9); assert.ok(report.traces.every((t: { sha256: string }) => /^[0-9a-f]{64}$/.test(t.sha256)), "every trace is hashed");
  assert.ok(report.notCovered.length >= 3, "what the gate does not cover is stated");
});
