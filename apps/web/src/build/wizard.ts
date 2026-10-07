import type { WizardStage } from "./stages.ts";
import type { FeatureReview } from "../../../../packages/core/src/feature/presentation.ts";

// Wizard-shell logic for the Build feature panel (spec §43.1, §30.2; plan tasks 1.H).
// Pure: the shapes mirror the frozen contracts in packages/core/src/feature/types.ts
// (FeatureWorkspace, advanceWizard in feature/api.ts) without the web app depending on packages/core.
// When the backend lands (1.B store, C02/advanceWizard), this module is the seam to swap.

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export type WizardTaskState = "READY" | "RUNNING" | "BLOCKED" | "COMPLETE" | "FAILED" | "CANCELLED" | "STALE";
export type WizardTask = {
  id: string;
  label: string;
  requirementIds: string[];
  state: WizardTaskState;
  /** Exact blocker text (§30.2: no generic "thinking"). */
  blocker?: string;
  /** The question/owner whose answer unblocks it; presence means "needs your answer". */
  questionId?: string;
  question?: string;
  nextAction?: string;
  /** What the wait is, so user/provider/queued are distinguishable (§30.2). */
  waiting?: "USER" | "PROVIDER" | "QUEUED";
};

export type CriterionStatus = "PASS" | "PASS_UNREVIEWED_ORACLE" | "FAIL" | "INCOMPLETE" | "STALE" | "NOT_RUN" | "NOT_APPLICABLE";
export type WizardCriterion = { id: string; text: string; implemented: boolean; mandatory: boolean; validation: CriterionStatus };

export type WizardDecision = {
  id: string;
  questionId: string;
  question: string;
  answer: string;
  stage: WizardStage;
  actor: string;
  supersedesId?: string;
};

export type WizardBlocker = {
  id: string;
  requirementIds: string[];
  text: string;
  question?: string;
  nextAction?: string;
};

export type WizardWorkspace = {
  requestId: string;
  stage: WizardStage;
  workspaceVersion: number;
  contractVersion: number;
  prompt: string;
  outcomeMode: string;
  issueRef?: string;
  candidate: { hash: string; status: "PLANNED" | "MATERIALIZED" | "STALE" | "SUPERSEDED" } | null;
  criteria: WizardCriterion[];
  tasks: WizardTask[];
  decisions: WizardDecision[];
  evidence: { id: string; kind: string; status: "CURRENT" | "STALE" }[];
  performance: "WITHIN_BUDGET" | "REGRESSION" | "INCONCLUSIVE" | "UNVALIDATED" | "NOT_APPLICABLE";
  blockers: WizardBlocker[];
  updatedAt: string;
  review?: FeatureReview;
};

/**
 * advanceWizard (frozen contract C02/advanceWizard): moving the view is a compare-and-swap on
 * workspaceVersion. A stale expectedVersion is a conflict, never a silent overwrite (AT-27; AT-69).
 * Navigation itself is always allowed — §43.1 browsing never approves or publishes anything; what a
 * blocked stage does is refuse its *primary action* (see stageGate), not the reading.
 */
export function advanceWizard(ws: WizardWorkspace, targetStage: WizardStage, expectedWorkspaceVersion: number): Outcome<WizardWorkspace> {
  if (expectedWorkspaceVersion !== ws.workspaceVersion) {
    return {
      ok: false,
      error: {
        code: "VERSION_CONFLICT",
        message: `Workspace ${ws.requestId} is at version ${ws.workspaceVersion}; you tried to move it from ${expectedWorkspaceVersion}. Re-open the request and retry — the recorded work was not changed.`,
      },
    };
  }
  return { ok: true, value: { ...ws, stage: targetStage, workspaceVersion: ws.workspaceVersion + 1, updatedAt: new Date().toISOString() } };
}

export type StageGate = {
  stage: WizardStage;
  /** The stage's primary action may run. */
  primaryEnabled: boolean;
  /** Why not, naming the exact blocker; null when primaryEnabled. */
  disabledReason: string | null;
  /** Unmet obligations shown when the user browses here (AT-68: explicit, not hidden). */
  visibleBlockers: WizardBlocker[];
};

/**
 * Per-stage prerequisites for the *primary action* (spec §43.2). Entering and reading a stage is always
 * allowed; only the effectful primary is gated. Material blockers stay visible either way, and work not
 * depending on them continues (AT-68).
 */
