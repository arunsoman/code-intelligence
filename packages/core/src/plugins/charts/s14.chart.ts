import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S14",
  "name": "Idempotency matrix",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 3,
  "aliases": [
    "Idempotency matrix",
    "idempotency matrix"
  ],
  "requiredKinds": [
    "function",
    "method"
  ],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "Reliability",
  "renderer": "view-spec",
  "questionAnswered": "Which mechanisms handle duplicate requests?",
  "description": "Each operation (reserve, post, rollback) crossed with its duplicate-call scenario, showing whether the result is idempotent and what mechanism enforces it (batchId lookup, INSERT IGNORE, Redis idempotency key). Missing guarantees are gaps.",
  "example": "Build an idempotency matrix for reserve, post and rollback. For each operation, show what happens on a duplicate call with the same batchId, which code mechanism enforces idempotency (state-exists check, INSERT IGNORE, Redis key), and cite the evidence. Mark any operation where idempotency is not evidenced as a gap.",
  "needs": []
} as const satisfies ChartDescriptor<"S14">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S14", compileStructuredChartV2(input));
} } satisfies ChartModule<"S14">;
