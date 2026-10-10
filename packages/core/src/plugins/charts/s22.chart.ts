import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S22",
  "name": "Layered architecture",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 4,
  "aliases": [
    "Layered architecture",
    "layered architecture",
    "layer diagram",
    "layered architecture diagram"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "Structure",
  "renderer": "view-spec",
  "questionAnswered": "What layers and dependencies are evidenced?",
  "description": "Components grouped into named, ordered layers (API, service, domain, infrastructure\u2026), with uses/calls and asynchronous dependencies between them. Layers only appear when the code evidences them.",
  "example": "Draw the layered architecture of this service: an API layer, an application-service layer, a domain layer and an infrastructure layer, with the components the code places in each and the dependencies between layers.",
  "needs": []
} as const satisfies ChartDescriptor<"S22">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S22", compileStructuredChartV2(input));
} } satisfies ChartModule<"S22">;
