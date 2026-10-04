// C22 hypothesis and agentic investigation engine (design: C22_Hypothesis_Engine_Detailed_Design.md).
//
// An investigation is a durable aggregate: a scoped question, competing hypotheses with explicit predictions and
// assumptions, observations, assessments of each observation against each hypothesis, a read-only plan of checks, and an
// honest completion report. The engine proposes and tests explanations; it never decides that one is "the cause" except
// as the evidence supports, and it can finish with the question unresolved.
//
// Rules this file enforces, each with a test (packages/core/test/c22.test.ts):
//   - model output can propose; it cannot grant authority, name an executable, or issue a verdict (broker.ts, validate*)
//   - every dispatched read is bound to a revision, a permission epoch, a deadline and a generation (reserve/publish)
//   - a pause, cancel, steer or revocation fences: a result that arrives later is stored but never published
//   - evidence absence is not contradiction without an exhaustive coverage certificate (reducer.ts)
//   - repeated descriptions of one source are one piece of evidence (correlation groups)
//   - durable commit (state + event + checkpoint + outbox, one transaction) comes before anything is shown
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { CallContext, Claim } from "@cie/schema";
import { applyVerdict, gateClaim } from "../claims.ts";
import { failpoint } from "../failpoint.ts";
import { claimOf, observation as evidenceFor } from "../forms/common.ts";
import type { Store } from "../store.ts";
import { locateFrames, parseTrace } from "../trace.ts";
import { TOOLS, invokeTool, toolRequest, validateRequest, type ToolEnv, type ToolResult } from "./broker.ts";
import { assessPrediction, correlationGroup, hash, priority, reduceHypothesis, RULE_VERSION } from "./reducer.ts";
import {
  C22Error, DEFAULT_POLICY, ENUMS, oneOf,
  type Assumption, type BoardDelta, type BoardReply, type BoardSnapshot, type CompletionReport, type CoverageCertificate, type CoverageReport, type DiscriminatingCheck, type EvidenceAssessment, type EvidenceGap,
  type ExperimentProposal, type Finding, type Goal, type HypothesisDraft, type HypothesisEvaluation, type HypothesisRecord, type InvestigationEvent, type InvestigationMode,
  type InvestigationPolicy, type InvestigationScope, type InvestigationSnapshot, type MechanismLink, type Observation, type ObservationInput, type OutcomeTag, type Prediction,
  type StepAttempt, type StepRecord, type StopReason, type TimeWindow, type EventType, type Usage, type GapReason,
} from "./types.ts";

export type ToolRunner = (toolId: string, req: { schemaId: string; version: number; payload: Record<string, unknown> }, env: ToolEnv) => ToolResult | Promise<ToolResult>;
/** A model (or any outside source) proposing candidate explanations. It returns drafts; the engine validates every reference. */
export type Proposer = (input: { question: string; roots: string[]; revision: string }) => Promise<HypothesisDraft[]>;
export type ExperimentRunner = (proposal: ExperimentProposal) => Promise<void>;

export interface EngineOptions { tools?: ToolRunner; now?: () => Date; proposer?: Proposer; experimentRunner?: ExperimentRunner }
export interface SteeringAction { type: "Prioritize" | "AddScope" | "NarrowScope" | "ChangeWindow" | "ChangeGoal" | "ExcludeCheck" | "SetMode"; hypothesisId?: string; refs?: string[]; window?: TimeWindow; goal?: Goal; checkId?: string; reason?: string; mode?: InvestigationMode }
export interface RuntimeEvent { eventId: string; eventTime: string; deploymentId?: string | null; attribution: { id: string; entityId: string } | null; signature: string; outcome: OutcomeTag; predictionId?: string | null; sampling?: "NONE" | "SAMPLED" | "UNKNOWN"; certificate?: CoverageCertificate | null; traceLineage?: string | null; description?: string }
export interface RuntimeBatch { events: RuntimeEvent[]; retractedEventIds?: string[]; sourceWatermark: string }
export interface CommandReceipt { investigationId: string; investigationVersion: number; eventSequence: number; replayed?: boolean }

