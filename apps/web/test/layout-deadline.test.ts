import {test} from "node:test";
import assert from "node:assert/strict";
import {layoutDeadline} from "../src/layout-deadline.ts";
test("successful layout preserves its exact geometry object",async()=>{const geometry={nodes:[{id:"n",x:3,y:4}],edges:[{id:"e",from:"n",to:"n"}]};assert.equal(await layoutDeadline(Promise.resolve(geometry)).promise,geometry);});
test("stalled layout has a bounded failure instead of permanent busy state",async()=>{await assert.rejects(layoutDeadline(new Promise(()=>{}),10).promise,/exceeded/);});
test("worker errors remain visible to the fallback handler",async()=>{await assert.rejects(layoutDeadline(Promise.reject(new Error("worker failed"))).promise,/worker failed/);});
test("cancelling a deadline prevents abandoned work from timing out later",async()=>{let finish!:(value:number)=>void;const job=layoutDeadline(new Promise<number>(done=>{finish=done;}),10);job.cancel();await new Promise(r=>setTimeout(r,20));finish(7);assert.equal(await job.promise,7);});
