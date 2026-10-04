import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { ctx, setup } from "./helpers.ts";

const REPO = resolve(import.meta.dirname, "../../../fixtures/journey-flow");
const noteOf = (v: any, label: string) => (v.nodes.find((n: any) => n.label === label)?.notes ?? []).join(" ");
const badge = (v: any, label: string) => v.nodes.find((n: any) => n.label === label)?.badge;

test("V4 journey marks conditions, else branches, loops and retry loops on the steps they affect, and says what it still does not know", async () => {
  const { svc, worker, revision } = await setup(undefined, REPO);
  const r = await svc.ask(ctx(), { question: "walk me through checkout step by step", revision });
  assert.ok(r.ok);
  const v = r.value.view;
  assert.equal(v.formId, "TransactionJourney");
  assert.match(noteOf(v, "shipFast"), /Runs only if cart\.express/);
  assert.match(noteOf(v, "shipSlow"), /Runs only in the other branch: not \(cart\.express\)/);
  assert.equal(badge(v, "shipFast"), "conditional");
  assert.match(noteOf(v, "reserve"), /Runs once per element: each of items, so it can run many times/);
  assert.equal(badge(v, "reserve"), "loop");
  assert.match(noteOf(v, "charge"), /retry or error-handling loop/);
  assert.equal(badge(v, "charge"), "retry");
  assert.match(noteOf(v, "backoff"), /retry or error-handling loop/);
  assert.equal(badge(v, "validate"), undefined, "straight-line steps carry no mark");
  assert.equal(badge(v, "notify"), undefined, "a step after the loops is not inside them");
  assert.ok(v.gaps.some((g: string) => /Conditions, loops and retry loops are read from the source's structure/.test(g) && /whether a branch is taken, or how often a loop runs, is not known/.test(g)));
  worker.close();
});

test("the same marks appear for Python code: conditions, loops and retry loops", async () => {
  const { svc, worker, revision } = await setup(undefined, REPO);
  const r = await svc.ask(ctx(), { question: "walk me through place_order step by step", revision });
  assert.ok(r.ok);
  const v = r.value.view;
  assert.equal(v.formId, "TransactionJourney");
  assert.match(noteOf(v, "ship_fast"), /Runs only if cart\.express/);
  assert.match(noteOf(v, "reserve"), /once per element: each of items/);
  assert.equal(badge(v, "charge"), "retry");
  assert.equal(badge(v, "notify"), undefined);
  worker.close();
});
