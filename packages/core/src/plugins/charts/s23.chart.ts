import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S23",
  "name": "Dependency / module graph",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 4,
  "aliases": [
    "Dependency / module graph",
    "dependency module graph",
    "module graph",
    "dependency graph",
    "module dependency diagram"
  ],
  "requiredKinds": [
    "module",
    "package",
    "crate",
    "workspace",
    "class",
    "interface",
    "function",
    "method"
  ],
  "requiredAcrossRepository": [
    "module",
    "package",
    "crate",
    "workspace",
    "class",
    "interface",
    "function",
    "method"
  ],
  "offline": "gap",
  "concern": "Structure",
  "renderer": "view-spec",
  "questionAnswered": "How are modules and components connected?",
  "description": "Modules, packages and crates with the dependencies between them, labelled by kind (compile-time, runtime, test-only). Cycles and unsupported dependencies are shown as what they are.",
  "example": "Draw the module dependency graph for this repository: each module/package, whether dependencies are compile-time, runtime or test-only, and any circular dependency the resolved graph contains.",
  "needs": []
} as const satisfies ChartDescriptor<"S23">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S23", compileStructuredChartV2(input));
} } satisfies ChartModule<"S23">;
