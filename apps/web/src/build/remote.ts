// Connects the wizard shell to the backend operations C01/openFeatureWorkspace and C02/advanceWizard (task 1.C/1.B handlers).
// Only what the server owns is taken from it: the request id, stage, workspace version, contract version, outcome mode, issue
// reference and candidate pointer. Everything else is shown only when the server has produced it (the review), so nothing here can
// look more complete than it is.
import type { WizardWorkspace } from "./wizard.ts";
import type { WizardStage } from "./stages.ts";
import type { FeatureReview } from "../../../../packages/core/src/feature/presentation.ts";

export type RemoteCall = <T>(component: string, op: string, body?: unknown, idempotencyKey?: string) => Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string; currentVersion?: number } }>;

type ServerWorkspace = {
  requestId: string; stage: WizardStage; workspaceVersion: number; contractVersion?: number; mode?: string; candidateHash?: string;
  candidateStatus?: "PLANNED" | "MATERIALIZED" | "STALE" | "SUPERSEDED"; issueRef?: string;
  review?: FeatureReview;
};
type OpenOutcome = { status: string; value?: ServerWorkspace; diagnostics: string[] };

export const MODE_LABEL: Record<string, string> = { PLAN: "PLAN_ONLY", BUILD_PREVIEW: "BUILD_AND_PREVIEW", CREATE_DRAFT_PR: "DRAFT_PR" };

export function mergeServer(ws: WizardWorkspace, s: ServerWorkspace): WizardWorkspace {
  return {
    ...ws, requestId: s.requestId, stage: s.stage, workspaceVersion: s.workspaceVersion, contractVersion: s.contractVersion ?? ws.contractVersion,
    outcomeMode: s.mode ? MODE_LABEL[s.mode] ?? s.mode : ws.outcomeMode, issueRef: s.issueRef,
    candidate: s.candidateHash ? { hash: s.candidateHash, status: s.candidateStatus ?? "MATERIALIZED" } : null,
    updatedAt: new Date().toISOString(),
    ...(s.review ? {
      review: s.review, prompt: s.review.prompt,
      criteria: s.review.criteria.map((a) => ({ id: a.id, text: `${a.scenario} → ${a.expectedOutcome}`, mandatory: a.mandatory, implemented: !!s.candidateHash && s.review!.files.some((f) => f.requirementIds.some((id) => a.requirementIds.includes(id))), validation: s.review!.results.filter((r) => r.acceptanceId === a.id).at(-1)?.status ?? "NOT_RUN" })),
      decisions: s.review.decisions.map((d) => ({ id: d.id, questionId: d.questionId ?? d.id, question: d.questionId ?? d.id, answer: d.answer, actor: d.actorId, stage: "CLARIFY" as const, supersedesId: d.supersedesId })),
      tasks: s.review.tasks.map((t) => ({ id: t.id, label: `${t.componentId}: ${t.plannedEdits.join(", ")}`, state: t.state, requirementIds: t.requirementIds, blocker: s.review!.questions.find((q) => q.requirementIds.some((id) => t.requirementIds.includes(id)))?.text })),
      blockers: s.review.questions.map((q) => ({ id: q.id, text: q.text, requirementIds: q.requirementIds, question: q.id, nextAction: q.whyNeeded })),
      evidence: s.review.results.map((r) => ({ id: r.id, kind: r.kind, status: r.status === "STALE" ? "STALE" as const : "CURRENT" as const })),
      performance: "UNVALIDATED" as const,
    } : {}),
  };
}

/** Result of a remote step: the merged workspace, or a message the person can read (a version conflict reloads on the next open). */
export type RemoteResult = { ok: true; value: WizardWorkspace; unchanged?: boolean } | { ok: false; message: string; conflict?: boolean };

export async function openRemote(call: RemoteCall, ws: WizardWorkspace, requestId: string): Promise<RemoteResult> {
  const sinceWorkspaceVersion = ws.requestId === requestId ? ws.workspaceVersion : undefined;
  const r = await call<OpenOutcome>("C01", "openFeatureWorkspace", { requestId, sinceWorkspaceVersion });
  if (!r.ok) return { ok: false, message: r.error.message };
  if (!r.value.value) return { ok: true, value: ws, unchanged: true };
  return { ok: true, value: mergeServer(ws, r.value.value) };
}

export async function advanceRemote(call: RemoteCall, ws: WizardWorkspace, target: WizardStage): Promise<RemoteResult> {
  const r = await call<OpenOutcome>("C02", "advanceWizard", { requestId: ws.requestId, targetStage: target, expectedWorkspaceVersion: ws.workspaceVersion }, `advance-${ws.requestId}-${ws.workspaceVersion}-${target}`);
  if (!r.ok) return { ok: false, message: r.error.code === "VERSION_CONFLICT" ? `${r.error.message} Reloading the request will show the current state; nothing you recorded was lost.` : r.error.message, conflict: r.error.code === "VERSION_CONFLICT" };
  // The advance result carries the stage and version; the rest of the pointer set is unchanged, so re-open to merge a full read.
  const full = await openRemote(call, { ...ws, workspaceVersion: -1 }, ws.requestId);
  return full.ok && !full.unchanged ? full : { ok: true, value: { ...ws, stage: r.value.value?.stage ?? target, workspaceVersion: r.value.value?.workspaceVersion ?? ws.workspaceVersion + 1 } };
}
