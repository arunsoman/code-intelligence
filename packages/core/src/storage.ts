// C31: backup and restore, reference-counted garbage collection, and deletion that reaches everything derived.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { currentVersion, MIGRATIONS } from "./migrations.ts";
import type { Store } from "./store.ts";

const q = (s: Store, sql: string, ...a: any[]) => s.db.prepare(sql).all(...a) as any[];
const n = (s: Store, sql: string, ...a: any[]): number => Number((s.db.prepare(sql).get(...a) as any)?.n ?? 0);

/** A consistent copy of the whole database while it is in use (VACUUM INTO takes a read snapshot). Refuses to overwrite. */
export function backup(store: Store, to: string): { path: string; revisions: number } {
  if (existsSync(to)) throw new Error(`backup target already exists: ${to}`);
  store.db.exec(`vacuum into '${to.replace(/'/g, "''")}'`);
  const copy = new DatabaseSync(to, { readOnly: true });
  try {
    const ok = (copy.prepare("pragma integrity_check").get() as any).integrity_check;
    if (ok !== "ok") throw new Error(`backup failed its integrity check: ${ok}`);
  } finally { copy.close(); }
  return { path: to, revisions: n(store, "select count(*) n from revisions") };
}

export interface RestoreReport { ok: boolean; target: string; schemaVersion: number; problems: string[] }
/** Verify a backup, then put it in place atomically (write beside, rename over). The old file is kept as `.before-restore`. */
export function restore(backupPath: string, target: string): RestoreReport {
  const problems: string[] = [];
  const probe = new DatabaseSync(backupPath, { readOnly: true });
  let schemaVersion = 0;
  try {
    const ok = (probe.prepare("pragma integrity_check").get() as any).integrity_check;
    if (ok !== "ok") problems.push(`integrity_check: ${ok}`);
    schemaVersion = currentVersion(probe as any);
    const newest = Math.max(...MIGRATIONS.map((m) => m.version));
    if (schemaVersion > newest) problems.push(`backup is schema v${schemaVersion}, newer than this build (v${newest}); refusing to downgrade silently`);
  } catch (e) { problems.push((e as Error).message); } finally { probe.close(); }
  if (problems.length) return { ok: false, target, schemaVersion, problems };
  const staging = `${target}.restoring`;
  copyFileSync(backupPath, staging);
  if (existsSync(target)) copyFileSync(target, `${target}.before-restore`);
  for (const ext of ["-wal", "-shm"]) rmSync(target + ext, { force: true });
  renameSync(staging, target);
  return { ok: true, target, schemaVersion, problems };
}

export interface GcReport { removed: string[]; kept: Record<string, string[]>; dryRun: boolean }
/**
 * A revision is kept while anything refers to it: a saved investigation, a human verdict on one of its claims, a concept
 * snapshot, or being the newest revision of its repository. Everything else older than `minAgeMs` is removed with all
 * rows derived from it. Nothing a person did is ever collected by being unreferenced.
 */
export function gc(store: Store, opts: { minAgeMs?: number; dryRun?: boolean; now?: number } = {}): GcReport {
  const minAge = opts.minAgeMs ?? 0, now = opts.now ?? Date.now();
  const revs = q(store, "select id, repo_root, created_at from revisions");
  const latest = new Set(q(store, "select id from revisions r where created_at = (select max(created_at) from revisions where repo_root = r.repo_root)").map((r) => r.id));
  const kept: Record<string, string[]> = {}, remove: string[] = [];
  for (const r of revs) {
    const why: string[] = [];
    if (latest.has(r.id)) why.push("newest revision of its repository");
    const ws = n(store, "select count(*) n from workspaces where revision = ?", r.id);
    if (ws) why.push(`${ws} saved investigation(s)`);
    const vd = n(store, "select count(*) n from verdicts v join claims c on c.id = v.claim_id where c.revision = ?", r.id);
    if (vd) why.push(`${vd} human verdict(s)`);
    const cv = n(store, "select count(*) n from concept_versions where revision = ?", r.id);
    if (cv) why.push(`${cv} concept snapshot(s)`);
    if (now - Date.parse(r.created_at) < minAge) why.push("younger than the minimum age");
    if (why.length) kept[r.id] = why; else remove.push(r.id);
  }
  if (!opts.dryRun) store.tx(() => { for (const id of remove) dropRevision(store, id); });
  return { removed: remove, kept, dryRun: !!opts.dryRun };
}

