import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S24",
  "name": "State transition table",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 4,
  "aliases": [
    "State transition table",
    "state transition table",
    "transition table"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "State and rules",
  "renderer": "table",
  "questionAnswered": "Which triggers move between states?",
  "description": "A real table: current state \u00d7 event \u2192 next state, with guards and forbidden transitions as negative facts. Combinations the source does not cover stay visibly unknown.",
  "example": "Build the state transition table for the batchId lifecycle: rows for NoState, Reserved, Posted and RolledBack; columns for reserve, post and rollback; each cell names the next state and its guard, and forbidden transitions (rollback after post) are marked as forbidden.",
  "needs": []
} as const satisfies ChartDescriptor<"S24">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S24", compileStructuredChartV2(input));
} } satisfies ChartModule<"S24">;
