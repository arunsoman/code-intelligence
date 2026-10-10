import { test } from "node:test";
import assert from "node:assert/strict";
import { compiledActivity } from "../../../packages/core/test/activity-fixture.ts";
import renderer from "../src/plugins/renderers/activity.renderer.ts";
import { rendererForView } from "../src/plugins/renderers/index.ts";
import { basePositions } from "../src/graph.ts";
import { arrange, arrangeElk, usesElk } from "../src/arrange.ts";
import { measure,nodeSize } from "../src/layoutmetrics.ts";
test("activity renderer preserves lanes, self calls and source identities",()=>{
 const v=compiledActivity(),before=structuredClone(v),r=renderer.render(v,0,basePositions(v),new Set());assert.equal(rendererForView(v).id,"activity");assert.equal(r.nodes[1].role,"activity-decision");assert.equal(r.edges.length,4);assert.equal(r.edges[3].from,r.edges[3].to);assert.match(r.edges[1].label,/sufficient · calls · flow\?/);assert.deepEqual(nodeSize(r.nodes[1]),{w:240,h:120});assert.deepEqual(v,before);assert.match(renderer.textAlternative(v),/Fan-out does not prove parallel/);
});
test("activity layout separates cards and keeps distinct lane bands",()=>{
 const v=compiledActivity(),r=renderer.render(v,5,basePositions(v),new Set()),result=arrange(r,v,5);assert.equal(usesElk(r,v.formId,"S2"),false);assert.equal(measure(result).nodeOverlaps,0);const api=result.nodes.filter(n=>n.node?.lane==="API"),storage=result.nodes.find(n=>n.node?.lane==="Storage")!;assert.ok(api.every(n=>Math.abs(n.pos.y-storage.pos.y)>120));assert.deepEqual(result.edges.map(e=>e.id),r.edges.map(e=>e.id));
});
test("legacy activity view retains graph fallback",()=>{const v=compiledActivity();delete v.activity;assert.equal(renderer.render(v,5,basePositions(v),new Set()).nodes.length,4);});

import Elk from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkEngine } from "elkjs/lib/elk-api.js";
const ELK=Elk as unknown as {new():ElkEngine};
test("activity without lanes uses adaptive topology without losing self links",async()=>{
 const v=compiledActivity();v.groups=[];v.activity!.steps=v.activity!.steps.map(({lane,...s})=>s);v.nodes=v.nodes.map(({lane,...n})=>n);
 const r=renderer.render(v,5,basePositions(v),new Set());assert.equal(usesElk(r,v.formId,"S2"),true);const result=await arrangeElk(r,new ELK(),{width:1000,height:650});assert.equal(measure(result).nodeOverlaps,0);assert.deepEqual(result.edges.map(e=>e.id),r.edges.map(e=>e.id));assert.equal(result.edges.filter(e=>e.from===e.to).length,1);
});
