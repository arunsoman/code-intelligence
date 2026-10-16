// Fresh Node + worker process per sample. Run sequentially after a release build.
import {execFileSync} from "node:child_process";
import {readFileSync,statSync,unlinkSync} from "node:fs";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {attachCoreStream} from "../../packages/core/src/evidence-core-stream.ts";
import {Store} from "../../packages/core/src/store.ts";
const script=resolve(import.meta.filename);
if(process.argv[2]==="--sample") {
  const [root,mode,transport]=process.argv.slice(3);
  process.env.CIE_EVIDENCE_CORE_MODE=mode;process.env.CIE_EVIDENCE_CORE_TRANSPORT=transport;process.env.CIE_EVIDENCE_CORE_STRICT="1";
  process.env.CIE_EVIDENCE_CORE_MAX_ROWS="250000";process.env.CIE_EVIDENCE_CORE_MAX_BYTES="134217728";
  const at=performance.now(),m=JSON.parse(execFileSync("python3",[resolve("tools/bench/worker-resource.py"),resolve("target/release/worker"),root,mode],{encoding:"utf8",timeout:130000}));
  const {response,...worker}=m;if(!response.ok)throw new Error(JSON.stringify(response.error));
  let batch;try{batch=JSON.parse(readFileSync(response.handle,"utf8"));}finally{unlinkSync(response.handle);}
  const transportAndParseMs=performance.now()-at;
  if(response.evidenceCoreHandle)attachCoreStream(batch,response.evidenceCoreHandle);
  const metadataBytes=response.evidenceCoreHandle?statSync(response.evidenceCoreHandle).size:Buffer.byteLength(JSON.stringify(batch.evidenceCore??null));
  const store=new Store(":memory:");let persistMs:number,metadataHash:string;
  try {
    const t=performance.now();store.putBatch(batch);persistMs=performance.now()-t;
    const hash=createHash("sha256");
    for(const table of ["evidence_core_producer_runs","evidence_core_links","evidence_core_coverage"])for(const row of store.db.prepare(`select * from ${table} order by 1,2,3,4`).iterate())hash.update(JSON.stringify(row)+"\n");
    metadataHash=hash.digest("hex");
    const links=(store.db.prepare("select count(*) n from evidence_core_links").get() as {n:number}).n;
    console.log(JSON.stringify({mode,transport,...worker,transportAndParseMs,persistMs,metadataBytes,metadataHash,links,files:batch.entities.filter((e:{kind:string})=>e.kind==="file").length,hostPeakRssBytes:process.resourceUsage().maxRSS*1024,baseVersion:store.evidenceCoreBaseVersion(batch.revision)}));
  }finally{store.db.close();}
}else {
  const root=resolve(process.argv[2]??"packages/core/src"),samples=[];
  for(let repeat=0;repeat<3;repeat++)for(const [mode,transport]of (repeat%2?[["on","stream"],["on","inline"],["off","inline"]]:[["off","inline"],["on","inline"],["on","stream"]])){
    const sample=JSON.parse(execFileSync(process.execPath,["--max-old-space-size=1536",script,"--sample",root,mode,transport],{encoding:"utf8",timeout:180000,maxBuffer:1024*1024}));samples.push({repeat,...sample});
  }
  const hashes=new Set(samples.filter(s=>s.mode==="on").map(s=>s.metadataHash));if(hashes.size!==1)throw new Error("inline/stream persisted metadata mismatch");
  console.log(JSON.stringify({schema:"cie.scale-benchmark.v1",root,budgets:{rows:250000,bytes:134217728,chunkRows:16384,chunkBytes:8388608,hostHeapMiB:1536},metadataParity:true,samples},null,2));
}
