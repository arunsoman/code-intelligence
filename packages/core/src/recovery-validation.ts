import { randomUUID } from "node:crypto";

export const RECOVERY_CASES = [
  { id: "provider-timeout-failed", faults: ["PROVIDER_TIMEOUT"], provider: "FAILED", duplicate: 1 },
  { id: "provider-timeout-fulfilled", faults: ["PROVIDER_TIMEOUT"], provider: "FULFILLED", duplicate: 1 },
  { id: "refund-before-commit", faults: ["REFUND_BEFORE_COMMIT"], provider: "FAILED", duplicate: 1 },
  { id: "refund-after-commit", faults: ["REFUND_AFTER_COMMIT"], provider: "FAILED", duplicate: 1 },
  { id: "scheduler-before-refund", faults: ["SCHEDULER_BEFORE_REFUND"], provider: "FAILED", duplicate: 1 },
  { id: "scheduler-after-refund", faults: ["SCHEDULER_AFTER_REFUND"], provider: "FAILED", duplicate: 1 },
  { id: "duplicate-recovery", faults: [], provider: "FAILED", duplicate: 5 },
  { id: "concurrent-recovery", faults: [], provider: "FAILED", duplicate: 4, concurrent: true },
  { id: "pending-across-midnight", faults: ["ADVANCE_DAY"], provider: "FAILED", duplicate: 1 },
] as const;
export type RecoveryCase = typeof RECOVERY_CASES[number];
export type RecoveryFault = RecoveryCase["faults"][number];
export interface RecoverySnapshot {
  /** Gross amounts, not netted figures. All amounts are integer minor currency units. */
  debitedMinor: number; refundedMinor: number; refundCommits: number; fulfillments: number;
  providerOutcome: "FAILED" | "FULFILLED" | "UNKNOWN";
  /** Read from the target's durable state, not inferred from a returned HTTP status. */
  terminal: boolean;
  exercisedFaults: RecoveryFault[];
}
export interface RecoverySession {
  pay(signal: AbortSignal): Promise<void>;
  recover(signal: AbortSignal): Promise<void>;
  advanceDay?(signal: AbortSignal): Promise<void>;
  snapshot(signal: AbortSignal): Promise<RecoverySnapshot>;
  close(signal: AbortSignal): Promise<void>;
}
export interface RecoveryAdapter {
  id: string; version: string; scope: "FIXTURE" | "TARGET";
  /** Declared by the trusted adapter; these fields alone are not execution attestation. */
  binding?: { revision: string; sourceSha256: string };
  open(input: { scenario: RecoveryCase; amountMinor: number; transactionId: string; signal: AbortSignal }): Promise<RecoverySession>;
}
export interface RecoveryCaseResult {
  scenario: RecoveryCase["id"]; status: "PASSED" | "FAILED" | "INCOMPLETE";
  /** Exceptions can be expected injections; pass/fail comes from durable snapshots and receipts. */
  operationErrors: number; issues: string[]; snapshot?: RecoverySnapshot;
}
export interface RecoveryValidationReport {
  version: "recovery-validation.v1"; runId: string; scope: "FIXTURE" | "TARGET" | "UNAVAILABLE";
  resultClass: "NOT_EXECUTED" | "FIXTURE_EXECUTION" | "ADAPTER_REPORTED_TARGET_EXECUTION";
  adapter?: { id: string; version: string; binding?: RecoveryAdapter["binding"] };
  status: RecoveryCaseResult["status"]; cases: RecoveryCaseResult[]; limitations: string[];
}

function checkSnapshot(s: RecoverySnapshot, scenario: RecoveryCase, amount: number): { failures: string[]; gaps: string[] } {
  const failures: string[] = [], gaps: string[] = [];
  const known=new Set<string>(RECOVERY_CASES.flatMap(c=>[...c.faults]));
  if (!s || ![s.debitedMinor,s.refundedMinor,s.refundCommits,s.fulfillments].every(n=>Number.isSafeInteger(n)&&n>=0) || typeof s.terminal!=="boolean" || !Array.isArray(s.exercisedFaults) || s.exercisedFaults.length>32 || s.exercisedFaults.some(f=>!known.has(f))) return { failures: [], gaps: ["Adapter returned an invalid durable-state snapshot."] };
  if(s.providerOutcome!==scenario.provider)gaps.push("The adapter did not confirm the scenario's definitive provider outcome.");
  if(s.debitedMinor!==amount)failures.push("Expected exactly one debit for the requested amount.");
  if(s.refundCommits>1||s.refundedMinor>amount)failures.push("Duplicate or excess refund detected.");
  if(s.fulfillments>1)failures.push("Duplicate provider fulfillment detected.");
  if(s.fulfillments&&s.refundedMinor)failures.push("Provider fulfillment and refund both occurred.");
  if(scenario.provider==="FULFILLED"){
    if(s.fulfillments!==1||s.refundedMinor!==0||s.refundCommits!==0)failures.push("A fulfilled topup must retain the debit and have no refund.");
  }else if(s.fulfillments!==0||s.refundedMinor!==amount||s.refundCommits!==1)failures.push("A definitively failed topup must have exactly one complete refund and no fulfillment.");
  if(!s.terminal)gaps.push("Recovery did not reach a durable terminal state within the defined attempts.");
  for(const fault of scenario.faults)if(!s.exercisedFaults.includes(fault))gaps.push(`The adapter did not confirm exercising ${fault}.`);
  return {failures,gaps};
}

/** Cooperative deadline only. Adapters must provide their own process/container isolation. */
async function bounded<T>(work: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error("deadline"));},ms);})]); }
  finally { if(timer)clearTimeout(timer); }
}

