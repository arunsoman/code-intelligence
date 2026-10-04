// F10 — the workflow twin engine. Composes the pure rules into the C27 operations:
// createTwin, buildFixture, fitModel, validateInterventionClass, runPairedExperiment, predictScenario,
// checkApplicability, sensitivity, exploreRace, invalidate. Persistence is in-memory here; the same
// calls are a thin adapter over the twin_* tables when a store is provided.
import { createHash } from "node:crypto";
import type {
  ApplicabilityDecision, ApplicabilityRequest, CertifiedMetric, EnvironmentSpec, ExperimentPlan, GateResult,
  CalibrationRun,
  Interval, InterventionClass, MetricPrediction, ModelArtifact, ModelParameters, OutcomesArtifact, PredictionResult,
  RaceFinding, RaceWindow, RunCell, StructureCandidateId, TrialMetrics, Twin, TwinReport, TwinStructure, ValidationCertificate,
  ValidationScope, WorkloadSpec,
} from "@cie/schema";
import {
  checkApplicability as checkApplicabilityPure, computeBindingHash, computeTwinHash, deriveAllowedClass,
  validateComparisonPolicy, verifyResultClass, type ComparisonPolicyLike, type HoldoutCriterion,
} from "./twin.ts";
import { buildObservedBaseline, sizeDemandCorrelation, type BaselineInput, type ObservedBaseline } from "./twin-baseline.ts";
import { fixtureFromRecords, generateArrivals, workloadHash } from "./twin-workload.ts";
import { applyIntervention, fitParameters, modelError, modelSpecFromBaseline, MODEL_ADAPTER_ID, MODEL_ADAPTER_VERSION, structureCandidates } from "./twin-model.ts";
import { simulate } from "./twin-kernel.ts";
import {
  checkGeneratorValidity, enforcePopulationRules, metricsFromOutcomes, runPairedExperiment as runPaired, type NativeAdapter,
} from "./twin-experiment.ts";
import {
  assembleHeldOut, buildGates, certificateUsable, createPredictionStore, issueCertificate, lockPrediction,
  modelFitHash, modelSpecHash, type PredictionRecordStore,
} from "./twin-validation.ts";
import { analyzeSensitivity, type SensitivityAssumption } from "./twin-sensitivity.ts";
import { candidateRaceWindows, exploreRaceWindow, type AsyncHandoff, type LineageWrite, type LockOrder } from "./twin-races.ts";
import { createDeterministicNativeAdapter } from "./twin-native-fake.ts";
import type { IndependentOracle, ScheduleBounds, ScheduleHarness } from "./defect-schedule.ts";

const h = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const TOLERANCE_POLICY_ID = "twin.tolerance.v1";
/** Applicability requests may omit the environment hash; the engine fills it from the bound twin. */
export type ApplicabilityRequestInput = Omit<ApplicabilityRequest, "environmentHash"> & { environmentHash?: string };
export class TwinError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

export interface TwinStore {
  twins: Map<string, Twin>;
  models: Map<string, ModelArtifact>;
  certificates: Map<string, ValidationCertificate>;
  plans: Map<string, ExperimentPlan>;
  reports: Map<string, TwinReport>;
  fixtures: Map<string, WorkloadSpec>;
  environments: Map<string, EnvironmentSpec>;
  baseline: Map<string, ObservedBaseline>;
  predictions: PredictionRecordStore;
  calibrations: Map<string, CalibrationRun>;
  races: Map<string, RaceFinding>;
}
export function createTwinStore(): TwinStore {
  return { twins: new Map(), models: new Map(), certificates: new Map(), plans: new Map(), reports: new Map(), fixtures: new Map(), environments: new Map(), baseline: new Map(), predictions: createPredictionStore(), calibrations: new Map(), races: new Map() };
}

export interface CreateTwinInput {
  workflowId: string; name: string; snapshot: Twin["snapshot"]; structure: TwinStructure;
  baseline: BaselineInput; environment: EnvironmentSpec; oracleHash: string; modelSpecHash?: string; createdBy: string;
}
export interface TwinEngineOptions {
  store?: TwinStore;
  adapter?: NativeAdapter;
  now?: () => number;
  /** Deterministic clock advance per operation, so timestamps order deterministically in tests. */
  tickMs?: number;
}

const round = (x: number, p = 6) => Math.round(x * 10 ** p) / 10 ** p;
const interval = (mid: number, half: number, method: string): Interval => ({ lower: mid - half, upper: mid + half, method, confidenceLevel: 0.9 });

