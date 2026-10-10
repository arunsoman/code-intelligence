import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileStructuredChartV2 } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "S21",
  "name": "Call graph",
  "form": "GeneratedChart",
  "compiler": "projected",
  "version": 3,
  "aliases": [
    "Call graph",
    "call graph"
  ],
  "requiredKinds": [
    "function",
    "method"
  ],
  "requiredAcrossRepository": [],
  "offline": "derived",
  "concern": "Behavior",
  "renderer": "view-spec",
  "questionAnswered": "Which functions call which other functions?",
  "description": "Which functions call which, from statically resolved call relationships. Every edge is static source evidence; no runtime frequency or ordering beyond source order is implied.",
  "example": "Draw the call graph rooted at reserve: each function it reaches through resolved calls, with the call-site evidence for every edge. Flag calls the indexer could not resolve.",
  "needs": []
} as const satisfies ChartDescriptor<"S21">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("S21", compileStructuredChartV2(input));
} } satisfies ChartModule<"S21">;
