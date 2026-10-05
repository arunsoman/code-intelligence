// Task 3.T — C30/syncCapabilityRelations: tell the bound issue which of the person's other requests this one relates to.
// Allowlisted text only (relationship words and request ids), through the same fail-closed guard as the issue trail; one comment per
// distinct set of relations (a marker makes a retry find its own comment instead of posting twice).
import { rawHash } from "./canon.ts";
import { FeatureError } from "./errors.ts";
import type { IssueForge } from "./issue-forge.ts";
import { guardOutgoing } from "./issue-trail.ts";
import { relationsOf, type CoordDeps } from "./coordination.ts";
import type { Id, IssueSyncReceipt } from "./types.ts";

export async function syncCapabilityRelations(d: CoordDeps & { forge: IssueForge }, actor: Id, i: { requestId: Id; assessmentId: Id; relationIds: Id[] }): Promise<IssueSyncReceipt> {
  const rec = d.fs.getRequest(i.requestId);
  if (!rec || rec.createdBy !== actor) throw new FeatureError("NOT_FOUND", `no such request ${i.requestId}`);
  if (!rec.issue.number || !rec.issue.repository) throw new FeatureError("BLOCKED", "no issue is bound to this request");
  if (!Array.isArray(i.relationIds) || !i.relationIds.length) throw new FeatureError("INVALID_SCHEMA", "relationIds must name at least one relation");
  const all = relationsOf(d, actor, rec.requestId); const picked = i.relationIds.map((id) => all.find((r) => r.id === id));
  if (picked.some((r) => !r)) throw new FeatureError("NOT_FOUND", "no such relation for this request");
  const lines = (picked as NonNullable<(typeof picked)[number]>[]).map((r) => `- \`${r.fromRequestId}\` ${r.relationship.toLowerCase().replace(/_/g, " ")} \`${r.toRequestId}\` (${r.state.toLowerCase()})`).sort();
  const marker = `<!-- cie-relations:${rawHash(`${rec.requestId}\0${lines.join("\n")}`).slice(0, 24)} -->`;
  const body = guardOutgoing(rec, `${marker}\n**CIE related requests**\n${lines.join("\n")}\n_Recorded by CIE; relations are proposals until verified._`, rec.issue.visibility ?? "PUBLIC_OR_UNKNOWN");
  const existing = (await d.forge.recentComments(rec.issue.repository, rec.issue.number)).find((c) => c.body.includes(marker));
  const remote = existing ?? await d.forge.createComment(rec.issue.repository, rec.issue.number, body);
  return { schemaVersion: 1, id: `relsync:${marker.slice(20, 40)}`, throughSequence: rec.issue.lastSyncedSequence, remoteIds: [String(remote.id)], sent: existing ? 0 : 1, skipped: existing ? 1 : 0, state: rec.issue.syncState };
}
