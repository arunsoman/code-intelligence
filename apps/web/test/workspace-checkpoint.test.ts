import assert from "node:assert/strict";
import { test } from "node:test";
import type { ViewSpec } from "@cie/schema";
import { responsePortfolio } from "../../../packages/core/src/response-portfolio.ts";
import { acceptCompletion, createWorkspace, updateTab } from "../src/response-workspace.ts";
import { encodeCheckpoint, decodeCheckpoint } from "../src/workspace-checkpoint.ts";
import { LENS_DEFAULTS } from "../src/fisheye.ts";
const view={id:"v",revision:"r1",version:1,question:"structure",formId:"GeneratedChart",level:5,params:{chartId:"S23",subject:"Checkout"},caption:"Checkout",gaps:[],nodes:[{id:"n",entityRefs:["entity:checkout"],label:"SECRET_SOURCE_LABEL",kind:"function",evidenceIds:[]}],edges:[]} as unknown as ViewSpec;
const workspace=()=>createWorkspace(responsePortfolio({views:[view],catalog:[],question:"structure"}),[{view,claims:[]}]);
test("checkpoint restores recipes and camera but regenerates source specs and interrupted work",()=>{
 let w=workspace();w=updateTab(w,w.activeId,{ui:{selection:["n"],cellSelection:[],level:2,drawMode:"graph",terrainWeights:{},canvas:{zoom:2,pan:{x:20,y:30},lens:{...LENS_DEFAULTS,radius:1}}}});
 const encoded=encodeCheckpoint(w,{ancestors:[w],truncated:false})!;
 assert.ok(!encoded.includes("SECRET_SOURCE_LABEL"));
 const restored=decodeCheckpoint(encoded,"r1")!;assert.equal(restored.navigation.ancestors.length,1);
 const active=restored.workspace.tabs.find(t=>t.id===w.activeId)!;
 assert.equal(active.view,undefined);assert.equal(active.status,"available");assert.equal(active.ui?.canvas?.zoom,2);assert.equal(active.ui?.canvas?.lens.radius,LENS_DEFAULTS.radius);
 assert.deepEqual(active.ui?.selectionRefs,["entity:checkout"]);
 const nextView={...view,id:"regenerated",nodes:[{...view.nodes[0]!,id:"fresh-node"}]};
 const accepted=acceptCompletion(restored.workspace,{responseId:restored.workspace.manifest.responseId,revision:"r1",tabId:active.id,attempt:active.attempt},{view:nextView,claims:[]});
 assert.deepEqual(accepted.tabs.find(t=>t.id===active.id)?.ui?.selection,["fresh-node"]);
 assert.equal(decodeCheckpoint(encoded,"r2"),undefined);
});
test("checkpoint rejects corrupt, oversized and mismatched identities",()=>{
 assert.equal(decodeCheckpoint("{","r1"),undefined);assert.equal(decodeCheckpoint(" ".repeat(1_000_001),"r1"),undefined);
 const saved=JSON.parse(encodeCheckpoint(workspace(),{ancestors:[],truncated:false})!);saved.workspace.activeId="unknown";assert.equal(decodeCheckpoint(JSON.stringify(saved),"r1"),undefined);
});
