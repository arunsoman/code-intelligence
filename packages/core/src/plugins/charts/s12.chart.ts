import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S12",
  "name": "Saga / compensation graph",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 3,
  "aliases": [
    "Saga / compensation graph",
    "saga graph",
    "compensation graph"
  ],
  "requiredKinds": [
    "function",
    "method"
  ],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "Reliability",
  "renderer": "view-spec",
  "questionAnswered": "How do failures trigger compensation or recovery?",
  "description": "The forward steps (reserve \u2192 post) and their compensation counterparts (rollback, cancelFast) laid out as a saga graph. Each compensation edge is traced to the code that implements it; missing compensations are flagged as gaps.",
  "example": "Draw a saga compensation graph for the reserve \u2192 post \u2192 ledger flow. Show each forward step alongside its compensation action (rollback, cancelFast), the trigger condition (DB sync failure, provider failure), and cite the code evidence. Mark any forward step that has no visible compensation as a gap.",
  "needs": []
} as const satisfies ChartDescriptor<"S12">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S12", compileStructuredChartV2(input));
} } satisfies ChartModule<"S12">;
