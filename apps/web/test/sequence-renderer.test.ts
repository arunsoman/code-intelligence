import { test } from "node:test";
import assert from "node:assert/strict";
import { compiledSequence } from "../../../packages/core/test/sequence-fixture.ts";
import renderer from "../src/plugins/renderers/sequence.renderer.ts";
import { rendererForView } from "../src/plugins/renderers/index.ts";
import { basePositions } from "../src/graph.ts";

test("sequence renderer has distinct participant columns, ordered rows and self messages", () => {
  const view=compiledSequence(),before=structuredClone(view);
  const r=renderer.render(view,1,basePositions(view),new Set());
  assert.equal(rendererForView(view).id,"sequence");
  assert.deepEqual(r.sequence!.messages.map(m=>m.order),[1,2,3,4]);
  assert.equal(r.edges.length,4,"repeated participant interactions stay distinct");
  assert.ok(r.sequence!.participants[0].x < r.sequence!.participants[1].x);
  assert.ok(r.sequence!.messages.every((m,i,a)=>i===0 || m.y>a[i-1].y));
  const self=r.sequence!.messages.at(-1)!;assert.equal(self.x1,self.x2);
  assert.deepEqual(view,before,"rendering preserves semantics and evidence");
  assert.match(renderer.textAlternative(view),/1\. Caller → Service: Validate/);
});
test("removed participants never leave orphan sequence messages", () => {
  const view=compiledSequence();view.nodes=view.nodes.slice(0,1);
  const r=renderer.render(view,5,basePositions(view),new Set());
  assert.equal(r.sequence?.participants.length,1);assert.equal(r.sequence?.messages.length,0);
});
test("old saved sequence views have an explicit compatible graph fallback", () => {
  const view=compiledSequence();delete view.sequence;
  assert.equal(renderer.render(view,5,basePositions(view),new Set()).sequence,undefined);
});

test("long labels reserve header and message space, including a last-participant self call", async () => {
  const { wrapSequenceText }=await import("../src/sequence-layout.ts");
  assert.equal(wrapSequenceText("x".repeat(100)).join("").length,100);
  const view=compiledSequence();view.nodes[1].label="Very long participant name ".repeat(7);view.edges.at(-1)!.label="Long self interaction ".repeat(8);
  const r=renderer.render(view,5,basePositions(view),new Set()),scene=r.sequence!;
  assert.ok(scene.headerHeight>52);
  assert.ok(scene.messages[0].y>scene.headerHeight+50);
  assert.ok(scene.width>=scene.messages.at(-1)!.x1+350);
});
