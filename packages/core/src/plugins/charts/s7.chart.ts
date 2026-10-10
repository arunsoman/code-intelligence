import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileBpmnV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S7",
  "name": "BPMN process diagram",
  "form": "GeneratedChart",
  "compiler": "specialized",
  "version": 4,
  "aliases": [
    "BPMN process diagram",
    "bpmn diagram",
    "business process diagram"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "Behavior",
  "renderer": "view-spec",
  "questionAnswered": "What activities, decisions, and participants make up this process?",
  "description": "Business-process view: start/end events, tasks, XOR gateways and compensation boundaries, arranged as a BPMN-style flow grounded in indexed control-flow and error-handling evidence.",
  "example": "Draw a BPMN process diagram for the reserve \u2192 post / rollback flow. Show start and end events, decision gateways for provider response and DB sync, and the compensation boundary around cancelFast. Use only evidence from the indexed code.",
  "needs": []
} as const satisfies ChartDescriptor<"S7">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S7", compileBpmnV2(input));
} } satisfies ChartModule<"S7">;
