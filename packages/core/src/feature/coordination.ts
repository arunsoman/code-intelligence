// Task 3.T — several requests against one repository (PF-063, PF-065).
//   * Mutation leases (AT-24/57): all-or-nothing reservation of surfaces (repository-relative paths) with a per-repository monotonic
//     FENCING TOKEN. A holder that was replaced (lease expired and taken over) has a lower token, and assertFence refuses it.
//     Another request's holder is not named unless the same person owns it, so ids cannot be probed.
//   * Relations (DUPLICATES / DEPENDS_ON / EXTENDS / CONFLICTS_WITH) are between a person's own requests and start PROPOSED; a
//     DEPENDS_ON cycle is refused.
//   * assessConcurrentChanges: candidates verified one by one are NOT verified together. Overlapping paths are conflicts; disjoint
//     candidates are still marked `reverify` with the hash of the combined tree that must be verified.
//   * getMutationOrigins reads only the caller's own requests. assessRetirement lists the static consumers it can see and ALWAYS
//     reports the unknown-consumer gap: callers outside this repository cannot be enumerated from here.
import { readFileSync } from "node:fs";
import { policyFor } from "../access.ts";
import { makeScratch, removeScratch, safeJoin, walkFiles } from "../isolated-exec.ts";
import { applyCandidateToDir, copyTreeKeepLinks } from "./tree.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "../store.ts";
import { contentRoot, entriesFromDirectory } from "./canon.ts";
import { FeatureError } from "./errors.ts";
import { unsafePath } from "./patch-export.ts";
import { snapshotOf } from "./intake.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { CandidateRecord, Id, ImpactAssessment, IntegrationAssessment, MutationLease, MutationLineage, Outcome, RequestRelation, SourceRef, Snapshot } from "./types.ts";
import { validationHash } from "./validation.ts";

export interface CoordDeps { fs: SqliteFeatureStore; store: Store; now?: () => number }
const clock = (d: CoordDeps) => (d.now ?? Date.now)();
export const MAX_SURFACES = 200, MIN_TTL_MS = 1_000, MAX_TTL_MS = 3_600_000;

const own = (d: CoordDeps, actor: Id, requestId: Id) => {
  const rec = d.fs.getRequest(requestId);
  if (!rec || rec.createdBy !== actor) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
  return rec;
};

// ------------------------------------------------------------------------------------------------ leases

