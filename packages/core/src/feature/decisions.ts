// Task 1.D — recording decisions and revising the contract (PF-012, PF-014, PF-036; AT-07, AT-27).
//   * A decision is immutable and bound to the contract version it answered. Answering against an older version is refused with
//     VERSION_CONFLICT AND leaves a finding behind, so the disagreement is visible instead of lost.
//   * Authority is checked per scope (authority.ts). A refused attempt is recorded as a BLOCKED event; nothing is accepted "for now".
//   * Revising the contract creates the next version, and every candidate built from the previous one becomes STALE (AT-07).
import { createHash } from "node:crypto";
import { asSet, canonHash, defineSchema, type Canon } from "./canon.ts";
import { authorityPolicyHash, authorize, SCOPES, type AuthorityConfig } from "./authority.ts";
import { FeatureError } from "./errors.ts";
import { eventFor } from "./lifecycle.ts";
import type { SqliteFeatureStore } from "./store.ts";
import { applyBlocking } from "./findings.ts";
import type { Assumption, DecisionRecord, FeatureContract, FeatureRecord, Id, Outcome } from "./types.ts";

export const contractIdOf = (requestId: Id): Id => `contract:${requestId}`;
export const requestIdOf = (contractId: Id): Id => { if (!contractId.startsWith("contract:")) throw new FeatureError("INVALID_SCHEMA", `${contractId} is not a contract id`); return contractId.slice("contract:".length); };
const decisionIdFor = (requestId: Id, key: string): Id => `decision:${createHash("sha256").update(`${requestId}\0${key}`).digest("hex").slice(0, 24)}`;

const ContractIdentity = defineSchema<Omit<FeatureContract, "hash">>("pf.FeatureContract", "1", (c) => ({
  id: c.id, version: c.version, requestId: c.requestId, commit: c.snapshot.commitHash, contentRoot: c.snapshot.contentRootHash, authorityPolicyHash: c.authorityPolicyHash,
  requirements: asSet(c.requirements.map((r): Canon => ({ id: r.id, text: r.text, origin: r.origin, type: r.type, status: r.status, dependsOn: asSet(r.dependsOn), acceptanceIds: asSet(r.acceptanceIds) }))) as Canon,
  acceptance: asSet(c.acceptance.map((a): Canon => ({ id: a.id, requirementIds: asSet(a.requirementIds), scenario: a.scenario, expected: a.expectedOutcome, mandatory: a.mandatory, oracleOrigin: a.oracleOrigin }))) as Canon,
  assumptions: asSet(c.assumptions.map((a): Canon => ({ id: a.id, text: a.text, state: a.state, reversible: a.reversible }))) as Canon,
  obligations: asSet(c.obligationIds) as Canon,
}));
export const contractHashOf = (c: Omit<FeatureContract, "hash">): string => canonHash(ContractIdentity, c);

export interface RecordDecisionInput { requestId: Id; expectedContractVersion: number; questionId: Id; answer: string; kind?: DecisionRecord["kind"]; authorityBindingId?: Id; rationale?: string; idempotencyKey: string; supersedes?: Id; waiver?: DecisionRecord["waiver"] }

