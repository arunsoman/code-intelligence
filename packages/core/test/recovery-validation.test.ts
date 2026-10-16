import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRecovery, RECOVERY_CASES } from "../src/recovery-validation.ts";
import type { RecoveryAdapter, RecoveryFault } from "../src/recovery-validation.ts";

/** Contract fixture, not wallet implementation or independent measurement. */
function fixture(bug?: "duplicate" | "early-terminal" | "today-only" | "race" | "refund-success" | "no-receipt"): RecoveryAdapter {
  return {id:"test-only-recovery",version:"1",scope:"FIXTURE",async open({scenario,amountMinor}){
    let debited=0,refunded=0,commits=0,fulfilled=0,terminal=false,injected=false,day=0,busy=false;
    const receipts=new Set<RecoveryFault>();
    return {
      async pay(){debited=amountMinor;if(scenario.provider==="FULFILLED")fulfilled=1;
        if(scenario.faults.includes("PROVIDER_TIMEOUT" as never)){receipts.add("PROVIDER_TIMEOUT");throw new Error("injected timeout");}},
      async recover(){
        if(bug==="today-only"&&day>0)return;
        if(bug!=="duplicate"&&terminal)return;
        if(bug!=="race"&&busy)return;
        busy=true;
        try{
          if(fulfilled&&bug!=="refund-success"){terminal=true;return;}
          if(bug==="early-terminal")terminal=true;
          const fault=scenario.faults[0];
          if(!injected&&(fault==="SCHEDULER_BEFORE_REFUND"||fault==="REFUND_BEFORE_COMMIT")){injected=true;receipts.add(fault);throw new Error("injected before refund");}
          // Yield after reading the guard to expose a missing concurrency fence.
          const shouldRefund=bug==="duplicate"||!commits;
          await Promise.resolve();
          if(shouldRefund){refunded+=amountMinor;commits++;}
          if(!injected&&(fault==="SCHEDULER_AFTER_REFUND"||fault==="REFUND_AFTER_COMMIT")){injected=true;receipts.add(fault);throw new Error("injected after refund commit");}
          terminal=true;
        }finally{busy=false;}
      },
      async advanceDay(){day++;receipts.add("ADVANCE_DAY");},
      async snapshot(){return {debitedMinor:debited,refundedMinor:refunded,refundCommits:commits,fulfillments:fulfilled,providerOutcome:scenario.provider,terminal,exercisedFaults:bug==="no-receipt"?[]:[...receipts]};},
      async close(){},
    };
  }};
}

