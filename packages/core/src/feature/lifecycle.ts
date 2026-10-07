// Task 1.B — the request state machine (spec §22), readiness flags, wizard pointer and crash reconciliation.
// Transitions are explicit: a move not in TRANSITIONS is refused, never coerced. Every transition is a compare-and-swap
// on the request's version and writes its event in the same transaction (see store.ts).
import { randomUUID } from "node:crypto";
import { FeatureError } from "./errors.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { EventRecord, EventType, FeatureRecord, FeatureWorkspace, Id, RequestState, WizardStage } from "./types.ts";
import { FEATURE_SCHEMA_VERSION } from "./types.ts";

export const TERMINAL: ReadonlySet<RequestState> = new Set(["CANCELLED", "FAILED"]);

/** Backward edges (to CONTRACTING/IMPLEMENTING/VALIDATING) exist because a decision, a review or a changed base invalidates later work. */
export const TRANSITIONS: Readonly<Record<RequestState, readonly RequestState[]>> = {
  RECEIVED: ["DISCOVERING", "CANCELLED", "FAILED"],
  DISCOVERING: ["CONTRACTING", "DISCOVERING", "CANCELLED", "FAILED"],
  CONTRACTING: ["IMPLEMENTING", "DISCOVERING", "CANCELLED", "FAILED"],
  IMPLEMENTING: ["VALIDATING", "CONTRACTING", "CANCELLED", "FAILED"],
  VALIDATING: ["REVIEW_READY", "IMPLEMENTING", "CONTRACTING", "CANCELLED", "FAILED"],
  REVIEW_READY: ["PUBLISHED", "VALIDATING", "IMPLEMENTING", "CONTRACTING", "CANCELLED"],
  PUBLISHED: ["IMPLEMENTING", "CONTRACTING", "CANCELLED"],
  CANCELLED: [], FAILED: [],
};
export const canTransition = (from: RequestState, to: RequestState): boolean => TRANSITIONS[from].includes(to);

export const STAGE_ORDER: readonly WizardStage[] = ["DESCRIBE", "CLARIFY", "PLAN", "CHANGES", "VALIDATE", "DELIVER"];

/** The furthest stage the request's state makes meaningful. Reading any earlier stage is always allowed. */
export function furthestStage(state: RequestState): WizardStage {
  switch (state) {
    case "RECEIVED": case "DISCOVERING": return "DESCRIBE";
    case "CONTRACTING": return "PLAN";
    case "IMPLEMENTING": return "CHANGES";
    case "VALIDATING": return "VALIDATE";
    case "REVIEW_READY": case "PUBLISHED": return "DELIVER";
    default: return "DESCRIBE";
  }
}

export type Readiness = "READY" | "BLOCKED" | "TERMINAL";
export function readiness(rec: FeatureRecord): Readiness { return TERMINAL.has(rec.state) ? "TERMINAL" : rec.blockers.length || rec.tasks.some((t) => t.state === "BLOCKED") ? "BLOCKED" : "READY"; }

export const newEventId = (): Id => `evt:${randomUUID()}`;
export function eventFor(rec: Pick<FeatureRecord, "requestId">, type: EventType, actor: Id, p: Partial<Omit<EventRecord, "sequence" | "sync" | "eventId" | "requestId" | "type" | "actor">> & { eventId?: Id } = {}): Omit<EventRecord, "sequence" | "sync"> {
  return {
    schemaVersion: FEATURE_SCHEMA_VERSION, eventId: p.eventId ?? newEventId(), requestId: rec.requestId, type, actor, producer: p.producer ?? "feature",
    requirementIds: p.requirementIds ?? [], decisionIds: p.decisionIds ?? [], before: p.before, after: p.after, result: p.result ?? "OK",
    rationale: p.rationale ?? "", at: p.at ?? new Date().toISOString(),
  };
}

/** Move a request to `to`. The record handed to `mutate` is the current one; the caller's `expectedVersion` guards against a lost update. */
export function transition(store: SqliteFeatureStore, requestId: Id, expectedVersion: number, to: RequestState, actor: Id, rationale: string, mutate?: (r: FeatureRecord) => FeatureRecord): FeatureRecord {
  const cur = store.getRequest(requestId);
  if (!cur) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
  if (cur.version !== expectedVersion) throw new FeatureError("VERSION_CONFLICT", `the request changed (version ${cur.version}, expected ${expectedVersion})`, cur.version);
  if (!canTransition(cur.state, to)) throw new FeatureError("ILLEGAL_TRANSITION", `a request cannot move from ${cur.state} to ${to}`);
  let next: FeatureRecord = { ...cur, state: to };
  if (mutate) next = { ...mutate(next), state: to };
  next = { ...next, workspace: { ...next.workspace, workspaceVersion: next.workspace.workspaceVersion + 1, stage: clampStage(next.workspace.stage, to) } };
  return store.updateRequest(requestId, expectedVersion, next, eventFor(cur, "StateChanged", actor, { rationale: `${cur.state} → ${to}${rationale ? `: ${rationale}` : ""}` }));
}

