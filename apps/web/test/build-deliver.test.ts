import assert from "node:assert/strict";
import { test } from "node:test";
import type { Dashboard, DeliverView } from "../../../packages/core/src/feature/dashboard.ts";
import { actionState, bannerTone, countByStatus, exportFileName, filterTests, reasonList, statusText, statusTone, targetLine, validDestination, type TestRow } from "../src/build/deliver-view.ts";

const rows: TestRow[] = [
  { name: "accepts current tenant", target: "backend", checkId: "tests:.", status: "PASS", origin: "ADDED" }, { name: "rejects other tenant", target: "backend", checkId: "tests:.", status: "FAIL", origin: "ADDED" },
  { name: "legacy export", target: "backend", checkId: "tests:.", status: "SKIP", origin: "NOT_IN_CHANGED_FILES" }, { name: "csv header", target: "frontend", checkId: "tests:ui", status: "STALE", origin: "IN_MODIFIED_FILE" },
];

test("PF-073/AT-74-77 only a real PASS looks like a pass; skips, stale and unreviewed oracles are never green", () => {
  assert.deepEqual(["PASS", "FAIL", "SKIP", "STALE", "NOT_RUN", "INCOMPLETE", "PASS_UNREVIEWED_ORACLE", "FLAKY", "anything"].map(statusTone), ["ok", "bad", "warn", "warn", "warn", "warn", "warn", "warn", "warn"]);
  assert.equal(statusText("PASS_UNREVIEWED_ORACLE"), "pass (expectation not reviewed)"); assert.equal(statusText("NOT_RUN"), "not run");
  assert.deepEqual((["VERIFIED_WITHIN_SCOPE", "REVIEW_ONLY_INCOMPLETE", "BLOCKED", "NO_CANDIDATE"] as const).map(bannerTone), ["ok", "warn", "bad", "warn"]);
});

test("PF-073 the test list filters by status, origin and name and summarises honestly", () => {
  assert.deepEqual(filterTests(rows, { status: "", origin: "", text: "" }).length, 4);
  assert.deepEqual(filterTests(rows, { status: "FAIL", origin: "", text: "" }).map((r) => r.name), ["rejects other tenant"]);
  assert.deepEqual(filterTests(rows, { status: "", origin: "ADDED", text: "ACCEPTS" }).map((r) => r.name), ["accepts current tenant"]);
  assert.equal(countByStatus(rows), "fail: 1 · pass: 1 · skip: 1 · stale: 1"); assert.equal(countByStatus([]), "No test outcomes recorded.");
});

test("PF-073 a target line shows the baseline beside the candidate, so a pre-existing failure is not read as a regression", () => {
  const t: Dashboard["targets"][number] = { target: "frontend", baseline: "PREEXISTING_FAILURE", candidate: "FAIL", checkIds: ["frontend"] };
  assert.equal(targetLine(t), "frontend: baseline preexisting failure · candidate fail");
});

test("PF-077/078 export names, destination syntax and the reason a disabled action gives", () => {
  assert.equal(exportFileName({ id: "export:abcdef0123456789", format: "GIT_PATCH" }), "feature-abcdef01.patch"); assert.equal(exportFileName({ id: "export:abcdef0123", format: "BUNDLE" }), "feature-abcdef01.json"); assert.equal(exportFileName({ id: "export:abcdef0123", format: "UNIFIED_DIFF" }), "feature-abcdef01.diff");
  assert.ok(validDestination("acme/payments:main")); for (const bad of ["acme/payments", "acme/payments:", "a/b:../x", "a b/c:main", ""]) assert.ok(!validDestination(bad), bad);
  const v = { actions: [{ action: "Export patch", enabled: false, reason: "a blocked candidate is not exported" }] } as unknown as DeliverView;
  assert.equal(actionState(v, "Export patch").reason, "a blocked candidate is not exported"); assert.equal(actionState(v, "Export patch").enabled, false); assert.equal(actionState(v, "Create draft PR").enabled, false); assert.ok(actionState(v, "Create draft PR").reason);
  assert.deepEqual(reasonList(Array.from({ length: 11 }, (_, i) => `r${i}`)), { shown: ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"], more: 3 }); assert.deepEqual(reasonList(["a"]), { shown: ["a"], more: 0 });
});
