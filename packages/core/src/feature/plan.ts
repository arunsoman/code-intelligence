// Tasks 1.E / 2.I — turning an analysed contract into a plan (PF-018, PF-059; AT-49, AT-60). Deterministic: the same contract, impact
// and overlap always give the same tasks. A requirement becomes a task; where the overlap assessment found something to modify, the
// task names those files; where the behaviour is new, its files are decided when the candidate is built (the edit plan), so no path
// is invented here. The tier comes from the paths the plan actually names, never from the prompt.
import { createHash } from "node:crypto";
import type { Store } from "../store.ts";
import { assessFeatureImpact } from "./clarify.ts";
import { FeatureError } from "./errors.ts";
import { openFindings } from "./findings.ts";
import { eventFor } from "./lifecycle.ts";
import { alreadySupported } from "./overlap.ts";
import type { SqliteFeatureStore } from "./store.ts";
import { classifyTier } from "./tiers.ts";
import type { BehaviourMapping, FeatureRecord, FeaturePlan, FeatureTask, Id, Outcome, OverlapAssessment, Tier } from "./types.ts";

const tid = (rid: Id) => `t:${rid}`;
function byContract(fs: SqliteFeatureStore, actor: Id, hash: string): FeatureRecord {
  for (const r of fs.listRequests(undefined, 1000)) if (r.createdBy === actor && r.contract?.hash === hash) return r;
  throw new FeatureError("NOT_FOUND", "no contract with that hash");
}
const planId = (rec: FeatureRecord, tasks: FeatureTask[]) => `plan:${createHash("sha256").update(JSON.stringify([rec.contract!.hash, tasks.map((t) => [t.id, t.plannedEdits, t.dependencyTaskIds])])).digest("hex").slice(0, 24)}`;

function persist(fs: SqliteFeatureStore, rec: FeatureRecord, actor: Id, tasks: FeatureTask[], tier: Tier | undefined, rationale: string): void {
  for (let attempt = 0; ; attempt++) {
    const cur = fs.getRequest(rec.requestId)!;
    try { fs.updateRequest(rec.requestId, cur.version, { ...cur, tasks, tier: tier ?? cur.tier, workspace: { ...cur.workspace, workspaceVersion: cur.workspace.workspaceVersion + 1 } }, eventFor(cur, "StateChanged", actor, { producer: "C28", rationale })); return; }
    catch (e) { if (!(e instanceof FeatureError) || e.code !== "VERSION_CONFLICT" || attempt) throw e; }
  }
}

/** Tasks from requirements; files only where the overlap assessment named them and the caller allowed that capability. */
function buildTasks(rec: FeatureRecord, overlap: OverlapAssessment | undefined, allowed: ReadonlySet<Id>, onlyDispositions?: ReadonlySet<BehaviourMapping["disposition"]>): FeatureTask[] {
  const contract = rec.contract!; const open = openFindings(rec);
  const filesOf = (capIds: Id[]) => (overlap?.capabilities ?? []).filter((c) => capIds.includes(c.id) && allowed.has(c.id)).map((c) => c.sourceRefs[0]!.locator.slice(5));
  return contract.requirements.filter((r) => r.status !== "SUPERSEDED").flatMap((r): FeatureTask[] => {
    const maps = (overlap?.mappings ?? []).filter((m) => contract.acceptance.some((a) => a.id === m.acceptanceId && a.requirementIds.includes(r.id)) && (!onlyDispositions || onlyDispositions.has(m.disposition)));
    if (onlyDispositions && !maps.length) return [];
    const edits = [...new Set(maps.filter((m) => m.disposition === "MODIFIED").flatMap((m) => filesOf(m.capabilityIds)))].sort();
    const caps = [...new Set(maps.flatMap((m) => m.capabilityIds).filter((c) => allowed.has(c)))].sort();
    return [{ id: tid(r.id), componentId: edits[0]?.split("/").slice(0, 2).join("/") || "feature", requirementIds: [r.id], dependencyTaskIds: r.dependsOn.map(tid), obligationIds: open.filter((f) => f.requirementIds.includes(r.id)).map((f) => f.id).sort(), plannedEdits: edits, capabilityIds: caps, state: "READY", evidenceIds: [] }];
  });
}

