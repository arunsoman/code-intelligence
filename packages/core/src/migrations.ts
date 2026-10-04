// C31/C32: ordered, transactional schema migrations. Each migration runs in one transaction, so a failure leaves the
// database exactly as it was, at the version it was; it is never half-migrated. `down` makes a step reversible.
import type { DatabaseSync } from "node:sqlite";

export interface Migration { version: number; name: string; up: (db: DatabaseSync) => void; down?: (db: DatabaseSync) => void }
export class MigrationError extends Error {
  readonly version: number;
  constructor(version: number, name: string, cause: unknown) { super(`migration ${version} (${name}) failed: ${(cause as Error).message}`); this.version = version; }
}

export const MIGRATIONS: Migration[] = [
  {
    version: 5, name: "defect-workflow",
    up: (db) => db.exec(`
      create table defect_records(id text primary key, revision text not null references revisions(id) on delete cascade, kind text not null, version integer not null, json text not null);
      create index defect_records_revision on defect_records(revision, kind);
      create table defect_commands(key text primary key, revision text not null references revisions(id) on delete cascade, payload_hash text not null, json text not null);
      create table defect_attempts(id text primary key, revision text not null references revisions(id) on delete cascade, spec_id text not null, generation integer not null, state text not null, lease_until integer not null, json text not null);
      create table defect_grants(id text primary key, revision text not null references revisions(id) on delete cascade, revoked integer not null default 0, json text not null);
      create table defect_outbox(sequence integer primary key autoincrement, revision text not null references revisions(id) on delete cascade, record_id text not null, version integer not null, event text not null, unique(record_id, version));
    `),
    down: (db) => db.exec("drop table defect_outbox; drop table defect_grants; drop table defect_attempts; drop table defect_commands; drop table defect_records;"),
  },
  { version: 1, name: "baseline", up: () => { /* the original tables are created by the store itself */ } },
  {
    version: 2, name: "outbox",
    up: (db) => db.exec(`
      create table if not exists outbox(seq integer primary key autoincrement, event_id text not null unique, topic text not null, payload text not null, created_at text not null, delivered_at text, attempts integer not null default 0);
      create table if not exists subscriber_progress(subscriber text not null, event_id text not null, done_at text not null, primary key(subscriber, event_id));`),
    down: (db) => db.exec("drop table if exists subscriber_progress; drop table if exists outbox;"),
  },
  {
    version: 4, name: "access-and-embeddings",
    up: (db) => db.exec(`
      create table if not exists access_deny(repo_root text not null, prefix text not null, primary key(repo_root, prefix));
      create table if not exists repo_access(repo_root text primary key, revoked integer not null default 0, revoked_at text);
      create table if not exists embeddings(revision text not null, entity_id text not null, dim integer not null, vec blob not null, primary key(revision, entity_id));`),
    down: (db) => db.exec("drop table if exists embeddings; drop table if exists repo_access; drop table if exists access_deny;"),
  },
  {
    version: 6, name: "change-proposals",
    up: (db) => db.exec("create table if not exists change_proposals(id text primary key, revision text not null, status text not null, version integer not null, json text not null);"),
    down: (db) => db.exec("drop table if exists change_proposals;"),
  },
  {
    version: 7, name: "exports-and-webhooks",
    up: (db) => db.exec(`
      create table if not exists exports(id text primary key, revision text not null, created_by text not null, created_at text not null, json text not null);
      create table if not exists webhook_subs(id text primary key, json text not null);
      create table if not exists webhook_deliveries(delivery_id text primary key, sub_id text not null, event_id text not null, type text not null, state text not null, attempts integer not null, next_at integer not null, last_error text, delivered_at text, claimed_until integer not null, revision text, payload text not null);
      create index if not exists webhook_due on webhook_deliveries(state, next_at);`),
    down: (db) => db.exec("drop index if exists webhook_due; drop table if exists webhook_deliveries; drop table if exists webhook_subs; drop table if exists exports;"),
  },
  {
    version: 8, name: "claim-ledger-and-roles",
    up: (db) => db.exec(`
      create table if not exists claim_events(claim_id text not null, seq integer not null, event text not null, from_state text, to_state text not null, display_mode text not null, version integer not null, actor text not null, at text not null, detail text not null, primary key(claim_id, seq));
      create table if not exists roles(principal text not null, role text not null, granted_at text not null, primary key(principal, role));`),
    down: (db) => db.exec("drop table if exists roles; drop table if exists claim_events;"),
  },
  {
    version: 9, name: "developer-context",
    up: (db) => db.exec(`
      create table if not exists ctx_events(session text not null, seq integer not null, kind text not null, tier text not null, payload text, digest text not null, at text not null, primary key(session, seq));
      create table if not exists context_policy(id integer primary key check (id = 1), version integer not null, json text not null);`),
    down: (db) => db.exec("drop table if exists context_policy; drop table if exists ctx_events;"),
  },
  {
    version: 10, name: "annotations",
    up: (db) => db.exec(`create table if not exists annotations(id text primary key, repo_root text not null, entity_id text not null, note text not null, scope text not null, author text not null, at text not null);
      create index if not exists annotations_entity on annotations(repo_root, entity_id);`),
    down: (db) => db.exec("drop table if exists annotations;"),
  },
  {
    version: 11, name: "workspace-log",
    up: (db) => db.exec(`
      create table if not exists ws_events(ws text not null, seq integer not null, kind text not null, key text not null, json text not null, actor text not null, at text not null, primary key(ws, seq));
      create table if not exists ws_checkpoints(ws text not null, seq integer not null, json text not null, at text not null, primary key(ws, seq));
      create table if not exists ws_meta(ws text primary key, name text not null, revision text, created_at text not null);`),
    down: (db) => db.exec("drop table if exists ws_meta; drop table if exists ws_checkpoints; drop table if exists ws_events;"),
  },
  {
    version: 12, name: "canonical-registry",
    up: (db) => db.exec(`
      create table if not exists canon_nodes(revision text not null, entity_id text not null, canon_id text not null, body_digest text, shape text not null, primary key(revision, entity_id));
      create index if not exists canon_nodes_canon on canon_nodes(canon_id);
      create table if not exists canon_lineage(revision text primary key, parent text, branch text not null, registered_at text not null);
      create table if not exists canon_proposals(id text primary key, kind text not null, state text not null, version integer not null, from_revision text not null, to_revision text not null, old_ids text not null, new_ids text not null, canon_before text not null, evidence text not null, strength text not null, created_at text not null);
      create table if not exists canon_history(seq integer primary key autoincrement, proposal_id text, canon_id text not null, event text not null, detail text not null, actor text not null, at text not null);`),
    down: (db) => db.exec("drop table if exists canon_history; drop table if exists canon_proposals; drop table if exists canon_lineage; drop table if exists canon_nodes;"),
  },
  {
    version: 13, name: "review-threads",
    up: (db) => db.exec(`
      create table if not exists review_threads(id text primary key, repo_root text not null, canon_id text not null, revision text not null, entity_id text, file text not null, line integer, text text not null, author text not null, state text not null, created_at text not null);
      create table if not exists review_thread_history(seq integer primary key autoincrement, thread_id text not null, event text not null, detail text not null, at text not null);`),
    down: (db) => db.exec("drop table if exists review_thread_history; drop table if exists review_threads;"),
  },
  {
    version: 14, name: "runtime-ingestion",
    up: (db) => db.exec(`
      create table if not exists rt_envelopes(id text primary key, source text not null, deployment text, revision text, win_from integer not null, win_to integer not null, handle text not null, kind text not null, quality text not null, digest text not null, received_at integer not null, span_count integer not null, rejected integer not null default 0);
      create table if not exists rt_spans(envelope text not null, seq integer not null, trace_id text not null, span_id text not null, parent_id text, name text not null, start_ms integer not null, end_ms integer not null, error integer not null, file text, line integer, fn text, flags text not null, primary key(envelope, seq));
      create index if not exists rt_spans_trace on rt_spans(trace_id);
      create table if not exists rt_markers(source text not null, deployment text not null, revision text not null, at integer not null, primary key(source, deployment));`),
    down: (db) => db.exec("drop table if exists rt_markers; drop table if exists rt_spans; drop table if exists rt_envelopes;"),
  },
  {
    version: 15, name: "security-findings",
    up: (db) => db.exec(`create table if not exists sec_findings(id text primary key, revision text not null, rule_id text not null, rule_version integer not null, rule_digest text not null, state text not null, superseded integer not null default 0, json text not null, created_at text not null);
      create index if not exists sec_findings_rev on sec_findings(revision);`),
    down: (db) => db.exec("drop table if exists sec_findings;"),
  },
  {
    version: 16, name: "collaboration",
    up: (db) => db.exec(`
      create table if not exists collab_principals(principal text primary key, tenant text not null);
      create table if not exists collab_access(principal text not null, repo_root text not null, allowed integer not null, denied text not null, primary key(principal, repo_root));
      create table if not exists collab_shares(ws text not null, principal text not null, role text not null, granted_by text not null, at text not null, active integer not null default 1, primary key(ws, principal));
      create table if not exists collab_ops(seq integer primary key autoincrement, ws text not null, kind text not null, actor text not null, detail text not null, at text not null);`),
    down: (db) => db.exec("drop table if exists collab_ops; drop table if exists collab_shares; drop table if exists collab_access; drop table if exists collab_principals;"),
  },
  {
    version: 17, name: "index-generation",
    up: (db) => db.exec(`create table if not exists index_generation(repo_root text primary key, generation integer not null);`),
    down: (db) => db.exec("drop table if exists index_generation;"),
  },
  {
    version: 18, name: "external-sources",
    up: (db) => db.exec(`
      create table if not exists ext_sources(id text primary key, kind text not null, repo_root text, state text not null, cred_expires_at integer, cursor text, last_ok integer, last_error text, rate_resume_at integer, updated_at integer not null);
      create table if not exists ext_items(source text not null, kind text not null, external_id text not null, updated_at text, json text not null, ingested_at integer not null, primary key(source, kind, external_id));
      create table if not exists ext_quarantine(id integer primary key autoincrement, source text not null, kind text not null, reason text not null, raw text not null, at integer not null);
      create table if not exists ext_deliveries(source text not null, delivery_id text not null, at integer not null, applied integer not null, primary key(source, delivery_id));`),
    down: (db) => db.exec("drop table if exists ext_deliveries; drop table if exists ext_quarantine; drop table if exists ext_items; drop table if exists ext_sources;"),
  },
  {
    version: 19, name: "evaluation-registry",
    up: (db) => db.exec(`
      create table if not exists eval_runs(id text primary key, suite text not null, suite_version integer not null, model text not null, code_version text not null, metrics text not null, items text not null, synthetic integer not null, at text not null);
      create table if not exists eval_labels(id text primary key, subject text not null, claim_class text not null, predicted_confidence real, outcome integer not null, labeler text not null, synthetic integer not null, held_out integer not null, at text not null);
      create table if not exists eval_studies(id text primary key, name text not null, protocol text not null, json text not null, at text not null);`),
    down: (db) => db.exec("drop table if exists eval_studies; drop table if exists eval_labels; drop table if exists eval_runs;"),
  },
  {
    version: 3, name: "c22-investigations",
    up: (db) => db.exec(`
      create table if not exists c22_investigations(id text primary key, workspace_id text not null, state text not null, version integer not null, generation integer not null, event_seq integer not null, deleted integer not null default 0, json text not null);
      create table if not exists c22_hypotheses(id text not null, version integer not null, investigation_id text not null, claim_id text not null, json text not null, primary key(id, version));
      create table if not exists c22_observations(id text primary key, investigation_id text not null, source_event_id text not null, group_id text not null, json text not null, unique(investigation_id, source_event_id));
      create table if not exists c22_assessments(id text primary key, hypothesis_id text not null, hypothesis_version integer not null, observation_id text not null, json text not null);
      create table if not exists c22_checks(id text primary key, investigation_id text not null, json text not null);
      create table if not exists c22_steps(id text primary key, investigation_id text not null, state text not null, json text not null);
      create table if not exists c22_attempts(id text primary key, step_id text not null, attempt_number integer not null, dispatch_id text not null, state text not null, json text not null);
      create index if not exists c22_attempts_dispatch on c22_attempts(dispatch_id);
      create table if not exists c22_events(investigation_id text not null, sequence integer not null, json text not null, primary key(investigation_id, sequence));
      create table if not exists c22_checkpoints(investigation_id text not null, version integer not null, hash text not null, json text not null, primary key(investigation_id, version));
      create table if not exists c22_experiments(id text primary key, investigation_id text not null, json text not null);
      create table if not exists c22_payloads(handle text primary key, investigation_id text not null, json text not null);
      create table if not exists c22_authority(investigation_id text primary key, epoch integer not null, revoked integer not null default 0);
      create table if not exists c22_grants(id text primary key, scope text not null, created_at text not null);`),
    down: (db) => db.exec("drop table if exists c22_grants; drop table if exists c22_authority; drop table if exists c22_payloads; drop table if exists c22_experiments; drop table if exists c22_checkpoints; drop table if exists c22_events; drop index if exists c22_attempts_dispatch; drop table if exists c22_attempts; drop table if exists c22_steps; drop table if exists c22_checks; drop table if exists c22_assessments; drop table if exists c22_observations; drop table if exists c22_hypotheses; drop table if exists c22_investigations;"),
  },
];

