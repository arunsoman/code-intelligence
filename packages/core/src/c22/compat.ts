// C22 compatibility projection (design §4): the five original APIs keep their shapes. The projection loses information
// (contested, stale, paused and failed collapse to fewer states), and says so: new clients should read the v2 snapshot.
import type { HypothesisRecord, InvestigationSnapshot, StepRecord } from "./types.ts";

export type LegacyPlanState = "READY" | "RUNNING" | "BLOCKED" | "FINISHED" | "CANCELLED";
export type LegacyStepState = "PENDING" | "RUNNING" | "DONE" | "BLOCKED" | "CANCELLED";
export type LegacyHypothesisState = "OPEN" | "SUPPORTED" | "REFUTED" | "UNRESOLVED";

export interface InvestigationPlan {
  id: string; workspaceId: string; version: number; state: LegacyPlanState;
  scope: { revision: string; roots: string[]; incidentWindow: { start: string; end: string } | null };
  maxSteps: number; remainingBudget: { toolSteps: number; tokens: number; cost: number };
  steps: { id: string; tool: string; state: LegacyStepState; checkId: string | null }[];
  /** What this projection leaves out; read the v2 snapshot for it. */
  lossy: string[];
}

export const planState = (s: InvestigationSnapshot["execution"]): LegacyPlanState =>
  s === "CREATED" || s === "READY" ? "READY" : s === "RUNNING" ? "RUNNING" : s === "FINISHED" ? "FINISHED" : s === "CANCELLED" ? "CANCELLED" : "BLOCKED";
export const stepState = (s: StepRecord["state"]): LegacyStepState =>
  s === "PENDING" || s === "READY" ? "PENDING" : s === "RUNNING" ? "RUNNING" : s === "SUCCEEDED" ? "DONE" : s === "CANCELLED" || s === "SUPERSEDED" ? "CANCELLED" : "BLOCKED";
export const hypothesisState = (s: HypothesisRecord["evaluation"]["state"]): LegacyHypothesisState => (s === "CONTESTED" ? "UNRESOLVED" : s);

export function toPlan(s: InvestigationSnapshot, steps: StepRecord[]): InvestigationPlan {
  const lossy: string[] = [];
  if (s.execution === "PAUSED" || s.execution === "WAITING" || s.execution === "STOPPING" || s.execution === "FAILED") lossy.push(`execution is ${s.execution}, shown here as BLOCKED`);
  if (s.closure === "FINALIZED") lossy.push("the investigation is finalized");
  return {
    id: s.id, workspaceId: s.workspaceId, version: s.version, state: planState(s.execution), scope: { revision: s.scope.revision, roots: s.scope.roots, incidentWindow: s.scope.incidentWindow },
    maxSteps: s.policy.maxPlanSteps, remainingBudget: { toolSteps: Math.max(0, s.budget.limit.toolSteps - s.budget.consumed.toolSteps - s.budget.reserved.toolSteps), tokens: Math.max(0, s.budget.limit.tokens - s.budget.consumed.tokens), cost: Math.max(0, s.budget.limit.cost - s.budget.consumed.cost) },
    steps: steps.map((x) => ({ id: x.id, tool: x.toolId, state: stepState(x.state), checkId: x.checkId })), lossy,
  };
}