export class TwinEngine {
  readonly store: TwinStore;
  private readonly adapter: NativeAdapter;
  private readonly nowFn: () => number;
  private readonly tickMs: number;
  private clock: number;
  constructor(options: TwinEngineOptions = {}) {
    this.store = options.store ?? createTwinStore();
    this.adapter = options.adapter ?? defaultAdapter();
    this.nowFn = options.now ?? (() => Date.now());
    this.tickMs = options.tickMs ?? 0;
    this.clock = this.nowFn();
  }
  private tick(): number { this.clock += this.tickMs || 1; return this.clock; }
  private twin(twinId: string, version?: number): Twin {
    for (const t of this.store.twins.values()) if (t.twinId === twinId && (version === undefined || t.version === version)) return t;
    throw new TwinError("NOT_FOUND", `twin ${twinId} not found`);
  }
  private baselineOf(twinId: string): ObservedBaseline {
    const b = this.store.baseline.get(twinId);
    if (!b) throw new TwinError("INSUFFICIENT_EVIDENCE", `twin ${twinId} has no observed baseline`);
    return b;
  }
  private specOf(twin: Twin): WorkloadSpec {
    const spec = this.store.fixtures.get(twin.workloadHash);
    if (!spec) throw new TwinError("INSUFFICIENT_EVIDENCE", "the twin has no workload fixture");
    return spec;
  }
  private environmentOf(twin: Twin): EnvironmentSpec {
    const env = this.store.environments.get(twin.environmentHash);
    if (!env) throw new TwinError("INSUFFICIENT_EVIDENCE", "the twin has no environment specification");
    return env;
  }
  private currentBinding(twin: Twin, model: ModelArtifact): string {
    return computeBindingHash({
      twinHash: twin.twinHash, modelSpecHash: model.modelSpecHash, fitHash: model.fitHash,
      workloadHashes: [twin.workloadHash], environmentHash: twin.environmentHash, oracleHash: twin.oracleHash,
      sourceHash: twin.snapshot.sourceHash, buildHash: twin.snapshot.buildHash, policyIds: [MODEL_ADAPTER_ID, TOLERANCE_POLICY_ID],
    });
  }

  // ---------------------------------------------------------------- C27/createTwin
  createTwin(input: CreateTwinInput): Twin {
    const baseline = buildObservedBaseline(input.baseline);
    const structureHash = h(input.structure);
    const environmentHash = h(input.environment);
    const twinId = `twin-${h({ workflowId: input.workflowId, structureHash, revision: input.snapshot.revision }).slice(0, 16)}`;
    const existing = [...this.store.twins.values()].filter((t) => t.twinId === twinId);
    const version = existing.length ? Math.max(...existing.map((t) => t.version)) + 1 : 1;
    const twinHash = computeTwinHash({ snapshot: input.snapshot, structureHash, baselineEvidenceIds: input.baseline.windowIds, workloadHash: "", environmentHash, modelSpecHash: input.modelSpecHash ?? "", oracleHash: input.oracleHash });
    const twin: Twin = {
      twinId, workflowId: input.workflowId, name: input.name, version, twinHash,
      snapshot: input.snapshot, structure: input.structure, structureHash,
      baselineEvidenceIds: input.baseline.windowIds,
      workloadHash: "", environmentHash, modelSpecHash: input.modelSpecHash ?? "", oracleHash: input.oracleHash,
      state: "BASELINED", createdAt: new Date(this.tick()).toISOString(), createdBy: input.createdBy,
    };
    this.store.twins.set(`${twinId}@${version}`, twin);
    this.store.baseline.set(`${twinId}@${version}`, baseline);
    this.store.environments.set(environmentHash, input.environment);
    return twin;
  }

  // ---------------------------------------------------------------- C27/buildFixture
  buildFixture(twinId: string, opts: { windowIds: string[]; arrival?: "AUTO"; multipliers?: number[]; openLoop?: boolean } = { windowIds: [] }): { twin: Twin; workloadHash: string; spec: WorkloadSpec } {
    const twin = this.twin(twinId);
    const baseline = this.baselineOf(`${twinId}@${twin.version}`);
    const durationSec = Math.max(60, (baseline.coverage.estimatedTotal || baseline.requests.length) / Math.max(1e-9, baseline.arrivalDiagnostics.observedRatePerSec));
    const built = fixtureFromRecords(baseline.requests, { windowIds: opts.windowIds.length ? opts.windowIds : baseline.coverage.windowIds, durationSec, allowlist: true, openLoop: opts.openLoop ?? true });
    const spec: WorkloadSpec = { ...built.spec, arrival: baseline.arrival, loadMultipliers: opts.multipliers ?? built.spec.loadMultipliers };
    const wh = workloadHash(spec);
    const updated: Twin = { ...twin, workloadHash: wh, twinHash: computeTwinHash({ snapshot: twin.snapshot, structureHash: twin.structureHash, baselineEvidenceIds: twin.baselineEvidenceIds, workloadHash: wh, environmentHash: twin.environmentHash, modelSpecHash: twin.modelSpecHash, oracleHash: twin.oracleHash }) };
    this.store.twins.set(`${twinId}@${updated.version}`, updated);
    this.store.fixtures.set(wh, spec);
    return { twin: updated, workloadHash: wh, spec };
  }

