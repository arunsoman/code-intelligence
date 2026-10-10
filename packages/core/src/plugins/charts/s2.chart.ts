import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileLegacyChartPlan } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S2",
  "name": "Reserve fast-path sequence / swimlane",
  "form": "TransactionJourney",
  "compiler": "standard",
  "version": 3,
  "aliases": [
    "Reserve fast-path sequence / swimlane",
    "reserve fast path sequence swimlane",
    "reserve sequence",
    "swimlane diagram"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [],
  "offline": "derived",
  "concern": "Behavior",
  "renderer": "view-spec",
  "questionAnswered": "How does this operation flow across components?",
  "description": "Follow reserve through its callers and callees as a swimlane journey: lanes per module, conditional branches, transaction markers and failure exits, ordered by static control-flow (not observed runtime timing). This is a swimlane journey rather than a full UML sequence diagram; for lifelines, ordered messages and alt/opt/loop fragments use the UML sequence diagram (S28). Also serves as a UML activity diagram or control-flow graph for any single operation.",
  "example": "Draw the reserve fast path as a sequence diagram from request through Redis and MySQL. Include decision points and failure branches supported by the code.",
  "needs": []
} as const satisfies ChartDescriptor<"S2">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S2", compileLegacyChartPlan(input));
} } satisfies ChartModule<"S2">;
