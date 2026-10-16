// Reproducible smoke benchmark; fresh worker processes, shared warm filesystem, no model.
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerClient } from "../../packages/core/src/worker.ts";
import { Store } from "../../packages/core/src/store.ts";
const root=mkdtempSync(join(tmpdir(),"cie-core-bench-")), samples: Record<string,unknown>[]=[];
try {
  for(let i=0;i<60;i++)writeFileSync(join(root,`source${i}.ts`),Array.from({length:8},(_,j)=>`export function f${i}_${j}(){return ${i+j};}`).join("\n"));
  for(let repeat=0;repeat<5;repeat++)for(const mode of ["off","on"]) {
    process.env.CIE_EVIDENCE_CORE_MODE=mode;process.env.CIE_EVIDENCE_CORE_STRICT="1";
    const worker=new WorkerClient(); let rssMb: number|null=null;
    const timer=setInterval(()=>{const rss=(worker as unknown as {rssMb():number|null}).rssMb();if(rss!==null)rssMb=Math.max(rssMb??0,rss);},5);
    const started=performance.now();const batch=await worker.index(root);const indexMs=performance.now()-started;
    clearInterval(timer);worker.close();
    const path=join(root,`${mode}-${repeat}.db`),store=new Store(path),at=performance.now();store.putBatch(batch);const persistMs=performance.now()-at;
    const times=[];for(let i=0;i<100;i++){const at=performance.now();store.evidenceCoreCoverage(batch.revision,"static.observations","source0.ts");times.push(performance.now()-at);}
    store.db.exec("pragma wal_checkpoint(TRUNCATE)");store.db.close();
    samples.push({mode,indexMs,persistMs,sampledWorkerRssMb:rssMb,dbBytes:statSync(path).size,metadataBytes:Buffer.byteLength(JSON.stringify(batch.evidenceCore??null)),lookupP95Ms:times.sort((a,b)=>a-b)[94]});
  }
  console.log(JSON.stringify({corpus:{files:60,functions:480},samples},null,2));
} finally {rmSync(root,{recursive:true,force:true});}
