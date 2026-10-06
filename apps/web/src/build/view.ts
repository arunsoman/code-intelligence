// Presentation logic for the Build feature dialog (UX audit UX-64…UX-92). Pure, so tests cover it without a browser.
// Nothing here invents state: every label is derived from the workspace, and "verified" wording stays with task 2.J.
import type { WizardStage } from "./stages.ts";
import { EFFECTFUL_ACTIONS, STAGES } from "./stages.ts";
import { groupTasks, stageGate, stageIndex, statusBanners, type WizardTask, type WizardWorkspace } from "./wizard.ts";

export type Severity = "blocked" | "caution" | "info";

/** "Q4: Who may receive the export?" → { id: "Q4", text: "Who may receive the export?" }. A bare id keeps its blocker text as the question. */
export function splitQuestion(q: string, fallbackText?: string): { id: string; text: string } {
  const m = /^(Q\d+)\s*[:.-]\s*(.+)$/s.exec(q.trim());
  if (m) return { id: m[1]!, text: m[2]!.trim() };
  return { id: q.trim(), text: fallbackText?.trim() || q.trim() };
}

export type OpenQuestion = { id: string; text: string; context: string; requirementIds: string[]; blockedTasks: string[] };
/** Questions the person still has to answer, in order, with what each one blocks. */
export function openQuestions(ws: WizardWorkspace): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  for (const b of ws.blockers) {
    if (!b.question) continue;
    const task = ws.tasks.find((t) => t.questionId === b.question || (t.question && splitQuestion(t.question).id === b.question));
    const q = task?.question ? splitQuestion(task.question) : splitQuestion(b.question, b.text);
    out.push({ id: b.question, text: q.text, context: b.text, requirementIds: b.requirementIds, blockedTasks: ws.tasks.filter((t) => t.questionId === b.question).map((t) => t.label) });
  }
  return out;
}

export type Digest = { blocked: number; needsAnswer: number; running: number; ready: number; failed: number; criteria: { passed: number; total: number }; evidence: "real" | "none"; stale: boolean };
export function digestOf(ws: WizardWorkspace): Digest {
  const g = groupTasks(ws.tasks);
  return {
    blocked: g.blocked.length, needsAnswer: openQuestions(ws).length, running: g.running.length, ready: g.ready.length, failed: g.failed.length,
    criteria: { passed: ws.criteria.filter((c) => c.validation === "PASS").length, total: ws.criteria.length },
    evidence: ws.evidence.length ? "real" : "none", stale: ws.candidate?.status === "STALE" || ws.evidence.some((e) => e.status === "STALE"),
  };
}

export type Note = { severity: Severity; text: string };
/** The few status lines worth showing at once: blocked/stale first, then caution. */
export function summaryNotes(ws: WizardWorkspace): { shown: Note[]; all: { severity: Severity; text: string }[] } {
  const all = statusBanners(ws).map((text): Note => ({ severity: /^(BLOCKED|STALE)/.test(text) ? "blocked" : /^(IMPLEMENTED|PERFORMANCE)/.test(text) ? "caution" : "info", text }));
  const rest = all.filter((n) => !n.text.startsWith("BLOCKED"));
  const d = digestOf(ws);
  const blocked: Note[] = d.blocked || d.needsAnswer ? [{ severity: "blocked", text: `${d.needsAnswer ? `${d.needsAnswer} question(s) need your answer` : `${d.blocked} item(s) blocked`}; independent tasks keep running.` }] : [];
  const shown = [...blocked, ...rest].slice(0, 2);
  return { shown, all };
}

