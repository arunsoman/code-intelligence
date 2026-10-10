import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileLegacyChartPlan } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "generic",
  "name": "Generated chart",
  "form": "GeneratedChart",
  "compiler": "standard",
  "version": 3,
  "aliases": [
    "Generated chart"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [],
  "offline": "derived",
  "concern": "Other views",
  "renderer": "view-spec",
  "questionAnswered": "What relationships in the indexed evidence answer this question?",
  "description": "Evidence-grounded Generated chart",
  "example": "Show Generated chart",
  "needs": []
} as const satisfies ChartDescriptor<"generic">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("generic", compileLegacyChartPlan(input));
} } satisfies ChartModule<"generic">;
