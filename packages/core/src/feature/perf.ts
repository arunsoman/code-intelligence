// Task 2.M — pf-perf-core-v1 paired benchmark harness and S11 statistics (spec §14, §15, §30.3; plan S4, S11, P4, P5).
//
// Three operations (frozen signatures in api.ts):
//   assessPerformanceRisk  — pure predicate over the diff: is the change performance-applicable (§2.4), which §30.3
//                            risk triggers fire; the triggers that fired are recorded (promotedBy on the experiment).
//   runPairedBenchmark     — durable job: P0–P3 declared workloads executed through a Runner against baseline and
//                            candidate checkouts, a RunManifest per run, the complete error/timeout population kept
//                            (AT-18 checks it later), a P4 baseline cache keyed by full identity, and a P5 exclusive
//                            lease around measurement (a non-exclusive run is labelled contended, never silently OK).
//   evaluatePerformance    — pure S11 statistics over a stored PairedExperiment: ≥10 repetitions per case
//                            (configurable), p50/p95/p99 per side, seeded bootstrap CI on the paired difference;
//                            budget without authority → UNVALIDATED, CI crossing the limit → INCONCLUSIVE (AT-20),
//                            budget exceeded → REGRESSION with the interference reported (AT-17), otherwise
//                            WITHIN_BUDGET. No representative environment → UNVALIDATED (AT-19). Nothing here ever
//                            invents a baseline for a feature that did not exist (§15).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { copyTree, makeScratch, removeScratch, safeJoin } from "../isolated-exec.ts";
import { asSet, canonHash, defineSchema, rawHash, type Canon } from "./canon.ts";
import type { AuthorityConfig } from "./authority.ts";
import { ConfigError } from "./config.ts";
import { FeatureError } from "./errors.ts";
import { eventFor } from "./lifecycle.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type {
  EvidenceRecord, Hash, Id, Outcome, PairedExperiment, PerfBudgetVerdict, PerfCase, PerfCaseRun,
  PerformanceAssessment, PerformanceBudget, PerformanceRiskAssessment, PerformanceState, PerfOutcomeClass,
  RunManifest, Runner, Snapshot, ValidationResult,
} from "./types.ts";

export const PERF_PROFILE = "pf-perf-core-v1" as const;
export const PERF_CASES: readonly PerfCase[] = ["P0", "P1", "P2", "P3"];
const OUTCOME_CLASSES: readonly PerfOutcomeClass[] = ["SUCCESS", "ERROR", "TIMEOUT", "CANCELLED"];

// ------------------------------------------------------------------------------------------------ S11 statistics

export interface PerfAnalysisPolicy {
  /** S11: at least this many repetitions per case, else the case cannot support a claim. */
  minRepetitions: number;
  /** Reported percentiles per side (p50/p95/p99). */
  percentiles: number[];
  /** Bootstrap resamples on the paired difference (seeded, deterministic). */
  bootstrapResamples: number;
  seed: number;
}
export const DEFAULT_ANALYSIS_POLICY: PerfAnalysisPolicy = { minRepetitions: 10, percentiles: [50, 95, 99], bootstrapResamples: 10_000, seed: 1 };

const AnalysisPolicySchema = defineSchema<PerfAnalysisPolicy>("pf.PerfAnalysisPolicy", "1", (p) => ({
  minRepetitions: p.minRepetitions, percentiles: [...p.percentiles].sort((a, b) => a - b), bootstrapResamples: p.bootstrapResamples, seed: p.seed,
}));
export const analysisPolicyHashOf = (p: PerfAnalysisPolicy): Hash => canonHash(AnalysisPolicySchema, p);
let defaultPolicyHash: Hash | null = null;
export const defaultAnalysisPolicyHash = (): Hash => (defaultPolicyHash ??= analysisPolicyHashOf(DEFAULT_ANALYSIS_POLICY));

/** Deterministic seeded RNG (mulberry32): the bootstrap is reproducible run to run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolation percentile over a sorted series; NaN for an empty series. Deterministic. */
export function percentileOf(sorted: readonly number[], pct: number): number {
  if (!sorted.length) return NaN;
  const idx = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/** Bootstrap CI of the mean over `values` with `resamples` redraws, seeded. Returns the point estimate and the CI. */
export function bootstrapCi(values: readonly number[], resamples: number, seed: number, confidence = 0.95): { low: number; high: number; point: number } {
  if (!values.length) return { low: NaN, high: NaN, point: NaN };
  const rng = mulberry32(seed);
  const n = values.length;
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rng() * n)]!;
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const alpha = ((1 - confidence) / 2) * 100;
  return { low: percentileOf(means, alpha), high: percentileOf(means, 100 - alpha), point: means.reduce((s, m) => s + m, 0) / resamples };
}

// ------------------------------------------------------------------------------------------------ population check (AT-18)

/**
 * §15.3: the candidate must keep the complete population. A candidate that drops errors (or any outcomes) from the
 * benchmark rejects the comparison — the case cannot support a claim. `expected`/`observed` are per-case populations.
 */
