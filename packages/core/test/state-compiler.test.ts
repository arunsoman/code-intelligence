import { test } from "node:test";
import assert from "node:assert/strict";
import { StateSpecSchema } from "@cie/schema";
import { compiledState } from "./state-fixture.ts";
import { erBundle } from "./er-fixture.ts";

test("state compiler preserves parallel transitions, self replay and forbidden interpretations",()=>{
 const v=compiledState();assert.ok(StateSpecSchema.safeParse(v.state).success);assert.equal(v.edges.length,4);assert.equal(new Set(v.edges.map(e=>e.id)).size,4);assert.ok(v.edges.every(e=>e.displayMode==="INFERENCE"));assert.match(v.edges[0].label ?? "",/\[balance sufficient\]/);assert.match(v.edges[2].label ?? "",/REPLAY\?/);assert.match(v.edges[3].label ?? "",/FORBIDDEN\?/);assert.equal(v.state!.states[0].initial,true);
});
test("duplicate states and stale or unknown transitions are omitted explicitly",()=>{
 const v=compiledState({states:[{id:"open",label:"Open",evidenceIds:["ev:1"]},{id:"open",label:"Duplicate",evidenceIds:["ev:1"]},{id:"stale",label:"Stale",evidenceIds:["missing"]}],transitions:[{from:"open",to:"open",trigger:"again",evidenceIds:["missing"]},{from:"open",to:"unknown",trigger:"exit",evidenceIds:["ev:1"]}]});assert.equal(v.nodes.length,1);assert.equal(v.edges.length,0);assert.ok(v.gaps.some(g=>g.includes("Duplicate")));assert.ok(v.gaps.some(g=>g.includes("no current evidence")));
});
test("a state citing an IR fact's evidence carries the function's indexed control-flow counts, entityRef and IR evidence",()=>{
 const irEv={...erBundle.evidence[0],id:"ev:ir"};
 const bundle={...erBundle,evidence:[...erBundle.evidence,irEv],entities:[...erBundle.entities,{entityId:"f:post",kind:"function",name:"post",file:"post.ts",spans:[]}],facts:[{id:"ir:post",subject:"f:post",predicate:"ir_control_flow",object:{kind:"IrControlFlow",loops:2,branches:3,returns:1,nodes:88},evidence:[irEv],resolution:"PARSED" as const}]};
 const v=compiledState({states:[{id:"open",label:"Open",isInitial:true,evidenceIds:["ev:ir"]},{id:"closed",label:"Closed",isFinal:true,evidenceIds:["ev:1"]}],transitions:[{from:"open",to:"closed",trigger:"post",evidenceIds:["ev:1"]}]},bundle);
 const open=v.nodes.find(n=>n.label==="Open")!,closed=v.nodes.find(n=>n.label==="Closed")!;
 assert.deepEqual(open.entityRefs,["f:post"]);assert.equal(open.file,"post.ts");
 assert.ok(open.notes?.some(x=>x.includes("Semantic IR")&&x.includes("3 branch(es)")),open.notes?.join("|"));
 assert.ok(open.evidenceIds.includes("ev:ir"));
 assert.equal(closed.entityRefs.length,0);assert.ok(!closed.notes); // no IR backing: no fake annotation
 assert.ok(StateSpecSchema.safeParse(v.state).success);
});
