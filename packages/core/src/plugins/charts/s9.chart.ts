import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileErDiagramV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S9",
  "name": "Entity-relationship diagram",
  "form": "GeneratedChart",
  "compiler": "specialized",
  "version": 4,
  "aliases": [
    "Entity-relationship diagram",
    "entity relationship er diagram",
    "er diagram",
    "entity relationship diagram",
    "entity relationship chart"
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
  "questionAnswered": "What entities, columns, and declared relationships exist?",
  "description": "All persisted tables, their key columns and foreign-key relationships as an ER sketch. Each table and relationship is traced to indexed schema or write-fact evidence; inferred relationships are shown dashed.",
  "example": "Draw an ER diagram for all persisted state in this repository: tables, primary keys, foreign keys and the relationships between them. Distinguish schema-evidenced relationships (solid) from inferred ones (dashed) and list gaps.",
  "needs": []
} as const satisfies ChartDescriptor<"S9">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S9", compileErDiagramV2(input));
} } satisfies ChartModule<"S9">;
