// 2.N: bounded read models derived from recorded contracts, plans and actual mutation inventory.
import type { ViewSpec } from "@cie/schema";
import { policyFor } from "../access.ts";
import type { Store } from "../store.ts";
import { deliverView, validationDashboard } from "./dashboard.ts";
import { unevaluatedModels } from "./builder-eval.ts";
import { computeEligibility, defaultValidationPlan, validationHash, validationPlanHash } from "./validation.ts";
import type { AcceptanceCriterion, CandidateRecord, ChangeGraphPage, DecisionRecord, FeatureRecord, FeatureStore, Outcome, OverlapAssessment, PublicationDecision, Requirement, ValidationResult } from "./types.ts";
import { FeatureError } from "./errors.ts";
export type ReviewFile = { path: string; oldPath?: string; kind: "ADDED" | "MODIFIED" | "DELETED" | "RENAMED" | "REUSED" | "AFFECTED_UNCHANGED" | "PLANNED"; requirementIds: string[]; taskIds: string[]; componentIds: string[]; attribution: string; gaps: string[] };
export type FeatureReview = {
  prompt: string; requirements: Requirement[]; criteria: AcceptanceCriterion[]; decisions: DecisionRecord[];
  questions: { id: string; text: string; requirementIds: string[]; scope: string; choices: string[]; whyNeeded: string }[];
  tasks: FeatureRecord["tasks"]; overlap?: OverlapAssessment; files: ReviewFile[]; fileCounts: Record<string, number>;
  results: ValidationResult[]; decision?: PublicationDecision; validationPlanHash?: string; gaps: string[];
  /** 3.P: the Validate and Deliver read models, derived from the same evidence and eligibility. */
  dashboard?: import("./dashboard.ts").Dashboard; deliver?: import("./dashboard.ts").DeliverView;
};
export function reviewFiles(request: FeatureRecord, candidate: CandidateRecord | null): ReviewFile[] {
  const componentIds = (ids: string[]) => [...new Set(request.tasks.filter((t) => ids.includes(t.id)).map((t) => t.componentId))];
  if (candidate) return candidate.mutations.map((m) => ({ path: (m.newPath ?? m.oldPath)!, oldPath: m.oldPath, kind: m.kind, requirementIds: m.requirementIds, taskIds: m.taskIds, componentIds: componentIds(m.taskIds), attribution: m.attribution,
    gaps: ["Attribution links the file mutation to requirements; individual lines do not establish unique causation.", ...(m.attribution !== "COMPLETE" ? ["Some mutation origins are missing."] : [])] }));
  const planned = new Map<string, ReviewFile>();
  for (const t of request.tasks) for (const path of t.plannedEdits) {
    const prior = planned.get(path);
    planned.set(path, { path, kind: "PLANNED", requirementIds: [...new Set([...(prior?.requirementIds ?? []), ...t.requirementIds])], taskIds: [...new Set([...(prior?.taskIds ?? []), t.id])], componentIds: [...new Set([...(prior?.componentIds ?? []), t.componentId])], attribution: "PLANNED", gaps: ["Planned path; no file mutation is claimed."] });
  }
  return [...planned.values()];
}
export function featureReview(fs: FeatureStore, request: FeatureRecord, candidate: CandidateRecord | null, sourceStore?: Store): FeatureReview {
  const base = featureReviewBase(fs, request, candidate, sourceStore);
  return { ...base, dashboard: validationDashboard(fs, request, candidate, base.decision), deliver: deliverView(fs, request, candidate) };
}
function featureReviewBase(fs: FeatureStore, request: FeatureRecord, candidate: CandidateRecord | null, sourceStore?: Store): FeatureReview {
  const files = reviewFiles(request, candidate);
  const allowed = sourceStore ? files.filter((f) => !policyFor(sourceStore, request.repositoryId).denied(f.path) && (!f.oldPath || !policyFor(sourceStore, request.repositoryId).denied(f.oldPath))) : files;
  // Planned edits are paths too: a denied one is dropped and only counted (issue #86).
  const denied = sourceStore ? policyFor(sourceStore, request.repositoryId).denied : () => false;
  const tasks = request.tasks.map((t) => ({ ...t, plannedEdits: t.plannedEdits.filter((p) => !denied(p)) }));
  const hiddenEdits = request.tasks.reduce((n, t) => n + t.plannedEdits.filter((p) => denied(p)).length, 0);
  const evidence = candidate ? fs.listEvidence(candidate.id) : [];
  const plan = candidate ? request.validationPlan ?? defaultValidationPlan(request, candidate) : undefined;
  const decisions = fs.listDecisions(request.requestId);
  return { prompt: request.promptRef.text ?? request.promptRef.redactedPreview, requirements: request.contract?.requirements ?? [], criteria: request.contract?.acceptance ?? [], decisions,
    questions: request.blockers.map((b) => ({ id: b.id, text: b.text, requirementIds: b.requirementIds, scope: b.scope ?? "business", choices: [], whyNeeded: `Blocks ${b.requirementIds.join(", ") || "request progress"}; ${b.scope ?? "business"} authority is required.` })),
    tasks, overlap: request.contract?.overlap, files: allowed,
    fileCounts: Object.fromEntries(["ADDED", "MODIFIED", "DELETED", "RENAMED", "REUSED", "AFFECTED_UNCHANGED", "PLANNED"].map((k) => [k, allowed.filter((f) => f.kind === k).length])),
    results: evidence.flatMap((e) => e.results), ...(candidate && plan ? { validationPlanHash: validationPlanHash(plan), decision: computeEligibility({ request, candidate, plan, evidence, decisions, unevaluatedModels: unevaluatedModels(fs as { getEvaluation?: never }, request, candidate) }) } : {}),
    gaps: [...(!request.contract ? ["No contract draft recorded."] : []), ...(!request.contract?.overlap ? ["Overlap assessment has not been recorded."] : []), ...(allowed.length !== files.length || hiddenEdits ? ["Some files are outside your source access scope; counts cover visible inventory only."] : [])] };
}
export function compileChangeGraph(request: FeatureRecord, files: ReviewFile[], input: { candidateHash?: string; filters?: Record<string, string>; cursor?: string; budget: { nodes: number } }): Outcome<ChangeGraphPage> {
  if (!Number.isInteger(input.budget.nodes) || input.budget.nodes < 3 || input.budget.nodes > 300) throw new FeatureError("INVALID_SCHEMA", "graph node budget must be 3..300");
  const filters = input.filters ?? {};
  const identity = validationHash("pf.ChangeGraphScope", { requestId: request.requestId, workspaceVersion: request.workspace.workspaceVersion, candidateHash: input.candidateHash ?? "", filters });
  let offset = 0;
  if (input.cursor) { const [hash, n] = input.cursor.split("|"); if (hash !== identity || !/^\d+$/.test(n ?? "")) throw new FeatureError("STALE_REVISION", "graph cursor no longer matches this view"); offset = Number(n); }
  const wanted = files.filter((f) => (!filters.requirementId || f.requirementIds.includes(filters.requirementId)) && (!filters.componentId || f.componentIds.includes(filters.componentId)) && (!filters.status || f.kind === filters.status) && (!filters.path || f.path.toLowerCase().includes(filters.path.toLowerCase())) && (!filters.gap || f.attribution !== "COMPLETE"));
  // Three layers share the budget. A bounded page never pretends to represent the whole repository.
  const count = Math.max(1, Math.floor(input.budget.nodes / 3)); const page = wanted.slice(offset, offset + count);
  const view: ViewSpec = { id: identity, version: request.workspace.workspaceVersion, revision: request.source.commitHash, taskId: request.requestId, formId: "SemanticDiff", caption: "Requirements → components → files", question: "What changes and why?", level: 5, nodes: [], edges: [], groups: [], legend: [], cameraPolicy: { behavior: "PRESERVE" }, gaps: [] };
  const add = (id: string, label: string, kind: string, layer: number, file = "") => { if (!view.nodes.some((n) => n.id === id) && view.nodes.length < input.budget.nodes) view.nodes.push({ id, label, kind, file, entityRefs: [], claimIds: [], evidenceIds: [], tier: "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, layer }); };
  const edge = (from: string, to: string, kind: string) => { if (view.nodes.some((n) => n.id === from) && view.nodes.some((n) => n.id === to)) { const id = `${from}->${to}:${kind}`; if (!view.edges.some((e) => e.id === id)) view.edges.push({ id, fromNodeId: from, toNodeId: to, kind, label: kind, evidenceIds: [], displayMode: kind === "potential-impact" ? "INFERENCE" : "FACT" }); } };
  for (const f of page) {
    add(`file:${f.path}`, `${f.kind}: ${f.path}`, "file", 2, f.path);
    for (const component of f.componentIds.length ? f.componentIds : ["unassigned"]) {
      add(`component:${component}`, component, "component", 1); edge(`component:${component}`, `file:${f.path}`, f.kind === "REUSED" ? "reuses" : f.kind === "PLANNED" ? "potential-impact" : "affects");
      for (const id of f.requirementIds) { add(`requirement:${id}`, request.contract?.requirements.find((r) => r.id === id)?.text ?? id, "requirement", 0); edge(`requirement:${id}`, `component:${component}`, "implements"); }
    }
  }
  if (offset + page.length < wanted.length) view.gaps.push(`Showing ${page.length} of ${wanted.length} matching files. Continue to the next page.`);
  if (view.nodes.length >= input.budget.nodes) view.gaps.push("Node budget reached; use the equivalent file list for all attribution links.");
  return { status: view.gaps.length ? "PARTIAL" : "COMPLETE", value: { viewSpec: view, presentationManifest: { identity, candidateHash: input.candidateHash, shown: page.length, total: wanted.length, files: page }, ...(offset + page.length < wanted.length ? { nextCursor: `${identity}|${offset + page.length}` } : {}) }, evidenceIds: [], diagnostics: view.gaps };
}
