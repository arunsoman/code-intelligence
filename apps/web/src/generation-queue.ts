export type GenerationOutcome<T> = { status: "completed"; value: T } | { status: "cancelled" } | { status: "failed"; message: string };
type Priority = "foreground" | "supporting";
interface Job<T> {
 key: string; priority: Priority; controller: AbortController; started: boolean;
 run: (signal: AbortSignal) => Promise<T>; onStart?: () => void;
 promise: Promise<GenerationOutcome<T>>; resolve: (result: GenerationOutcome<T>) => void;
}
/** Browser-side generation budget. Cancelling a running job holds its slot until it settles. */
export class GenerationQueue<T> {
 private jobs = new Map<string,Job<T>>();
 private queued: Job<T>[] = [];
 private active = 0;
 readonly concurrency: number; readonly pendingLimit: number; readonly timeoutMs: number;
 constructor(concurrency = 2, pendingLimit = 6, timeoutMs = 180000) {
  this.concurrency=concurrency;this.pendingLimit=pendingLimit;this.timeoutMs=timeoutMs;
  if(!Number.isInteger(concurrency)||concurrency<1||!Number.isInteger(pendingLimit)||pendingLimit<0||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error("Invalid generation budget");
 }
 has(key: string) { return this.jobs.has(key); }
 promote(key: string) { const job=this.jobs.get(key); if(job&&!job.started)job.priority="foreground"; }
 enqueue(key: string, run: Job<T>["run"], priority: Priority = "foreground", onStart?: () => void): Promise<GenerationOutcome<T>> {
  const existing=this.jobs.get(key);
  if(existing){if(priority==="foreground")this.promote(key);return existing.promise;}
  if(this.active>=this.concurrency && this.queued.length>=this.pendingLimit)return Promise.resolve({status:"failed",message:"The generation queue is full. Retry after a view finishes."});
  let resolve!: Job<T>["resolve"];
  const promise=new Promise<GenerationOutcome<T>>(done=>{resolve=done;});
  const job:Job<T>={key,run,priority,onStart,promise,resolve,controller:new AbortController(),started:false};
  this.jobs.set(key,job);this.queued.push(job);this.drain();return promise;
 }
 cancel(key: string) {
  const job=this.jobs.get(key);if(!job)return;
  job.controller.abort();job.resolve({status:"cancelled"});this.jobs.delete(key);
  this.queued=this.queued.filter(j=>j!==job);
 }
 cancelAll() { for(const key of [...this.jobs.keys()])this.cancel(key); }
 private drain() {
  while(this.active<this.concurrency && this.queued.length){
   const index=this.queued.findIndex(j=>j.priority==="foreground");
   const job=this.queued.splice(index<0?0:index,1)[0];job.started=true;this.active++;
   void this.execute(job);
  }
 }
 private async execute(job: Job<T>) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
   job.onStart?.();
   const timeout=new Promise<GenerationOutcome<T>>(resolve=>{timer=setTimeout(()=>{
    job.controller.abort();resolve({status:"failed",message:`Generation timed out after ${Math.round(this.timeoutMs/1000)} seconds. Retry this view.`});
   },this.timeoutMs);});
   const result=Promise.resolve().then(()=>job.run(job.controller.signal)).then(value=>({status:"completed" as const,value}),error=>({status:"failed" as const,message:error instanceof Error?error.message:String(error)}));
   const outcome=await Promise.race([timeout,result]);
   job.resolve(outcome);
  } catch(error) { job.resolve({status:"failed",message:error instanceof Error?error.message:String(error)}); }
  finally {
   clearTimeout(timer);if(this.jobs.get(job.key)===job)this.jobs.delete(job.key);
   this.active--;this.drain();
  }
 }
}
