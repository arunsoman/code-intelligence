import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S20",
  "name": "CRC cards",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 3,
  "aliases": [
    "CRC cards",
    "crc cards",
    "class responsibility collaborator cards"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "Structure",
  "renderer": "view-spec",
  "questionAnswered": "Which responsibilities and collaborators belong to each type?",
  "description": "One card per class: its evidenced responsibilities and the classes it collaborates with, rendered as a table plus a collaboration graph. Entries the source does not support are listed as gaps, not invented.",
  "example": "Build CRC cards for ReserveService, BalanceService, TransactionStateService and LedgerWriterServiceImpl. List each class's responsibilities and collaborators, citing the code that evidences each entry.",
  "needs": []
} as const satisfies ChartDescriptor<"S20">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S20", compileStructuredChartV2(input));
} } satisfies ChartModule<"S20">;
