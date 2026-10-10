export interface CaptureResult { code:string; name:string; file:string|null; skipped:boolean; error?:string; stage?:string; diagnosticFile?:string; blocked?:boolean }
export function captureReport(results:CaptureResult[]) {
 const entries=results.map(r=>({...r,status:r.blocked?"blocked":r.error?"failed":r.skipped?"unavailable":"captured"}));
 const count=(status:string)=>entries.filter(r=>r.status===status).length;
 return {schemaVersion:"capture-report.v1",attempted:entries.length,counts:{captured:count("captured"),unavailable:count("unavailable"),failed:count("failed"),blocked:count("blocked")},entries};
}
