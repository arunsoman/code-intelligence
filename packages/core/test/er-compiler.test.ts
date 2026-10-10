import { test } from "node:test";
import assert from "node:assert/strict";
import { ErSpecSchema } from "@cie/schema";
import { compiledEr, erBundle } from "./er-fixture.ts";
test("ER metadata keeps only current-evidence columns and attaches source identities",()=>{
 const v=compiledEr();assert.ok(ErSpecSchema.safeParse(v.er).success);assert.equal(v.er!.tables[1].columns.length,1);assert.deepEqual(v.nodes[0].entityRefs,["t:a"]);assert.equal(v.edges[0].displayMode,"INFERENCE");assert.match(v.edges[0].label!,/1:N\?/);assert.ok(v.gaps.some(g=>g.includes("Entry.stale")));
});
test("inferred relations require rationale and repeated endpoints keep distinct edge identities",()=>{
 const rel={fromTable:"entry",toTable:"account",cardinality:"1:N",isInferred:true,evidenceIds:["ev:1"]};
 assert.equal(compiledEr({relationships:[rel]}).edges.length,0);
 const v=compiledEr({relationships:[{...rel,reason:"A"},{...rel,reason:"B"}]});assert.equal(v.edges.length,2);assert.notEqual(v.edges[0].id,v.edges[1].id);
});
test("declared relation styling requires indexed endpoint and evidence agreement",()=>{
 const rel={fromTable:"entry",toTable:"account",cardinality:"1:1",isInferred:false,evidenceIds:["ev:1"]};
 assert.equal(compiledEr({relationships:[rel]}).edges[0].displayMode,"INFERENCE");
 const bundle={...erBundle,relationships:[{id:"fk",from:"t:e",to:"t:a",kind:"foreign_key",evidence:[erBundle.evidence[0]],resolution:"STATIC_RESOLVED" as const}]};
 const v=compiledEr({relationships:[rel]},bundle);assert.equal(v.edges[0].displayMode,"FACT");assert.equal(v.er!.relationships[0].cardinalityBasis,"plan-inferred");
});
