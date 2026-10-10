import { CHART_REGISTRY, type ChartId, type WorkflowStep } from "@cie/schema";
import { matchConcerns, type PlanningContext, type AnswerPlan } from "../../answer-planning.ts";
export const id = "interpret";
export default { id, before: ["probe-evidence"], run(ctx) {
  const matches=matchConcerns(ctx.question);
  const matched=matches.map(m=>m.concern);
  const primaryConcern = CHART_REGISTRY[ctx.primaryCode as ChartId]?.concern;
  const concerns = [...new Set([...matched, ...(primaryConcern ? [primaryConcern] : [])])];
  const intents: Record<string, AnswerPlan["intent"]> = { Structure: "structure", Behavior: "behavior", Data: "data", "State and rules": "state", Reliability: "reliability", Concurrency: "concurrency", Quality: "quality" };
  ctx.plan = { intent: intents[matched[0] ?? primaryConcern ?? ""] ?? "general", concerns, primaryCode: ctx.primaryCode, supportingCodes: [], scope: ctx.scope, subject: ctx.subject, evidenceStatus: ctx.evidenceKinds ? "checked" : "not-checked", classification: {basis:matched.length?"keyword":primaryConcern?"primary-view":"general",matches} };
} } satisfies WorkflowStep<PlanningContext>;
