// F10/WP-05 — paired native experiments with retained outcomes.
// Every request's result (including errors, timeouts and cancellations) stays in the outcomes artifact;
// trial metrics are computed from that artifact by the runner, never supplied by a caller. Incomparable
// pairs are rejected with their reason and raw evidence (F10-D7); the pairing never silently drops.
import type {
  EnvironmentSpec, InterventionClass, OutcomesArtifact, OutcomesRecord, RunCell, RunRole, TrialMetrics,
  TwinModelSpec, WorkloadSpec,
} from "@cie/schema";
import { artifactHash } from "./defect-schedule.ts";
import { comparePairedBenchmarks, type BenchmarkTrial, type ComparisonPolicy } from "./defect-benchmark.ts";

export interface NativeRunRequest {
  role: RunRole; buildHash: string; environment: EnvironmentSpec; workload: WorkloadSpec;
  multiplier: number; seed: string; intervention: { class: InterventionClass; parameters: Record<string, number> };
  modelSpec: TwinModelSpec; maxRequests?: number;
}
export interface NativeRunResult {
  outcomes: OutcomesRecord[]; instrumented: boolean;
  environmentHash: string; buildHash: string; workloadHash: string; oracleHash: string;
  scheduledRatePerSec: number; achievedRatePerSec: number;
}
export interface NativeAdapter { id: string; version: string; run(request: NativeRunRequest): Promise<NativeRunResult> }

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);

/** Compute trial metrics from the complete outcomes artifact. Failures are never dropped. */
export function metricsFromOutcomes(artifact: Pick<OutcomesArtifact, "records" | "scheduledRatePerSec">, options: { durationSec: number; minBlocks?: number } = { durationSec: 1 }): TrialMetrics {
  const records = artifact.records;
  const success = records.filter((r) => r.outcome === "SUCCESS");
  const successLatencies = success.map((r) => r.intendedLatencyMs).sort((a, b) => a - b);
  const allLatencies = records.map((r) => r.intendedLatencyMs).sort((a, b) => a - b);
  const errors = records.filter((r) => r.outcome !== "SUCCESS").length;
  const duration = Math.max(1e-9, options.durationSec);
  // Independent blocks: one per scheduled-rate sample bucket, a conservative proxy for tail independence.
  const buckets = Math.max(1, Math.round(duration));
  return {
    throughput: success.length / duration,
    p50: percentile(successLatencies, 0.5),
    p95: percentile(successLatencies, 0.95),
    p99: percentile(successLatencies, 0.99),
    errorRate: records.length ? errors / records.length : 0,
    completedWorkRate: records.length ? success.length / records.length : 1,
    successOnlyP95: percentile(successLatencies, 0.95),
    allRequestsP95: percentile(allLatencies, 0.95),
    utilisation: {},
    effectiveBlocks: buckets,
  };
}

export interface GeneratorProblem { problem: "SATURATED" | "COORDINATED_OMISSION" | "INSTRUMENTED" | "HASH_MISMATCH" | "NO_OUTCOMES"; detail: string }

/** Validate the load generator before a run is admitted to a comparison. */
export function checkGeneratorValidity(artifact: OutcomesArtifact, expected: { environmentHash: string; buildHash: string; workloadHash: string; oracleHash: string }): GeneratorProblem[] {
  const problems: GeneratorProblem[] = [];
  if (!artifact.records.length) problems.push({ problem: "NO_OUTCOMES", detail: "the run produced no outcome records" });
  if (artifact.achievedRatePerSec < artifact.scheduledRatePerSec * 0.9) problems.push({ problem: "SATURATED", detail: `achieved ${artifact.achievedRatePerSec.toFixed(1)}/s of scheduled ${artifact.scheduledRatePerSec.toFixed(1)}/s: the generator saturated` });
  if (artifact.coordinatedOmissionDetected) problems.push({ problem: "COORDINATED_OMISSION", detail: "a request was measured from when the generator got to it, not from its intended time" });
  if (artifact.instrumentationPresent) problems.push({ problem: "INSTRUMENTED", detail: "instrumented timings are not representative performance timings" });
  for (const key of ["environmentHash", "buildHash", "workloadHash", "oracleHash"] as const) if (artifact[key] !== expected[key]) problems.push({ problem: "HASH_MISMATCH", detail: `${key} differs (${artifact[key]} vs ${expected[key]})` });
  return problems;
}

