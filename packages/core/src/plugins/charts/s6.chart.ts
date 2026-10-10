import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileLegacyChartPlan } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S6",
  "name": "Use case diagram",
  "form": "GeneratedChart",
  "compiler": "standard",
  "version": 3,
  "aliases": [
    "Use case diagram",
    "use case diagram",
    "usecase diagram"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [],
  "offline": "derived",
  "concern": "Other views",
  "renderer": "view-spec",
  "questionAnswered": "How is this behavior decomposed?",
  "description": "Actors (callers, admins, external systems) and the use cases they trigger, grounded in the entry points and guard checks visible in the code. Missing actors and undeclared relationships are listed as gaps.",
  "example": "Draw a use case diagram for the bookkeeping component. Show each caller role and the operations (reserve, post, rollback, audit) they can invoke, based on entry-point and authorisation evidence in the code.",
  "needs": []
} as const satisfies ChartDescriptor<"S6">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S6", compileLegacyChartPlan(input));
} } satisfies ChartModule<"S6">;
