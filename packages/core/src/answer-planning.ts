import { CHART_REGISTRY, type Concern, type ViewSpec } from "@cie/schema";
import type { CatalogEntry } from "./visuals.ts";
export const concernPatterns: Record<Concern, RegExp> = {
  Structure: /architect|component|module|package|class|repo|system|structure|wired/i,
  Behavior: /flow|sequence|process|happen|work|implement|method|call|logic|checkout|behavior/i,
  Data: /data|schema|table|persist|read|writ|storage|entity|database/i,
  "State and rules": /state|lifecycle|transition|condition|guard|branch|rule/i,
  Reliability: /fail|recover|retry|retries|timeout|compensat|rollback|idempoten|duplicate/i,
  Concurrency: /concurren|race|thread|parallel|lock|simultaneous/i,
  Quality: /test|coverage|metric|profile|hotspot|performance|security|trust/i,
  "Other views": /(?!) /,
};
export const nativeConcerns: Record<string, Concern> = { V5: "Data", V10: "Concurrency", V12: "Quality", V17: "Quality", V8: "Quality" };
export interface AnswerPlan {
  intent: "structure" | "behavior" | "data" | "state" | "reliability" | "concurrency" | "quality" | "general";
  concerns: Concern[]; primaryCode: string; supportingCodes: string[];
  scope: "subject" | "repository"; subject?: string;
  evidenceStatus: "checked" | "not-checked";
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
  const plan = ctx.plan!, choices = Object.values(CHART_REGISTRY).filter(d => d.id !== "generic" && d.id !== ctx.primaryCode && plan.concerns.includes(d.concern) && ctx.availability.get(d.id)?.available);
  const explicit = (id: string) => { const i = preferred[plan.intent]?.indexOf(id) ?? -1; return i < 0 ? 100 : i; };
  const candidates: { id: string; concern: Concern }[] = [...choices, ...ctx.catalog.filter(n => n.available && n.code !== ctx.primaryCode && nativeConcerns[n.code] && plan.concerns.includes(nativeConcerns[n.code])).map(n => ({ id: n.code, concern: nativeConcerns[n.code] }))];
  candidates.sort((a,b) => explicit(a.id) - explicit(b.id) || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  // First show one perspective per concern, then fill spare slots deterministically.
  const ranked: string[] = [];
  for (const concern of plan.concerns) { const d = candidates.find(d => d.concern === concern); if (d) ranked.push(d.id); }
  for (const d of candidates) if (!ranked.includes(d.id)) ranked.push(d.id);
  return ranked.slice(0,3);
}
