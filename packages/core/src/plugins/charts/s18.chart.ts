import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S18",
  "name": "UML communication diagram",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 5,
  "aliases": [
    "UML communication diagram",
    "communication diagram",
    "uml communication diagram"
  ],
  "requiredKinds": [
    "function",
    "method"
  ],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "Behavior",
  "renderer": "view-spec",
  "questionAnswered": "Which participants communicate with each other?",
  "description": "Participants linked by numbered messages: each message carries its sequence number, direction and kind (sync, async, return). The numbering gives the interaction order.",
  "example": "Draw a UML communication diagram for the reserve flow: the caller, engine, balance, state and ledger participants, with numbered messages (1: reserve, 2: tryReserveFast, \u2026) grounded in the indexed call relationships.",
  "needs": []
} as const satisfies ChartDescriptor<"S18">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S18", compileStructuredChartV2(input));
} } satisfies ChartModule<"S18">;
