import { CHART_REGISTRY, type ChartId, type WorkflowStep } from "@cie/schema";
import { concernPatterns, type PlanningContext, type AnswerPlan } from "../../answer-planning.ts";
export const id = "interpret";
export default { id, before: ["probe-evidence"], run(ctx) {
  const matched = Object.entries(concernPatterns).filter(([, p]) => p.test(ctx.question)).map(([c]) => c as keyof typeof concernPatterns);
  const primaryConcern = CHART_REGISTRY[ctx.primaryCode as ChartId]?.concern;
  const concerns = [...new Set([...matched, ...(primaryConcern ? [primaryConcern] : [])])];
  const intents: Record<string, AnswerPlan["intent"]> = { Structure: "structure", Behavior: "behavior", Data: "data", "State and rules": "state", Reliability: "reliability", Concurrency: "concurrency", Quality: "quality" };
  ctx.plan = { intent: intents[matched[0] ?? primaryConcern ?? ""] ?? "general", concerns, primaryCode: ctx.primaryCode, supportingCodes: [], scope: ctx.scope, subject: ctx.subject, evidenceStatus: ctx.evidenceKinds ? "checked" : "not-checked" };
} } satisfies WorkflowStep<PlanningContext>;