export type StepState = "done" | "current" | "open" | "attention";
export type Step = { id: WizardStage; label: string; index: number; state: StepState; glyph: string; word: string; hint?: string };
/** Stepper state from the workspace. Navigation is free; a stage that cannot do its primary action yet says why, it is not locked. */
export function stepsOf(ws: WizardWorkspace): Step[] {
  const oq = openQuestions(ws);
  const done: Record<WizardStage, boolean> = {
    DESCRIBE: ws.prompt.trim().length > 0 && (ws.candidate !== null || ws.decisions.length > 0),
    CLARIFY: oq.length === 0 && ws.decisions.length > 0,
    PLAN: ws.criteria.length > 0 && ws.candidate !== null && stageGate(ws, "PLAN").primaryEnabled,
    CHANGES: ws.candidate?.status === "MATERIALIZED",
    VALIDATE: ws.criteria.length > 0 && ws.criteria.filter((c) => c.mandatory).every((c) => c.validation === "PASS" || c.validation === "NOT_APPLICABLE") && ws.candidate?.status === "MATERIALIZED",
    DELIVER: false,
  };
  return STAGES.map((s, i) => {
    const attention = s.id === "CLARIFY" && oq.length > 0 ? `${oq.length} question(s) need your answer` : s.id === "VALIDATE" && ws.evidence.some((e) => e.status === "STALE") ? "evidence is stale" : undefined;
    const current = s.id === ws.stage;
    const state: StepState = current ? "current" : attention ? "attention" : done[s.id] ? "done" : "open";
    const glyph = state === "done" ? "✓" : state === "current" ? "●" : state === "attention" ? "⚠" : "○";
    const word = state === "done" ? "done" : state === "current" ? "current step" : state === "attention" ? "needs attention" : "not started";
    return { id: s.id, label: s.label, index: i + 1, state, glyph, word, hint: attention ?? (state === "open" ? stageGate(ws, s.id).disabledReason ?? undefined : undefined) };
  });
}

/** Where a request opens. A saved workspace resumes where it was (AT-67); a fresh one on Describe that already has work goes where the work is. */
export function landingStage(ws: WizardWorkspace): WizardStage {
  if (ws.stage !== "DESCRIBE") return ws.stage;
  if (openQuestions(ws).length) return "CLARIFY";
  if (ws.candidate?.status === "STALE") return "VALIDATE";
  if (ws.candidate) return "VALIDATE";
  return "DESCRIBE";
}

export const STATUS_WORDS: Record<NonNullable<WizardWorkspace["candidate"]>["status"], string> = { MATERIALIZED: "drafted and saved", PLANNED: "planned", STALE: "stale — rebuild needed", SUPERSEDED: "replaced by a newer draft" };
export const MODES: { value: string; label: string; explain: string }[] = [
  { value: "PLAN_ONLY", label: "Plan only", explain: "Produces requirements, questions and a plan. Nothing is built." },
  { value: "BUILD_AND_PREVIEW", label: "Build and preview", explain: "Also creates a candidate draft you can review. Nothing leaves this machine." },
  { value: "DRAFT_PR", label: "Draft PR", explain: "Also prepares a draft pull request once the required checks pass." },
];

export type ActionReason = { action: (typeof EFFECTFUL_ACTIONS)[number]; enabled: boolean; reason: string };
/** One line per effectful action: either it can run, or exactly what it is waiting for. Shown as text, not only on hover. */
export function actionReasons(ws: WizardWorkspace): ActionReason[] {
  const gate = (s: WizardStage) => stageGate(ws, s);
  const none = "The service that performs this action arrives with tasks 2.N–3.R, so it cannot run yet.";
  return [
    { action: "Build candidate", enabled: false, reason: gate("PLAN").disabledReason ?? none },
    { action: "Run validation", enabled: false, reason: gate("VALIDATE").disabledReason ?? none },
    { action: "Export patch", enabled: false, reason: gate("DELIVER").disabledReason ?? none },
    { action: "Create draft PR", enabled: false, reason: "Needs an exported patch and the publication check (task 2.J). Never enabled by navigation." },
  ];
}

export type Primary =
  | { kind: "SUBMIT_ANSWER"; label: string; questionId: string }
  | { kind: "FOCUS_ANSWER"; label: string; questionId: string }
  | { kind: "ANALYSE"; label: string; disabledReason: string | null }
  | { kind: "GO"; label: string; target: WizardStage }
  | { kind: "NONE"; label: string };
/** The single primary action, derived from state: an unanswered question beats everything, then the stage's own step. */
export function primaryOf(ws: WizardWorkspace, drafts: Record<string, string>): Primary {
  const oq = openQuestions(ws);
  if (oq.length) {
    const ready = ws.stage === "CLARIFY" ? oq.find((q) => (drafts[q.id] ?? "").trim()) : undefined;
    if (ready) return { kind: "SUBMIT_ANSWER", label: `Submit answer to ${ready.id}`, questionId: ready.id };
    return { kind: "FOCUS_ANSWER", label: `Answer ${oq[0]!.id} →`, questionId: oq[0]!.id };
  }
  if (ws.stage === "DESCRIBE") { const g = stageGate(ws, "DESCRIBE"); return { kind: "ANALYSE", label: "Start analysis", disabledReason: g.disabledReason }; }
  const next = STAGES[stageIndex(ws.stage) + 1];
  return next ? { kind: "GO", label: `Review ${next.label} →`, target: next.id } : { kind: "NONE", label: "Nothing further to do here" };
}