function dropRevision(store: Store, id: string) {
  const d = store.db;
  d.prepare("delete from subscriber_progress where event_id in (select event_id from outbox where json_extract(payload, '$.revision') = ?)").run(id);
  d.prepare("delete from outbox where json_extract(payload, '$.revision') = ?").run(id);
  d.prepare("delete from verdicts where claim_id in (select id from claims where revision = ?)").run(id);
  for (const t of ["entities", "relationships", "facts", "evidence", "rev_files", "concepts", "claims", "context_events", "embeddings", "exports"]) d.prepare(`delete from ${t} where revision = ?`).run(id);
  d.prepare("delete from webhook_deliveries where revision = ? or payload like ?").run(id, `%${id}%`);
  d.prepare("delete from revisions where id = ?").run(id);
}

export interface DeleteReport { revisions: number; workspaces: number; claims: number; rowsAfter: number }
/**
 * Delete a repository and everything derived from it: revisions and their facts, concepts and claims, verdicts on those
 * claims, saved investigations over it, overrides, policy, test data, editor context, jobs. The audit log keeps that a
 * deletion happened (who, when, how many rows) and nothing of the content. Returns how many rows still mention it: 0.
 */
export function deleteRepository(store: Store, repoRoot: string, actor = "local-user"): DeleteReport {
  const revIds = q(store, "select id from revisions where repo_root = ?", repoRoot).map((r) => r.id as string);
  const claims = revIds.reduce((a, id) => a + n(store, "select count(*) n from claims where revision = ?", id), 0);
  const workspaces = revIds.reduce((a, id) => a + n(store, "select count(*) n from workspaces where revision = ?", id), 0);
  store.tx(() => {
    // F05: this repository's trace sources anchor profile links; gather them here, before the envelopes go.
    const traceSources = new Set(revIds.flatMap((id) => q(store, "select distinct source from rt_envelopes where revision = ?", id).map((r) => String(r.source))));
    const linkedArtifacts = new Set(traceSources.size
      ? q(store, `select distinct artifact_hash from profile_trace_links where trace_source in (${[...traceSources].map(() => "?").join(",")})`, ...traceSources).map((r) => String(r.artifact_hash))
      : []);
    // Claim history, canonical identities, event-sourced workspaces, annotations and the developer-context stream are all derived from the code.
    const entityIds = new Set(revIds.flatMap((id) => q(store, "select entity_id from entities where revision = ?", id).map((r) => r.entity_id as string)));
    for (const row of q(store, "select session, seq, payload from ctx_events where payload is not null")) {
      const text = String(row.payload);
      if ([...entityIds].some((e) => text.includes(e))) store.db.prepare("delete from ctx_events where session = ? and seq = ?").run(row.session, row.seq);
    }
    for (const src of q(store, "select id from ext_sources where repo_root = ?", repoRoot)) for (const t of ["ext_items", "ext_quarantine", "ext_deliveries"]) store.db.prepare(`delete from ${t} where source = ?`).run(src.id);
    store.db.prepare("delete from ext_sources where repo_root = ?").run(repoRoot);
    store.db.prepare("delete from annotations where repo_root = ?").run(repoRoot);
    store.db.prepare("delete from collab_access where repo_root = ?").run(repoRoot);
    for (const t of q(store, "select id from review_threads where repo_root = ?", repoRoot)) store.db.prepare("delete from review_thread_history where thread_id = ?").run(t.id);
    store.db.prepare("delete from review_threads where repo_root = ?").run(repoRoot);
    for (const id of revIds) {
      for (const c of q(store, "select id from claims where revision = ?", id)) store.db.prepare("delete from claim_events where claim_id = ?").run(c.id);
      for (const c of q(store, "select distinct canon_id from canon_nodes where revision = ?", id)) store.db.prepare("delete from canon_history where canon_id = ?").run(c.canon_id);
      for (const e of q(store, "select id from rt_envelopes where revision = ?", id)) { store.db.prepare("delete from rt_spans where envelope = ?").run(e.id); store.db.prepare("delete from rt_envelopes where id = ?").run(e.id); }
      store.db.prepare("delete from rt_markers where revision = ?").run(id);
      store.db.prepare("delete from sec_findings where revision = ?").run(id);
      store.db.prepare("delete from canon_nodes where revision = ?").run(id);
      store.db.prepare("delete from canon_lineage where revision = ? or parent = ?").run(id, id);
      store.db.prepare("delete from canon_proposals where from_revision = ? or to_revision = ?").run(id, id);
      for (const w of q(store, "select ws from ws_meta where revision = ?", id)) { for (const t of ["ws_events", "ws_checkpoints", "collab_shares", "collab_ops"]) store.db.prepare(`delete from ${t} where ws = ?`).run(w.ws); }
      store.db.prepare("delete from ws_meta where revision = ?").run(id);
      store.db.prepare("delete from workspaces where revision = ?").run(id);
      store.db.prepare("delete from jobs where json like ?").run(`%${id}%`);
      dropRevision(store, id);
    }
    // F07: a task, its event log, plans, obligations, candidates, verdicts, approvals, grants and publication rows all
    // belong to this repository's revisions. The candidate rows quote the binding, which quotes a revision, so the
    // task rows go with it; a branch CIE pushed in its own clone is left alone (deleting a repository never touches a
    // remote), and that is said in the report below.
    if (revIds.length) {
      const tasks = q(store, `select task_id from tasks where revision in (${revIds.map(() => "?").join(",")})`, ...revIds).map((r) => String(r.task_id));
      for (const t of tasks) {
        for (const table of ["task_events", "task_plans", "task_obligations", "task_candidates", "oracle_reviews", "task_runs", "task_verdicts", "task_approvals", "task_grants", "branch_publications"]) {
          store.db.prepare(`delete from ${table} where task_id = ?`).run(t);
        }
        store.db.prepare("delete from tasks where task_id = ?").run(t);
      }
    }
    for (const t of ["concept_versions", "overrides", "repo_policy", "test_runs"]) store.db.prepare(`delete from ${t} where repo_root = ?`).run(repoRoot);
    // F02: the pull-request analyses, their findings, decisions, publications, waivers and policy assignment are all
    // derived from this repository's sources; nothing about it outlives the delete. Baselines are content-cache rows:
    // a shared one whose other owner is gone simply re-analyses next time.
    const mergeBases = q(store, "select distinct merge_base_hash m from pr_analyses where repo_root = ?", repoRoot).map((x) => x.m) as unknown as string[];
    for (const a of q(store, "select id from pr_analyses where repo_root = ?", repoRoot)) {
      for (const d of q(store, "select decision_id from gate_decisions where analysis_id = ?", a.id)) store.db.prepare("delete from gate_condition_results where decision_id = ?").run(d.decision_id);
      store.db.prepare("delete from gate_decisions where analysis_id = ?").run(a.id);
      for (const t of ["pr_changed_files", "pr_findings"]) store.db.prepare(`delete from ${t} where analysis_id = ?`).run(a.id);
    }
    // pr analyses and their publications key on repository_id; gate_waivers has no repo_root column, so the
    // per-table columns differ (a wrong shared clause is "no such column" for every deletion).
    for (const t of ["pr_analyses", "check_publications"]) store.db.prepare(`delete from ${t} where repository_id = ?`).run(repoRoot);
    store.db.prepare("delete from gate_waivers where repository_id in (select repository_id from repositories where root = ?)").run(repoRoot);
    store.db.prepare("delete from gate_repo_policy where repo_root = ?").run(repoRoot);
    for (const id of revIds) store.db.prepare("delete from revision_test_runs where revision = ?").run(id);
    for (const m of mergeBases) store.db.prepare("delete from pr_baselines where merge_base_hash = ?").run(m);
    store.db.prepare("delete from jobs where params like ?").run(`%${repoRoot.replace(/[%_]/g, "")}%`);
    // Investigations over it: their hypotheses, observations, plans and payloads are derived from it. What remains is a tombstone
    // (that one existed, and when it ended), never content.
    for (const r of store.db.prepare("select id, json from c22_investigations where json like ? and deleted = 0").all(`%${repoRoot.replace(/[%_]/g, "")}%`) as { id: string; json: string }[]) purgeInvestigation(store, r.id, JSON.parse(r.json).workspaceId);
    // F05: every table keyed by an artifact hash is derived from the collected file; artifacts whose only trace links
    // belonged to this repository go with it (the remaining ones are content-addressed bytes, redacted at read time).
    for (const h of linkedArtifacts) {
      for (const t of ["profile_artifacts", "profile_sample_types", "profile_function_agg", "profile_tree"]) store.db.prepare(`delete from ${t} where artifact_hash = ?`).run(h);
      // populations carry no artifact column; their chunk ids name the artifact they were built from
      store.db.prepare("delete from profile_populations where chunk_ids_json like ?").run(`%${h}%`);
      store.db.prepare("delete from profile_mappings where artifact_hash = ?").run(h);
      store.db.prepare("delete from profile_labels where artifact_hash = ?").run(h);
      store.db.prepare("delete from profile_trace_links where artifact_hash = ?").run(h);
    }
    if (traceSources.size) for (const s of traceSources) store.db.prepare("delete from profile_trace_links where trace_source = ?").run(s);
    if (revIds.length) store.db.prepare(`delete from profile_mappings where revision is not null and revision in (${[...revIds].map(() => "?").join(",")})`).run(...revIds);
    // Receipts of replayed commands hold whole snapshots; they are derived data too.
    store.db.prepare("delete from idempotency where receipt like ?").run(`%${repoRoot.replace(/[%_]/g, "")}%`);
    for (const id of revIds) store.db.prepare("delete from idempotency where receipt like ?").run(`%${id}%`);
    // Stack traces name this repository's files and functions, so they are derived from it too.
    store.db.prepare("delete from exceptions where trace like ?").run(`%${repoRoot.replace(/[%_]/g, "")}%`);
    // F06: the analysed history, its lineages, scores, co-change edges, exclusions and contributor hashes are
    // derived from this repository and are removed with it. The engine names a repository by its registry id
    // when it has one, and by a hash of its resolved path otherwise; both are matched here.
    const f06Ids = new Set<string>();
    const known = q(store, "select repository_id from repositories where root = ?", repoRoot)[0];
    if (known) f06Ids.add(String(known.repository_id));
    f06Ids.add("repo:" + createHash("sha256").update("path:" + resolve(repoRoot)).digest("hex").slice(0, 16));
    for (const id of f06Ids) {
      for (const r of q(store, "select run_id from history_runs where repository_id = ?", id)) {
        for (const t of ["hotspot_scores", "cochange_edges", "history_exclusions"]) store.db.prepare(`delete from ${t} where run_id = ?`).run(r.run_id);
      }
      for (const t of ["history_runs", "commit_events", "file_changes", "file_lineage", "history_contributor_names"]) store.db.prepare(`delete from ${t} where repository_id = ?`).run(id);
    }
  });
  const redacted = store.redactAudit([repoRoot, ...revIds]);
  store.audit(actor, "repo.delete", "(deleted)", { revisions: revIds.length, claims, workspaces, auditEventsRedacted: redacted });
  return { revisions: revIds.length, workspaces, claims, rowsAfter: rowsMentioning(store, repoRoot, revIds) };
}