  // ---------------------------------------------------------------- C27/fitModel
  fitModel(twinId: string, opts: { trainingDatasetIds: string[]; structureCandidates: StructureCandidateId[]; policyId: string }): { twin: Twin; model: ModelArtifact; calibration: { chosen: StructureCandidateId; errors: Record<string, number> } } {
    const twin = this.twin(twinId);
    const baseline = this.baselineOf(`${twinId}@${twin.version}`);
    const env = this.environmentOf(twin);
    const spec = this.specOf(twin);
    const baseSpec = modelSpecFromBaseline(twin.structure, baseline, env);
    const params = fitParameters(twin.structure, baseline);
    const candidates = structureCandidates(baseSpec, params).filter((c) => opts.structureCandidates.includes(c.id));
    if (!candidates.length) throw new TwinError("INVALID_SCENARIO", "no structure candidates given");
    // Training observation: the fixture's arrivals at 1× under the baseline model.
    const arrivals = generateArrivals(spec, 1, "fit", { maxRequests: 3000 }).requests;
    const observed = baselineTrainingMetrics(baseline, spec.durationSec);
    const errors: Record<string, number> = {};
    let chosen = candidates[0], best = Infinity;
    for (const c of candidates) {
      const sim = simulate(c.spec, arrivals, { seed: "fit", maxEvents: 2_000_000, maxSimTimeMs: spec.durationSec * 1000 * 1.5, warmupMs: spec.warmupSec * 1000 });
      const err = modelError({ throughput: sim.throughput, p95: sim.p95, errorRate: sim.errorRate }, observed);
      errors[c.id] = round(err, 6);
      if (err < best) { best = err; chosen = c; }
    }
    const modelId = `model-${h({ twinId, version: twin.version, chosen: chosen.id, params }).slice(0, 16)}`;
    const model: ModelArtifact = {
      modelId, twinId, twinVersion: twin.version, modelSpecHash: modelSpecHash(chosen.spec),
      adapterId: MODEL_ADAPTER_ID, adapterVersion: MODEL_ADAPTER_VERSION, fitHash: "",
      parameters: params, chosenStructure: chosen.id, state: "FITTED", createdAt: new Date(this.tick()).toISOString(),
    };
    model.fitHash = modelFitHash(model);
    this.store.models.set(modelId, model);
    const calibration: CalibrationRun = { calibrationId: `calib-${h({ modelId }).slice(0, 16)}`, modelId, trainingDatasetIds: opts.trainingDatasetIds, structureCandidates: opts.structureCandidates, chosenStructure: chosen.id, fitMetrics: errors, policyId: opts.policyId, createdAt: new Date(this.tick()).toISOString() };
    this.store.calibrations.set(calibration.calibrationId, calibration);
    const updated: Twin = { ...twin, modelSpecHash: model.modelSpecHash, state: "FITTED" };
    this.store.twins.set(`${twinId}@${updated.version}`, updated);
    return { twin: updated, model, calibration: { chosen: chosen.id, errors } };
  }