export function reserveMutationSurfaces(d: CoordDeps, actor: Id, i: { requestId: Id; surfaceIds: Id[]; expectedRevision: string; ttlMs: number }): Outcome<MutationLease> {
  const rec = own(d, actor, i.requestId);
  if (["CANCELLED", "FAILED"].includes(rec.state)) throw new FeatureError("FORBIDDEN", `the request is ${rec.state}`);
  if (!Array.isArray(i.surfaceIds) || !i.surfaceIds.length || i.surfaceIds.length > MAX_SURFACES) throw new FeatureError("INVALID_SCHEMA", `between 1 and ${MAX_SURFACES} surfaces`);
  const surfaces = [...new Set(i.surfaceIds)].sort();
  for (const s of surfaces) if (typeof s !== "string" || unsafePath(s)) throw new FeatureError("INVALID_SCHEMA", `surface ${JSON.stringify(s)} is not a safe repository-relative path`);
  if (!Number.isInteger(i.ttlMs) || i.ttlMs < MIN_TTL_MS || i.ttlMs > MAX_TTL_MS) throw new FeatureError("INVALID_SCHEMA", `ttlMs must be between ${MIN_TTL_MS} and ${MAX_TTL_MS}`);
  const policy = policyFor(d.store, rec.repositoryId);
  if (surfaces.some((s) => policy.denied(s))) throw new FeatureError("NOT_FOUND", "a surface is not accessible");
  const live = snapshotOf(d.store, rec.repositoryId);
  if (i.expectedRevision !== live.contentRootHash) return { status: "STALE", evidenceIds: [], diagnostics: ["the repository changed since the revision you expected; reload before reserving"] };
  const now = clock(d), db = d.store.db;
  return d.store.tx((): Outcome<MutationLease> => {
    const held = surfaces.flatMap((s) => { const r = db.prepare("select request_id, expires_at from feature_leases where repository_id = ? and surface = ?").get(rec.repositoryId, s) as { request_id: string; expires_at: number } | undefined; return r && r.expires_at > now && r.request_id !== rec.requestId ? [{ s, holder: r.request_id }] : []; });
    if (held.length) {
      const mine = (h: string) => d.fs.getRequest(h)?.createdBy === actor;
      return { status: "FAILED", evidenceIds: [], diagnostics: held.map((h) => `${h.s} is reserved by ${mine(h.holder) ? `your request ${h.holder}` : "another request"}`) };
    }
    const cur = (db.prepare("select token from feature_fence where repository_id = ?").get(rec.repositoryId) as { token: number } | undefined)?.token ?? 0, token = cur + 1;
    db.prepare("insert into feature_fence(repository_id, token) values (?, ?) on conflict(repository_id) do update set token = excluded.token").run(rec.repositoryId, token);
    const expiresAt = now + i.ttlMs, id = `lease:${validationHash("pf.Lease", { r: rec.repositoryId, q: rec.requestId, t: token }).split(":").pop()!.slice(0, 20)}`;
    for (const s of surfaces) db.prepare("insert into feature_leases(repository_id, surface, lease_id, request_id, fencing_token, expected_revision, expires_at) values (?,?,?,?,?,?,?) on conflict(repository_id, surface) do update set lease_id = excluded.lease_id, request_id = excluded.request_id, fencing_token = excluded.fencing_token, expected_revision = excluded.expected_revision, expires_at = excluded.expires_at").run(rec.repositoryId, s, id, rec.requestId, token, i.expectedRevision, expiresAt);
    return { status: "COMPLETE", value: { id, requestId: rec.requestId, surfaceIds: surfaces, expectedRevision: i.expectedRevision, fencingToken: token, expiresAt: new Date(expiresAt).toISOString() }, evidenceIds: [], diagnostics: [] };
  });
}

/** True only when `token` is the current, unexpired token of `requestId` for every surface. A replaced holder fails here. */
export function assertFence(d: CoordDeps, requestId: Id, surfaceIds: Id[], token: number): void {
  const rec = d.fs.getRequest(requestId); if (!rec) throw new FeatureError("NOT_FOUND", "no such request");
  const now = clock(d);
  for (const s of surfaceIds) {
    const r = d.store.db.prepare("select request_id, fencing_token, expires_at from feature_leases where repository_id = ? and surface = ?").get(rec.repositoryId, s) as { request_id: string; fencing_token: number; expires_at: number } | undefined;
    if (!r || r.request_id !== requestId || r.fencing_token !== token || r.expires_at <= now) throw new FeatureError("STALE_REVISION", `the lease on ${s} is not held by this request with token ${token}; the write is refused`);
  }
}
export function releaseLeases(d: CoordDeps, actor: Id, requestId: Id): number { own(d, actor, requestId); return Number(d.store.db.prepare("delete from feature_leases where request_id = ?").run(requestId).changes); }

// ------------------------------------------------------------------------------------------------ relations

