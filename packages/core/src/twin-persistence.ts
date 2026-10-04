// F10 WP-02/WP-04: persistence for the twin engine. The engine's in-memory `TwinStore` is serialised
// into the `twin_*` tables added by migration 31 and loaded back. Rows keyed by the identity hashes the
// engine already computed (workloadHash, environmentHash), so a reload never silently rebinds a result.
import type { DatabaseSync } from "node:sqlite";
import type {
  CalibrationRun, EnvironmentSpec, ExperimentPlan, ModelArtifact, RaceFinding, Twin, TwinReport,
  ValidationCertificate, WorkloadSpec,
} from "@cie/schema";
import type { LockedPrediction } from "./twin-validation.ts";
import type { ObservedBaseline } from "./twin-baseline.ts";
import { createTwinStore, type TwinStore } from "./twin-engine.ts";

const J = (v: unknown): string => JSON.stringify(v);
const P = <T>(s: string | null): T | undefined => (s === null ? undefined : (JSON.parse(s) as T));

export function saveTwin(db: DatabaseSync, twin: Twin): void {
  db.prepare("insert or replace into twins(twin_id, workflow_id, name, created_by, created_at) values(?,?,?,?,?)")
    .run(twin.twinId, twin.workflowId, twin.name, twin.createdBy, twin.createdAt);
  db.prepare(`insert or replace into twin_versions(
      twin_id, version, twin_hash, revision, snapshot_json, structure_json, structure_hash, baseline_evidence_json,
      workload_hash, environment_hash, model_spec_hash, oracle_hash, state) values(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(twin.twinId, twin.version, twin.twinHash, twin.snapshot.revision, J(twin.snapshot), J(twin.structure), twin.structureHash,
      J(twin.baselineEvidenceIds), twin.workloadHash, twin.environmentHash, twin.modelSpecHash, twin.oracleHash, twin.state);
}

export function saveObservedBaseline(db: DatabaseSync, twinId: string, version: number, baseline: ObservedBaseline): void {
  db.prepare("insert or replace into twin_baselines(twin_id, twin_version, baseline_json) values(?,?,?)").run(twinId, version, J(baseline));
}

export function saveWorkloadFixture(db: DatabaseSync, hash: string, spec: WorkloadSpec): void {
  db.prepare("insert or replace into workload_fixtures(workload_hash, spec_json, fixture_ref, derived_from_json, streams_json, created_at) values(?,?,?,?,?,?)")
    .run(hash, J(spec), spec.derivedFrom.windowIds.join(",") || "fixture", spec.derivedFrom.labelAllowlistApplied ? J(spec.derivedFrom) : null, J(spec.streams), new Date().toISOString());
}

export function saveEnvironmentSpec(db: DatabaseSync, hash: string, spec: EnvironmentSpec): void {
  db.prepare("insert or replace into environment_specs(environment_hash, spec_json, created_at) values(?,?,?)").run(hash, J(spec), new Date().toISOString());
}

export function saveModelArtifact(db: DatabaseSync, model: ModelArtifact): void {
  db.prepare(`insert or replace into model_artifacts(
      model_id, twin_id, twin_version, model_spec_hash, adapter_id, adapter_version, parent_model_id, fit_hash,
      parameters_json, state, created_at) values(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(model.modelId, model.twinId, model.twinVersion, model.modelSpecHash, model.adapterId, model.adapterVersion,
      model.parentModelId ?? null, model.fitHash, J(model.parameters), model.state, model.createdAt);
}

export function saveCalibrationRun(db: DatabaseSync, run: CalibrationRun): void {
  db.prepare(`insert or replace into calibration_runs(
      calibration_id, model_id, training_dataset_ids_json, structure_candidates_json, chosen_structure,
      fit_metrics_json, policy_id, created_at) values(?,?,?,?,?,?,?,?)`)
    .run(run.calibrationId, run.modelId, J(run.trainingDatasetIds), J(run.structureCandidates), run.chosenStructure,
      J(run.fitMetrics), run.policyId, run.createdAt);
}

export function saveValidationCertificate(db: DatabaseSync, cert: ValidationCertificate): void {
  db.prepare(`insert or replace into validation_certificates(
      certificate_id, twin_id, twin_version, model_id, scope_json, binding_hash, holdout_report_json,
      intervention_report_json, state, issued_at, issued_by, invalidated_by, invalidated_at, invalidation_reason)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(cert.certificateId, cert.twinId, cert.twinVersion, cert.modelId, J(cert.scope), cert.bindingHash,
      J(cert.validation), J(cert.validation.heldOutInterventions), cert.state, cert.issuedAt, cert.issuedBy,
      cert.invalidatedBy ?? null, cert.invalidatedAt ?? null, cert.invalidationReason ?? null);
}

export function saveExperimentPlan(db: DatabaseSync, plan: ExperimentPlan): void {
  db.prepare(`insert or replace into twin_experiments(
      plan_id, twin_id, twin_version, intervention_hash, validation_plan_hash, seed_plan_hash, state, generation, created_at, plan_json)
      values(?,?,?,?,?,?,?,?,?,?)`)
    .run(plan.planId, plan.twinId, plan.twinVersion, plan.interventionHash, plan.validationPlanHash, plan.seedPlanHash,
      plan.state, plan.generation, plan.createdAt, J(plan));
  db.prepare("delete from twin_run_cells where plan_id = ?").run(plan.planId);
  for (const cell of plan.cells) {
    db.prepare(`insert or replace into twin_run_cells(
        plan_id, cell_id, pair_id, role, run_manifest_id, order_index, comparable, incomparable_reason) values(?,?,?,?,?,?,?,?)`)
      .run(plan.planId, cell.cellId, cell.pairId, cell.role, cell.runManifestId, cell.orderIndex, cell.comparable ? 1 : 0, cell.incomparableReason ?? null);
  }
}

export function saveTwinReport(db: DatabaseSync, report: TwinReport): void {
  db.prepare(`insert or replace into twin_reports(report_id, plan_id, kind, result_class, content_json, certificate_id, created_at)
      values(?,?,?,?,?,?,?)`)
    .run(report.reportId, report.planId ?? null, report.kind, report.resultClass, J(report.content), report.certificateId ?? null, report.createdAt);
}

export function saveRaceFinding(db: DatabaseSync, finding: RaceFinding): void {
  db.prepare(`insert or replace into schedule_explorations(
      exploration_id, twin_id, harness_hash, oracle_hash, bounds_json, status, explored, completed, schedule_artifact_hash, created_at, finding_json)
      values(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(finding.explorationId, finding.twinId, finding.harnessHash ?? "", finding.oracleHash ?? "", J(finding.bounds),
      finding.status, finding.exploredSchedules, finding.completedSearch ? 1 : 0, finding.scheduleArtifactHash ?? null, new Date().toISOString(), J(finding));
}

export function saveLockedPrediction(db: DatabaseSync, prediction: LockedPrediction): void {
  db.prepare(`insert or replace into prediction_records(
      prediction_id, parameter, value, load_multiplier, interval_json, baseline_value, predicted_value, recorded_at_ms, hash)
      values(?,?,?,?,?,?,?,?,?)`)
    .run(prediction.id, prediction.parameter, prediction.value, prediction.loadMultiplier, J(prediction.interval),
      prediction.baselineValue, prediction.predictedValue, prediction.recordedAtMs, prediction.hash);
}

/** Persist every map in a `TwinStore`. Idempotent and safe to call repeatedly. */
export function saveTwinStore(db: DatabaseSync, store: TwinStore): void {
  db.exec("begin immediate");
  try {
    for (const twin of store.twins.values()) saveTwin(db, twin);
    for (const [key, baseline] of store.baseline) { const [twinId, version] = key.split("@"); saveObservedBaseline(db, twinId, Number(version), baseline); }
    for (const [hash, spec] of store.fixtures) saveWorkloadFixture(db, hash, spec);
    for (const [hash, env] of store.environments) saveEnvironmentSpec(db, hash, env);
    for (const model of store.models.values()) saveModelArtifact(db, model);
    for (const run of store.calibrations.values()) saveCalibrationRun(db, run);
    for (const cert of store.certificates.values()) saveValidationCertificate(db, cert);
    for (const plan of store.plans.values()) saveExperimentPlan(db, plan);
    for (const report of store.reports.values()) saveTwinReport(db, report);
    for (const finding of store.races.values()) saveRaceFinding(db, finding);
    for (const prediction of store.predictions.all()) saveLockedPrediction(db, prediction);
    db.exec("commit");
  } catch (e) {
    try { if (db.isTransaction) db.exec("rollback"); } catch { /* already rolled back */ }
    throw e;
  }
}

/** Rebuild a `TwinStore` from the `twin_*` tables. */
export function loadTwinStore(db: DatabaseSync): TwinStore {
  const store = createTwinStore();
  for (const r of db.prepare("select * from twin_versions").all() as any[]) {
    const twin: Twin = {
      twinId: r.twin_id, workflowId: (db.prepare("select workflow_id from twins where twin_id = ?").get(r.twin_id) as { workflow_id: string }).workflow_id,
      name: (db.prepare("select name from twins where twin_id = ?").get(r.twin_id) as { name: string }).name,
      version: r.version, twinHash: r.twin_hash, snapshot: P(r.snapshot_json)!, structure: P(r.structure_json)!,
      structureHash: r.structure_hash, baselineEvidenceIds: P(r.baseline_evidence_json)!,
      workloadHash: r.workload_hash, environmentHash: r.environment_hash, modelSpecHash: r.model_spec_hash, oracleHash: r.oracle_hash,
      state: r.state, createdAt: (db.prepare("select created_at from twins where twin_id = ?").get(r.twin_id) as { created_at: string }).created_at,
      createdBy: (db.prepare("select created_by from twins where twin_id = ?").get(r.twin_id) as { created_by: string }).created_by,
    };
    store.twins.set(`${twin.twinId}@${twin.version}`, twin);
  }
  for (const r of db.prepare("select * from twin_baselines").all() as any[]) store.baseline.set(`${r.twin_id}@${r.twin_version}`, P(r.baseline_json)!);
  for (const r of db.prepare("select * from workload_fixtures").all() as any[]) store.fixtures.set(r.workload_hash, P(r.spec_json)!);
  for (const r of db.prepare("select * from environment_specs").all() as any[]) store.environments.set(r.environment_hash, P(r.spec_json)!);
  for (const r of db.prepare("select * from model_artifacts").all() as any[]) {
    store.models.set(r.model_id, {
      modelId: r.model_id, twinId: r.twin_id, twinVersion: r.twin_version, modelSpecHash: r.model_spec_hash,
      adapterId: r.adapter_id, adapterVersion: r.adapter_version, parentModelId: r.parent_model_id ?? undefined,
      fitHash: r.fit_hash, parameters: P(r.parameters_json)!, chosenStructure: (db.prepare("select chosen_structure from calibration_runs where model_id = ?").get(r.model_id) as { chosen_structure: ModelArtifact["chosenStructure"] } | undefined)?.chosen_structure ?? "FIXED",
      state: r.state, createdAt: r.created_at,
    });
  }
  for (const r of db.prepare("select * from calibration_runs").all() as any[]) {
    store.calibrations.set(r.calibration_id, {
      calibrationId: r.calibration_id, modelId: r.model_id, trainingDatasetIds: P(r.training_dataset_ids_json)!,
      structureCandidates: P(r.structure_candidates_json)!, chosenStructure: r.chosen_structure, fitMetrics: P(r.fit_metrics_json)!,
      policyId: r.policy_id, createdAt: r.created_at,
    });
  }
  for (const r of db.prepare("select * from validation_certificates").all() as any[]) {
    store.certificates.set(r.certificate_id, {
      certificateId: r.certificate_id, twinId: r.twin_id, twinVersion: r.twin_version, modelId: r.model_id,
      scope: P(r.scope_json)!, bindingHash: r.binding_hash, validation: P(r.holdout_report_json)!,
      state: r.state, issuedAt: r.issued_at, issuedBy: r.issued_by,
      invalidatedBy: r.invalidated_by ?? undefined, invalidatedAt: r.invalidated_at ?? undefined, invalidationReason: r.invalidation_reason ?? undefined,
    });
  }
  for (const r of db.prepare("select * from twin_experiments").all() as any[]) store.plans.set(r.plan_id, P(r.plan_json)!);
  for (const r of db.prepare("select * from twin_reports").all() as any[]) {
    store.reports.set(r.report_id, { reportId: r.report_id, planId: r.plan_id ?? undefined, kind: r.kind, resultClass: r.result_class, content: P(r.content_json), certificateId: r.certificate_id ?? undefined, createdAt: r.created_at });
  }
  for (const r of db.prepare("select * from schedule_explorations").all() as any[]) {
    const finding = P<RaceFinding>(r.finding_json);
    if (finding) store.races.set(r.exploration_id, finding);
  }
  for (const r of db.prepare("select * from prediction_records").all() as any[]) {
    store.predictions.put({ id: r.prediction_id, parameter: r.parameter, value: r.value, loadMultiplier: r.load_multiplier, interval: P(r.interval_json)!, baselineValue: r.baseline_value, predictedValue: r.predicted_value, recordedAtMs: r.recorded_at_ms, hash: r.hash });
  }
  return store;
}
