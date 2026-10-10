import { test } from "node:test";
import assert from "node:assert/strict";
import { SequenceSpecSchema } from "@cie/schema";
import { compiledSequence, sequenceFixture } from "./sequence-fixture.ts";
test("sequence compiler retains repeated messages, kind, order, fragments and current evidence", () => {
  const view = compiledSequence();
  assert.equal(view.nodes.length,2);
  assert.equal(view.edges.length,4);
  assert.deepEqual(view.sequence?.messages.map(m=>m.order),[2,3,1,4]);
  assert.equal(view.sequence?.fragments[0].kind,"par");
  assert.ok(view.edges.every(e=>e.displayMode === "INFERENCE" && e.evidenceIds[0] === "ev:1"));
  assert.match(view.gaps.at(-1)!,/does not prove runtime/);
  assert.ok(SequenceSpecSchema.safeParse(view.sequence).success);
});
test("sequence compiler drops unknown endpoints and stale evidence without inventing interactions", () => {
  const view = compiledSequence({ messages: [{ from:"caller",to:"missing",order:1,label:"Unknown",kind:"sync",evidenceIds:["ev:1"] },{ from:"caller",to:"service",order:2,label:"Stale",kind:"sync",evidenceIds:["ev:stale"] }] });
  assert.equal(view.edges.length,0); assert.equal(view.sequence?.messages.length,0);
  assert.ok(view.gaps.some(g=>g.includes("endpoints or current evidence")));
});
test("duplicate sequence orders report uncertainty", () => {
  const plan = sequenceFixture(); if (plan.chartId !== "S28") throw new Error();
  const view = compiledSequence({ messages: plan.messages.map(m=>({...m,order:1})) });
  assert.equal(view.edges.length,4);assert.ok(view.gaps.some(g=>g.includes("relative order is ambiguous")));
});
