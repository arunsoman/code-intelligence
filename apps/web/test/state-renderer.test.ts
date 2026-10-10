import { test } from "node:test";
import assert from "node:assert/strict";
import { compiledState } from "../../../packages/core/test/state-fixture.ts";
import renderer from "../src/plugins/renderers/state.renderer.ts";
import { rendererForView } from "../src/plugins/renderers/index.ts";
import { basePositions } from "../src/graph.ts";
import { nodeSize } from "../src/layoutmetrics.ts";
import { arrangeElk } from "../src/arrange.ts";
import Elk from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkEngine } from "elkjs/lib/elk-api.js";
import { measure } from "../src/layoutmetrics.ts";
const ELK=Elk as unknown as {new():ElkEngine};
test("state renderer retains transition identities and exposes semantic alternatives",()=>{
 const v=compiledState(),before=structuredClone(v),r=renderer.render(v,0,basePositions(v),new Set());assert.equal(rendererForView(v).id,"state");assert.equal(r.nodes[0].role,"lifecycle-initial");assert.equal(r.nodes[1].role,"lifecycle-final");assert.equal(r.edges[2].kind,"replay-transition");assert.equal(r.edges[3].kind,"forbidden-transition");assert.deepEqual(nodeSize(r.nodes[0]),{w:220,h:72});assert.deepEqual(v,before);assert.match(renderer.textAlternative(v),/absent path is unknown/);assert.match(renderer.textAlternative(v),/FORBIDDEN\?/);
});
test("state adaptive layout preserves parallel and self transitions without card overlaps",async()=>{
 const v=compiledState(),r=renderer.render(v,5,basePositions(v),new Set());const result=await arrangeElk(r,new ELK(),{width:1000,height:650});assert.equal(measure(result).nodeOverlaps,0);assert.deepEqual(result.edges.map(e=>e.id),r.edges.map(e=>e.id));assert.equal(result.edges.filter(e=>e.from===e.to).length,1);
});
test("legacy state view falls back safely",()=>{const v=compiledState();delete v.state;assert.equal(renderer.render(v,5,basePositions(v),new Set()).nodes.length,2);});