export function currentVersion(db: DatabaseSync): number {
  db.exec("create table if not exists schema_version(version integer not null, name text not null, applied_at text not null)");
  return (db.prepare("select coalesce(max(version), 0) v from schema_version").get() as { v: number }).v;
}

const inTx = (db: DatabaseSync, fn: () => void) => { db.exec("begin immediate"); try { fn(); db.exec("commit"); } catch (e) { try { if (db.isTransaction) db.exec("rollback"); } catch { /* already rolled back */ } throw e; } };

/** Apply every pending migration up to `target` (default: all). Returns the versions applied. Stops at the first failure. */
export function migrate(db: DatabaseSync, migrations: Migration[] = MIGRATIONS, target = Infinity): number[] {
  const applied: number[] = [];
  let v = currentVersion(db);
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= v || m.version > target) continue;
    try {
      inTx(db, () => { m.up(db); db.prepare("insert into schema_version values (?,?,?)").run(m.version, m.name, new Date().toISOString()); });
    } catch (e) { throw new MigrationError(m.version, m.name, e); }
    applied.push(m.version); v = m.version;
  }
  return applied;
}

/** Step back to `target`, newest first. A migration with no `down` stops the rollback (never silently skipped). */
export function rollback(db: DatabaseSync, target: number, migrations: Migration[] = MIGRATIONS): number[] {
  const undone: number[] = [];
  for (const m of [...migrations].sort((a, b) => b.version - a.version)) {
    if (m.version <= target || m.version > currentVersion(db)) continue;
    if (!m.down) throw new MigrationError(m.version, m.name, new Error("no down step; it cannot be rolled back"));
    try { inTx(db, () => { m.down!(db); db.prepare("delete from schema_version where version = ?").run(m.version); }); } catch (e) { throw new MigrationError(m.version, m.name, e); }
    undone.push(m.version);
  }
  return undone;
}
