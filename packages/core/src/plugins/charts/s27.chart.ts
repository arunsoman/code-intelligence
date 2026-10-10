import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S27",
  "name": "System context",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 3,
  "aliases": [
    "C4 context diagram",
    "c4 context diagram",
    "context diagram"
  ],
  "requiredKinds": [
    "class",
    "function"
  ],
  "requiredAcrossRepository": [
    "class",
    "function"
  ],
  "offline": "gap",
  "concern": "Structure",
  "renderer": "view-spec",
  "questionAnswered": "What actors, systems, and external boundaries are evidenced?",
  "description": "The widest view: people, the subject software system and external systems, with labelled relationships (operation, protocol or data purpose). Containers and components stay out of scope at context level (use S1 for those).",
  "example": "Draw a system context diagram for the bookkeeping system: the caller and admin roles, the bookkeeping system itself, and Redis, MySQL and the provider as external systems, with the evidenced operations on each relationship.",
  "needs": []
} as const satisfies ChartDescriptor<"S27">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S27", compileStructuredChartV2(input));
} } satisfies ChartModule<"S27">;
