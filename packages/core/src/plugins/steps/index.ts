import { RESPONSE_STEPS } from "./registry.generated.ts";
import { runWorkflow } from "./workflow.ts";
import type { PlanningContext } from "../../answer-planning.ts";
export function planResponse(ctx: PlanningContext) { return runWorkflow(RESPONSE_STEPS, ctx); }