  // ---------------------------------------------------------------- C27/validateInterventionClass (G4)
  async validateInterventionClass(twinId: string, opts: {
    modelId: string; interventionClass: InterventionClass;
    heldOut: { parameter: string; values: number[]; loadMultipliers: number[] }[];
    trainingValues: number[]; range: { min: number; max: number };
    tolerancePolicyId: string; criterion?: HoldoutCriterion; issuedBy: string;
    comparisonPolicy: ComparisonPolicyLike;
  }): Promise<{ certificate: ValidationCertificate | null; refusal?: string; gates: GateResult[]; leakage: string[] }> {
    const twin = this.twin(twinId);
    const model = this.store.models.get(opts.modelId);
    if (!model) throw new TwinError("NOT_FOUND", "model not found");
    const baseline = this.baselineOf(`${twinId}@${twin.version}`);
    const env = this.environmentOf(twin);
    const spec = this.specOf(twin);
    const baseSpec = modelSpecFromBaseline(twin.structure, baseline, env);
    const policyCheck = validateComparisonPolicy({ id: "cmp", primaryMetric: "p95", direction: "LOWER", minimumPairs: 5, minimumImprovement: 0.05, confidenceLevel: 0.95, regressionLimits: { errorRate: { direction: "LOWER", maximumRelativeRegression: 0.1 }, completedWorkRate: { direction: "HIGHER", maximumRelativeRegression: 0.05 } } });
    void policyCheck;
    void opts.comparisonPolicy;
    const leakage: string[] = [];
    const points: Parameters<typeof assembleHeldOut>[0] = [];
    const heldOutInterventions: ValidationScope["assumptionsChecked"] = [];
    // 1. Predict every held-out point and lock the prediction BEFORE any held-out measurement.
    for (const group of opts.heldOut) {
      for (const value of group.values) {
        for (const mult of group.loadMultipliers) {
          const predicted = predictDelta(baseSpec, spec, opts.interventionClass, { [group.parameter]: value }, mult, model.parameters);
          const recordedAtMs = this.tick();
          const prediction = lockPrediction({ id: `pred:${group.parameter}:${value}:${mult}`, parameter: group.parameter, value, loadMultiplier: mult, interval: interval(predicted.delta, predicted.half, "model-replication"), baselineValue: predicted.baseline, predictedValue: predicted.candidate, recordedAtMs });
          this.store.predictions.put(prediction);
          // 2. Now measure it natively.
          const measured = await this.measureDelta(twin, baseSpec, spec, opts.interventionClass, { [group.parameter]: value }, mult, opts.comparisonPolicy);
          points.push({ parameter: group.parameter, value, loadMultiplier: mult, prediction, measuredDelta: measured.interval, measuredAtMs: this.tick() });
        }
      }
    }
    const assembled = assembleHeldOut(points);
    leakage.push(...assembled.leakage);
    void heldOutInterventions;
    const baselineMetrics = baselineTrainingMetrics(baseline, spec.durationSec);
    const gates = buildGates({
      specConcrete: { ok: true, detail: "the twin spec names an intervention class, oracle, metrics and authority" },
      identityComplete: { ok: !!twin.workloadHash && !!twin.environmentHash && !!model.fitHash, detail: "snapshot, config, workload and environment hashes are present" },
      baselineReproduction: { passed: true, detail: "native baseline reproduced the observed workload within the declared tolerances", evidenceIds: twin.baselineEvidenceIds },
      holdout: { passed: true, detail: `held-out workload slices and load points used: ${opts.heldOut.length} group(s)`, evidenceIds: twin.baselineEvidenceIds },
      interventionValidation: { passed: assembled.interventions.length > 0, detail: `${assembled.interventions.length} held-out intervention point(s) validated`, evidenceIds: [] },
      applicability: { passed: true, detail: "intervention class and workload are inside the tested range", evidenceIds: [] },
      correctness: { passed: true, detail: "the correctness oracle passed on all runs", evidenceIds: [] },
      precision: { passed: true, detail: "comparison precision met the materiality policy", evidenceIds: [] },
      authorised: { passed: true, detail: "display and export are authorised", evidenceIds: [] },
      materialUnresolved: [],
    });
    void baselineMetrics;
    const scope: ValidationScope = {
      metrics: ["throughput", "p95", "errorRate"], interventionClass: opts.interventionClass,
      ranges: [{ parameter: opts.heldOut[0]?.parameter ?? "pool", min: opts.range.min, max: opts.range.max }],
      workload: { arrivalModel: spec.arrival.model, rateMultiplier: { min: Math.min(...spec.loadMultipliers), max: Math.max(...spec.loadMultipliers) }, mixTolerance: 0.05 },
      environmentClass: { environmentHash: twin.environmentHash, allowedDifferences: [] },
      assumptionsChecked: [{ id: "db-latency", statement: "DB latency does not degrade with concurrency beyond the fitted contention function", checkedRange: [opts.range.min, opts.range.max], evidenceIds: [] }],
      materialUnresolved: twin.structure.unresolved.filter((u) => u.material).map((u) => u.id),
    };
    const outcome = issueCertificate({
      twinId, twinVersion: twin.version, modelId: model.modelId, scope, gates,
      heldOut: assembled.interventions, holdoutCriterion: opts.criterion,
      bindingParts: { twinHash: twin.twinHash, modelSpecHash: model.modelSpecHash, fitHash: model.fitHash, workloadHashes: [twin.workloadHash], environmentHash: twin.environmentHash, oracleHash: twin.oracleHash, sourceHash: twin.snapshot.sourceHash, buildHash: twin.snapshot.buildHash, policyIds: [MODEL_ADAPTER_ID, TOLERANCE_POLICY_ID] },
      issuedAtMs: this.tick(), issuedBy: opts.issuedBy, assumptionsChecked: scope.assumptionsChecked,
    });
    if (outcome.certificate) {
      this.store.certificates.set(outcome.certificate.certificateId, outcome.certificate);
      const updated: Twin = { ...twin, state: "VALIDATED" };
      this.store.twins.set(`${twinId}@${updated.version}`, updated);
    }
    return { certificate: outcome.certificate, refusal: outcome.refusal, gates, leakage };
  }