export function populationCheck(expected: Record<PerfOutcomeClass, number>, observed: Record<PerfOutcomeClass, number>): { ok: boolean; reason?: string } {
  const tot = (p: Record<PerfOutcomeClass, number>) => OUTCOME_CLASSES.reduce((s, k) => s + (p[k] ?? 0), 0);
  const et = tot(expected), ot = tot(observed);
  if (ot < et) return { ok: false, reason: `the candidate kept ${ot} of ${et} outcomes: dropped samples reject the comparison (§15.3)` };
  const eBad = expected.ERROR + expected.TIMEOUT + expected.CANCELLED, oBad = observed.ERROR + observed.TIMEOUT + observed.CANCELLED;
  if (oBad < eBad) return { ok: false, reason: `the candidate kept ${oBad} errors/timeouts/cancellations vs ${eBad} in the baseline: a candidate that drops errors is rejected (AT-18)` };
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------ risk predicate (§2.4, §30.3)

/** §2.4 applicability: the change touches a request path, query, job, loop over data, or a shared resource. */
const APPLICABILITY: [RegExp, string][] = [
  [/\b(router|route|handler|controller|endpoint|middleware|request|response)\b/i, "request path"],
  [/\b(select|insert|update|delete|query|where|sql|findMany|findAll|join)\b/i, "query"],
  [/\b(worker|job|queue|scheduler|cron|background task)\b/i, "job"],
  [/\b(for\s*\(|while\s*\(|forEach|\.map\(|\.reduce\(|\.filter\()/i, "loop over data"],
  [/\b(cache|lock|mutex|semaphore|pool|connection|shared)\b/i, "shared resource"],
];
/** §30.3 explicit risk triggers; a trigger that fires promotes the progressive cases and is recorded. */
const RISK_TRIGGERS: [string, RegExp][] = [
  ["resource-sharing-concurrency", /\b(mutex|lock|semaphore|race condition|concurrent|parallel|worker_threads|shared|pool)\b/i],
  ["long-held-db-connections", /\b(transaction|begin\b|commit\b|rollback|connection|held|acquire|checkout)\b/i],
  ["unbounded-output", /\b(while\s*\(|repeat\(|unbounded|collect all|load all|fetch all|no limit|stream all)\b/i],
  ["client-backpressure", /\b(backpressure|highwatermark|drain|pause\(\)|resume\(\)|slow client)\b/i],
  ["cancellation", /\b(abort|cancel|cancellation|abortsignal|signal)\b/i],
  ["retries-external-degradation", /\b(retry|retries|retrying|fallback|degrad|circuit.?breaker|timeout)\b/i],
  ["migration-scale", /\b(migration|migrate|schema|alter table|bulk|backfill|historical records)\b/i],
];
export const PERF_RISK_TRIGGERS = RISK_TRIGGERS.map(([k]) => k);

/** Lines present in the candidate text but not the base (multiset difference) — what the diff added. */
function addedLines(baseText: string | null, candText: string): string[] {
  if (baseText === null) return candText.split("\n");
  const remaining = new Map<string, number>();
  for (const l of baseText.split("\n")) remaining.set(l, (remaining.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of candText.split("\n")) {
    const n = remaining.get(l) ?? 0;
    if (n > 0) remaining.set(l, n - 1);
    else out.push(l);
  }
  return out;
}

export interface AssessRiskInput { contractHash: Hash; patchBindingHash: Hash; runtimeEvidenceIds: Id[] }

/** Pure given the store: applicability is a predicate over the actual diff, separate from the change tier (§2.4). */
export function assessPerformanceRisk(d: { fs: SqliteFeatureStore }, i: AssessRiskInput): Outcome<PerformanceRiskAssessment> {
  if (!i.contractHash || !i.patchBindingHash) throw new FeatureError("INVALID_SCHEMA", "contractHash and patchBindingHash are required");
  const candidate = d.fs.getCandidateByBinding(i.patchBindingHash);
  if (!candidate) throw new FeatureError("NOT_FOUND", "no candidate bound to that patch binding");
  const rec = d.fs.getRequest(candidate.requestId);
  if (!rec) throw new FeatureError("NOT_FOUND", "the candidate's request no longer exists");
  const diagnostics: string[] = [];
  for (const id of i.runtimeEvidenceIds) {
    if (!d.fs.listEvidence(candidate.id).some((e) => e.id === id)) diagnostics.push(`runtime evidence ${id} is not on record for this candidate; it was not used`);
  }
  const hits = new Map<string, string[]>(), triggers = new Map<string, string[]>();
  for (const [file, text] of Object.entries(candidate.contents ?? {})) {
    if (text === null) continue;
    const added = addedLines(candidate.baseContents?.[file] ?? null, text);
    for (const [re, what] of APPLICABILITY) if (added.some((l) => re.test(l))) hits.set(what, [...(hits.get(what) ?? []), file]);
    for (const [key, re] of RISK_TRIGGERS) if (added.some((l) => re.test(l))) triggers.set(key, [...(triggers.get(key) ?? []), file]);
  }
  const applicable = hits.size > 0 || triggers.size > 0;
  const rationale = applicable
    ? [...[...hits.entries()].map(([what, files]) => `touches ${what}: ${[...new Set(files)].join(", ")}`),
        ...[...triggers.entries()].map(([key, files]) => `§30.3 trigger ${key} fired in ${[...new Set(files)].join(", ")}`)]
    : ["the change touches no request path, query, job, loop over data or shared resource (§2.4)"];
  return {
    status: "COMPLETE",
    value: {
      schemaVersion: 1, id: `prisk:${candidate.bindingHash.split(":").pop()!.slice(0, 24)}`, applicable,
      triggers: [...triggers.keys()], rationale, contractHash: i.contractHash, patchBindingHash: i.patchBindingHash,
    },
    evidenceIds: [candidate.id],
    diagnostics,
  };
}

// ------------------------------------------------------------------------------------------------ workloads and measurement plans

export interface PerfWorkloadCaseConfig { env?: Record<string, string>; argv?: string[] }
/** A declared workload: files placed inside the checkout and a node entry run through the Runner per repetition.
 *  The entry prints one line `PF_PERF {"outcome":"SUCCESS|ERROR|TIMEOUT|CANCELLED","metrics":{...}}`. */
export interface PerfWorkload {
  entry: string;
  files: Record<string, string>;
  /** Which cases this workload can execute; a case missing here makes that case INCOMPLETE with a concrete reason. */
  cases: Partial<Record<PerfCase, PerfWorkloadCaseConfig>>;
}
export interface PerfMeasurementPlan {
  /** Repetitions per case (S11: ≥10 unless configured otherwise; declared before running, §30.3). */
  repetitions: number;
  /** Cases to execute; default P0–P3. Progressive cases run because a §30.3 trigger promoted them (recorded). */
  cases?: PerfCase[];
  /** Cases that also have a baseline analogue (compared against baseline); default ["P0"]. */
  baselineCases?: PerfCase[];
  /** The declared statistics method; its hash lands in the experiment's analysisPolicyHash. */
  analysis?: PerfAnalysisPolicy;
  perRunWallMs?: number;
}

export interface RunPairedBenchmarkInput {
  baselineSnapshot: Snapshot; patchBindingHash: Hash; workloadHash: Hash; environmentHash: Hash; measurementPlanHash: Hash;
  budget: { wallMs: number };
  /** Budget ids the experiment is expected to be evaluated against (stored on the experiment). */
  budgetIds?: Id[];
  /** §30.3 triggers that promoted progressive cases (recorded as promotedBy). */
  promotedBy?: string[];
}

export interface PerfCachedBaseline { manifestIds: Id[]; run: PerfCaseRun }
export interface BaselineCache { get: (key: string) => PerfCachedBaseline | null | undefined; set: (key: string, v: PerfCachedBaseline) => void }
/** P5: benchmarks hold an exclusive resource lease during measurement; a run that cannot get it is labelled contended. */
export interface PerfLease { tryAcquire: () => boolean; release: () => void }

export interface PerfRunDeps {
  fs: SqliteFeatureStore;
  runner: Runner;
  workload: (hash: Hash) => PerfWorkload | null;
  measurementPlan: (hash: Hash) => PerfMeasurementPlan | null;
  /** Overlay a side's checkout into `dir` (default: copy the repository and apply the candidate's stored contents). */
  materialize?: (side: "BASELINE" | "CANDIDATE", dir: string) => void;
  /** P4 baseline cache keyed by (base commit, workload, environment, toolchain); reused only on full-identity match. */
  baselineCache?: BaselineCache;
  lease?: PerfLease;
  /** Test/host hook: is the recorded environment representative? Default true. */
  environment?: () => { representative: boolean };
  /** Monotonic ms clock for the budget; default Date.now(). */
  now?: () => number;
  /** Called immediately before the evidence is written. A job passes its fencing commit here, so a replaced holder throws instead of saving (issue #85). */
  commit?: () => void;
}

interface Sample { outcome: PerfOutcomeClass; metrics: Record<string, number> }

function parseSample(stdout: string, status: string): Sample | { infra: string } {
  if (status === "TIMEOUT") return { outcome: "TIMEOUT", metrics: {} };
  if (status === "INFRA_ERROR" || status === "REFUSED" || status === "CANCELLED") return { infra: status };
  let line: string | undefined;
  for (const l of stdout.split("\n")) if (l.startsWith("PF_PERF ")) line = l.slice("PF_PERF ".length).trim();
  if (line) {
    try {
      const j = JSON.parse(line) as { outcome?: string; metrics?: Record<string, number> };
      const outcome = OUTCOME_CLASSES.includes(j.outcome as PerfOutcomeClass) ? (j.outcome as PerfOutcomeClass) : "ERROR";
      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(j.metrics ?? {})) if (typeof v === "number" && Number.isFinite(v)) metrics[k] = v;
      return { outcome, metrics };
    } catch { return { outcome: "ERROR", metrics: {} }; }
  }
  return { outcome: status === "PASSED" ? "ERROR" : "ERROR", metrics: {} };
}

const emptyPopulation = (): Record<PerfOutcomeClass, number> => ({ SUCCESS: 0, ERROR: 0, TIMEOUT: 0, CANCELLED: 0 });

function summarizeMetrics(series: Record<string, number[]>): PerfCaseRun["metrics"] {
  const out: PerfCaseRun["metrics"] = {};
  for (const [k, vs] of Object.entries(series)) {
    const sorted = [...vs].sort((a, b) => a - b);
    out[k] = { samples: vs, p50: percentileOf(sorted, 50), p95: percentileOf(sorted, 95), p99: percentileOf(sorted, 99) };
  }
  return out;
}

const PopulationSchema = defineSchema<{ case: string; side: string; population: Record<string, number> }[]>("pf.PerfPopulation", "1", (rows) =>
  asSet(rows.map((r): Canon => ({ case: r.case, side: r.side, population: r.population }))) as Canon);

/**
 * Execute the declared P0–P3 workloads through the Runner and store the PairedExperiment as a PERFORMANCE evidence
 * record. Durable-job body: the caller (handlers-2m.ts) wraps this in svc.jobs.enqueue with a fence.
 */
export async function runPairedBenchmark(d: PerfRunDeps, actor: Id, i: RunPairedBenchmarkInput): Promise<PairedExperiment> {
  if (!(i.budget.wallMs > 0)) throw new FeatureError("INVALID_SCHEMA", "a positive budget.wallMs is required");
  const candidate = d.fs.getCandidateByBinding(i.patchBindingHash);
  if (!candidate) throw new FeatureError("NOT_FOUND", "no candidate bound to that patch binding");
  const rec = d.fs.getRequest(candidate.requestId);
  if (!rec) throw new FeatureError("NOT_FOUND", "the candidate's request no longer exists");
  if (rec.createdBy !== actor) throw new FeatureError("FORBIDDEN", "only the requester can benchmark this request's candidates");
  if (i.baselineSnapshot.commitHash !== candidate.binding.baseCommitHash) throw new FeatureError("STALE_REVISION", "the baseline snapshot does not match the candidate's base commit");
  if (i.baselineSnapshot.contentRootHash !== candidate.binding.baseContentHash) throw new FeatureError("STALE_REVISION", "the baseline snapshot content root does not match the candidate's base");
  const workload = d.workload(i.workloadHash);
  if (!workload) throw new FeatureError("NOT_FOUND", `workload ${i.workloadHash} is not declared`);
  const plan = d.measurementPlan(i.measurementPlanHash);
  if (!plan) throw new FeatureError("NOT_FOUND", `measurement plan ${i.measurementPlanHash} is not declared`);
  if (!Number.isInteger(plan.repetitions) || plan.repetitions < 1 || plan.repetitions > 10_000) throw new FeatureError("INVALID_SCHEMA", "the measurement plan's repetitions must be a positive integer");
  const cases = (plan.cases?.length ? plan.cases : [...PERF_CASES]);
  const baselineCases = new Set(plan.baselineCases ?? ["P0"]);
  const analysis = plan.analysis ?? DEFAULT_ANALYSIS_POLICY;
  const environmentRepresentative = d.environment?.().representative ?? true;

  // P5: take the exclusive lease for the whole measurement; a contended run proceeds but is labelled.
  const exclusive = d.lease ? d.lease.tryAcquire() : true;
  const startedMonotonic = d.now?.() ?? Date.now();
  const budgetDeadline = startedMonotonic + i.budget.wallMs;
  const now = () => d.now?.() ?? Date.now();
  const scratch = makeScratch("pf-perf-");
  const manifests: RunManifest[] = [];
  const measurements: NonNullable<PairedExperiment["measurements"]> = {};
  const caseStates: NonNullable<PairedExperiment["caseStates"]> = {};
  const incompleteReasons: string[] = [];
  const baselineIds: Id[] = []; // manifests of baseline-side runs only, including those reused from the P4 cache (issue #84)
  let contended = !exclusive;
  try {
    // Materialize both checkouts once; the workload files are placed inside each.
    const dirs: Record<"BASELINE" | "CANDIDATE", string> = { BASELINE: join(scratch, "base"), CANDIDATE: join(scratch, "cand") };
    for (const side of ["BASELINE", "CANDIDATE"] as const) {
      mkdirSync(dirs[side], { recursive: true });
      (d.materialize ?? defaultMaterialize(candidate))(side, dirs[side]);
      for (const [rel, text] of Object.entries(workload.files)) {
        const p = safeJoin(dirs[side], rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, text);
      }
    }
    // P4: a fully-identity-matching cached P0 baseline is reused; anything else re-runs.
    const cacheKey = `${candidate.binding.baseCommitHash}|${i.workloadHash}|${i.environmentHash}|${i.baselineSnapshot.toolchainHash}`;
    const cached = baselineCases.has("P0") ? d.baselineCache?.get(cacheKey) ?? null : null;
    const cacheHit = !!cached && cached.run.repetitions >= plan.repetitions;

    for (const c of cases) {
      const caseCfg = workload.cases[c];
      if (!caseCfg) {
        caseStates[c] = "INCOMPLETE";
        incompleteReasons.push(`${c}: the workload declares no such case; the case cannot support a claim (no invented pass)`);
        continue;
      }
      if (now() >= budgetDeadline) {
        caseStates[c] = "INCOMPLETE";
        incompleteReasons.push(`${c}: budget exhausted after ${now() - startedMonotonic} ms of ${i.budget.wallMs} ms (cost limits constrain execution, not truth)`);
        continue;
      }
      const cell: { baseline?: PerfCaseRun; candidate?: PerfCaseRun } = {};
      let p0BaselineIds: Id[] = [];
      measurements[c] = cell;
      for (const side of ["BASELINE", "CANDIDATE"] as const) {
        if (side === "BASELINE" && !baselineCases.has(c)) continue;
        if (side === "BASELINE" && c === "P0" && cacheHit) {
          baselineIds.push(...cached.manifestIds);
          cell.baseline = cached.run;
          continue;
        }
        const before = manifests.length;
        const run = await executeCase(d, rec.contract?.hash ?? "", candidate, i, workload, plan, dirs[side], side, c, budgetDeadline, manifests);
        if ("infra" in run) {
          caseStates[c] = "INCOMPLETE";
          incompleteReasons.push(`${c} ${side}: infrastructure failure (${run.infra}); an infra failure cannot satisfy mandatory validation (§13)`);
        } else {
          cell[side === "BASELINE" ? "baseline" : "candidate"] = run;
          if (side === "BASELINE") { const ids = manifests.slice(before).map((m) => m.id); baselineIds.push(...ids); if (c === "P0") p0BaselineIds = ids; }
        }
      }
      if (caseStates[c] !== "INCOMPLETE") caseStates[c] = "COMPLETE";
      if (c === "P0" && cell.baseline && !cacheHit && p0BaselineIds.length && d.baselineCache) d.baselineCache.set(cacheKey, { manifestIds: p0BaselineIds, run: cell.baseline });
    }
  } finally {
    if (d.lease && exclusive) d.lease.release();
    removeScratch(scratch);
  }

  const populationRows: { case: string; side: string; population: Record<string, number> }[] = [];
  for (const [c, cell] of Object.entries(measurements)) {
    if (cell.baseline) populationRows.push({ case: c, side: "BASELINE", population: cell.baseline.population });
    if (cell.candidate) populationRows.push({ case: c, side: "CANDIDATE", population: cell.candidate.population });
  }
  const candidateManifestIds = manifests.filter((m) => m.contentHash === candidate.binding.candidateContentHash).map((m) => m.id);
  const baselineManifestIds = [...new Set(baselineIds)];
  const experiment: PairedExperiment = {
    id: `pexp:${randomUUID()}`, profile: PERF_PROFILE,
    baselineManifestIds: baselineManifestIds.length ? baselineManifestIds : manifests.slice(0, 1).map((m) => m.id),
    candidateManifestIds: candidateManifestIds.length ? candidateManifestIds : manifests.slice(0, 1).map((m) => m.id),
    populationHash: canonHash(PopulationSchema, populationRows),
    budgetIds: [...(i.budgetIds ?? [])], analysisPolicyHash: analysisPolicyHashOf(analysis), state: "UNVALIDATED",
    cases, promotedBy: [...(i.promotedBy ?? [])], contended,
    requestId: rec.requestId, candidateId: candidate.id, bindingHash: candidate.bindingHash,
    createdAt: new Date().toISOString(), measurementPlanHash: i.measurementPlanHash, workloadHash: i.workloadHash, environmentHash: i.environmentHash,
    environmentRepresentative, measurements, caseStates, incompleteReasons,
  };
  if (!manifests.length) throw new FeatureError("RESOURCE_LIMIT", `no benchmark run could execute: ${incompleteReasons.join("; ") || "nothing ran"}`);

  // Store as a PERFORMANCE evidence record (five record families only; no new tables).
  const results: ValidationResult[] = cases.map((c) => {
    const cell = measurements[c];
    const manifestId = cell?.candidate?.manifestId ?? cell?.baseline?.manifestId ?? manifests[0]!.id;
    const gaps = incompleteReasons.filter((r) => r.startsWith(`${c}:`));
    return {
      id: `vr:${experiment.id}:${c}`, kind: "PERFORMANCE" as const, target: c, runManifestId: manifestId,
      status: (caseStates[c] === "COMPLETE" ? "PASS" : "INCOMPLETE") as ValidationResult["status"],
      evidenceIds: [candidate.id], gaps,
    };
  });
  const evidence: EvidenceRecord = {
    schemaVersion: 1, id: `ev:${experiment.id}`, requestId: rec.requestId, candidateId: candidate.id, bindingHash: candidate.bindingHash, kind: "PERFORMANCE",
    manifest: manifests[manifests.length - 1]!, results,
    toolVersions: { node: process.version, runner: d.runner.isolation, harness: PERF_PROFILE },
    coverage: { state: incompleteReasons.length ? "PARTIAL" : "COMPLETE_WITHIN_SCOPE", gaps: incompleteReasons },
    outcomeRef: experiment.id, createdAt: experiment.createdAt!, performance: experiment,
  };
  d.commit?.();
  d.fs.putEvidence(evidence);
  return experiment;
}

/** Default checkout materialisation: copy the repository and apply the candidate's recorded per-file contents. */
const defaultMaterialize = (candidate: { binding: { repositoryId: string }; contents?: Record<string, string | null>; baseContents?: Record<string, string | null> }) =>
  (side: "BASELINE" | "CANDIDATE", dir: string): void => {
    try { copyTree(candidate.binding.repositoryId, dir); } catch { /* the tree may be unavailable; the overlay below still applies */ }
    const files = side === "BASELINE" ? (candidate.baseContents ?? {}) : (candidate.contents ?? {});
    for (const [rel, text] of Object.entries(files)) {
      const p = safeJoin(dir, rel);
      if (text === null) rmSync(p, { force: true });
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
    }
  };

async function executeCase(
  d: PerfRunDeps, contractHash: string, candidate: { binding: { baseContentHash: Hash; candidateContentHash: Hash; generationProvenanceHash: Hash }; invocationIds: Id[] },
  i: RunPairedBenchmarkInput, workload: PerfWorkload, plan: PerfMeasurementPlan, dir: string, side: "BASELINE" | "CANDIDATE", c: PerfCase, budgetDeadline: number, manifests: RunManifest[],
): Promise<PerfCaseRun | { infra: string }> {
  const caseCfg = workload.cases[c] ?? {};
  const population = emptyPopulation();
  const series: Record<string, number[]> = {};
  const manifestIds: Id[] = [];
  const outDir = join(dir, ".pf-out");
  mkdirSync(outDir, { recursive: true });
  for (let rep = 0; rep < plan.repetitions; rep++) {
    const remaining = budgetDeadline - (d.now?.() ?? Date.now());
    if (remaining <= 0) return { infra: `budget exhausted before repetition ${rep + 1} of ${c} (${side})` };
    const seed = seedOf(i.workloadHash, c, side, rep);
    const startedAt = new Date().toISOString();
    const res = await d.runner.run({
      capabilities: {
        commands: [["node"]], readRoots: [dir], writeRoots: [outDir], network: "DENY", secretRefs: [],
        limits: { wallMs: Math.max(100, Math.min(plan.perRunWallMs ?? 30_000, remaining)), outputBytes: 1_048_576 },
      },
      argv: ["node", safeJoin(dir, workload.entry), ...(caseCfg.argv ?? [])],
      cwd: dir,
      env: { PF_CASE: c, PF_SIDE: side, PF_SEED: String(seed), ...(caseCfg.env ?? {}) },
    });
    const sample = parseSample(res.stdout, res.status);
    if ("infra" in sample) return { infra: `${sample.infra}: ${res.reason ?? res.stderr.slice(0, 200)}` };
    population[sample.outcome]++;
    for (const [k, v] of Object.entries(sample.metrics)) (series[k] ??= []).push(v);
    manifests.push({
      id: `rm:${randomUUID()}`, contractHash, contentHash: side === "BASELINE" ? candidate.binding.baseContentHash : candidate.binding.candidateContentHash,
      buildHash: rawHash(`${PERF_PROFILE}:harness:1`), harnessHash: rawHash(JSON.stringify([d.runner.isolation, d.runner.omissions])),
      fixtureHash: rawHash(JSON.stringify(workload.files)), workloadHash: i.workloadHash, environmentHash: i.environmentHash, toolchainHash: i.baselineSnapshot.toolchainHash,
      oracleHash: rawHash(JSON.stringify(sample)), outcomesArtifactHash: rawHash(res.stdout), generationProvenanceHash: candidate.binding.generationProvenanceHash,
      modelIdentityHashes: [...candidate.invocationIds], startedAt, completedAt: new Date().toISOString(), exitStatus: res.status, isolation: d.runner.isolation,
    });
    manifestIds.push(manifests[manifests.length - 1]!.id);
  }
  void manifestIds;
  return { side, case: c, manifestId: manifests[manifests.length - 1]!.id, repetitions: plan.repetitions, completed: population.SUCCESS + population.ERROR + population.TIMEOUT + population.CANCELLED, population, metrics: summarizeMetrics(series) };
}

const seedOf = (workloadHash: string, c: PerfCase, side: string, rep: number): number => {
  const h = rawHash(`${workloadHash}:${c}:${side}:${rep}`);
  return parseInt(h.slice(0, 8), 16);
};

// ------------------------------------------------------------------------------------------------ evaluation (S11)

export interface PerfEvaluateDeps {
  fs: SqliteFeatureStore;
  budgets: (id: Id) => PerformanceBudget | null;
  authority: AuthorityConfig;
  /** Recover the declared analysis policy by hash; defaults to the built-in S11 policy. */
  analysisPolicy?: (hash: Hash) => PerfAnalysisPolicy | null;
  findExperiment?: (id: Id) => { experiment: PairedExperiment; evidenceId: Id; requestId: Id } | null;
}

const SEVERITY: Record<PerformanceState, number> = { NOT_APPLICABLE: 0, WITHIN_BUDGET: 1, UNVALIDATED: 2, INCONCLUSIVE: 3, REGRESSION: 4 };
const worst = (states: PerformanceState[]): PerformanceState => states.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "NOT_APPLICABLE" as PerformanceState);

interface CaseStats { repetitions: number; baselineP50: number; candidateP50: number; baselineP95: number; candidateP95: number; deltaP50: number; ciLow: number; ciHigh: number }

/** Paired per-metric comparison of one baseline run and one candidate run: percentiles + seeded bootstrap CI on the difference. */
export function compareRuns(baseline: PerfCaseRun, candidate: PerfCaseRun, metric: string, policy: PerfAnalysisPolicy): CaseStats | { error: string } {
  const b = baseline.metrics[metric], c = candidate.metrics[metric];
  if (!b || !c) return { error: `metric ${metric} was not measured on both sides` };
  const n = Math.min(b.samples.length, c.samples.length);
  if (n < policy.minRepetitions) return { error: `only ${n} paired repetitions for ${metric}; S11 requires at least ${policy.minRepetitions} per case` };
  const diffs: number[] = [];
  for (let k = 0; k < n; k++) diffs.push(c.samples[k]! - b.samples[k]!);
  const ci = bootstrapCi(diffs, policy.bootstrapResamples, policy.seed);
  return {
    repetitions: n, baselineP50: b.p50, candidateP50: c.p50, baselineP95: b.p95, candidateP95: c.p95, deltaP50: c.p50 - b.p50,
    ciLow: ci.low, ciHigh: ci.high,
  };
}

function verdictFromStats(budgetId: Id, budget: PerformanceBudget, comparison: string, stats: CaseStats, policy: PerfAnalysisPolicy, prefix: string): PerfBudgetVerdict {
  const limit = budget.allowedDelta ?? budget.absoluteLimit;
  const base = { budgetId, metric: budget.metric, comparison, repetitions: stats.repetitions, baselineP50: stats.baselineP50, candidateP50: stats.candidateP50, baselineP95: stats.baselineP95, candidateP95: stats.candidateP95, deltaP50: stats.deltaP50, ciLow: stats.ciLow, ciHigh: stats.ciHigh, limit };
  if (limit === undefined) return { ...base, state: "UNVALIDATED", reasons: [`${prefix}the budget sets no absolute limit or allowed delta; "fast" cannot be validated without a criterion (§14.2)`] };
  if (stats.ciLow > limit) return { ...base, state: "REGRESSION", reasons: [`${prefix}the bootstrap CI (${fmt(stats.ciLow)}, ${fmt(stats.ciHigh)}) lies entirely above the budget limit ${fmt(limit)}: the budget is exceeded and the interference is reported, not hidden (AT-17)`] };
  if (stats.ciHigh <= limit) return { ...base, state: "WITHIN_BUDGET", reasons: [`${prefix}the bootstrap CI (${fmt(stats.ciLow)}, ${fmt(stats.ciHigh)}) lies within the budget limit ${fmt(limit)}`] };
  return { ...base, state: "INCONCLUSIVE", reasons: [`${prefix}the bootstrap CI (${fmt(stats.ciLow)}, ${fmt(stats.ciHigh)}) crosses the budget limit ${fmt(limit)}: the criterion cannot be supported from this experiment (AT-20)`] };
}
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3));

/** One budget's verdicts: the primary ordinary-traffic comparison (P1 vs P0) plus interference checks for P2/P3. */
function verdictsForBudget(budgetId: Id, budget: PerformanceBudget | null, exp: PairedExperiment, policy: PerfAnalysisPolicy, authority: AuthorityConfig): PerfBudgetVerdict[] {
  const unr = (reasons: string[]): PerfBudgetVerdict => ({ budgetId, state: "UNVALIDATED", metric: budget?.metric ?? "?", comparison: "P1-vs-P0", repetitions: 0, baselineP50: NaN, candidateP50: NaN, baselineP95: NaN, candidateP95: NaN, deltaP50: NaN, ciLow: NaN, ciHigh: NaN, limit: budget?.allowedDelta ?? budget?.absoluteLimit, reasons });
  if (!budget) return [unr(["the budget is not on record; a missing budget can never pass"])];
  if (!budget.authorityBindingId || !authority.bindings.some((b) => b.id === budget.authorityBindingId)) return [unr([`budget ${budget.id} has no authority binding on record (S11): a budget without authority is UNVALIDATED, never a pass`])];
  if (exp.environmentRepresentative === false) return [unr(["no representative environment was recorded for this experiment (AT-19): UNVALIDATED, and no no-regression claim may be made"])];
  if (budget.measurementPlanHash && exp.measurementPlanHash && budget.measurementPlanHash !== exp.measurementPlanHash)
    return [unr([`the budget's measurement plan changed after the experiment was run; the bound assessment is stale (AT-21)`])];
  if (budget.workloadDomainHash && exp.workloadHash && budget.workloadDomainHash !== exp.workloadHash)
    return [unr(["the budget names a different workload domain than the experiment measured; the assessment is stale (AT-21)"])];

  const verdicts: PerfBudgetVerdict[] = [];
  const base0 = exp.measurements?.P0?.baseline, cand1 = exp.measurements?.P1?.candidate;
  if (!base0 || !cand1) verdicts.push(unr(["P0 baseline or P1 candidate measurements are missing; the mandatory ordinary-traffic comparison cannot be made"]));
  else {
    const pop = populationCheck(base0.population, cand1.population);
    if (!pop.ok) verdicts.push(unr([pop.reason!]));
    else {
      const stats = compareRuns(base0, cand1, budget.metric, policy);
      if ("error" in stats) verdicts.push(unr([stats.error]));
      else verdicts.push(verdictFromStats(budgetId, budget, "P1-vs-P0", stats, policy, ""));
    }
  }
  // Interference: ordinary-path impact while the feature is active (P2) and under the large-data case (P3), AT-17.
  for (const c of ["P2", "P3"] as const) {
    const candN = exp.measurements?.[c]?.candidate;
    if (!candN || !base0) continue;
    const pop = populationCheck(base0.population, candN.population);
    if (!pop.ok) { verdicts.push({ ...unr([`${c}: ${pop.reason}`]), comparison: `${c}-vs-P0` }); continue; }
    const stats = compareRuns(base0, candN, budget.metric, policy);
    if ("error" in stats) { verdicts.push({ ...unr([`${c}: ${stats.error}`]), comparison: `${c}-vs-P0` }); continue; }
    const v = verdictFromStats(budgetId, budget, `${c}-vs-P0`, stats, policy, `${c} ordinary-path interference: `);
    if (v.state === "REGRESSION") v.reasons.push("the feature path may be fine; the ordinary path regressed while it ran (AT-17)");
    verdicts.push(v);
  }
  return verdicts;
}

/** Pure S11 evaluation over a stored experiment. Never claims more than the statistics compute (plan rule 7). */
export function evaluateExperiment(exp: PairedExperiment, o: { budgetIds: Id[]; budgets: (id: Id) => PerformanceBudget | null; authority: AuthorityConfig; policy: PerfAnalysisPolicy }): PerformanceAssessment {
  const reasons: string[] = [...(exp.incompleteReasons ?? [])];
  const budgetIds = o.budgetIds.length ? o.budgetIds : exp.budgetIds;
  const verdicts: PerfBudgetVerdict[] = [];
  if (!exp.cases.length) {
    return { schemaVersion: 1, id: `passess:${exp.id}`, state: "NOT_APPLICABLE", reasons: ["the experiment covers no pf-perf-core-v1 cases"], pairedExperimentId: exp.id, verdicts };
  }
  for (const id of budgetIds) verdicts.push(...verdictsForBudget(id, o.budgets(id), exp, o.policy, o.authority));
  if (!verdicts.length) reasons.push("no budgets were evaluated against this experiment");
  let state = worst(verdicts.map((v) => v.state));
  if (SEVERITY[state] < SEVERITY.UNVALIDATED && reasons.length) state = "UNVALIDATED"; // incomplete cases floor the claim
  return { schemaVersion: 1, id: `passess:${exp.id}`, state, reasons, pairedExperimentId: exp.id, verdicts };
}

export interface EvaluatePerformanceInput { pairedExperimentId: Id; budgetIds: Id[]; analysisPolicyHash: Hash }

/** Stored-backed evaluation: finds the experiment's evidence record, applies S11, records a PerformanceAssessed event. */
export function evaluatePerformance(d: PerfEvaluateDeps, actor: Id, i: EvaluatePerformanceInput): Outcome<PerformanceAssessment> {
  if (!i.pairedExperimentId) throw new FeatureError("INVALID_SCHEMA", "pairedExperimentId is required");
  const found = (d.findExperiment ?? defaultFindExperiment(d.fs))(i.pairedExperimentId);
  if (!found) throw new FeatureError("NOT_FOUND", `no paired experiment ${i.pairedExperimentId}`);
  const rec = d.fs.getRequest(found.requestId);
  if (!rec) throw new FeatureError("NOT_FOUND", "the experiment's request no longer exists");
  const exp = found.experiment;
  const reasons: string[] = [];
  let policy: PerfAnalysisPolicy | null = null;
  if (i.analysisPolicyHash !== exp.analysisPolicyHash) {
    reasons.push("the analysis method hash differs from the method declared before the run; the bound assessment is stale (AT-21)");
  } else {
    policy = d.analysisPolicy?.(i.analysisPolicyHash) ?? (i.analysisPolicyHash === defaultAnalysisPolicyHash() ? DEFAULT_ANALYSIS_POLICY : null);
    if (!policy) reasons.push("the analysis policy behind that hash is not on record; the statistics cannot be recomputed");
  }
  const assessment: PerformanceAssessment = policy
    ? evaluateExperiment(exp, { budgetIds: i.budgetIds, budgets: d.budgets, authority: d.authority, policy })
    : { schemaVersion: 1, id: `passess:${exp.id}`, state: "UNVALIDATED", reasons, pairedExperimentId: exp.id, verdicts: [] };
  if (policy && reasons.length) assessment.reasons = [...reasons, ...assessment.reasons];
  assessment.evidenceIds = [found.evidenceId];
  d.fs.appendEvent(eventFor(rec, "PerformanceAssessed", actor, {
    result: assessment.state === "WITHIN_BUDGET" ? "OK" : assessment.state === "REGRESSION" ? "FAILED" : "BLOCKED",
    rationale: `pf-perf-core-v1 ${assessment.state}${assessment.verdicts?.length ? ` over ${assessment.verdicts.length} verdict(s)` : ""}${reasons.length ? `: ${reasons.join("; ")}` : ""}`,
    after: exp.populationHash,
  }));
  return { status: "COMPLETE", value: assessment, evidenceIds: [found.evidenceId], diagnostics: reasons };
}

function defaultFindExperiment(fs: SqliteFeatureStore) {
  return (id: Id): { experiment: PairedExperiment; evidenceId: Id; requestId: Id } | null => {
    for (const rec of fs.listRequests()) {
      for (const cand of fs.listCandidates(rec.requestId)) {
        for (const ev of fs.listEvidence(cand.id)) {
          if (ev.performance?.id === id) return { experiment: ev.performance, evidenceId: ev.id, requestId: rec.requestId };
        }
      }
    }
    return null;
  };
}

// ------------------------------------------------------------------------------------------------ registry (gateway wiring)

/** Declared workloads, measurement plans and budgets for a repository, read from `<repo>/.cie/perf.json`. */
export interface PerfRegistry {
  workloads: Record<Hash, PerfWorkload>;
  measurementPlans: Record<Hash, PerfMeasurementPlan>;
  budgets: Record<Id, PerformanceBudget>;
}

/** Reads the perf registry; unknown keys are rejected, never ignored (config convention). */
export function loadPerfRegistry(repoRoot: string): PerfRegistry {
  const file = join(repoRoot, ".cie", "perf.json");
  const empty: PerfRegistry = { workloads: {}, measurementPlans: {}, budgets: {} };
  if (!existsSync(file)) return empty;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { throw new ConfigError(".cie/perf.json is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(".cie/perf.json must be an object");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["workloads", "measurementPlans", "budgets"].includes(k)) throw new ConfigError(`unknown perf setting ${k}`);
  const reg = { ...empty, ...(o as unknown as PerfRegistry) };
  for (const [h, w] of Object.entries(reg.workloads)) {
    if (!w || typeof w.entry !== "string" || !w.entry || typeof w.files !== "object" || typeof w.cases !== "object") throw new ConfigError(`workload ${h} needs entry, files and cases`);
  }
  for (const [h, p] of Object.entries(reg.measurementPlans)) {
    if (!p || !Number.isInteger(p.repetitions)) throw new ConfigError(`measurement plan ${h} needs an integer repetitions`);
  }
  return reg;
}
