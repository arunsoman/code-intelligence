import { test } from "node:test";
import assert from "node:assert/strict";
import { compiledEr } from "../../../packages/core/test/er-fixture.ts";
import renderer from "../src/plugins/renderers/er.renderer.ts";
import { rendererForView } from "../src/plugins/renderers/index.ts";
import { basePositions } from "../src/graph.ts";
import { nodeSize } from "../src/layoutmetrics.ts";
import { arrangeElk } from "../src/arrange.ts";
import Elk from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkEngine } from "elkjs/lib/elk-api.js";
const ELK = Elk as unknown as { new(): ElkEngine };
import { measure } from "../src/layoutmetrics.ts";
test("ER renderer retains field metadata, cardinality labels and semantic identity",()=>{
 const v=compiledEr(),before=structuredClone(v),r=renderer.render(v,0,basePositions(v),new Set());
 assert.equal(rendererForView(v).id,"er");assert.equal(r.nodes.length,2);assert.equal(r.nodes[0].role,"er-entity");assert.match(r.nodes[0].node!.notes![0],/PK\?/);assert.equal(r.edges[0].sourceLabel,"1?");assert.equal(r.edges[0].targetLabel,"N?");assert.equal(r.edges[0].kind,"er-inferred");assert.deepEqual(v,before);assert.match(renderer.textAlternative(v),/FK\? → Account.id/);
});
test("ER card sizes include visible rows and an explicit overflow line",()=>{
 const v=compiledEr();const r=renderer.render(v,5,basePositions(v),new Set());const n=r.nodes[0];n.node={...n.node!,notes:Array.from({length:30},(_,i)=>`field_${i}`)};assert.deepEqual(nodeSize(n),{w:320,h:328});
});
test("adaptive ER geometry has no card overlaps or edges through cards",async()=>{
 const v=compiledEr(),r=renderer.render(v,5,basePositions(v),new Set());
 const result=await arrangeElk(r,new ELK(),{width:1000,height:650});const m=measure(result);assert.equal(m.nodeOverlaps,0);assert.equal(m.edgeThroughNode,0);assert.equal(result.edges[0].sourceLabel,"1?");
});
test("older ER views without metadata retain a compatible graph fallback",()=>{
 const v=compiledEr();delete v.er;assert.equal(renderer.render(v,5,basePositions(v),new Set()).nodes.length,2);
});