const REL = ["DUPLICATES", "DEPENDS_ON", "EXTENDS", "CONFLICTS_WITH"] as const;
export function relateRequests(d: CoordDeps, actor: Id, i: { fromRequestId: Id; toRequestId: Id; relationship: string; sourceRefs?: SourceRef[] }): RequestRelation {
  if (!(REL as readonly string[]).includes(i.relationship)) throw new FeatureError("INVALID_SCHEMA", `relationship must be one of ${REL.join(", ")}`);
  if (i.fromRequestId === i.toRequestId) throw new FeatureError("INVALID_SCHEMA", "a request cannot relate to itself");
  const from = own(d, actor, i.fromRequestId), to = own(d, actor, i.toRequestId);
  if (from.repositoryId !== to.repositoryId) throw new FeatureError("INVALID_SCHEMA", "requests in different repositories are not related here");
  const relationship = i.relationship as RequestRelation["relationship"];
  if (relationship === "DEPENDS_ON" && dependsOnPath(d, to.requestId, from.requestId)) throw new FeatureError("ILLEGAL_TRANSITION", "that dependency would form a cycle");
  const rel: RequestRelation = { fromRequestId: from.requestId, toRequestId: to.requestId, relationship, sourceRefs: i.sourceRefs ?? [], state: "PROPOSED" };
  const id = `rel:${validationHash("pf.Relation", { f: rel.fromRequestId, t: rel.toRequestId, r: relationship }).split(":").pop()!.slice(0, 20)}`;
  d.store.db.prepare("insert or ignore into feature_relations(id, from_request, to_request, relationship, state, created_by, json, created_at) values (?,?,?,?,?,?,?,?)").run(id, rel.fromRequestId, rel.toRequestId, relationship, "PROPOSED", actor, JSON.stringify(rel), new Date(clock(d)).toISOString());
  return rel;
}
export function relationsOf(d: CoordDeps, actor: Id, requestId: Id): (RequestRelation & { id: Id })[] {
  own(d, actor, requestId);
  return (d.store.db.prepare("select id, json from feature_relations where (from_request = ? or to_request = ?) and created_by = ? order by created_at, id").all(requestId, requestId, actor) as { id: string; json: string }[]).map((r) => ({ ...(JSON.parse(r.json) as RequestRelation), id: r.id }));
}
function dependsOnPath(d: CoordDeps, from: Id, target: Id, seen = new Set<Id>()): boolean {
  if (from === target) return true; if (seen.has(from)) return false; seen.add(from);
  const next = d.store.db.prepare("select to_request from feature_relations where from_request = ? and relationship = 'DEPENDS_ON' and state != 'SUPERSEDED'").all(from) as { to_request: string }[];
  return next.some((r) => dependsOnPath(d, r.to_request, target, seen));
}
/** Requests this one DEPENDS_ON that are not yet published: they order the work and show as blockers. */
export function unmetDependencies(d: CoordDeps, actor: Id, requestId: Id): Id[] {
  return relationsOf(d, actor, requestId).filter((r) => r.relationship === "DEPENDS_ON" && r.fromRequestId === requestId && r.state !== "SUPERSEDED" && d.fs.getRequest(r.toRequestId)?.state !== "PUBLISHED").map((r) => r.toRequestId);
}

// ------------------------------------------------------------------------------------------------ integration

const pathsOf = (c: CandidateRecord): string[] => [...new Set(c.mutations.flatMap((m) => [m.oldPath, m.newPath]).filter((p): p is string => !!p))];

