import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opsReadiness } from "../src/ops-readiness.ts";

const healthRoute = { kind: "route" as const, name: "GET /healthz" };
const otherRoute = { kind: "route" as const, name: "POST /payments" };
const loggingFn = { src: 'function f() { console.log("started"); }' };
const quietFn = { src: "function f() { return 1 + 1; }" };

test("all three signals true when everything is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-readiness-"));
  writeFileSync(join(dir, "RUNBOOK.md"), "# Runbook\n");
  const r = opsReadiness(dir, [healthRoute], [loggingFn]);
  assert.deepEqual(r, { runbookFound: true, healthRouteFound: true, loggingFound: true });
});

test("all three signals false when everything is absent, never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-readiness-"));
  const r = opsReadiness(dir, [otherRoute], [quietFn]);
  assert.deepEqual(r, { runbookFound: false, healthRouteFound: false, loggingFound: false });
});

test("runbookFound flips independently of the other two", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-readiness-"));
  writeFileSync(join(dir, "RUNBOOK.md"), "# Runbook\n");
  const r = opsReadiness(dir, [otherRoute], [quietFn]);
  assert.deepEqual(r, { runbookFound: true, healthRouteFound: false, loggingFound: false });
});

test("healthRouteFound flips independently of the other two", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-readiness-"));
  const r = opsReadiness(dir, [healthRoute, otherRoute], [quietFn]);
  assert.deepEqual(r, { runbookFound: false, healthRouteFound: true, loggingFound: false });
});

test("loggingFound flips independently of the other two, and ignores non-route artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-readiness-"));
  const r = opsReadiness(dir, [{ kind: "table" as const, name: "/healthz" }], [loggingFn, quietFn]);
  assert.deepEqual(r, { runbookFound: false, healthRouteFound: false, loggingFound: true });
});

test("a /ready route (not /health) is also recognised", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-readiness-"));
  const r = opsReadiness(dir, [{ kind: "route" as const, name: "GET /ready" }], [quietFn]);
  assert.equal(r.healthRouteFound, true);
});