/** Remove an investigation's content and leave a tombstone. Mirrors InvestigationEngine.deleteInvestigation, for use when its source is deleted. */
export function purgeInvestigation(store: Store, id: string, workspaceId: string) {
  const d = store.db;
  const hyps = (d.prepare("select id, claim_id from c22_hypotheses where investigation_id = ?").all(id) as { id: string; claim_id: string }[]);
  const claimIds = new Set(hyps.map((h) => h.claim_id));
  for (const h of hyps) for (const a of d.prepare("select json from c22_assessments where hypothesis_id = ?").all(h.id) as { json: string }[]) claimIds.add(JSON.parse(a.json).claimId);
  for (const st of d.prepare("select id from c22_steps where investigation_id = ?").all(id) as { id: string }[]) d.prepare("delete from c22_attempts where step_id = ?").run(st.id);
  for (const h of hyps) d.prepare("delete from c22_assessments where hypothesis_id = ?").run(h.id);
  for (const t of ["c22_hypotheses", "c22_observations", "c22_checks", "c22_steps", "c22_experiments", "c22_payloads", "c22_checkpoints"]) d.prepare(`delete from ${t} where investigation_id = ?`).run(id);
  for (const c of claimIds) { d.prepare("delete from verdicts where claim_id = ?").run(c); d.prepare("delete from claims where id = ?").run(c); }
  const evs = d.prepare("select json from c22_events where investigation_id = ?").all(id) as { json: string }[];
  d.prepare("delete from c22_events where investigation_id = ?").run(id);
  for (const x of evs) { const ev = JSON.parse(x.json); d.prepare("insert into c22_events values (?,?,?)").run(id, ev.sequence, JSON.stringify({ id: ev.id, investigationId: id, sequence: ev.sequence, aggregateVersion: ev.aggregateVersion, generation: ev.generation, type: "STATE_CHANGED", payload: {}, scopeHash: "", causedByCommandId: "", createdAt: ev.createdAt, redacted: true })); }
  d.prepare("update c22_investigations set deleted = 1, json = ? where id = ?").run(JSON.stringify({ id, workspaceId, deleted: true }), id);
}

/** Every row, in every table except the audit log, whose text still contains the repository path or one of its revision ids. */
export function rowsMentioning(store: Store, repoRoot: string, revIds: string[]): number {
  return Object.values(mentionsByTable(store, repoRoot, revIds)).reduce((a, b) => a + b, 0);
}
/** Which tables still hold a row that mentions the repository path or one of its revision ids, and how many. */
export function mentionsByTable(store: Store, repoRoot: string, revIds: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const tables = q(store, "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").map((r) => r.name as string).filter((t) => t !== "audit" && t !== "repo_access"); // the revocation record must outlive the data it guards: it holds a path and a flag, nothing derived
  for (const t of tables) {
    const cols = q(store, `pragma table_info(${t})`).map((c) => c.name as string);
    for (const needle of [repoRoot, ...revIds]) {
      const c = n(store, `select count(*) n from ${t} where ${cols.map((x) => `cast(${x} as text) like ?`).join(" or ")}`, ...cols.map(() => `%${needle}%`));
      if (c) out[t] = (out[t] ?? 0) + c;
    }
  }
  return out;
}

export const tempDir = () => mkdtempSync(join(tmpdir(), "cie-store-"));
export { dirname };
