import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivitySpecSchema } from "@cie/schema";
import { compiledActivity } from "./activity-fixture.ts";
test("activity retains lane and branch interpretations and indexed relationship kinds",()=>{
 const v=compiledActivity();assert.ok(ActivitySpecSchema.safeParse(v.activity).success);assert.equal(v.groups.length,2);assert.equal(v.activity!.steps[1].shape,"decision");assert.equal(v.activity!.links[1].annotation,"sufficient");assert.ok(v.activity!.links.every(l=>l.relationshipKind==="calls"));assert.ok(v.edges.every(e=>e.displayMode==="INFERENCE"));assert.ok(v.gaps.some(g=>g.includes("parallel execution")));
});
test("activity excludes mismatched endpoints and stale supporting evidence",()=>{
 const v=compiledActivity({edges:[{from:"request",to:"save",relationshipId:"r1",evidenceIds:["ev:1"]},{from:"check",to:"save",relationshipId:"r2",evidenceIds:["missing"]}]});assert.equal(v.edges.length,0);assert.equal(v.activity!.links.length,0);assert.ok(v.gaps.length>=3);
});
test("repeated activity links keep unique identity",()=>{
 const edge={from:"request",to:"check",relationshipId:"r1",evidenceIds:["ev:1"]};const v=compiledActivity({edges:[{...edge,label:"first"},{...edge,label:"second"}]});assert.equal(new Set(v.edges.map(e=>e.id)).size,2);
});