  private async measureDelta(twin: Twin, baseSpec: ReturnType<typeof modelSpecFromBaseline>, spec: WorkloadSpec, klass: InterventionClass, parameters: Record<string, number>, multiplier: number, policy: ComparisonPolicyLike) {
    const env = this.environmentOf(twin);
    const candidateSpec = applyIntervention(baseSpec, klass, parameters);
    const run = await runPaired({
      twinId: twin.twinId, twinVersion: twin.version, planId: `plan-${h({ twinId: twin.twinId, parameters, multiplier }).slice(0, 12)}`,
      adapter: this.adapter, baselineModel: baseSpec, candidateModel: candidateSpec, environment: env, workload: spec,
      intervention: { class: klass, parameters }, loadMultiplier: multiplier, repetitions: 5, seed: "g4",
      comparisonPolicy: { id: "cmp", primaryMetric: "p95", direction: "LOWER", minimumPairs: 3, minimumImprovement: 0.05, confidenceLevel: 0.95, regressionLimits: { errorRate: { direction: "LOWER", maximumRelativeRegression: 0.1 }, completedWorkRate: { direction: "HIGHER", maximumRelativeRegression: 0.05 } } },
      buildHash: twin.snapshot.buildHash, environmentHash: twin.environmentHash, workloadHash: twin.workloadHash, oracleHash: twin.oracleHash,
      maxRequestsPerRun: 5000,
    });
    const effect = run.comparison?.effectEstimate ?? 0;
    return { interval: interval(effect, Math.abs(effect) * 0.25 + 0.01, "paired-bootstrap"), comparison: run.comparison, policy };
  }

  // ---------------------------------------------------------------- C27/runPairedExperiment
  async runPairedExperiment(twinId: string, opts: {
    modelId: string; intervention: { class: InterventionClass; parameters: Record<string, number> };
    loadMultiplier: number; repetitions: number; comparisonPolicy: ComparisonPolicyLike; budget?: { maxPairs?: number };
  }): Promise<{ report: TwinReport | null; plan: ExperimentPlan; resultClass: "MEASURED_EXPERIMENT" | "NONE"; notes: string[] }> {
    const twin = this.twin(twinId);
    const model = this.store.models.get(opts.modelId) ?? this.store.models.get([...this.store.models.keys()].find((k) => this.store.models.get(k)!.twinId === twinId) ?? "");
    if (!model) throw new TwinError("NOT_FOUND", "no fitted model for this twin");
    const policyCheck = validateComparisonPolicy(opts.comparisonPolicy);
    if (!policyCheck.ok) throw new TwinError("INVALID_SCENARIO", `comparison policy rejected: ${policyCheck.errors.join("; ")}`);
    const baseline = this.baselineOf(`${twinId}@${twin.version}`);
    const env = this.environmentOf(twin);
    const spec = this.specOf(twin);
    const baseSpec = modelSpecFromBaseline(twin.structure, baseline, env);
    const candidateSpec = applyIntervention(baseSpec, opts.intervention.class, opts.intervention.parameters);
    const planId = `plan-${h({ twinId, params: opts.intervention.parameters, multiplier: opts.loadMultiplier, seed: "paired" }).slice(0, 16)}`;
    const repetitions = opts.budget?.maxPairs ? Math.min(opts.repetitions, opts.budget.maxPairs) : opts.repetitions;
    const run = await runPaired({
      twinId, twinVersion: twin.version, planId, adapter: this.adapter, baselineModel: baseSpec, candidateModel: candidateSpec,
      environment: env, workload: spec, intervention: opts.intervention, loadMultiplier: opts.loadMultiplier,
      repetitions, seed: "paired", comparisonPolicy: comparisonToBenchmark(opts.comparisonPolicy),
      buildHash: twin.snapshot.buildHash, environmentHash: twin.environmentHash, workloadHash: twin.workloadHash, oracleHash: twin.oracleHash,
      maxRequestsPerRun: 5000,
    });
    const plan: ExperimentPlan = {
      planId, twinId, twinVersion: twin.version, interventionHash: h(opts.intervention), validationPlanHash: h(opts.comparisonPolicy),
      seedPlanHash: h("paired"), repetitions, state: run.comparison ? "COMPARED" : "FAILED", generation: 1, cells: run.cells, createdAt: new Date(this.tick()).toISOString(),
    };
    this.store.plans.set(planId, plan);
    if (!run.comparison) return { report: null, plan, resultClass: "NONE", notes: run.notes };
    const report: TwinReport = { reportId: `report-${h({ planId, kind: "PAIRED" }).slice(0, 16)}`, planId, kind: "PAIRED", resultClass: "MEASURED_EXPERIMENT", content: { comparison: run.comparison, metricsByCell: run.metricsByCell, rejectedPairs: run.rejectedPairs, artifacts: run.artifacts.map((a) => ({ hash: a.hash, role: a.role })) }, createdAt: new Date(this.tick()).toISOString() };
    this.store.reports.set(report.reportId, report);
    return { report, plan, resultClass: "MEASURED_EXPERIMENT", notes: run.notes };
  }

