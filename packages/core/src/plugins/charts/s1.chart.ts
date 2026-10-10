import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileLegacyChartPlan } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S1",
  "name": "Container / component architecture",
  "form": "GeneratedChart",
  "compiler": "standard",
  "version": 3,
  "aliases": [
    "C4 container / component architecture",
    "C4 container component architecture",
    "C4 component diagram",
    "container diagram",
    "architecture diagram"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [],
  "offline": "derived",
  "concern": "Structure",
  "renderer": "view-spec",
  "questionAnswered": "How are the main components connected?",
  "description": "Show the main components and who calls what, rendered as an evidence-grounded component graph. Architecture boundaries (Redis, MySQL and other stores) appear only where the indexed code names them; unsupported boundaries are listed as gaps instead of drawn. Also covers UML component, deployment and hexagonal port-and-adapter layouts.",
  "example": "Build a container architecture diagram for the reserve fast path. Show who calls what and distinguish Redis from MySQL using repository evidence.",
  "needs": []
} as const satisfies ChartDescriptor<"S1">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S1", compileLegacyChartPlan(input));
} } satisfies ChartModule<"S1">;
