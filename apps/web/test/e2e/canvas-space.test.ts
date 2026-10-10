import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {Browser,CHROME} from "./cdp.ts";
import {startServer} from "./harness.ts";
test("canvas focus expands drawing width and restores side panels",{skip:!existsSync(CHROME),timeout:120000},async()=>{
 const server=await startServer(),b=await Browser.launch();try{await b.send("Emulation.setDeviceMetricsOverride",{width:1400,height:900,deviceScaleFactor:1,mobile:false});await b.goto(server.url);const width=()=>b.eval<number>("document.querySelector('main').getBoundingClientRect().width");const before=await width();await b.eval("[...document.querySelectorAll('button')].find(b=>b.textContent==='Focus canvas').click()");await b.waitFor(()=>"document.querySelector('.app').dataset.canvasFocus==='true'");assert.ok(await width()>before*1.5);await b.eval("[...document.querySelectorAll('button')].find(b=>b.textContent==='Chat & evidence').click()");assert.equal(await b.eval("getComputedStyle(document.getElementById('workspace-right-panel')).display"),"grid");await b.eval("[...document.querySelectorAll('button')].find(b=>b.textContent==='Exit canvas focus').click()");await b.waitFor(()=>"!document.querySelector('.app').dataset.canvasFocus");assert.ok(Math.abs(await width()-before)<2);}finally{await b.close();server.proc.kill();}
});
