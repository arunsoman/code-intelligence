import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S17",
  "name": "UML package diagram",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 3,
  "aliases": [
    "UML package diagram",
    "package diagram",
    "uml package diagram"
  ],
  "requiredKinds": [
    "class",
    "interface",
    "module",
    "package",
    "function",
    "method"
  ],
  "requiredAcrossRepository": [
    "class",
    "interface",
    "module",
    "package",
    "function",
    "method"
  ],
  "offline": "gap",
  "concern": "Structure",
  "renderer": "view-spec",
  "questionAnswered": "How are packages connected?",
  "description": "Packages/namespaces with their evidenced members and the dependencies between them, drawn dashed. Members come from the indexed declarations only.",
  "example": "Draw a UML package diagram for this repository: the main packages, the classes or modules each contains, and which packages depend on which. Cite the declarations that evidence each dependency and list gaps.",
  "needs": []
} as const satisfies ChartDescriptor<"S17">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S17", compileStructuredChartV2(input));
} } satisfies ChartModule<"S17">;
