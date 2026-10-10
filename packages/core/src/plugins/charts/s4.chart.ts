import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileErDiagramV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S4",
  "name": "Ledger and entry relationships",
  "form": "GeneratedChart",
  "compiler": "specialized",
  "version": 4,
  "aliases": [
    "Ledger and entry relationships",
    "ledger and entry relationships",
    "ledger er diagram",
    "ledger entity relationship diagram"
  ],
  "requiredKinds": [
    "table",
    "column"
  ],
  "requiredAcrossRepository": [
    "table",
    "column"
  ],
  "offline": "gap",
  "concern": "Data",
  "renderer": "er",
  "questionAnswered": "What ledger and persistence relationships are evidenced?",
  "description": "Sketch the double-entry writes and the INSERT IGNORE and batchId + \"_0\" behavior where the source supports them.",
  "example": "Create an ER-style ledger sketch for double-entry writes, INSERT IGNORE behavior, and batchId with the \"_0\" suffix. Ground each table or operation in repository evidence and note gaps.",
  "needs": []
} as const satisfies ChartDescriptor<"S4">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S4", compileErDiagramV2(input));
} } satisfies ChartModule<"S4">;
