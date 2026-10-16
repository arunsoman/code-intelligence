import {test} from "node:test";
import assert from "node:assert/strict";
import {buildSync} from "esbuild";
import {renderToStaticMarkup} from "react-dom/server";
import {createElement} from "react";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import type {EvidenceTrace} from "@cie/schema";
test("evidence panel renders partial coverage, producer details and safe source controls",async()=>{
  const root=mkdtempSync(join(import.meta.dirname,"evidence-render-"));
  try{
    const compiled=buildSync({entryPoints:[join(import.meta.dirname,"../src/EvidencePanel.tsx")],bundle:true,platform:"node",format:"esm",jsx:"automatic",packages:"external",write:false});
    const path=join(root,"panel.mjs");writeFileSync(path,compiled.outputFiles[0].text);
    const {EvidencePanel}=await import(pathToFileURL(path).href);
    const trace:EvidenceTrace={version:"evidence-trace.v1",revision:"r1",snapshotId:"snapshot:one",coverage:"PARTIAL",provenance:"AVAILABLE",truncated:true,limitations:["Static analysis does not prove runtime behavior."],items:[{kind:"FACT",id:"f",label:"<script>charge</script>",entityIds:["function:a.ts#charge"],sources:[{evidenceId:"e",file:"a.ts",startByte:0,endByteExclusive:20,producer:{id:"cie.rust.static",version:"3",runId:"run:one"}}]}]};
    const html=renderToStaticMarkup(createElement(EvidencePanel,{trace,onOpen:()=>{}}));
    assert.match(html,/partial/);assert.match(html,/limited display/);assert.match(html,/snapshot:one/);assert.match(html,/cie.rust.static/);assert.match(html,/run:one/);assert.match(html,/<button/);assert.doesNotMatch(html,/<script>/);
    const opened: unknown[]=[];
    const walk=(node:any):void=>{if(!node||typeof node!=="object")return;if(node.type==="button")node.props.onClick();for(const child of [node.props?.children].flat(Infinity))walk(child);};
    walk(EvidencePanel({trace,onOpen:(...args:unknown[])=>opened.push(args)}));
    assert.deepEqual(opened,[["r1","file:a.ts"]]);
    const legacy=renderToStaticMarkup(createElement(EvidencePanel,{trace:{...trace,provenance:"UNAVAILABLE",items:[]}}));assert.match(legacy,/provenance unavailable/);assert.doesNotMatch(legacy,/<button/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
