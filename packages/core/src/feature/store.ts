// Task 1.B — the FeatureStore over the five record families (migration 33). Rules:
//   * Every write that changes a request's state also appends its milestone event IN THE SAME TRANSACTION (the outbox), so a
//     crash can never leave a state change without its event or an event without its state.
//   * Mutable pointers (the request record) move by compare-and-swap on `version`; a stale writer gets VERSION_CONFLICT.
//   * Decisions and evidence are immutable: re-putting the same id with the same identity is a no-op, with a different one is refused.
//   * Event sequences are dense per request, starting at 1.
import { asSet, canonHash, defineSchema, type Canon } from "./canon.ts";
import { FeatureError } from "./errors.ts";
import type { CandidateRecord, DecisionRecord, EventRecord, EvidenceRecord, FeatureRecord, FeatureStore, Id } from "./types.ts";
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
      this.db.prepare("insert into feature_records(request_id,repository_id,state,version,contract_version,schema_version,json,idempotency_key,created_by,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(stored.requestId, stored.repositoryId, stored.state, 0, stored.contractVersion, stored.schemaVersion, JSON.stringify(stored), idempotencyKey, stored.createdBy, stored.createdAt, stored.updatedAt);
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
      this.db.prepare("update feature_records set state=?, version=?, contract_version=?, json=?, updated_at=? where request_id=? and version=?")
        .run(stored.state, stored.version, stored.contractVersion, JSON.stringify(stored), stored.updatedAt, requestId, expectedVersion);
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
  putCandidate(rec: CandidateRecord, event?: NewEvent): CandidateRecord {
    return this.s.tx(() => {
      if (!this.getRequest(rec.requestId)) throw new FeatureError("NOT_FOUND", `no such request ${rec.requestId}`);
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
