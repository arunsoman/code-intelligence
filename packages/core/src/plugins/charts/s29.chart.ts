import type { ChartDescriptor, ChartModule } from "@cie/schema";

export const descriptor = {
  "id": "S29",
  "name": "Control flow graph",
  "form": "GeneratedChart",
  "compiler": "missing",
  "version": 3,
  "aliases": [
    "Control flow graph",
    "control flow graph",
    "cfg",
    "control flow diagram"
  ],
  "requiredKinds": [
    "function",
    "method"
  ],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "Behavior",
  "renderer": "view-spec",
  "questionAnswered": "What branches and control-flow paths are evidenced?",
  "description": "Evidence-grounded Control flow graph",
  "example": "Show Control flow graph",
  "needs": []
} as const satisfies ChartDescriptor<"S29">;

export default { descriptor, status: "unavailable", reason: "No compiler is implemented for this notation yet." } satisfies ChartModule<"S29">;
