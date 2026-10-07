// Task 2.I — clarification planning and change impact (spec §7, §8.3; PF-008, PF-009, PF-013, PF-015, PF-019; AT-04, AT-05, AT-06).
//   * material unknowns become focused questions, two or three per batch, ranked by how much they could change what is built
//   * low-impact unknowns are visible assumptions; work continues (nothing waits on a preference)
//   * each question names the tasks it blocks; every other task keeps running
//   * a question already answered is not asked again, and elapsed time is never an answer
import { createHash } from "node:crypto";
import { FeatureError } from "./errors.ts";
import { applyBlocking, openFindings } from "./findings.ts";
import { eventFor } from "./lifecycle.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { FeatureRecord, FindingKind, Id, ImpactAssessment, Outcome, QuestionBatch, RequirementFinding, Snapshot } from "./types.ts";
import type { Store } from "../store.ts";
import { snapshotOf } from "./intake.ts";

export const BATCH_MAX = 3;
const KIND_RANK: Record<FindingKind, number> = { ACCESS_CONFLICT: 0, INVARIANT_VIOLATION: 1, CONTRADICTION: 2, DEPENDENCY_GAP: 3, IMPLEMENTATION_MISMATCH: 3, GAP: 4, AMBIGUITY: 5, TRADEOFF: 6, TERMINOLOGY: 7, DUPLICATE: 8, CHANGE_IMPACT: 9 };
const IMPACT_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
export const questionIdFor = (f: Pick<RequirementFinding, "id">): Id => `q:${f.id.split(":").pop()}`;
const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export const rankFindings = (fs: readonly RequirementFinding[]): RequirementFinding[] => [...fs].sort((a, b) =>
  (a.status === b.status ? 0 : a.status === "CONFIRMED" ? -1 : 1) || KIND_RANK[a.kind] - KIND_RANK[b.kind] || IMPACT_RANK[a.impact ?? "MEDIUM"] - IMPACT_RANK[b.impact ?? "MEDIUM"] || a.id.localeCompare(b.id));

/** Low-impact, non-conflicting unknowns do not need a person: they are shown as assumptions. */
export const isAssumptionOnly = (f: RequirementFinding): boolean => f.impact === "LOW" && f.status !== "CONFIRMED" && (f.kind === "AMBIGUITY" || f.kind === "DUPLICATE" || f.kind === "TERMINOLOGY");

function byContract(fs: SqliteFeatureStore, actor: Id, contractHash: string): FeatureRecord {
  for (const r of fs.listRequests(undefined, 1000)) if (r.createdBy === actor && r.contract?.hash === contractHash) return r;
  throw new FeatureError("NOT_FOUND", "no contract with that hash");
}