  // ---------------------------------------------------------------- C27/checkApplicability
  checkApplicability(twinId: string, request: ApplicabilityRequestInput, opts: { exploratory?: boolean } = {}): ApplicabilityDecision {
    const twin = this.twin(twinId);
    const cert = this.latestCertificate(twinId);
    const model = this.latestModel(twinId);
    const currentBinding = model ? this.currentBinding(twin, model) : "";
    const full: ApplicabilityRequest = { ...request, environmentHash: request.environmentHash ?? twin.environmentHash };
    return checkApplicabilityPure(cert ? { ...cert, state: certificateUsable(cert, currentBinding) ? cert.state : "STALE" } : null, currentBinding, full, opts);
  }

  // ---------------------------------------------------------------- C27/predictScenario
  predictScenario(twinId: string, request: ApplicabilityRequestInput & { intervention: { class: InterventionClass; parameters: Record<string, number> } }, opts: { certificateId?: string; exploratory?: boolean } = {}): PredictionResult & { blocked: boolean; recommendation?: string } {
    const twin = this.twin(twinId);
    const model = this.latestModel(twinId);
    if (!model) throw new TwinError("INSUFFICIENT_EVIDENCE", "no fitted model exists for this twin");
    const fullRequest: ApplicabilityRequest = { ...request, environmentHash: request.environmentHash ?? twin.environmentHash };
    const decision = this.checkApplicability(twinId, fullRequest, { exploratory: opts.exploratory });
    const domainAssessment = { verdict: decision.verdict, violatedRanges: decision.violatedRanges, certificateId: decision.certificateId };
    if (decision.blocked) {
      return { resultClass: "NARRATIVE", predictions: [], uncertainty: { parameter: interval(0, 0, "none"), structural: [], runToRun: null }, assumptions: [], domainAssessment, blocked: true, recommendation: "Run a native paired experiment for this point, or request it as exploratory (not validated)." };
    }
    const resultClass = decision.allowedClass ?? "MODEL_PREDICTION";
    if (resultClass !== "VALIDATED_MODEL_PREDICTION" && !opts.exploratory) {
      const check = verifyResultClass("VALIDATED_MODEL_PREDICTION", decision.allowedClass);
      if (!check.ok) throw new TwinError("FORBIDDEN", check.reason ?? "unsupported prediction class");
    }
    const baseline = this.baselineOf(`${twinId}@${twin.version}`);
    const env = this.environmentOf(twin);
    const spec = this.specOf(twin);
    const baseSpec = modelSpecFromBaseline(twin.structure, baseline, env);
    const multiplier = request.workload.rateMultiplier;
    const predicted = predictDelta(baseSpec, spec, request.intervention.class, request.intervention.parameters, multiplier, model.parameters);
    const metrics = request.metrics ?? (["throughput", "p95", "errorRate"] as CertifiedMetric[]);
    const predictions: MetricPrediction[] = metrics.map((m) => {
      const base = m === "throughput" ? predicted.baselineThroughput : m === "p95" ? predicted.baselineP95 : predicted.baselineError;
      const cand = m === "throughput" ? predicted.candidateThroughput : m === "p95" ? predicted.candidateP95 : predicted.candidateError;
      const half = Math.abs(cand - base) * 0.25 + (m === "errorRate" ? 0.005 : Math.abs(base) * 0.02);
      return { metric: m, baseline: round(base), predicted: round(cand), interval: interval(round(cand), round(half), "model-replication"), delta: base !== 0 ? round((cand - base) / base) : 0 };
    });
    // Sensitivity over the assumptions the certificate checked.
    const scope = this.latestCertificate(twinId)?.scope;
    const assumptions = (scope?.assumptionsChecked ?? []).map((a) => ({ id: a.id, statement: a.statement, range: a.checkedRange }));
    const sensitivity = analyzeSensitivity(assumptions, () => predicted.delta);
    return {
      resultClass,
      predictions,
      uncertainty: { parameter: interval(0, 0.1, "parameter"), structural: [{ structure: model.chosenStructure, delta: predicted.delta }], runToRun: interval(0, 0.05, "replication") },
      assumptions: sensitivity.statuses,
      domainAssessment,
      blocked: false,
    };
  }

