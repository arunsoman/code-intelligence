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
    version: 20, name: "c24-causality",
    up: (db) => db.exec(`
      create table if not exists c24_runtime_sources(id text primary key, version integer not null, trust text not null, schema_digest text not null, watermark json, revoked integer not null default 0, json text not null);
      create table if not exists c24_event_refs(id text primary key, version integer not null, tenant text not null, source text not null, source_epoch text not null, dedup_hash text not null, kind text not null, clock_domain text not null, clock_epoch text not null, trace_id text, operation_id text, attempt_id text, at_ms integer, json text not null, unique(source, source_epoch, dedup_hash));
      create index if not exists c24_event_refs_trace on c24_event_refs(trace_id);
      create table if not exists c24_edge_versions(id text not null, version integer not null, snapshot_id text not null, from_event text not null, to_event text not null, kind text not null, layer text not null, state text not null, json text not null, primary key(id, version));
      create index if not exists c24_edge_versions_ends on c24_edge_versions(from_event, to_event);
      create table if not exists c24_attribution(event_id text not null, version integer not null, revision text not null, exact integer not null, json text not null, primary key(event_id, version));
      create table if not exists c24_coverage(id text primary key, source text not null, source_epoch text not null, win_from integer not null, win_to integer not null, predicate_schema text not null, query_hash text not null, exhaustive integer not null, json text not null);
      create table if not exists c24_snapshots(id text primary key, version integer not null, generation integer not null, scope_hash text not null, event_seq integer not null, json text not null);
      create table if not exists c24_derivations(source_key text not null, derived text not null, derived_version integer not null, kind text not null, json text not null, primary key(source_key, derived, derived_version));
      create table if not exists c24_updates(snapshot_id text not null, seq integer not null, event text not null, json text not null, primary key(snapshot_id, seq));`),
    down: (db) => db.exec("drop table if exists c24_updates; drop table if exists c24_derivations; drop table if exists c24_snapshots; drop table if exists c24_coverage; drop table if exists c24_attribution; drop table if exists c24_edge_versions; drop table if exists c24_event_refs; drop table if exists c24_runtime_sources;"),
  },
  {
    version: 21, name: "c24-causality-phase1",
    up: (db) => db.exec(`
      create table if not exists c24_wait_relations(id text primary key, snapshot_id text not null, task text not null, resource text not null, json text not null);
      create table if not exists c24_relation_certs(id text primary key, adapter text not null, kind text not null, json text not null);
      create table if not exists c24_artifacts(id text primary key, version integer not null, revision text not null, json text not null);
      create table if not exists c24_experiment_reports(id text primary key, version integer not null, json text not null);`),
    down: (db) => db.exec("drop table if exists c24_experiment_reports; drop table if exists c24_artifacts; drop table if exists c24_relation_certs; drop table if exists c24_wait_relations;"),
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
  {
    version: 22, name: "incremental-index",
    up: (db) => db.exec(`
      alter table relationships add column file text;
      alter table facts add column file text;

      create index if not exists rel_file on relationships(revision, file);
      create index if not exists facts_file on facts(revision, file);
      create table if not exists rev_files(revision text not null, file text not null, digest text not null, primary key(revision, file));`),
    down: (db) => db.exec("drop table if exists rev_files; drop index if exists facts_file; drop index if exists rel_file; alter table facts drop column file; alter table relationships drop column file;"),
  },
  {
    version: 23, name: "incremental-index-evidence-ids",
    // The ids of the evidence each row embeds, so a revision built from a previous one can rebuild its evidence table without parsing every row.
    up: (db) => db.exec(`
      alter table relationships add column ev text;
      alter table facts add column ev text;
      delete from rev_files;`),
    down: (db) => db.exec("alter table facts drop column ev; alter table relationships drop column ev;"),
  },
  {
    // F01: cross-repository search and navigation. Repository registry, per-revision build state, content-addressed blobs
    // with a per-blob trigram text index (unchanged files cost nothing on re-index), symbol definitions and references with
    // a resolution *basis* (the tier is derived at query time), package identity shared with the F04 inventory, and derived
    // cross-repository edges. Each table is its own migration in practice; this slice ships as one orderable step.
    version: 24, name: "cross-repo-search",
    up: (db) => db.exec(`
      create table repositories(
        repository_id text primary key,
        display_name text not null,
        root text,
        remote_url text,
        default_branch text,
        authz_scope_id text not null,
        state text not null,
        added_at text not null);
      create table repo_revision_state(
        repository_id text not null, revision text not null,
        commit_hash text, content_root_hash text not null,
        index_generation integer not null, analyzer_version text not null,
        text_state text not null, symbol_state text not null, semantic_tier text not null,
        files_total integer not null, files_indexed integer not null,
        skipped_json text not null, indexed_at text not null,
        primary key(repository_id, revision));
      create table blobs(
        blob_hash text primary key, size integer not null,
        language text, is_binary integer not null, is_generated integer not null,
        skip_reason text);
      create table blob_data(blob_hash text primary key, body blob not null);
      create table tree_entries(
        repository_id text not null, revision text not null,
        path text not null, blob_hash text not null,
        primary key(repository_id, revision, path));
      create index tree_entries_blob on tree_entries(blob_hash);
      create virtual table blob_text using fts5(body, tokenize='trigram');
      create table blob_text_map(blob_hash text primary key, rowid integer unique);
      create table symbol_defs(
        repository_id text not null, revision text not null, symbol_id text not null,
        canonical_id text, name text not null, qualified text not null, kind text not null,
        path text not null, start_byte integer not null, end_byte integer not null,
        exported integer not null, basis text not null,
        primary key(repository_id, revision, symbol_id));
      create index symbol_defs_name on symbol_defs(repository_id, revision, name);
      create table symbol_refs(
        repository_id text not null, revision text not null, ref_id text not null,
        target_symbol text, target_name text not null,
        path text not null, start_byte integer not null, end_byte integer not null,
        ref_kind text not null, resolution text not null, basis text not null,
        candidates_json text,
        primary key(repository_id, revision, ref_id));
      create index symbol_refs_target on symbol_refs(repository_id, revision, target_symbol);
      create index symbol_refs_name on symbol_refs(repository_id, revision, target_name);
      create table package_provides(
        repository_id text not null, revision text not null,
        ecosystem text not null, package_name text not null, version text,
        manifest_path text not null,
        primary key(repository_id, revision, ecosystem, package_name, manifest_path));
      create table package_requires(
        repository_id text not null, revision text not null,
        ecosystem text not null, package_name text not null, version text,
        source text not null,
        primary key(repository_id, revision, ecosystem, package_name, source));
      create table package_exports(
        repository_id text not null, revision text not null,
        ecosystem text not null, package_name text not null,
        exported_name text not null, symbol_id text not null,
        primary key(repository_id, revision, ecosystem, package_name, exported_name));
      create table cross_repo_edges(
        from_repository text not null, from_revision text not null,
        to_repository text not null, to_revision text not null,
        via_ecosystem text not null, via_package text not null,
        kind text not null, evidence_id text not null,
        ambiguous integer not null default 0, version_mismatch text,
        primary key(from_repository, from_revision, to_repository, via_package, kind));
      create table search_flags(id integer primary key check (id = 1), enabled integer not null);
      create table cursor_keys(id text primary key, key text not null);`),
    down: (db) => db.exec(`
      drop table if exists cursor_keys; drop table if exists search_flags; drop table if exists cross_repo_edges; drop table if exists package_exports;
      drop table if exists package_requires; drop table if exists package_provides;
      drop index if exists symbol_refs_name; drop index if exists symbol_refs_target; drop table if exists symbol_refs;
      drop index if exists symbol_defs_name; drop table if exists symbol_defs;
      drop table if exists blob_text_map; drop table if exists blob_text; drop index if exists tree_entries_blob;
      drop table if exists tree_entries; drop table if exists blob_data; drop table if exists blobs;
      drop table if exists repo_revision_state; drop table if exists repositories;`),
  },
  {
    // F02: PR analysis and quality gates. Analyses are content-addressed by identity (§6.1); per-condition results keep every
    // shown line linked to its policy condition; waivers carry scope and expiry; publications are idempotent per key;
    // test evidence is per *revision* (the per-repository test_runs table is untouched).
    version: 25, name: "pr-quality-gates",
    up: (db) => db.exec(`
      create table if not exists pr_analyses(
        id text primary key,
        repository_id text not null, forge text not null, pr_number integer not null,
        repo_root text not null,
        base_hash text not null, head_hash text not null, merge_base_hash text not null,
        head_repository text,
        base_revision text, head_revision text,
        policy_id text not null, policy_hash text not null, analyzer_set_hash text not null,
        state text not null,
        job_id text,
        generation integer not null default 1,
        superseded_by text,
        created_at text not null, updated_at text not null);
      create index if not exists pr_analyses_pr on pr_analyses(repository_id, forge, pr_number, created_at);
      create unique index if not exists pr_analyses_identity on pr_analyses(repository_id, pr_number, base_hash, head_hash, policy_hash, analyzer_set_hash);
      create table if not exists pr_changed_files(
        analysis_id text not null, path text not null, status text not null,
        old_path text, additions integer, deletions integer, generated integer not null,
        primary key(analysis_id, path));
      create table if not exists pr_findings(
        analysis_id text not null, finding_id text not null,
        fingerprint text not null, introduced integer not null,
        baseline_finding_id text,
        rule_id text not null, rule_version integer not null, severity text not null,
        path text not null, line integer, entity_id text,
        kind text not null default 'SECURITY',
        disposition text not null,
        json text not null default '{}',
        primary key(analysis_id, finding_id));
      create index if not exists pr_findings_analysis on pr_findings(analysis_id, introduced, disposition);
      create table if not exists gate_policies(
        policy_id text not null, version integer not null, policy_hash text not null,
        body text not null,
        created_by text not null, created_at text not null,
        primary key(policy_id, version));
      create table if not exists gate_repo_policy(
        repo_root text primary key, policy_id text not null, updated_at text not null);
      create table if not exists gate_decisions(
        decision_id text primary key, analysis_id text not null,
        status text not null,
        binding_hash text not null, evaluated_at text not null, valid_until text,
        superseded integer not null default 0, revoked_reason text,
        json text not null);
      create index if not exists gate_decisions_analysis on gate_decisions(analysis_id, superseded);
      create table if not exists gate_condition_results(
        decision_id text not null, condition_id text not null,
        outcome text not null,
        reason text not null, evidence_ids text not null,
        waiver_id text,
        primary key(decision_id, condition_id));
      create table if not exists gate_waivers(
        id text primary key, repository_id text not null,
        scope_kind text not null,
        scope_json text not null,
        actor text not null, approver text, rationale text not null,
        created_at text not null, expires_at text not null, revoked_at text);
      create index if not exists gate_waivers_repo on gate_waivers(repository_id, expires_at);
      create table if not exists check_publications(
        id text primary key, decision_id text not null, repository_id text not null,
        forge text not null, head_hash text not null, idempotency_key text not null unique,
        kind text not null,
        external_id text, url text, state text not null,
        attempts integer not null default 0, last_error text, updated_at text not null);
      create index if not exists check_publications_head on check_publications(repository_id, head_hash, kind);
      create table if not exists revision_test_runs(
        revision text primary key, json text not null, source_hash text not null, ingested_at text not null);
      create table if not exists pr_baselines(
        merge_base_hash text not null, analyzer_set_hash text not null,
        revision text not null, findings_json text not null, created_at text not null,
        primary key(merge_base_hash, analyzer_set_hash));
      create table if not exists pr_grants(
        id text primary key, repository_id text not null, head_hash text not null,
        decision_id text, pending integer not null default 0,
        principal_id text not null, operation text not null, expires_at integer not null,
        revoked integer not null default 0, created_at text not null);`),
    down: (db) => db.exec(`
      drop table if exists pr_grants; drop table if exists pr_baselines; drop table if exists revision_test_runs;
      drop index if exists check_publications_head; drop table if exists check_publications;
      drop index if exists gate_waivers_repo; drop table if exists gate_waivers;
      drop table if exists gate_condition_results; drop table if exists gate_decisions;
      drop table if exists gate_repo_policy; drop table if exists gate_policies;
      drop index if exists pr_findings_analysis; drop table if exists pr_findings;
      drop table if exists pr_changed_files;
      drop index if exists pr_analyses_identity; drop index if exists pr_analyses_pr; drop table if exists pr_analyses;`),
  },
  {
    // F05: trace-linked continuous profiling. Artifacts declare their sample types, units, sampling metadata and build
    // identity; only aggregates (per function, and one pruned tree) are persisted — raw samples stay in the artifact store
    // by reference. `dropped_samples` is nullable on purpose: NULL means "not reported" (F05-A4), 0 means "reported none".
    // The sample_type_ordinal everywhere is the ordinal inside the artifact's own declared sample types.
    version: 27, name: "trace-linked-profiles",
    up: (db) => db.exec(`
      create table if not exists profile_artifacts(
        artifact_hash text primary key,
        format text not null, format_version text,
        profiler text, profiler_version text,
        service text, instance text, runtime_name text,
        start_ns real not null, end_ns real not null,   -- nanoseconds since the epoch: doubles, since SQLite integers cannot return 1.8e18 to JS
        period_ns real,
        sampling_rate_hz real, declared_overhead_percent real,
        dropped_samples integer,
        truncated integer not null default 0,
        stored_ref text not null,
        bytes integer not null,
        ingest_state text not null,             -- RECEIVED | PARSED | NORMALISED | AGGREGATED | LINKED | REJECTED | PARTIAL
        diagnostics_json text not null default '[]',
        labels_dropped integer not null default 0,
        ingested_at text not null);
      create index if not exists profile_artifacts_service on profile_artifacts(service, start_ns);
      create table if not exists profile_sample_types(
        artifact_hash text not null, ordinal integer not null,
        kind text not null, unit text not null, raw_type text not null, raw_unit text not null,
        primary key(artifact_hash, ordinal));
      create table if not exists profile_mappings(
        artifact_hash text not null, mapping_id integer not null,
        build_id text, file text,
        has_functions integer not null, has_filenames integer not null, has_line_numbers integer not null, has_inline_frames integer not null,
        revision text, revision_state text not null,   -- MATCHED | MISMATCH | UNKNOWN
        primary key(artifact_hash, mapping_id));
      create table if not exists profile_labels(
        artifact_hash text not null, label text not null, value text not null, sample_count integer not null,
        primary key(artifact_hash, label, value));
      create table if not exists profile_function_agg(
        artifact_hash text not null, sample_type_ordinal integer not null,
        function_key text not null,
        name text not null, file text, line integer,
        self_value real not null, total_value real not null, sample_count integer not null,
        entity_id text, attribution_method text not null,
        primary key(artifact_hash, sample_type_ordinal, function_key));
      create index if not exists profile_function_agg_ord on profile_function_agg(artifact_hash, sample_type_ordinal, self_value);
      create table if not exists profile_tree(
        artifact_hash text not null, sample_type_ordinal integer not null,
        tree_json text not null, node_count integer not null, pruned_value real not null,
        primary key(artifact_hash, sample_type_ordinal));
      create table if not exists profile_trace_links(
        link_id text primary key, artifact_hash text not null, chunk_index integer,
        trace_source text not null, trace_id text, span_id text,
        grade text not null,
        overlap_ms integer,
        reason text not null, created_at text not null);
      create index if not exists profile_trace_links_artifact on profile_trace_links(artifact_hash, trace_source);
      create table if not exists profile_populations(
        population_hash text primary key, service text not null,
        window_from_ns real not null, window_to_ns real not null,
        revision text, sample_type_kind text not null,
        chunk_ids_json text not null,
        sample_count integer not null, expected_samples integer, collection_ratio real,
        request_count integer, error_count integer, created_at text not null);
      create table if not exists profile_flags(id integer primary key check (id = 1), import integer not null, correlate integer not null, compare integer not null);
      insert or ignore into profile_flags(id, import, correlate, compare) values (1, 1, 1, 1);`),
    down: (db) => db.exec(`
      drop table if exists profile_flags; drop table if exists profile_populations;
      drop index if exists profile_trace_links_artifact; drop table if exists profile_trace_links;
      drop table if exists profile_tree;
      drop index if exists profile_function_agg_ord; drop table if exists profile_function_agg;
      drop table if exists profile_labels; drop table if exists profile_mappings; drop table if exists profile_sample_types;
      drop index if exists profile_artifacts_service; drop table if exists profile_artifacts;`),
  },
  {
    // F04: dependency vulnerability and licence scanning (WP-01/WP-02). Lockfile inventories with package identities as
    // purls, versioned advisory-feed snapshots, package-level findings with append-only assessments, licence outcomes
    // and versioned licence policies. Assessments are append-only (F04-A4): a feed change writes a new row, never an update.
    version: 26, name: "dependency-inventory",
    up: (db) => db.exec(`
      create table if not exists dependency_inventories(
        inventory_id text primary key, repository_id text not null, revision text not null,
        workspace_path text not null,
        ecosystem text not null, tier text not null,
        inventory_hash text not null, logical_hash text not null, source_hashes_json text not null,
        drift_json text not null,
        partial integer not null default 0, parse_errors_json text not null default '[]',
        json text not null,
        created_at text not null);
      create table if not exists dep_packages(
        inventory_id text not null, purl text not null, name text not null, version text not null,
        integrity text,
        registry text,
        scope text not null default 'PROD',
        is_private integer not null,
        licence_declared text,
        json text not null,
        primary key(inventory_id, purl));
      create table if not exists dep_edges(
        inventory_id text not null, from_purl text not null, to_purl text not null,
        range text,
        scope text not null,
        json text not null,
        primary key(inventory_id, from_purl, to_purl, scope));
      create table if not exists dep_roots(inventory_id text not null, purl text not null, scope text not null, primary key(inventory_id, purl, scope));
      create table if not exists feed_snapshots(
        snapshot_id text primary key, feed text not null, fetched_at text not null,
        upstream_modified text, content_hash text not null, advisories integer not null,
        licence_notice text not null,
        json text not null);
      create table if not exists advisories(
        snapshot_id text not null, advisory_id text not null, aliases_json text not null,
        ecosystem text not null, package_name text not null,
        summary text, details text, severity_json text,
        published text, modified text, withdrawn text,
        affected_json text not null,
        ecosystem_specific_json text,
        json text not null,
        primary key(snapshot_id, advisory_id, ecosystem, package_name));
      create index if not exists advisories_pkg on advisories(snapshot_id, ecosystem, package_name);
      create table if not exists dep_findings(
        finding_id text primary key, repository_id text not null, purl text not null, advisory_id text not null,
        introduced_in_revision text not null, last_seen_revision text not null, state text not null,
        json text not null,
        unique(repository_id, purl, advisory_id));
      create table if not exists dep_assessments(
        assessment_id text primary key, finding_id text not null,
        snapshot_id text not null, inventory_id text not null,
        applies integer not null, applicability_reason text not null,
        severity_reported text, reachability text not null,
        evidence_json text not null, assessed_at text not null);
      create table if not exists dep_licence_findings(
        inventory_id text not null, purl text not null, policy_hash text not null,
        outcome text not null,
        expression text, reason text not null, evidence_json text not null,
        json text not null,
        primary key(inventory_id, purl, policy_hash));
      create table if not exists licence_policies(
        policy_id text not null, version integer not null, policy_hash text not null, body text not null,
        json text not null,
        primary key(policy_id, version));`),
    down: (db) => db.exec(`
      drop table if exists licence_policies; drop table if exists dep_licence_findings; drop table if exists dep_assessments;
      drop table if exists dep_findings; drop index if exists advisories_pkg; drop table if exists advisories;
      drop table if exists feed_snapshots; drop table if exists dep_roots; drop table if exists dep_edges;
      drop table if exists dep_packages; drop table if exists dependency_inventories;`),
  },
  {
    // F06: historical hotspots and change coupling. The repository's own git history is analysed into commit events,
    // per-file changes, rename continuations (lineages), scored hotspots, statistical co-change edges and an
    // exclusions ledger (§6.2). Contributor identity is a keyed hash (`author_hash`); display names live only in the
    // restricted `history_contributor_names` table and are returned only to authorised principals (F06-A6).
    version: 28, name: "historical-hotspots",
    up: (db) => db.exec(`
      create table history_runs(
        run_id text primary key, repository_id text not null,
        head_commit text not null, since_time text, until_time text not null,
        shallow integer not null, commit_count integer not null,
        boundary_hash text not null, policy_hash text not null,
        worker_version text not null, state text not null, created_at text not null,
        note text not null default '', policy_json text not null default '{}', stats_json text not null default '{}',
        repo_root text not null default '',
        unique(repository_id, boundary_hash, policy_hash));
      create index history_runs_repo on history_runs(repository_id);
      create table commit_events(
        repository_id text not null, commit_hash text not null,
        author_hash text not null,
        committed_at text not null, parent_count integer not null,
        files_changed integer not null, insertions integer not null, deletions integer not null,
        class text not null, class_reason text not null,
        logical_change_id text not null, pr_number integer,
        primary key(repository_id, commit_hash));
      create table file_changes(
        repository_id text not null, commit_hash text not null,
        path text not null, old_path text, status text not null,
        similarity integer, insertions integer, deletions integer, generated integer not null,
        primary key(repository_id, commit_hash, path));
      create table file_lineage(
        repository_id text not null, lineage_id text not null,
        path text not null, valid_from_commit text not null, valid_to_commit text,
        primary key(repository_id, lineage_id, path, valid_from_commit));
      create table hotspot_scores(
        run_id text not null, lineage_id text not null, path text not null,
        changes_raw integer not null, changes_decayed real not null,
        logical_changes integer not null, distinct_contributors integer not null,
        health_json text not null, impact_json text not null, factors_json text not null,
        score real not null, rank integer not null, rank_raw integer not null,
        times_json text not null default '[]',
        formula_version text not null,
        primary key(run_id, lineage_id));
      create table cochange_edges(
        run_id text not null, a_lineage text not null, b_lineage text not null,
        support integer not null, count_a integer not null, count_b integer not null,
        total_changes integer not null, confidence_a_to_b real not null, confidence_b_to_a real not null,
        lift real not null, jaccard real not null, first_seen text not null, last_seen text not null,
        static_dependency text not null,
        edge_id text not null,
        primary key(run_id, a_lineage, b_lineage));
      create unique index cochange_edge_id on cochange_edges(run_id, edge_id);
      create index cochange_support on cochange_edges(run_id, support desc);
      create table history_exclusions(
        run_id text not null, commit_hash text not null, reason text not null, rule text not null,
        primary key(run_id, commit_hash));
      create table history_contributor_names(
        repository_id text not null, author_hash text not null, display_name text not null,
        primary key(repository_id, author_hash));
      create table history_name_grants(
        principal text primary key, granted_at text not null);
      create table history_flags(id integer primary key check (id = 1), v2 integer not null);`),
    down: (db) => db.exec(`
      drop table if exists history_flags; drop table if exists history_name_grants; drop table if exists history_contributor_names;
      drop table if exists history_exclusions;
      drop index if exists cochange_support; drop index if exists cochange_edge_id; drop table if exists cochange_edges;
      drop table if exists hotspot_scores;
      drop table if exists file_lineage; drop table if exists file_changes;
      drop index if exists history_runs_repo; drop table if exists history_runs;`),
  },
  {
    version: 29, name: "coordinated-campaigns",
    up: (db) => db.exec(`
      create table if not exists campaigns(
        campaign_id text primary key, tenant_id text not null, name text not null,
        spec_json text not null, spec_hash text not null, transformation_hash text not null,
        state text not null, version integer not null,
        created_by text not null, created_at text not null, updated_at text not null);
      create table if not exists campaign_populations(
        campaign_id text not null, version integer not null,
        population_hash text not null, selector_result_json text not null,
        frozen_at text not null, created_by text not null,
        primary key(campaign_id, version));
      create table if not exists campaign_children(
        campaign_id text not null, repository_id text not null, population_version integer not null,
        base_commit text not null, task_id text, batch_id text, state text not null,
        role text not null default 'INDEPENDENT', blocked_by_json text not null default '[]',
        assessment_state text not null default 'ASSESSED',
        publication_id text, pr_number integer, pr_state text,
        validation_json text, updated_at text not null,
        primary key(campaign_id, repository_id));
      create table if not exists campaign_batches(
        campaign_id text not null, batch_id text not null, ordinal integer not null,
        kind text not null, members_json text not null, depends_on_json text not null,
        pause_rule_json text not null, state text not null,
        primary key(campaign_id, batch_id));
      create table if not exists campaign_compat(
        campaign_id text not null, case_id text not null,
        producer_repository text not null, consumer_repository text not null,
        mode text not null, run_manifest_id text, state text not null, reason text,
        primary key(campaign_id, case_id));
      create table if not exists campaign_events(
        campaign_id text not null, seq integer not null, at text not null, actor text not null,
        type text not null, repository_id text, payload_json text not null, idempotency_key text,
        primary key(campaign_id, seq));
      create table if not exists campaign_reviewers(
        campaign_id text not null, repository_id text not null, principal text not null,
        role text not null, source text not null,
        primary key(campaign_id, repository_id, principal, role));
      create table if not exists campaign_exceptions(
        id text primary key, campaign_id text not null, repository_id text not null,
        scope text not null, rationale text not null, actor text not null, approver text,
        created_at text not null, expires_at text);`),
    down: (db) => db.exec(`
      drop table if exists campaign_exceptions; drop table if exists campaign_reviewers;
      drop table if exists campaign_events; drop table if exists campaign_compat;
      drop table if exists campaign_batches; drop table if exists campaign_children;
      drop table if exists campaign_populations; drop table if exists campaigns;`),
  },
  {
    // F08 follow-on: the parts of a running campaign that are not derivable from the plan alone — the materialised
    // child candidate, its recorded author and token cost, per-child publication grants bound to the exact
    // (base, head, diff), per-child approvals, the dry-run record, the joint run manifests and the budget usage.
    version: 30, name: "campaign-execution",
    up: (db) => db.exec(`
      alter table campaign_children add column recipe_json text;
      alter table campaign_children add column head_hash text;
      alter table campaign_children add column author text;
      alter table campaign_children add column tokens_used integer not null default 0;
      create table if not exists campaign_publication_grants(
        id text primary key, campaign_id text not null, repository_id text not null, principal text not null,
        base_hash text not null, head_hash text not null, diff_hash text not null,
        expires_at text not null, revoked integer not null default 0, created_at text not null);
      create index if not exists campaign_publication_grants_lookup on campaign_publication_grants(campaign_id, repository_id, principal);
      create table if not exists campaign_approvals(
        campaign_id text not null, repository_id text not null, principal text not null, version integer not null,
        binding_hash text not null, explanation text not null, cluster_id text, created_at text not null,
        primary key(campaign_id, repository_id, principal));
      create table if not exists campaign_dry_runs(
        run_id text primary key, campaign_id text not null, created_by text not null, created_at text not null, result_json text not null);
      create index if not exists campaign_dry_runs_campaign on campaign_dry_runs(campaign_id, created_at);
      create table if not exists campaign_joint_runs(
        run_manifest_id text primary key, campaign_id text not null, case_id text not null, manifest_json text not null);
      create table if not exists campaign_usage(
        campaign_id text primary key, wall_ms integer not null default 0, model_tokens integer not null default 0, github_writes integer not null default 0);`),
    down: (db) => db.exec(`
      drop table if exists campaign_usage; drop table if exists campaign_joint_runs;
      drop index if exists campaign_dry_runs_campaign; drop table if exists campaign_dry_runs;
      drop table if exists campaign_approvals;
      drop index if exists campaign_publication_grants_lookup; drop table if exists campaign_publication_grants;
      alter table campaign_children drop column tokens_used;
      alter table campaign_children drop column author;
      alter table campaign_children drop column head_hash;
      alter table campaign_children drop column recipe_json;`),
  },
  {
    // F10: the bounded workflow digital twin. Twins and their versions, the workload/environment
    // identities a result is bound to, the model artifacts and their full calibration history, the
    // validation certificates (scope is part of the certificate identity), the paired experiments and
    // their per-cell evidence, reports, and bounded schedule explorations.
    version: 31, name: "workflow-twins",
    up: (db) => db.exec(`
      create table if not exists twins(
        twin_id text primary key, workflow_id text not null, name text not null, created_by text not null, created_at text not null);
      create table if not exists twin_versions(
        twin_id text not null, version integer not null, twin_hash text not null,
        revision text not null, snapshot_json text not null,
        structure_json text not null, structure_hash text not null,
        baseline_evidence_json text not null,
        workload_hash text not null, environment_hash text not null, model_spec_hash text not null, oracle_hash text not null,
        state text not null,
        primary key(twin_id, version));
      create table if not exists workload_fixtures(
        workload_hash text primary key, spec_json text not null, fixture_ref text not null,
        derived_from_json text, streams_json text not null, created_at text not null);
      create table if not exists environment_specs(
        environment_hash text primary key, spec_json text not null, created_at text not null);
      create table if not exists model_artifacts(
        model_id text primary key, twin_id text not null, twin_version integer not null,
        model_spec_hash text not null, adapter_id text not null, adapter_version text not null,
        parent_model_id text, fit_hash text, parameters_json text not null, state text not null, created_at text not null);
      create table if not exists calibration_runs(
        calibration_id text primary key, model_id text not null,
        training_dataset_ids_json text not null, structure_candidates_json text not null, chosen_structure text not null,
        fit_metrics_json text not null, policy_id text not null, created_at text not null);
      create table if not exists validation_certificates(
        certificate_id text primary key, twin_id text not null, twin_version integer not null, model_id text not null,
        scope_json text not null, binding_hash text not null,
        holdout_report_json text not null, intervention_report_json text not null,
        state text not null, issued_at text not null, issued_by text not null,
        invalidated_by text, invalidated_at text, invalidation_reason text);
      create table if not exists twin_experiments(
        plan_id text primary key, twin_id text not null, twin_version integer not null,
        intervention_hash text not null, validation_plan_hash text not null, seed_plan_hash text not null,
        state text not null, generation integer not null, created_at text not null, plan_json text);
      create table if not exists twin_run_cells(
        plan_id text not null, cell_id text not null, pair_id text not null, role text not null,
        run_manifest_id text not null, order_index integer not null, comparable integer not null, incomparable_reason text,
        primary key(plan_id, cell_id));
      create table if not exists twin_reports(
        report_id text primary key, plan_id text, kind text not null,
        result_class text not null, content_json text not null, certificate_id text, created_at text not null);
      create table if not exists schedule_explorations(
        exploration_id text primary key, twin_id text not null, harness_hash text not null, oracle_hash text not null,
        bounds_json text not null, status text not null, explored integer not null, completed integer not null,
        schedule_artifact_hash text, created_at text not null, finding_json text);
      create table if not exists twin_baselines(
        twin_id text not null, twin_version integer not null, baseline_json text not null, primary key(twin_id, twin_version));
      create table if not exists prediction_records(
        prediction_id text primary key, parameter text not null, value real not null, load_multiplier real not null,
        interval_json text not null, baseline_value real not null, predicted_value real not null,
        recorded_at_ms integer not null, hash text not null);
      create index if not exists twin_versions_workflow on twin_versions(twin_id, state);
      create index if not exists model_artifacts_twin on model_artifacts(twin_id, twin_version, created_at);
      create index if not exists validation_certificates_twin on validation_certificates(twin_id, twin_version, state);
      create index if not exists twin_run_cells_plan on twin_run_cells(plan_id, role);`),
    down: (db) => db.exec(`
      drop table if exists prediction_records;
      drop table if exists twin_baselines;
      drop table if exists schedule_explorations;
      drop table if exists twin_reports;
      drop table if exists twin_run_cells;
      drop table if exists twin_experiments;
      drop table if exists validation_certificates;
      drop table if exists calibration_runs;
      drop table if exists model_artifacts;
      drop table if exists environment_specs;
      drop table if exists workload_fixtures;
      drop table if exists twin_versions;
      drop table if exists twins;`),
  },
  {
    // F07: task → candidate → validated patch → CIE-owned branch → draft PR. The task row is a projection of an
    // append-only event log (replay reproduces it exactly); the candidate's identity is the binding hash, which is
    // what grants, approvals, verdicts and the GitHub receipt all quote. Nothing in this migration writes to a
    // user's working tree: the branch tables describe a CIE-owned clone kept outside the repository.
    version: 32, name: "task-execution",
    up: (db) => db.exec(`
      create table if not exists tasks(
        task_id text primary key, repository_id text not null, revision text not null,
        base_ref text not null, base_commit text not null, base_content_hash text not null,
        spec_json text not null, spec_hash text not null,
        state text not null, version integer not null default 0, generation integer not null default 0,
        confirmed_at text, confirmed_by text, confirmed_spec_hash text,
        created_by text not null, created_at text not null, updated_at text not null);
      create index if not exists tasks_repo on tasks(repository_id, state, updated_at);
      create table if not exists task_events(
        task_id text not null, seq integer not null, at text not null, actor text not null,
        type text not null, payload_json text not null, generation integer not null, idempotency_key text,
        primary key(task_id, seq));
      create unique index if not exists task_events_idem on task_events(task_id, idempotency_key) where idempotency_key is not null;
      create table if not exists task_plans(
        task_id text not null, plan_version integer not null, plan_json text not null, plan_hash text not null,
        unknowns_json text not null, obligations_json text not null, created_by text not null, created_at text not null,
        primary key(task_id, plan_version));
      create table if not exists task_obligations(
        task_id text not null, obligation_id text not null, question text not null, state text not null,
        result_json text, steps integer not null default 0, updated_at text not null,
        primary key(task_id, obligation_id));
      create table if not exists task_candidates(
        task_id text not null, candidate_index integer not null, proposal_id text not null,
        binding_json text not null, binding_hash text not null, origin text not null,
        oracle_state text not null, state text not null, edit_operations_json text not null,
        changed_files_json text not null, plan_version integer not null, created_by text not null, created_at text not null,
        primary key(task_id, candidate_index));
      create index if not exists task_candidates_binding on task_candidates(binding_hash);
      create table if not exists oracle_reviews(
        id text primary key, task_id text not null, candidate_index integer not null,
        changes_json text not null, decision text not null, reviewer text not null, rationale text not null, created_at text not null);
      create index if not exists oracle_reviews_candidate on oracle_reviews(task_id, candidate_index);
      create table if not exists task_runs(
        task_id text not null, candidate_index integer not null, role text not null,
        run_manifest_id text not null, status text not null, outcomes_artifact_hash text not null,
        isolation text not null, omissions_json text not null, started_at text not null, finished_at text not null,
        primary key(task_id, run_manifest_id));
      create index if not exists task_runs_candidate on task_runs(task_id, candidate_index);
      create table if not exists task_verdicts(
        id text primary key, task_id text not null, candidate_index integer not null, binding_hash text not null,
        state text not null, oracle_state text not null, plan_hash text not null, verdict_json text not null, created_at text not null);
      create index if not exists task_verdicts_binding on task_verdicts(binding_hash);
      create table if not exists task_approvals(
        task_id text not null, candidate_index integer not null, principal text not null, version integer not null,
        binding_hash text not null, explanation text not null, created_at text not null,
        primary key(task_id, candidate_index, principal));
      create table if not exists task_grants(
        id text primary key, task_id text not null, principal text not null, repository text not null,
        base_branch text not null, branch text not null, base_hash text not null, head_hash text not null,
        diff_hash text not null, binding_hash text not null, expires_at text not null, revoked integer not null default 0,
        created_at text not null);
      create index if not exists task_grants_lookup on task_grants(binding_hash, repository);
      create table if not exists branch_publications(
        id text primary key, task_id text not null, repository text not null, branch text not null,
        base_hash text not null, head_hash text not null, push_state text not null,
        pr_number integer, pr_url text, receipt_draft integer, idempotency_key text not null unique, updated_at text not null);
      create index if not exists branch_publications_task on branch_publications(task_id, updated_at);
      create table if not exists task_isolations(
        profile_id text primary key, class text not null, audited integer not null, properties_json text not null,
        omissions_json text not null, checked_at text not null);`),
    down: (db) => db.exec(`
      drop table if exists task_isolations;
      drop index if exists branch_publications_task; drop table if exists branch_publications;
      drop index if exists task_grants_lookup; drop table if exists task_grants;
      drop table if exists task_approvals;
      drop index if exists task_verdicts_binding; drop table if exists task_verdicts;
      drop index if exists task_runs_candidate; drop table if exists task_runs;
      drop index if exists oracle_reviews_candidate; drop table if exists oracle_reviews;
      drop index if exists task_candidates_binding; drop table if exists task_candidates;
      drop table if exists task_obligations;
      drop table if exists task_plans;
      drop index if exists task_events_idem; drop table if exists task_events;
      drop index if exists tasks_repo; drop table if exists tasks;`),
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
