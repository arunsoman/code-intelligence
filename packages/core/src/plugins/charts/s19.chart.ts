import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S19",
  "name": "UML interaction overview",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 4,
  "aliases": [
    "UML interaction overview",
    "interaction overview diagram",
    "uml interaction overview"
  ],
  "requiredKinds": [
    "function",
    "method"
  ],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "Behavior",
  "renderer": "view-spec",
  "questionAnswered": "How do interactions compose into a larger flow?",
  "description": "The control-flow between interactions: initial and final markers, interaction frames that name the nested interaction they refer to, and decision points with guards on the outgoing flows.",
  "example": "Draw an interaction overview for the bookkeeping lifecycle: one interaction frame per operation (reserve, post, rollback), connected through decision points with the guards the code evidences.",
  "needs": []
} as const satisfies ChartDescriptor<"S19">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S19", compileStructuredChartV2(input));
} } satisfies ChartModule<"S19">;
