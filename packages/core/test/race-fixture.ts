import { ChartOutputV2, type EvidenceBundle, type ViewRoute } from "@cie/schema";
import { compileChartPlan } from "../src/chart-creator.ts";
const bundle: EvidenceBundle = { id: "b", revision: "rev", evidence: [], entities: [], relationships: [], facts: [], coverage: [], unresolved: [], tokenEstimate: 0 };
const rev = { id: "rev", repoRoot: "/r", gitHead: null, createdAt: "t", analyzerVersion: "t", diagnostics: [], fileCount: 1 };
const route: ViewRoute = { source: "chosen", confidence: "high", form: "RaceWindow", name: "Replay", because: "", alternatives: [] };
export function raceFixture(extra: Record<string, unknown> = {}) {
  return ChartOutputV2.parse({ contractVersion: "chart.v2", chartId: "R1", chartType: "Replay timeline (twin run)", caption: "Checkout under timeout", layout: "timeline", nodes: [], edges: [], subject: "checkout", scenario: "timeout", arrivalRatePerSec: 80, durationSec: 30, timeoutMs: 14, faultProbability: 0.05, seed: "race-fixture", ...extra });
}
export function compiledRace(extra: Record<string, unknown> = {}) {
  return compileChartPlan({ plan: raceFixture(extra), bundle, rev, question: "What happens on timeout?", route, chartId: "R1" });
}