export async function validateRecovery(adapter?: RecoveryAdapter, options: { amountMinor?: number; caseTimeoutMs?: number } = {}): Promise<RecoveryValidationReport> {
  const amount=options.amountMinor??1000, timeout=options.caseTimeoutMs??3000;
  if(!Number.isSafeInteger(amount)||amount<=0||!Number.isSafeInteger(timeout)||timeout<10||timeout>30000)throw new Error("Use a positive safe integer amount and a case timeout between 10 and 30000 ms.");
  const report:RecoveryValidationReport={version:"recovery-validation.v1",runId:`recovery:${randomUUID()}`,scope:adapter?.scope??"UNAVAILABLE",resultClass:"NOT_EXECUTED",status:"INCOMPLETE",cases:[],limitations:[
    "Results cover the defined scenarios, amount and adapter only; they are not a production guarantee or exhaustive proof.",
    "Durable-state measurements and fault receipts are supplied by the adapter. Source bindings are declarations, not independent attestations.",
    "The runner uses cooperative deadlines. The adapter must provide process/container isolation, provider stubs and cleanup; the runner does not sandbox in-process code.",
    "Amounts exclude fees, commissions, FX and external settlement; those require additional explicit invariants.",
  ]};
  if(!adapter || (adapter.scope==="TARGET"&&(!adapter.binding?.revision||!/^[a-f0-9]{64}$/.test(adapter.binding.sourceSha256)))){
    report.limitations.push(adapter?"Target adapter has no valid revision/source binding.":"No target execution adapter is configured. Static evidence and model replay cannot substitute for one.");
    report.cases=RECOVERY_CASES.map(s=>({scenario:s.id,status:"INCOMPLETE",operationErrors:0,issues:["Execution adapter unavailable or unbound."]}));return report;
  }
  report.adapter={id:adapter.id,version:adapter.version,...(adapter.binding?{binding:{...adapter.binding}}:{})};
  report.resultClass=adapter.scope==="FIXTURE"?"FIXTURE_EXECUTION":"ADAPTER_REPORTED_TARGET_EXECUTION";
  if(adapter.scope==="FIXTURE")report.limitations.push("FIXTURE EXECUTION: these results do not establish behavior of the user's wallet or provider integration.");
  let halted=false;
  for(const scenario of RECOVERY_CASES){
    const result:RecoveryCaseResult={scenario:scenario.id,status:"INCOMPLETE",operationErrors:0,issues:[]};report.cases.push(result);
    if(halted){result.issues.push("Skipped after an adapter deadline or cleanup failure; no overlapping scenarios were started.");continue;}
    const controller=new AbortController();let session:RecoverySession|undefined;
    try {
      await bounded((async()=>{
        const opened=await adapter.open({scenario:structuredClone(scenario),amountMinor:amount,transactionId:`${report.runId}:${scenario.id}`,signal:controller.signal});
        if(controller.signal.aborted){const cleanup=new AbortController();await bounded(opened.close(cleanup.signal),Math.min(timeout,1000),cleanup);throw new Error("late adapter open");}
        session=opened;
        const active=()=>{if(controller.signal.aborted)throw new Error("aborted");};
        const attempt=async(work:()=>Promise<void>)=>{active();try{await work();}catch{active();result.operationErrors++;}active();};
        await attempt(()=>session!.pay(controller.signal));
        if(scenario.id==="pending-across-midnight"){
          if(!session.advanceDay){result.issues.push("Adapter cannot advance the recovery clock.");return;}
          await session.advanceDay(controller.signal);
          active();
        }
        const repeats=Array.from({length:scenario.duplicate},()=>()=>attempt(()=>session!.recover(controller.signal)));
        // Concurrent calls must start against the unsettled transaction, not after a successful recovery.
        if("concurrent" in scenario){await Promise.all(repeats.map(run=>run()));await attempt(()=>session!.recover(controller.signal));}
        else {await attempt(()=>session!.recover(controller.signal));for(const run of repeats)await run();}
        active();const snapshot=await session.snapshot(controller.signal);active();const checks=checkSnapshot(snapshot,scenario,amount);
        if(!checks.gaps.includes("Adapter returned an invalid durable-state snapshot."))result.snapshot={debitedMinor:snapshot.debitedMinor,refundedMinor:snapshot.refundedMinor,refundCommits:snapshot.refundCommits,fulfillments:snapshot.fulfillments,providerOutcome:["FAILED","FULFILLED"].includes(snapshot.providerOutcome)?snapshot.providerOutcome:"UNKNOWN",terminal:snapshot.terminal,exercisedFaults:[...new Set(snapshot.exercisedFaults)]};
        result.issues.push(...checks.failures,...checks.gaps);
        const missingPrecondition=checks.gaps.some(g=>/invalid durable-state|did not confirm/.test(g));
        result.status=missingPrecondition?"INCOMPLETE":checks.failures.length?"FAILED":checks.gaps.length?"INCOMPLETE":"PASSED";
      })(),timeout,controller);
    }catch{
      result.status="INCOMPLETE";result.issues.push(controller.signal.aborted?"Adapter deadline reached; remaining scenarios stopped.":"Adapter setup, clock or snapshot failed; no successful execution conclusion is available.");
      halted=true;
    }finally{
      if(session){const cleanup=new AbortController();try{await bounded(session.close(cleanup.signal),Math.min(timeout,1000),cleanup);}catch{result.issues.push("Adapter cleanup failed; remaining scenarios stopped.");if(result.status==="PASSED")result.status="INCOMPLETE";halted=true;}}
    }
  }
  report.status=report.cases.some(c=>c.status==="FAILED")?"FAILED":report.cases.every(c=>c.status==="PASSED")?"PASSED":"INCOMPLETE";
  return report;
}
