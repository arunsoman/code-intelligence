// SQLite persistence (C31 slice) on node:sqlite. All reads are revision-bound.
import { failpoint } from "./failpoint.ts";
import { canTransition } from "./claim-ledger.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { migrate } from "./migrations.ts";
import type { AnalysisBatch, Claim, ConceptCard, Entity, EvidenceRef, Fact, JobView, Relationship, Verdict } from "@cie/schema";

export interface RevisionRow { id: string; repoRoot: string; gitHead: string | null; createdAt: string; analyzerVersion: string; diagnostics: AnalysisBatch["diagnostics"]; fileCount: number }

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path = process.env.CIE_DB ?? ".cie/cie.db") {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      pragma journal_mode = wal;
      pragma foreign_keys = on;
      pragma busy_timeout = 8000;
      create table if not exists revisions(id text primary key, repo_root text not null, git_head text, created_at text not null, analyzer_version text not null, diagnostics text not null, file_count integer not null);
      create table if not exists entities(revision text not null, entity_id text not null, kind text not null, name text not null, file text not null, json text not null, primary key(revision, entity_id));
      create index if not exists entities_file on entities(revision, file);
      create table if not exists relationships(revision text not null, id text not null, from_id text not null, to_id text not null, kind text not null, json text not null, primary key(revision, id));
      create index if not exists rel_from on relationships(revision, from_id);
      create index if not exists rel_to on relationships(revision, to_id);
      create table if not exists facts(revision text not null, id text not null, subject text not null, predicate text not null, resolution text not null, json text not null, primary key(revision, id));
      create index if not exists facts_subject on facts(revision, subject);
      create table if not exists evidence(revision text not null, id text not null, json text not null, primary key(revision, id));
      create table if not exists workspaces(id text primary key, name text not null, version integer not null, revision text, updated_at text not null, json text not null);
      create table if not exists journal(seq integer primary key autoincrement, resource_id text not null, command_id text not null, type text not null, payload text not null, actor text not null, ts text not null);
      create table if not exists idempotency(key text primary key, payload_hash text not null, receipt text not null);
      create table if not exists concepts(revision text not null, id text not null, kind text not null, json text not null, primary key(revision, id));
      create table if not exists concept_versions(repo_root text not null, version integer not null, revision text not null, created_at text not null, provider text not null, json text not null, primary key(repo_root, version));
      create table if not exists claims(id text primary key, revision text not null, version integer not null, state text not null, claim_class text not null, json text not null);
      create table if not exists verdicts(id text primary key, claim_id text not null, actor text not null, verdict text not null, explanation text not null, ts text not null, evidence text not null);
      create index if not exists verdicts_claim on verdicts(claim_id);
      create table if not exists audit(seq integer primary key autoincrement, actor text not null, action text not null, resource text not null, ts text not null, meta text not null, prev_hash text not null, event_hash text not null);
      create table if not exists context_events(seq integer primary key autoincrement, session text not null, client_seq integer not null, kind text not null, revision text not null, file text not null, entities text not null, line_start integer, line_end integer, ts text not null);
      create index if not exists context_session on context_events(session, client_seq);
      create table if not exists exceptions(id text primary key, fingerprint text not null unique, error_class text not null, message text not null, trace text not null, source text not null, count integer not null, first_seen text not null, last_seen text not null, dismissed integer not null default 0);
      create table if not exists test_runs(repo_root text primary key, json text not null);
      create table if not exists overrides(repo_root text not null, entity_id text not null, mode text not null, updated_at text not null, primary key(repo_root, entity_id));
      create table if not exists jobs(id text primary key, idem text unique, kind text not null, state text not null, params text not null, json text not null, created_at text not null);
      create table if not exists repo_policy(repo_root text primary key, allow_hosted integer not null, updated_at text not null);
    `);
    migrate(this.db);
  }

  /** Atomic: either the whole revision is stored or none of it. */
  putBatch(b: AnalysisBatch): RevisionRow {
    const files = b.entities.filter((e) => e.kind === "file").length;
    const row: RevisionRow = { id: b.revision, repoRoot: b.repoRoot, gitHead: b.gitHead, createdAt: new Date().toISOString(), analyzerVersion: b.analyzerVersion, diagnostics: b.diagnostics, fileCount: files };
    this.tx(() => {
      const exists = this.db.prepare("select 1 from revisions where id = ?").get(b.revision);
      if (exists) return; // content-addressed revision: identical content already indexed
      this.db.prepare("insert into revisions values (?,?,?,?,?,?,?)").run(row.id, row.repoRoot, row.gitHead, row.createdAt, row.analyzerVersion, JSON.stringify(row.diagnostics), files);
      const ie = this.db.prepare("insert into entities values (?,?,?,?,?,?)");
      for (const e of b.entities) ie.run(b.revision, e.entityId, e.kind, e.name, e.file, JSON.stringify(e));
      failpoint("index.commit"); // test hook: a crash here must leave no revision at all
      const ir = this.db.prepare("insert or ignore into relationships values (?,?,?,?,?,?)");
      const ev = this.db.prepare("insert or ignore into evidence values (?,?,?)");
      for (const r of b.relationships) {
        ir.run(b.revision, r.id, r.from, r.to, r.kind, JSON.stringify(r));
        for (const e of r.evidence) ev.run(b.revision, e.id, JSON.stringify(e));
      }
      const iff = this.db.prepare("insert or ignore into facts values (?,?,?,?,?,?)");
      for (const f of b.facts) {
        iff.run(b.revision, f.id, f.subject, f.predicate, f.resolution, JSON.stringify(f));
        for (const e of f.evidence) ev.run(b.revision, e.id, JSON.stringify(e));
      }
    });
    return row;
  }

  tx<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try { const v = fn(); this.db.exec("commit"); return v; } catch (e) {
      // Some errors (disk full, I/O) make SQLite roll the transaction back itself; rolling back again would hide the real error.
      try { if (this.db.isTransaction) this.db.exec("rollback"); } catch { /* already rolled back */ }
      throw e;
    }
  }

  /** A revision of a revoked source reads as if it were not indexed (see isRevoked); `raw` is for the purge that deletes it. */
  revision(id: string, raw = false): RevisionRow | null {
    const r = this.db.prepare("select * from revisions where id = ?").get(id) as any;
    return r && (raw || !this.isRevoked(r.repo_root)) ? this.mapRev(r) : null;
  }
  hasRepo(repoRoot: string): boolean { return !!this.db.prepare("select 1 from revisions where repo_root = ? limit 1").get(repoRoot); }

  /** The revision indexed immediately before `id` for the same repository, if any. */
  previousRevision(id: string): RevisionRow | null {
    const cur = this.db.prepare("select rowid as rid, repo_root from revisions where id = ?").get(id) as any;
    if (!cur || this.isRevoked(cur.repo_root)) return null;
    const r = this.db.prepare("select * from revisions where repo_root = ? and rowid < ? order by rowid desc limit 1").get(cur.repo_root, cur.rid) as any;
    return r ? this.mapRev(r) : null;
  }
  revisionsOf(repoRoot: string): RevisionRow[] {
    if (this.isRevoked(repoRoot)) return [];
    return (this.db.prepare("select * from revisions where repo_root = ? order by rowid desc").all(repoRoot) as any[]).map((r) => this.mapRev(r));
  }

  allRevisionRoots(): { id: string; repoRoot: string }[] {
    return (this.db.prepare("select r.id as id, r.repo_root as repo_root from revisions r where r.rowid = (select max(rowid) from revisions where repo_root = r.repo_root) and r.repo_root not in (select repo_root from repo_access where revoked = 1)").all() as any[]).map((x) => ({ id: x.id, repoRoot: x.repo_root }));
  }

  latestRevision(repoRoot?: string): RevisionRow | null {
    const r = (repoRoot
      ? this.db.prepare("select * from revisions where repo_root = ? and repo_root not in (select repo_root from repo_access where revoked = 1) order by rowid desc limit 1").get(repoRoot)
      : this.db.prepare("select * from revisions where repo_root not in (select repo_root from repo_access where revoked = 1) order by rowid desc limit 1").get()) as any;
    return r ? this.mapRev(r) : null;
  }

  private mapRev(r: any): RevisionRow {
    return { id: r.id, repoRoot: r.repo_root, gitHead: r.git_head, createdAt: r.created_at, analyzerVersion: r.analyzer_version, diagnostics: JSON.parse(r.diagnostics), fileCount: r.file_count };
  }

  entities(rev: string): Entity[] {
    return (this.db.prepare("select json from entities where revision = ?").all(rev) as any[]).map((r) => JSON.parse(r.json));
  }
  entitiesById(rev: string, ids: string[]): Entity[] {
    const get = this.db.prepare("select json from entities where revision = ? and entity_id = ?");
    return ids.flatMap((id) => { const r = get.get(rev, id) as any; return r ? [JSON.parse(r.json) as Entity] : []; });
  }
  relationshipsFor(rev: string, entityId: string): Relationship[] {
    return (this.db.prepare("select json from relationships where revision = ? and (from_id = ? or to_id = ?)").all(rev, entityId, entityId) as any[]).map((r) => JSON.parse(r.json));
  }
  relationshipsAmong(rev: string, kind: string): Relationship[] {
    return (this.db.prepare("select json from relationships where revision = ? and kind = ?").all(rev, kind) as any[]).map((r) => JSON.parse(r.json));
  }
  factsFor(rev: string, subject: string): Fact[] {
    return (this.db.prepare("select json from facts where revision = ? and subject = ?").all(rev, subject) as any[]).map((r) => JSON.parse(r.json));
  }
  evidence(rev: string, id: string): EvidenceRef | null {
    const r = this.db.prepare("select json from evidence where revision = ? and id = ?").get(rev, id) as any;
    return r ? JSON.parse(r.json) : null;
  }

  // ---- facts / relationships (revision-wide reads) ----
  factsByPredicate(rev: string, predicate: string): Fact[] {
    return (this.db.prepare("select json from facts where revision = ? and predicate = ?").all(rev, predicate) as any[]).map((r) => JSON.parse(r.json));
  }
  allFacts(rev: string): Fact[] {
    return (this.db.prepare("select json from facts where revision = ?").all(rev) as any[]).map((r) => JSON.parse(r.json));
  }
  allRelationships(rev: string): Relationship[] {
    return (this.db.prepare("select json from relationships where revision = ?").all(rev) as any[]).map((r) => JSON.parse(r.json));
  }
  putEvidence(rev: string, e: EvidenceRef) {
    this.db.prepare("insert or ignore into evidence values (?,?,?)").run(rev, e.id, JSON.stringify(e));
  }

  // ---- concepts (current set per revision + immutable versions per repository) ----
  replaceConcepts(rev: string, cards: ConceptCard[], provider = "unknown"): number {
    return this.tx(() => {
      this.db.prepare("delete from concepts where revision = ?").run(rev);
      const ins = this.db.prepare("insert into concepts values (?,?,?,?)");
      for (const c of cards) ins.run(rev, c.id, c.kind, JSON.stringify(c));
      const root = (this.db.prepare("select repo_root from revisions where id = ?").get(rev) as any)?.repo_root ?? "";
      const last = Number((this.db.prepare("select max(version) as v from concept_versions where repo_root = ?").get(root) as any)?.v ?? 0);
      this.db.prepare("insert into concept_versions values (?,?,?,?,?,?)").run(root, last + 1, rev, new Date().toISOString(), provider, JSON.stringify(cards));
      return last + 1;
    });
  }
  /** Cards for a revision. By default refuted cards are excluded, so a card you rejected stops influencing ranking. */
  concepts(rev: string, opts: { includeRefuted?: boolean } = {}): ConceptCard[] {
    const cards = (this.db.prepare("select json from concepts where revision = ?").all(rev) as any[]).map((r) => JSON.parse(r.json) as ConceptCard);
    if (opts.includeRefuted) return cards;
    return cards.filter((c) => this.getClaim(c.claimId)?.state !== "REFUTED");
  }
  conceptVersions(repoRoot: string): { version: number; revision: string; createdAt: string; provider: string; cards: number }[] {
    return (this.db.prepare("select version, revision, created_at, provider, json from concept_versions where repo_root = ? order by version desc").all(repoRoot) as any[])
      .map((r) => ({ version: r.version, revision: r.revision, createdAt: r.created_at, provider: r.provider, cards: (JSON.parse(r.json) as unknown[]).length }));
  }
  conceptVersion(repoRoot: string, version: number): ConceptCard[] | null {
    const r = this.db.prepare("select json from concept_versions where repo_root = ? and version = ?").get(repoRoot, version) as any;
    return r ? JSON.parse(r.json) : null;
  }

  // ---- claims & verdicts ----
  putClaim(c: Claim, actor = "system", event = "gate") {
    const prev = this.db.prepare("select state, version from claims where id = ?").get(c.draft.id) as any;
    const from = (prev?.state ?? null) as Claim["state"] | null;
    // A re-derivation of the same claim (event "gate") never erases what a person decided: a refuted or confirmed claim keeps its verdicts and state.
    if (event === "gate" && prev && (prev.state === "REFUTED" || prev.state === "CONFIRMED" || prev.state === "RETIRED") && c.verdicts.length === 0) return;
    if (!canTransition(from, c.state)) throw new Error(`illegal claim transition ${from} -> ${c.state} for ${c.draft.id}`);
    this.db.prepare("insert into claims values (?,?,?,?,?,?) on conflict(id) do update set version=excluded.version, state=excluded.state, json=excluded.json")
      .run(c.draft.id, c.draft.revision, c.version, c.state, c.draft.claimClass, JSON.stringify(c));
    if (!prev || prev.state !== c.state || prev.version !== c.version) {
      const seq = Number((this.db.prepare("select coalesce(max(seq),0)+1 as n from claim_events where claim_id = ?").get(c.draft.id) as any).n);
      this.db.prepare("insert into claim_events values (?,?,?,?,?,?,?,?,?,?)").run(c.draft.id, seq, event, from, c.state, c.displayMode, c.version, actor, new Date().toISOString(), JSON.stringify({ gates: c.gates.map((g) => `${g.gate}:${g.status}`) }));
    }
  }
  getClaim(id: string): Claim | null {
    const r = this.db.prepare("select json from claims where id = ?").get(id) as any;
    return r ? JSON.parse(r.json) : null;
  }
  getClaims(ids: string[]): Claim[] {
    return ids.flatMap((id) => { const c = this.getClaim(id); return c ? [c] : []; });
  }
  dependents(claimId: string): Claim[] {
    return (this.db.prepare("select json from claims where json like ?").all(`%${claimId}%`) as any[])
      .map((r) => JSON.parse(r.json) as Claim)
      .filter((c) => c.draft.id !== claimId && (c.draft.dependencyIds ?? []).includes(claimId));
  }
  addVerdict(v: Verdict) {
    this.db.prepare("insert into verdicts values (?,?,?,?,?,?,?)").run(v.id, v.claimId, v.actorId, v.verdict, v.explanation, v.timestamp, JSON.stringify(v.evidenceIds));
  }
  /** Labelled outcomes per claim class: input for calibration. CONFIRM/REFUTE only; DISPUTE is not a label. */
  verdictCounts(claimClass: string): { confirmed: number; refuted: number } {
    const rows = this.db.prepare("select v.verdict as verdict, count(*) as n from verdicts v join claims c on c.id = v.claim_id where c.claim_class = ? and v.verdict in ('CONFIRM','REFUTE') group by v.verdict").all(claimClass) as any[];
    const n = (k: string) => Number(rows.find((r) => r.verdict === k)?.n ?? 0);
    return { confirmed: n("CONFIRM"), refuted: n("REFUTE") };
  }

  // ---- audit (hash-chained, local) ----
  audit(actor: string, action: string, resource: string, meta: Record<string, unknown> = {}) {
    const last = this.db.prepare("select event_hash from audit order by seq desc limit 1").get() as any;
    const prev = last?.event_hash ?? "genesis";
    const ts = new Date().toISOString();
    const metaJson = JSON.stringify(meta);
    const hash = createHash("sha256").update([prev, actor, action, resource, ts, metaJson].join("|")).digest("hex");
    this.db.prepare("insert into audit(actor,action,resource,ts,meta,prev_hash,event_hash) values (?,?,?,?,?,?,?)").run(actor, action, resource, ts, metaJson, prev, hash);
  }
  auditEvents(limit = 100) {
    return this.db.prepare("select seq, actor, action, resource, ts, meta from audit order by seq desc limit ?").all(limit) as any[];
  }
  /**
   * Deleting a source must not leave its name in the log. An authorized deletion replaces the name in the events that carry it
   * and re-links the chain from the first changed event, so the chain still verifies; the redaction is itself recorded
   * (how many events, never what). This is the one rewrite the log allows, and it exists only for deletion.
   */
  redactAudit(needles: string[], replacement = "(deleted source)"): number {
    const ns = needles.filter((n) => n && n.length >= 6);
    if (!ns.length) return 0;
    const scrub = (v: string) => ns.reduce((x, n) => x.split(n).join(replacement), v);
    return this.tx(() => {
      const rows = this.db.prepare("select * from audit order by seq").all() as any[];
      let changed = 0, prev = "genesis", rewriting = false;
      for (const r of rows) {
        const actor = scrub(r.actor), resource = scrub(r.resource), meta = scrub(r.meta);
        const edited = actor !== r.actor || resource !== r.resource || meta !== r.meta;
        if (edited) { changed++; rewriting = true; }
        if (rewriting) {
          const h = createHash("sha256").update([prev, actor, r.action, resource, r.ts, meta].join("|")).digest("hex");
          this.db.prepare("update audit set actor = ?, resource = ?, meta = ?, prev_hash = ?, event_hash = ? where seq = ?").run(actor, resource, meta, prev, h, r.seq);
          prev = h;
        } else prev = r.event_hash;
      }
      return changed;
    });
  }

  verifyAuditChain(): { ok: boolean; brokenAt?: number } {
    let prev = "genesis";
    for (const r of this.db.prepare("select * from audit order by seq").all() as any[]) {
      const h = createHash("sha256").update([prev, r.actor, r.action, r.resource, r.ts, r.meta].join("|")).digest("hex");
      if (r.prev_hash !== prev || r.event_hash !== h) return { ok: false, brokenAt: r.seq };
      prev = r.event_hash;
    }
    return { ok: true };
  }

  // ---- egress policy ----
  allowHosted(repoRoot: string): boolean {
    const r = this.db.prepare("select allow_hosted from repo_policy where repo_root = ?").get(repoRoot) as any;
    return !!r?.allow_hosted;
  }
  setAllowHosted(repoRoot: string, allow: boolean) {
    this.db.prepare("insert into repo_policy values (?,?,?) on conflict(repo_root) do update set allow_hosted=excluded.allow_hosted, updated_at=excluded.updated_at")
      .run(repoRoot, allow ? 1 : 0, new Date().toISOString());
  }

  // ---- editor context (privacy-minimized: paths, line numbers and resolved entity ids only; never file text) ----
  lastClientSeq(session: string): number {
    return Number((this.db.prepare("select max(client_seq) as m from context_events where session = ?").get(session) as any)?.m ?? -1);
  }
  addContextEvent(e: { session: string; clientSeq: number; kind: string; revision: string; file: string; entities: string[]; lineStart: number | null; lineEnd: number | null }) {
    this.db.prepare("insert into context_events(session,client_seq,kind,revision,file,entities,line_start,line_end,ts) values (?,?,?,?,?,?,?,?,?)")
      .run(e.session, e.clientSeq, e.kind, e.revision, e.file, JSON.stringify(e.entities), e.lineStart, e.lineEnd, new Date().toISOString());
    // Short retention: keep the most recent events per session only.
    this.db.prepare("delete from context_events where session = ? and seq not in (select seq from context_events where session = ? order by seq desc limit 200)").run(e.session, e.session);
  }
  recentContext(limit = 20) {
    return (this.db.prepare("select seq, session, kind, revision, file, entities, line_start, line_end, ts from context_events order by seq desc limit ?").all(limit) as any[])
      .map((r) => ({ seq: r.seq, session: r.session, kind: r.kind, revision: r.revision, file: r.file, entities: JSON.parse(r.entities) as string[], lineStart: r.line_start, lineEnd: r.line_end, ts: r.ts }));
  }

  // ---- exception inbox (runtime observations reported by a running app, or pasted) ----
  addException(e: { id: string; fingerprint: string; errorClass: string; message: string; trace: string; source: string }): { id: string; count: number; isNew: boolean } {
    const now = new Date().toISOString();
    const hit = this.db.prepare("select id, count from exceptions where fingerprint = ?").get(e.fingerprint) as any;
    if (hit) {
      this.db.prepare("update exceptions set count = count + 1, last_seen = ?, dismissed = 0, trace = ? where id = ?").run(now, e.trace, hit.id);
      return { id: hit.id, count: hit.count + 1, isNew: false };
    }
    this.db.prepare("insert into exceptions(id,fingerprint,error_class,message,trace,source,count,first_seen,last_seen) values (?,?,?,?,?,?,?,?,?)").run(e.id, e.fingerprint, e.errorClass, e.message, e.trace, e.source, 1, now, now);
    // Bounded inbox: oldest dismissed entries go first, then oldest overall.
    this.db.prepare("delete from exceptions where id in (select id from exceptions order by dismissed desc, last_seen asc limit max(0, (select count(*) from exceptions) - 200))").run();
    return { id: e.id, count: 1, isNew: true };
  }
  exceptions(includeDismissed = false) {
    return (this.db.prepare(`select * from exceptions ${includeDismissed ? "" : "where dismissed = 0"} order by last_seen desc limit 100`).all() as any[])
      .map((r) => ({ id: r.id as string, errorClass: r.error_class as string, message: r.message as string, trace: r.trace as string, source: r.source as string, count: r.count as number, firstSeen: r.first_seen as string, lastSeen: r.last_seen as string, dismissed: !!r.dismissed }));
  }
  dismissException(id: string) { return this.db.prepare("update exceptions set dismissed = 1 where id = ?").run(id).changes > 0; }

  // ---- manual salience overrides (repo-level, survive re-indexing because ids are stable) ----
  setOverride(repoRoot: string, entityId: string, mode: "pin" | "boost" | "demote" | null) {
    if (mode === null) this.db.prepare("delete from overrides where repo_root = ? and entity_id = ?").run(repoRoot, entityId);
    else this.db.prepare("insert into overrides values (?,?,?,?) on conflict(repo_root, entity_id) do update set mode=excluded.mode, updated_at=excluded.updated_at").run(repoRoot, entityId, mode, new Date().toISOString());
  }
  overrides(repoRoot: string): Map<string, "pin" | "boost" | "demote"> {
    return new Map((this.db.prepare("select entity_id, mode from overrides where repo_root = ?").all(repoRoot) as any[]).map((r) => [r.entity_id, r.mode]));
  }

  // ---- extra facts for a revision (test artifacts); replaced wholesale per source ----
  replaceFactsBySource(rev: string, idPrefix: string, facts: Fact[]) {
    this.tx(() => {
      this.db.prepare("delete from facts where revision = ? and id like ?").run(rev, `${idPrefix}%`);
      const ins = this.db.prepare("insert or replace into facts values (?,?,?,?,?,?)");
      for (const f of facts) {
        ins.run(rev, f.id, f.subject, f.predicate, f.resolution, JSON.stringify(f));
        for (const e of f.evidence) this.putEvidence(rev, e);
      }
    });
  }

  // ---- jobs (C07) ----
  putJob(job: JobView, idem: string | null) {
    this.db.prepare("insert into jobs(id, idem, kind, state, params, json, created_at) values (?,?,?,?,?,?,?)").run(job.id, idem, job.kind, job.state, JSON.stringify(job.params), JSON.stringify(job), job.createdAt);
  }
  saveJob(job: JobView) {
    this.db.prepare("update jobs set state = ?, json = ? where id = ?").run(job.state, JSON.stringify(job), job.id);
  }
  job(id: string): JobView | null {
    const r = this.db.prepare("select json from jobs where id = ?").get(id) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : null;
  }
  jobByIdempotencyKey(idem: string): JobView | null {
    const r = this.db.prepare("select json from jobs where idem = ?").get(idem) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : null;
  }
  /** Newest first. Finished jobs are kept for a short history only. */
  jobs(limit = 20): JobView[] {
    return (this.db.prepare("select json from jobs order by created_at desc, rowid desc limit ?").all(limit) as { json: string }[]).map((r) => JSON.parse(r.json));
  }
  /** Jobs still marked QUEUED or RUNNING when no runner exists belonged to a process that is gone; they cannot resume. */
  activeJobs(): JobView[] {
    return (this.db.prepare("select json from jobs where state in ('QUEUED','RUNNING') order by created_at, rowid").all() as { json: string }[]).map((r) => JSON.parse(r.json));
  }
  pruneJobs(keep = 50) {
    this.db.prepare("delete from jobs where state not in ('QUEUED','RUNNING') and id not in (select id from jobs order by created_at desc, rowid desc limit ?)").run(keep);
  }

  // ---- access (C03 slice): denied paths and revoked sources ----
  denyPath(repoRoot: string, prefix: string, deny = true) {
    const p = prefix.replace(/^\.?\//, "").replace(/\/+$/, "");
    if (deny) this.db.prepare("insert or ignore into access_deny values (?,?)").run(repoRoot, p);
    else this.db.prepare("delete from access_deny where repo_root = ? and prefix = ?").run(repoRoot, p);
  }
  deniedPrefixes(repoRoot: string): string[] { return (this.db.prepare("select prefix from access_deny where repo_root = ? order by prefix").all(repoRoot) as { prefix: string }[]).map((r) => r.prefix); }
  /** A revoked source is treated as if it were not indexed: nothing derived from it can be read, even before it is purged. */
  isRevoked(repoRoot: string): boolean { const r = this.db.prepare("select revoked from repo_access where repo_root = ?").get(repoRoot) as { revoked: number } | undefined; return !!r?.revoked; }
  setRevoked(repoRoot: string, revoked: boolean) {
    this.db.prepare("insert into repo_access(repo_root, revoked, revoked_at) values (?,?,?) on conflict(repo_root) do update set revoked = excluded.revoked, revoked_at = excluded.revoked_at").run(repoRoot, revoked ? 1 : 0, revoked ? new Date().toISOString() : null);
  }

  // ---- embeddings (C10): one vector per entity, per revision, kept beside the data it describes ----
  putEmbeddings(rev: string, rows: { entityId: string; vec: Float32Array }[]) {
    this.tx(() => {
      const st = this.db.prepare("insert or replace into embeddings values (?,?,?,?)");
      for (const r of rows) st.run(rev, r.entityId, r.vec.length, new Uint8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength));
    });
  }
  embeddings(rev: string): { entityId: string; vec: Float32Array }[] {
    return (this.db.prepare("select entity_id, dim, vec from embeddings where revision = ?").all(rev) as { entity_id: string; dim: number; vec: Uint8Array }[])
      .map((r) => ({ entityId: r.entity_id, vec: new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)) }));
  }
  hasEmbeddings(rev: string): boolean { return Number((this.db.prepare("select count(*) n from embeddings where revision = ?").get(rev) as { n: number }).n) > 0; }
}
