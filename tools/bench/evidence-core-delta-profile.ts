import {attachCoreStream} from "../../packages/core/src/evidence-core-stream.ts";
import {execFileSync} from "node:child_process";
import {mkdtempSync,writeFileSync,readFileSync,rmSync,unlinkSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve,join} from "node:path";
import {Store} from "../../packages/core/src/store.ts";
const scratch=mkdtempSync(join(tmpdir(),"cie-delta-profile-")),source=join(scratch,"repo"),samples:unknown[]=[];
import {mkdirSync} from "node:fs";
mkdirSync(source);
try {
  for(let i=0;i<600;i++)writeFileSync(join(source,`${i}.ts`),`export function f${i}(){return ${i};}\n`);
  for(let repeat=0;repeat<3;repeat++)for(const mode of (repeat%2?["on","off"]:["off","on"])) {
    process.env.CIE_EVIDENCE_CORE_MODE=mode;process.env.CIE_EVIDENCE_CORE_STRICT="1";
    const store=new Store(":memory:");
    try {
      let base:unknown;
      for(const operation of ["full","unchanged","delta"]) {
        if(operation==="delta")writeFileSync(join(source,"0.ts"),"export function edited(){return 999;}\n");
        const params=join(scratch,"params.json");writeFileSync(params,JSON.stringify({base}));
        const measurement=JSON.parse(execFileSync("python3",[resolve("tools/bench/worker-resource.py"),resolve("target/release/worker"),source,mode,params],{encoding:"utf8",timeout:130000}));
        const {response,...metrics}=measurement;if(!response.ok)throw new Error(JSON.stringify(response.error));
        const at=performance.now();let batch;try{batch=JSON.parse(readFileSync(response.handle,"utf8"));}finally{unlinkSync(response.handle);}
        const readParseMs=performance.now()-at;
        if(response.evidenceCoreHandle)attachCoreStream(batch,response.evidenceCoreHandle);
        const metadataBytes=response.evidenceCoreHandle?statSync(response.evidenceCoreHandle).size:Buffer.byteLength(JSON.stringify(batch.evidenceCore??null));
        const persistAt=performance.now();if(operation==="full")store.putBatch(batch);else if(batch.mode==="delta")store.putDelta(batch);
        const persistMs=performance.now()-persistAt;
        if(operation==="full")base={revision:batch.revision,analyzerVersion:batch.analyzerVersion,digests:batch.manifest,evidenceCoreVersion:store.evidenceCoreBaseVersion(batch.revision)};
        samples.push({repeat,mode,operation,resultMode:batch.mode,...metrics,readParseMs,persistMs,metadataBytes,transport:response.evidenceCoreHandle?"stream":"inline"});
      }
    }finally{store.db.close();writeFileSync(join(source,"0.ts"),"export function f0(){return 0;}\n");}
  }
  console.log(JSON.stringify({schema:"cie.delta-profile.v1",files:600,functions:600,samples},null,2));
}finally{rmSync(scratch,{recursive:true,force:true});}
