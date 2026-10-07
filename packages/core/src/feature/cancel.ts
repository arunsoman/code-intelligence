// Task 1.F — cancelFeature. Stops the request's running jobs where they can still stop, moves the request to CANCELLED, and
// says plainly what it could NOT undo (a job already saving, a published pull request, a bound issue).
import { FeatureError } from "./errors.ts";
import { eventFor, TERMINAL } from "./lifecycle.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { CancellationReceipt, Id } from "./types.ts";

export interface JobControlLike { cancel(jobId: string): { cancelled: boolean; reason?: string } | null }

export function cancelFeature(fs: SqliteFeatureStore, jobs: JobControlLike, actor: Id, i: { requestId: Id; reason: string }): CancellationReceipt {
  const rec = fs.getRequest(i.requestId);
  if (!rec) throw new FeatureError("NOT_FOUND", `no such request ${i.requestId}`);
  if (rec.createdBy !== actor) throw new FeatureError("FORBIDDEN", "only the requester can cancel this request");
  if (typeof i.reason !== "string" || !i.reason.trim() || i.reason.length > 2000) throw new FeatureError("INVALID_SCHEMA", "a reason is required (at most 2000 characters)");
  const receipt = (stopped: Id[], effects: string[]): CancellationReceipt => ({ schemaVersion: 1, id: `cancel:${rec.requestId}`, requestId: rec.requestId, stoppedJobIds: stopped, externalEffects: effects });
  if (TERMINAL.has(rec.state)) {
    if (rec.state === "CANCELLED") return receipt([], []);
    throw new FeatureError("ILLEGAL_TRANSITION", `the request already ended as ${rec.state}`);
  }
  const stopped: Id[] = [], effects: string[] = [];
  for (const id of rec.workspace.runningJobIds) {
    const r = jobs.cancel(id);
    if (r?.cancelled) stopped.push(id);
    else effects.push(`job ${id} could not be stopped: ${r?.reason ?? "it no longer exists"}`);
  }
  for (const c of fs.listCandidates(rec.requestId)) if (c.publication) effects.push(`a draft pull request (${c.publication.remoteRef ?? c.publication.id}) was already published and is NOT closed by this action`);
  if (rec.issue.number) effects.push(`issue #${rec.issue.number} in ${rec.issue.repository} is not closed by this action`);
  // A concurrent update may have moved the version; re-read and retry once rather than losing the cancel.
  for (let attempt = 0; ; attempt++) {
    const cur = fs.getRequest(i.requestId)!;
    if (cur.state === "CANCELLED") break;
    try {
      fs.updateRequest(cur.requestId, cur.version, { ...cur, state: "CANCELLED", tasks: cur.tasks.map((t) => t.state === "RUNNING" || t.state === "READY" ? { ...t, state: "CANCELLED" as const } : t),
        workspace: { ...cur.workspace, runningJobIds: cur.workspace.runningJobIds.filter((j) => !stopped.includes(j)), workspaceVersion: cur.workspace.workspaceVersion + 1 } },
        eventFor(cur, "Cancelled", actor, { rationale: i.reason.trim().slice(0, 500) + (effects.length ? ` (${effects.length} effect(s) not undone)` : "") }));
      break;
    } catch (e) { if (!(e instanceof FeatureError) || e.code !== "VERSION_CONFLICT" || attempt) throw e; }
  }
  return receipt(stopped, effects);
}