export interface PairedExperimentInput {
  twinId: string; twinVersion: number; planId: string;
  adapter: NativeAdapter;
  baselineModel: TwinModelSpec; candidateModel: TwinModelSpec;
  environment: EnvironmentSpec; workload: WorkloadSpec;
  intervention: { class: InterventionClass; parameters: Record<string, number> };
  loadMultiplier: number;
  repetitions: number; seed: string;
  comparisonPolicy: ComparisonPolicy;
  buildHash: string; environmentHash: string; workloadHash: string; oracleHash: string;
  maxRequestsPerRun?: number;
  /** Below this many independent blocks, a tail verdict is refused (F10-D9). */
  minTailBlocks?: number;
}
export interface PairedExperimentResult {
  planId: string;
  artifacts: OutcomesArtifact[];
  metricsByCell: Record<string, TrialMetrics>;
  cells: RunCell[];
  rejectedPairs: { pairId: string; reason: string; problems: GeneratorProblem[] }[];
  comparison: ReturnType<typeof comparePairedBenchmarks> | null;
  resultClass: "MEASURED_EXPERIMENT" | "NONE";
  tailVerdictAllowed: boolean;
  notes: string[];
}

async function runOne(input: PairedExperimentInput, role: RunRole, pairId: string, orderIndex: number, cellId: string, model: TwinModelSpec, instrumented: boolean): Promise<{ artifact: OutcomesArtifact; result: NativeRunResult }> {
  const result = await input.adapter.run({
    role, buildHash: input.buildHash, environment: input.environment, workload: input.workload,
    multiplier: input.loadMultiplier, seed: `${input.seed}:${pairId}:${role}`, intervention: input.intervention,
    modelSpec: model, maxRequests: input.maxRequestsPerRun,
  });
  const artifact: OutcomesArtifact = {
    hash: artifactHash({ role, records: result.outcomes, buildHash: result.buildHash, environmentHash: result.environmentHash, workloadHash: result.workloadHash }),
    role, buildHash: result.buildHash, environmentHash: result.environmentHash, workloadHash: result.workloadHash, oracleHash: result.oracleHash,
    scheduledRatePerSec: result.scheduledRatePerSec, achievedRatePerSec: result.achievedRatePerSec,
    generatorSaturated: result.achievedRatePerSec < result.scheduledRatePerSec * 0.9,
    coordinatedOmissionDetected: result.outcomes.some((o) => o.generatorDelayMs > Math.max(5, o.intendedLatencyMs * 0.25)),
    instrumentationPresent: result.instrumented,
    records: result.outcomes,
  };
  void orderIndex; void cellId;
  return { artifact, result };
}

/**
 * Run the paired experiment: baseline and candidate instances under the same fixture and environment,
 * interleaved to expose drift, all outcomes retained, and only comparable pairs compared.
 */
