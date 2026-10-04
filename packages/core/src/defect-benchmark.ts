import type { BenchmarkComparison, NumericInterval } from "@cie/schema";
import { createHash } from "node:crypto";

export interface BenchmarkTrial {
  runId: string; pairId: string; workloadHash: string; environmentHash: string; oracleHash: string;
  buildSettingsHash: string; instrumented: boolean; correctnessPassed: boolean;
  metrics: Record<string, number>;
}
export interface ComparisonPolicy {
  id: string; primaryMetric: string; direction: "LOWER" | "HIGHER";
  minimumPairs: number; minimumImprovement: number; confidenceLevel: number;
  regressionLimits: Record<string, { direction: "LOWER" | "HIGHER"; maximumRelativeRegression: number }>;
}
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const quantile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/** Every pair is retained. Bootstrap resamples pairs, not individual requests within one process. */
export function comparePairedBenchmarks(baseline: BenchmarkTrial[], candidate: BenchmarkTrial[], policy: ComparisonPolicy): BenchmarkComparison {
  if (!Number.isSafeInteger(policy.minimumPairs) || policy.minimumPairs < 3 || policy.minimumImprovement <= 0 || !Number.isFinite(policy.minimumImprovement) || policy.confidenceLevel <= 0 || policy.confidenceLevel >= 1) throw new Error("Invalid comparison policy");
  for (const gate of Object.values(policy.regressionLimits)) if (!Number.isFinite(gate.maximumRelativeRegression) || gate.maximumRelativeRegression < 0) throw new Error("Invalid regression limit");
  const limitations: string[] = [], regressions: string[] = [];
  const all = [...baseline, ...candidate];
  const rawSampleHandle = `samples:${digest({ baseline, candidate })}`;
  const first = baseline[0];
  if (!first || !candidate.length) throw new Error("Both benchmark groups must contain trials");
  const result: BenchmarkComparison = {
    id: `comparison:${digest({ rawSampleHandle, policy })}`, baselineRunIds: baseline.map((x) => x.runId), candidateRunIds: candidate.map((x) => x.runId),
    workloadHash: first.workloadHash, environmentHash: first.environmentHash, primaryMetric: policy.primaryMetric,
    rawSampleHandle, effectEstimate: 0, uncertaintyInterval: null, verdict: "INCONCLUSIVE", regressions, limitations,
  };
  if (new Set(all.map((t) => t.runId)).size !== all.length) limitations.push("duplicate run IDs");
  if (new Set(baseline.map((t) => t.pairId)).size !== baseline.length || new Set(candidate.map((t) => t.pairId)).size !== candidate.length) limitations.push("duplicate pair IDs");
  if (baseline.length !== candidate.length || baseline.some((b) => !candidate.some((c) => c.pairId === b.pairId))) limitations.push("unmatched trials; no samples were excluded");
  if (all.some((t) => t.instrumented)) limitations.push("instrumented timings are not representative performance timings");
  if (all.some((t) => !t.correctnessPassed)) regressions.push("correctness failure");
  for (const field of ["workloadHash", "environmentHash", "oracleHash", "buildSettingsHash"] as const) if (all.some((t) => t[field] !== first[field])) limitations.push(`${field} differs across trials`);
  const metrics = new Set([policy.primaryMetric, ...Object.keys(policy.regressionLimits)]);
  for (const metric of metrics) if (all.some((t) => !Number.isFinite(t.metrics[metric]) || t.metrics[metric] < 0)) limitations.push(`missing or invalid metric: ${metric}`);
  if (baseline.length < policy.minimumPairs) limitations.push(`requires at least ${policy.minimumPairs} paired trials`);
  if (limitations.length) return result;
  const paired = [...baseline].sort((a, b) => a.pairId.localeCompare(b.pairId)).map((b) => [b, candidate.find((c) => c.pairId === b.pairId)!] as const);
  const effect = (metric: string, direction: "LOWER" | "HIGHER", pairs = paired) => {
    const b = mean(pairs.map(([x]) => x.metrics[metric])), c = mean(pairs.map(([, x]) => x.metrics[metric]));
    return b === 0 ? null : (direction === "LOWER" ? b - c : c - b) / b;
  };
  const primary = effect(policy.primaryMetric, policy.direction);
  if (primary === null) { limitations.push("zero baseline for primary metric"); return result; }
  result.effectEstimate = primary;
  // Seeded PRNG makes reports reproducible without hiding the seed/method choice.
  let seed = 0x9e3779b9;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const effects: number[] = [];
  for (let n = 0; n < 2000; n++) {
    const sample = Array.from({ length: paired.length }, () => paired[Math.floor(random() * paired.length)]);
    const e = effect(policy.primaryMetric, policy.direction, sample);
    if (e === null) { limitations.push("a bootstrap resample had zero baseline"); return result; }
    effects.push(e);
  }
  effects.sort((a, b) => a - b);
  const tail = (1 - policy.confidenceLevel) / 2;
  const interval: NumericInterval = { lower: quantile(effects, tail), upper: quantile(effects, 1 - tail), method: "paired-percentile-bootstrap/2000/xorshift32/9e3779b9", confidenceLevel: policy.confidenceLevel };
  result.uncertaintyInterval = interval;
  for (const [metric, gate] of Object.entries(policy.regressionLimits)) {
    const e = effect(metric, gate.direction);
    if (e === null) {
      const candidates = candidate.map((x) => x.metrics[metric]);
      if (gate.direction === "LOWER" && candidates.some((x) => x > 0)) regressions.push(`${metric} increased from zero`);
    } else if (-e > gate.maximumRelativeRegression) regressions.push(`${metric} exceeded its regression limit`);
  }
  if (regressions.length || interval.upper < -policy.minimumImprovement) result.verdict = "REGRESSED";
  else if (interval.lower >= policy.minimumImprovement) result.verdict = "IMPROVED";
  else if (interval.lower > -policy.minimumImprovement && interval.upper < policy.minimumImprovement) result.verdict = "NO_MATERIAL_CHANGE";
  limitations.push("Paired process-trial uncertainty; tail estimates still depend on workload arrival model and completed request counts.");
  return result;
}
