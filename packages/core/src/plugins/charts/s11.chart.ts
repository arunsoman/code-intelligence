import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileDecisionTableV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S11",
  "name": "Decision table",
  "form": "GeneratedChart",
  "compiler": "specialized",
  "version": 4,
  "aliases": [
    "Decision table",
    "decision matrix",
    "decision table"
  ],
  "requiredKinds": [
    "field"
  ],
  "requiredAcrossRepository": [
    "function",
    "method"
  ],
  "offline": "gap",
  "concern": "State and rules",
  "renderer": "table",
  "questionAnswered": "Which conditions determine each outcome?",
  "description": "Guard conditions (state exists, balance sufficient, DB sync result) mapped to outcomes (return existing, throw, compensate, persist). Each row is grounded in a branch condition visible in the indexed control-flow.",
  "example": "Build a decision table for the reserve operation. Rows are combinations of: state-already-exists, balance-sufficient, DB-sync-succeeded. Columns are the outcome actions. Cite the code branch that produces each outcome and mark any combination not evidenced in the code as a gap.",
  "needs": []
} as const satisfies ChartDescriptor<"S11">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S11", compileDecisionTableV2(input));
} } satisfies ChartModule<"S11">;
