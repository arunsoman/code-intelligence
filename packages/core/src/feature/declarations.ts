// Declarations are evidence-bearing decisions (decision D001). What a validation run is allowed to claim about itself — that its
// environment is representative, its dependencies available, its test data synthetic or an authorised redacted copy, that performance
// does not apply — is only as strong as who said it. This file:
//   * checks the declarer against the authority file at the moment of the declaration,
//   * records each accepted declaration as a DecisionRecord (who, under which binding, why, when),
//   * returns what was REFUSED and why, so the run goes on with the weaker, honest claim (never the stronger one),
//   * and, whenever eligibility is computed later, re-checks every declaration the plan relies on (declarationGaps): a revoked binding,
//     or a plan that claims something nobody recorded, becomes a named gap and keeps the result from VERIFIED.
// The requester may declare what is theirs to say (confirming expected outcomes, synthetic test data, weaker claims). Everything else needs a binding.
import { createHash } from "node:crypto";
import { authorize, loadAuthority, type AuthorityConfig } from "./authority.ts";
import { loadFeatureConfig } from "./config.ts";
import { FeatureError } from "./errors.ts";
import { eventFor } from "./lifecycle.ts";
import type { DecisionRecord, FeatureRecord, FeatureStore, Id } from "./types.ts";

export type DeclarationKind = "ENVIRONMENT" | "DEPENDENCIES" | "TEST_DATA" | "PERFORMANCE_NOT_APPLICABLE";
export interface DeclaredValidation {
  fidelity?: "REPRESENTATIVE" | "PARTIAL" | "UNKNOWN"; dependencies?: "AVAILABLE" | "MISSING" | "UNKNOWN"; environmentLabel?: string;
  testData?: { kind: "SYNTHETIC" | "AUTHORIZED_REDACTED"; authorizationRef?: string }; performanceApplicable?: boolean; wallMs?: number;
}
/** What the plan may rely on, with who said it, for the Validate stage to show. */
export type DeclaredBy = Partial<Record<DeclarationKind, { actor: Id; bindingId?: Id; decisionId: Id }>>;
export interface DeclarationOutcome { effective: DeclaredValidation & { declaredBy?: DeclaredBy }; accepted: DecisionRecord[]; refused: { kind: DeclarationKind; reason: string }[] }

const QUESTION = (k: DeclarationKind) => `declaration:${k}`;
const idFor = (requestId: Id, kind: DeclarationKind, value: string): Id => `decision:${createHash("sha256").update(`${requestId}\0declare\0${kind}\0${value}`).digest("hex").slice(0, 24)}`;

export function authorityFor(repositoryId: string): { auth: AuthorityConfig; problem?: string } {
  try { return { auth: loadAuthority(repositoryId, loadFeatureConfig(repositoryId).authorityFile) }; }
  catch (e) { return { auth: { bindings: [] }, problem: `the authority file could not be read: ${(e as Error).message}` }; }
}

/** The authority a declaration needs. `performance` may also be given by release authority (D001: "performance/release authority"). */
function permits(auth: AuthorityConfig, actor: Id, requester: Id, kind: DeclarationKind, value: { redacted?: boolean }): { allowed: boolean; bindingId?: Id; reason: string } {
  switch (kind) {
    case "ENVIRONMENT": case "DEPENDENCIES": return authorize(auth, actor, "validation", requester);
    case "TEST_DATA": return value.redacted ? authorize(auth, actor, "data", requester) : authorize(auth, actor, "business", requester);
    case "PERFORMANCE_NOT_APPLICABLE": { const p = authorize(auth, actor, "performance", requester); return p.allowed ? p : authorize(auth, actor, "release", requester); }
  }
}

