import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileDfdV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S10",
  "name": "Data flow diagram",
  "form": "GeneratedChart",
  "compiler": "specialized",
  "version": 4,
  "aliases": [
    "Data flow diagram",
    "data flow diagram dfd",
    "dfd",
    "data flow chart"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [],
  "offline": "derived",
  "concern": "Data",
  "renderer": "view-spec",
  "questionAnswered": "Where does data enter, move, and persist?",
  "description": "Data flows between processes, data stores and external entities across the whole reserve/post/rollback pipeline \u2014 showing what data moves, not which code calls which code. Complements V5 DataLineage which centres on one field.",
  "example": "Draw a level-1 data flow diagram for the bookkeeping component. Show external entities (caller, provider), processes (validate, reserve, persist, post ledger), data stores (Redis, transaction_state, ledger) and the data flows between them, grounded in indexed read/write facts.",
  "needs": []
} as const satisfies ChartDescriptor<"S10">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S10", compileDfdV2(input));
} } satisfies ChartModule<"S10">;
