// Conservative Linux recovery for metadata claimed by a host that later died.
import {openSync,closeSync,unlinkSync,lstatSync,readdirSync,readFileSync,readlinkSync} from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
const leases=new Map<string,string>();
export const CORE_STREAM_STALE_MS=24*60*60*1000;
let token:string|null|undefined,lastSweep=0;
function namespace():string|null {
  if(token!==undefined)return token;
  try{return token=createHash("sha256").update(readFileSync("/proc/sys/kernel/random/boot_id")).update(readlinkSync("/proc/self/ns/pid")).digest("hex");}
  catch{return token=null;}
}
export function claimCoreStream(path:string):void {
  const ns=namespace();if(!ns)return;
  const lease=`${path}.lease-${ns}-${process.pid}`;
  const fd=openSync(lease,"wx",0o600);closeSync(fd);leases.set(path,lease);
}
export function releaseCoreStreamClaim(path:string):void {
  const lease=leases.get(path);if(!lease)return;leases.delete(path);
  try{unlinkSync(lease);}catch{}
}
function alive(pid:number):boolean {
  if(!Number.isSafeInteger(pid)||pid<=0)return true;
  try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=="ESRCH";}
}
/** Unknown owners, foreign namespaces, symlinks and live/reused PIDs are retained. */
export function cleanupStaleCoreStreams(directory=tmpdir(),now=Date.now()):number {
  if(!Number.isFinite(now))return 0;
  const ns=namespace(),uid=process.getuid?.();if(!ns||uid===undefined)return 0;
  let names:string[];try{names=readdirSync(directory);}catch{return 0;}
  const grouped=new Map<string,string[]>();
  for(const name of names){
    const match=/^(cie-handle-[0-9]+-[0-9]+\.core\.jsonl)\.lease-/.exec(name);
    if(match){const list=grouped.get(match[1])??[];list.push(name);grouped.set(match[1],list);}
  }
  let removed=0;
  for(const [file,claims]of grouped){
    const path=join(directory,file),worker=Number(/^cie-handle-([0-9]+)-/.exec(file)![1]);
    if(alive(worker))continue;
    try{
      const data=lstatSync(path);
      if(!data.isFile()||data.uid!==uid||now-data.mtimeMs<CORE_STREAM_STALE_MS)continue;
      let safe=true;
      for(const claim of claims){
        const match=new RegExp(`^${file.replaceAll(".","\\.")}\\.lease-${ns}-([0-9]+)$`).exec(claim);
        const stat=lstatSync(join(directory,claim));
        if(!match||!stat.isFile()||stat.uid!==uid||now-stat.mtimeMs<CORE_STREAM_STALE_MS||alive(Number(match[1]))){safe=false;break;}
      }
      if(!safe)continue;
      unlinkSync(path);removed++;
      for(const claim of claims)try{unlinkSync(join(directory,claim));}catch{}
    }catch{/* Another process may have released or reclaimed it. */}
  }
  return removed;
}
export function cleanupCoreStreamsAtStartup():number {
  const now=Date.now();if(now-lastSweep<60*60*1000)return 0;lastSweep=now;
  return cleanupStaleCoreStreams(tmpdir(),now);
}
