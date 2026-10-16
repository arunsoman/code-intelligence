// Compare the actual baseline semantic builder with the optimized builder on identical inputs.
// No model or index I/O: this measures semantic construction, not end-to-end hierarchy latency.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSemanticConcepts } from "../packages/core/src/concept-hierarchy/semantic-concepts.ts";
import type { Pdg } from "../packages/core/src/concept-hierarchy/types.ts";
import type { Store } from "../packages/core/src/store.ts";

const baseline="0337482",count=Number(process.argv[2]??1000),rounds=5;
if(!Number.isSafeInteger(count)||count<10||count>10000)throw new Error("graph count must be 10..10000");
const file=resolve(`packages/core/src/concept-hierarchy/perf-baseline-${randomUUID()}.ts`);
const source=execFileSync("git",["show",`${baseline}:packages/core/src/concept-hierarchy/semantic-concepts.ts`],{encoding:"utf8"});
writeFileSync(file,source);
try{
  const original=await import(pathToFileURL(file).href) as {buildSemanticConcepts:typeof buildSemanticConcepts};
  const graph=(i:number,edit=0):Pdg=>{
    const nodes:Pdg["nodes"]=[{id:"n0",kind:"branch",at:0}],edges:Pdg["edges"]=[];
    for(let j=1;j<=30;j++){nodes.push({id:`n${j}`,kind:"def",name:`balance${i}_${edit}_${j}`,op:"op:sub",at:j});edges.push({from:"n0",to:`n${j}`,kind:"guard"});}
    return {entityId:`function:src/m${i}.ts#pay`,file:`src/m${i}.ts`,bodyHash:`body${i}_${edit}`,graphHash:"not-a-cache-key",nodes,edges,locals:[],truncated:false,statements:31};
  };
  const pdgs=Array.from({length:count},(_,i)=>graph(i));let reads=0;
  const store={factsFor:()=>{reads++;return [];}} as unknown as Store;
  const start=performance.now();const cold=buildSemanticConcepts(store,"bench",pdgs);const coldMs=performance.now()-start;
  const measurements=[];
  for(let round=0;round<rounds;round++){
    const edited=pdgs.map((g,i)=>i===0?graph(i,round+1):g);
    reads=0;let t=performance.now();const before=original.buildSemanticConcepts(store,"bench",edited);const baselineMs=performance.now()-t,baselineReads=reads;
    reads=0;t=performance.now();const after=buildSemanticConcepts(store,"bench",edited);const incrementalMs=performance.now()-t;
    assert.deepEqual(after.concepts,before.concepts);
    assert.equal(after.motifMatching?.matched,1);
    measurements.push({baselineMs,incrementalMs,baselineReads,incrementalReads:reads,motifs:after.motifMatching,outputEquivalent:true});
  }
  const median=(values:number[])=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const before=median(measurements.map(m=>m.baselineMs)),after=median(measurements.map(m=>m.incrementalMs));
  const report={baseline,graphs:count,nodesPerGraph:31,rounds,coldMs,coldMotifs:cold.motifMatching,medianBaselineMs:before,medianIncrementalMs:after,speedup:before/after,measurements,limits:["Synthetic semantic-phase workload, no model, index or architecture/persistence I/O.","Process-local warm cache; restart is cold. Timings are specific to this environment."]};
  const json=JSON.stringify(report,null,2)+"\n";if(process.argv[3])writeFileSync(process.argv[3],json);process.stdout.write(json);
}finally{rmSync(file,{force:true});}
