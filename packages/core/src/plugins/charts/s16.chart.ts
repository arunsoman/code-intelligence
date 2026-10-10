import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileClassDiagramV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S16",
  "name": "UML class diagram",
  "form": "GeneratedChart",
  "compiler": "specialized",
  "version": 3,
  "aliases": [
    "UML class diagram",
    "class diagram",
    "uml class diagram"
  ],
  "requiredKinds": [
    "class",
    "interface",
    "enum",
    "field",
    "method"
  ],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "Structure",
  "renderer": "view-spec",
  "questionAnswered": "What types, members, and type relationships exist?",
  "description": "Classes, interfaces, enums and their attributes and operations, with inheritance (hollow triangle), realization, association, aggregation/composition (diamond at the owner end) and dependency relations. Relations not declared in source are drawn dashed and named as inferred.",
  "example": "Draw a UML class diagram for the bookkeeping domain: classes with their evidenced attributes and operations, inheritance and realization between them, and the associations the code declares. Mark anything not declared in source as inferred and list gaps.",
  "needs": []
} as const satisfies ChartDescriptor<"S16">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S16", compileClassDiagramV2(input));
} } satisfies ChartModule<"S16">;
