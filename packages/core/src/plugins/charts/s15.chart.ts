import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S15",
  "name": "DI wiring diagram",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 3,
  "aliases": [
    "DI wiring diagram",
    "di wiring diagram",
    "dependency injection diagram",
    "di diagram",
    "wiring diagram"
  ],
  "requiredKinds": [
    "class",
    "interface"
  ],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "Structure",
  "renderer": "view-spec",
  "questionAnswered": "How are dependencies injected and resolved?",
  "description": "Which classes are injected into which, how the dependency graph is wired by the container, and where circular or missing bindings would appear. Grounded in constructor-injection and field-injection evidence from the indexed code.",
  "example": "Draw the dependency-injection wiring diagram for the bookkeeping component. Show which implementations are injected into which classes (BookkeepingEngineImpl \u2192 ReserveService \u2192 BalanceService, TransactionStateService, LedgerWriterServiceImpl), the injection mechanism (constructor vs field), and flag any dependency that could not be confirmed from the indexed code.",
  "needs": []
} as const satisfies ChartDescriptor<"S15">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S15", compileStructuredChartV2(input));
} } satisfies ChartModule<"S15">;
