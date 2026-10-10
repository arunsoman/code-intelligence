import { test } from "node:test";
import assert from "node:assert/strict";
import { type ViewSpec, ResponseManifestSchema } from "@cie/schema";
import { responsePortfolio } from "../../../packages/core/src/response-portfolio.ts";
import { compiledActivity } from "../../../packages/core/test/activity-fixture.ts";
import { explorationChoices, explorationTarget, explorationQuestion, explorationShortcut } from "../src/exploration-choices.ts";
const manifest=()=>responsePortfolio({views:[compiledActivity()],catalog:[],question:"Flow",evidenceKinds:{method:4,table:0}});
test("context priorities vary across code, data, component and flow targets",()=>{
 assert.equal(explorationChoices("method")[0].code,"S21");assert.equal(explorationChoices("table")[0].code,"S9");assert.equal(explorationChoices("class")[0].code,"S16");assert.equal(explorationChoices("component")[0].code,"S23");assert.equal(explorationChoices("flow")[0].code,"S2");
});
test("revision preflight disables absent evidence independently of parent result status",()=>{
 const m=manifest();assert.ok(ResponseManifestSchema.safeParse(m).success);const er=m.views.find(v=>v.code==="S9")!;er.status="ready";const choices=explorationChoices("method",m,"rev");assert.equal(choices.find(c=>c.code==="S9")!.disabled,true);assert.equal(choices.find(c=>c.code==="S21")!.availability,"requestable");assert.match(choices.find(c=>c.code==="S21")!.reason,/Selected-subject evidence/);
});
test("foreign revision and legacy parent failures do not disable a new subject",()=>{
 const m=manifest();delete m.explorationAvailability;m.views.find(v=>v.code==="S21")!.status="unavailable";assert.equal(explorationChoices("method",m,"rev").find(c=>c.code==="S21")!.availability,"unchecked");assert.equal(explorationChoices("method",manifest(),"other").find(c=>c.code==="S9")!.disabled,false);assert.equal(explorationChoices("method").find(c=>c.code==="S29")!.disabled,true);assert.equal(explorationChoices("method").find(c=>c.code==="V10")!.disabled,true);
});
test("source-backed node, selected group and relationship endpoints bind exact entity seeds",()=>{
 const v=compiledActivity();const one=explorationTarget(v,[v.nodes[0].id])!;assert.equal(one.source,"element");assert.deepEqual(one.entityRefs,["request"]);
 const ids=[v.nodes[1].id,v.nodes[2].id],flow=explorationTarget(v,ids,{viewId:v.id,nodeIds:ids,label:"check → save"})!;assert.equal(flow.kind,"flow");assert.deepEqual(flow.entityRefs,["check","save"]);assert.equal(explorationTarget(v,ids)?.source,"selection");assert.equal(explorationTarget(v,ids,{viewId:"old",nodeIds:ids,label:"old"})?.source,"selection");
 const c=explorationChoices(flow.kind).find(c=>c.code==="S28")!;assert.match(explorationQuestion(c,flow),/check → save/);assert.match(explorationQuestion(c,flow),/order/);assert.equal(explorationShortcut(`explore ${c.label}`,explorationChoices(flow.kind))?.code,c.code);
});
test("unbound targets are unavailable and partial or oversized scopes disclose limits",()=>{
 const v=compiledActivity();v.nodes[0].entityRefs=[];assert.equal(explorationTarget(v,[v.nodes[0].id]),undefined);assert.match(explorationTarget(v,[v.nodes[0].id,v.nodes[1].id])!.limitation!,/unbound/);
 v.nodes[1].entityRefs=Array.from({length:45},(_,i)=>`e:${i}`);const target=explorationTarget(v,[v.nodes[1].id])!;assert.equal(target.entityRefs.length,40);assert.match(target.limitation!,/first 40/);
});
test("full choice catalog has unique identities and exposes every concern",()=>{
 const choices=explorationChoices("component",manifest());assert.equal(new Set(choices.map(c=>c.code)).size,choices.length);for(const concern of ["Structure","Behavior","Data","State and rules","Reliability","Concurrency","Quality"])assert.ok(choices.some(c=>c.concern===concern));
});
