import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStateMachineV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S3",
  "name": "BatchId lifecycle state machine",
  "form": "GeneratedChart",
  "compiler": "specialized",
  "version": 4,
  "aliases": [
    "BatchId lifecycle state machine",
    "state machine",
    "state diagram",
    "lifecycle diagram"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "State and rules",
  "renderer": "state",
  "questionAnswered": "What states and transitions are supported?",
  "description": "Map reserve, post, rollback and idempotent repeats from observed code paths; missing transitions are called out as gaps. Cardinality, timing and token semantics require separate views; this view preserves states, guards, forbidden paths and replay interpretations.",
  "example": "Draw the batchId lifecycle as a state machine: reserve \u2192 post or rollback, including idempotent repeats. Use only states and transitions evidenced in the code, and list gaps.",
  "needs": []
} as const satisfies ChartDescriptor<"S3">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S3", compileStateMachineV2(input));
} } satisfies ChartModule<"S3">;