export function recordDecision(fs: SqliteFeatureStore, auth: AuthorityConfig, actor: Id, i: RecordDecisionInput): DecisionRecord {
  const rec = fs.getRequest(i.requestId);
  if (!rec) throw new FeatureError("NOT_FOUND", `no such request ${i.requestId}`);
  if (!i.idempotencyKey) throw new FeatureError("INVALID_SCHEMA", "an idempotency key is required");
  if (!i.answer.trim() || i.answer.length > 20_000) throw new FeatureError("INVALID_SCHEMA", "an answer is required and is at most 20000 characters");
  const id = decisionIdFor(i.requestId, i.idempotencyKey);
  const prior = fs.listDecisions(i.requestId).find((d) => d.id === id);
  if (prior) {
    if (prior.answer !== i.answer || prior.questionId !== i.questionId || prior.actorId !== actor) throw new FeatureError("IDEMPOTENCY_CONFLICT", "this idempotency key was already used for a different decision");
    return prior;
  }
  if (rec.state === "CANCELLED" || rec.state === "FAILED") throw new FeatureError("ILLEGAL_TRANSITION", `the request is ${rec.state}; decisions can no longer be recorded`);
  const blocker = rec.blockers.find((b) => b.id === i.questionId);
  const scope = blocker?.scope ?? "business";
  const kind = i.kind ?? "ANSWER";
  const verdict = authorize(auth, actor, kind === "WAIVER" ? "policy" : scope, rec.createdBy);
  if (!verdict.allowed) {
    fs.appendEvent(eventFor(rec, "DecisionRecorded", actor, { result: "BLOCKED", rationale: `refused: ${verdict.reason}`, requirementIds: blocker?.requirementIds ?? [] }));
    throw new FeatureError("FORBIDDEN", `${actor} cannot decide ${kind === "WAIVER" ? "policy" : scope} questions: ${verdict.reason}`);
  }
  if (i.authorityBindingId && i.authorityBindingId !== verdict.bindingId) throw new FeatureError("FORBIDDEN", `authority binding ${i.authorityBindingId} does not authorise ${actor} for ${scope}`);
  if (kind === "WAIVER" && (!i.waiver || !i.waiver.criteria.length || !i.waiver.residualRisk.trim() || !(Date.parse(i.waiver.expiresAt) > Date.now()))) throw new FeatureError("INVALID_SCHEMA", "a waiver names its criteria, residual risk and a future expiry");
  if (i.expectedContractVersion !== rec.contractVersion) {
    const finding = { id: `finding:stale-decision:${id.slice(-12)}`, kind: "FINDING" as const, requirementIds: blocker?.requirementIds ?? [], scope: "business",
      text: `${actor} answered "${i.questionId}" against contract version ${i.expectedContractVersion}, but the contract is now version ${rec.contractVersion}. Confirm the answer still applies.` };
    if (!rec.blockers.some((b) => b.id === finding.id)) fs.updateRequest(rec.requestId, rec.version, { ...rec, blockers: [...rec.blockers, finding], workspace: { ...rec.workspace, blockers: [...rec.workspace.blockers, finding.id], workspaceVersion: rec.workspace.workspaceVersion + 1 } },
      eventFor(rec, "RequirementFindingRaised", actor, { result: "BLOCKED", rationale: finding.text, requirementIds: finding.requirementIds }));
    throw new FeatureError("VERSION_CONFLICT", `the contract moved to version ${rec.contractVersion}; a finding was raised so the answer can be confirmed`, rec.contractVersion);
  }
  const decision: DecisionRecord = {
    schemaVersion: 1, id, requestId: rec.requestId, kind, questionId: i.questionId, answer: i.answer, actorId: actor, authorityBindingId: verdict.bindingId,
    contractVersion: rec.contractVersion, affectedIds: blocker?.requirementIds ?? [], rationale: i.rationale ?? "", createdAt: new Date().toISOString(), supersedesId: i.supersedes, waiver: i.waiver,
  };
  const saved = fs.putDecision(decision, eventFor(rec, "DecisionRecorded", actor, { decisionIds: [id], requirementIds: decision.affectedIds, rationale: `${kind} for ${i.questionId} under ${verdict.reason}` }));
  // The question is answered: remove its blocker. A concurrent writer may have moved the record; retry once from fresh state.
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = fs.getRequest(rec.requestId)!;
    if (!cur.blockers.some((b) => b.id === i.questionId)) break;
    try {
      const blockers = cur.blockers.filter((b) => b.id !== i.questionId);
      fs.updateRequest(cur.requestId, cur.version, { ...cur, blockers, workspace: { ...cur.workspace, blockers: blockers.map((b) => b.id), workspaceVersion: cur.workspace.workspaceVersion + 1 } });
      break;
    } catch (e) { if (!(e instanceof FeatureError) || e.code !== "VERSION_CONFLICT" || attempt) throw e; }
  }
  // The answer resolves the finding behind the question (PF-014); the tasks it was holding are released once its blocker is gone.
  resolveFindingFor(fs, rec.requestId, i.questionId, saved);
  return saved;
}

