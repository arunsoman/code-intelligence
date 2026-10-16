import assert from "node:assert/strict";
import { test } from "node:test";
import { MotifCache } from "../src/concept-hierarchy/motif-cache.ts";
import { localMotifBatch } from "../src/concept-hierarchy/motifs.ts";
import { buildSemanticConcepts } from "../src/concept-hierarchy/semantic-concepts.ts";
import type { Pdg } from "../src/concept-hierarchy/types.ts";
import type { Store } from "../src/store.ts";

export const graph=(id:string,name="balance"):Pdg=>({entityId:id,file:"a.ts",bodyHash:"body",graphHash:"deliberately-not-authority",nodes:[{id:"n0",kind:"branch",at:0},{id:"n1",kind:"def",name,op:"op:sub",at:1}],edges:[{from:"n0",to:"n1",kind:"guard"}],locals:[name],truncated:false,statements:2});

test("unchanged graphs and duplicate shapes skip matching and remap current entity identities",()=>{
  const cache=new MotifCache();let matched=0;
  const matcher=(pdgs:Pdg[])=>{matched+=pdgs.length;return localMotifBatch(pdgs);};
  const a=graph("a"),b=graph("b");
  const first=cache.match([a,b],matcher,"v1");
  assert.equal(matched,1);assert.deepEqual(first.matches,localMotifBatch([a,b]));
  first.matches[0][0].binds.var="corrupted caller data";
  const renamed=graph("renamed");const next=cache.match([renamed],matcher,"v1");
  assert.equal(next.stats.matched,0);assert.equal(next.matches[0][0].entityId,"renamed");assert.equal(next.matches[0][0].binds.var,"balance");
  const changed=graph("a","other");const delta=cache.match([changed,b],matcher,"v1");
  assert.equal(delta.stats.matched,1);assert.deepEqual(delta.matches,localMotifBatch([changed,b]));
});

test("matcher identity, worker namespace and exact graph inputs invalidate reuse",()=>{
  const cache=new MotifCache(),a=graph("a");
  assert.equal(cache.match([a],localMotifBatch,"worker1").stats.matched,1);
  assert.equal(cache.match([a],localMotifBatch,"worker2").stats.matched,1);
  assert.equal(cache.match([a],p=>localMotifBatch(p),"worker2").stats.matched,1);
  const changed={...a,nodes:a.nodes.map(n=>({...n,at:n.at+1}))};
  assert.equal(cache.match([changed],localMotifBatch,"worker2").stats.matched,1);
});

test("entry and payload budgets evict old graphs without changing results",()=>{
  const cache=new MotifCache(4096,1),a=graph("a"),b=graph("b","other");
  cache.match([a],localMotifBatch,"v");const result=cache.match([b],localMotifBatch,"v");
  assert.equal(result.stats.entries,1);assert.ok(result.stats.bytes<=4096);
  assert.equal(cache.match([a],localMotifBatch,"v").stats.matched,1);
  const disabled=new MotifCache(0,0);assert.deepEqual(disabled.match([a],localMotifBatch,"v").matches,localMotifBatch([a]));
  assert.equal(disabled.match([a],localMotifBatch,"v").stats.entries,0);
});

test("failed matching is never reused and a single edit matches only one of 1000 graphs",()=>{
  const cache=new MotifCache();let broken=true;
  const matcher=(pdgs:Pdg[])=>{if(broken)throw new Error("worker failed");return localMotifBatch(pdgs);};
  const pdgs=Array.from({length:1000},(_,i)=>graph(`f${i}`,`balance${i}`));
  assert.throws(()=>cache.match(pdgs,matcher,"v"));broken=false;
  assert.equal(cache.match(pdgs,matcher,"v").stats.matched,1000);
  const edited=pdgs.map((g,i)=>i===500?graph(g.entityId,"changed"):g);
  const next=cache.match(edited,matcher,"v");assert.equal(next.stats.matched,1);assert.equal(next.stats.reused,999);
  assert.deepEqual(next.matches,localMotifBatch(edited));
});

test("semantic evidence loads once per member and refreshes on every revision",()=>{
  let reads=0;const store={factsFor:()=>{reads++;return [];}} as unknown as Store;
  const pdgs=[graph("a"),graph("b","other")];
  buildSemanticConcepts(store,"r1",pdgs,[],localMotifBatch);assert.equal(reads,2);
  buildSemanticConcepts(store,"r2",pdgs,[],localMotifBatch);assert.equal(reads,4);
});

test("production cached motifs still resolve fresh evidence for the current revision",()=>{
  let revision="r1",reads=0;
  const store={factsFor:()=>{reads++;return [{predicate:"writes",evidence:[{id:`e:${revision}`}]}];}} as unknown as Store;
  const pdgs=[graph("function:production.ts#pay","uniqueProductionVariable")];
  const first=buildSemanticConcepts(store,revision,pdgs);assert.equal(first.motifMatching?.matched,1);
  revision="r2";const next=buildSemanticConcepts(store,revision,pdgs,first.concepts);
  assert.equal(next.motifMatching?.matched,0);assert.equal(next.motifMatching?.reused,1);
  assert.deepEqual(next.concepts[0].evidenceIds,["e:r2"]);assert.equal(next.concepts[0].revision,"r2");assert.equal(reads,2);
});
