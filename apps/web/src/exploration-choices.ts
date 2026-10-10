import { CHART_REGISTRY, type ChartId, type Concern, type ResponseManifest, type ViewSpec } from "@cie/schema";
export interface ExplorationChoice { label: string; code: string; form: string; concern: string; questionAnswered: string; disabled: boolean; reason: string; availability: "requestable" | "unavailable" | "unchecked"; recommended: boolean }
export interface ExplorationTarget { label: string; kind: string; entityRefs: string[]; nodeIds: string[]; source: "element" | "flow" | "selection"; limitation?: string }
export interface ExplorationEdge { viewId: string; nodeIds: string[]; label: string }
const unique = (values: string[]) => [...new Set(values)];
export function explorationTarget(view: ViewSpec | null, selection: string[], edge?: ExplorationEdge | null): ExplorationTarget | undefined {
 if (!view || !selection.length) return;
 const nodes=view.nodes.filter(n=>selection.includes(n.id));
 if (!nodes.length) return;
 const refs=unique(nodes.flatMap(n=>n.entityRefs));
 if (!refs.length) return;
 const flow=edge?.viewId===view.id && edge.nodeIds.length===selection.length && edge.nodeIds.every(id=>selection.includes(id));
 return { label: flow ? edge!.label : nodes.length===1 ? nodes[0].label : `${nodes.length} selected elements`, kind: flow ? "flow" : nodes.length===1 ? nodes[0].kind : "component", entityRefs: refs.slice(0,40), nodeIds: nodes.map(n=>n.id), source: flow ? "flow" : nodes.length===1 ? "element" : "selection", ...((nodes.some(n=>!n.entityRefs.length) || refs.length>40) ? {limitation:[nodes.some(n=>!n.entityRefs.length) ? "This scope uses source-backed members; unbound diagram elements are not included." : "",refs.length>40 ? "This request uses the first 40 source entities. Narrow the selection to explore the remaining members." : ""].filter(Boolean).join(" ")} : {}) };
}
const priorities = (kind: string): ChartId[] => {
 if (kind === "flow") return ["S2","S28","S21","S12","S14","S10","S3"];
 if (["table","column"].includes(kind)) return ["S9","S10","S16","S3","S12","S21"];
 if (["method","function"].includes(kind)) return ["S21","S2","S28","S11","S14","S12","S23"];
 if (["class","interface","type","enum"].includes(kind)) return ["S16","S21","S28","S23","S9","S3","S12"];
 return ["S23","S1","S2","S28","S9","S3","S12"];
};
/** Revision preflight is reusable; a parent result's status is not a verdict on a newly selected subject. */
export function explorationChoices(kind: string, manifest?: ResponseManifest | null, revision?: string): ExplorationChoice[] {
 const compatible=manifest && (!revision || manifest.revision===revision) ? manifest : undefined;
 const ordered=priorities(kind), candidates=Object.values(CHART_REGISTRY).filter(d=>d.id!=="generic");
 candidates.sort((a,b)=>{const ai=ordered.indexOf(a.id),bi=ordered.indexOf(b.id);return (ai<0?100:ai)-(bi<0?100:bi)||Number(a.id.slice(1))-Number(b.id.slice(1));});
 const choices: ExplorationChoice[]=candidates.map(d=>{
  const preflight=compatible?.explorationAvailability?.find(a=>a.code===d.id);
  const unavailable=d.compiler==="missing" || preflight?.available===false;
  const availability=unavailable ? "unavailable" : preflight ? "requestable" : "unchecked";
  return {code:d.id,form:d.form,label:d.name,concern:d.concern,questionAnswered:d.questionAnswered,disabled:unavailable,availability,reason:unavailable ? preflight?.reason ?? (d.compiler==="missing" ? "No compiler is implemented for this notation yet." : "Revision preflight did not find the required evidence.") : preflight ? `${preflight.reason ?? "Revision preflight passed."} Selected-subject evidence is checked during generation.` : "Availability has not been checked for this revision; selected-subject evidence will be checked during generation.",recommended:ordered.includes(d.id)};
 });
 const native=compatible?.views.find(v=>v.code==="V10"),preflight=compatible?.explorationAvailability?.find(a=>a.code==="V10");
 choices.push({code:"V10",form:native?.form??"RaceWindow",label:"Concurrency",concern:"Concurrency",questionAnswered:"Where can concurrent execution create races or unsafe interleavings?",disabled:!preflight?.available,availability:preflight?.available ? "requestable" : preflight ? "unavailable" : "unchecked",reason:preflight?.reason??"Concurrency availability has not been checked for this revision.",recommended:kind==="flow"||["method","function"].includes(kind)});
 return choices;
}
export const EXPLORATION_CONCERNS: Concern[] = ["Structure","Behavior","Data","State and rules","Reliability","Concurrency","Quality","Other views"];
export function explorationQuestion(choice: ExplorationChoice,target: ExplorationTarget): string {
 return `${choice.questionAnswered} Focus on ${target.source==="flow" ? "the flow" : "the selected scope"}: ${target.label}.`;
}
export function explorationShortcut(text: string, choices: ExplorationChoice[]): ExplorationChoice | undefined {
 return choices.find(c => text.trim().toLowerCase() === `explore ${c.label.toLowerCase()}`);
}