export function stageGate(ws: WizardWorkspace, stage: WizardStage): StageGate {
  const visible = ws.blockers;
  switch (stage) {
    case "DESCRIBE":
      return { stage, primaryEnabled: ws.prompt.trim().length > 0, disabledReason: ws.prompt.trim() ? null : "Describe what should change first.", visibleBlockers: visible };
    case "CLARIFY":
      // "Continue with ready work" never waits on blocked obligations: they stay listed, independent work continues.
      return { stage, primaryEnabled: true, disabledReason: null, visibleBlockers: visible };
    case "PLAN": {
      const material = visible.filter((b) => b.requirementIds.length > 0);
      return {
        stage,
        primaryEnabled: material.length === 0,
        disabledReason: material.length === 0 ? null : `Build candidate is held by ${material.length} unresolved obligation(s): ${material.map((b) => b.text).join("; ")}. Independent tasks keep running.`,
        visibleBlockers: visible,
      };
    }
    case "CHANGES":
      return ws.candidate
        ? { stage, primaryEnabled: true, disabledReason: null, visibleBlockers: visible }
        : { stage, primaryEnabled: false, disabledReason: "No candidate exists yet. Build one on the Plan stage first.", visibleBlockers: visible };
    case "VALIDATE":
      return ws.candidate?.status === "MATERIALIZED"
        ? { stage, primaryEnabled: true, disabledReason: null, visibleBlockers: visible }
        : { stage, primaryEnabled: false, disabledReason: ws.candidate ? `The candidate is ${ws.candidate.status.toLowerCase()}; run validation against the exact current binding only.` : "No candidate to validate.", visibleBlockers: visible };
    case "DELIVER": {
      if (ws.review) return { stage, primaryEnabled: ws.review.decision?.eligibility === "VERIFIED_WITHIN_SCOPE", disabledReason: ws.review.decision?.eligibility === "VERIFIED_WITHIN_SCOPE" ? null : ws.review.decision?.reasons.join("; ") || "Validation eligibility has not been computed.", visibleBlockers: visible };
      const open = ws.criteria.filter((c) => c.mandatory && c.validation !== "PASS" && c.validation !== "NOT_APPLICABLE");
      return {
        stage,
        primaryEnabled: open.length === 0 && ws.candidate?.status === "MATERIALIZED",
        disabledReason: open.length === 0 ? (ws.candidate?.status === "MATERIALIZED" ? null : "No current candidate to export.") : `${open.length} mandatory criterion/criteria not passed; export would be review-only. This is never labelled complete.`,
        visibleBlockers: visible,
      };
    }
  }
}

export type GroupedTask = WizardTask & { independent: WizardTask[] };
export type TaskGroups = {
  running: WizardTask[];
  ready: WizardTask[];
  blocked: GroupedTask[];
  failed: WizardTask[];
  needsAnswer: GroupedTask[];
};

/**
 * §30.2: always show separate Running / Ready / Blocked / Failed / Needs your answer groups.
 * A blocked task with a question is a "needs your answer" task; a STALE task is blocked on
 * revalidation. Blocked items carry requirement IDs, the exact blocker, the question/owner and the
 * next action, plus the tasks still progressing independently of them.
 */
export function groupTasks(tasks: WizardTask[]): TaskGroups {
  const progressing = tasks.filter((t) => t.state === "RUNNING" || t.state === "READY");
  const blocked = tasks
    .filter((t) => t.state === "BLOCKED" || t.state === "STALE")
    .map((t) => ({
      ...t,
      blocker: t.blocker ?? (t.state === "STALE" ? "Inputs changed since this ran; revalidation required." : undefined),
      independent: progressing,
    }));
  return {
    running: tasks.filter((t) => t.state === "RUNNING"),
    ready: tasks.filter((t) => t.state === "READY"),
    blocked,
    failed: tasks.filter((t) => t.state === "FAILED"),
    needsAnswer: blocked.filter((t) => t.questionId || t.waiting === "USER"),
  };
}
/**
 * Status banners, persistent on every stage (§30.2, §43.2). Text only — never color alone — and only
 * wordings the recorded state supports: "verified" and green completion aggregates are produced by the
 * eligibility function (task 2.J), so this shell cannot and does not emit them (plan execution rule 7).
 */
