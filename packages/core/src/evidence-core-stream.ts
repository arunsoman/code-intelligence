// Transport-only capability: never serialized into AnalysisBatch or supplied to models.
import {openSync,readSync,closeSync,unlinkSync,fstatSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {z} from "zod";
import type {DatabaseSync} from "node:sqlite";
import type {AnalysisBatch,EvidenceCoreBatchV1} from "@cie/schema";
import {evidenceCoreConfig,validatedCore,insertCore} from "./evidence-core.ts";
import {claimCoreStream,releaseCoreStreamClaim} from "./evidence-core-cleanup.ts";
const handles=new WeakMap<AnalysisBatch,string>(),pending=new Set<string>();
const remove=(path:string)=>{pending.delete(path);try{unlinkSync(path);}catch{}releaseCoreStreamClaim(path);};
const cleanup=new FinalizationRegistry<string>(remove);
process.once("exit",()=>{for(const path of pending)remove(path);});
export function attachCoreStream(batch:AnalysisBatch,path:string):void {
  if(batch.evidenceCore || handles.has(batch))throw new Error("EVIDENCE_CORE_STREAM_INVALID: ambiguous transport");
  claimCoreStream(path);
  handles.set(batch,path);pending.add(path);cleanup.register(batch,path,batch);
}
export function coreStreamPath(batch:AnalysisBatch):string|undefined{return handles.get(batch);}
export function releaseCoreStream(batch:AnalysisBatch):void {const path=handles.get(batch);if(path){handles.delete(batch);cleanup.unregister(batch);remove(path);}}
export function cleanupCoreWorkerFiles(pid:number):void {
  try{for(const file of readdirSync(tmpdir()))if(file.startsWith(`cie-handle-${pid}-`)&&file.endsWith(".core.jsonl")){const path=join(tmpdir(),file);if(!pending.has(path))remove(path);}}catch{}
}
function invalid():never {throw new Error("EVIDENCE_CORE_STREAM_INVALID: incomplete or invalid metadata stream");}
function limit():never {throw new Error("EVIDENCE_CORE_RESOURCE_LIMIT: stream budget");}
function* lines(path:string,maxLine:number,maxTotal:number):Generator<Buffer> {
  const fd=openSync(path,"r");
  try {
    if(!fstatSync(fd).isFile()||fstatSync(fd).size>maxTotal)limit();
    const block=Buffer.alloc(65536);let pieces:Buffer[]=[],length=0,total=0;
    for(;;){const n=readSync(fd,block);if(!n)break;total+=n;if(total>maxTotal)limit();
      let start=0;
      while(start<n){const found=block.subarray(0,n).indexOf(10,start),end=found<0?n:found+1;
        const piece=Buffer.from(block.subarray(start,end));length+=piece.length;
        if(length>maxLine+(found<0?0:1))limit();pieces.push(piece);start=end;
        if(found>=0){yield Buffer.concat(pieces,length);pieces=[];length=0;}
      }
    }
    if(length)invalid();
  }finally{closeSync(fd);}
}
const header=z.object({kind:z.literal("header"),schema:z.literal("cie.evidence-core.stream.v1"),revision:z.string()}).strict();
const chunk=z.object({kind:z.literal("chunk"),sequence:z.number().int().nonnegative(),scope:z.string(),core:z.unknown()}).strict();
const footer=z.object({kind:z.literal("footer"),chunks:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
/** Called only inside Store's outer write transaction. Uncommitted rows are staging. */
export function insertCoreStream(db:DatabaseSync,batch:AnalysisBatch,entities:AnalysisBatch["entities"],replace:boolean):void {
  const path=handles.get(batch);if(!path)throw new Error("EVIDENCE_CORE_STREAM_INVALID: no handle");
  const config=evidenceCoreConfig();if(config.mode==="off")return;
  const expected=new Set(Object.keys(batch.manifest??{}).filter(f=>batch.mode!=="delta"||(batch.changedFiles??[]).includes(f)));
  const seen=new Set<string>(),hash=createHash("sha256");let sequence=0,started=false,finished=false,links=0;
  const owners=new Map(entities.map(e=>[e.entityId,e]));
  const files=new Map(entities.filter(e=>e.kind==="file").map(e=>[e.file,e]));
  const factGroups=new Map<string,AnalysisBatch["facts"]>(),relGroups=new Map<string,AnalysisBatch["relationships"]>();
  for(const row of batch.facts){const scope=owners.get(row.subject)?.file??"";const rows=factGroups.get(scope)??[];rows.push(row);factGroups.set(scope,rows);}
  for(const row of batch.relationships){const scope=owners.get(row.from)?.file??"";const rows=relGroups.get(scope)??[];rows.push(row);relGroups.set(scope,rows);}
  db.exec("savepoint evidence_core_stream");
  try {
    if(replace)db.prepare("delete from evidence_core_producer_runs where revision=?").run(batch.revision);
    for(const line of lines(path,config.limits.chunkBytes,config.limits.streamBytes)){
      let value:any;try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(line));}catch{invalid();}
      if(!started){const h=header.safeParse(value);if(!h.success||h.data.revision!==batch.revision)invalid();started=true;continue;}
      if(finished)invalid();
      if(value?.kind==="footer"){
        const f=footer.safeParse(value);if(!f.success||f.data.chunks!==sequence||f.data.sha256!==hash.digest("hex")||seen.size!==expected.size)invalid();finished=true;continue;
      }
      const parsed=chunk.safeParse(value);if(!parsed.success)invalid();const c=parsed.data;
      if(c.sequence!==sequence++||!expected.has(c.scope)||seen.has(c.scope))invalid();seen.add(c.scope);hash.update(line);
      const raw=c.core as EvidenceCoreBatchV1;if(!raw||!Array.isArray(raw.links))invalid();
      links+=raw.links.length;
      if(raw.links.length>config.limits.chunkRows||links>config.limits.streamRows||sequence>config.limits.streamRows)limit();
      const facts=factGroups.get(c.scope)??[],relationships=relGroups.get(c.scope)??[];
      const ids=new Set([...facts.map(f=>f.subject),...relationships.map(r=>r.from)]);
      // Only these file rows can participate in this scope's input/source checks.
      // Keep cross-file evidence sources; scanning every file per chunk is quadratic.
      const sources=new Set([c.scope]);
      for(const row of [...facts,...relationships])for(const ev of row.evidence)
        if(ev.location.kind==="CodeLocation")sources.add(ev.sourceId);
      const selected=[...[...sources].map(file=>files.get(file)).filter((e):e is NonNullable<typeof e>=>!!e),
        ...[...ids].map(id=>owners.get(id)).filter((e):e is NonNullable<typeof e>=>!!e&&e.kind!=="file")];
      const scoped={...batch,mode:"delta" as const,changedFiles:[c.scope],entities:selected,facts,relationships,evidenceCore:raw};
      const core=validatedCore(scoped);if(!core)invalid();insertCore(db,batch.revision,core,false);
    }
    if(!started||!finished)invalid();
    db.exec("release evidence_core_stream");
  }catch(error){
    try{db.exec("rollback to evidence_core_stream; release evidence_core_stream");}catch{throw error;}
    if(config.strict || !(error instanceof Error) || !/^(EVIDENCE_CORE_STREAM_INVALID|EVIDENCE_CORE_INVALID)/.test(error.message))throw error;
    if(!batch.diagnostics.some(d=>d.code==="EVIDENCE_CORE_REJECTED"))batch.diagnostics.push({code:"EVIDENCE_CORE_REJECTED",message:"Incomplete optional stream discarded; coverage remains unknown",relatedEntityIds:[],retryable:false});
  }
}
