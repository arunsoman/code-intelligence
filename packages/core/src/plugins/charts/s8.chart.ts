import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileEventStormingV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S8",
  "name": "Event storming / event modeling",
  "form": "GeneratedChart",
  "compiler": "specialized",
  "version": 3,
  "aliases": [
    "Event storming / event modeling",
    "event storming event modeling",
    "event storming board",
    "event model"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [],
  "offline": "derived",
  "concern": "Other views",
  "renderer": "view-spec",
  "questionAnswered": "Which commands, events, and actors participate?",
  "description": "Commands, domain events and read models arranged on a timeline. Commands are derived from public entry points, events from emitted topics and state transitions, aggregates from the entities that own them.",
  "example": "Build an event storming board for the bookkeeping component. Place commands (Reserve, Post, Rollback), domain events (FundsReserved, TransactionPosted, LedgerEntryWritten, ReservationRolledBack) and the aggregates that own them on a timeline, grounded in indexed topics and state-transition evidence.",
  "needs": []
} as const satisfies ChartDescriptor<"S8">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S8", compileEventStormingV2(input));
} } satisfies ChartModule<"S8">;
