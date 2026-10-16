// Sequential fresh-process comparison. Run without competing builds/tests.
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import assert from "node:assert/strict";
const [source,baseline,current="target/release/worker"]=process.argv.slice(2);
if(!source||!baseline)throw new Error("usage: evidence-core-compare.ts FROZEN_SOURCE BASELINE_WORKER [CURRENT_WORKER]");
const variants=[
  ["current","off","inline",current],["baseline","on","inline",baseline],
  ["current","on","inline",current],["baseline","on","stream",baseline],["current","on","stream",current],
];
const samples=[];
for(let repeat=0;repeat<3;repeat++)for(const [version,mode,transport,binary]of (repeat%2?[...variants].reverse():variants)){
  const sample=JSON.parse(execFileSync(process.execPath,["--max-old-space-size=1536",resolve("tools/bench/evidence-core-scale.ts"),"--sample",resolve(source),mode,transport,resolve(binary)],{encoding:"utf8",timeout:180000,maxBuffer:1024*1024}));
  samples.push({repeat,version,...sample});
  process.stderr.write(`${version} ${mode}/${transport}: worker ${sample.workerWallMs.toFixed(2)} ms, Store ${sample.persistMs.toFixed(2)} ms\n`);
}
assert.equal(new Set(samples.filter(s=>s.mode==="on").map(s=>s.metadataHash)).size,1,"baseline/current persisted metadata mismatch");
console.log(JSON.stringify({schema:"cie.worker-comparison.v1",source:resolve(source),metadataParity:true,samples},null,2));
