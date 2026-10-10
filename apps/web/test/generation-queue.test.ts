import {test} from "node:test";
import assert from "node:assert/strict";
import {GenerationQueue} from "../src/generation-queue.ts";
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test("third request queues automatically and duplicate requests share one promise",async()=>{
 const q=new GenerationQueue<number>(),a=deferred<number>(),b=deferred<number>();const starts:string[]=[];
 const first=q.enqueue("a",()=>a.promise,"foreground",()=>starts.push("a"));const second=q.enqueue("b",()=>b.promise,"foreground",()=>starts.push("b"));
 const third=q.enqueue("c",async()=>3,"foreground",()=>starts.push("c"));assert.equal(q.enqueue("c",async()=>99),third);assert.deepEqual(starts,["a","b"]);
 a.resolve(1);assert.deepEqual(await first,{status:"completed",value:1});await tick();assert.deepEqual(starts,["a","b","c"]);assert.deepEqual(await third,{status:"completed",value:3});b.resolve(2);await second;
});
test("foreground jobs and promoted queued tabs precede background generation",async()=>{
 const q=new GenerationQueue<number>(1),gate=deferred<number>(),starts:string[]=[];
 const blocker=q.enqueue("block",()=>gate.promise);const background=q.enqueue("background",async()=>1,"supporting",()=>starts.push("background"));
 const selected=q.enqueue("selected",async()=>2,"supporting",()=>starts.push("selected"));q.promote("selected");gate.resolve(0);await blocker;await Promise.all([background,selected]);assert.deepEqual(starts,["selected","background"]);
});
test("cancellation removes queued jobs and aborts running requests",async()=>{
 const q=new GenerationQueue<number>(1),gate=deferred<number>();let signal:AbortSignal|undefined,ran=false;
 const active=q.enqueue("active",s=>{signal=s;return gate.promise;});await tick();const queued=q.enqueue("queued",async()=>{ran=true;return 1;});q.cancelAll();
 assert.deepEqual(await active,{status:"cancelled"});assert.deepEqual(await queued,{status:"cancelled"});assert.equal(signal!.aborted,true);assert.equal(ran,false);assert.equal(q.has("active"),false);gate.resolve(0);await tick();
});
test("cancelled running jobs retain their slot and cannot delete a new request with the same key",async()=>{
 const q=new GenerationQueue<number>(1),old=deferred<number>();const a=q.enqueue("same",()=>old.promise);await tick();q.cancel("same");await a;let started=false;
 const next=q.enqueue("same",async()=>2,"foreground",()=>{started=true;});assert.equal(started,false);assert.equal(q.has("same"),true);old.resolve(1);assert.deepEqual(await next,{status:"completed",value:2});assert.equal(started,true);
});
test("pending budget is finite and overflow produces a retryable explanation",async()=>{
 const q=new GenerationQueue<number>(1,1),gate=deferred<number>();const a=q.enqueue("a",()=>gate.promise),b=q.enqueue("b",async()=>2);const overflow=await q.enqueue("c",async()=>3);assert.equal(overflow.status,"failed");assert.match(overflow.status==="failed"?overflow.message:"",/queue is full/);gate.resolve(1);await Promise.all([a,b]);assert.equal((await q.enqueue("c",async()=>3)).status,"completed");
});
test("provider exceptions release slots and permit another request",async()=>{
 const q=new GenerationQueue<number>(1);const bad=q.enqueue("bad",async()=>{throw new Error("provider failed");});const next=q.enqueue("next",async()=>4);assert.deepEqual(await bad,{status:"failed",message:"provider failed"});assert.deepEqual(await next,{status:"completed",value:4});
});
test("deadline aborts a stalled request and advances queued work",async()=>{
 const q=new GenerationQueue<number>(1,1,15);let signal:AbortSignal|undefined;
 const stalled=q.enqueue("stall",s=>{signal=s;return new Promise(()=>{});});const next=q.enqueue("next",async()=>5);const result=await stalled;assert.equal(result.status,"failed");assert.match(result.status==="failed"?result.message:"",/timed out/);assert.equal(signal!.aborted,true);assert.deepEqual(await next,{status:"completed",value:5});
});
test("invalid budgets fail early",()=>{assert.equal(new GenerationQueue().timeoutMs,180000);for(const args of [[0,1,10],[1,-1,10],[1,1,0],[1.5,1,10]])assert.throws(()=>new GenerationQueue(...args as [number,number,number]),/budget/);});
