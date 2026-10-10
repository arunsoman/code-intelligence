import type { WorkflowStep } from "@cie/schema";
import { probeCharts, type PlanningContext } from "../../answer-planning.ts";
export const id = "probe-evidence";
export default { id, after: ["interpret"], before: ["rank-views"], run: probeCharts } satisfies WorkflowStep<PlanningContext>;
