import { CHART_REGISTRY, type Concern, type ViewSpec } from "@cie/schema";
import type { CatalogEntry } from "./visuals.ts";
/** Word boundaries avoid accidental intents such as test in latest or lock in clock. */
export const concernPatterns: Record<Concern, RegExp> = {
  Structure: /\b(?:architect\w*|components?|modules?|packages?|class(?:es)?|repos?|repository|repositories|systems?|structures?|wired|wiring)\b/i,
  Behavior: /\b(?:flows?|workflows?|activities|activity|swimlanes?|sequences?|process(?:es)?|happens?|works?|implement\w*|methods?|calls?|logic|checkout|behavio[u]?r)\b/i,
  Data: /\b(?:data|schemas?|tables?|persist\w*|reads?|writes?|storage|entities|entity|databases?)\b/i,
  "State and rules": /\b(?:states?|lifecycle|transitions?|conditions?|guards?|branch(?:es)?|rules?)\b/i,
  Reliability: /\b(?:fail\w*|recover\w*|retry|retries|timeouts?|compensat\w*|rollbacks?|idempoten\w*|duplicates?)\b/i,
  Concurrency: /\b(?:concurren\w*|races?|threads?|parallel\w*|locks?|locking|simultaneous\w*)\b/i,
  Quality: /\b(?:tests?|testing|coverage|metrics?|profiles?|profiling|hotspots?|performance|security|trust)\b/i,
  "Other views": /(?!) /,
};
export interface IntentMatch { concern: Concern; terms: string[]; firstIndex: number }
export function matchConcerns(question: string): IntentMatch[] {
  return Object.entries(concernPatterns).flatMap(([concern,pattern])=>{
    const hits=[...question.matchAll(new RegExp(pattern.source,"gi"))];
    return hits.length ? [{concern:concern as Concern,terms:[...new Set(hits.map(h=>h[0].toLowerCase()))],firstIndex:hits[0].index!}] : [];
  }).sort((a,b)=>a.firstIndex-b.firstIndex || (a.concern<b.concern?-1:a.concern>b.concern?1:0));
}
export const nativeConcerns: Record<string, Concern> = { V5: "Data", V10: "Concurrency", V12: "Quality", V17: "Quality", V8: "Quality" };
export interface AnswerPlan {
  intent: "structure" | "behavior" | "data" | "state" | "reliability" | "concurrency" | "quality" | "general";
  concerns: Concern[]; primaryCode: string; supportingCodes: string[];
  scope: "subject" | "repository"; subject?: string;
  evidenceStatus: "checked" | "not-checked";
  classification?: { basis: "keyword" | "primary-view" | "general"; matches: IntentMatch[] };
  recommendations?: { code: string; score: number; reasons: string[] }[];
}
export interface PlanningContext {
  question: string; primaryCode: string; views: ViewSpec[]; catalog: CatalogEntry[];
  scope: "subject" | "repository"; subject?: string;
  /** Repository-wide indexed counts. Absence is unknown, never proof of missing evidence. */
  evidenceKinds?: Record<string, number>;
  plan?: AnswerPlan; availability: Map<string, { available: boolean; reason?: string }>;
}
export function probeCharts(ctx: PlanningContext) {
  for (const d of Object.values(CHART_REGISTRY)) {
    const native = ctx.catalog.find(n => n.formId === d.form);
    let available = d.compiler !== "missing" && (d.form === "GeneratedChart" || !!native?.available);
    let reason = d.compiler === "missing" ? "No compiler is implemented for this notation yet." : native?.reason;
    // Retrieval hints are alternatives, not an all-of semantic proof contract.
    const kinds = d.requiredAcrossRepository.length ? d.requiredAcrossRepository : d.requiredKinds;
    if (available && ctx.evidenceKinds && kinds.length && !kinds.some(k => (ctx.evidenceKinds![k] ?? 0) > 0)) {
      available = false; reason = `No indexed ${kinds.join(" or ")} entities exist in this revision. Import or index matching sources first.`;
    }
    ctx.availability.set(d.id, { available, reason: reason ?? (ctx.evidenceKinds ? "Indexed entity preflight passed; semantic evidence is checked during generation." : "Evidence availability has not been checked yet.") });
  }
}
const preferred: Partial<Record<AnswerPlan["intent"], readonly string[]>> = {
  structure: ["S1", "S23", "S16", "S27"], behavior: ["S28", "S21", "S7"],
  data: ["S9", "S10"], state: ["S24", "S11"], reliability: ["S12", "S25", "S14"],
};
export function rankSupporting(ctx: PlanningContext): string[] {
  const plan=ctx.plan!;
  const choices=Object.values(CHART_REGISTRY).filter(d=>d.id!=="generic" && d.id!==ctx.primaryCode && plan.concerns.includes(d.concern) && ctx.availability.get(d.id)?.available);
  const candidates=[...choices.map(d=>({id:d.id,concern:d.concern,name:d.name,aliases:d.aliases,native:false})),
    ...ctx.catalog.filter(n=>n.available && n.formId!=="HypothesisGraph" && n.code!==ctx.primaryCode && nativeConcerns[n.code] && plan.concerns.includes(nativeConcerns[n.code])).map(n=>({id:n.code,concern:nativeConcerns[n.code],name:n.name,aliases:[] as readonly string[],native:true}))];
  const normalized=(text:string)=>` ${text.toLowerCase().replace(/[^a-z0-9]+/g," ").trim()} `;
  const question=normalized(ctx.question);
  const unique=new Map<string,{code:string;concern:Concern;score:number;reasons:string[]}>();
  for(const d of candidates){
    const index=plan.concerns.indexOf(d.concern), match=plan.classification?.matches.find(m=>m.concern===d.concern);
    const scoreBase=(plan.concerns.length-index)*100;
    const preference=preferred[plan.intent]?.indexOf(d.id)??-1;
    const named=[d.name,...d.aliases].some(name=>name.trim().length>=3 && question.includes(normalized(name)));
    const reasons=[match ? `Matches ${d.concern.toLowerCase()} terms: ${match.terms.join(", ")}.` : `Adds the ${d.concern.toLowerCase()} perspective of the primary view.`];
    if(named)reasons.push("This notation is named in the question.");
    if(preference>=0)reasons.push(`Preferred supporting notation for ${plan.intent} questions.`);
    reasons.push(d.native ? "The revision catalog reports this native view as available; semantic evidence remains unverified until generation." : ctx.evidenceKinds ? "Revision entity preflight passed; semantic evidence remains unverified until generation." : "Requestable; evidence preflight has not been checked.");
    const candidate={code:d.id,concern:d.concern,score:scoreBase+(named?50:0)+(preference>=0?25-preference*2:0),reasons};
    if(!unique.has(d.id)||unique.get(d.id)!.score<candidate.score)unique.set(d.id,candidate);
  }
  const ranked=[...unique.values()].sort((a,b)=>b.score-a.score || Number(a.code.slice(1))-Number(b.code.slice(1)) || (a.code<b.code?-1:a.code>b.code?1:0));
  // Cover each requested concern before spending remaining slots on another notation.
  const selected:typeof ranked=[];
  for(const concern of plan.concerns){const next=ranked.find(d=>d.concern===concern);if(next)selected.push(next);if(selected.length===3)break;}
  for(const next of ranked){if(selected.length===3)break;if(!selected.some(d=>d.code===next.code))selected.push(next);}
  plan.recommendations=selected.map(({code,score,reasons})=>({code,score,reasons}));
  return selected.map(d=>d.code);
}
