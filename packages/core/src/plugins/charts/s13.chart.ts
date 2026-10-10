import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S13",
  "name": "Outbox pattern topology",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 4,
  "aliases": [
    "Outbox pattern topology",
    "outbox diagram",
    "outbox topology"
  ],
  "requiredKinds": [
    "function",
    "method"
  ],
  "requiredAcrossRepository": [],
  "offline": "gap",
  "concern": "Reliability",
  "renderer": "view-spec",
  "questionAnswered": "How do writers, stores, publishers, and consumers connect?",
  "description": "The transactional outbox: which service writes to it, which poller reads from it, and which downstream targets (provider, ledger) are driven by it \u2014 grounded in indexed write-to-outbox and publish-from-outbox evidence.",
  "example": "Draw the outbox pattern topology for the bookkeeping service. Show the service writing to the outbox table in the same transaction as state changes, the outbox poller, and the downstream targets it drives (provider callback, ledger writer). Cite the evidence for each step and list what could not be confirmed from the indexed code.",
  "needs": []
} as const satisfies ChartDescriptor<"S13">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S13", compileStructuredChartV2(input));
} } satisfies ChartModule<"S13">;
