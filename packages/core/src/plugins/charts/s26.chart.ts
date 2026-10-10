import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S26",
  "name": "Metrics / telemetry map",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 5,
  "aliases": [
    "Metrics / telemetry map",
    "metrics telemetry map",
    "metrics map",
    "telemetry map"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [
    "function",
    "method"
  ],
  "offline": "gap",
  "concern": "Quality",
  "renderer": "view-spec",
  "questionAnswered": "Which measurements and monitored components are evidenced?",
  "description": "Metric names as declared in code, with their evidenced meaning and emitters. Declared names only \u2014 this chart never reports live values.",
  "example": "List the metrics this component declares (reservation.fast.success, ledger.insert.ignored, \u2026), what each measures based on the code that emits it, and which functions emit them. Do not invent live values.",
  "needs": []
} as const satisfies ChartDescriptor<"S26">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S26", compileStructuredChartV2(input));
} } satisfies ChartModule<"S26">;