export function planClarifications(fs: SqliteFeatureStore, actor: Id, i: { contractHash: string; findingIds: Id[]; obligationIds: Id[] }): Outcome<QuestionBatch> {
  const rec = byContract(fs, actor, i.contractHash);
  if (!Array.isArray(i.findingIds) || !Array.isArray(i.obligationIds)) throw new FeatureError("INVALID_SCHEMA", "findingIds and obligationIds must be lists");
  const open = openFindings(rec); const wanted = new Set<Id>([...i.findingIds, ...i.obligationIds]);
  for (const id of wanted) if (!(rec.findings ?? []).some((f) => f.id === id)) throw new FeatureError("NOT_FOUND", `no such finding ${id}`);
  const pool = wanted.size ? open.filter((f) => wanted.has(f.id)) : open;
  const decisions = fs.listDecisions(rec.requestId); const answered = (f: RequirementFinding) => decisions.some((d) => d.questionId === questionIdFor(f) || d.questionId === f.id || d.findingId === f.id);
  const askable = rankFindings(pool.filter((f) => !isAssumptionOnly(f) && !answered(f)));
  const assumptions = pool.filter(isAssumptionOnly).map((f) => f.id);
  // pick the top item, then related items (same requirement) first, up to the batch size
  const batch: RequirementFinding[] = [];
  const rest = [...askable];
  while (batch.length < BATCH_MAX && rest.length) {
    const next = batch.length ? rest.findIndex((f) => f.requirementIds.some((r) => batch.some((b) => b.requirementIds.includes(r)))) : 0;
    batch.push(...rest.splice(next >= 0 ? next : 0, 1));
  }
  const deferred = rest.map((f) => f.id);
  // the tasks a question holds: those that name its requirements, and every task that depends on one of those
  const tasksFor = (f: RequirementFinding) => {
    const held = new Set<Id>(rec.tasks.filter((t) => t.requirementIds.some((r) => f.requirementIds.includes(r))).map((t) => t.id));
    for (let grew = true; grew;) { grew = false; for (const t of rec.tasks) if (!held.has(t.id) && t.dependencyTaskIds.some((x) => held.has(x))) { held.add(t.id); grew = true; } }
    return rec.tasks.filter((t) => held.has(t.id)).map((t) => t.id);
  };
  const questions = batch.map((f, n) => ({
    id: questionIdFor(f), text: `${f.explanation}${f.kind === "CONTRADICTION" ? " Which applies?" : ""}`.slice(0, 400), choices: f.options.map((o) => o.description), scope: f.scope,
    whyNeeded: `Blocks ${f.requirementIds.join(", ") || "request progress"}${tasksFor(f).length ? ` (tasks ${tasksFor(f).join(", ")})` : ""}; ${f.scope} authority is required to decide it.`, blocks: tasksFor(f),
    dependsOn: batch.slice(0, n).filter((e) => KIND_RANK[e.kind] <= KIND_RANK.CONTRADICTION && KIND_RANK[f.kind] > KIND_RANK.CONTRADICTION && e.requirementIds.some((r) => f.requirementIds.includes(r))).map(questionIdFor),
  }));
  // record them as blockers so the wizard and the blocked-task list show exactly what is waiting
  if (questions.length) {
    for (let attempt = 0; ; attempt++) {
      const cur = fs.getRequest(rec.requestId)!;
      const add = questions.filter((q) => !cur.blockers.some((b) => b.id === q.id)).map((q, n) => ({ id: q.id, kind: "QUESTION" as const, requirementIds: batch[questions.indexOf(q)]!.requirementIds, text: q.text, scope: q.scope, ...(q.dependsOn.length ? { dependsOn: q.dependsOn } : {}) }));
      if (!add.length) break;
      try { fs.updateRequest(rec.requestId, cur.version, { ...cur, blockers: [...cur.blockers, ...add], workspace: { ...cur.workspace, blockers: [...cur.blockers, ...add].map((b) => b.id), workspaceVersion: cur.workspace.workspaceVersion + 1 } }, eventFor(cur, "TaskBlocked", actor, { result: "BLOCKED", requirementIds: [...new Set(add.flatMap((b) => b.requirementIds))].slice(0, 20), rationale: `${add.length} question(s) asked (batch of ${questions.length}); independent work continues` })); break; }
      catch (e) { if (!(e instanceof FeatureError) || e.code !== "VERSION_CONFLICT" || attempt) throw e; }
    }
  }
  const state = applyBlocking(fs, rec.requestId, actor);
  const batchOut: QuestionBatch = { schemaVersion: 1, id: `batch:${shortHash(questions.map((q) => q.id).join(","))}`, questions, assumptions, deferred, independentTaskIds: state.independent };
  return { status: "COMPLETE", value: batchOut, evidenceIds: batch.map((f) => f.id), diagnostics: [
    ...(deferred.length ? [`${deferred.length} more question(s) wait for the next batch so a person is not asked everything at once`] : []),
    ...(assumptions.length ? [`${assumptions.length} low-impact point(s) are shown as assumptions; work continues and a person can correct them`] : []),
    ...(pool.some(answered) ? ["questions that were already answered were not asked again"] : []),
    "time passing is not approval: an unanswered material question stays open"] };
}

export function assessFeatureImpact(fs: SqliteFeatureStore, store: Store, actor: Id, i: { contractHash: string; snapshot: Snapshot }): Outcome<ImpactAssessment> {
  const rec = byContract(fs, actor, i.contractHash); const contract = rec.contract!;
  if (i.snapshot.repositoryId !== rec.repositoryId) throw new FeatureError("INVALID_SCHEMA", "the snapshot is for a different repository");
  if (i.snapshot.contentRootHash !== snapshotOf(store, rec.repositoryId).contentRootHash) return { status: "STALE", evidenceIds: [], diagnostics: ["the repository changed since this snapshot was taken"] };
  const reqIds = new Set(contract.requirements.map((r) => r.id)); const affected = new Set<Id>(); const stale = new Set<Id>(); const reasons: string[] = []; const gaps: string[] = [];
  for (const f of openFindings(rec)) { for (const r of f.requirementIds) affected.add(r); reasons.push(`open ${f.kind.toLowerCase()} finding on ${f.requirementIds.join(", ") || "the request"}`); }
  for (const t of rec.tasks) if (t.requirementIds.some((r) => !reqIds.has(r))) { affected.add(t.id); reasons.push(`task ${t.id} refers to a requirement that no longer exists`); }
  for (const a of contract.acceptance) if (a.requirementIds.some((r) => !reqIds.has(r))) { affected.add(a.id); reasons.push(`criterion ${a.id} refers to a requirement that no longer exists`); }
  for (const c of fs.listCandidates(rec.requestId)) {
    if (c.binding.contractHash !== contract.hash) { stale.add(c.id); reasons.push(`candidate ${c.id} was built from a different contract`); for (const e of fs.listEvidence(c.id)) stale.add(e.id); }
    else for (const e of fs.listEvidence(c.id)) if (e.manifest.contractHash !== contract.hash) { stale.add(e.id); reasons.push(`evidence ${e.id} was recorded against a different contract`); }
  }
  if (!rec.tasks.length) gaps.push("no tasks are planned yet, so task impact cannot be assessed");
  if (!reasons.length) reasons.push("nothing recorded depends on an outdated contract");
  return { status: "COMPLETE", value: { schemaVersion: 1, id: `impact:${shortHash(JSON.stringify([contract.hash, [...affected].sort(), [...stale].sort()]))}`, affectedIds: [...affected].sort(), staleIds: [...stale].sort(), reasons, gaps }, evidenceIds: [contract.hash], diagnostics: gaps };
}
