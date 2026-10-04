import { randomUUID } from "node:crypto";
import type { AdapterCapability, ApiError, CallContext, DetectorFinding, ExperimentSpec, PatchValidation, PrPublication, RunManifest, SafetyObligation } from "@cie/schema";
import { ExperimentSpecSchema, RunManifestSchema } from "@cie/schema";
import type { Store } from "./store.ts";
import { artifactHash, exploreSchedules, validateHarness, type IndependentOracle, type ScheduleBounds, type ScheduleHarness, type ScheduleReport } from "./defect-schedule.ts";
import { policyFor } from "./access.ts";
import { LOCAL_ADAPTERS, capabilityOf, unavailableAdapters, type LocalAdapter, type LocalRun, type SourceHarness } from "./defect-local.ts";
import { realpathSync } from "node:fs";

export class DefectError extends Error {
  readonly code: ApiError["code"];
  constructor(code: ApiError["code"], message: string) { super(message); this.code = code; }
}
type Row = { id: string; revision: string; kind: string; version: number; json: string };
export interface ExecutionGrant { id: string; revision: string; principalId: string; specHash: string; expiresAt: number; operation: "RUN" }
export interface PublicationGrant { id: string; revision: string; principalId: string; repository: string; baseBranch: string; baseHash: string; headHash: string; diffHash: string; expiresAt: number; operation: "PUBLISH_DRAFT" }
export interface FixProposal {
  /** A documentation-only change makes no claim about detectors, tests or benchmarks, and is published with a body that says so. */
  kind?: "FIX" | "DOCUMENTATION";
  id: string; findingId: string; revision: string; baseHash: string; headHash: string; diffHash: string;
  diffHandle: string; obligationIds: string[]; harnessHash: string; oracleHash: string;
  title: string; explanation: string;
}
export interface DraftForge {
  resolve(repository: string, baseBranch: string, headBranch: string): Promise<{ baseHash: string; headHash: string | null }>;
  find(publication: PrPublication): Promise<{ number: number; url: string; headHash: string; draft: boolean } | null>;
  createDraft(publication: PrPublication, body: string): Promise<{ number: number; url: string; headHash: string; draft: boolean }>;
}
/** A lease outlives the wall-clock budget by this much, so a run stopped for exceeding its budget is reported as stopped, not as a lost lease. */
const LEASE_GRACE_MS = 15_000;
/** Adapters that check a reviewer-written model of the code, not the code itself. */
const MODEL_ADAPTERS = new Set(["cie.async-schedule", "rust.loom.local"]);
/** The pull request description. A fix says what was checked; a documentation change says it checked nothing and implements nothing. */
export function prBody(p: { kind?: "FIX" | "DOCUMENTATION"; title?: string; findingId: string; headHash: string; baseHash: string; validationId: string; checks: number }): string {
  if (p.kind === "DOCUMENTATION") return `## Problem and behavior\nDocumentation only: this change adds a written design${p.title ? ` (${p.title})` : ""}. It implements no detector and changes no behaviour.\n\n## Change\nCandidate: ${p.headHash}\nThe design is a proposal. Nothing in it has been built, run or measured by this change.\n\n## Evidence\nNone applies. No test, replay or benchmark is claimed.\n\n## Limits\nThe design has not been validated against code. Detector accuracy, performance effects and integrations are open until they are implemented and measured.\n`;
  return `## Problem and behavior\nFinding: ${artifactHash(p.findingId)}\n\n## Change\nCandidate: ${p.headHash}\n\n## Evidence\nValidation: ${artifactHash(p.validationId)}\nBase: ${p.baseHash}\nRecorded checks: ${p.checks}\n\n## Limits\nValidation applies to the recorded source and experiment scope.\n`;
}
const scheduleCapability: AdapterCapability = {
  id: "cie.async-schedule", version: "1", languageIds: ["typescript-model"], platformIds: ["node"], classes: ["SCHEDULE_SEARCH", "REPLAY"],
  schemas: ["defect.schedule.v1", "defect.oracle.v1", "defect.bounds.v1"], supportsReplay: true, modelsWeakMemory: false,
  maximumBounds: { schemaId: "defect.bounds.v1", schemaVersion: 1, value: { maxSchedules: 100000, maxSteps: 512 } },
  knownExclusions: ["Finite async model; arbitrary source execution, database isolation, external I/O and weak memory are unsupported."],
};