const UNIVERSAL = /\b(every|all|any)\b.{0,30}\b(way|ways|path|paths|case|cases|bug|bugs|defect|defects|inconsisten\w*)\b|\bfind every\b|\bprove\b|\bguarantee\b/i;
const inStep = new AsyncLocalStorage<{ investigationId: string }>();
const iso = (d: Date) => d.toISOString();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export class InvestigationEngine {
  private store: Store;
  private tools: ToolRunner;
  private now: () => Date;
  private proposer?: Proposer;
  private runner?: ExperimentRunner;
  /** Experiments handed to a runner. Zero unless a grant existed, which the tests check. */
  experimentDispatches = 0;

  constructor(store: Store, opts: EngineOptions = {}) {
    this.store = store;
    this.tools = opts.tools ?? ((id, req, env) => invokeTool(id, req, env));
    this.now = opts.now ?? (() => new Date());
    this.proposer = opts.proposer;
    this.runner = opts.experimentRunner;
  }
  setClock(now: () => Date) { this.now = now; }
  setTools(t: ToolRunner) { this.tools = t; }
  setProposer(p: Proposer | undefined) { this.proposer = p; }

  private get db() { return this.store.db; }

  // ------------------------------------------------------------------ persistence primitives
  private row(id: string): { json: string; deleted: number } | undefined { return this.db.prepare("select json, deleted from c22_investigations where id = ?").get(id) as any; }
  /** The snapshot, or NOT_FOUND. A deleted investigation reads as gone, never as a reconstruction. */
  load(id: string): InvestigationSnapshot {
    const r = this.row(id);
    if (!r || r.deleted) throw new C22Error("NOT_FOUND", r?.deleted ? "this investigation was deleted" : "no such investigation");
    return JSON.parse(r.json);
  }
  private save(s: InvestigationSnapshot) {
    this.db.prepare("insert into c22_investigations(id, workspace_id, state, version, generation, event_seq, deleted, json) values (?,?,?,?,?,?,0,?) on conflict(id) do update set state=excluded.state, version=excluded.version, generation=excluded.generation, event_seq=excluded.event_seq, json=excluded.json")
      .run(s.id, s.workspaceId, s.execution, s.version, s.generation, s.eventSequence, JSON.stringify(s));
  }
  private event(s: InvestigationSnapshot, type: EventType, payload: Record<string, unknown>, cmd: string): InvestigationEvent {
    s.eventSequence += 1;
    const ev: InvestigationEvent = { id: "evt:" + hash(s.id, s.eventSequence), investigationId: s.id, sequence: s.eventSequence, aggregateVersion: s.version, generation: s.generation, type, payload, scopeHash: s.scope.scopeHash, causedByCommandId: cmd, createdAt: iso(this.now()) };
    this.db.prepare("insert into c22_events values (?,?,?)").run(s.id, ev.sequence, JSON.stringify(ev));
    this.db.prepare("insert or ignore into outbox(event_id, topic, payload, created_at) values (?,?,?,?)").run(ev.id, `c22.${type}`, JSON.stringify({ investigationId: s.id, sequence: ev.sequence, type }), ev.createdAt);
    return ev;
  }
  private putHyp(h: HypothesisRecord) { this.db.prepare("insert or replace into c22_hypotheses values (?,?,?,?,?)").run(h.id, h.version, h.investigationId, h.claimId, JSON.stringify(h)); }
  hypothesesOf(s: InvestigationSnapshot, opts: { all?: boolean } = {}): HypothesisRecord[] {
    const rows = this.db.prepare("select json from c22_hypotheses where investigation_id = ? order by id, version").all(s.id) as { json: string }[];
    const latest = new Map<string, HypothesisRecord>();
    for (const r of rows) { const h = JSON.parse(r.json) as HypothesisRecord; latest.set(h.id, h); }
    return [...latest.values()].filter((h) => opts.all || h.lifecycle === "ACTIVE");
  }
  hypothesis(id: string, version?: number): HypothesisRecord | null {
    const r = (version ? this.db.prepare("select json from c22_hypotheses where id = ? and version = ?").get(id, version) : this.db.prepare("select json from c22_hypotheses where id = ? order by version desc limit 1").get(id)) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : null;
  }
  private observationsOf(invId: string): Observation[] { return (this.db.prepare("select json from c22_observations where investigation_id = ?").all(invId) as { json: string }[]).map((r) => JSON.parse(r.json)); }
  private putObs(o: Observation) { this.db.prepare("insert or replace into c22_observations values (?,?,?,?,?)").run(o.id, o.investigationId, o.sourceEventIds[0], o.correlationGroupId, JSON.stringify(o)); }
  private assessmentsOf(hid: string): EvidenceAssessment[] { return (this.db.prepare("select json from c22_assessments where hypothesis_id = ?").all(hid) as { json: string }[]).map((r) => JSON.parse(r.json)); }
  private putAssessment(a: EvidenceAssessment) { this.db.prepare("insert or replace into c22_assessments values (?,?,?,?,?)").run(a.id, a.hypothesisId, a.hypothesisVersion, a.observationId, JSON.stringify(a)); }
  stepsOf(invId: string): StepRecord[] { return (this.db.prepare("select json from c22_steps where investigation_id = ? order by rowid").all(invId) as { json: string }[]).map((r) => JSON.parse(r.json)); }
  private putStep(st: StepRecord) { this.db.prepare("insert or replace into c22_steps values (?,?,?,?)").run(st.id, st.investigationId, st.state, JSON.stringify(st)); }
  private step(id: string): StepRecord | null { const r = this.db.prepare("select json from c22_steps where id = ?").get(id) as { json: string } | undefined; return r ? JSON.parse(r.json) : null; }
  attemptsOf(stepId: string): StepAttempt[] { return (this.db.prepare("select json from c22_attempts where step_id = ? order by attempt_number").all(stepId) as { json: string }[]).map((r) => JSON.parse(r.json)); }
  private putAttempt(a: StepAttempt) { this.db.prepare("insert or replace into c22_attempts values (?,?,?,?,?,?)").run(a.id, a.stepId, a.attemptNumber, a.dispatchId, a.state, JSON.stringify(a)); }
  private checksOf(invId: string): DiscriminatingCheck[] { return (this.db.prepare("select json from c22_checks where investigation_id = ?").all(invId) as { json: string }[]).map((r) => JSON.parse(r.json)); }
  private putCheck(invId: string, c: DiscriminatingCheck) { this.db.prepare("insert or replace into c22_checks values (?,?,?)").run(c.id, invId, JSON.stringify(c)); }
  private putPayload(invId: string, handle: string, v: unknown) { this.db.prepare("insert or replace into c22_payloads values (?,?,?)").run(handle, invId, JSON.stringify(v)); }
  private payload<T>(handle: string): T | null { const r = this.db.prepare("select json from c22_payloads where handle = ?").get(handle) as { json: string } | undefined; return r ? JSON.parse(r.json) : null; }

  // ------------------------------------------------------------------ authority (design §12: revocation takes effect at once)
  private epoch(invId: string): { epoch: number; revoked: boolean } {
    const r = this.db.prepare("select epoch, revoked from c22_authority where investigation_id = ?").get(invId) as any;
    return r ? { epoch: r.epoch, revoked: !!r.revoked } : { epoch: 0, revoked: false };
  }
  /** The viewer's permission over this investigation is withdrawn. Work stops; nothing already running may publish; reads are sanitized. */
  revokeAccess(invId: string, cmd = "revoke"): InvestigationSnapshot {
    return this.store.tx(() => {
      const s = this.load(invId);
      const cur = this.epoch(invId);
      this.db.prepare("insert into c22_authority values (?,?,1) on conflict(investigation_id) do update set epoch = excluded.epoch, revoked = 1").run(invId, cur.epoch + 1);
      this.fenceAll(s, "CANCELLED", "ACCESS_REVOKED");
      s.execution = "CANCELLED"; s.stopReason = "ACCESS_REVOKED"; s.disposition = "UNRESOLVED";
      this.event(s, "EXECUTION_FENCED", { reason: "ACCESS_REVOKED" }, cmd);
      return this.commit(s, cmd);
    });
  }
  private authorized(s: InvestigationSnapshot): boolean { const e = this.epoch(s.id); return !e.revoked && e.epoch === s.scope.authorityEpoch; }

  // ------------------------------------------------------------------ commands: idempotency and the version check
  private idem<T>(ctx: CallContext, op: string, req: unknown, fn: () => T): T {
    if (!ctx.idempotencyKey) return fn();
    const key = `c22:${op}:${ctx.idempotencyKey}`, h = hash(req);
    const prior = this.db.prepare("select payload_hash, receipt from idempotency where key = ?").get(key) as any;
    if (prior) {
      if (prior.payload_hash !== h) throw new C22Error("VERSION_CONFLICT", "idempotency key reused with a different payload");
      return JSON.parse(prior.receipt);
    }
    const out = fn();
    this.db.prepare("insert into idempotency values (?,?,?)").run(key, h, JSON.stringify(out));
    return out;
  }
  /** One writer per version: compare, apply, bump, checkpoint, all in one transaction. */
  private mutate<T>(ctx: CallContext, op: string, id: string, expectedVersion: number | undefined, fn: (s: InvestigationSnapshot) => T): { value: T; receipt: CommandReceipt } {
    const cmd = ctx.idempotencyKey || randomUUID();
    return this.idem(ctx, op, { id, expectedVersion, op }, () => this.store.tx(() => {
      const s = this.load(id);
      if (expectedVersion !== undefined && expectedVersion !== s.version) throw new C22Error("VERSION_CONFLICT", `expected version ${expectedVersion}, current ${s.version}`, s.version);
      const value = fn(s);
      const next = this.commit(s, cmd);
      return { value, receipt: { investigationId: id, investigationVersion: next.version, eventSequence: next.eventSequence } };
    }));
  }
  private commit(s: InvestigationSnapshot, cmd: string): InvestigationSnapshot {
    s.version += 1; s.updatedAt = iso(this.now());
    const board = this.boardOf(s, false);
    const json = JSON.stringify({ snapshot: s, board });
    s.lastCheckpointId = "ckpt:" + hash(s.id, s.version);
    this.db.prepare("insert or replace into c22_checkpoints values (?,?,?,?)").run(s.id, s.version, hash(json), JSON.stringify({ snapshot: s, board }));
    this.save(s);
    void cmd;
    return s;
  }

  // ------------------------------------------------------------------ create / get / list
  private scopeOf(revisionId: string, repoRoot: string, roots: string[], window: TimeWindow | null, epoch: number, deployments: string[] = []): InvestigationScope {
    const base = { revision: revisionId, repoRoot, roots: [...roots].sort(), deploymentIds: deployments, incidentWindow: window, allowedTools: Object.keys(TOOLS), maxGraphDepth: 4, maxGraphNodes: 400, authorityEpoch: epoch };
    return { ...base, scopeHash: hash(base) };
  }

  create(ctx: CallContext, req: { workspaceId: string; goal: Goal; mode?: InvestigationMode; revision?: string; /** false: no automatic seeding; the person proposes the hypotheses (guided use). */ seed?: boolean; policy?: Partial<InvestigationPolicy>; budget?: { tokens?: number; cost?: number; toolSteps?: number } }): InvestigationSnapshot {
    if (inStep.getStore()) throw new C22Error("FORBIDDEN", "an investigation step may not start another investigation: that would be a hidden, unbounded recursion");
    const q = (req.goal?.question ?? "").trim();
    if (!q || q.length > 500) throw new C22Error("INVALID_SCHEMA", "the question must be 1–500 characters");
    const mode = oneOf("mode", req.mode ?? "BOUNDED_AUTOMATIC", "mode");
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) throw new C22Error("NOT_FOUND", "no indexed revision; index a repository first");
    return this.idem(ctx, "create", { req }, () => this.store.tx(() => {
      const roots: string[] = [];
      for (const r of req.goal.entityRefs ?? []) { if (!this.store.entitiesById(rev.id, [r])[0]) throw new C22Error("INVALID_SCHEMA", `"${r}" is not an entity of revision ${rev.id}`); roots.push(r); }
      if (req.goal.trace) {
        const parsed = parseTrace(req.goal.trace);
        for (const f of locateFrames(this.store, rev, parsed)) if (f.entityId && !roots.includes(f.entityId)) roots.push(f.entityId);
      }
      const id = "inv:" + randomUUID();
      const policy = { ...DEFAULT_POLICY, ...(req.policy ?? {}) };
      const now = iso(this.now());
      const s: InvestigationSnapshot = {
        id, workspaceId: req.workspaceId, version: 0, generation: 1, eventSequence: 0, goal: { ...req.goal, question: q }, mode, scope: this.scopeOf(rev.id, rev.repoRoot, roots, req.goal.incidentWindow ?? null, 0),
        execution: "READY", closure: "OPEN", disposition: "UNASSESSED", hypothesisIds: [], stepIds: [],
        budget: { limit: { tokens: req.budget?.tokens ?? 200_000, cost: req.budget?.cost ?? 5, toolSteps: req.budget?.toolSteps ?? policy.maxPlanSteps }, consumed: { tokens: 0, cost: 0, toolSteps: 0 }, reserved: { tokens: 0, cost: 0, toolSteps: 0 } },
        policy, coverage: { inspectedEntityIds: [], excludedEntityIds: [], attemptedCheckIds: [], missing: [], completeness: "UNKNOWN", scopeHash: "" }, stopReason: null,
        pendingEvidence: 0, pinned: [], waitingFor: null, lastCheckpointId: "", createdAt: now, updatedAt: now,
      };
      s.coverage.scopeHash = s.scope.scopeHash;
      this.db.prepare("insert into c22_authority values (?,0,0)").run(id);
      // "start" creates a READY plan with its seed step; seeding itself runs in the first wave.
      if (req.seed !== false) {
        const seed = this.newStep(s, null, "internal.seed", { schemaId: "c22.step.seed.v1", version: 1, payload: {} }, []);
        this.putStep(seed); s.stepIds.push(seed.id);
      }
      this.event(s, "CREATED", { goalHash: hash(s.goal), mode, universalGoal: UNIVERSAL.test(q) }, id);
      return this.commit(s, id);
    }));
  }

  get(id: string): InvestigationSnapshot { const s = this.load(id); return this.refreshFreshness(s); }
  list(workspaceId: string, limit = 20): { items: InvestigationSnapshot[]; nextCursor: string | null } {
    const rows = this.db.prepare("select id from c22_investigations where workspace_id = ? and deleted = 0 order by rowid desc limit ?").all(workspaceId, Math.min(Math.max(limit, 1), 100)) as { id: string }[];
    return { items: rows.map((r) => this.load(r.id)), nextCursor: null };
  }

  private newStep(s: InvestigationSnapshot, checkId: string | null, toolId: string, request: StepRecord["request"], dependsOn: string[]): StepRecord {
    return { id: "step:" + hash(s.id, checkId ?? toolId, request.payload), investigationId: s.id, version: 1, checkId, toolId, request, dependsOn, state: dependsOn.length ? "PENDING" : "READY", generation: s.generation, attemptIds: [], resultHandle: null, resultHash: null, unavailableReason: null, acceptedAttemptId: null };
  }

  // ------------------------------------------------------------------ hypotheses
  /** Every id in a candidate must exist in this revision; unknown ones are rejected, never guessed or "corrected". */
  validateCandidate(s: InvestigationSnapshot, d: HypothesisDraft): string[] {
    const problems: string[] = [];
    const rev = s.scope.revision;
    if (!d.statement || d.statement.length > 500) problems.push("the statement must be 1–500 characters");
    const ents = new Set<string>();
    for (const m of d.mechanism ?? []) for (const end of [m.from, m.to]) if (end.kind === "entity") ents.add(end.ref);
    for (const a of d.assumptions ?? []) a.entityRefs?.forEach((r) => ents.add(r));
    for (const r of ents) if (!this.store.entitiesById(rev, [r])[0]) problems.push(`entity "${r}" is not in the pinned revision`);
    const evs = new Set<string>([...(d.basisEvidenceIds ?? []), ...(d.mechanism ?? []).flatMap((m) => m.evidenceIds ?? []), ...(d.assumptions ?? []).flatMap((a) => a.evidenceIds ?? [])]);
    for (const e of evs) if (!this.store.evidence(rev, e)) problems.push(`evidence "${e}" does not exist for the pinned revision`);
    for (const m of d.mechanism ?? []) { try { oneOf("mechanismRelation", m.relation); } catch (e) { problems.push((e as Error).message); } }
    for (const a of d.assumptions ?? []) { try { oneOf("assumption", a.verification); } catch (e) { problems.push((e as Error).message); } }
    for (const p of d.predictions ?? []) {
      for (const t of [...p.outcomeIfTrue, ...p.outcomeIfFalse]) { try { oneOf("outcome", t); } catch (e) { problems.push((e as Error).message); } }
      if (p.request) {
        try { validateRequest(p.request.toolId, toolRequest(p.request.toolId, p.request.payload), s.scope); } catch (e) { problems.push(`prediction "${p.description.slice(0, 40)}": ${(e as Error).message}`); }
      }
    }
    for (const r of d.alternativeRelations ?? []) { try { oneOf("hypothesisRelation", r.kind); } catch (e) { problems.push((e as Error).message); } }
    if (!(d.predictions?.length)) problems.push("a hypothesis needs at least one checkable prediction (or an explicit 'not yet testable' prediction without a request)");
    if (!(d.basisEvidenceIds?.length) && !(d.mechanism ?? []).some((m) => [m.from, m.to].some((e) => e.kind === "entity" && s.scope.roots.includes(e.ref)))) problems.push("say what motivated it: cite evidence, or connect it to the symptom's code");
    return problems;
  }

  private similarity(a: HypothesisDraft, b: HypothesisDraft): number {
    const set = (d: HypothesisDraft) => new Set([...d.mechanism.flatMap((m) => [m.from, m.to]).map((e) => (e.kind === "entity" ? e.ref : "")), ...d.predictions.map((p) => (p.request ? `${p.request.toolId}:${JSON.stringify(p.request.payload)}` : p.description))].filter(Boolean));
    const [x, y] = [set(a), set(b)];
    const inter = [...x].filter((v) => y.has(v)).length;
    return x.size + y.size - inter === 0 ? 0 : inter / (x.size + y.size - inter);
  }

  /** Registers a candidate as version 1 of a new hypothesis. Its claim goes through the gates and can only display as a hypothesis. */
  private register(s: InvestigationSnapshot, d: HypothesisDraft, origin: HypothesisRecord["origin"], cmd: string, supersedes: string | null = null, parent: HypothesisRecord | null = null): HypothesisRecord {
    const problems = this.validateCandidate(s, d);
    if (problems.length) throw new C22Error("INVALID_SCHEMA", `candidate rejected: ${problems.slice(0, 3).join("; ")}`);
    const id = parent?.id ?? "hyp:" + hash(s.id, d.statement.toLowerCase().replace(/\s+/g, " ").trim());
    if (!parent && this.hypothesis(id)) throw new C22Error("INVALID_SCHEMA", "this hypothesis is already registered");
    if (!parent && this.hypothesesOf(s).length >= s.policy.maxActiveHypotheses) throw new C22Error("BUDGET_EXCEEDED", `at most ${s.policy.maxActiveHypotheses} hypotheses are active at once; retire one first`);
    const evidenceIds = [...new Set([...d.basisEvidenceIds, ...d.mechanism.flatMap((m) => m.evidenceIds)])];
    const claim = claimOf(this.store, s.scope.revision, {
      assertion: `Candidate explanation: ${d.statement}`, claimClass: "hypothesis-candidate", evidenceIds,
      rationaleSummary: `Proposed by ${origin.toLowerCase()} as one possible explanation of "${s.goal.question.slice(0, 80)}". It has ${d.predictions.length} prediction(s) that checks can confirm or contradict; it is not a finding.`,
      subjects: d.mechanism.flatMap((m) => [m.from, m.to]).flatMap((e) => (e.kind === "entity" ? [e.ref] : [])),
    });
    this.capHypothesisDisplay(claim);
    const now = iso(this.now());
    const rec: HypothesisRecord = {
      ...clone(d), id, investigationId: s.id, version: (parent?.version ?? 0) + 1, claimId: claim.draft.id, scopeHash: s.scope.scopeHash, origin,
      lifecycle: "ACTIVE", evaluation: this.evaluate(s, { ...(clone(d) as HypothesisDraft), id, investigationId: s.id, version: (parent?.version ?? 0) + 1, claimId: claim.draft.id, scopeHash: s.scope.scopeHash, origin, lifecycle: "ACTIVE", evaluation: undefined as never, assessmentIds: [], experimentIds: parent?.experimentIds ?? [], parentVersion: parent?.version ?? null, supersedesId: supersedes, createdAt: now, updatedAt: now }),
      assessmentIds: [], experimentIds: parent?.experimentIds ?? [], parentVersion: parent?.version ?? null, supersedesId: supersedes, createdAt: now, updatedAt: now,
    };
    this.putHyp(rec);
    if (!s.hypothesisIds.includes(id)) s.hypothesisIds.push(id);
    this.event(s, parent ? "HYPOTHESIS_REVISED" : "HYPOTHESIS_REGISTERED", { hypothesisId: id, version: rec.version, origin, claimId: claim.draft.id, states: { [id]: rec.evaluation.state } }, cmd);
    return rec;
  }

  /** A hypothesis is a hypothesis: nothing it proposes may display as a fact or an inference, whatever the evidence class. */
  private capHypothesisDisplay(c: Claim) {
    if (c.displayMode === "FACT" || c.displayMode === "INFERENCE") { c.displayMode = "HYPOTHESIS"; this.store.putClaim(c, "system", "c22.downgrade"); }
  }

  /** A new or revised hypothesis is tested against what is already known and its own checks are planned; a finished investigation wakes to do it. */
  private schedule(s: InvestigationSnapshot, h: HypothesisRecord, cmd: string) {
    for (const o of this.observationsOf(s.id).filter((x) => !x.retracted)) {
      const st = this.newStep(s, null, "internal.assess", { schemaId: "c22.step.assess.v1", version: 1, payload: { observationId: o.id, hypothesisId: h.id, version: h.version } }, []);
      if (!this.step(st.id)) { this.putStep(st); s.stepIds.push(st.id); }
    }
    this.planChecks(s, [h.id], cmd);
    if (s.execution === "FINISHED" || s.execution === "WAITING") { s.execution = "READY"; s.stopReason = null; if (s.disposition !== "USER_CLOSED") s.disposition = "UNASSESSED"; }
  }

  proposeHypothesis(ctx: CallContext, req: { investigationId: string; expectedVersion: number; draft: HypothesisDraft; origin?: "USER" | "MODEL" | "RULE" | "IMPORTED" }) {
    return this.mutate(ctx, "proposeHypothesis", req.investigationId, req.expectedVersion, (s) => {
      this.assertOpen(s);
      const origin = oneOf("origin", req.origin ?? "USER", "origin");
      // A near-duplicate of an active hypothesis is registered as a refinement of it, not silently merged: it keeps its own predictions and provenance until a person reviews it.
      const twin = this.hypothesesOf(s).find((h) => this.similarity(h, req.draft) >= 0.8);
      const draft = twin ? { ...req.draft, alternativeRelations: [...req.draft.alternativeRelations, { otherId: twin.id, kind: "REFINES" as const }] } : req.draft;
      const rec = this.register(s, draft, origin, ctx.idempotencyKey);
      this.schedule(s, rec, ctx.idempotencyKey);
      return rec;
    });
  }

  reviseHypothesis(ctx: CallContext, req: { investigationId: string; expectedVersion: number; hypothesisId: string; expectedHypothesisVersion: number; draft: HypothesisDraft }) {
    return this.mutate(ctx, "reviseHypothesis", req.investigationId, req.expectedVersion, (s) => {
      this.assertOpen(s);
      const cur = this.hypothesis(req.hypothesisId);
      if (!cur || cur.investigationId !== s.id) throw new C22Error("NOT_FOUND", "no such hypothesis");
      if (cur.version !== req.expectedHypothesisVersion) throw new C22Error("VERSION_CONFLICT", `hypothesis is at version ${cur.version}`, cur.version);
      const next = this.register(s, req.draft, cur.origin, ctx.idempotencyKey, cur.supersedesId, cur);
      // New statement or predictions invalidate earlier assessments until they are made again against the new version.
      this.schedule(s, next, ctx.idempotencyKey);
      return next;
    });
  }

  retireHypothesis(ctx: CallContext, req: { investigationId: string; expectedVersion: number; hypothesisId: string; reason: string }) {
    return this.mutate(ctx, "retireHypothesis", req.investigationId, req.expectedVersion, (s) => {
      const h = this.hypothesis(req.hypothesisId);
      if (!h || h.investigationId !== s.id) throw new C22Error("NOT_FOUND", "no such hypothesis");
      h.lifecycle = "RETIRED"; h.updatedAt = iso(this.now()); this.putHyp(h);
      this.event(s, "HYPOTHESIS_REVISED", { hypothesisId: h.id, retired: true, reason: req.reason.slice(0, 200), states: { [h.id]: h.evaluation.state } }, ctx.idempotencyKey);
    });
  }

  /** A person's verdict goes through the claim ledger (C18) with attribution; it never turns correlation into proof. */
  recordVerdict(ctx: CallContext, req: { investigationId: string; hypothesisId: string; verdict: "CONFIRM" | "REFUTE" | "DISPUTE"; explanation: string }) {
    const s = this.load(req.investigationId);
    const h = this.hypothesis(req.hypothesisId);
    if (!h || h.investigationId !== s.id) throw new C22Error("NOT_FOUND", "no such hypothesis");
    const claim = this.store.getClaim(h.claimId);
    if (!claim) throw new C22Error("NOT_FOUND", "the hypothesis' claim is missing");
    const r = applyVerdict(this.store, { claimId: h.claimId, verdict: req.verdict, explanation: req.explanation, actorId: ctx.actor.principalId, expectedVersion: claim.version });
    if (!r.ok) throw new C22Error("VERSION_CONFLICT", r.error.message);
    return this.mutate(ctx, "recordVerdict", s.id, undefined, (cur) => { this.reevaluateAll(cur, ctx.idempotencyKey); return this.hypothesis(h.id)!; });
  }

  // ------------------------------------------------------------------ evidence in, assessments out
  private assertOpen(s: InvestigationSnapshot) { if (s.closure === "FINALIZED") throw new C22Error("FORBIDDEN", "this investigation is finalized; reopen it to add to it"); }

  private normalize(s: InvestigationSnapshot, i: ObservationInput): Observation {
    const kind = oneOf("observationKind", i.kind ?? "RUNTIME_SIGNAL", "observation kind");
    const outcome = oneOf("outcome", i.outcome ?? "UNKNOWN", "outcome");
    const sampling = oneOf("sampling", i.sampling ?? i.certificate?.sampling ?? "UNKNOWN", "sampling");
    return {
      id: "obs:" + hash(s.id, i.sourceEventId), investigationId: s.id, evidenceIds: [...new Set(i.evidenceIds)], kind, description: i.description.slice(0, 500),
      revision: i.revision ?? null, deploymentId: i.deploymentId ?? null, window: i.window ?? null, sourceEventIds: [i.sourceEventId], correlationGroupId: correlationGroup(i),
      attributionId: i.attributionId ?? null, unknownContext: kind === "RUNTIME_SIGNAL" && !i.attributionId, outcome, predictionId: i.predictionId ?? null, introducedByHypothesisId: i.introducedByHypothesisId ?? null,
      quality: { completeness: i.certificate?.exhaustiveForPredicate ? "COMPLETE" : "UNKNOWN", sampling, clockUncertaintyMs: i.clockUncertaintyMs ?? null, collectionErrors: [], certificateId: i.certificate?.id ?? null },
      eventTime: i.eventTime ?? null, retracted: false, createdAt: iso(this.now()),
    };
  }

  /** Committed intake only. Assessment is scheduled as steps and happens in the next wave; the response never says it already did. */
  attachEvidence(ctx: CallContext, req: { investigationId: string; expectedVersion: number; observation: ObservationInput }) {
    return this.mutate(ctx, "attachEvidence", req.investigationId, req.expectedVersion, (s) => {
      if (!this.authorized(s)) throw new C22Error("FORBIDDEN", "access to this investigation was withdrawn");
      const rejected: string[] = [];
      for (const e of req.observation.evidenceIds) if (!this.store.evidence(s.scope.revision, e)) rejected.push(e);
      if (rejected.length) throw new C22Error("INVALID_SCHEMA", `evidence not found in the pinned revision: ${rejected.slice(0, 3).join(", ")}`);
      return this.intake(s, req.observation, ctx.idempotencyKey);
    });
  }

  private intake(s: InvestigationSnapshot, input: ObservationInput, cmd: string): { observationIds: string[]; scheduledAssessmentStepIds: string[]; duplicate: boolean } {
    const o = this.normalize(s, input);
    const existing = this.db.prepare("select json from c22_observations where investigation_id = ? and source_event_id = ?").get(s.id, input.sourceEventId) as any;
    if (existing) return { observationIds: [JSON.parse(existing.json).id], scheduledAssessmentStepIds: [], duplicate: true };
    this.putObs(o);
    if (input.certificate) this.putPayload(s.id, "cert:" + o.id, input.certificate);
    this.event(s, "EVIDENCE_ATTACHED", { observationId: o.id, kind: o.kind, group: o.correlationGroupId, unknownContext: o.unknownContext }, cmd);
    // A finalized investigation records the evidence and says so; it does not wake itself (a late event never reopens it).
    if (s.closure === "FINALIZED") { s.pendingEvidence += 1; return { observationIds: [o.id], scheduledAssessmentStepIds: [], duplicate: false }; }
    const steps: string[] = [];
    for (const h of this.hypothesesOf(s)) {
      const st = this.newStep(s, null, "internal.assess", { schemaId: "c22.step.assess.v1", version: 1, payload: { observationId: o.id, hypothesisId: h.id, version: h.version } }, []);
      if (!this.step(st.id)) { this.putStep(st); s.stepIds.push(st.id); steps.push(st.id); }
    }
    if (s.execution === "FINISHED" || s.execution === "WAITING") { s.execution = "READY"; s.stopReason = null; }
    return { observationIds: [o.id], scheduledAssessmentStepIds: steps, duplicate: false };
  }

  /** Privileged, attributed runtime intake: de-duplicated by event id, ordered by event time, retractions invalidate what they fed. */
  applyRuntimeBatch(ctx: CallContext, req: { investigationId: string; expectedVersion: number; batch: RuntimeBatch }) {
    return this.mutate(ctx, "applyRuntimeBatch", req.investigationId, req.expectedVersion, (s) => {
      if (!this.authorized(s)) throw new C22Error("FORBIDDEN", "access to this investigation was withdrawn");
      const out = { accepted: 0, duplicates: 0, unattributed: 0, retracted: 0, observationIds: [] as string[] };
      const events = [...req.batch.events].sort((a, b) => a.eventTime.localeCompare(b.eventTime) || a.eventId.localeCompare(b.eventId));
      for (const ev of events) {
        const ref = evidenceFor(this.store, s.scope.revision, `rt:${s.id}:${ev.eventId}`, "RUNTIME", `runtime:${ev.signature}`, ev.signature, ev.eventTime, "RuntimeLocation");
        const r = this.intake(s, {
          evidenceIds: [ref.id], description: ev.description ?? `${ev.signature}: ${ev.outcome}`, predictionId: ev.predictionId ?? null, sourceEventId: ev.eventId, kind: "RUNTIME_SIGNAL", outcome: ev.outcome,
          revision: s.scope.revision, deploymentId: ev.deploymentId ?? null, certificate: ev.certificate ?? null, sampling: ev.sampling ?? "UNKNOWN", traceLineage: ev.traceLineage ?? null,
          attributionId: ev.attribution?.id ?? null, eventTime: ev.eventTime,
        }, ctx.idempotencyKey);
        if (r.duplicate) out.duplicates++; else { out.accepted++; out.observationIds.push(...r.observationIds); if (!ev.attribution) out.unattributed++; }
      }
      for (const id of req.batch.retractedEventIds ?? []) out.retracted += this.retract(s, id, ctx.idempotencyKey);
      return out;
    });
  }

  /** A source event was corrected or withdrawn: what it fed stops counting, and every hypothesis it touched is reduced again. */
  private retract(s: InvestigationSnapshot, sourceEventId: string, cmd: string): number {
    const r = this.db.prepare("select json from c22_observations where investigation_id = ? and source_event_id = ?").get(s.id, sourceEventId) as any;
    if (!r) return 0;
    const o = JSON.parse(r.json) as Observation;
    if (o.retracted) return 0;
    o.retracted = true; this.putObs(o);
    for (const h of this.hypothesesOf(s, { all: true })) {
      for (const a of this.assessmentsOf(h.id)) if (a.observationId === o.id && !a.stale) { a.stale = true; a.reasonCodes = [...a.reasonCodes, "SOURCE_RETRACTED"]; this.putAssessment(a); }
    }
    this.event(s, "SOURCE_INVALIDATED", { observationId: o.id, sourceEventId }, cmd);
    this.reevaluateAll(s, cmd);
    return 1;
  }

  /** One observation against one hypothesis version: relation, its claim through the gates, and the evidence group it belongs to. */
  private assess(s: InvestigationSnapshot, h: HypothesisRecord, o: Observation, cmd: string): EvidenceAssessment {
    const cert = this.payload<CoverageCertificate>("cert:" + o.id);
    const pred = h.predictions.find((p) => p.id === o.predictionId) ?? (o.predictionId ? undefined : h.predictions.find((p) => p.checkId && this.checksFeeding(o).includes(p.checkId)));
    const d = assessPrediction(pred, o, h.id, cert, s.scope);
    const knownEvidence = o.evidenceIds.filter((e) => this.store.evidence(s.scope.revision, e));
    const claim = claimOf(this.store, s.scope.revision, {
      assertion: `${d.relation === "SUPPORTS" ? "Supports" : d.relation === "CONTRADICTS" ? "Contradicts" : d.relation === "INCONCLUSIVE" ? "Does not settle" : "Is unrelated to"}: ${h.statement.slice(0, 120)} — ${o.description.slice(0, 160)}`,
      claimClass: "hypothesis-assessment", evidenceIds: knownEvidence, rationaleSummary: d.reasons.join("; ").slice(0, 300), dependencyIds: [h.claimId],
    });
    const grounded = claim.gates.find((g) => g.gate === "GROUNDING")?.status === "PASS";
    const id = "asm:" + hash(h.id, h.version, o.id, RULE_VERSION);
    const a: EvidenceAssessment = {
      id, hypothesisId: h.id, hypothesisVersion: h.version, observationId: o.id, relation: d.relation, predictionId: pred?.id ?? null, claimId: claim.draft.id,
      gateReportId: "gates:" + hash(claim.draft.id, claim.version), correlationGroupId: o.correlationGroupId, snapshotHash: hash(s.id, s.version), scopeHash: s.scope.scopeHash,
      // An assessment whose evidence cannot be found is recorded as rejected: it appears in the audit trail and never counts.
      accepted: grounded && knownEvidence.length > 0, stale: false, reasonCodes: grounded ? d.reasons : [...d.reasons, "UNGROUNDED"], createdAt: iso(this.now()),
    };
    this.putAssessment(a);
    void cmd;
    return a;
  }
  private checksFeeding(o: Observation): string[] { return o.predictionId ? [] : (o as any).checkIds ?? []; }

  private evaluate(s: InvestigationSnapshot, h: HypothesisRecord): HypothesisEvaluation {
    const asm = h.id ? this.assessmentsOf(h.id) : [];
    const verdicts = this.store.getClaim(h.claimId)?.verdicts ?? [];
    const last = verdicts.at(-1);
    const claim = this.store.getClaim(h.claimId);
    const cal = claim?.confidence;
    const calibration: HypothesisEvaluation["calibration"] = cal && (cal as any).status === "CALIBRATED" && typeof (cal as any).probability === "number"
      ? { kind: "Calibrated", probability: (cal as any).probability, lower: (cal as any).lower, upper: (cal as any).upper }
      : { kind: "Uncalibrated", reason: "no calibration artifact applies to this claim class; ordering is for scheduling, not probability" };
    const prelim = reduceHypothesis({ h, assessments: asm, stale: false, revoked: false, humanVerdict: last ? { id: `${claim!.draft.id}:${verdicts.length}`, verdict: last.verdict } : null, calibration, rank: { investigationPriority: 0, impact: 0, relevance: 0, discriminability: 0, evidenceQuality: 0, reasons: [] }, gapIds: [] });
    const f = this.priorityFactors(s, h, asm);
    const stale = this.isStale(s, h);
    const rank = priority(f, prelim.state, stale ? "STALE" : "CURRENT", s.pinned.includes(h.id));
    return reduceHypothesis({ h, assessments: asm, stale, revoked: !this.authorized(s), humanVerdict: last ? { id: `${claim!.draft.id}:${verdicts.length}`, verdict: last.verdict } : null, calibration, rank, gapIds: this.gaps(s, [h]).map((g) => g.id) });
  }

  private priorityFactors(s: InvestigationSnapshot, h: HypothesisRecord, asm: EvidenceAssessment[]) {
    const ents = new Set(h.mechanism.flatMap((m) => [m.from, m.to]).flatMap((e) => (e.kind === "entity" ? [e.ref] : [])));
    const roots = new Set(s.scope.roots);
    const relevance = roots.size ? [...ents].filter((e) => roots.has(e)).length / Math.max(1, Math.min(ents.size, roots.size)) : 0.3;
    const rels = this.store.allRelationships(s.scope.revision).filter((r) => r.kind === "calls");
    const dependents = [...ents].reduce((n, e) => n + rels.filter((r) => r.to === e).length, 0);
    const impact = Math.min(1, dependents / 8);
    const others = this.hypothesesOf(s).filter((x) => x.id !== h.id);
    const keys = (x: HypothesisDraft) => new Set(x.predictions.map((p) => p.request ? hash(p.request.toolId, p.request.payload) : p.checkId));
    const mine = keys(h); const shared = others.filter((o) => [...keys(o)].some((k) => mine.has(k))).length;
    const discriminability = others.length ? 1 - shared / others.length * 0.5 : 0.5;
    const evidenceQuality = asm.length ? asm.filter((a) => a.accepted && !a.stale).length / asm.length : 0;
    return { relevance, impact, discriminability, evidenceQuality };
  }

  private isStale(s: InvestigationSnapshot, h: HypothesisRecord): boolean {
    const latest = this.store.latestRevision(s.scope.repoRoot);
    if (!latest || latest.id === s.scope.revision) return false;
    const before = new Map(this.store.entities(s.scope.revision).filter((e) => e.symbolHash).map((e) => [e.entityId, e.symbolHash!]));
    const after = new Map(this.store.entities(latest.id).filter((e) => e.symbolHash).map((e) => [e.entityId, e.symbolHash!]));
    const ents = h.mechanism.flatMap((m) => [m.from, m.to]).flatMap((e) => (e.kind === "entity" ? [e.ref] : []));
    return ents.some((e) => !after.has(e) || before.get(e) !== after.get(e));
  }

  /** If the code a conclusion rests on has changed since the revision was pinned, mark it stale: history is kept, the conclusion is not current. */
  private refreshFreshness(s: InvestigationSnapshot): InvestigationSnapshot {
    const latest = this.store.latestRevision(s.scope.repoRoot);
    if (!latest || latest.id === s.scope.revision || s.disposition === "STALE") return s;
    const stale = this.hypothesesOf(s).some((h) => this.isStale(s, h));
    if (!stale) return s;
    return this.store.tx(() => {
      const cur = this.load(s.id);
      for (const h of this.hypothesesOf(cur, { all: true })) if (this.isStale(cur, h)) for (const a of this.assessmentsOf(h.id)) if (!a.stale) { a.stale = true; a.reasonCodes = [...a.reasonCodes, "REVISION_CHANGED"]; this.putAssessment(a); }
      this.reevaluateAll(cur, "revalidate");
      cur.disposition = "STALE";
      this.event(cur, "SOURCE_INVALIDATED", { reason: "REVISION_CHANGED", from: cur.scope.revision, to: latest.id }, "revalidate");
      return this.commit(cur, "revalidate");
    });
  }

  /** Two hypotheses that are both supported contribute together: their relation becomes CAN_COEXIST. Nothing here picks a winner. */
  private relate(s: InvestigationSnapshot) {
    const hs = this.hypothesesOf(s);
    const supported = new Set(hs.filter((h) => h.evaluation.state === "SUPPORTED").map((h) => h.id));
    for (const h of hs) {
      const next = h.alternativeRelations.map((r) => (r.kind === "COMPETES_WITH" || r.kind === "CAN_COEXIST") && supported.has(h.id) && supported.has(r.otherId)
        ? { ...r, kind: "CAN_COEXIST" as const, basisClaimId: h.claimId } : r.kind === "CAN_COEXIST" && !(supported.has(h.id) && supported.has(r.otherId)) ? { otherId: r.otherId, kind: "COMPETES_WITH" as const } : r);
      if (JSON.stringify(next) !== JSON.stringify(h.alternativeRelations)) { h.alternativeRelations = next; this.putHyp(h); }
    }
  }

  private reevaluateAll(s: InvestigationSnapshot, cmd: string) {
    const states: Record<string, string> = {};
    for (const h of this.hypothesesOf(s, { all: true })) {
      h.evaluation = this.evaluate(s, h); h.updatedAt = iso(this.now()); this.putHyp(h); states[h.id] = h.evaluation.state;
    }
    this.relate(s);
    this.event(s, "ASSESSMENT_COMMITTED", { states, reevaluated: true }, cmd);
  }

  reassess(ctx: CallContext, req: { investigationId: string; expectedVersion: number; hypothesisIds?: string[] }) {
    return this.mutate(ctx, "reassess", req.investigationId, req.expectedVersion, (s) => {
      this.assertOpen(s);
      const obs = this.observationsOf(s.id).filter((o) => !o.retracted);
      let n = 0;
      for (const h of this.hypothesesOf(s)) {
        if (req.hypothesisIds?.length && !req.hypothesisIds.includes(h.id)) continue;
        for (const o of obs) { this.assess(s, h, o, ctx.idempotencyKey); n++; }
      }
      this.reevaluateAll(s, ctx.idempotencyKey);
      return { assessed: n };
    });
  }

  // ------------------------------------------------------------------ coverage and gaps
  private gaps(s: InvestigationSnapshot, hs: HypothesisRecord[]): EvidenceGap[] {
    const out: EvidenceGap[] = [];
    const steps = this.stepsOf(s.id);
    for (const h of hs) {
      for (const p of h.predictions) {
        if (!p.request) { out.push({ id: "gap:" + hash(h.id, p.id, "untestable"), description: `"${p.description}" cannot be tested with a registered read yet`, hypothesisIds: [h.id], material: p.essentialForHypothesis, reason: "ADAPTER_UNAVAILABLE", suggestedCheckIds: [] }); continue; }
        const asm = this.assessmentsOf(h.id).filter((a) => a.predictionId === p.id && a.accepted && !a.stale);
        const decisive = asm.some((a) => a.relation === "SUPPORTS" || a.relation === "CONTRADICTS");
        if (decisive) continue;
        const st = steps.find((x) => x.checkId === p.checkId);
        const reason: GapReason = st?.state === "BLOCKED" ? "BUDGET_LIMIT" : asm.some((a) => a.relation === "INCONCLUSIVE") ? "INCOMPLETE_SAMPLING" : p.request.toolId === "runtime.window" ? "NO_TELEMETRY" : "UNRESOLVED_SYMBOL";
        out.push({ id: "gap:" + hash(h.id, p.id, reason), description: `"${p.description}" has no decisive evidence yet`, hypothesisIds: [h.id], material: p.essentialForHypothesis, reason, suggestedCheckIds: [p.checkId] });
      }
    }
    return out;
  }
  private coverageOf(s: InvestigationSnapshot): CoverageReport {
    const hs = this.hypothesesOf(s);
    const steps = this.stepsOf(s.id);
    const inspected = new Set<string>(), attempted = new Set<string>();
    for (const st of steps) if (st.state === "SUCCEEDED" && st.checkId) {
      attempted.add(st.checkId);
      for (const k of ["entityId", "from", "to"]) { const v = st.request.payload[k]; if (typeof v === "string") inspected.add(v); }
    }
    const missing = this.gaps(s, hs);
    return { inspectedEntityIds: [...inspected], excludedEntityIds: s.coverage.excludedEntityIds, attemptedCheckIds: [...attempted], missing, completeness: missing.some((g) => g.material) ? "PARTIAL" : hs.length && !missing.length ? "COMPLETE" : "UNKNOWN", scopeHash: s.scope.scopeHash };
  }

  // ------------------------------------------------------------------ seeding and planning
  private entityEvidence(rev: string, id: string): string[] {
    return this.store.relationshipsFor(rev, id).filter((r) => r.kind === "contains" && r.to === id).flatMap((r) => r.evidence.map((e) => e.id)).slice(0, 3);
  }

  /** Deterministic candidates from structure near the symptom: where it throws, how it propagates, what writes unprotected, what is hidden by dynamic calls. */
  private ruleCandidates(s: InvestigationSnapshot): HypothesisDraft[] {
    const rev = s.scope.revision;
    const roots = s.scope.roots.filter((r) => this.store.entitiesById(rev, [r])[0]);
    const names = new Map(this.store.entities(rev).map((e) => [e.entityId, e]));
    const seeds: string[] = [...roots];
    if (!seeds.length) {
      const words = (s.goal.question.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []);
      for (const e of names.values()) if (e.kind !== "file" && words.some((w) => e.name.toLowerCase().includes(w))) seeds.push(e.entityId);
    }
    const rels = this.store.allRelationships(rev).filter((r) => r.kind === "calls" || r.kind === "async-flow");
    // Everything within three hops downstream of the symptom code is a place the cause could be.
    const down = new Map<string, number>(seeds.slice(0, 6).map((x) => [x, 0]));
    let frontier = [...down.keys()];
    for (let d = 0; d < 3 && frontier.length; d++) { const next: string[] = []; for (const id of frontier) for (const r of rels.filter((x) => x.from === id)) if (!down.has(r.to)) { down.set(r.to, d + 1); next.push(r.to); } frontier = next; }
    const reachable = [...down.keys()].filter((id) => names.get(id) && names.get(id)!.kind !== "file");
    const out: HypothesisDraft[] = [];
    const link = (from: string, to: string, relation: MechanismLink["relation"]): MechanismLink => ({ from: { kind: "entity", ref: from }, to: { kind: "entity", ref: to }, relation, evidenceIds: this.entityEvidence(rev, to) });
    const sym = seeds[0];
    const A = (statement: string): Assumption => ({ id: "asm:" + hash(statement), statement, entityRefs: sym ? [sym] : [], verification: roots.length ? "EVIDENCED" : "UNCHECKED", evidenceIds: sym && roots.length ? this.entityEvidence(rev, sym) : [] });
    const pred = (description: string, toolId: string, payload: Record<string, unknown>, ifTrue: OutcomeTag[], ifFalse: OutcomeTag[], essential: boolean): Prediction => ({
      id: "prd:" + hash(description, toolId, payload), description, checkId: "chk:" + hash(toolId, payload), request: { toolId, payload }, outcomeIfTrue: ifTrue, outcomeIfFalse: ifFalse, distinguishingHypothesisIds: [], essentialForHypothesis: essential,
    });
    const thrower = reachable.find((id) => this.store.factsFor(rev, id).some((f) => f.predicate === "throws"));
    if (thrower && sym) out.push({
      statement: `${names.get(thrower)!.name} throws on the path from ${names.get(sym)?.name ?? "the symptom"}, and nothing on that path handles it`,
      mechanism: [link(sym, thrower, thrower === sym ? "CAUSES_CANDIDATE" : "CALLS")], assumptions: [A("the symptom's code is on the failing path")],
      predictions: [pred(`${names.get(thrower)!.name} has a throw statement`, "source.entity", { entityId: thrower, predicate: "throws" }, ["PRESENT"], ["ABSENT_WITH_COVERAGE"], true), ...(s.goal.trace ? [pred("the same error class was reported at runtime", "runtime.window", { signature: (parseTrace(s.goal.trace).errorClass ?? "Error") as string }, ["PRESENT"], [], false)] : [])],
      basisEvidenceIds: this.entityEvidence(rev, thrower), alternativeRelations: [],
    });
    const async_ = rels.find((r) => r.kind === "async-flow" && (down.has(r.from) || down.has(r.to)));
    if (async_ && sym) out.push({
      statement: `the failure is swallowed by an asynchronous hand-off from ${names.get(async_.from)?.name ?? async_.from} to ${names.get(async_.to)?.name ?? async_.to}, so the caller never sees it`,
      mechanism: [{ from: { kind: "entity", ref: async_.from }, to: { kind: "entity", ref: async_.to }, relation: "PRECEDES", evidenceIds: async_.evidence.map((e) => e.id) }], assumptions: [A("the hand-off is on the path the symptom travelled")],
      predictions: [pred("an asynchronous call path exists between the two", "graph.paths", { from: async_.from, to: async_.to, maxDepth: 4 }, ["PRESENT"], ["ABSENT_WITH_COVERAGE"], true)],
      basisEvidenceIds: async_.evidence.map((e) => e.id), alternativeRelations: [],
    });
    const writer = reachable.find((id) => this.store.factsFor(rev, id).some((f) => f.predicate === "writes") && !this.store.factsFor(rev, id).some((f) => f.predicate === "uses_transaction"));
    if (writer && sym) out.push({
      statement: `${names.get(writer)!.name} changes state outside a transaction, leaving it inconsistent when something fails part-way`,
      mechanism: [link(sym, writer, writer === sym ? "CAUSES_CANDIDATE" : "CALLS")], assumptions: [A("the state it writes is read by the failing operation")],
      predictions: [pred(`${names.get(writer)!.name} uses no transaction`, "source.entity", { entityId: writer, predicate: "uses_transaction" }, ["ABSENT_WITH_COVERAGE"], ["PRESENT"], true), pred(`${names.get(writer)!.name} writes state`, "source.entity", { entityId: writer, predicate: "writes" }, ["PRESENT"], ["ABSENT_WITH_COVERAGE"], false)],
      basisEvidenceIds: this.entityEvidence(rev, writer), alternativeRelations: [],
    });
    const fog = reachable.find((id) => this.store.factsFor(rev, id).some((f) => f.resolution === "UNRESOLVED" && f.predicate === "calls"));
    if (fog && sym) out.push({
      statement: `a dynamic call in ${names.get(fog)!.name} reaches code static analysis cannot see, and that hidden callee is where it fails`,
      mechanism: [link(sym, fog, fog === sym ? "CAUSES_CANDIDATE" : "CALLS")], assumptions: [A("the dynamic call executes during the incident")],
      predictions: [pred(`${names.get(fog)!.name} has calls analysis could not resolve`, "source.entity", { entityId: fog, predicate: "unresolved_calls" }, ["PRESENT"], ["ABSENT_WITH_COVERAGE"], true)],
      basisEvidenceIds: this.entityEvidence(rev, fog), alternativeRelations: [],
    });
    if (sym && out.length < 3) out.push({
      statement: `the failure comes from heavy shared use of ${names.get(sym)?.name ?? "the symptom's code"}: many callers reach it in states it does not expect`,
      mechanism: [{ from: { kind: "entity", ref: sym }, to: { kind: "entity", ref: sym }, relation: "CONTRIBUTES_TO", evidenceIds: this.entityEvidence(rev, sym) }], assumptions: [A("more than one caller exercises this code")],
      predictions: [pred(`${names.get(sym)?.name ?? "it"} has at least two callers`, "graph.dependents", { entityId: sym, depth: 2, minCount: 2 }, ["PRESENT"], ["ABSENT_WITH_COVERAGE"], false)],
      basisEvidenceIds: this.entityEvidence(rev, sym), alternativeRelations: [],
    });
    return out;
  }

  /** The seed step: rule candidates plus whatever the proposer (a model) offers; every candidate is validated, bad ones are reported not dropped silently. */
  private async seed(s: InvestigationSnapshot, cmd: string): Promise<{ registered: string[]; rejected: { statement: string; problems: string[] }[] }> {
    const drafts: { d: HypothesisDraft; origin: HypothesisRecord["origin"] }[] = this.ruleCandidates(s).map((d) => ({ d, origin: "RULE" }));
    const rejected: { statement: string; problems: string[] }[] = [];
    if (this.proposer) {
      try { for (const d of await this.proposer({ question: s.goal.question, roots: s.scope.roots, revision: s.scope.revision })) drafts.push({ d, origin: "MODEL" }); }
      catch (e) { rejected.push({ statement: "(proposer)", problems: [`the proposer failed: ${(e as Error).message}`] }); }
    }
    return this.store.tx(() => {
      const cur = this.load(s.id);
      const registered: string[] = [];
      for (const { d: base, origin } of drafts) {
        if (this.hypothesesOf(cur).length >= cur.policy.maxActiveHypotheses) break;
        const problems = this.validateCandidate(cur, base);
        if (problems.length) { rejected.push({ statement: String(base.statement ?? "").slice(0, 80), problems: problems.slice(0, 3) }); continue; }
        if (this.hypothesis("hyp:" + hash(cur.id, base.statement.toLowerCase().replace(/\s+/g, " ").trim()))) continue;
        // A near-duplicate of an already-registered seed candidate refines it, as proposals do; it keeps its own predictions and provenance until a person reviews it.
        const twin = registered.map((id) => this.hypothesis(id)).find((h) => h && this.similarity(h, base) >= 0.8);
        const d = twin ? { ...base, alternativeRelations: [...base.alternativeRelations, { otherId: twin.id, kind: "REFINES" as const }] } : base;
        registered.push(this.register(cur, d, origin, cmd).id);
      }
      // Hypotheses compete unless something says they can coexist; mutual exclusion is a claim and is never assumed.
      const all = this.hypothesesOf(cur);
      for (const h of all) { h.alternativeRelations = [...h.alternativeRelations.filter((r) => r.kind !== "COMPETES_WITH"), ...all.filter((o) => o.id !== h.id).map((o) => ({ otherId: o.id, kind: "COMPETES_WITH" as const }))]; this.putHyp(h); }
      this.commit(cur, cmd);
      return { registered, rejected };
    });
  }

  /** Turn predictions into registered checks (deduplicated, so one read can serve several hypotheses) and the steps that run them. */
  proposeChecks(ctx: CallContext, req: { investigationId: string; expectedVersion: number; hypothesisIds?: string[] }) {
    return this.mutate(ctx, "proposeChecks", req.investigationId, req.expectedVersion, (s) => this.planChecks(s, req.hypothesisIds, ctx.idempotencyKey));
  }
  private planChecks(s: InvestigationSnapshot, only: string[] | undefined, cmd: string): DiscriminatingCheck[] {
    const hs = this.hypothesesOf(s).filter((h) => !only?.length || only.includes(h.id));
    const byKey = new Map<string, { req: NonNullable<Prediction["request"]>; checkId: string; hs: HypothesisRecord[]; preds: Prediction[] }>();
    for (const h of hs) for (const p of h.predictions) {
      if (!p.request) continue;
      const k = hash(p.request.toolId, p.request.payload);
      const g = byKey.get(k) ?? { req: p.request, checkId: p.checkId, hs: [], preds: [] };
      g.hs.push(h); g.preds.push(p); byKey.set(k, g);
    }
    const checks: DiscriminatingCheck[] = [];
    for (const g of byKey.values()) {
      const toolId = g.req.toolId;
      if (!TOOLS[toolId]) throw new C22Error("FORBIDDEN", `check uses an unregistered tool "${toolId}"`);
      const request = toolRequest(toolId, g.req.payload);
      validateRequest(toolId, request, s.scope);
      const diverge = g.hs.length > 1 && new Set(g.preds.map((p) => p.outcomeIfTrue.join())).size > 1 ? 1 : g.hs.length > 1 ? 0.5 : 0.2;
      const gap = Math.min(1, this.gaps(s, g.hs).filter((x) => x.suggestedCheckIds.includes(g.checkId)).length / Math.max(1, g.hs.length));
      const rel = [g.req.payload.entityId, g.req.payload.from, g.req.payload.to].some((v) => typeof v === "string" && s.scope.roots.includes(v)) ? 1 : 0.4;
      const score = (0.4 * diverge + 0.3 * gap + 0.3 * rel) / 1.05;
      const check: DiscriminatingCheck = {
        id: g.checkId, description: g.preds[0].description, hypothesisIds: g.hs.map((h) => h.id), toolId, request,
        outcomes: g.preds.map((p) => ({ outcome: p.outcomeIfTrue[0] ?? "PRESENT", description: `consistent with: ${p.description}`, supports: g.hs.filter((h) => h.predictions.includes(p)).map((h) => h.id), contradicts: [], requiredPredictionIds: [p.id] })),
        requiredCoverage: { requiresExhaustivePredicate: g.preds.some((p) => p.outcomeIfFalse.includes("ABSENT_WITH_COVERAGE")), minimumObservationCount: 1, requiredRevision: s.scope.revision },
        expectedCost: { tokens: 0, cost: 0, toolSteps: 1 }, dependencies: [], executionClass: "READ_ONLY",
        value: { partitionQuality: diverge, gapReduction: gap, incidentRelevance: rel, score, method: "DETERMINISTIC_HEURISTIC" },
      };
      checks.push(check); this.putCheck(s.id, check);
    }
    // The plan is bounded and acyclic, and contains only reads.
    const have = new Set(this.stepsOf(s.id).map((x) => x.id));
    const fresh = checks.filter((c) => !have.has("step:" + hash(s.id, c.id, c.request.payload)));
    if (this.stepsOf(s.id).length + fresh.length > s.policy.maxPlanSteps) throw new C22Error("BUDGET_EXCEEDED", `the plan would exceed ${s.policy.maxPlanSteps} steps`);
    for (const c of checks.sort((a, b) => b.value.score - a.value.score)) {
      if (c.executionClass !== "READ_ONLY") throw new C22Error("FORBIDDEN", "only read-only checks may be planned");
      const st = this.newStep(s, c.id, c.toolId, c.request, c.dependencies);
      if (!this.step(st.id)) { this.putStep(st); s.stepIds.push(st.id); }
    }
    this.assertAcyclic(this.stepsOf(s.id));
    this.event(s, "PLAN_CHANGED", { checks: checks.map((c) => c.id), reason: "checks proposed" }, cmd);
    return checks;
  }
  private assertAcyclic(steps: StepRecord[]) {
    const by = new Map(steps.map((x) => [x.id, x])); const color = new Map<string, number>();
    const visit = (id: string) => { if (color.get(id) === 1) throw new C22Error("INVALID_SCHEMA", "the plan has a dependency cycle"); if (color.get(id) === 2) return; color.set(id, 1); for (const d of by.get(id)?.dependsOn ?? []) visit(d); color.set(id, 2); };
    for (const id of by.keys()) visit(id);
  }

  // ------------------------------------------------------------------ execution (design §8)
  /** Admit one bounded wave: one writer per version, so a second advance with the same version is refused. */
  admitWave(ctx: CallContext, req: { investigationId: string; expectedVersion: number }): { snapshot: InvestigationSnapshot; generation: number } {
    const r = this.mutate(ctx, "advance", req.investigationId, req.expectedVersion, (s) => {
      if (s.closure === "FINALIZED") throw new C22Error("FORBIDDEN", "this investigation is finalized");
      if (!this.authorized(s)) throw new C22Error("FORBIDDEN", "access to this investigation was withdrawn");
      if (!(["READY", "WAITING", "FINISHED"] as string[]).includes(s.execution)) throw new C22Error("FORBIDDEN", `cannot advance an investigation that is ${s.execution}`);
      if (s.execution === "FINISHED") throw new C22Error("FORBIDDEN", "the investigation is finished; reopen it to continue");
      s.execution = "RUNNING"; s.waitingFor = null; s.stopReason = null;
      this.event(s, "STATE_CHANGED", { to: "RUNNING" }, ctx.idempotencyKey);
      return s.generation;
    });
    return { snapshot: this.load(req.investigationId), generation: r.value };
  }

  /** Run steps until nothing is ready, the budget or the fence stops it, or maxSteps is reached. Returns the committed snapshot. */
  async runWave(invId: string, generation: number, maxSteps: number): Promise<InvestigationSnapshot> {
    this.recoverExpiredAttempts(invId);
    let remaining = maxSteps;
    const workers = Array.from({ length: Math.max(1, this.load(invId).policy.maxConcurrentSteps) }, async () => {
      while (remaining > 0) {
        const reserved = this.reserve(invId, generation);
        if (!reserved) return;
        remaining--;
        await this.execute(invId, reserved.attempt, reserved.step);
      }
    });
    await Promise.all(workers);
    return this.settle(invId, generation);
  }

  private readyStep(s: InvestigationSnapshot): StepRecord | null {
    const steps = this.stepsOf(s.id); const done = new Set(steps.filter((x) => x.state === "SUCCEEDED").map((x) => x.id));
    const ready = steps.filter((x) => (x.state === "READY" || (x.state === "PENDING" && x.dependsOn.every((d) => done.has(d)))) && x.generation <= s.generation);
    // Internal steps (seeding, assessing) cost nothing and run first; reads run best-valued first.
    const checks = new Map(this.checksOf(s.id).map((c) => [c.id, c]));
    ready.sort((a, b) => (a.toolId.startsWith("internal.") ? 0 : 1) - (b.toolId.startsWith("internal.") ? 0 : 1) || (checks.get(b.checkId ?? "")?.value.score ?? 0) - (checks.get(a.checkId ?? "")?.value.score ?? 0));
    return ready[0] ?? null;
  }

  /** Atomic dispatch admission: version check, generation and permission check, budget reservation, lease and attempt, all in one transaction. */
  private reserve(invId: string, generation: number): { attempt: StepAttempt; step: StepRecord } | null {
    const r = this.reserveTx(invId, generation);
    if (r) failpoint("c22-after-reserve"); // a kill here leaves a committed reservation, which is the boundary being tested
    return r;
  }
  private reserveTx(invId: string, generation: number): { attempt: StepAttempt; step: StepRecord } | null {
    return this.store.tx(() => {
      const s = this.load(invId);
      if (s.execution !== "RUNNING" || s.generation !== generation || !this.authorized(s)) return null;
      const st = this.readyStep(s);
      if (!st) return null;
      const internal = st.toolId.startsWith("internal.");
      const need: Usage = internal ? { tokens: 0, cost: 0, toolSteps: 0 } : { tokens: 0, cost: 0, toolSteps: 1 };
      const used = { tokens: s.budget.consumed.tokens + s.budget.reserved.tokens, cost: s.budget.consumed.cost + s.budget.reserved.cost, toolSteps: s.budget.consumed.toolSteps + s.budget.reserved.toolSteps };
      if (used.toolSteps + need.toolSteps > s.budget.limit.toolSteps || used.tokens + need.tokens > s.budget.limit.tokens || used.cost + need.cost > s.budget.limit.cost) {
        st.state = "BLOCKED"; st.unavailableReason = "BUDGET_LIMIT"; this.putStep(st);
        s.stopReason = "BUDGET_EXHAUSTED";
        this.event(s, "STEP_FAILED", { stepId: st.id, reason: "BUDGET_LIMIT" }, "reserve");
        this.save(s);
        return null;
      }
      const attemptNumber = this.attemptsOf(st.id).length + 1;
      const requestHash = hash(st.toolId, st.request);
      const attempt: StepAttempt = {
        id: "att:" + hash(st.id, attemptNumber), stepId: st.id, generation: s.generation, attemptNumber, state: "RESERVED", leaseOwner: "engine", leaseExpiresAt: iso(new Date(this.now().getTime() + s.policy.leaseDurationMs)),
        // The same read always has the same dispatch identity, so a retry after a crash is recognisably the same request.
        dispatchId: "dsp:" + hash(st.id, requestHash), requestHash, scopeHash: s.scope.scopeHash, reservation: need, startedAt: iso(this.now()), finishedAt: null, resultHandle: null, error: null,
      };
      s.budget.reserved = { tokens: s.budget.reserved.tokens + need.tokens, cost: s.budget.reserved.cost + need.cost, toolSteps: s.budget.reserved.toolSteps + need.toolSteps };
      st.state = "RUNNING"; st.attemptIds.push(attempt.id); st.generation = s.generation; this.putStep(st); this.putAttempt(attempt);
      this.event(s, "STEP_RESERVED", { stepId: st.id, attempt: attempt.id, dispatchId: attempt.dispatchId }, "reserve");
      this.save(s);
      return { attempt, step: st };
    });
  }

  private async execute(invId: string, attempt: StepAttempt, step: StepRecord): Promise<void> {
    let result: ToolResult | { seed: { registered: string[]; rejected: { statement: string; problems: string[] }[] } } | { assess: true } | null = null;
    let error: Error | null = null;
    try {
      const s0 = this.load(invId);
      const fenced = () => { const cur = this.load(invId); return cur.generation !== attempt.generation || cur.execution !== "RUNNING" || !this.authorized(cur); };
      const env: ToolEnv = { store: this.store, scope: s0.scope, cancelled: fenced };
      await inStep.run({ investigationId: invId }, async () => {
        if (step.toolId === "internal.seed") result = { seed: await this.seed(s0, "seed") };
        else if (step.toolId === "internal.assess") result = { assess: true };
        else {
          const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new C22Error("CANCELLED", "the read timed out")), s0.policy.readTimeoutMs).unref());
          result = await Promise.race([Promise.resolve(this.tools(step.toolId, step.request, env)), timeout]) as ToolResult;
        }
      });
    } catch (e) { error = e as Error; }
    if (!error) {
      // Persist the result handle first, publish second: a crash in between loses nothing and publishes nothing twice.
      this.store.tx(() => {
        const a = this.attemptsOf(step.id).find((x) => x.id === attempt.id)!;
        const handle = "res:" + a.dispatchId + ":" + a.attemptNumber;
        this.putPayload(invId, handle, result); a.resultHandle = handle; a.state = "DISPATCHED"; this.putAttempt(a);
      });
      failpoint("c22-after-result");
    }
    this.finishAttempt(invId, attempt.id, error);
  }

  /** Publish or quarantine. A result is published only if the fence it was dispatched under still stands and nothing accepted a result first. */
  private finishAttempt(invId: string, attemptId: string, error: Error | null) {
    const committed = this.finishAttemptTx(invId, attemptId, error);
    if (committed) failpoint("c22-after-commit"); // a kill here leaves everything committed exactly once
  }
  private finishAttemptTx(invId: string, attemptId: string, error: Error | null): boolean {
    return this.store.tx(() => {
      const s = this.load(invId);
      const a = JSON.parse((this.db.prepare("select json from c22_attempts where id = ?").get(attemptId) as any).json) as StepAttempt;
      const st = this.step(a.stepId)!;
      const release = (usage: Usage, actual: Usage) => {
        s.budget.reserved = { tokens: Math.max(0, s.budget.reserved.tokens - usage.tokens), cost: Math.max(0, s.budget.reserved.cost - usage.cost), toolSteps: Math.max(0, s.budget.reserved.toolSteps - usage.toolSteps) };
        s.budget.consumed = { tokens: s.budget.consumed.tokens + actual.tokens, cost: s.budget.consumed.cost + actual.cost, toolSteps: s.budget.consumed.toolSteps + actual.toolSteps };
      };
      a.finishedAt = iso(this.now());
      if (error) {
        release(a.reservation, a.reservation);
        a.state = error instanceof C22Error && error.code === "CANCELLED" ? "CANCELLED" : "FAILED"; a.error = error.message.slice(0, 200); this.putAttempt(a);
        const permanent = error instanceof C22Error && (error.code === "FORBIDDEN" || error.code === "INVALID_SCHEMA" || error.code === "NOT_FOUND");
        if (a.state === "CANCELLED") { if (a.generation === s.generation && s.execution === "RUNNING") { st.state = "READY"; } }
        else if (permanent || this.attemptsOf(st.id).length > s.policy.maxRetriesPerStep) { st.state = "FAILED"; st.unavailableReason = a.error; this.event(s, "STEP_FAILED", { stepId: st.id, error: a.error }, "finish"); }
        else st.state = "READY";
        this.putStep(st); this.save(s); return false;
      }
      const publishable = a.generation === s.generation && s.execution === "RUNNING" && this.authorized(s) && st.state === "RUNNING" && st.generation === s.generation;
      const alreadyAccepted = !!st.acceptedAttemptId;
      if (!publishable || alreadyAccepted) {
        release(a.reservation, a.reservation);
        a.state = "ABANDONED"; a.error = alreadyAccepted ? "late result after another attempt was accepted" : "fenced: the investigation moved on while this ran"; this.putAttempt(a);
        this.event(s, "EXECUTION_FENCED", { attempt: a.id, quarantined: true, reason: a.error }, "finish");
        this.save(s); return false;
      }
      const raw = this.payload<any>(a.resultHandle!);
      release(a.reservation, a.reservation);
      a.state = "SUCCEEDED"; this.putAttempt(a);
      st.state = "SUCCEEDED"; st.acceptedAttemptId = a.id; st.resultHandle = a.resultHandle; st.resultHash = hash(raw); this.putStep(st);
      const states: Record<string, string> = {};
      if (st.toolId === "internal.assess") {
        const { observationId, hypothesisId, version } = st.request.payload as { observationId: string; hypothesisId: string; version: number };
        const o = this.observationsOf(s.id).find((x) => x.id === observationId); const h = this.hypothesis(hypothesisId, version);
        const latest = this.hypothesis(hypothesisId);
        if (o && h && latest && latest.version === h.version && !o.retracted && h.lifecycle === "ACTIVE") this.assess(s, h, o, "assess");
      } else if (st.toolId !== "internal.seed") {
        const res = raw as ToolResult;
        const n = this.publishToolResult(s, st, res);
        void n;
      } else {
        // Seeding committed its own hypotheses; plan the checks for them now.
        this.planChecks(s, undefined, "seed");
      }
      for (const h of this.hypothesesOf(s)) { h.evaluation = this.evaluate(s, h); h.updatedAt = iso(this.now()); this.putHyp(h); states[h.id] = h.evaluation.state; }
      this.relate(s);
      s.coverage = this.coverageOf(s);
      this.event(s, "ASSESSMENT_COMMITTED", { stepId: st.id, states }, "finish");
      this.event(s, "STEP_COMPLETED", { stepId: st.id, toolId: st.toolId }, "finish");
      this.commit(s, "finish");
      return true;
    });
  }

  /** A read's outcome becomes an observation (once), then an assessment of every hypothesis whose prediction that check is. */
  private publishToolResult(s: InvestigationSnapshot, st: StepRecord, res: ToolResult): number {
    const sourceEventId = `tool:${st.id}:${st.request ? hash(st.request) : ""}`;
    const input: ObservationInput = {
      evidenceIds: res.evidenceIds.length ? res.evidenceIds : [], description: res.summary, sourceEventId, kind: res.runtimeIds.length || res.toolId === "runtime.window" ? "RUNTIME_SIGNAL" : "SOURCE_FACT",
      outcome: res.outcome, revision: res.revision, certificate: res.certificate, sampling: res.certificate?.sampling ?? "UNKNOWN", attributionId: "tool:" + res.toolId, eventTime: iso(this.now()),
    };
    // A read that found nothing cites the revision it searched, so the observation still has a source to point at.
    if (!input.evidenceIds.length) {
      const ref = evidenceFor(this.store, s.scope.revision, `read:${st.id}`, res.toolId === "runtime.window" ? "RUNTIME" : "STATIC_RESOLVED", `revision:${s.scope.revision}`, res.summary.slice(0, 120), iso(this.now()), res.toolId === "runtime.window" ? "RuntimeLocation" : "DocumentLocation");
      input.evidenceIds = [ref.id];
    }
    const o = this.normalize(s, input);
    (o as any).checkIds = st.checkId ? [st.checkId] : [];
    const existing = this.db.prepare("select json from c22_observations where investigation_id = ? and source_event_id = ?").get(s.id, sourceEventId) as any;
    if (!existing) { this.putObs(o); if (res.certificate) this.putPayload(s.id, "cert:" + o.id, res.certificate); this.event(s, "EVIDENCE_ATTACHED", { observationId: o.id, kind: o.kind, via: res.toolId }, "tool"); }
    const obs = existing ? (JSON.parse(existing.json) as Observation) : o;
    (obs as any).checkIds = st.checkId ? [st.checkId] : [];
    let n = 0;
    for (const h of this.hypothesesOf(s)) {
      if (!h.predictions.some((p) => p.checkId === st.checkId)) continue;
      const pred = h.predictions.find((p) => p.checkId === st.checkId)!;
      this.assess(s, h, { ...obs, predictionId: pred.id }, "tool"); n++;
    }
    return n;
  }

  /** After the wave: decide FINISHED / WAITING / the stop reason, evaluate completion, commit. Never claims success the evidence does not give. */
  private settle(invId: string, generation: number): InvestigationSnapshot {
    return this.store.tx(() => {
      const s = this.load(invId);
      if (s.generation !== generation || s.execution !== "RUNNING") return s;
      const steps = this.stepsOf(invId);
      const open = steps.filter((x) => x.state === "READY" || x.state === "PENDING" || x.state === "RUNNING");
      const blocked = steps.filter((x) => x.state === "BLOCKED");
      if (open.length && !blocked.length) { s.execution = "READY"; }
      else {
        s.execution = "FINISHED";
        s.stopReason = blocked.length ? "BUDGET_EXHAUSTED" : steps.length ? "CHECKS_COMPLETED" : "NO_READY_CHECK";
        s.coverage = this.coverageOf(s);
        s.disposition = this.disposition(s);
      }
      s.coverage = this.coverageOf(s);
      this.event(s, "STATE_CHANGED", { to: s.execution, stopReason: s.stopReason }, "settle");
      return this.commit(s, "settle");
    });
  }

  /** Lease recovery after a crash: finish what has a persisted result, retry only what is a safe immutable read, never silently re-run something that may have cost money. */
  recoverExpiredAttempts(invId?: string): { recovered: number; retried: number; abandoned: number } {
    const out = { recovered: 0, retried: 0, abandoned: 0 };
    const rows = this.db.prepare("select json from c22_attempts where state in ('RESERVED','DISPATCHED')").all() as { json: string }[];
    for (const r of rows) {
      const a = JSON.parse(r.json) as StepAttempt;
      if (new Date(a.leaseExpiresAt) > this.now()) continue;
      const st = this.step(a.stepId); if (!st || (invId && st.investigationId !== invId)) continue;
      if (a.resultHandle) { this.finishAttempt(st.investigationId, a.id, null); out.recovered++; continue; }
      this.store.tx(() => {
        const s = this.load(st.investigationId); const cur = this.attemptsOf(st.id).find((x) => x.id === a.id)!;
        cur.state = "ABANDONED"; cur.error = "lease expired without a result"; cur.finishedAt = iso(this.now()); this.putAttempt(cur);
        s.budget.reserved = { tokens: Math.max(0, s.budget.reserved.tokens - a.reservation.tokens), cost: Math.max(0, s.budget.reserved.cost - a.reservation.cost), toolSteps: Math.max(0, s.budget.reserved.toolSteps - a.reservation.toolSteps) };
        const ambiguous = /^(model|provider)\./.test(st.toolId);
        if (ambiguous) { st.state = "FAILED"; st.unavailableReason = "AMBIGUOUS: a provider call may have been made and charged; ask before repeating it"; s.budget.consumed = { ...s.budget.consumed, tokens: s.budget.consumed.tokens + a.reservation.tokens, cost: s.budget.consumed.cost + a.reservation.cost }; out.abandoned++; }
        else if (this.attemptsOf(st.id).length > s.policy.maxRetriesPerStep) { st.state = "FAILED"; st.unavailableReason = "retries exhausted"; out.abandoned++; }
        else { st.state = "READY"; out.retried++; }
        this.putStep(st); this.save(s);
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ fences: pause, resume, cancel, steer
  /** Bump the generation so nothing dispatched under the old one can publish; running steps return to the queue or are cancelled. */
  private fenceAll(s: InvestigationSnapshot, stepState: "READY" | "CANCELLED" | "SUPERSEDED", reason: string): string[] {
    s.generation += 1;
    const invalidated: string[] = [];
    for (const st of this.stepsOf(s.id)) {
      if (st.state === "RUNNING") { for (const a of this.attemptsOf(st.id)) if (a.state === "RESERVED" || a.state === "DISPATCHED") invalidated.push(a.id); st.state = stepState; st.generation = s.generation; this.putStep(st); }
      else if ((st.state === "READY" || st.state === "PENDING") && stepState === "CANCELLED") { st.state = "CANCELLED"; this.putStep(st); }
    }
    // Reservations for attempts that are now orphaned are released when they report in; the budget never double counts them.
    this.event(s, "EXECUTION_FENCED", { reason, generation: s.generation, invalidatedAttemptIds: invalidated }, "fence");
    return invalidated;
  }

  pause(ctx: CallContext, req: { investigationId: string; expectedVersion: number; reason: string }) {
    return this.mutate(ctx, "pause", req.investigationId, req.expectedVersion, (s) => {
      if (!(["READY", "RUNNING", "WAITING"] as string[]).includes(s.execution)) throw new C22Error("FORBIDDEN", `cannot pause an investigation that is ${s.execution}`);
      this.fenceAll(s, "READY", "PAUSED"); s.execution = "PAUSED"; s.waitingFor = null;
      this.event(s, "STATE_CHANGED", { to: "PAUSED", reason: req.reason.slice(0, 200) }, ctx.idempotencyKey);
    });
  }
  resume(ctx: CallContext, req: { investigationId: string; expectedVersion: number }) {
    return this.mutate(ctx, "resume", req.investigationId, req.expectedVersion, (s) => {
      if (s.execution !== "PAUSED") throw new C22Error("FORBIDDEN", "only a paused investigation can be resumed");
      if (!this.authorized(s)) throw new C22Error("FORBIDDEN", "access to this investigation was withdrawn");
      s.generation += 1; s.execution = "READY";
      this.event(s, "STATE_CHANGED", { to: "READY", generation: s.generation }, ctx.idempotencyKey);
    });
  }
  cancel(ctx: CallContext, req: { investigationId: string; expectedVersion: number; reason: string }) {
    return this.mutate(ctx, "cancel", req.investigationId, req.expectedVersion, (s) => {
      if (s.execution === "CANCELLED") return;
      this.fenceAll(s, "CANCELLED", "CANCELLED"); s.execution = "CANCELLED"; s.stopReason = "USER_STOP";
      s.coverage = this.coverageOf(s); s.disposition = this.disposition(s);
      this.event(s, "STATE_CHANGED", { to: "CANCELLED", reason: req.reason.slice(0, 200) }, ctx.idempotencyKey);
    });
  }

  steer(ctx: CallContext, req: { investigationId: string; expectedVersion: number; action: SteeringAction }) {
    const a = req.action;
    oneOf("mode", a.mode ?? "GUIDED"); // a malformed mode fails here, not later
    return this.mutate(ctx, "steer", req.investigationId, req.expectedVersion, (s) => {
      let invalidated: string[] = []; let clarification: string | null = null;
      const need = (v: unknown, what: string) => { if (!v) throw new C22Error("INVALID_SCHEMA", `${what} is required`); };
      switch (a.type) {
        case "Prioritize": {
          need(a.hypothesisId, "hypothesisId");
          if (!this.hypothesis(a.hypothesisId!)) throw new C22Error("NOT_FOUND", "no such hypothesis");
          if (!s.pinned.includes(a.hypothesisId!)) s.pinned.push(a.hypothesisId!);
          this.reevaluateAll(s, ctx.idempotencyKey); // priority changes order, never support
          break;
        }
        case "AddScope": {
          need(a.refs?.length, "refs");
          if (!this.authorized(s)) throw new C22Error("FORBIDDEN", "enlarging scope needs current authority");
          if (s.budget.consumed.toolSteps + s.budget.reserved.toolSteps >= s.budget.limit.toolSteps) throw new C22Error("BUDGET_EXCEEDED", "enlarging scope needs budget, and none is left");
          for (const r of a.refs!) if (!this.store.entitiesById(s.scope.revision, [r])[0]) throw new C22Error("INVALID_SCHEMA", `"${r}" is not an entity of the pinned revision`);
          invalidated = this.rescope(s, [...new Set([...s.scope.roots, ...a.refs!])], s.scope.incidentWindow, "AddScope");
          break;
        }
        case "NarrowScope": {
          need(a.refs?.length, "refs");
          const keep = s.scope.roots.filter((r) => a.refs!.includes(r));
          const dropped = s.scope.roots.filter((r) => !a.refs!.includes(r));
          s.coverage.excludedEntityIds = [...new Set([...s.coverage.excludedEntityIds, ...dropped])];
          invalidated = this.rescope(s, keep, s.scope.incidentWindow, "NarrowScope");
          // Work that only concerned code now out of scope is cancelled, and conclusions about it become unavailable.
          for (const st of this.stepsOf(s.id)) {
            const ents = ["entityId", "from", "to"].map((k) => st.request.payload[k]).filter((v): v is string => typeof v === "string");
            if (ents.length && ents.every((e) => dropped.includes(e)) && (st.state === "READY" || st.state === "PENDING" || st.state === "RUNNING")) { st.state = "SUPERSEDED"; this.putStep(st); }
          }
          for (const h of this.hypothesesOf(s)) { const es = h.mechanism.flatMap((m) => [m.from, m.to]).flatMap((e) => (e.kind === "entity" ? [e.ref] : [])); if (es.length && es.every((e) => dropped.includes(e))) { h.lifecycle = "RETIRED"; this.putHyp(h); } }
          break;
        }
        case "ChangeWindow": {
          need(a.window, "window");
          if (!a.window || Date.parse(a.window.start) >= Date.parse(a.window.end)) throw new C22Error("INVALID_SCHEMA", "the window must start before it ends");
          invalidated = this.rescope(s, s.scope.roots, a.window, "ChangeWindow");
          // Earlier observations stay as history but need an explicit comparability check before they count again.
          for (const h of this.hypothesesOf(s, { all: true })) for (const as of this.assessmentsOf(h.id)) if (!as.stale) { as.stale = true; as.reasonCodes = [...as.reasonCodes, "WINDOW_CHANGED"]; this.putAssessment(as); }
          this.reevaluateAll(s, ctx.idempotencyKey);
          break;
        }
        case "ChangeGoal": {
          need(a.goal?.question, "goal");
          s.goal = { ...s.goal, ...a.goal!, question: a.goal!.question.trim().slice(0, 500) };
          invalidated = this.rescope(s, s.scope.roots, s.scope.incidentWindow, "ChangeGoal");
          break;
        }
        case "ExcludeCheck": {
          need(a.checkId, "checkId");
          let n = 0; for (const st of this.stepsOf(s.id)) if (st.checkId === a.checkId && (st.state === "READY" || st.state === "PENDING")) { st.state = "SUPERSEDED"; st.unavailableReason = (a.reason ?? "excluded by you").slice(0, 200); this.putStep(st); n++; }
          if (!n) throw new C22Error("NOT_FOUND", "no waiting step runs that check");
          this.event(s, "PLAN_CHANGED", { excluded: a.checkId, reason: a.reason ?? "" }, ctx.idempotencyKey);
          break;
        }
        case "SetMode": { s.mode = oneOf("mode", a.mode, "mode"); break; }
        default: throw new C22Error("INVALID_SCHEMA", `unknown steering action "${String((a as any).type)}"`);
      }
      return { invalidatedAttemptIds: invalidated, clarification };
    });
  }
  /** A new scope is a new hash and a new generation; whatever was dispatched under the old one cannot publish. */
  private rescope(s: InvestigationSnapshot, roots: string[], window: TimeWindow | null, why: string): string[] {
    const sc = this.scopeOf(s.scope.revision, s.scope.repoRoot, roots, window, this.epoch(s.id).epoch, s.scope.deploymentIds);
    const invalidated = this.fenceAll(s, "READY", why);
    s.scope = { ...sc, allowedTools: s.scope.allowedTools }; s.scope.scopeHash = hash({ ...s.scope, scopeHash: undefined });
    s.coverage.scopeHash = s.scope.scopeHash;
    if (s.execution === "RUNNING") s.execution = "READY";
    this.event(s, "PLAN_CHANGED", { scope: why, scopeHash: s.scope.scopeHash }, "rescope");
    return invalidated;
  }

  /** Legacy `steer(instruction)`: the instruction is stored and a clarification is returned. Free text never changes scope. */
  steerLegacy(ctx: CallContext, req: { investigationId: string; expectedVersion: number; instruction: string }) {
    const r = this.mutate(ctx, "steerLegacy", req.investigationId, req.expectedVersion, (s) => {
      this.event(s, "PLAN_CHANGED", { instructionStored: req.instruction.slice(0, 300), applied: false }, ctx.idempotencyKey);
      return { clarification: "I kept your instruction, but a free-text instruction cannot change scope or budget. Choose one of: prioritize a hypothesis, add or narrow scope, change the window, exclude a check, or change the goal." };
    });
    return r;
  }

  // ------------------------------------------------------------------ completion, finalize, reopen
  private disposition(s: InvestigationSnapshot): InvestigationSnapshot["disposition"] {
    if (s.disposition === "USER_CLOSED") return "USER_CLOSED";
    const hs = this.hypothesesOf(s);
    if (hs.some((h) => h.evaluation.freshness === "STALE")) return "STALE";
    const supported = hs.filter((h) => h.evaluation.state === "SUPPORTED");
    const materialGap = s.coverage.missing.some((g) => g.material);
    if (s.stopReason === "ACCESS_REVOKED" || s.stopReason === "BUDGET_EXHAUSTED" || s.stopReason === "USER_STOP") return supported.length && !materialGap ? "EXPLAINED_WITH_LIMITS" : "UNRESOLVED";
    return supported.length && !materialGap ? "EXPLAINED_WITH_LIMITS" : "UNRESOLVED";
  }

  getCompletion(investigationId: string): CompletionReport {
    const s = this.get(investigationId);
    return this.report(s);
  }
  private report(s: InvestigationSnapshot): CompletionReport {
    const hs = this.hypothesesOf(s, { all: true }).filter((h) => h.lifecycle !== "SUPERSEDED");
    const cov = this.coverageOf(s);
    const disposition = this.disposition({ ...s, coverage: cov });
    const by = (st: string) => hs.filter((h) => h.evaluation.state === st).map((h) => h.id);
    const supported = by("SUPPORTED"), refuted = by("REFUTED"), contested = by("CONTESTED"), unresolved = [...by("UNRESOLVED"), ...by("OPEN")];
    const findings: Finding[] = [];
    for (const id of supported) { const h = hs.find((x) => x.id === id)!; findings.push({ id: "fnd:" + hash(id), statement: `Supported, within the scope examined: ${h.statement}`, kind: "supported", hypothesisIds: [id], claimIds: [h.claimId] }); }
    for (const id of refuted) { const h = hs.find((x) => x.id === id)!; findings.push({ id: "fnd:" + hash(id, "r"), statement: `Refuted for what was examined (${s.coverage.scopeHash.slice(0, 6)}): ${h.statement}`, kind: "refuted", hypothesisIds: [id], claimIds: [h.claimId] }); }
    for (const id of [...contested, ...unresolved]) { const h = hs.find((x) => x.id === id)!; findings.push({ id: "fnd:" + hash(id, "u"), statement: `Not settled (${h.evaluation.state.toLowerCase()}): ${h.statement}`, kind: "unresolved", hypothesisIds: [id], claimIds: [h.claimId] }); }
    const limits: string[] = [];
    if (UNIVERSAL.test(s.goal.question)) limits.push(`You asked for something universal ("${s.goal.question.slice(0, 80)}"). That needs a sound exhaustive analysis, which this is not: it inspected ${cov.inspectedEntityIds.length} entities, excluded ${cov.excludedEntityIds.length}, and found candidate mechanisms, not a proof that no others exist.`);
    for (const g of cov.missing.filter((x) => x.material)) limits.push(`${g.description} (${g.reason.toLowerCase().replace(/_/g, " ")})`);
    if (s.pendingEvidence) limits.push(`${s.pendingEvidence} piece(s) of evidence arrived after this was finalized and are not reflected; reopen to assess them`);
    if (disposition === "STALE") limits.push("The code this rests on changed after the revision was pinned; re-validate before relying on it");
    const checks = this.checksOf(s.id).filter((c) => !cov.attemptedCheckIds.includes(c.id)).sort((a, b) => b.value.score - a.value.score).slice(0, 5);
    return {
      investigationId: s.id, version: s.version, execution: s.execution, disposition, supportedHypothesisIds: supported, refutedHypothesisIds: refuted, unresolvedHypothesisIds: [...unresolved], contestedHypothesisIds: contested,
      findings, coverage: cov, stopReason: s.stopReason ?? "NO_READY_CHECK", nextActions: checks,
      // A conclusion claim exists only when the disposition is an explanation with limits; an unresolved question concludes nothing.
      conclusionClaimIds: disposition === "EXPLAINED_WITH_LIMITS" ? findings.filter((f) => f.kind === "supported").flatMap((f) => f.claimIds) : [],
      universalClaim: false, limits, generatedAt: iso(this.now()),
    };
  }

  finalize(ctx: CallContext, req: { investigationId: string; expectedVersion: number; completionReportVersion?: number; userClosed?: boolean }) {
    return this.mutate(ctx, "finalize", req.investigationId, req.expectedVersion, (s) => {
      if (s.closure === "FINALIZED") throw new C22Error("FORBIDDEN", "already finalized");
      if (req.completionReportVersion !== undefined && req.completionReportVersion !== s.version) throw new C22Error("VERSION_CONFLICT", "the investigation changed since you read the report; read it again", s.version);
      if (req.userClosed) s.disposition = "USER_CLOSED";
      const rep = this.report(s);
      if (!req.userClosed) s.disposition = rep.disposition;
      this.fenceAll(s, "CANCELLED", "FINALIZED");
      if (s.execution === "RUNNING" || s.execution === "READY" || s.execution === "WAITING" || s.execution === "PAUSED") s.execution = "FINISHED";
      s.closure = "FINALIZED";
      this.putPayload(s.id, `report:${s.version + 1}`, rep);
      this.event(s, "COMPLETION_RECORDED", { disposition: s.disposition, supported: rep.supportedHypothesisIds, unresolved: rep.unresolvedHypothesisIds }, ctx.idempotencyKey);
      return { ...rep, disposition: s.disposition };
    });
  }

  reopen(ctx: CallContext, req: { investigationId: string; expectedVersion: number; goalAmendment?: Goal }) {
    return this.mutate(ctx, "reopen", req.investigationId, req.expectedVersion, (s) => {
      if (s.closure !== "FINALIZED" && s.execution !== "FINISHED" && s.execution !== "CANCELLED") throw new C22Error("FORBIDDEN", "only a finished or finalized investigation can be reopened");
      if (!this.authorized(s)) throw new C22Error("FORBIDDEN", "access to this investigation was withdrawn");
      s.closure = "OPEN"; s.generation += 1; s.execution = "READY"; s.stopReason = null; s.disposition = "UNASSESSED";
      if (req.goalAmendment) s.goal = { ...s.goal, ...req.goalAmendment };
      // Evidence that arrived while it was closed is assessed now, by an explicit reassessment.
      if (s.pendingEvidence) {
        for (const o of this.observationsOf(s.id).filter((x) => !x.retracted)) for (const h of this.hypothesesOf(s)) {
          const st = this.newStep(s, null, "internal.assess", { schemaId: "c22.step.assess.v1", version: 1, payload: { observationId: o.id, hypothesisId: h.id, version: h.version } }, []);
          if (!this.step(st.id)) { this.putStep(st); s.stepIds.push(st.id); }
        }
        s.pendingEvidence = 0;
      }
      this.event(s, "STATE_CHANGED", { to: "READY", reopened: true, generation: s.generation }, ctx.idempotencyKey);
    });
  }

  // ------------------------------------------------------------------ experiments: proposals only
  proposeExperiment(ctx: CallContext, req: { investigationId: string; expectedVersion: number; draft: { description: string; hypothesisIds: string[]; predictedOutcomes?: ExperimentProposal["predictedOutcomes"]; requiredEnvironment: string; requiredPermissions?: string[]; scenarioId?: string | null; executionClass?: string } }) {
    return this.mutate(ctx, "proposeExperiment", req.investigationId, req.expectedVersion, (s) => {
      if (req.draft.executionClass && req.draft.executionClass !== "ISOLATED_EXPERIMENT_PROPOSAL") throw new C22Error("FORBIDDEN", "an experiment can only be proposed here; it is never run by the investigation");
      const p: ExperimentProposal = {
        id: "exp:" + hash(s.id, req.draft.description), investigationId: s.id, hypothesisIds: req.draft.hypothesisIds, description: req.draft.description.slice(0, 500), predictedOutcomes: req.draft.predictedOutcomes ?? [],
        requiredEnvironment: req.draft.requiredEnvironment.slice(0, 200), requiredPermissions: req.draft.requiredPermissions ?? [], executionClass: "ISOLATED_EXPERIMENT_PROPOSAL", state: "PROPOSED", scenarioId: req.draft.scenarioId ?? null, evidenceIds: [],
      };
      this.db.prepare("insert or replace into c22_experiments values (?,?,?)").run(p.id, s.id, JSON.stringify(p));
      for (const hid of p.hypothesisIds) { const h = this.hypothesis(hid); if (h && !h.experimentIds.includes(p.id)) { h.experimentIds.push(p.id); this.putHyp(h); } }
      return p;
    });
  }
  /** Not part of the public allowlist. Needs a grant that a person issued for this scope, and a runner that was configured; otherwise nothing runs. */
  async requestExperiment(ctx: CallContext, req: { investigationId: string; experimentId: string; authorizationGrantId: string }): Promise<ExperimentProposal> {
    const row = this.db.prepare("select json from c22_experiments where id = ? and investigation_id = ?").get(req.experimentId, req.investigationId) as any;
    if (!row) throw new C22Error("NOT_FOUND", "no such experiment proposal");
    const grant = this.db.prepare("select scope from c22_grants where id = ?").get(req.authorizationGrantId) as any;
    if (!grant || (grant.scope !== req.experimentId && grant.scope !== req.investigationId)) throw new C22Error("FORBIDDEN", "a visible proposal is not authorization; no grant covers this experiment");
    if (!this.runner) throw new C22Error("FORBIDDEN", "no isolated experiment runner is configured");
    const p = JSON.parse(row.json) as ExperimentProposal;
    p.state = "REQUESTED"; this.db.prepare("insert or replace into c22_experiments values (?,?,?)").run(p.id, req.investigationId, JSON.stringify(p));
    this.experimentDispatches++;
    await this.runner(p);
    void ctx;
    return p;
  }
  /** A person issues a grant (outside the investigation, never from model output). */
  issueGrant(scope: string): string { const id = "grant:" + randomUUID(); this.db.prepare("insert into c22_grants values (?,?,?)").run(id, scope, iso(this.now())); return id; }

  // ------------------------------------------------------------------ board and events
  /** One consistent read for the investigation screen, including the evidence comparison matrix. */
  getDetails(investigationId: string) {
    const snapshot = this.get(investigationId);
    if (!this.authorized(snapshot)) throw new C22Error("FORBIDDEN", "access to this investigation was withdrawn");
    const hypotheses = this.hypothesesOf(snapshot);
    return {
      snapshot, hypotheses,
      observations: this.observationsOf(snapshot.id),
      assessments: hypotheses.flatMap((h) => this.assessmentsOf(h.id).filter((a) => a.hypothesisVersion === h.version)),
      checks: this.checksOf(snapshot.id), steps: this.stepsOf(snapshot.id),
    };
  }

  private boardOf(s: InvestigationSnapshot, restrictedOverride?: boolean): BoardSnapshot {
    const restricted = restrictedOverride ?? !this.authorized(s);
    const base = { investigationId: s.id, investigationVersion: s.version, sequence: s.eventSequence, generation: s.generation, scopeHash: s.scope.scopeHash, execution: s.execution, disposition: s.disposition };
    if (restricted) return { ...base, restricted: true, hypothesisIds: [], claimIds: [], evidenceIds: [], checkIds: [], unknownGapIds: [], hypotheses: [] };
    const hs = this.hypothesesOf(s);
    const evidenceIds = [...new Set(this.observationsOf(s.id).filter((o) => !o.retracted).flatMap((o) => o.evidenceIds))];
    return {
      ...base, restricted: false, hypothesisIds: hs.map((h) => h.id), claimIds: hs.map((h) => h.claimId), evidenceIds, checkIds: this.checksOf(s.id).map((c) => c.id), unknownGapIds: s.coverage.missing.map((g) => g.id),
      hypotheses: hs.map((h) => ({ id: h.id, version: h.version, statement: h.statement, state: h.evaluation.state, freshness: h.evaluation.freshness, claimId: h.claimId, priority: h.evaluation.rank.investigationPriority, disputed: h.evaluation.disputed, independentSupportGroups: h.evaluation.independentSupportGroups, reasonCodes: h.evaluation.reasonCodes })),
    };
  }
  /** The committed board: a full snapshot, a delta from a version the client knows, or "unchanged". Revoked access sees nothing. */
  getBoard(investigationId: string, knownVersion?: number): BoardReply {
    const s = this.get(investigationId);
    const snapshot = this.boardOf(s);
    if (snapshot.restricted) return { kind: "full", snapshot };
    if (knownVersion === undefined) return { kind: "full", snapshot };
    if (knownVersion === s.version) return { kind: "unchanged", version: s.version, sequence: s.eventSequence };
    const prev = this.db.prepare("select json from c22_checkpoints where investigation_id = ? and version = ?").get(investigationId, knownVersion) as any;
    if (!prev) return { kind: "full", snapshot };
    const old = (JSON.parse(prev.json).board as BoardSnapshot);
    const oldBy = new Map(old.hypotheses.map((h) => [h.id, h])); const newBy = new Map(snapshot.hypotheses.map((h) => [h.id, h]));
    const changed = snapshot.hypotheses.filter((h) => JSON.stringify(oldBy.get(h.id)) !== JSON.stringify(h)).map((h) => h.id);
    const removed = old.hypotheses.filter((h) => !newBy.has(h.id)).map((h) => h.id);
    const delta: BoardDelta = {
      investigationId, baseVersion: knownVersion, newVersion: s.version, fromSequence: old.sequence, toSequence: s.eventSequence, generation: s.generation,
      changedHypothesisIds: changed, removedHypothesisIds: removed, changedClaimIds: changed.map((id) => newBy.get(id)!.claimId), addedEvidenceIds: snapshot.evidenceIds.filter((e) => !old.evidenceIds.includes(e)),
      requiresRecompile: changed.length > 0 || removed.length > 0 || snapshot.generation !== old.generation,
    };
    return { kind: "changed", delta, snapshot };
  }

  /** Durable replay for a client that lost its place. History is filtered by what the viewer may see now; a hidden event is a placeholder that keeps the sequence. */
  readEvents(investigationId: string, afterSequence: number, limit = 200): { items: InvestigationEvent[]; nextSequence: number; replayRequired: boolean } {
    const r = this.row(investigationId);
    if (!r) throw new C22Error("NOT_FOUND", "no such investigation");
    const rows = this.db.prepare("select json from c22_events where investigation_id = ? and sequence > ? order by sequence limit ?").all(investigationId, afterSequence, Math.min(Math.max(limit, 1), 500)) as { json: string }[];
    const oldest = (this.db.prepare("select coalesce(min(sequence), 0) m from c22_events where investigation_id = ?").get(investigationId) as any).m as number;
    const restricted = !!r.deleted || !this.authorized(JSON.parse(r.json) as InvestigationSnapshot);
    const items = rows.map((x) => { const ev = JSON.parse(x.json) as InvestigationEvent; return restricted ? { ...ev, payload: {}, redacted: true } : ev; });
    const replayRequired = (oldest > 0 && afterSequence + 1 < oldest) || !!r.deleted || items.some((e, i) => i > 0 && e.sequence !== items[i - 1].sequence + 1);
    return { items, nextSequence: items.length ? items[items.length - 1].sequence : afterSequence, replayRequired };
  }
  /** Drop events older than `keepFrom`, as retention would; a client behind that point must resync from a snapshot. */
  pruneEvents(investigationId: string, keepFrom: number): number { return Number(this.db.prepare("delete from c22_events where investigation_id = ? and sequence < ?").run(investigationId, keepFrom).changes); }

  /** Rebuild each hypothesis' state from the latest checkpoint plus the events after it; must equal the live board. */
  replayStates(investigationId: string): Record<string, string> {
    const ck = this.db.prepare("select json from c22_checkpoints where investigation_id = ? order by version desc limit 1").get(investigationId) as any;
    const states: Record<string, string> = {};
    const board = ck ? (JSON.parse(ck.json).board as BoardSnapshot) : null; const snap = ck ? (JSON.parse(ck.json).snapshot as InvestigationSnapshot) : null;
    for (const h of board?.hypotheses ?? []) states[h.id] = h.state;
    const after = snap?.eventSequence ?? 0;
    for (const x of this.db.prepare("select json from c22_events where investigation_id = ? and sequence > ? order by sequence").all(investigationId, after) as { json: string }[]) {
      const ev = JSON.parse(x.json) as InvestigationEvent;
      for (const [id, st] of Object.entries((ev.payload.states as Record<string, string>) ?? {})) states[id] = st;
    }
    return states;
  }

  /** Delete the investigation's content. A tombstone keeps that it existed and when it was removed; nothing private can be rebuilt from it. */
  deleteInvestigation(ctx: CallContext, invId: string): { deleted: true } {
    this.store.tx(() => {
      const s = this.load(invId);
      const hyps = this.hypothesesOf(s, { all: true });
      const claimIds = hyps.flatMap((h) => [h.claimId, ...this.assessmentsOf(h.id).map((a) => a.claimId)]);
      for (const st of this.stepsOf(invId)) this.db.prepare("delete from c22_attempts where step_id = ?").run(st.id);
      for (const h of hyps) this.db.prepare("delete from c22_assessments where hypothesis_id = ?").run(h.id);
      for (const t of ["c22_hypotheses", "c22_observations", "c22_checks", "c22_steps", "c22_experiments", "c22_payloads", "c22_checkpoints"]) this.db.prepare(`delete from ${t} where investigation_id = ?`).run(invId);
      for (const id of claimIds) { this.db.prepare("delete from verdicts where claim_id = ?").run(id); this.db.prepare("delete from claims where id = ?").run(id); }
      const evs = this.db.prepare("select json from c22_events where investigation_id = ?").all(invId) as { json: string }[];
      this.db.prepare("delete from c22_events where investigation_id = ?").run(invId);
      for (const x of evs) { const ev = JSON.parse(x.json) as InvestigationEvent; this.db.prepare("insert into c22_events values (?,?,?)").run(invId, ev.sequence, JSON.stringify({ id: ev.id, investigationId: invId, sequence: ev.sequence, aggregateVersion: ev.aggregateVersion, generation: ev.generation, type: "STATE_CHANGED", payload: {}, scopeHash: "", causedByCommandId: "", createdAt: ev.createdAt, redacted: true })); }
      this.db.prepare("update c22_investigations set deleted = 1, json = ? where id = ?").run(JSON.stringify({ id: invId, workspaceId: s.workspaceId, deleted: true }), invId);
      this.store.audit(ctx.actor.principalId, "c22.delete", "(deleted)", { events: evs.length });
    });
    return { deleted: true };
  }
}