export function applyDeclarations(fs: FeatureStore, auth: AuthorityConfig, actor: Id, requestId: Id, decl: DeclaredValidation = {}, rationale = ""): DeclarationOutcome {
  const rec = fs.getRequest(requestId);
  if (!rec || rec.createdBy !== actor) throw new FeatureError("NOT_FOUND", `no such request ${requestId}`);
  const effective: DeclarationOutcome["effective"] = { ...decl, declaredBy: {} }; const accepted: DecisionRecord[] = []; const refused: DeclarationOutcome["refused"] = [];
  const record = (kind: DeclarationKind, value: string, verdict: { bindingId?: Id; reason: string }): void => {
    const id = idFor(requestId, kind, value); const prior = fs.listDecisions(requestId).find((d) => d.id === id);
    const d: DecisionRecord = prior ?? { schemaVersion: 1, id, requestId, kind: "DISPOSITION", questionId: QUESTION(kind), answer: value, actorId: actor, authorityBindingId: verdict.bindingId, contractVersion: fs.getRequest(requestId)!.contractVersion, affectedIds: [], rationale: (rationale || verdict.reason).slice(0, 2000), createdAt: new Date().toISOString() };
    if (!prior) fs.putDecision(d, eventFor(fs.getRequest(requestId)!, "DecisionRecorded", actor, { decisionIds: [id], rationale: `declared ${kind}: ${value}` }));
    accepted.push(d); effective.declaredBy![kind] = { actor, bindingId: verdict.bindingId, decisionId: id };
  };
  const refuse = (kind: DeclarationKind, why: string) => { refused.push({ kind, reason: why }); fs.appendEvent(eventFor(fs.getRequest(requestId)!, "DecisionRecorded", actor, { result: "BLOCKED", rationale: `refused declaration ${kind}: ${why}` })); };

  if (decl.fidelity !== undefined) {
    const label = `environment ${decl.fidelity}${decl.environmentLabel ? ` (${decl.environmentLabel})` : ""}`;
    if (decl.fidelity === "REPRESENTATIVE") { const v = permits(auth, actor, rec.createdBy, "ENVIRONMENT", {}); if (v.allowed) record("ENVIRONMENT", label, v); else { effective.fidelity = "PARTIAL"; refuse("ENVIRONMENT", `REPRESENTATIVE was not accepted: ${v.reason}`); } }
    else record("ENVIRONMENT", label, { reason: "a weaker claim than representative needs no authority" });
  }
  if (decl.dependencies !== undefined) {
    if (decl.dependencies === "AVAILABLE") { const v = permits(auth, actor, rec.createdBy, "DEPENDENCIES", {}); if (v.allowed) record("DEPENDENCIES", "dependencies AVAILABLE", v); else { effective.dependencies = "UNKNOWN"; refuse("DEPENDENCIES", `AVAILABLE was not accepted: ${v.reason}`); } }
    else record("DEPENDENCIES", `dependencies ${decl.dependencies}`, { reason: "a weaker claim than available needs no authority" });
  }
  if (decl.testData) {
    const redacted = decl.testData.kind === "AUTHORIZED_REDACTED"; const v = permits(auth, actor, rec.createdBy, "TEST_DATA", { redacted });
    if (v.allowed) record("TEST_DATA", `test data ${decl.testData.kind}${decl.testData.authorizationRef ? ` (authorisation ${decl.testData.authorizationRef})` : ""}`, v);
    else { effective.testData = undefined; refuse("TEST_DATA", `${decl.testData.kind} was not accepted: ${v.reason}`); }
  }
  if (decl.performanceApplicable === false) {
    const v = permits(auth, actor, rec.createdBy, "PERFORMANCE_NOT_APPLICABLE", {});
    if (v.allowed) record("PERFORMANCE_NOT_APPLICABLE", "performance not applicable", v);
    else { effective.performanceApplicable = undefined; refuse("PERFORMANCE_NOT_APPLICABLE", `performance cannot be declared not applicable: ${v.reason}`); }
  }
  return { effective, accepted, refused };
}