export type TaskCard = { task: WizardTask; chip: string; tone: "run" | "ready" | "blocked" | "failed" | "done"; detail?: string; needsAnswer: boolean; action?: { label: string; kind: "ANSWER" | "RETRY" | "NONE"; questionId?: string } };
const CHIP: Record<WizardTask["state"], string> = { READY: "Ready", RUNNING: "Running", BLOCKED: "Blocked", COMPLETE: "Done", FAILED: "Failed", CANCELLED: "Cancelled", STALE: "Stale" };
export function cardOf(t: WizardTask): TaskCard {
  const needsAnswer = t.state === "BLOCKED" && !!(t.questionId || t.waiting === "USER");
  const waiting = t.waiting === "QUEUED" ? "queued" : t.waiting === "PROVIDER" ? "waiting on provider" : t.waiting === "USER" ? "waiting on you" : undefined;
  const tone: TaskCard["tone"] = t.state === "RUNNING" ? "run" : t.state === "READY" ? "ready" : t.state === "FAILED" ? "failed" : t.state === "COMPLETE" ? "done" : "blocked";
  return {
    task: t, tone, needsAnswer, chip: t.state === "RUNNING" && waiting ? `Running · ${waiting}` : needsAnswer ? "Needs your answer" : CHIP[t.state],
    detail: t.blocker,
    action: needsAnswer && t.questionId ? { label: `Answer ${t.questionId}`, kind: "ANSWER", questionId: t.questionId } : t.state === "FAILED" ? { label: "Retry", kind: "RETRY" } : undefined,
  };
}

/** Failed → ready again, keeping the failure text out of the way. The real rerun belongs to the validation service. */
export function retryTask(ws: WizardWorkspace, id: string): WizardWorkspace {
  return { ...ws, workspaceVersion: ws.workspaceVersion + 1, updatedAt: new Date().toISOString(), tasks: ws.tasks.map((t) => (t.id === id && t.state === "FAILED" ? { ...t, state: "READY" as const, blocker: undefined, nextAction: undefined } : t)) };
}

export type Section = { key: "running" | "ready" | "blocked" | "failed"; label: string; cards: TaskCard[] };
/** Four sections; items that need an answer stay inside Blocked (one canonical card each), with the count named in the digest. */
export function sectionsOf(ws: WizardWorkspace): Section[] {
  const g = groupTasks(ws.tasks);
  return [
    { key: "running", label: "Running", cards: g.running.map(cardOf) },
    { key: "ready", label: "Ready", cards: g.ready.map(cardOf) },
    { key: "blocked", label: "Blocked", cards: g.blocked.map(cardOf) },
    { key: "failed", label: "Failed", cards: g.failed.map(cardOf) },
  ];
}

/** Dotted glossary terms (UX-91). */
export const GLOSSARY: { term: string; meaning: string }[] = [
  { term: "Candidate", meaning: "A complete set of proposed file changes, saved so it can be reviewed and checked. It is never applied to your working copy." },
  { term: "Drafted and saved", meaning: "The candidate exists and matches the current contract. It has not been validated." },
  { term: "Contract", meaning: "The agreed requirements and acceptance criteria. Changing an answer creates a new version and marks earlier work stale." },
  { term: "Requirement (R…)", meaning: "One thing the feature must do, taken from your request." },
  { term: "Acceptance criterion (AC…)", meaning: "A check that shows a requirement is met. Passing counts describe progress, not proof." },
  { term: "Stale", meaning: "Built or checked against an older contract. It must be redone before export." },
  { term: "Intake", meaning: "The backend step that reads your request and the repository." },
];

/** "o/r#9" links to the tracker; a bare "#812" has no repository to link to, so it stays text. */
export function issueLink(ref: string | undefined): { text: string; href?: string } | null {
  if (!ref) return null;
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref);
  return m ? { text: ref, href: `https://github.com/${m[1]}/issues/${m[2]}` } : { text: ref };
}

export const refKind = (id: string): string => /^AC\d+/.test(id) ? "Acceptance criterion" : /^R\d+/.test(id) ? "Requirement" : "Reference";
export const ago = (iso: string, now = Date.now()): string => { const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
