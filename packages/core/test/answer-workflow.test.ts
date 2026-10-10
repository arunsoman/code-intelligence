import assert from "node:assert/strict";
import { test } from "node:test";
import { orderSteps, runWorkflow } from "../src/plugins/steps/workflow.ts";
import { planResponse } from "../src/plugins/steps/index.ts";
import { generate } from "../../../scripts/generate-plugins.ts";
import type { PlanningContext } from "../src/answer-planning.ts";
const ctx = (kinds?: Record<string, number>): PlanningContext => ({ question: "Show data schema and failure recovery", primaryCode: "S23", views: [], catalog: [], scope: "subject", subject: "Checkout", evidenceKinds: kinds, availability: new Map() });
test("workflow ordering is independent of discovery order and permits middle insertion", () => {
  const steps = [{ id: "compose", after: ["validate"], run: (c: string[]) => { c.push("compose"); } }, { id: "interpret", before: ["validate"], run: (c: string[]) => { c.push("interpret"); } }, { id: "validate", run: (c: string[]) => { c.push("validate"); } }];
  assert.deepEqual(runWorkflow(steps, []), ["interpret", "validate", "compose"]);
  assert.deepEqual(orderSteps([...steps].reverse()).map(s => s.id), orderSteps(steps).map(s => s.id));
});
test("invalid workflows fail loudly and optional stages skip", () => {
  const run = () => {};
  assert.throws(() => orderSteps([{ id: "x", run }, { id: "x", run }]), /Duplicate/);
  assert.throws(() => orderSteps([{ id: "x", after: ["missing"], run }]), /Unknown/);
  assert.throws(() => orderSteps([{ id: "x", after: ["y"], run }, { id: "y", after: ["x"], run }]), /cycle.*x.*y/);
  assert.deepEqual(runWorkflow([{ id: "skip", appliesTo: () => false, run: (c: string[]) => { c.push("bad"); } }], []), []);
});
test("planning ranks deterministically, bounds supporting tabs and preserves chosen primary", () => {
  const a = planResponse(ctx()), b = planResponse(ctx());
  assert.deepEqual(a.plan, b.plan);
  assert.equal(a.plan?.primaryCode, "S23");
  assert.equal(a.plan?.intent, "data");
  assert.equal(a.plan?.subject, "Checkout");
  assert.ok(a.plan!.supportingCodes.length <= 3);
  assert.equal(a.plan?.evidenceStatus, "not-checked");
  assert.ok(generate(true).charts > 0);
});
test("preflight distinguishes missing indexed entities from unchecked evidence", () => {
  const known = planResponse(ctx({ function: 5 }));
  assert.equal(known.availability.get("S9")?.available, false);
  assert.match(known.availability.get("S9")!.reason!, /No indexed table or column/);
  assert.ok(!known.plan!.supportingCodes.includes("S9"));
  assert.equal(planResponse(ctx()).availability.get("S9")?.available, true);
  assert.equal(planResponse(ctx({ table: 2 })).availability.get("S9")?.available, true);
  assert.equal(known.availability.get("S29")?.available, false);
});

test("concurrency intent includes an available native view rather than unrelated chart tabs", () => {
  const input = ctx({ function: 3 }); input.question = "Find concurrency races";
  input.catalog = [{ code: "V10", formId: "RaceWindow", name: "Race window", available: true }] as PlanningContext["catalog"];
  assert.ok(planResponse(input).plan!.supportingCodes.includes("V10"));
});
