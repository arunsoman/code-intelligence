/** Presentation of inspected static observations. Never an answer-verification verdict. */
export interface EvidenceTrace {
  version:"evidence-trace.v1"; revision:string; snapshotId?:string;
  provenance:"AVAILABLE"|"UNAVAILABLE";
  coverage:"PARTIAL"; truncated:boolean;
  items:{kind:"FACT"|"RELATIONSHIP";id:string;label:string;entityIds:string[];
    sources:{evidenceId:string;file:string;startByte:number;endByteExclusive:number;
      producer?:{id:string;version:string;runId:string}}[]}[];
  limitations:string[];
}
