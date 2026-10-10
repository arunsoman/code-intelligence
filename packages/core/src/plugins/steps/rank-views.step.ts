import type { WorkflowStep } from "@cie/schema";
import { rankSupporting, type PlanningContext } from "../../answer-planning.ts";
export const id = "rank-views";
export default { id, after: ["probe-evidence"], run(ctx) { ctx.plan!.supportingCodes = rankSupporting(ctx); } } satisfies WorkflowStep<PlanningContext>;