export function planFeatureChange(d: { fs: SqliteFeatureStore; store: Store }, actor: Id, i: { contractHash: string; impactAssessmentId: Id; capabilities: string[] }): Outcome<FeaturePlan> {
  const rec = byContract(d.fs, actor, i.contractHash); if (!Array.isArray(i.capabilities)) throw new FeatureError("INVALID_SCHEMA", "capabilities must be a list of capability ids");
  const impact = assessFeatureImpact(d.fs, d.store, actor, { contractHash: i.contractHash, snapshot: rec.source });
  if (impact.status === "STALE") return { status: "STALE", evidenceIds: [], diagnostics: ["the repository changed since the request was analysed; run discovery again"] };
  if (impact.value!.id !== i.impactAssessmentId) throw new FeatureError("STALE_REVISION", "the impact assessment is out of date; assess the change again");
  const unknown = i.capabilities.filter((c) => !(rec.contract!.overlap?.capabilities ?? []).some((x) => x.id === c)); if (unknown.length) throw new FeatureError("NOT_FOUND", `no such capability: ${unknown.join(", ")}`);
  const tasks = buildTasks(rec, rec.contract!.overlap, new Set(i.capabilities));
  if (!tasks.length) throw new FeatureError("BLOCKED", "the contract has no active requirement to plan; normalise the requirements first");
  const paths = tasks.flatMap((t) => t.plannedEdits.map((path) => ({ path, kind: "MODIFIED" as const })));
  const tier = paths.length ? classifyTier(paths).tier : undefined;
  persist(d.fs, rec, actor, tasks, tier, `plan: ${tasks.length} task(s)${tier ? `, tier ${tier}` : ""}`);
  return { status: "COMPLETE", value: { schemaVersion: 1, id: planId(rec, tasks), tasks, tier: tier ?? "T1", reuse: rec.contract!.overlap?.mappings ?? [] }, evidenceIds: [impact.value!.id], diagnostics: [
    ...(tier ? [] : ["no file is named yet, so the tier is provisional (T1) until the candidate's files are known"]), ...tasks.filter((t) => t.obligationIds.length).map((t) => `${t.id} has ${t.obligationIds.length} open item(s) and will be held until they are settled`)] };
}

export function planReuseChange(d: { fs: SqliteFeatureStore; store: Store }, actor: Id, i: { contractHash: string; verifiedAssessmentId: Id; capabilities: string[] }): Outcome<FeaturePlan> {
  const rec = byContract(d.fs, actor, i.contractHash); const a = rec.contract!.overlap;
  if (!a || a.id !== i.verifiedAssessmentId) throw new FeatureError("NOT_FOUND", `no overlap assessment ${i.verifiedAssessmentId} on this contract`);
  if (!a.verified) throw new FeatureError("FORBIDDEN", "the overlap assessment is not verified; verify it before planning a reuse change");
  if (!Array.isArray(i.capabilities)) throw new FeatureError("INVALID_SCHEMA", "capabilities must be a list of capability ids");
  if (alreadySupported(rec)) {
    persist(d.fs, rec, actor, [], undefined, "plan: already supported, no change");
    return { status: "COMPLETE", value: { schemaVersion: 1, id: planId(rec, []), tasks: [], tier: "T0", reuse: a.mappings }, evidenceIds: [a.id], diagnostics: [`ALREADY_SUPPORTED by ${alreadySupported(rec)!.entryPoint}: there is nothing to change, and no file will be reported as changed`] };
  }
  const allowed = new Set(i.capabilities); const unknown = i.capabilities.filter((c) => !(a.capabilities ?? []).some((x) => x.id === c)); if (unknown.length) throw new FeatureError("NOT_FOUND", `no such capability: ${unknown.join(", ")}`);
  const change = new Set<BehaviourMapping["disposition"]>(a.strategy === "CONFIGURE" ? ["REUSED"] : ["MODIFIED", "NEW"]);
  const tasks = buildTasks(rec, a, allowed, change);
  if (a.strategy === "CONFIGURE") for (const t of tasks) { const cfg = (a.observations ?? []).filter((o) => o.kind === "CONFIG_FLAG").map((o) => o.path); t.plannedEdits = [...new Set(cfg)].sort(); t.componentId = "configuration"; }
  // behaviour that is reused must keep working: its tests become explicit regression tasks with nothing to edit
  const regression: FeatureTask[] = (a.regressionObligations ?? []).length ? [{ id: "t:regression", componentId: "regression", requirementIds: [...new Set(a.mappings.filter((m) => m.disposition === "REUSED" || m.disposition === "MODIFIED").flatMap((m) => rec.contract!.acceptance.find((x) => x.id === m.acceptanceId)?.requirementIds ?? []))].sort(), dependencyTaskIds: tasks.map((t) => t.id), obligationIds: [], plannedEdits: [], capabilityIds: [...allowed].sort(), state: "READY", evidenceIds: [] }] : [];
  const all = [...tasks, ...regression];
  const paths = all.flatMap((t) => t.plannedEdits.map((path) => ({ path, kind: "MODIFIED" as const }))); const tier = paths.length ? classifyTier(paths).tier : undefined;
  persist(d.fs, rec, actor, all, tier, `reuse plan (${a.strategy}): ${all.length} task(s)`);
  return { status: "COMPLETE", value: { schemaVersion: 1, id: planId(rec, all), tasks: all, tier: tier ?? "T1", reuse: a.mappings }, evidenceIds: [a.id], diagnostics: [`strategy ${a.strategy}`, ...(a.regressionObligations ?? []).map((r) => `regression: ${r}`)] };
}