export function statusBanners(ws: WizardWorkspace): string[] {
  const banners: string[] = [];
  if (ws.review?.decision) banners.push(ws.review.decision.eligibility.replaceAll("_", " "));
  const implemented = ws.criteria.filter((c) => c.implemented);
  const validated = ws.criteria.filter((c) => c.validation === "PASS");
  if (ws.candidate && implemented.length > 0 && validated.length < ws.criteria.filter((c) => c.mandatory).length) {
    banners.push(`IMPLEMENTED — VALIDATION INCOMPLETE (${validated.length}/${ws.criteria.length} criteria passed)`);
  }
  if (ws.performance === "UNVALIDATED") banners.push("PERFORMANCE UNVALIDATED");
  else if (ws.performance !== "NOT_APPLICABLE") banners.push(`PERFORMANCE ${ws.performance}`);
  for (const b of ws.blockers) {
    banners.push(`BLOCKED — ${b.text} [${b.requirementIds.join(", ") || "no requirement id"}]${b.question ? ` question: ${b.question}` : ""}${b.nextAction ? ` next: ${b.nextAction}` : ""}`);
  }
  if (ws.candidate?.status === "STALE") banners.push("STALE — the candidate was affected by a contract change; affected evidence is stale. Revalidate before anything is exported or published.");
  const staleEvidence = ws.evidence.filter((e) => e.status === "STALE").length;
  if (staleEvidence > 0) banners.push(`STALE — ${staleEvidence} evidence record(s) no longer match the current contract (v${ws.contractVersion}).`);
  if (banners.length === 0) banners.push(ws.review ? "No blockers recorded. Validation evidence is shown within its recorded scope." : "No blockers recorded. Nothing has been analysed or validated yet.");
  return banners;
}

export type StaleImpact = {
  contractVersion: number;
  candidateStale: boolean;
  staleEvidenceIds: string[];
  /** Human-readable summary shown before the user continues (AT-69). */
  summary: string;
};

/**
 * Backward edit (PF-070, AT-69): answering or changing an answer on an earlier stage records a new
 * decision (the old one is superseded, never rewritten), creates a new contract version, and marks the
 * affected candidate and evidence STALE. The stale-impact summary is returned so the UI shows it before
 * any further navigation.
 */
export function recordDecision(
  ws: WizardWorkspace,
  input: { questionId: string; question: string; answer: string; stage: WizardStage; actor: string; affectsEvidenceIds?: string[] },
): { workspace: WizardWorkspace; impact: StaleImpact } {
  const previous = [...ws.decisions].reverse().find((d) => d.questionId === input.questionId);
  const backward = stageIndex(input.stage) < stageIndex(ws.stage);
  const decision: WizardDecision = {
    id: `dec-${ws.contractVersion + 1}-${input.questionId}`,
    questionId: input.questionId,
    question: input.question,
    answer: input.answer,
    stage: input.stage,
    actor: input.actor,
    ...(previous ? { supersedesId: previous.id } : {}),
  };
  const affects = new Set(input.affectsEvidenceIds ?? []);
  const staleEvidenceIds = backward ? ws.evidence.filter((e) => affects.size === 0 || affects.has(e.id)).map((e) => e.id) : [];
  const candidateStale = backward && ws.candidate !== null && ws.candidate.status !== "STALE";
  const workspace: WizardWorkspace = {
    ...ws,
    // Decisions are immutable; the new record supersedes the old one instead of rewriting it.
    decisions: [...ws.decisions, decision],
    contractVersion: ws.contractVersion + 1,
    workspaceVersion: ws.workspaceVersion + 1,
    candidate: candidateStale && ws.candidate ? { ...ws.candidate, status: "STALE" } : ws.candidate,
    evidence: ws.evidence.map((e) => (staleEvidenceIds.includes(e.id) ? { ...e, status: "STALE" as const } : e)),
    // An answered material question clears its blocker and unblocks the task waiting on it.
    blockers: ws.blockers.filter((b) => b.question !== input.questionId),
    tasks: ws.tasks.map((t) =>
      t.questionId === input.questionId && t.state === "BLOCKED" ? { ...t, state: "READY" as const, blocker: undefined, question: undefined, waiting: undefined } : t,
    ),
    updatedAt: new Date().toISOString(),
  };
  const impact: StaleImpact = {
    contractVersion: workspace.contractVersion,
    candidateStale,
    staleEvidenceIds,
    summary:
      `Answer recorded as a new decision${previous ? ` (supersedes ${previous.id})` : ""}; contract is now v${workspace.contractVersion}.` +
      (backward
        ? ` Because this revises an earlier stage, ${candidateStale ? "the current candidate and " : ""}${staleEvidenceIds.length} evidence record(s) are STALE and must be revalidated before validation, export or publication.`
        : " Work that depends on this answer can proceed."),
  };
  return { workspace, impact };
}

export function stageIndex(stage: WizardStage): number {
  return ["DESCRIBE", "CLARIFY", "PLAN", "CHANGES", "VALIDATE", "DELIVER"].indexOf(stage);
}