test("all nine defined scenarios execute on the fixture without claiming target behavior",async()=>{
  const report=await validateRecovery(fixture());
  assert.equal(report.status,"PASSED");assert.equal(report.scope,"FIXTURE");assert.equal(report.cases.length,9);
  assert.equal(report.resultClass,"FIXTURE_EXECUTION");
  assert.ok(report.cases.every(c=>c.status==="PASSED"));
  assert.match(report.limitations.join(" "),/do not establish behavior of the user's wallet/);
  assert.ok(report.cases.find(c=>c.scenario==="provider-timeout-failed")!.operationErrors>0);
  const success=report.cases.find(c=>c.scenario==="provider-timeout-fulfilled")!.snapshot!;
  assert.equal(success.fulfillments,1);assert.equal(success.refundedMinor,0);
});

for(const [bug,scenario] of [["duplicate","duplicate-recovery"],["early-terminal","refund-before-commit"],["today-only","pending-across-midnight"],["race","concurrent-recovery"],["refund-success","provider-timeout-fulfilled"]] as const){
  test(`oracle detects ${bug} in ${scenario}`,async()=>{
    const report=await validateRecovery(fixture(bug));
    assert.equal(report.status,"FAILED");assert.equal(report.cases.find(c=>c.scenario===scenario)?.status,"FAILED");
  });
}

test("missing fault receipts cannot be counted as a successful failure-injection test",async()=>{
  const report=await validateRecovery(fixture("no-receipt"));assert.equal(report.status,"INCOMPLETE");
  assert.match(report.cases[0].issues.join(" "),/did not confirm exercising PROVIDER_TIMEOUT/);
});

test("missing adapter or unbound target remains incomplete without running anything",async()=>{
  const missing=await validateRecovery();assert.equal(missing.status,"INCOMPLETE");assert.equal(missing.scope,"UNAVAILABLE");assert.equal(missing.cases.length,RECOVERY_CASES.length);
  assert.equal(missing.resultClass,"NOT_EXECUTED");
  let opened=false;const adapter=fixture();adapter.scope="TARGET";adapter.open=async()=>{opened=true;throw new Error("must not run");};
  assert.equal((await validateRecovery(adapter)).status,"INCOMPLETE");assert.equal(opened,false);
});

test("cooperative deadline aborts the adapter and never starts overlapping scenarios",async()=>{
  let opens=0,signal:AbortSignal|undefined,closed=false;
  const adapter=fixture();adapter.open=async input=>{opens++;signal=input.signal;return {pay:async()=>new Promise(()=>{}),recover:async()=>{},snapshot:async()=>{throw new Error("unreachable");},close:async()=>{closed=true;}};};
  const report=await validateRecovery(adapter,{caseTimeoutMs:10});
  assert.equal(report.status,"INCOMPLETE");assert.equal(opens,1);assert.equal(signal!.aborted,true);assert.equal(closed,true);
  assert.ok(report.cases.slice(1).every(c=>c.issues.some(i=>i.includes("Skipped"))));
});

test("cleanup failure invalidates a pass and stops later scenarios",async()=>{
  const base=fixture(),adapter=fixture();let opens=0;
  adapter.open=async input=>{opens++;const session=await base.open(input);session.close=async()=>{throw new Error("cleanup");};return session;};
  const report=await validateRecovery(adapter);assert.equal(report.status,"INCOMPLETE");assert.equal(opens,1);
});

test("invalid state measurements and amounts never silently pass",async()=>{
  await assert.rejects(validateRecovery(fixture(),{amountMinor:0}));
  const base=fixture(),adapter=fixture();adapter.open=async input=>{const session=await base.open(input);session.snapshot=async()=>({debitedMinor:NaN,refundedMinor:0,refundCommits:0,fulfillments:0,providerOutcome:"UNKNOWN",terminal:true,exercisedFaults:[]});return session;};
  const report=await validateRecovery(adapter);assert.equal(report.status,"INCOMPLETE");assert.ok(report.cases.every(c=>c.status==="INCOMPLETE"));
});

test("adapter extra fields and exception contents are not copied into evidence reports",async()=>{
  const base=fixture(),adapter=fixture();
  adapter.open=async input=>{const session=await base.open(input),snapshot=session.snapshot;session.snapshot=async signal=>({...await snapshot(signal),secret:"private-token"});return session;};
  const report=await validateRecovery(adapter);assert.equal(report.status,"PASSED");assert.ok(!JSON.stringify(report).includes("private-token"));
});

test("a late adapter open is closed without executing payment after the deadline",async()=>{
  const adapter=fixture();let opened!:(s:Awaited<ReturnType<RecoveryAdapter["open"]>>)=>void,closed!:()=>void,paid=false;
  const didClose=new Promise<void>(resolve=>{closed=resolve;});
  adapter.open=async()=>new Promise(resolve=>{opened=resolve;});
  const report=await validateRecovery(adapter,{caseTimeoutMs:10});
  opened({pay:async()=>{paid=true;},recover:async()=>{},snapshot:async()=>{throw new Error("unreachable");},close:async()=>{closed();}});
  await didClose;
  assert.equal(paid,false);assert.equal(report.status,"INCOMPLETE");
});

test("a declared target binding never becomes an independently attested result class",async()=>{
  const adapter=fixture();adapter.scope="TARGET";adapter.binding={revision:"declared-only",sourceSha256:"a".repeat(64)};
  const report=await validateRecovery(adapter);
  assert.equal(report.status,"PASSED");assert.equal(report.resultClass,"ADAPTER_REPORTED_TARGET_EXECUTION");
  assert.match(report.limitations.join(" "),/not independent attestations/);
});

test("an unknown provider result cannot establish a successful refund scenario",async()=>{
  const base=fixture(),adapter=fixture();adapter.open=async input=>{const session=await base.open(input),snapshot=session.snapshot;session.snapshot=async signal=>({...await snapshot(signal),providerOutcome:"UNKNOWN"});return session;};
  const report=await validateRecovery(adapter);assert.equal(report.status,"INCOMPLETE");assert.ok(report.cases.every(c=>c.status==="INCOMPLETE"));
});
