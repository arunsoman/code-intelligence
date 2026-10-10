import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileLegacyChartPlan } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S5",
  "name": "test-guarantee matrix",
  "form": "TestConfidence",
  "compiler": "standard",
  "version": 3,
  "aliases": [
    "test-guarantee matrix",
    "test guarantee matrix",
    "test traceability matrix"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [],
  "offline": "derived",
  "concern": "Quality",
  "renderer": "view-spec",
  "questionAnswered": "Which tests support the selected behaviors?",
  "description": "Map tests to behaviors and named invariants. Code reach and test names are signals; they do not alone prove an invariant.",
  "example": "Which tests support each reserve and ledger invariant? Separate tests that only reach code from tests whose names indicate an assertion, and show untested gaps.",
  "needs": [
    "tests"
  ]
} as const satisfies ChartDescriptor<"S5">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S5", compileLegacyChartPlan(input));
} } satisfies ChartModule<"S5">;
