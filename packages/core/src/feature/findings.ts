// Task 2.I — shared handling of RequirementFindings (spec §8). Ids are deterministic so a re-run recognises a finding it already
// raised; a person's resolution or dismissal is never overwritten by a re-run; a finding whose cause is gone is dropped.
import { createHash } from "node:crypto";
import { FeatureError } from "./errors.ts";
import { eventFor } from "./lifecycle.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { FeatureRecord, FindingKind, Id, RequirementFinding, ResolutionOption } from "./types.ts";

export const findingId = (rule: string, ...parts: string[]): Id => `finding:${rule}:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16)}`;
export const opt = (id: string, description: string, requiredAuthority: string, impacts: string[] = []): ResolutionOption => ({ id, description, impacts, requiredAuthority });

/** Authority scope a finding needs to be resolved (plan S7). Unknown kinds take the strict one. */
export const scopeOfKind = (kind: FindingKind): string => kind === "ACCESS_CONFLICT" ? "access" : kind === "INVARIANT_VIOLATION" ? "policy" : kind === "CONTRADICTION" || kind === "TRADEOFF" ? "business" : kind === "GAP" || kind === "AMBIGUITY" || kind === "TERMINOLOGY" || kind === "DUPLICATE" ? "business" : kind === "IMPLEMENTATION_MISMATCH" ? "security" : kind === "DEPENDENCY_GAP" ? "business" : "business";

const OPEN = (f: RequirementFinding) => f.status === "POTENTIAL" || f.status === "CONFIRMED";
export const openFindings = (rec: FeatureRecord): RequirementFinding[] => (rec.findings ?? []).filter(OPEN);

/**
 * Merge a detector's fresh findings into the stored list.
 *   - a stored finding the person already RESOLVED or DISMISSED is kept exactly as it is
 *   - a stored open finding from a rule this run covered, that this run did not raise again, is dropped (its cause is gone)
 *   - everything else is replaced by the fresh version
 */
export function mergeFindings(existing: readonly RequirementFinding[], fresh: readonly RequirementFinding[], coveredRules: ReadonlySet<string>): RequirementFinding[] {
  const closed = new Map(existing.filter((f) => !OPEN(f)).map((f) => [f.id, f]));
  const out = new Map<Id, RequirementFinding>();
  for (const f of existing) { if (!OPEN(f)) out.set(f.id, f); else if (!(f.rule && coveredRules.has(f.rule))) out.set(f.id, f); }
  for (const f of fresh) out.set(f.id, closed.get(f.id) ?? f);
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Persist findings with their events; retries once if the request moved. Returns the stored request. */
export function saveFindings(fs: SqliteFeatureStore, requestId: Id, actor: Id, fresh: readonly RequirementFinding[], coveredRules: ReadonlySet<string>, rationale: string): FeatureRecord {
  for (let attempt = 0; ; attempt++) {
    const cur = fs.getRequest(requestId); if (!cur) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
    const known = new Set((cur.findings ?? []).map((f) => f.id));
    const raised = fresh.filter((f) => !known.has(f.id) && (f.status === "CONFIRMED" || f.impact === "HIGH"));
    const findings = mergeFindings(cur.findings ?? [], fresh, coveredRules);
    try {
      return fs.updateRequest(requestId, cur.version, { ...cur, findings, workspace: { ...cur.workspace, workspaceVersion: cur.workspace.workspaceVersion + 1 } },
        raised.length ? eventFor(cur, "RequirementFindingRaised", actor, { result: "BLOCKED", requirementIds: [...new Set(raised.flatMap((f) => f.requirementIds))].slice(0, 20), rationale: `${rationale}: ${raised.length} new finding(s) (${raised.map((f) => `${f.kind}/${f.status}`).join(", ")})`.slice(0, 400) }) : eventFor(cur, "StateChanged", actor, { rationale: `${rationale}: no new blocking findings`, producer: "C15" }));
    } catch (e) { if (!(e instanceof FeatureError) || e.code !== "VERSION_CONFLICT" || attempt) throw e; }
  }
}

/**
 * Dependency-aware blocking (spec §7.2, PF-009; AT-06): a task is blocked when an OPEN finding or question names one of its
 * requirements, and so is any task that depends on a blocked task. Every other task is left exactly as it was.
 * Returns the ids of the tasks that are now blocked and of those still free to run.
 */
export function applyBlocking(fs: SqliteFeatureStore, requestId: Id, actor: Id): { blocked: Id[]; independent: Id[] } {
  for (let attempt = 0; ; attempt++) {
    const cur = fs.getRequest(requestId); if (!cur) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
    const held = new Set<Id>();
    for (const f of openFindings(cur)) for (const r of f.requirementIds) held.add(r);
    // FINDING blockers are derived from the open findings above, so they are rebuilt below and must not hold anything themselves
    for (const b of cur.blockers) if (b.kind === "QUESTION") for (const r of b.requirementIds) held.add(r);
    const blocked = new Set<Id>(cur.tasks.filter((t) => t.requirementIds.some((r) => held.has(r))).map((t) => t.id));
    for (let grew = true; grew;) { grew = false; for (const t of cur.tasks) if (!blocked.has(t.id) && t.dependencyTaskIds.some((d) => blocked.has(d))) { blocked.add(t.id); grew = true; } }
    const taskOf = (f: RequirementFinding) => cur.tasks.filter((t) => blocked.has(t.id) && t.requirementIds.some((r) => f.requirementIds.includes(r))).map((t) => t.id);
    const findings = (cur.findings ?? []).map((f) => (OPEN(f) ? { ...f, blockingTaskIds: taskOf(f) } : f));
    const tasks = cur.tasks.map((t) => (blocked.has(t.id) ? (t.state === "READY" || t.state === "RUNNING" || t.state === "BLOCKED" ? { ...t, state: "BLOCKED" as const } : t) : (t.state === "BLOCKED" ? { ...t, state: "READY" as const } : t)));
    const wanted = openFindings({ ...cur, findings }).filter((f) => f.status === "CONFIRMED" || f.impact === "HIGH");
    const keep = cur.blockers.filter((b) => b.kind !== "FINDING" || wanted.some((f) => f.id === b.id));
    const added = wanted.filter((f) => !keep.some((b) => b.id === f.id)).map((f) => ({ id: f.id, kind: "FINDING" as const, requirementIds: f.requirementIds, text: f.explanation.slice(0, 300), scope: f.scope }));
    const blockers = [...keep, ...added];
    const same = JSON.stringify([tasks, blockers, findings]) === JSON.stringify([cur.tasks, cur.blockers, cur.findings ?? []]);
    const result = { blocked: tasks.filter((t) => t.state === "BLOCKED").map((t) => t.id), independent: tasks.filter((t) => t.state !== "BLOCKED" && t.state !== "COMPLETE" && t.state !== "CANCELLED").map((t) => t.id) };
    if (same) return result;
    try {
      fs.updateRequest(requestId, cur.version, { ...cur, tasks, blockers, findings, workspace: { ...cur.workspace, blockers: blockers.map((b) => b.id), workspaceVersion: cur.workspace.workspaceVersion + 1 } },
        eventFor(cur, "TaskBlocked", actor, { result: result.blocked.length ? "BLOCKED" : "OK", requirementIds: [...held].slice(0, 20), rationale: `${result.blocked.length} task(s) blocked by open items; ${result.independent.length} independent task(s) continue` }));
      return result;
    } catch (e) { if (!(e instanceof FeatureError) || e.code !== "VERSION_CONFLICT" || attempt) throw e; }
  }
}
