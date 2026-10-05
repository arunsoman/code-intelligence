// A generated acceptance criterion is only a proposal: its expected outcome came from a model, so by plan S6 it can never make a
// feature "verified". This is the one way a person turns it into a reviewed oracle: they read the criterion, optionally replace
// the expected outcome with their own example, and say so. The act is a recorded decision under business authority, the criterion's
// oracleOrigin becomes USER_EXAMPLE, the contract gets a new version and hash, and any candidate built on the old one is stale.
import { createHash } from "node:crypto";
import { authorize, type AuthorityConfig } from "./authority.ts";
import { rawHash } from "./canon.ts";
import { contractHashOf } from "./decisions.ts";
import { FeatureError } from "./errors.ts";
import { eventFor } from "./lifecycle.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { DecisionRecord, FeatureContract, Id, Outcome } from "./types.ts";

export interface ConfirmInput { requestId: Id; expectedVersion: number; criteria: { id: Id; expectedOutcome?: string }[]; rationale: string; idempotencyKey: string }

export function confirmAcceptance(fs: SqliteFeatureStore, auth: AuthorityConfig, actor: Id, i: ConfirmInput): Outcome<FeatureContract> {
  const rec = fs.getRequest(i.requestId);
  if (!rec || rec.createdBy !== actor) throw new FeatureError("NOT_FOUND", `no such request ${i.requestId}`);
  if (!rec.contract) throw new FeatureError("NOT_FOUND", "there is no contract yet");
  if (["CANCELLED", "FAILED"].includes(rec.state)) throw new FeatureError("ILLEGAL_TRANSITION", `the request is ${rec.state}`);
  if (!i.idempotencyKey) throw new FeatureError("INVALID_SCHEMA", "an idempotency key is required");
  if (!Array.isArray(i.criteria) || !i.criteria.length || i.criteria.length > 200) throw new FeatureError("INVALID_SCHEMA", "name between 1 and 200 criteria");
  if (typeof i.rationale !== "string" || !i.rationale.trim()) throw new FeatureError("INVALID_SCHEMA", "say why these expectations are right (rationale)");
  if (rec.contractVersion !== i.expectedVersion) throw new FeatureError("VERSION_CONFLICT", `the contract is at version ${rec.contractVersion}, expected ${i.expectedVersion}`, rec.contractVersion);
  const verdict = authorize(auth, actor, "business", rec.createdBy);
  if (!verdict.allowed) throw new FeatureError("FORBIDDEN", `${actor} cannot confirm expected outcomes: ${verdict.reason}`);
  const ids = i.criteria.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new FeatureError("INVALID_SCHEMA", "a criterion is named twice");
  const missing = ids.filter((id) => !rec.contract!.acceptance.some((a) => a.id === id)); if (missing.length) throw new FeatureError("NOT_FOUND", `no such criterion: ${missing.join(", ")}`);
  for (const c of i.criteria) if (c.expectedOutcome !== undefined && (typeof c.expectedOutcome !== "string" || !c.expectedOutcome.trim() || c.expectedOutcome.length > 4000)) throw new FeatureError("INVALID_SCHEMA", `the expected outcome for ${c.id} must be 1-4000 characters`);
  const decisionId = `decision:${createHash("sha256").update(`${rec.requestId}\0confirm\0${i.idempotencyKey}`).digest("hex").slice(0, 24)}`;
  const prior = fs.listDecisions(rec.requestId).find((d) => d.id === decisionId);
  if (prior) return { status: "COMPLETE", value: rec.contract, evidenceIds: [prior.id], diagnostics: ["already confirmed"] };
  const decision: DecisionRecord = { schemaVersion: 1, id: decisionId, requestId: rec.requestId, kind: "DISPOSITION", questionId: "confirm-acceptance", answer: `confirmed expected outcomes for ${ids.join(", ")}`, actorId: actor,
    authorityBindingId: verdict.bindingId, contractVersion: rec.contractVersion, affectedIds: ids, rationale: i.rationale.trim().slice(0, 2000), createdAt: new Date().toISOString() };
  fs.putDecision(decision, eventFor(rec, "DecisionRecorded", actor, { decisionIds: [decisionId], requirementIds: [...new Set(rec.contract.acceptance.filter((a) => ids.includes(a.id)).flatMap((a) => a.requirementIds))], rationale: `confirmed ${ids.length} expected outcome(s)` }));
  const cur = fs.getRequest(rec.requestId)!; const version = cur.contractVersion + 1;
  const acceptance = cur.contract!.acceptance.map((a) => {
    const c = i.criteria.find((x) => x.id === a.id); if (!c) return a;
    const expectedOutcome = c.expectedOutcome?.trim() ?? a.expectedOutcome;
    return { ...a, expectedOutcome, oracleOrigin: "USER_EXAMPLE" as const, oracleSourceRefs: [...a.oracleSourceRefs, { artifactId: decisionId, version: "1", locator: `decision:${decisionId}`, contentHash: rawHash(expectedOutcome) }] };
  });
  const { hash: _h, ...body } = cur.contract!; const draft: Omit<FeatureContract, "hash"> = { ...body, version, acceptance };
  const contract: FeatureContract = { ...draft, hash: contractHashOf(draft) };
  const stale: Id[] = [];
  for (const c of fs.listCandidates(cur.requestId)) if (c.status === "MATERIALIZED" || c.status === "PLANNED") { fs.putCandidate({ ...c, status: "STALE" }, eventFor(cur, "VerificationInvalidated", actor, { before: c.bindingHash, rationale: `the contract moved to version ${version}` })); stale.push(c.id); }
  const after = fs.getRequest(cur.requestId)!;
  fs.updateRequest(after.requestId, after.version, { ...after, contract, contractVersion: version, workspace: { ...after.workspace, contractHash: contract.hash, candidateHash: stale.length ? undefined : after.workspace.candidateHash, workspaceVersion: after.workspace.workspaceVersion + 1 } },
    eventFor(cur, "ContractVersionCreated", actor, { decisionIds: [decisionId], before: cur.contract!.hash, after: contract.hash, rationale: `version ${version}: ${ids.length} expected outcome(s) confirmed by a person` }));
  return { status: "COMPLETE", value: contract, evidenceIds: [decisionId], diagnostics: stale.map((id) => `candidate ${id} is stale: it was built from contract version ${cur.contractVersion}`) };
}