/** A finding is closed by the decision that answers its question: RESOLVED, or DISMISSED when the answer says to dismiss it. */
function resolveFindingFor(fs: SqliteFeatureStore, requestId: Id, questionId: Id, decision: DecisionRecord): void {
  for (let attempt = 0; ; attempt++) {
    const cur = fs.getRequest(requestId); if (!cur) return;
    const f = (cur.findings ?? []).find((x) => x.id === questionId || questionId === `q:${x.id.split(":").pop()}`);
    if (!f || (f.status !== "POTENTIAL" && f.status !== "CONFIRMED")) return;
    const status = /^\s*dismiss/i.test(decision.answer) ? "DISMISSED" as const : "RESOLVED" as const;
    try {
      fs.updateRequest(requestId, cur.version, { ...cur, findings: (cur.findings ?? []).map((x) => (x.id === f.id ? { ...x, status, decisionId: decision.id, blockingTaskIds: [] } : x)), workspace: { ...cur.workspace, workspaceVersion: cur.workspace.workspaceVersion + 1 } },
        eventFor(cur, "DecisionRecorded", decision.actorId, { decisionIds: [decision.id], requirementIds: f.requirementIds, rationale: `finding ${f.id} ${status.toLowerCase()} by decision ${decision.id}` }));
      applyBlocking(fs, requestId, decision.actorId); return;
    } catch (e) { if (!(e instanceof FeatureError) || e.code !== "VERSION_CONFLICT" || attempt) throw e; }
  }
}

export const SCOPE_LIST = SCOPES;

/**
 * Create the next contract version from recorded decisions. Requirement text is not rewritten here (normalisation is task 2.I):
 * accepted assumptions and resolved findings move to their new state, the version and hash change, and work built on the old
 * version is marked stale so nothing stale can be validated or published.
 */
export function reviseContract(fs: SqliteFeatureStore, auth: AuthorityConfig, actor: Id, i: { requestId: Id; expectedVersion: number; decisionIds: Id[] }): Outcome<FeatureContract> {
  const rec = fs.getRequest(i.requestId);
  if (!rec) throw new FeatureError("NOT_FOUND", `no such request ${i.requestId}`);
  if (!rec.contract) throw new FeatureError("NOT_FOUND", "there is no contract draft yet; it is produced when requirements are normalised (task 2.I)");
  if (rec.contractVersion !== i.expectedVersion) throw new FeatureError("VERSION_CONFLICT", `the contract is at version ${rec.contractVersion}, expected ${i.expectedVersion}`, rec.contractVersion);
  const decisions = fs.activeDecisions(rec.requestId);
  const chosen = i.decisionIds.map((d) => { const x = decisions.find((y) => y.id === d); if (!x) throw new FeatureError("INVALID_SCHEMA", `decision ${d} does not exist or has been superseded`); return x; });
  if (!chosen.length) throw new FeatureError("INVALID_SCHEMA", "name at least one decision to apply");
  const accepted = new Set(chosen.filter((d) => d.kind === "ASSUMPTION").flatMap((d) => d.affectedIds.concat(d.questionId ? [d.questionId] : [])));
  const assumptions: Assumption[] = rec.contract.assumptions.map((a) => accepted.has(a.id) ? { ...a, state: /^(no|reject)/i.test(chosen.find((d) => d.questionId === a.id)?.answer ?? "") ? "REJECTED" : "ACCEPTED" } : a);
  const version = rec.contractVersion + 1;
  const draft: Omit<FeatureContract, "hash"> = { ...rec.contract, version, assumptions, authorityPolicyHash: authorityPolicyHash(auth) };
  const contract: FeatureContract = { ...draft, hash: contractHashOf(draft) };
  const staleIds: Id[] = [];
  for (const c of fs.listCandidates(rec.requestId)) if (c.status === "MATERIALIZED" || c.status === "PLANNED") { fs.putCandidate({ ...c, status: "STALE" }, eventFor(rec, "VerificationInvalidated", actor, { before: c.bindingHash, rationale: `contract moved to version ${version}` })); staleIds.push(c.id); }
  const cur = fs.getRequest(rec.requestId)!;
  fs.updateRequest(rec.requestId, cur.version, { ...cur, contract, contractVersion: version, workspace: { ...cur.workspace, contractHash: contract.hash, candidateHash: undefined, workspaceVersion: cur.workspace.workspaceVersion + 1 } },
    eventFor(rec, "ContractVersionCreated", actor, { decisionIds: i.decisionIds, before: rec.contract.hash, after: contract.hash, rationale: `version ${version}${staleIds.length ? `; ${staleIds.length} candidate(s) are now stale` : ""}` }));
  return { status: "COMPLETE", value: contract, evidenceIds: i.decisionIds, diagnostics: staleIds.map((id) => `candidate ${id} is stale: it was built from contract version ${rec.contractVersion}`) };
}
