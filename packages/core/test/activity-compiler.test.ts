import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivitySpecSchema } from "@cie/schema";
import { compiledActivity, activityBundle } from "./activity-fixture.ts";
import { erBundle } from "./er-fixture.ts";
test("activity retains lane and branch interpretations and indexed relationship kinds",()=>{
 const v=compiledActivity();assert.ok(ActivitySpecSchema.safeParse(v.activity).success);assert.equal(v.groups.length,2);assert.equal(v.activity!.steps[1].shape,"decision");assert.equal(v.activity!.links[1].annotation,"sufficient");assert.ok(v.activity!.links.every(l=>l.relationshipKind==="calls"));assert.ok(v.edges.every(e=>e.displayMode==="INFERENCE"));assert.ok(v.gaps.some(g=>g.includes("parallel execution")));
});
test("activity excludes mismatched endpoints and stale supporting evidence",()=>{
 const v=compiledActivity({edges:[{from:"request",to:"save",relationshipId:"r1",evidenceIds:["ev:1"]},{from:"check",to:"save",relationshipId:"r2",evidenceIds:["missing"]}]});assert.equal(v.edges.length,0);assert.equal(v.activity!.links.length,0);assert.ok(v.gaps.length>=3);
});
test("repeated activity links keep unique identity",()=>{
 const edge={from:"request",to:"check",relationshipId:"r1",evidenceIds:["ev:1"]};const v=compiledActivity({edges:[{...edge,label:"first"},{...edge,label:"second"}]});assert.equal(new Set(v.edges.map(e=>e.id)).size,2);
});
test("semantic IR facts ground a modeled process step as a decision site, with the IR fact's evidence and counts on the node",()=>{
 const ev=erBundle.evidence[0];const irEv={...ev,id:"ev:ir"};
 const bundle={...activityBundle,evidence:[...activityBundle.evidence,irEv],facts:[{id:"ir:save",subject:"save",predicate:"ir_control_flow",object:{kind:"IrControlFlow",loops:1,branches:2,returns:1,nodes:57},evidence:[irEv],resolution:"PARSED" as const}]};
 const v=compiledActivity({},bundle);const saveNode=v.nodes.find(n=>n.entityRefs[0]==="save")!;
 const step=v.activity!.steps.find(s=>s.nodeId===saveNode.id)!;
 assert.equal(step.shape,"decision"); // plan said process; the indexed IR says the body branches
 assert.ok(saveNode.notes?.some(x=>x.includes("Semantic IR")&&x.includes("2 branch(es)")),saveNode.notes?.join("|"));
 assert.ok(saveNode.evidenceIds.includes("ev:ir"));
 // untouched: a step with no IR fact keeps the plan's own shape and evidence
 const failNode=v.nodes.find(n=>n.entityRefs[0]==="fail")!;
 assert.equal(v.activity!.steps.find(s=>s.nodeId===failNode.id)!.shape,"process");
 assert.ok(!failNode.notes);
});
