// Task 1.B — the FeatureStore over the five record families (migration 33). Rules:
//   * Every write that changes a request's state also appends its milestone event IN THE SAME TRANSACTION (the outbox), so a
//     crash can never leave a state change without its event or an event without its state.
//   * Mutable pointers (the request record) move by compare-and-swap on `version`; a stale writer gets VERSION_CONFLICT.
//   * Decisions and evidence are immutable: re-putting the same id with the same identity is a no-op, with a different one is refused.
//   * Event sequences are dense per request, starting at 1.
import { asSet, canonHash, defineSchema, type Canon } from "./canon.ts";
import { FeatureError } from "./errors.ts";
import type { BuilderEvaluation, CandidateRecord, DecisionRecord, EventRecord, EvidenceRecord, FeatureRecord, FeatureStore, Id } from "./types.ts";
import type { Store } from "../store.ts";

type NewEvent = Omit<EventRecord, "sequence" | "sync">;
const now = () => new Date().toISOString();

const DecisionIdentity = defineSchema<DecisionRecord>("pf.DecisionRecord", "1", (d) => ({
  id: d.id, requestId: d.requestId, kind: d.kind, questionId: d.questionId ?? "", findingId: d.findingId ?? "", answer: d.answer, actorId: d.actorId,
  authorityBindingId: d.authorityBindingId ?? "", contractVersion: d.contractVersion, affectedIds: asSet([...new Set(d.affectedIds)]) as Canon, rationale: d.rationale,
  createdAt: d.createdAt, supersedesId: d.supersedesId ?? "",
  waiver: d.waiver ? { owner: d.waiver.owner, criteria: asSet([...new Set(d.waiver.criteria)]) as Canon, expiresAt: d.waiver.expiresAt, residualRisk: d.waiver.residualRisk } : null,
}));
const EvidenceIdentity = defineSchema<EvidenceRecord>("pf.EvidenceRecord", "1", (e) => ({
  id: e.id, requestId: e.requestId, candidateId: e.candidateId, bindingHash: e.bindingHash, kind: e.kind, manifestId: e.manifest.id, outcomeRef: e.outcomeRef,
  results: e.results.map((r) => ({ id: r.id, acceptanceId: r.acceptanceId ?? "", kind: r.kind, target: r.target ?? "", status: r.status, gaps: r.gaps })),
}));
export const decisionIdentity = (d: DecisionRecord): string => canonHash(DecisionIdentity, d);

export class SqliteFeatureStore implements FeatureStore {
  private readonly s: Store;
  constructor(store: Store) { this.s = store; }
  selectedModel(): string | null { return this.s.selectedModel(); }
  private get db() { return this.s.db; }

  // ------------------------------------------------------------------ events (always called inside a transaction)
  private insertEvent(ev: NewEvent): EventRecord {
    const dup = this.db.prepare("select request_id, sequence, json, sync_state, sync_remote_id, sync_attempts from feature_events where event_id = ?").get(ev.eventId) as EventRow | undefined;
    if (dup) { if (dup.request_id !== ev.requestId) throw new FeatureError("IDEMPOTENCY_CONFLICT", `event id ${ev.eventId} belongs to another request`); return rowToEvent(dup); }
    const seq = (this.db.prepare("select coalesce(max(sequence),0)+1 n from feature_events where request_id = ?").get(ev.requestId) as { n: number }).n;
    const full: EventRecord = { ...ev, sequence: seq, sync: { state: "PENDING", attempts: 0 } };
    this.db.prepare("insert into feature_events(request_id,sequence,event_id,type,actor,schema_version,json,at) values (?,?,?,?,?,?,?,?)")
      .run(ev.requestId, seq, ev.eventId, ev.type, ev.actor, ev.schemaVersion, JSON.stringify(ev), ev.at);
    return full;
  }