/** The latest decision of each kind, by time then id. */
export function activeDeclarations(fs: FeatureStore, requestId: Id): Partial<Record<DeclarationKind, DecisionRecord>> {
  const out: Partial<Record<DeclarationKind, DecisionRecord>> = {};
  for (const d of [...fs.listDecisions(requestId)].filter((x) => x.questionId?.startsWith("declaration:")).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) out[d.questionId!.slice(12) as DeclarationKind] = d;
  return out;
}

export type DeclarationState = "NOT_CLAIMED" | "NOT_DECLARED" | "NO_LONGER_AUTHORISED" | "DECLARED";
export interface DeclarationStatus { claim: string; state: DeclarationState; declarer?: Id; bindingId?: Id; decisionId?: Id; reason?: string }
const CLAIMS: Record<DeclarationKind, string> = { ENVIRONMENT: "the REPRESENTATIVE environment", DEPENDENCIES: "the AVAILABLE dependencies", TEST_DATA: "the test data", PERFORMANCE_NOT_APPLICABLE: "the performance-not-applicable statement" };

/** For each kind of declaration: does the plan rely on it, was it recorded, and does the declarer still have the authority it needed? */
export function declarationStatus(fs: Pick<FeatureStore, "listDecisions">, request: FeatureRecord, auth?: AuthorityConfig): Record<DeclarationKind, DeclarationStatus> {
  const authority = auth ?? authorityFor(request.repositoryId).auth; const active = activeDeclarations(fs as FeatureStore, request.requestId); const plan = request.validationPlan;
  const claimed: Record<DeclarationKind, { on: boolean; redacted?: boolean; label?: string }> = {
    ENVIRONMENT: { on: plan?.environment.fidelity === "REPRESENTATIVE" }, DEPENDENCIES: { on: plan?.environment.dependencies === "AVAILABLE" },
    TEST_DATA: { on: plan?.testData.kind === "SYNTHETIC" || plan?.testData.kind === "AUTHORIZED_REDACTED", redacted: plan?.testData.kind === "AUTHORIZED_REDACTED", label: plan?.testData.kind === "AUTHORIZED_REDACTED" ? "the authorised redacted test data" : "the SYNTHETIC test data" },
    PERFORMANCE_NOT_APPLICABLE: { on: !!plan?.checks.some((c) => c.kind === "PERFORMANCE" && c.applicability === "NOT_APPLICABLE") },
  };
  const out = {} as Record<DeclarationKind, DeclarationStatus>;
  for (const kind of Object.keys(claimed) as DeclarationKind[]) {
    const c = claimed[kind], claim = c.label ?? CLAIMS[kind], d = active[kind];
    if (!c.on) { out[kind] = { claim, state: "NOT_CLAIMED" }; continue; }
    if (!d) { out[kind] = { claim, state: "NOT_DECLARED", reason: `${claim} has no recorded declaration` }; continue; }
    const v = permits(authority, d.actorId, request.createdBy, kind, { redacted: c.redacted });
    out[kind] = v.allowed ? { claim, state: "DECLARED", declarer: d.actorId, bindingId: d.authorityBindingId, decisionId: d.id }
      : { claim, state: "NO_LONGER_AUTHORISED", declarer: d.actorId, decisionId: d.id, reason: `${claim} was declared by ${d.actorId}, who no longer has the authority for it (${v.reason})` };
  }
  return out;
}

/**
 * Gaps for eligibility: every strong claim in the plan must rest on a recorded declaration whose declarer still has the authority it needed.
 * Called wherever eligibility is computed, so revoking a binding after the fact makes the result review-only again.
 */
export function declarationGaps(fs: Pick<FeatureStore, "listDecisions">, request: FeatureRecord, auth?: AuthorityConfig): string[] {
  if (!request.validationPlan) return [];
  return Object.values(declarationStatus(fs, request, auth)).filter((x) => x.state === "NOT_DECLARED" || x.state === "NO_LONGER_AUTHORISED").map((x) => x.reason!);
}

// ------------------------------------------------------------------------------------------------ release plan and operational note

