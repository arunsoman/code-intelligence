// Compare release workers on the same source tree; optional baseline checks exact output.
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkerClient} from "../../packages/core/src/worker.ts";
const baseline=process.argv[2],samples:unknown[]=[];
process.env.CIE_EVIDENCE_CORE_MODE="on";process.env.CIE_EVIDENCE_CORE_STRICT="1";
for(const files of [60,600]) {
  const root=mkdtempSync(join(tmpdir(),"cie-fact-bench-"));
  try {
    for(let i=0;i<files;i++)writeFileSync(join(root,`${i}.ts`),Array.from({length:8},(_,j)=>`export function f${i}_${j}(){return ${i+j};}`).join("\n"));
    for(let repeat=0;repeat<5;repeat++) {
      let expected:unknown;
      // Alternate order to reduce systematic first-worker bias.
      const variants=baseline? (repeat%2?["current","baseline"]:["baseline","current"]):["current"];
      let actual:unknown;
      for(const variant of variants) {
        const worker=new WorkerClient(variant==="baseline"?baseline:undefined);
        try {
          const at=performance.now(),batch=await worker.index(root),indexMs=performance.now()-at;
          if(variant==="baseline")expected=batch;else actual=batch;
          samples.push({files,functions:files*8,repeat,variant,indexMs,metadataBytes:Buffer.byteLength(JSON.stringify(batch.evidenceCore??null))});
        } finally {worker.close();}
      }
      if(baseline)assert.deepEqual(actual,expected,"worker output changed");
    }
  } finally {rmSync(root,{recursive:true,force:true});}
}
console.log(JSON.stringify({exactOutputParity:baseline?true:null,samples},null,2));
