import {test} from "node:test";
import assert from "node:assert/strict";
import {captureReport} from "./e2e/capture-report.ts";
test("capture report separates actual captures, fixture unavailability, chart failures and runtime blocks",()=>{const r=captureReport([{code:"S1",name:"Architecture",file:"s1.png",skipped:false},{code:"V6",name:"Diff",file:"v6.png",skipped:true},{code:"S9",name:"ER",file:"s9-failure.png",skipped:false,error:"render timeout",stage:"generation"},{code:"S27",name:"Context",file:null,skipped:false,error:"socket denied",blocked:true,stage:"startup"}]);assert.deepEqual(r.counts,{captured:1,unavailable:1,failed:1,blocked:1});assert.equal(r.attempted,4);assert.equal(r.entries[2].status,"failed");assert.equal(r.entries[3].status,"blocked");});
