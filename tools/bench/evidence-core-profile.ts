import {attachCoreStream} from "../../packages/core/src/evidence-core-stream.ts";
// Sequential profiling; no model. Run after a release build, without competing tests.
import {execFileSync} from "node:child_process";
import {mkdtempSync,writeFileSync,readFileSync,rmSync,unlinkSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve,join} from "node:path";
import {Store} from "../../packages/core/src/store.ts";
import {validatedCore} from "../../packages/core/src/evidence-core.ts";
const root=mkdtempSync(join(tmpdir(),"cie-profile-")), samples:unknown[]=[];
const worker=resolve(process.argv[2]??"target/release/worker");
try {
  for(let i=0;i<600;i++)writeFileSync(join(root,`${i}.ts`),Array.from({length:8},(_,j)=>`export function f${i}_${j}(){return ${i+j};}`).join("\n"));
  for(const corpus of ["sample-repo","express-repo","spring-repo","cie-core-src","synthetic600"])for(let repeat=0;repeat<3;repeat++)for(const mode of (repeat%2?["on","off"]:["off","on"])) {
    process.env.CIE_EVIDENCE_CORE_MODE=mode;process.env.CIE_EVIDENCE_CORE_STRICT="1";
    const source=corpus==="synthetic600"?root:corpus==="cie-core-src"?resolve("packages/core/src"):resolve("fixtures",corpus);
    const measurement=JSON.parse(execFileSync("python3",[resolve("tools/bench/worker-resource.py"),worker,source,mode],{encoding:"utf8",timeout:130000}));
    const {response,...metrics}=measurement;
    if(!response.ok){samples.push({corpus,repeat,mode,...metrics,error:response.error});continue;}
    const at=performance.now();let batch;
    try{batch=JSON.parse(readFileSync(response.handle,"utf8"));}finally{unlinkSync(response.handle);}
    const handleReadParseMs=performance.now()-at;
    if(response.evidenceCoreHandle)attachCoreStream(batch,response.evidenceCoreHandle);
    const metadataBytes=response.evidenceCoreHandle?statSync(response.evidenceCoreHandle).size:Buffer.byteLength(JSON.stringify(batch.evidenceCore??null));
    const validationAt=performance.now();if(!response.evidenceCoreHandle)validatedCore(batch);const standaloneValidationMs=performance.now()-validationAt;
    const store=new Store(":memory:");let persistMs:number;
    try{const at=performance.now();store.putBatch(batch);persistMs=performance.now()-at;}finally{store.db.close();}
    samples.push({corpus,repeat,mode,...metrics,handleReadParseMs,standaloneValidationMs,persistMs,files:batch.entities.filter((e:{kind:string})=>e.kind==="file").length,metadataBytes,transport:response.evidenceCoreHandle?"stream":"inline"});
  }
  console.log(JSON.stringify({schema:"cie.index-profile.v1",samples},null,2));
} finally {rmSync(root,{recursive:true,force:true});}