  // ------------------------------------------------------------------ requests
  createRequest(rec: FeatureRecord, firstEvent: NewEvent, idempotencyKey: string): { record: FeatureRecord; replayed: boolean } {
    if (!idempotencyKey) throw new FeatureError("INVALID_SCHEMA", "an idempotency key is required to create a request");
    return this.s.tx(() => {
      const prior = this.db.prepare("select json from feature_records where created_by = ? and idempotency_key = ?").get(rec.createdBy, idempotencyKey) as { json: string } | undefined;
      if (prior) {
        const existing = JSON.parse(prior.json) as FeatureRecord;
        if (existing.promptRef.contentHash !== rec.promptRef.contentHash || existing.repositoryId !== rec.repositoryId) throw new FeatureError("IDEMPOTENCY_CONFLICT", "this idempotency key was already used for a different request");
        return { record: existing, replayed: true };
      }
      const stored: FeatureRecord = { ...rec, version: 0 };
      this.db.prepare("insert into feature_records(request_id,repository_id,state,version,contract_version,schema_version,json,idempotency_key,created_by,created_at,updated_at,release_id) values (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(stored.requestId, stored.repositoryId, stored.state, 0, stored.contractVersion, stored.schemaVersion, JSON.stringify(stored), idempotencyKey, stored.createdBy, stored.createdAt, stored.updatedAt, stored.workspace.releaseId ?? null);
      this.insertEvent(firstEvent);
      return { record: stored, replayed: false };
    });
  }
  getRequest(requestId: Id): FeatureRecord | null {
    const r = this.db.prepare("select json, version from feature_records where request_id = ?").get(requestId) as { json: string; version: number } | undefined;
    return r ? { ...(JSON.parse(r.json) as FeatureRecord), version: r.version } : null;
  }
  updateRequest(requestId: Id, expectedVersion: number, next: FeatureRecord, event?: NewEvent): FeatureRecord {
    if (next.requestId !== requestId) throw new FeatureError("INVALID_SCHEMA", "the record does not belong to this request");
    return this.s.tx(() => {
      const cur = this.db.prepare("select version, created_by, repository_id from feature_records where request_id = ?").get(requestId) as { version: number; created_by: string; repository_id: string } | undefined;
      if (!cur) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
      if (cur.version !== expectedVersion) throw new FeatureError("VERSION_CONFLICT", `the request changed (version ${cur.version}, expected ${expectedVersion})`, cur.version);
      if (next.createdBy !== cur.created_by || next.repositoryId !== cur.repository_id) throw new FeatureError("INVALID_SCHEMA", "the owner and repository of a request cannot change");
      const stored: FeatureRecord = { ...next, version: expectedVersion + 1, updatedAt: now() };
      this.db.prepare("update feature_records set state=?, version=?, contract_version=?, json=?, updated_at=?, release_id=? where request_id=? and version=?")
        .run(stored.state, stored.version, stored.contractVersion, JSON.stringify(stored), stored.updatedAt, stored.workspace.releaseId ?? null, requestId, expectedVersion);
      if (event) this.insertEvent(event);
      return stored;
    });
  }
  listRequests(repositoryId?: Id, limit = 50): FeatureRecord[] {
    const rows = (repositoryId
      ? this.db.prepare("select json, version from feature_records where repository_id = ? order by updated_at desc limit ?").all(repositoryId, limit)
      : this.db.prepare("select json, version from feature_records order by updated_at desc limit ?").all(limit)) as { json: string; version: number }[];
    return rows.map((r) => ({ ...(JSON.parse(r.json) as FeatureRecord), version: r.version }));
  }
  /** Every request building toward a release (release-scope.ts's Release), newest first — an indexed column, not a
   *  load-then-filter over every request (contrast with the owner-filtered loops elsewhere that reuse listRequests). */
  listRequestsByRelease(releaseId: Id, limit = 50): FeatureRecord[] {
    const rows = this.db.prepare("select json, version from feature_records where release_id = ? order by updated_at desc limit ?").all(releaseId, limit) as { json: string; version: number }[];
    return rows.map((r) => ({ ...(JSON.parse(r.json) as FeatureRecord), version: r.version }));
  }

  // ------------------------------------------------------------------ decisions
  putDecision(rec: DecisionRecord, event?: NewEvent): DecisionRecord {
    const identity = decisionIdentity(rec);
    return this.s.tx(() => {
      if (!this.getRequest(rec.requestId)) throw new FeatureError("NOT_FOUND", `no such request ${rec.requestId}`);
      const prior = this.db.prepare("select identity, json from feature_decisions where id = ?").get(rec.id) as { identity: string; json: string } | undefined;
      if (prior) { if (prior.identity !== identity) throw new FeatureError("IDEMPOTENCY_CONFLICT", `decision ${rec.id} already exists with different content; supersede it with a new record`); return JSON.parse(prior.json) as DecisionRecord; }
      if (rec.supersedesId) {
        const old = this.db.prepare("select request_id from feature_decisions where id = ?").get(rec.supersedesId) as { request_id: string } | undefined;
        if (!old || old.request_id !== rec.requestId) throw new FeatureError("INVALID_SCHEMA", "a decision can only supersede an earlier decision of the same request");
      }
      this.db.prepare("insert into feature_decisions(id,request_id,kind,contract_version,supersedes_id,schema_version,identity,json,created_at) values (?,?,?,?,?,?,?,?,?)")
        .run(rec.id, rec.requestId, rec.kind, rec.contractVersion, rec.supersedesId ?? null, rec.schemaVersion, identity, JSON.stringify(rec), rec.createdAt);
      if (event) this.insertEvent(event);
      return rec;
    });
  }
  listDecisions(requestId: Id): DecisionRecord[] {
    return (this.db.prepare("select json from feature_decisions where request_id = ? order by created_at, id").all(requestId) as { json: string }[]).map((r) => JSON.parse(r.json) as DecisionRecord);
  }
  /** Decisions not superseded by a later one: what is currently in force. */
  activeDecisions(requestId: Id): DecisionRecord[] {
    const all = this.listDecisions(requestId); const gone = new Set(all.map((d) => d.supersedesId).filter((x): x is string => !!x));
    return all.filter((d) => !gone.has(d.id));
  }

  // ------------------------------------------------------------------ candidates
  /**
   * The commit-time lease check (#93), run inside the same transaction as the write. Rules, for the paths the write changes:
   *   * another request holds a live lease on any of them: refused, with or without a token (a replaced worker lands here);
   *   * this request has lease rows (live or expired): a fence is required, must name that lease and the CURRENT token for every path,
   *     and the lease must not have expired; a path outside the leased surfaces is refused;
   *   * no lease rows at all: coordination is not in use for this request and the write proceeds.
   * `requireFence` makes a fence mandatory even without lease rows.
   */
  assertFence(requestId: Id, paths: string[], fence: { leaseId: Id; token: number } | undefined, opts: { nowMs?: number; requireFence?: boolean; takeoverOnly?: boolean } = {}): void {
    const rec = this.getRequest(requestId); if (!rec) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
    const now = opts.nowMs ?? Date.now();
    const q = this.db.prepare("select surface, lease_id, request_id, fencing_token, expires_at from feature_leases where repository_id = ? and surface = ?");
    const row = (surface: string) => q.get(rec.repositoryId, surface) as { surface: string; lease_id: string; request_id: string; fencing_token: number; expires_at: number } | undefined;
    const taken = paths.filter((p) => { const r = row(p); return r && r.request_id !== requestId && r.expires_at > now; });
    if (taken.length) throw new FeatureError("STALE_REVISION", `${taken[0]} is leased by another request; this write is refused${taken.length > 1 ? ` (and ${taken.length - 1} more path(s))` : ""}`);
    // Monotonic fence: a presented token below the repository's current token was issued before a newer lease and is stale, whichever paths it names.
    const current = (this.db.prepare("select token from feature_fence where repository_id = ?").get(rec.repositoryId) as { token: number } | undefined)?.token ?? 0;
    if (fence && fence.token < current && !paths.every((p) => { const r = row(p); return r && r.request_id === requestId && r.fencing_token === fence.token && r.lease_id === fence.leaseId && r.expires_at > now; })) throw new FeatureError("STALE_REVISION", `fencing token ${fence.token} is older than the repository's current token ${current}; the write is refused`);
    if (opts.takeoverOnly) return;
    const mine = (this.db.prepare("select count(*) n from feature_leases where request_id = ?").get(requestId) as { n: number }).n > 0;
    if (!mine && !opts.requireFence) return;
    if (!fence) throw new FeatureError("STALE_REVISION", "a lease id and fencing token are required to write a candidate for this request");
    for (const p of paths) {
      const r = row(p);
      if (!r || r.request_id !== requestId) throw new FeatureError("STALE_REVISION", `${p} is not covered by a lease held by this request; reserve it before building`);
      if (r.lease_id !== fence.leaseId || r.fencing_token !== fence.token) throw new FeatureError("STALE_REVISION", `the fencing token for ${p} is not current (expected ${r.fencing_token}, got ${fence.token}); the write is refused`);
      if (r.expires_at <= now) throw new FeatureError("STALE_REVISION", `the lease on ${p} expired; reserve it again`);
    }
  }
  putCandidate(rec: CandidateRecord, event?: NewEvent, fence?: { leaseId: Id; token: number; nowMs?: number; requireFence?: boolean }): CandidateRecord {
    return this.s.tx(() => {
      if (!this.getRequest(rec.requestId)) throw new FeatureError("NOT_FOUND", `no such request ${rec.requestId}`);
      // A candidate's tree never changes after it is created (its binding is immutable), so the check names the paths of a NEW record;
      // later writes on the same record (status, exports, publication) are refused only when another request now holds a live lease.
      const paths = [...new Set([...Object.keys(rec.contents ?? {}), ...Object.keys(rec.entries ?? {})])];
      const isNew = !this.db.prepare("select 1 from feature_candidates where id = ?").get(rec.id);
      // Invalidating a record (STALE, SUPERSEDED) only lowers trust, so another holder's lease never blocks it.
      if (isNew || !(rec.status === "STALE" || rec.status === "SUPERSEDED")) this.assertFence(rec.requestId, paths, fence ? { leaseId: fence.leaseId, token: fence.token } : undefined, { nowMs: fence?.nowMs, requireFence: fence?.requireFence, takeoverOnly: !isNew });
      const prior = this.db.prepare("select binding_hash, request_id from feature_candidates where id = ?").get(rec.id) as { binding_hash: string; request_id: string } | undefined;
      if (prior) {
        if (prior.binding_hash !== rec.bindingHash || prior.request_id !== rec.requestId) throw new FeatureError("IDEMPOTENCY_CONFLICT", "a candidate's binding never changes; create a new candidate");
        this.db.prepare("update feature_candidates set status=?, json=? where id=?").run(rec.status, JSON.stringify(rec), rec.id);
      } else {
        this.db.prepare("insert into feature_candidates(id,request_id,ordinal,binding_hash,status,schema_version,json,created_at) values (?,?,?,?,?,?,?,?)")
          .run(rec.id, rec.requestId, rec.ordinal, rec.bindingHash, rec.status, rec.schemaVersion, JSON.stringify(rec), rec.createdAt);
      }
      if (event) this.insertEvent(event);
      return rec;
    });
  }
  getCandidate(id: Id): CandidateRecord | null { const r = this.db.prepare("select json from feature_candidates where id = ?").get(id) as { json: string } | undefined; return r ? JSON.parse(r.json) as CandidateRecord : null; }
  getCandidateByBinding(bindingHash: string): CandidateRecord | null { const r = this.db.prepare("select json from feature_candidates where binding_hash = ? order by created_at desc limit 1").get(bindingHash) as { json: string } | undefined; return r ? JSON.parse(r.json) as CandidateRecord : null; }
  listCandidates(requestId: Id): CandidateRecord[] { return (this.db.prepare("select json from feature_candidates where request_id = ? order by ordinal").all(requestId) as { json: string }[]).map((r) => JSON.parse(r.json) as CandidateRecord); }
  nextOrdinal(requestId: Id): number { return (this.db.prepare("select coalesce(max(ordinal),0)+1 n from feature_candidates where request_id = ?").get(requestId) as { n: number }).n; }

  // ------------------------------------------------------------------ decision approvals (migration 39)
  // An additive sign-off bound to the exact candidate's bindingHash, mirroring campaigns.ts's campaign_approvals:
  // approving does not require owning the request (owned() stays untouched everywhere else), and an approval
  // bound to a since-superseded candidate never counts for a later one.
  recordDecisionApproval(requestId: Id, principal: Id, bindingHash: string, explanation: string, at: string = now()): void {
    this.db.prepare(
      "insert into feature_decision_approvals(request_id, principal, binding_hash, explanation, created_at) values (?,?,?,?,?) " +
      "on conflict(request_id, principal) do update set binding_hash = excluded.binding_hash, explanation = excluded.explanation, created_at = excluded.created_at",
    ).run(requestId, principal, bindingHash, explanation, at);
  }
  decisionApprovals(requestId: Id): { principal: Id; bindingHash: string; explanation: string; createdAt: string }[] {
    return (this.db.prepare("select principal, binding_hash, explanation, created_at from feature_decision_approvals where request_id = ?").all(requestId) as { principal: Id; binding_hash: string; explanation: string; created_at: string }[])
      .map((r) => ({ principal: r.principal, bindingHash: r.binding_hash, explanation: r.explanation, createdAt: r.created_at }));
  }

  // ------------------------------------------------------------------ observed coverage (#94B)
  // The table is created on first use so this record family needs no migration number of its own yet; fold it into the migration list when the numbering is settled.
  private ensureCoverage(): void { this.db.exec("create table if not exists feature_coverage(id text primary key, request_id text not null, candidate_hash text not null, observed_at text not null, json text not null); create index if not exists feature_coverage_candidate on feature_coverage(candidate_hash, observed_at);"); }
  putObservedCoverage(rec: import("./coverage.ts").ObservedCoverage): void {
    this.ensureCoverage();
    this.db.prepare("insert into feature_coverage(id,request_id,candidate_hash,observed_at,json) values (?,?,?,?,?) on conflict(id) do nothing").run(rec.id, rec.requestId, rec.candidateHash, rec.observedAt, JSON.stringify(rec));
  }
  latestObservedCoverage(candidateHash: string): import("./coverage.ts").ObservedCoverage | null {
    this.ensureCoverage();
    const r = this.db.prepare("select json from feature_coverage where candidate_hash = ? order by observed_at desc, id desc limit 1").get(candidateHash) as { json: string } | undefined; return r ? JSON.parse(r.json) : null;
  }

  // ------------------------------------------------------------------ builder evaluations (3.U)
  putEvaluation(e: BuilderEvaluation): BuilderEvaluation {
    this.db.prepare("insert into feature_evaluations(identity_hash, suite_hash, passed, json, created_at) values (?,?,?,?,?) on conflict(identity_hash, suite_hash) do update set passed = excluded.passed, json = excluded.json, created_at = excluded.created_at")
      .run(e.modelIdentityHash, e.suiteHash, e.passed ? 1 : 0, JSON.stringify(e), now());
    return e;
  }
  getEvaluation(identityHash: string, suiteHash: string): BuilderEvaluation | null { const r = this.db.prepare("select json from feature_evaluations where identity_hash = ? and suite_hash = ?").get(identityHash, suiteHash) as { json: string } | undefined; return r ? JSON.parse(r.json) as BuilderEvaluation : null; }

  // ------------------------------------------------------------------ evidence
  putEvidence(rec: EvidenceRecord, event?: NewEvent): EvidenceRecord {
    const identity = canonHash(EvidenceIdentity, rec);
    return this.s.tx(() => {
      const cand = this.getCandidate(rec.candidateId);
      if (!cand || cand.requestId !== rec.requestId) throw new FeatureError("NOT_FOUND", `no such candidate ${rec.candidateId} for this request`);
      if (cand.bindingHash !== rec.bindingHash) throw new FeatureError("STALE_REVISION", "the evidence is bound to a different candidate than the one it names");
      const prior = this.db.prepare("select identity, json from feature_evidence where id = ?").get(rec.id) as { identity: string; json: string } | undefined;
      if (prior) { if (prior.identity !== identity) throw new FeatureError("IDEMPOTENCY_CONFLICT", `evidence ${rec.id} already exists with different content`); return JSON.parse(prior.json) as EvidenceRecord; }
      this.db.prepare("insert into feature_evidence(id,request_id,candidate_id,binding_hash,kind,run_manifest_id,schema_version,identity,json,created_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run(rec.id, rec.requestId, rec.candidateId, rec.bindingHash, rec.kind, rec.manifest.id, rec.schemaVersion, identity, JSON.stringify(rec), rec.createdAt);
      if (event) this.insertEvent(event);
      return rec;
    });
  }
  listEvidence(candidateId: Id): EvidenceRecord[] { return (this.db.prepare("select json from feature_evidence where candidate_id = ? order by created_at, id").all(candidateId) as { json: string }[]).map((r) => JSON.parse(r.json) as EvidenceRecord); }

  // ------------------------------------------------------------------ events and outbox
  appendEvent(ev: NewEvent): EventRecord {
    return this.s.tx(() => {
      if (!this.getRequest(ev.requestId)) throw new FeatureError("NOT_FOUND", `no such request ${ev.requestId}`);
      return this.insertEvent(ev);
    });
  }
  listEvents(requestId: Id, afterSequence = 0, limit = 200): EventRecord[] {
    return (this.db.prepare("select request_id, sequence, json, sync_state, sync_remote_id, sync_attempts from feature_events where request_id = ? and sequence > ? order by sequence limit ?").all(requestId, afterSequence, Math.min(limit, 1000)) as unknown as EventRow[]).map(rowToEvent);
  }
  pendingSync(limit: number): EventRecord[] {
    return (this.db.prepare("select request_id, sequence, json, sync_state, sync_remote_id, sync_attempts from feature_events where sync_state in ('PENDING','FAILED') order by at, request_id, sequence limit ?").all(limit) as unknown as EventRow[]).map(rowToEvent);
  }
  markSynced(eventId: Id, result: EventRecord["sync"]): void {
    const r = this.db.prepare("update feature_events set sync_state=?, sync_remote_id=?, sync_attempts=? where event_id=?").run(result.state, result.remoteId ?? null, result.attempts, eventId);
    if (!r.changes) throw new FeatureError("NOT_FOUND", `no such event ${eventId}`);
  }
}

interface EventRow { request_id: string; sequence: number; json: string; sync_state: string; sync_remote_id: string | null; sync_attempts: number }
function rowToEvent(r: EventRow): EventRecord {
  const base = JSON.parse(r.json) as Omit<EventRecord, "sequence" | "sync">;
  return { ...base, sequence: r.sequence, sync: { state: r.sync_state as EventRecord["sync"]["state"], remoteId: r.sync_remote_id ?? undefined, attempts: r.sync_attempts } };
}