/** If the state no longer supports the open stage (for example after a backward move), the pointer follows the state. */
function clampStage(stage: WizardStage, state: RequestState): WizardStage {
  return STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(furthestStage(state)) ? furthestStage(state) : stage;
}

/** Replace the blocker list (the caller computed it) and keep the readiness visible in one write. */
export function setBlockers(store: SqliteFeatureStore, requestId: Id, expectedVersion: number, actor: Id, blockers: FeatureRecord["blockers"]): FeatureRecord {
  const cur = store.getRequest(requestId);
  if (!cur) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
  const next: FeatureRecord = { ...cur, blockers, workspace: { ...cur.workspace, blockers: blockers.map((b) => b.id), workspaceVersion: cur.workspace.workspaceVersion + 1 } };
  const type: EventType = blockers.length ? "TaskBlocked" : "StateChanged";
  return store.updateRequest(requestId, expectedVersion, next, eventFor(cur, type, actor, { result: blockers.length ? "BLOCKED" : "OK", rationale: blockers.length ? `${blockers.length} blocker(s): ${blockers.map((b) => b.id).join(", ")}` : "all blockers cleared" }));
}

/** Navigation moves the view only and is free in both directions (spec §43.1, plan S10): it never starts, approves or publishes anything. What a stage may DO is gated by its own primary action, not by whether it can be read. */
export function advanceStage(store: SqliteFeatureStore, requestId: Id, actor: Id, target: WizardStage, expectedWorkspaceVersion: number): FeatureWorkspace {
  const cur = store.getRequest(requestId);
  if (!cur) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
  if (cur.workspace.workspaceVersion !== expectedWorkspaceVersion) throw new FeatureError("VERSION_CONFLICT", `the workspace changed (version ${cur.workspace.workspaceVersion}, expected ${expectedWorkspaceVersion})`, cur.workspace.workspaceVersion);
  if (!STAGE_ORDER.includes(target)) throw new FeatureError("INVALID_SCHEMA", `unknown stage ${String(target)}`);
  if (cur.workspace.stage === target) return cur.workspace;
  const next: FeatureRecord = { ...cur, workspace: { ...cur.workspace, stage: target, workspaceVersion: cur.workspace.workspaceVersion + 1 } };
  return store.updateRequest(requestId, cur.version, next, eventFor(cur, "WizardAdvanced", actor, { rationale: `${cur.workspace.stage} → ${target}` })).workspace;
}

/** `resumeRequest`: the workspace as stored, with job references that no longer run removed. */
export function resumeRequest(store: SqliteFeatureStore, requestId: Id, actor: Id, isJobActive: (jobId: Id) => boolean): FeatureWorkspace {
  const cur = store.getRequest(requestId);
  if (!cur) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
  const dead = cur.workspace.runningJobIds.filter((j) => !isJobActive(j));
  if (!dead.length) return cur.workspace;
  const next: FeatureRecord = { ...cur, workspace: { ...cur.workspace, runningJobIds: cur.workspace.runningJobIds.filter((j) => !dead.includes(j)), workspaceVersion: cur.workspace.workspaceVersion + 1 },
    tasks: cur.tasks.map((t) => t.state === "RUNNING" ? { ...t, state: "BLOCKED" as const } : t) };
  return store.updateRequest(requestId, cur.version, next, eventFor(cur, "RequestReconciled", actor, { result: "BLOCKED", rationale: `job(s) ${dead.join(", ")} stopped without finishing; running tasks are blocked until restarted` })).workspace;
}

/** Start-up: every non-terminal request is reconciled so a crash never leaves a "running" label on work that is gone. */
export function reconcileAll(store: SqliteFeatureStore, actor: Id, isJobActive: (jobId: Id) => boolean): Id[] {
  const fixed: Id[] = [];
  for (const r of store.listRequests(undefined, 1000)) {
    if (TERMINAL.has(r.state)) continue;
    const before = r.workspace.workspaceVersion;
    if (resumeRequest(store, r.requestId, actor, isJobActive).workspaceVersion !== before) fixed.push(r.requestId);
  }
  return fixed;
}
