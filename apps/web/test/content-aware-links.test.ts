import {test} from "node:test";
import assert from "node:assert/strict";
import {compiledActivity} from "../../../packages/core/test/activity-fixture.ts";
import {render,basePositions} from "../src/graph.ts";
import {usesElk,arrangeElk,classCardGrid} from "../src/arrange.ts";
import Elk from "elkjs/lib/elk.bundled.js";
import type {ELK as ElkEngine} from "elkjs/lib/elk-api.js";
import {measure} from "../src/layoutmetrics.ts";
const ELK=Elk as unknown as {new():ElkEngine};
test("shared graph retains actual self relationships and evidence identity",()=>{const v=compiledActivity(),r=render(v,5,basePositions(v));assert.equal(r.edges.length,v.edges.length);const loop=r.edges.find(e=>e.from===e.to)!;assert.deepEqual(loop.edgeIds,[v.edges[3].id]);assert.deepEqual(loop.evidenceIds,v.edges[3].evidenceIds);});
test("additional flow notations choose topology layout while semantic lanes remain intact",()=>{const v=compiledActivity(),r=render({...v,groups:[]},5,basePositions(v));for(const code of ["S7","S12","S18","S19"])assert.equal(usesElk(r,"GeneratedChart",code),true);assert.equal(usesElk(render(v,5,basePositions(v)),"GeneratedChart","S7"),false);assert.equal(usesElk(r,"GeneratedChart","S28"),false);});
test("wide and tall viewports choose different topology orientations without losing links",async()=>{const v=compiledActivity(),r=render({...v,groups:[]},5,basePositions(v)),engine=new ELK();const wide=await arrangeElk(r,engine,{width:1600,height:350}),tall=await arrangeElk(r,engine,{width:350,height:1600});const aspect=(x:typeof r)=>{const p=x.nodes.map(n=>n.pos);return (Math.max(...p.map(n=>n.x))-Math.min(...p.map(n=>n.x)))/(Math.max(...p.map(n=>n.y))-Math.min(...p.map(n=>n.y)));};assert.ok(aspect(wide)>aspect(tall));for(const x of [wide,tall]){assert.equal(measure(x).nodeOverlaps,0);assert.deepEqual(x.edges.map(e=>e.id),r.edges.map(e=>e.id));}});

test("unconnected class cards form a viewport-aware grid without overriding connected topology",()=>{
 const v=compiledActivity(),r=render({...v,groups:[],edges:[]},5,basePositions(v));r.nodes=r.nodes.map(n=>({...n,role:"uml-class"}));const wide=classCardGrid(r,{width:1500,height:350})!,tall=classCardGrid(r,{width:350,height:1500})!;assert.equal(measure(wide).nodeOverlaps,0);assert.equal(measure(tall).nodeOverlaps,0);assert.ok(new Set(wide.nodes.map(n=>n.pos.x)).size>new Set(tall.nodes.map(n=>n.pos.x)).size);r.edges=[{id:"link",from:r.nodes[0].id,to:r.nodes[1].id,displayMode:"FACT",label:"inherits",count:1,edgeIds:["link"],evidenceIds:[],stale:false}];assert.equal(classCardGrid(r,{width:1500,height:350}),undefined);
});
