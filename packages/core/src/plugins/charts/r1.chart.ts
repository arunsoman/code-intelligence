import type { ChartDescriptor, ChartModule } from "@cie/schema";
import { compileLegacyChartPlan } from "../../chart-compilers.ts";
import { checkedResult } from "../checked-result.ts";

export const descriptor = {
  "id": "R1",
  "name": "Replay timeline (twin run)",
  "form": "RaceWindow",
  "compiler": "specialized",
  "version": 1,
  "aliases": [
    "replay timeline",
    "twin replay",
    "race timeline",
    "timeout replay",
    "what-if simulation",
    "scenario replay"
  ],
  "requiredKinds": [],
  "requiredAcrossRepository": [],
  "offline": "derived",
  "concern": "Reliability",
  "renderer": "race-timeline",
  "questionAnswered": "What actually happens to requests under this load or fault scenario, on the pinned twin model?",
  "description": "Runs the pinned reference twin model deterministically for the requested scenario (baseline, timeout, saturation, retry storm) and draws the sampled request lifecycles across stations: service blocks, queued waits, retries, timeouts and drops, with run metrics and a MODEL_PREDICTION result class. This is a bounded model prediction in simulated time — not observed production timing, and not a capacity certificate; a calibrated baseline or an isolated-exec experiment upgrades the result class.",
  "example": "Replay checkout at 80 requests per second with a 14 ms ledger timeout and show which requests exhaust their retries.",
  "needs": []
} as const satisfies ChartDescriptor<"R1">;

export default { descriptor, status: "available", compile(input) {
  return checkedResult("R1", compileLegacyChartPlan(input));
} } satisfies ChartModule<"R1">;