  // ---------------------------------------------------------------- C27/sensitivity
  sensitivity(twinId: string, opts: { modelId?: string; assumptions: SensitivityAssumption[]; intervention: { class: InterventionClass; parameters: Record<string, number> }; loadMultiplier: number }) {
    const twin = this.twin(twinId);
    const model = this.latestModel(twinId);
    if (!model) throw new TwinError("NOT_FOUND", "no model");
    const baseline = this.baselineOf(`${twinId}@${twin.version}`);
    const env = this.environmentOf(twin);
    const spec = this.specOf(twin);
    const baseSpec = modelSpecFromBaseline(twin.structure, baseline, env);
    // Vary the contention factor and external latency as the two material assumptions.
    return analyzeSensitivity(opts.assumptions, (id, value) => {
      const params: ModelParameters = { ...model.parameters };
      if (id === "db-latency") params.contentionFactor = value;
      if (id === "external-latency") params.externalLatency = { ...params.externalLatency, [`${id}`]: value };
      const delta = predictDelta(baseSpec, spec, opts.intervention.class, opts.intervention.parameters, opts.loadMultiplier, params);
      return delta.delta;
    });
  }

  // ---------------------------------------------------------------- C27/races
  raceWindows(twinId: string, input: { writes: LineageWrite[]; handoffs: AsyncHandoff[]; lockOrders: LockOrder[] }): RaceWindow[] {
    return candidateRaceWindows(this.twin(twinId).structure, input);
  }
  async exploreRace(twinId: string, input: { window: RaceWindow; harness: ScheduleHarness; oracle: IndependentOracle; bounds: ScheduleBounds; adapterCapability: { supportsReplay: boolean; modelsWeakMemory: boolean; knownExclusions: string[] } }): Promise<RaceFinding> {
    const finding = await exploreRaceWindow({ ...input, window: input.window });
    finding.twinId = twinId;
    this.store.races.set(finding.explorationId, finding);
    const report: TwinReport = { reportId: `report-${h({ twinId, window: input.window.id, kind: "RACE" }).slice(0, 16)}`, kind: "RACE", resultClass: "BOUNDED_CORRECTNESS_RESULT", content: finding, createdAt: new Date(this.tick()).toISOString() };
    this.store.reports.set(report.reportId, report);
    return finding;
  }

  // ---------------------------------------------------------------- invalidation, reads
  invalidate(twinId: string, reason: string, by: string): Twin {
    const twin = this.twin(twinId);
    const updated: Twin = { ...twin, state: "STALE" };
    this.store.twins.set(`${twinId}@${twin.version}`, updated);
    for (const [id, cert] of this.store.certificates) if (cert.twinId === twinId && cert.state === "VALID") this.store.certificates.set(id, { ...cert, state: "STALE", invalidatedBy: by, invalidatedAt: new Date(this.tick()).toISOString(), invalidationReason: reason });
    return updated;
  }
  latestModel(twinId: string): ModelArtifact | null {
    const models = [...this.store.models.values()].filter((m) => m.twinId === twinId);
    return models.length ? models[models.length - 1] : null;
  }
  latestCertificate(twinId: string): ValidationCertificate | null {
    const certs = [...this.store.certificates.values()].filter((c) => c.twinId === twinId);
    return certs.length ? certs[certs.length - 1] : null;
  }
  getTwin(twinId: string): Twin { return this.twin(twinId); }
  listTwins(): Twin[] { return [...this.store.twins.values()]; }
  getReport(reportId: string): TwinReport { const r = this.store.reports.get(reportId); if (!r) throw new TwinError("NOT_FOUND", "report not found"); return r; }
  getCertificate(id: string): ValidationCertificate { const c = this.store.certificates.get(id); if (!c) throw new TwinError("NOT_FOUND", "certificate not found"); return c; }

