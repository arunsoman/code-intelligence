import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync,appendFileSync,unlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {WorkerClient} from "../../packages/core/src/worker.ts";
import {Store} from "../../packages/core/src/store.ts";
import {graphDigest} from "../../packages/core/src/indexer.ts";
import {populateMixed,mixedLanguages} from "./evidence-core-workloads.ts";
const root=mkdtempSync(join(tmpdir(),"cie-mixed-bench-")),samples:unknown[]=[];
let initialClusters:unknown;
const metadata=(s:Store,r:string)=>["evidence_core_producer_runs","evidence_core_links","evidence_core_coverage"].map(t=>s.db.prepare(`select * from ${t} where revision=? order by 2,3,4`).all(r));
try{
  for(let repeat=0;repeat<3;repeat++)for(const [mode,transport]of (repeat%2?[["on","stream"],["on","inline"],["off","inline"]]:[["off","inline"],["on","inline"],["on","stream"]])){
    rmSync(root,{recursive:true,force:true});populateMixed(root);
    Object.assign(process.env,{CIE_EVIDENCE_CORE_MODE:mode,CIE_EVIDENCE_CORE_TRANSPORT:transport,CIE_EVIDENCE_CORE_STRICT:"1",CIE_EVIDENCE_CORE_MAX_ROWS:"250000",CIE_EVIDENCE_CORE_MAX_BYTES:"134217728",CIE_LOG_LEVEL:"off"});
    const worker=new WorkerClient(),store=new Store(":memory:"),clean=new Store(":memory:");
    try{
      const at=performance.now(),batch=await worker.index(root),fullIndexMs=performance.now()-at;
      const persistAt=performance.now();store.putBatch(batch);const fullPersistMs=performance.now()-persistAt;
      assert.equal(batch.entities.filter(e=>e.kind==="file").length,500);
      if(initialClusters)assert.deepEqual(batch.conceptClusters,initialClusters,"concept labels changed across identical indexes");else initialClusters=batch.conceptClusters;
      if(process.argv[2]&&mode==="on"&&transport==="inline"){
        const baseline=new WorkerClient(resolve(process.argv[2]));try{
          const old=await baseline.index(root);
          // The only intentional output change fixes nondeterministic heuristic labels.
          const withoutLabels=(b:typeof batch)=>({...b,conceptClusters:b.conceptClusters?.map(({heuristicName,...cluster})=>cluster)});
          assert.deepEqual(withoutLabels(old),withoutLabels(batch));
        }finally{baseline.close();}
      }
      const base={revision:batch.revision,analyzerVersion:batch.analyzerVersion,digests:batch.manifest!,evidenceCoreVersion:store.evidenceCoreBaseVersion(batch.revision)};
      const u=performance.now(),unchanged=await worker.index(root,120000,undefined,base),unchangedMs=performance.now()-u;
      assert.equal(unchanged.mode,"unchanged");
      appendFileSync(join(root,"0.py"),"\ndef added(amount):\n    return amount + 999\n");
      unlinkSync(join(root,"0.go"));writeFileSync(join(root,"Added.java"),"public class Added { public int value(){return 999;} }\n");
      const d=performance.now(),delta=await worker.index(root,120000,undefined,base),deltaIndexMs=performance.now()-d;
      assert.equal(delta.mode,"delta");const p=performance.now();store.putDelta(delta);const deltaPersistMs=performance.now()-p;
      const full=await worker.index(root);clean.putBatch(full);
      assert.deepEqual(metadata(store,delta.revision),metadata(clean,full.revision));
      assert.equal(graphDigest(store,delta.revision).digest,graphDigest(clean,full.revision).digest);
      if(mode==="on"){assert.deepEqual(store.evidenceCoreProducerRuns(delta.revision,"0.go"),[]);assert.equal(store.evidenceCoreProducerRuns(delta.revision,"Added.java").length,1);}
      samples.push({repeat,mode,transport,files:500,fullIndexMs,fullPersistMs,unchangedMs,deltaIndexMs,deltaPersistMs,diagnostics:batch.diagnostics.map(d=>d.code),fullDeltaParity:true});
    }finally{worker.close();store.db.close();clean.db.close();}
  }
  console.log(JSON.stringify({schema:"cie.mixed-workload.v1",languages:mixedLanguages,synthetic:true,samples},null,2));
}finally{rmSync(root,{recursive:true,force:true});}
