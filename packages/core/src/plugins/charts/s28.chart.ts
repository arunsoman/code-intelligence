import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S28",
  "name": "UML sequence diagram",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 5,
  "aliases": [
    "UML sequence diagram",
    "uml sequence diagram",
    "sequence diagram"
  ],
  "requiredKinds": [
    "function",
    "method"
  ],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "Behavior",
  "renderer": "sequence",
  "questionAnswered": "What interaction order is supported by the available evidence?",
  "description": "Lifelines with ordered messages (sync, async, return, self) and alt/opt/loop/exception/parallel fragment regions, ordered by static control-flow \u2014 not observed runtime timing. Rendered as lifelines and message rows. Message ordering and fragment semantics are inferred from the supplied static plan, not proven by the presence of source evidence.",
  "example": "Draw the reserve interaction as a UML sequence diagram: caller, engine, Redis and MySQL lifelines; numbered messages in evidenced order; an alt fragment for insufficient balance and an exception fragment for the DB-sync compensation.",
  "needs": []
} as const satisfies ChartDescriptor<"S28">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S28", compileStructuredChartV2(input));
} } satisfies ChartModule<"S28">;