/** Durable artifacts and transitions. Grants are provisioned by a trusted host, never by browser requests. */
export class DefectWorkflow {
  readonly store: Store;
  private readonly running = new Map<string, Promise<RunManifest>>();
  /** Checkouts an operator has reviewed and vouches for. Local adapters run nothing else; everything else needs a container boundary. */
  readonly trustedRoots = new Set<string>();
  private readonly local = new Map<string, LocalAdapter>(LOCAL_ADAPTERS.map((a) => [a.id, a]));
  private probes = new Map<string, { available: boolean; reason?: string; toolVersion?: string }>();
  constructor(store: Store) { this.store = store; }
  trustCheckout(root: string) { this.trustedRoots.add(realpathSync(root)); }
  private probe(a: LocalAdapter) { let p = this.probes.get(a.id); if (!p) { p = a.probe(); this.probes.set(a.id, p); } return p; }
  /** Adapters that exist in the design but cannot run here, with why. An absent adapter is never a successful analysis. */
  listUnavailable(languageId?: string) {
    return [...unavailableAdapters(), ...LOCAL_ADAPTERS.filter((a) => !this.probe(a).available).map((a) => ({ id: a.id, languageIds: a.languageIds, reason: this.probe(a).reason ?? "unavailable" }))]
      .filter((u) => !languageId || u.languageIds.includes(languageId) || u.languageIds.includes("any"));
  }
  listCapabilities(languageId?: string, platformId?: string) {
    return [scheduleCapability, ...LOCAL_ADAPTERS.filter((a) => this.probe(a).available).map(capabilityOf)].filter((c) => (!languageId || c.languageIds.includes(languageId)) && (!platformId || c.platformIds.includes(platformId))).map((c) => structuredClone(c));
  }
  private revision(id: string) {
    const rev = this.store.revision(id);
    if (!rev) throw new DefectError("NOT_FOUND", "Revision is absent or access was revoked");
  }
  get<T>(id: string, kind?: string): { value: T; version: number; revision: string } {
    const row = this.store.db.prepare("select * from defect_records where id = ?").get(id) as Row | undefined;
    if (!row || (kind && row.kind !== kind)) throw new DefectError("NOT_FOUND", "Artifact not found");
    this.revision(row.revision);
    const rev = this.store.revision(row.revision)!;
    // Derived run/proposal payloads may contain arbitrary source locations. Until each payload
    // carries a complete entity dependency set, fail closed after a path permission changes.
    if (row.kind !== "finding" && this.store.deniedPrefixes(rev.repoRoot).length) throw new DefectError("FORBIDDEN", "Artifact requires revalidation after source permissions changed");
    if (row.kind === "finding") {
      const f = JSON.parse(row.json) as DetectorFinding, access = policyFor(this.store, rev.repoRoot);
      const entities = new Map(this.store.entities(row.revision).map((e) => [e.entityId, e.file]));
      if (f.entityIds.some((id) => access.deniedEntity(id, (key) => entities.get(key)))) throw new DefectError("FORBIDDEN", "Finding is outside the current source permissions");
    }
    return { value: JSON.parse(row.json) as T, version: row.version, revision: row.revision };
  }
  list<T>(revision: string, kind: string): T[] {
    this.revision(revision);
    return (this.store.db.prepare("select id from defect_records where revision = ? and kind = ? order by id").all(revision, kind) as { id: string }[]).flatMap((r) => {
      try { return [this.get<T>(r.id, kind).value]; } catch (e) { if (e instanceof DefectError && e.code === "FORBIDDEN") return []; throw e; }
    });
  }
  private save(revision: string, kind: string, id: string, value: unknown, expectedVersion = 0) {
    this.revision(revision);
    const existing = this.store.db.prepare("select version from defect_records where id = ?").get(id) as { version: number } | undefined;
    if ((existing?.version ?? 0) !== expectedVersion) throw new DefectError("VERSION_CONFLICT", "Artifact version changed");
    const version = expectedVersion + 1;
    if (!existing) this.store.db.prepare("insert into defect_records values (?,?,?,?,?)").run(id, revision, kind, version, JSON.stringify(value));
    else this.store.db.prepare("update defect_records set version = ?, json = ? where id = ?").run(version, JSON.stringify(value), id);
    this.store.db.prepare("insert into defect_outbox(revision, record_id, version, event) values (?,?,?,?)").run(revision, id, version, JSON.stringify({ kind, id, version }));
    return value;
  }
  private command<T>(ctx: CallContext, revision: string, operation: string, request: unknown, fn: () => T): T {
    this.revision(revision);
    if (!ctx.idempotencyKey) throw new DefectError("INVALID_SCHEMA", "Idempotency key required");
    if (ctx.deadlineMs <= Date.now()) throw new DefectError("DEADLINE_EXCEEDED", "Command deadline expired");
    const key = artifactHash([ctx.actor.tenantId, ctx.actor.principalId, ctx.idempotencyKey]);
    const payload = artifactHash([operation, request]);
    return this.store.tx(() => {
      const prior = this.store.db.prepare("select payload_hash, json from defect_commands where key = ?").get(key) as { payload_hash: string; json: string } | undefined;
      if (prior) {
        if (prior.payload_hash !== payload) throw new DefectError("VERSION_CONFLICT", "Idempotency key was used with another payload");
        return JSON.parse(prior.json) as T;
      }
      const result = fn();
      this.store.db.prepare("insert into defect_commands values (?,?,?,?)").run(key, revision, payload, JSON.stringify(result));
      return result;
    });
  }
  recordFinding(ctx: CallContext, finding: DetectorFinding): DetectorFinding {
    return this.command(ctx, finding.revision, "finding", finding, () => {
      const existing = this.store.db.prepare("select json from defect_records where id = ?").get(finding.id) as { json: string } | undefined;
      if (existing) {
        if (artifactHash(JSON.parse(existing.json)) !== artifactHash(finding)) throw new DefectError("VERSION_CONFLICT", "Finding identity already names different content");
        return JSON.parse(existing.json) as DetectorFinding;
      }
      this.save(finding.revision, "finding", finding.id, finding); return finding;
    });
  }
  defineObligations(ctx: CallContext, findingId: string, expectedVersion: number, obligations: SafetyObligation[]) {
    const finding = this.get<DetectorFinding>(findingId, "finding");
    return this.command(ctx, finding.revision, "obligations", { findingId, expectedVersion, obligations }, () => {
      if (obligations.some((o) => o.state !== "PENDING" || o.evidenceIds.length)) throw new DefectError("INVALID_SCHEMA", "New obligations must start pending");
      const merged = [...finding.value.safetyObligations, ...obligations];
      if (new Set(merged.map((o) => o.id)).size !== merged.length) throw new DefectError("INVALID_SCHEMA", "Duplicate obligation IDs");
      this.save(finding.revision, "finding", findingId, { ...finding.value, version: expectedVersion + 1, safetyObligations: merged }, expectedVersion);
      return merged;
    });
  }
  /** An obligation is evidenced only by records that exist: reports or manifests for this revision. Nothing else moves it. */
  markObligation(ctx: CallContext, findingId: string, expectedVersion: number, obligationId: string, state: "EVIDENCED" | "FAILED" | "UNRESOLVED", evidenceIds: string[]) {
    const finding = this.get<DetectorFinding>(findingId, "finding");
    return this.command(ctx, finding.revision, "markObligation", { findingId, expectedVersion, obligationId, state, evidenceIds }, () => {
      const ob = finding.value.safetyObligations.find((o) => o.id === obligationId);
      if (!ob) throw new DefectError("NOT_FOUND", "No such obligation");
      if (state === "EVIDENCED") {
        if (!evidenceIds.length) throw new DefectError("INSUFFICIENT_EVIDENCE", "An obligation needs evidence to be evidenced");
        for (const e of evidenceIds) { try { const kind = this.store.db.prepare("select kind, revision from defect_records where id = ?").get(e) as { kind: string; revision: string } | undefined; if (!kind || kind.revision !== finding.revision || !["manifest", "report"].includes(kind.kind)) throw 0; } catch { throw new DefectError("INSUFFICIENT_EVIDENCE", "Evidence must be a recorded run manifest or report for this revision"); } }
      }
      const next = { ...finding.value, version: expectedVersion + 1, safetyObligations: finding.value.safetyObligations.map((o) => (o.id === obligationId ? { ...o, state, evidenceIds } : o)) };
      this.save(finding.revision, "finding", findingId, next, expectedVersion);
      return next.safetyObligations;
    });
  }
  putArtifact(ctx: CallContext, revision: string, kind: "harness" | "oracle" | "fixture" | "diff", value: unknown): { handle: string; hash: string } {
    const hash = artifactHash(value), handle = `${kind}:${revision}:${hash}`;
    return this.command(ctx, revision, "artifact", { kind, value }, () => {
      const old = this.store.db.prepare("select id from defect_records where id = ?").get(handle);
      if (!old) this.save(revision, kind, handle, value);
      return { handle, hash };
    });
  }
  provisionGrant(grant: ExecutionGrant | PublicationGrant) {
    this.revision(grant.revision);
    if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) throw new DefectError("INVALID_SCHEMA", "Grant expiration is invalid");
    this.store.db.prepare("insert into defect_grants(id, revision, json) values (?,?,?)").run(grant.id, grant.revision, JSON.stringify(grant));
  }
  revokeGrant(id: string) { this.store.db.prepare("update defect_grants set revoked = 1 where id = ?").run(id); }
  private grant<T extends ExecutionGrant | PublicationGrant>(id: string, ctx: CallContext, operation: T["operation"]): T {
    const row = this.store.db.prepare("select revoked, json from defect_grants where id = ?").get(id) as { revoked: number; json: string } | undefined;
    if (!row || row.revoked) throw new DefectError("FORBIDDEN", "Grant is absent or revoked");
    const grant = JSON.parse(row.json) as T;
    this.revision(grant.revision);
    if (grant.operation !== operation || grant.principalId !== ctx.actor.principalId || grant.expiresAt <= Date.now()) throw new DefectError("FORBIDDEN", "Grant does not authorize this actor, operation or time");
    return grant;
  }
  prepareExperiment(ctx: CallContext, raw: ExperimentSpec): ExperimentSpec {
    const parsed = ExperimentSpecSchema.safeParse(raw);
    if (!parsed.success) throw new DefectError("INVALID_SCHEMA", "Invalid defect.v1 experiment specification");
    const spec = parsed.data, finding = this.get<DetectorFinding>(spec.findingId, "finding");
    if (finding.revision !== spec.baselineRevision) throw new DefectError("STALE_REVISION", "Finding belongs to a different revision");
    const local = this.local.get(spec.adapterId);
    if (local) {
      if (!this.probe(local).available) throw new DefectError("PROVIDER_UNAVAILABLE", `${local.id} is unavailable: ${this.probe(local).reason}`);
      if (!local.classes.includes(spec.kind)) throw new DefectError("PROVIDER_UNAVAILABLE", "This adapter does not support that experiment class");
      const h = this.get<SourceHarness>(spec.harnessHandle, "harness");
      if (h.value.schemaId !== "defect.source-harness.v1" || h.value.adapterId !== local.id || artifactHash(h.value) !== spec.harnessHash || h.revision !== spec.baselineRevision) throw new DefectError("STALE_REVISION", "Source harness differs from its recorded hash");
      if (!this.trustedRoots.has(h.value.checkoutRoot)) throw new DefectError("FORBIDDEN", "This checkout is not trusted for local execution; run it through a container boundary");
      this.get(spec.oracleSchemaId, "oracle");
      return this.command(ctx, spec.baselineRevision, "prepareExperiment", spec, () => { this.save(spec.baselineRevision, "spec", spec.id, spec); return spec; });
    }
    if (spec.adapterId !== scheduleCapability.id || spec.adapterVersion !== scheduleCapability.version || !scheduleCapability.classes.includes(spec.kind)) throw new DefectError("PROVIDER_UNAVAILABLE", "No installed adapter supports this specification");
    const harness = this.get<ScheduleHarness>(spec.harnessHandle, "harness");
    if (harness.revision !== spec.baselineRevision || artifactHash(harness.value) !== spec.harnessHash) throw new DefectError("STALE_REVISION", "Harness hash or revision differs");
    const oracle = this.get<IndependentOracle>(spec.oracleSchemaId, "oracle");
    if (oracle.revision !== spec.baselineRevision || spec.bounds.schemaId !== "defect.bounds.v1" || spec.bounds.schemaVersion !== 1) throw new DefectError("INVALID_SCHEMA", "Unsupported oracle or bound schema");
    validateHarness(harness.value, oracle.value, spec.bounds.value as unknown as ScheduleBounds);
    for (let i = 0; i < spec.fixtureHandles.length; i++) {
      const fixture = this.get(spec.fixtureHandles[i], "fixture");
      if (fixture.revision !== spec.baselineRevision || artifactHash(fixture.value) !== spec.fixtureHashes[i]) throw new DefectError("STALE_REVISION", "Fixture differs from its recorded hash");
    }
    return this.command(ctx, spec.baselineRevision, "prepareExperiment", spec, () => { this.save(spec.baselineRevision, "spec", spec.id, spec); return spec; });
  }
  runExperiment(ctx: CallContext, specId: string, expectedVersion: number, replay?: { manifestId: string; expectedSourceHash: string }): Promise<RunManifest> {
    const key = artifactHash([ctx.actor, ctx.idempotencyKey, specId, expectedVersion, replay]);
    const existing = this.running.get(key);
    if (existing) return existing;
    const run = this.executeExperiment(ctx, specId, expectedVersion, replay).finally(() => { this.running.delete(key); });
    this.running.set(key, run); return run;
  }
  private async executeExperiment(ctx: CallContext, specId: string, expectedVersion: number, replay?: { manifestId: string; expectedSourceHash: string }): Promise<RunManifest> {
    const stored = this.get<ExperimentSpec>(specId, "spec"), spec = stored.value;
    const grant = this.grant<ExecutionGrant>(spec.executionGrantId, ctx, "RUN");
    if (grant.revision !== stored.revision || grant.specHash !== artifactHash(spec)) throw new DefectError("FORBIDDEN", "Grant does not bind this exact experiment");
    const localAdapter = this.local.get(spec.adapterId);
    const harness = this.get<ScheduleHarness>(spec.harnessHandle, "harness").value;
    const oracle = this.get<IndependentOracle>(spec.oracleSchemaId, "oracle").value;
    let replaySchedule: string[] | undefined;
    const sourceHash = localAdapter ? (harness as unknown as SourceHarness).checkoutHash : spec.candidateHead ?? artifactHash([stored.revision, spec.harnessHash]);
    if (replay) {
      const old = this.get<RunManifest>(replay.manifestId, "manifest");
      if (old.revision !== stored.revision || sourceHash !== replay.expectedSourceHash || old.value.oracleHash !== artifactHash(oracle) || !old.value.scheduleHandle) throw new DefectError("STALE_REVISION", "Replay source, oracle, revision or schedule does not match");
      replaySchedule = this.get<string[]>(old.value.scheduleHandle, "schedule").value;
      if (localAdapter && !localAdapter.supportsReplay) throw new DefectError("PROVIDER_UNAVAILABLE", "This adapter cannot replay a run");
    }
    const admitted = this.command(ctx, stored.revision, "runExperiment", { specId, expectedVersion, replay }, () => {
      if (stored.version !== expectedVersion) throw new DefectError("VERSION_CONFLICT", "Experiment version changed");
      const active = this.store.db.prepare("select id from defect_attempts where spec_id = ? and state in ('RUNNING', 'DISPATCHED') and lease_until > ?").get(specId, Date.now());
      if (active) throw new DefectError("VERSION_CONFLICT", "Experiment is already running");
      const id = `attempt:${randomUUID()}`, manifestId = `run:${randomUUID()}`, startedAt = new Date().toISOString();
      this.store.db.prepare("insert into defect_attempts values (?,?,?,?,?,?,?)").run(id, stored.revision, specId, 1, "RUNNING", Date.now() + spec.budget.wallTimeMs + LEASE_GRACE_MS, JSON.stringify({ manifestId, startedAt }));
      return { id, manifestId, startedAt };
    });
    const previous = this.store.db.prepare("select id from defect_records where id = ?").get(admitted.manifestId);
    if (previous) return this.get<RunManifest>(admitted.manifestId, "manifest").value;
    const attempt = this.store.db.prepare("select state from defect_attempts where id = ?").get(admitted.id) as { state: string } | undefined;
    if (!attempt || attempt.state !== "RUNNING") throw new DefectError("CANCELLED", "Attempt is no longer active");
    const claimed = this.store.db.prepare("update defect_attempts set state = 'DISPATCHED' where id = ? and state = 'RUNNING'").run(admitted.id);
    if (!claimed.changes) throw new DefectError("VERSION_CONFLICT", "Another executor owns this attempt");
    const signal = new AbortController();
    const check = () => {
      const row = this.store.db.prepare("select state from defect_attempts where id = ?").get(admitted.id) as { state: string } | undefined;
      try { this.grant(spec.executionGrantId, ctx, "RUN"); if (!row || row.state !== "DISPATCHED") signal.abort(); } catch { signal.abort(); }
    };
    const timer = setInterval(check, 10);
    let report: ScheduleReport & { observations?: Record<string, unknown>; evidenceLevel?: string; sourceHash?: string; buildHash?: string; seed?: string | null; replay?: string[] };
    try {
      if (localAdapter) {
        const sh = harness as unknown as SourceHarness;
        const r: LocalRun = await localAdapter.run(sh, { wallMs: spec.budget.wallTimeMs, memoryBytes: spec.budget.memoryBytes, outputBytes: spec.budget.outputBytes, processes: spec.budget.processes }, signal.signal);
        report = { status: r.status === "INFRA_FAILED" ? "INCONCLUSIVE" : (r.status as ScheduleReport["status"]), exploredSchedules: 0, completedSearch: r.evidenceLevel === "BOUNDED_EXHAUSTIVE", schedule: r.replay.length ? r.replay : null, state: null, oracleHash: artifactHash(oracle), harnessHash: artifactHash(harness), exclusions: r.exclusions, observations: r.observations, evidenceLevel: r.evidenceLevel, sourceHash: r.sourceHash, buildHash: r.buildHash, seed: r.seed, replay: r.replay };
        if (r.status === "INFRA_FAILED") report.exclusions = [...report.exclusions, "The tool failed to run; no passing result is available."];
      } else
      report = await exploreSchedules(harness, oracle, spec.bounds.value as unknown as ScheduleBounds, { replay: replaySchedule, signal: signal.signal, deadline: Math.min(Date.now() + spec.budget.wallTimeMs, ctx.deadlineMs) });
    } catch (e) {
      report = { status: "INCONCLUSIVE", exploredSchedules: 0, completedSearch: false, schedule: null, state: null, oracleHash: artifactHash(oracle), harnessHash: artifactHash(harness), exclusions: [localAdapter ? `The adapter refused or failed: ${(e as Error).message}` : "Harness evaluation failed; no passing result is available."] };
    } finally { clearInterval(timer); }
    const row = this.store.db.prepare("select state, lease_until from defect_attempts where id = ?").get(admitted.id) as { state: string; lease_until: number } | undefined;
    check();
    const fenced = signal.signal.aborted || !row || row.lease_until < Date.now();
    const manifest: RunManifest = RunManifestSchema.parse({
      id: admitted.manifestId, specId, specHash: artifactHash(spec), sourceHash: report.sourceHash ?? sourceHash,
      buildHash: report.buildHash ?? artifactHash(["cie.async-schedule/1", harness]), adapterVersion: spec.adapterVersion,
      environmentHash: artifactHash([spec.environmentProfileId, process.version, process.platform, process.arch]), oracleHash: artifactHash(oracle),
      fixtureHashes: spec.fixtureHashes, seed: report.seed ?? null, scheduleHandle: report.schedule ? `schedule:${admitted.manifestId}` : null,
      startedAt: admitted.startedAt, finishedAt: new Date().toISOString(), status: fenced ? "CANCELLED" : report.status,
      evidenceIds: [`report:${admitted.manifestId}`], omissions: [...report.exclusions, ...(fenced ? ["Attempt cancelled, revoked, or lease expired; result quarantined."] : [])],
    });
    // If retention deleted the source, no late artifact is allowed to resurrect it.
    this.store.tx(() => {
      this.revision(stored.revision);
      this.save(stored.revision, fenced ? "quarantine" : "report", manifest.evidenceIds[0], report);
      if (report.schedule) this.save(stored.revision, "schedule", manifest.scheduleHandle!, report.schedule);
      this.save(stored.revision, "manifest", manifest.id, manifest);
      this.store.db.prepare("update defect_attempts set state = ? where id = ?").run(fenced ? "QUARANTINED" : "FINISHED", admitted.id);
    });
    return manifest;
  }
  cancelExperiment(specId: string) {
    this.get(specId, "spec");
    return this.store.db.prepare("update defect_attempts set state = 'CANCELLED', generation = generation + 1 where spec_id = ? and state in ('RUNNING', 'DISPATCHED')").run(specId).changes;
  }
  recoverExpired(now = Date.now()) {
    return this.store.db.prepare("update defect_attempts set state = 'INFRA_FAILED', generation = generation + 1 where state in ('RUNNING', 'DISPATCHED') and lease_until < ?").run(now).changes;
  }
  proposeFix(ctx: CallContext, proposal: FixProposal): FixProposal {
    const finding = this.get<DetectorFinding>(proposal.findingId, "finding");
    const diff = this.get<string>(proposal.diffHandle, "diff");
    if (finding.revision !== proposal.revision || diff.revision !== proposal.revision || artifactHash(diff.value) !== proposal.diffHash) throw new DefectError("STALE_REVISION", "Patch source or diff does not match");
    if (finding.value.safetyObligations.some((o) => !proposal.obligationIds.includes(o.id))) throw new DefectError("INVALID_SCHEMA", "Proposal omits mandatory safety obligations");
    return this.command(ctx, proposal.revision, "proposeFix", proposal, () => { this.save(proposal.revision, "proposal", proposal.id, proposal); return proposal; });
  }
  validateFix(ctx: CallContext, request: { proposalId: string; expectedHeadHash: string; baselineRunIds: string[]; candidateRunIds: string[]; regressionRunIds: string[] }): PatchValidation {
    const p = this.get<FixProposal>(request.proposalId, "proposal").value;
    if (p.headHash !== request.expectedHeadHash) throw new DefectError("STALE_REVISION", "Candidate changed after validation was requested");
    const unresolved: string[] = [];
    const load = (ids: string[]) => ids.map((id) => { const r = this.get<RunManifest>(id, "manifest"); if (r.revision !== p.revision) throw new DefectError("STALE_REVISION", "Run belongs to another revision"); return r.value; });
    const base = load(request.baselineRunIds), candidate = load(request.candidateRunIds), regression = load(request.regressionRunIds);
    if (base.filter((r) => r.status === "PROPERTY_FAILED").length < 2) unresolved.push("Baseline failure must be reproduced twice");
    if (!candidate.length || candidate.some((r) => r.status !== "SUCCEEDED" || r.sourceHash !== p.headHash)) unresolved.push("Candidate checks must succeed on the exact candidate source");
    if (!regression.length || regression.some((r) => r.status !== "SUCCEEDED" || r.sourceHash !== p.headHash)) unresolved.push("Passing candidate regression runs are required");
    if ([...base, ...candidate].some((r) => r.oracleHash !== p.oracleHash)) unresolved.push("Correctness property changed");
    if (base.some((r) => r.sourceHash !== p.baseHash)) unresolved.push("Baseline source differs from the proposal base");
    const finding = this.get<DetectorFinding>(p.findingId, "finding").value;
    if (finding.safetyObligations.some((o) => o.state !== "EVIDENCED")) unresolved.push("Mandatory safety obligations remain unresolved");
    // A model harness cannot certify application code. Source validation requires a source-executing adapter.
    if ([...base, ...candidate, ...regression].some((r) => MODEL_ADAPTERS.has(this.get<ExperimentSpec>(r.specId, "spec").value.adapterId))) unresolved.push("Finite-model runs do not validate the application source patch");
    const validation: PatchValidation = {
      id: `validation:${artifactHash([request, p])}`, proposalId: p.id, baseHash: p.baseHash, headHash: p.headHash, diffHash: p.diffHash,
      harnessHash: p.harnessHash, oracleHash: p.oracleHash, runManifestIds: [...request.baselineRunIds, ...request.candidateRunIds, ...request.regressionRunIds],
      benchmarkComparisonIds: [], obligationIds: p.obligationIds, state: candidate.some((r) => r.status === "PROPERTY_FAILED") ? "FAILED" : unresolved.length ? "REVIEWABLE_WITH_LIMITS" : "PASSED_DEFINED_GATES", unresolved,
    };
    return this.command(ctx, p.revision, "validateFix", request, () => { this.save(p.revision, "validation", validation.id, validation); return validation; });
  }
  preparePullRequest(ctx: CallContext, request: { proposalId: string; validationId: string; repository: string; baseBranch: string }): PrPublication {
    const p = this.get<FixProposal>(request.proposalId, "proposal").value;
    if (p.kind === "DOCUMENTATION") {
      // Nothing to validate: it carries no behavioural claim. It still needs an exact head, a base and a grant to be published.
      const id = `publication:${artifactHash(request)}`;
      const docs: PrPublication = { id, repository: request.repository, baseBranch: request.baseBranch, baseHash: p.baseHash, headBranch: `cie/${artifactHash(id).slice(0, 20)}`, headHash: p.headHash, proposalId: p.id, validationId: "none", authorizationId: "pending", status: "PREPARED", prNumber: null, prUrl: null };
      return this.command(ctx, p.revision, "preparePullRequest", request, () => { this.save(p.revision, "publication", id, docs); return docs; });
    }
    const v = this.get<PatchValidation>(request.validationId, "validation").value;
    if (v.proposalId !== p.id || v.headHash !== p.headHash || v.diffHash !== p.diffHash) throw new DefectError("STALE_REVISION", "Validation does not describe this patch");
    const id = `publication:${artifactHash(request)}`;
    const publication: PrPublication = { id, repository: request.repository, baseBranch: request.baseBranch, baseHash: p.baseHash, headBranch: `cie/${artifactHash(id).slice(0, 20)}`, headHash: p.headHash, proposalId: p.id, validationId: v.id, authorizationId: "pending", status: "PREPARED", prNumber: null, prUrl: null };
    return this.command(ctx, p.revision, "preparePullRequest", request, () => { this.save(p.revision, "publication", id, publication); return publication; });
  }
  async publishPullRequest(ctx: CallContext, request: { publicationId: string; expectedHeadHash: string; authorizationId: string }, forge: DraftForge): Promise<PrPublication> {
    const stored = this.get<PrPublication>(request.publicationId, "publication"), pub = stored.value;
    const proposal = this.get<FixProposal>(pub.proposalId, "proposal").value;
    const docs = proposal.kind === "DOCUMENTATION";
    const validation = docs ? null : this.get<PatchValidation>(pub.validationId, "validation").value;
    const authorize = () => {
      const g = this.grant<PublicationGrant>(request.authorizationId, ctx, "PUBLISH_DRAFT");
      if (g.revision !== stored.revision || g.repository !== pub.repository || g.baseBranch !== pub.baseBranch || g.baseHash !== pub.baseHash || g.headHash !== pub.headHash || g.diffHash !== proposal.diffHash || request.expectedHeadHash !== pub.headHash) throw new DefectError("FORBIDDEN", "Publication grant does not bind this exact repository, base and patch");
    };
    authorize();
    if (validation && validation.state !== "PASSED_DEFINED_GATES") throw new DefectError("INSUFFICIENT_EVIDENCE", "Validation gates have not passed");
    if (pub.status === "PUBLISHED") return pub;
    const current = await forge.resolve(pub.repository, pub.baseBranch, pub.headBranch);
    if (current.baseHash !== pub.baseHash || current.headHash !== pub.headHash) throw new DefectError("STALE_REVISION", "Forge base or candidate head changed");
    authorize();
    const intent = this.command(ctx, stored.revision, "publishPullRequest", request, () => {
      const value = { ...pub, authorizationId: request.authorizationId, status: "PUBLISHING" as const };
      this.save(stored.revision, "publication", pub.id, value, stored.version); return value;
    });
    let receipt = await forge.find(intent);
    if (!receipt) {
      authorize();
      // Export IDs and validation scope only. Source, traces and arbitrary model text are not included.
      const body = prBody({ kind: proposal.kind, title: proposal.title, findingId: proposal.findingId, headHash: pub.headHash, baseHash: pub.baseHash, validationId: pub.validationId, checks: validation?.runManifestIds.length ?? 0 });
      receipt = await forge.createDraft(intent, body);
    }
    if (!receipt.draft || receipt.headHash !== pub.headHash) throw new DefectError("VERSION_CONFLICT", "Forge receipt is not a draft for the validated head");
    const done: PrPublication = { ...intent, status: "PUBLISHED", prNumber: receipt.number, prUrl: receipt.url };
    this.store.tx(() => { const now = this.get<PrPublication>(pub.id, "publication"); this.save(stored.revision, "publication", pub.id, done, now.version); });
    return done;
  }
}