export async function runPairedExperiment(input: PairedExperimentInput): Promise<PairedExperimentResult> {
  const artifacts: OutcomesArtifact[] = [];
  const metricsByCell: Record<string, TrialMetrics> = {};
  const cells: RunCell[] = [];
  const rejectedPairs: { pairId: string; reason: string; problems: GeneratorProblem[] }[] = [];
  const notes: string[] = [];
  const expected = { environmentHash: input.environmentHash, buildHash: input.buildHash, workloadHash: input.workloadHash, oracleHash: input.oracleHash };
  const baselineTrials: BenchmarkTrial[] = [], candidateTrials: BenchmarkTrial[] = [], rejectedBaseline: BenchmarkTrial[] = [], rejectedCandidate: BenchmarkTrial[] = [];
  for (let i = 0; i < input.repetitions; i++) {
    const pairId = `pair-${i}`;
    // Interleave: even pairs baseline-then-candidate, odd pairs candidate-then-baseline.
    const order: RunRole[] = i % 2 === 0 ? ["TWIN_BASELINE", "TWIN_CANDIDATE"] : ["TWIN_CANDIDATE", "TWIN_BASELINE"];
    for (let o = 0; o < order.length; o++) {
      const role = order[o];
      const cellId = `${pairId}:${role}`;
      const model = role === "TWIN_BASELINE" ? input.baselineModel : input.candidateModel;
      const instrumented = false;
      const { artifact } = await runOne(input, role, pairId, i * 2 + o, cellId, model, instrumented);
      artifacts.push(artifact);
      const problems = checkGeneratorValidity(artifact, expected);
      const metrics = metricsFromOutcomes(artifact, { durationSec: input.workload.durationSec });
      metricsByCell[cellId] = metrics;
      const comparable = problems.length === 0;
      cells.push({ cellId, pairId, role, runManifestId: artifact.hash, orderIndex: i * 2 + o, comparable, incomparableReason: comparable ? undefined : problems.map((p) => p.problem).join(",") });
      const trial: BenchmarkTrial = {
        runId: cellId, pairId, workloadHash: artifact.workloadHash, environmentHash: artifact.environmentHash,
        oracleHash: artifact.oracleHash, buildSettingsHash: artifact.buildHash, instrumented: artifact.instrumentationPresent,
        correctnessPassed: artifact.records.every((r) => r.correctnessPassed),
        metrics: { throughput: metrics.throughput, p95: metrics.p95, allRequestsP95: metrics.allRequestsP95, errorRate: metrics.errorRate, completedWorkRate: metrics.completedWorkRate },
      };
      if (role === "TWIN_BASELINE") (comparable ? baselineTrials : rejectedBaseline).push(trial);
      else (comparable ? candidateTrials : rejectedCandidate).push(trial);
    }
    const pairCells = cells.filter((c) => c.pairId === pairId);
    for (const c of pairCells) if (!c.comparable) rejectedPairs.push({ pairId, reason: c.incomparableReason ?? "incomparable", problems: checkGeneratorValidity(artifacts.find((a) => a.hash === c.runManifestId)!, expected) });
    if (pairCells.some((c) => !c.comparable) && pairCells.every((c) => c.role !== "TWIN_BASELINE" || !c.comparable) === false) {
      const rejected = rejectedBaseline.concat(rejectedCandidate).filter((t) => t.pairId === pairId);
      if (rejected.length) notes.push(`${pairId}: ${rejected.length} cell(s) rejected; all outcomes retained`);
    }
  }
  // Only fully comparable pairs enter the comparison.
  const comparablePairIds = new Set([...baselineTrials].map((t) => t.pairId).filter((p) => candidateTrials.some((c) => c.pairId === p)));
  const baseline = baselineTrials.filter((t) => comparablePairIds.has(t.pairId));
  const candidate = candidateTrials.filter((t) => comparablePairIds.has(t.pairId));
  let comparison: ReturnType<typeof comparePairedBenchmarks> | null = null;
  if (baseline.length && candidate.length) {
    comparison = comparePairedBenchmarks(baseline, candidate, input.comparisonPolicy);
    if (comparison.verdict === "IMPROVED") {
      const completedWork = baseline.length ? baseline.reduce((a, t) => a + t.metrics["completedWorkRate"], 0) / baseline.length : 1;
      const candidateWork = candidate.length ? candidate.reduce((a, t) => a + t.metrics["completedWorkRate"], 0) / candidate.length : 1;
      if (candidateWork < completedWork * 0.99) {
        comparison.verdict = "REGRESSED";
        comparison.regressions.push("completedWorkRate regressed: the candidate completes less of the offered work");
      }
    }
  } else notes.push("no fully comparable pairs; no comparison was produced");
  const blocks = baseline.length;
  const tailVerdictAllowed = blocks >= (input.minTailBlocks ?? 3);
  if (!tailVerdictAllowed) notes.push(`insufficient independent blocks for a p99 verdict (need ${input.minTailBlocks ?? 3})`);
  return { planId: input.planId, artifacts, metricsByCell, cells, rejectedPairs, comparison, resultClass: comparison ? "MEASURED_EXPERIMENT" : "NONE", tailVerdictAllowed, notes };
}

/** A candidate that is "faster" because it completes less work is never IMPROVED. */
export function enforcePopulationRules(baseline: TrialMetrics, candidate: TrialMetrics, policy: { errorRateDelta: number; completedWorkDelta: number }): { verdict: "NOT_COMPARABLE" | "REGRESSED" | "OK"; reasons: string[] } {
  const reasons: string[] = [];
  if (candidate.completedWorkRate < baseline.completedWorkRate - policy.completedWorkDelta) reasons.push("completedWorkRate regressed");
  if (candidate.errorRate > baseline.errorRate + policy.errorRateDelta) { reasons.push("error rate differs beyond the threshold; latency claims are NOT_COMPARABLE"); return { verdict: "NOT_COMPARABLE", reasons }; }
  return { verdict: reasons.length ? "REGRESSED" : "OK", reasons };
}
