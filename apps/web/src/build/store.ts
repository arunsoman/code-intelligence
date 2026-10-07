import type { WizardWorkspace } from "./wizard.ts";

// Persistence seam for the Build feature shell, plus the empty workspace shown before the server has answered.

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

/** What the wizard shows before the server has said anything: no tasks, no criteria, no evidence and no candidate, so nothing here can be mistaken for a result. */
export function blankWorkspace(requestId = ""): WizardWorkspace {
  return { requestId, stage: "DESCRIBE", workspaceVersion: 0, contractVersion: 0, prompt: "", outcomeMode: "BUILD_AND_PREVIEW", candidate: null, criteria: [], tasks: [], decisions: [], evidence: [], performance: "UNVALIDATED", blockers: [], updatedAt: new Date(0).toISOString() };
}