const PLAN_FIELDS = ["applicability", "rationale", "flagStrategy", "deploymentOrder", "observationWindow", "stopCriteria", "operator", "killSwitch", "revertRunbook", "dataRecoveryLimits"] as const;
/** The requester drafts the plan or note. A new draft replaces the old one and clears any confirmation, which was of the old text. */
export function draftReleasePlan(fs: FeatureStore, actor: Id, i: { requestId: Id; plan: Record<string, unknown> }): NonNullable<FeatureRecord["contract"]>["releasePlan"] {
  const rec = fs.getRequest(i.requestId);
  if (!rec || rec.createdBy !== actor) throw new FeatureError("NOT_FOUND", `no such request ${i.requestId}`);
  if (!rec.contract) throw new FeatureError("NOT_FOUND", "there is no contract yet");
  if (!i.plan || typeof i.plan !== "object" || Array.isArray(i.plan)) throw new FeatureError("INVALID_SCHEMA", "the plan must be an object");
  for (const k of Object.keys(i.plan)) if (!(PLAN_FIELDS as readonly string[]).includes(k)) throw new FeatureError("INVALID_SCHEMA", `release plan: unknown field ${k}${k === "confirmedBy" || k === "draftedBy" ? " (confirmation is recorded by a principal with release authority, not written into the plan)" : ""}`);
  if (!["APPLICABLE", "NOT_APPLICABLE"].includes(i.plan.applicability as string)) throw new FeatureError("INVALID_SCHEMA", "applicability is APPLICABLE or NOT_APPLICABLE");
  const plan = { ...(i.plan as object), draftedBy: actor } as NonNullable<NonNullable<FeatureRecord["contract"]>["releasePlan"]>;
  fs.updateRequest(rec.requestId, rec.version, { ...rec, contract: { ...rec.contract, releasePlan: plan }, workspace: { ...rec.workspace, workspaceVersion: rec.workspace.workspaceVersion + 1 } }, eventFor(rec, "DecisionRecorded", actor, { rationale: "drafted the release plan or operational note" }));
  return plan;
}

export function confirmReleasePlan(fs: FeatureStore, auth: AuthorityConfig, actor: Id, i: { requestId: Id }): NonNullable<NonNullable<FeatureRecord["contract"]>["releasePlan"]> {
  const rec = fs.getRequest(i.requestId);
  if (!rec || rec.createdBy !== actor) throw new FeatureError("NOT_FOUND", `no such request ${i.requestId}`);
  const plan = rec.contract?.releasePlan; if (!plan) throw new FeatureError("NOT_FOUND", "no release plan or operational note has been drafted");
  const v = authorize(auth, actor, "release", rec.createdBy);
  if (!v.allowed) { fs.appendEvent(eventFor(rec, "DecisionRecorded", actor, { result: "BLOCKED", rationale: `refused: ${v.reason}` })); throw new FeatureError("FORBIDDEN", `${actor} cannot confirm a release plan: ${v.reason}`); }
  const next = { ...plan, confirmedBy: actor };
  const id = `decision:${createHash("sha256").update(`${rec.requestId}\0release-plan\0${JSON.stringify(plan)}\0${actor}`).digest("hex").slice(0, 24)}`;
  if (!fs.listDecisions(rec.requestId).some((d) => d.id === id)) fs.putDecision({ schemaVersion: 1, id, requestId: rec.requestId, kind: "DISPOSITION", questionId: "release-plan-confirmation", answer: "release plan confirmed", actorId: actor, authorityBindingId: v.bindingId, contractVersion: rec.contractVersion, affectedIds: [], rationale: v.reason, createdAt: new Date().toISOString() }, eventFor(rec, "DecisionRecorded", actor, { decisionIds: [id], rationale: "confirmed the release plan" }));
  const cur = fs.getRequest(rec.requestId)!;
  fs.updateRequest(cur.requestId, cur.version, { ...cur, contract: { ...cur.contract!, releasePlan: next }, workspace: { ...cur.workspace, workspaceVersion: cur.workspace.workspaceVersion + 1 } });
  return next;
}