export function assessConcurrentChanges(d: CoordDeps, actor: Id, i: { requestIds: Id[]; candidateBindings: string[]; snapshot: Snapshot }): Outcome<IntegrationAssessment> {
  if (!Array.isArray(i.requestIds) || !Array.isArray(i.candidateBindings) || i.requestIds.length !== i.candidateBindings.length || !i.requestIds.length) throw new FeatureError("INVALID_SCHEMA", "one candidate binding per request is required");
  if (new Set(i.requestIds).size !== i.requestIds.length) throw new FeatureError("INVALID_SCHEMA", "a request appears twice");
  const cands: CandidateRecord[] = [];
  i.requestIds.forEach((rid, k) => {
    const rec = own(d, actor, rid); const c = d.fs.getCandidateByBinding(i.candidateBindings[k]!);
    if (!c || c.requestId !== rid) throw new FeatureError("NOT_FOUND", `request ${rid} has no such candidate`);
    if (rec.repositoryId !== i.snapshot.repositoryId) throw new FeatureError("INVALID_SCHEMA", "all requests must be in the snapshot's repository");
    cands.push(c);
  });
  const live = snapshotOf(d.store, i.snapshot.repositoryId);
  if (live.contentRootHash !== i.snapshot.contentRootHash) return { status: "STALE", evidenceIds: [], diagnostics: ["the repository changed since this snapshot"] };
  const conflicts: string[] = [], notes: string[] = [];
  for (const c of cands) { if (c.status !== "MATERIALIZED") conflicts.push(`${c.requestId}: candidate is ${c.status}`); else if (c.baseSnapshotRoot !== live.contentRootHash) conflicts.push(`${c.requestId}: candidate was built on a different base than the repository now has`); }
  const byPath = new Map<string, Id[]>();
  for (const c of cands) for (const p of pathsOf(c)) byPath.set(p, [...(byPath.get(p) ?? []), c.requestId]);
  const overlaps = [...byPath].filter(([, ids]) => ids.length > 1).map(([path, requestIds]) => ({ path, requestIds })).sort((a, b) => a.path.localeCompare(b.path));
  for (const o of overlaps) conflicts.push(`${o.path} is changed by ${o.requestIds.length} requests`);
  // Order by dependencies: a request after what it depends on. A cycle among the set is a conflict.
  const order: Id[] = []; const remaining = new Set(i.requestIds); const deps = (r: Id) => relationsOf(d, actor, r).filter((x) => x.relationship === "DEPENDS_ON" && x.fromRequestId === r && remaining.has(x.toRequestId)).map((x) => x.toRequestId);
  while (remaining.size) { const ready = [...remaining].filter((r) => deps(r).length === 0).sort(); if (!ready.length) { conflicts.push("the requests depend on each other in a cycle"); break; } for (const r of ready) { order.push(r); remaining.delete(r); } }
  for (const r of i.requestIds) for (const x of relationsOf(d, actor, r)) if (x.relationship === "CONFLICTS_WITH" && x.fromRequestId === r && i.requestIds.includes(x.toRequestId)) conflicts.push(`${r} is recorded as conflicting with ${x.toRequestId}`);
  let integrated: string | undefined;
  if (!conflicts.length) {
    const scratch = makeScratch("pf-int-");
    try {
      copyTreeKeepLinks(i.snapshot.repositoryId, scratch);
      for (const c of cands) applyCandidateToDir(scratch, c);
      integrated = contentRoot(entriesFromDirectory(scratch, { exclude: [] }));
    } finally { removeScratch(scratch); }
  }
  const reverify = cands.length > 1;
  if (reverify) notes.push("each candidate was verified alone; the combined tree is not verified until it is validated as one candidate");
  if (!conflicts.length && reverify) notes.push("no shared files does not mean no interaction: shared types, configuration or runtime state can still conflict");
  const value: IntegrationAssessment = { schemaVersion: 1, id: validationHash("pf.Integration", { b: [...i.candidateBindings].sort(), s: live.contentRootHash }), compatible: !conflicts.length, conflicts, reverify, integratedContentHash: integrated, overlaps, order, notes };
  return { status: conflicts.length ? "PARTIAL" : "COMPLETE", value, evidenceIds: cands.map((c) => c.id), diagnostics: [...conflicts, ...notes] };
}

// ------------------------------------------------------------------------------------------------ origins

