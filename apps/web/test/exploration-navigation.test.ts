import { test } from "node:test";
import assert from "node:assert/strict";
import { compiledActivity } from "../../../packages/core/test/activity-fixture.ts";
import { responsePortfolio } from "../../../packages/core/src/response-portfolio.ts";
import { createWorkspace, updateTab, activateTab, perspectiveState, acceptCompletion, type TabState, type ResponseWorkspace } from "../src/response-workspace.ts";
import { emptyNavigation, extendNavigation, jumpNavigation, navigationCrumbs, NAVIGATION_LIMIT } from "../src/exploration-navigation.ts";
function workspace(label:string,revision="rev"): ResponseWorkspace {
 const v={...compiledActivity(),id:`v:${label}`,revision};const m=responsePortfolio({views:[v],catalog:[],question:label,context:{scope:"subject",subject:label,seeds:["check"]}});return {...createWorkspace(m,[{view:v,claims:[]}]),navigationLabel:label};
}
const ui:TabState={selection:["n:check"],cellSelection:["cell"],level:3,drawMode:"graph",terrainWeights:{risk:0.8},canvas:{zoom:1.8,pan:{x:72,y:-31},lens:{enabled:true,magnification:2.2,radius:186,falloff:1/.88,easing:true,rings:true,pinned:false}}};
test("explicit exploration creates a breadcrumb branch and jumps restore exact parent state",()=>{
 let root=workspace("Repository"),child=workspace("Payment"),leaf=workspace("check");root=updateTab(root,root.activeId,{ui});let h=extendNavigation(emptyNavigation(),root,child,true);h=extendNavigation(h,child,leaf,true);assert.deepEqual(navigationCrumbs(h,leaf).map(c=>c.label),["Repository","Payment","check"]);const jump=jumpNavigation(h,0)!;assert.equal(jump.workspace.activeId,root.activeId);assert.deepEqual(jump.workspace.tabs.find(t=>t.id===root.activeId)!.ui,ui);assert.equal(jump.history.ancestors.length,0);assert.equal(h.ancestors.length,2);
});
test("new questions and revision changes start fresh navigation roots",()=>{
 const root=workspace("root"),child=workspace("child"),h=extendNavigation(emptyNavigation(),root,child,true);assert.equal(extendNavigation(h,child,workspace("new question"),false).ancestors.length,0);assert.equal(extendNavigation(h,child,workspace("new revision","r2"),true).ancestors.length,0);assert.equal(extendNavigation(h,null,child,true).ancestors.length,0);
});
test("perspective switches preserve the scope label without adding ancestors",()=>{
 const w=workspace("Payment"),tab=w.tabs.find(t=>t.code==="S21")!;const switched=activateTab(w,tab.id);const crumbs=navigationCrumbs(emptyNavigation(),switched);assert.equal(crumbs.length,1);assert.equal(crumbs[0].label,"Payment");assert.equal(crumbs[0].perspective,"Code calls");
});
test("restored pending views become retryable and reject old completion attempts",()=>{
 let root=workspace("root");const tab=root.tabs.find(t=>t.code==="S21")!;root=updateTab(root,tab.id,{status:"generating",attempt:2});const h=extendNavigation(emptyNavigation(),root,workspace("child"),true);const restored=jumpNavigation(h,0)!.workspace;assert.equal(restored.tabs.find(t=>t.id===tab.id)!.status,"available");assert.equal(restored.tabs.find(t=>t.id===tab.id)!.attempt,3);const token={responseId:restored.manifest.responseId,revision:"rev",tabId:tab.id,attempt:2};assert.equal(acceptCompletion(restored,token,{view:compiledActivity(),claims:[]}),restored);
});
test("history retention is bounded and discloses omitted ancestors",()=>{
 let h=emptyNavigation(),parent=workspace("0");for(let i=1;i<=NAVIGATION_LIMIT+5;i++){const next=workspace(String(i));h=extendNavigation(h,parent,next,true);parent=next;}assert.equal(h.ancestors.length,NAVIGATION_LIMIT);assert.equal(h.truncated,true);assert.equal(navigationCrumbs(h,parent)[0].label,"5");assert.equal(jumpNavigation(h,0)!.history.truncated,true);
});
test("invalid breadcrumb indices are no-ops",()=>{
 const h=extendNavigation(emptyNavigation(),workspace("root"),workspace("child"),true);for(const index of [-1,1,NaN,0.5])assert.equal(jumpNavigation(h,index),undefined);
});
test("new perspectives project source identity without carrying unrelated canvas coordinates",()=>{
 const from=compiledActivity(),to={...from,nodes:from.nodes.map(n=>({...n,id:`new:${n.id}`}))};const before=structuredClone(ui),state=perspectiveState(from,to,ui);assert.deepEqual(state.selection,["new:n:check"]);assert.equal(state.canvas,undefined);assert.deepEqual(state.cellSelection,[]);assert.equal(state.level,to.level);assert.deepEqual(ui,before);
});
