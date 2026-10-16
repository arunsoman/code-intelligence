import { createHash } from "node:crypto";
import type { MotifMatch, Pdg } from "./types.ts";
import type { MotifBatchMatcher } from "./motifs.ts";

export interface MotifCacheStats { matched: number; reused: number; entries: number; bytes: number }
/** Process-local, exact-input cache. Worker identity namespaces invalidate hot binary replacements. */
export class MotifCache {
  private entries = new Map<string, { matches: Omit<MotifMatch,"entityId">[]; bytes: number }>();
  private bytes = 0;
  private namespace = "";
  private matcher?: MotifBatchMatcher;
  constructor(maxBytes = 16 * 1024 * 1024, maxEntries = 5000) { this.maxBytes=maxBytes;this.maxEntries=maxEntries; }
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  clear(): void { this.entries.clear();this.bytes=0; }
  match(pdgs: Pdg[], matcher: MotifBatchMatcher, namespace: string): { matches: MotifMatch[][]; stats: MotifCacheStats } {
    if(this.namespace!==namespace||this.matcher!==matcher){this.clear();this.namespace=namespace;this.matcher=matcher;}
    // Include names, node IDs, edge order and all graph fields; graphHash alone is not authority.
    const keys=pdgs.map(({entityId,file,bodyHash,graphHash,...graph})=>createHash("sha256").update(JSON.stringify(graph)).digest("hex"));
    const missing=new Map<string,Pdg>();
    const found=new Map<string,Omit<MotifMatch,"entityId">[]>();
    for(let i=0;i<pdgs.length;i++){
      const key=keys[i],hit=this.entries.get(key);
      if(hit){this.entries.delete(key);this.entries.set(key,hit);found.set(key,hit.matches);}
      else if(!missing.has(key))missing.set(key,pdgs[i]);
    }
    const todo=[...missing.values()];
    const results=todo.length?matcher(todo):[];
    if(results.length!==todo.length)throw new Error("Motif matcher returned a mismatched batch; nothing was cached.");
    // Populate only after the entire batch succeeds. Returned arrays never alias cached records.
    for(const [i,key] of [...missing.keys()].entries()){
      const matches=results[i].map(({entityId,...match})=>structuredClone(match));found.set(key,matches);
      const bytes=Buffer.byteLength(JSON.stringify(matches))+key.length;
      if(bytes>this.maxBytes||this.maxEntries<=0)continue;
      while(this.entries.size&&(this.bytes+bytes>this.maxBytes||this.entries.size>=this.maxEntries)){
        const oldest=this.entries.keys().next().value!;this.bytes-=this.entries.get(oldest)!.bytes;this.entries.delete(oldest);
      }
      this.entries.set(key,{matches,bytes});this.bytes+=bytes;
    }
    return {matches:keys.map((key,i)=>found.get(key)!.map(match=>({...structuredClone(match),entityId:pdgs[i].entityId}))),stats:{matched:todo.length,reused:pdgs.length-todo.length,entries:this.entries.size,bytes:this.bytes}};
  }
}