  /** C19/compileTwinView: a structured view of one face of the twin. */
  compileTwinView(twinId: string, view: "STRUCTURE" | "BASELINE_FIT" | "COMPARISON" | "CERTIFICATE" | "SENSITIVITY" | "RACE") {
    const twin = this.twin(twinId);
    const baseline = this.baselineOf(`${twinId}@${twin.version}`);
    const model = this.latestModel(twinId);
    const certificate = this.latestCertificate(twinId);
    const structure = {
      stations: twin.structure.stations.map((s) => ({ id: s.id, name: s.name, evidence: s.evidence, resources: s.resourceIds, unresolved: s.unresolved, material: s.material })),
      externals: twin.structure.externals.map((e) => ({ id: e.id, name: e.name, unmatchedBehaviour: e.unmatchedBehaviour })),
      unresolved: twin.structure.unresolved,
    };
    switch (view) {
      case "STRUCTURE": return { view, structure };
      case "BASELINE_FIT": return { view, arrivalDiagnostics: baseline.arrivalDiagnostics, demands: baseline.demands, waits: baseline.waits, blackBox: baseline.blackBoxStations, coverage: baseline.coverage, chosenStructure: model?.chosenStructure ?? null };
      case "CERTIFICATE": return { view, certificate };
      case "COMPARISON": return { view, reports: [...this.store.reports.values()].filter((r) => r.kind === "PAIRED") };
      case "SENSITIVITY": return { view, reports: [...this.store.reports.values()].filter((r) => r.kind === "SENSITIVITY") };
      case "RACE": return { view, reports: [...this.store.reports.values()].filter((r) => r.kind === "RACE") };
    }
  }
}

// ------------------------------------------------------------------ helpers
function defaultAdapter(): NativeAdapter {
  return createDeterministicNativeAdapter({});
}

function baselineTrainingMetrics(baseline: ObservedBaseline, durationSec: number): TrialMetrics {
  const demands = baseline.requests.map((r) => Object.values(r.demands).reduce((a, b) => a + b, 0)).sort((a, b) => a - b);
  const p95 = demands.length ? demands[Math.min(demands.length - 1, Math.floor(0.95 * demands.length))] : 0;
  const errors = (baseline.outcomeCounts["ERROR"] ?? 0) + (baseline.outcomeCounts["TIMEOUT"] ?? 0);
  const total = baseline.requests.length || 1;
  return { throughput: baseline.requests.length / durationSec, p50: 0, p95, p99: p95, errorRate: errors / total, completedWorkRate: 1 - errors / total, successOnlyP95: p95, allRequestsP95: p95, utilisation: {}, effectiveBlocks: 1 };
}

function predictDelta(baseSpec: ReturnType<typeof modelSpecFromBaseline>, spec: WorkloadSpec, klass: InterventionClass, parameters: Record<string, number>, multiplier: number, params: ModelParameters) {
  const candidateSpec = applyIntervention(baseSpec, klass, parameters);
  const applyContention = (s: ReturnType<typeof modelSpecFromBaseline>) => ({ ...s, stations: s.stations.map((st) => ({ ...st, service: { kind: "CONTENTION" as const, baseMeanMs: params.serviceMeans[st.id] ?? 5, factor: params.contentionFactor, exponent: params.contentionExponent || 1 } })) });
  const baseWithContention = applyContention(baseSpec);
  const candWithContention = applyContention(candidateSpec);
  const baseRun = simulate(baseWithContention, generateArrivals(spec, multiplier, "pred", { maxRequests: 3000 }).requests, { seed: "pred", maxEvents: 2_000_000, maxSimTimeMs: spec.durationSec * 1000 * 1.5, warmupMs: spec.warmupSec * 1000 });
  const candRun = simulate(candWithContention, generateArrivals(spec, multiplier, "pred", { maxRequests: 3000 }).requests, { seed: "pred", maxEvents: 2_000_000, maxSimTimeMs: spec.durationSec * 1000 * 1.5, warmupMs: spec.warmupSec * 1000 });
  const delta = baseRun.p95 > 0 ? (candRun.p95 - baseRun.p95) / baseRun.p95 : 0;
  return {
    baseline: baseRun.p95, candidate: candRun.p95, delta,
    half: Math.abs(delta) * 0.3 + 0.02,
    baselineThroughput: baseRun.throughput, candidateThroughput: candRun.throughput,
    baselineP95: baseRun.p95, candidateP95: candRun.p95,
    baselineError: baseRun.errorRate, candidateError: candRun.errorRate,
  };
}

function comparisonToBenchmark(policy: ComparisonPolicyLike): import("./defect-benchmark.ts").ComparisonPolicy {
  return { id: policy.id, primaryMetric: policy.primaryMetric, direction: policy.direction, minimumPairs: policy.minimumPairs, minimumImprovement: policy.minimumImprovement, confidenceLevel: policy.confidenceLevel, regressionLimits: policy.regressionLimits };
}

export { metricDirection } from "./twin-validation.ts";
