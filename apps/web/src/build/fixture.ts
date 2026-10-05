import type { WizardWorkspace } from "./wizard.ts";

// Fixture data source for the Build feature shell (plan 1.H: "driven by fixture data until backend lands").
// The fixture models the spec's worked example (§25 permission-aware CSV export, §43.4 wireframe):
// saved decisions and a current candidate (AT-67), one material question blocking one task while
// independent work runs (AT-68), and a permission answer on an earlier stage that can change (AT-69).

export const FIXTURE_REQUEST_ID = "PFREQ-104";

export function buildFixtureWorkspace(): WizardWorkspace {
  return {
    requestId: FIXTURE_REQUEST_ID,
    stage: "DESCRIBE",
    workspaceVersion: 1,
    contractVersion: 3,
    prompt: "Add CSV export to transactions, permission-aware: approved recipients only, delivered by email link.",
    outcomeMode: "BUILD_AND_PREVIEW",
    issueRef: "#812",
    candidate: { hash: "cand-9f31c0", status: "MATERIALIZED" },
    criteria: [
      { id: "AC1", text: "Export produces CSV for the filtered transaction set", implemented: true, mandatory: true, validation: "PASS" },
      { id: "AC2", text: "Export is scoped to authorized recipients", implemented: true, mandatory: true, validation: "NOT_RUN" },
      { id: "AC3", text: "Independent dataset reproduces the export", implemented: true, mandatory: true, validation: "INCOMPLETE" },
      { id: "AC4", text: "Ordinary request latency is not regressed (P0/P1)", implemented: false, mandatory: true, validation: "NOT_RUN" },
      { id: "AC5", text: "Provider integration is validated against the real provider", implemented: false, mandatory: false, validation: "NOT_RUN" },
      { id: "AC6", text: "Operations runbook and metrics updated", implemented: false, mandatory: false, validation: "NOT_APPLICABLE" },
    ],
    tasks: [
      { id: "t1", label: "Inspect export implementation", requirementIds: ["R2"], state: "COMPLETE" },
      { id: "t2", label: "Prepare independent CSV fixtures", requirementIds: ["R4"], state: "RUNNING", waiting: "QUEUED" },
      { id: "t3", label: "Reuse export filter logic", requirementIds: ["R2"], state: "READY" },
      {
        id: "t4",
        label: "Delivery policy for email recipients",
        requirementIds: ["R4"],
        state: "BLOCKED",
        blocker: "Recipient policy is a new disclosure not covered by download permission.",
        questionId: "Q4",
        question: "Q4: Who may receive the export?",
        nextAction: "Answer Q4 on the Clarify stage.",
        waiting: "USER",
      },
      {
        id: "t5",
        label: "Provider integration test",
        requirementIds: ["R5"],
        state: "BLOCKED",
        blocker: "Real provider is not reachable from this environment; the provider is mocked.",
        nextAction: "Run against a real provider before claiming integration evidence.",
        waiting: "PROVIDER",
      },
      {
        id: "t6",
        label: "Baseline browser journey",
        requirementIds: ["AC4"],
        state: "FAILED",
        blocker: "Baseline login fixture times out after 30 s.",
        nextAction: "Classify the baseline failure (§39.2) before treating it as caused by the feature.",
      },
    ],
    decisions: [
      { id: "dec-1-Q1", questionId: "Q1", question: "Q1: Which transaction fields may leave the system?", answer: "Existing finance-report fields only; no free-text notes.", stage: "CLARIFY", actor: "user" },
      { id: "dec-2-Q2", questionId: "Q2", question: "Q2: Is the export synchronous or asynchronous?", answer: "Asynchronous; large exports run as a job.", stage: "CLARIFY", actor: "user" },
      { id: "dec-3-Q3", questionId: "Q3", question: "Q3: Who may request the export?", answer: "Finance role, existing tenant scope and masking preserved.", stage: "CLARIFY", actor: "user" },
    ],
    evidence: [
      { id: "ev-build", kind: "BUILD", status: "CURRENT" },
      { id: "ev-unit", kind: "UNIT", status: "CURRENT" },
      { id: "ev-browser", kind: "BROWSER", status: "CURRENT" },
    ],
    performance: "UNVALIDATED",
    blockers: [
      {
        id: "b-Q4",
        requirementIds: ["R4"],
        text: "Delivery policy: recipient disclosure is new and needs an explicit decision.",
        question: "Q4",
        nextAction: "Answer Q4 on the Clarify stage; independent tasks (fixtures, reuse) continue meanwhile.",
      },
      {
        id: "b-provider",
        requirementIds: ["AC5"],
        text: "Provider integration unvalidated: the provider is mocked in this environment.",
        nextAction: "Run against a real provider; until then AC5 cannot pass.",
      },
    ],
    mocked: ["provider integration", "fixture data (intake backend lands with task 1.C)"],
    updatedAt: "2026-10-05T00:00:00.000Z",
  };
}

// ------------------------------------------------------------------------------------------------ persistence seam

export type WorkspaceSummary = { requestId: string; stage: WizardWorkspace["stage"]; workspaceVersion: number; updatedAt: string };

export interface WizardStore {
  load(requestId: string): WizardWorkspace | null;
  save(ws: WizardWorkspace): void;
  list(): WorkspaceSummary[];
}

/** In-memory store for tests and SSR-safe use. */
export function memoryStore(seed?: WizardWorkspace): WizardStore & { dump(): Map<string, WizardWorkspace> } {
  const data = new Map<string, WizardWorkspace>();
  if (seed) data.set(seed.requestId, seed);
  return {
    load: (id) => data.get(id) ?? null,
    save: (ws) => void data.set(ws.requestId, ws),
    list: () => [...data.values()].map((w) => ({ requestId: w.requestId, stage: w.stage, workspaceVersion: w.workspaceVersion, updatedAt: w.updatedAt })),
    dump: () => data,
  };
}

const STORAGE_KEY = "cie-build-feature-workspaces";

function readAll(storage: Pick<Storage, "getItem">): Map<string, WizardWorkspace> {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed as WizardWorkspace[] : [];
    return new Map(list.map((w) => [w.requestId, w]));
  } catch {
    return new Map();
  }
}

/**
 * localStorage-backed store so closing the panel and coming back resumes the request at its saved
 * stage, with saved decisions and the current candidate (AT-67). Fail-soft: without storage the
 * wizard still works for the session, it just cannot resume.
 */
export function localStore(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): WizardStore {
  const write = (all: Map<string, WizardWorkspace>) => {
    try { storage.setItem(STORAGE_KEY, JSON.stringify([...all.values()])); } catch { /* session-only is acceptable */ }
  };
  return {
    load: (id) => readAll(storage).get(id) ?? null,
    save: (ws) => { const all = readAll(storage); all.set(ws.requestId, ws); write(all); },
    list: () => [...readAll(storage).values()].map((w) => ({ requestId: w.requestId, stage: w.stage, workspaceVersion: w.workspaceVersion, updatedAt: w.updatedAt })),
  };
}