export function getMutationOrigins(d: CoordDeps, actor: Id, i: { repositoryId: Id; path: string; revision: string }): Outcome<MutationLineage> {
  if (typeof i.path !== "string" || unsafePath(i.path)) throw new FeatureError("INVALID_SCHEMA", "a safe repository-relative path is required");
  if (policyFor(d.store, i.repositoryId).denied(i.path)) throw new FeatureError("NOT_FOUND", "no such file");
  const origins: MutationLineage["origins"] = []; const gaps: string[] = [];
  for (const r of d.fs.listRequests(i.repositoryId, 1000)) {
    if (r.createdBy !== actor) continue;
    for (const c of d.fs.listCandidates(r.requestId)) {
      if (c.status === "SUPERSEDED" && !c.publication) continue;
      if (!pathsOf(c).includes(i.path)) continue;
      const ev = d.fs.listEvents(r.requestId, 0, 1000).find((e) => e.type === "CandidateCreated" && e.after === c.bindingHash);
      origins.push({ requestId: r.requestId, eventId: ev?.eventId ?? "", ...(c.publication?.commit ? { commit: c.publication.commit } : {}) });
    }
  }
  if (!origins.length) gaps.push("no request of yours changed this file; changes by other people or outside CIE are not recorded here");
  return { status: "PARTIAL", value: { schemaVersion: 1, id: validationHash("pf.Lineage", { p: i.path, r: i.revision, o: origins }), path: i.path, origins }, evidenceIds: [], diagnostics: ["only your own requests are listed", ...gaps] };
}

// ------------------------------------------------------------------------------------------------ retirement

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function assessRetirement(d: CoordDeps, actor: Id, i: { requestId: Id; candidateHash: string }): Outcome<ImpactAssessment> {
  const rec = own(d, actor, i.requestId); const c = d.fs.getCandidateByBinding(i.candidateHash);
  if (!c || c.requestId !== rec.requestId) throw new FeatureError("NOT_FOUND", "no such candidate");
  const removed = c.mutations.filter((m) => m.kind === "DELETED" || m.kind === "RENAMED").map((m) => m.oldPath!);
  if (!removed.length) return { status: "COMPLETE", value: { schemaVersion: 1, id: validationHash("pf.Retirement", { c: c.bindingHash }), affectedIds: [], staleIds: [], consumers: [], gaps: [], reasons: ["the candidate removes or moves no file"] }, evidenceIds: [], diagnostics: [] };
  const policy = policyFor(d.store, rec.repositoryId); const touched = new Set(pathsOf(c));
  const files = walkFiles(rec.repositoryId, (p) => /\.[cm]?[jt]sx?$|\.(json|ya?ml|md)$/.test(p) && !policy.denied(p) && !touched.has(p), 5000);
  const consumers = new Set<string>();
  for (const f of files) {
    let text: string; try { text = readFileSync(safeJoin(rec.repositoryId, f), "utf8"); } catch { continue; }
    for (const r of removed) { const stem = r.replace(/\.[cm]?[jt]sx?$/, ""); const base = stem.split("/").pop()!; if (new RegExp(`(from|require\\(|import\\()\\s*['"][^'"]*${escape(base)}(\\.[cm]?[jt]s)?['"]`).test(text) || text.includes(r)) consumers.add(`${f} → ${r}`); }
  }
  const gaps = ["consumers outside this repository (other services, scripts, deployed configuration, dynamic imports and reflection) cannot be enumerated from here: the unknown-consumer gap stays open until an owner confirms none exist"];
  const checklist = ["Name an owner for each static consumer below and migrate or confirm it", "Deprecate before removal: keep a compatibility path for an agreed window, or record why not", "Confirm no external consumer exists, or notify them", "Remove behind a flag or release step that can be reverted (a revert is a new candidate)"];
  return { status: "PARTIAL", value: { schemaVersion: 1, id: validationHash("pf.Retirement", { c: c.bindingHash, k: [...consumers].sort() }), affectedIds: removed, staleIds: [], consumers: [...consumers].sort(), gaps, reasons: checklist, regressionObligations: [...consumers].sort().map((x) => `re-run the tests that cover ${x.split(" → ")[0]}`) }, evidenceIds: [c.id], diagnostics: gaps };
}
