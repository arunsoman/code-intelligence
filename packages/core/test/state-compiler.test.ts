import { test } from "node:test";
import assert from "node:assert/strict";
import { StateSpecSchema } from "@cie/schema";
import { compiledState } from "./state-fixture.ts";

test("state compiler preserves parallel transitions, self replay and forbidden interpretations",()=>{
 const v=compiledState();assert.ok(StateSpecSchema.safeParse(v.state).success);assert.equal(v.edges.length,4);assert.equal(new Set(v.edges.map(e=>e.id)).size,4);assert.ok(v.edges.every(e=>e.displayMode==="INFERENCE"));assert.match(v.edges[0].label ?? "",/\[balance sufficient\]/);assert.match(v.edges[2].label ?? "",/REPLAY\?/);assert.match(v.edges[3].label ?? "",/FORBIDDEN\?/);assert.equal(v.state!.states[0].initial,true);
});
test("duplicate states and stale or unknown transitions are omitted explicitly",()=>{
 const v=compiledState({states:[{id:"open",label:"Open",evidenceIds:["ev:1"]},{id:"open",label:"Duplicate",evidenceIds:["ev:1"]},{id:"stale",label:"Stale",evidenceIds:["missing"]}],transitions:[{from:"open",to:"open",trigger:"again",evidenceIds:["missing"]},{from:"open",to:"unknown",trigger:"exit",evidenceIds:["ev:1"]}]});assert.equal(v.nodes.length,1);assert.equal(v.edges.length,0);assert.ok(v.gaps.some(g=>g.includes("Duplicate")));assert.ok(v.gaps.some(g=>g.includes("no current evidence")));
});
