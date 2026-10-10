import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S25",
  "name": "FMEA / compensation matrix",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 4,
  "aliases": [
    "FMEA / compensation matrix",
    "fmea compensation matrix",
    "fmea matrix",
    "failure mode analysis"
  ],
  "requiredKinds": [
    "function",
    "method"
  ],
  "requiredAcrossRepository": [
    "function",
    "method"
  ],
  "offline": "gap",
  "concern": "Reliability",
  "renderer": "table",
  "questionAnswered": "What failure modes and mitigations are evidenced?",
  "description": "Failure mode \u00d7 impact \u00d7 compensation as a table, each cell backed by source or test evidence. A failure with no evidenced compensation is listed as a gap, never assumed recoverable.",
  "example": "Build an FMEA matrix for the reserve fast path: Redis reserve failure, DB sync failure, provider failure, duplicate post. For each, the evidenced impact and the compensation in the code (cancelFast, rollback, INSERT IGNORE), and mark any failure without a compensation.",
  "needs": []
} as const satisfies ChartDescriptor<"S25">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S25", compileStructuredChartV2(input));
} } satisfies ChartModule<"S25">;
