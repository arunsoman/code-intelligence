import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const run = JSON.parse(spawnSync(process.execPath, [join(here, "build-deliver-run.ts")], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).stdout || "{}") as { html?: Record<string, string>; findings?: Record<string, unknown[]>; error?: string };
const text = (h: string) => h.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

test("PF-073/074 the Validate stage renders baseline beside candidate, origins, stale and weakened-test warnings, and no stronger word than the server gave", () => {
  assert.equal(run.error, undefined, run.error); const t = text(run.html!.validate!);
  assert.match(t, /REVIEW ONLY — VALIDATION INCOMPLETE/); assert.doesNotMatch(t, /Verified within/);
  assert.match(t, /backend: baseline preexisting failure · candidate fail/); assert.match(t, /Stale: the candidate is stale/); assert.match(t, /pass \(expectation not reviewed\)/);
  assert.match(t, /added by this change/); assert.match(t, /existing \(not in a changed file\)/); assert.match(t, /3 more not listed/);
  assert.match(t, /Do not edit, skip or loosen a test/); assert.match(t, /A test was weakened/); assert.match(t, /Run validation/);
  assert.deepEqual(run.findings!.validate, []);
});

test("PF-077/078/079 the Deliver stage gives each disabled action its reason, keeps effectful actions separate, and never says verified for a review-only candidate", () => {
  const blocked = text(run.html!.deliverBlocked!), ok = text(run.html!.deliverOk!);
  assert.match(blocked, /BLOCKED — a mandatory check failed/); assert.match(blocked, /a blocked candidate is not exported/); assert.match(blocked, /export a patch first/); assert.match(blocked, /BUILD_PREVIEW mode/);
  assert.match(ok, /REVIEW ONLY — VALIDATION INCOMPLETE/); assert.doesNotMatch(ok, /verified within/i); assert.match(ok, /Export patch/); assert.match(ok, /Create draft PR/); assert.match(ok, /never merges or approves/);
  assert.match(run.html!.deliverBlocked!, /disabled=""[^>]*aria-describedby="why-export"|aria-describedby="why-export"[^>]*disabled=""/);
  assert.deepEqual(run.findings!.deliverBlocked, []); assert.deepEqual(run.findings!.deliverOk, []);
});
