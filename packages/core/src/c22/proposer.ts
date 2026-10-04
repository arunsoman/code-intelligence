// C22 model-backed seeding (design §20 step 3): the model proposes candidate explanations, and everything it says
// becomes data for the engine's own validation — never a command. This file is the pure conversion from the
// registry-validated hypotheses.v1 output to engine drafts; the entity/evidence ids it carries are checked against
// the pinned scope by validateCandidate in the engine, so a confident invention is rejected, not executed.
import { randomUUID } from "node:crypto";
import type { CallContext, EvidenceBundle, HypothesesOutput } from "@cie/schema";
import { hash } from "./reducer.ts";
import type { HypothesisDraft, MechanismLink, OutcomeTag, Prediction } from "./types.ts";

const TAGS: readonly OutcomeTag[] = ["PRESENT", "ABSENT_WITH_COVERAGE", "MATCH", "MISMATCH"];

/** Convert one registry-validated hypothesis draft. Evidence ids the retrieval bundle does not contain are dropped
 *  here, so "say what motivated it" validation can only be satisfied by citations the model was actually given. */
export function toDraft(out: HypothesesOutput["hypotheses"][number], bundle: Pick<EvidenceBundle, "evidence">): HypothesisDraft {
  const known = new Set(bundle.evidence.map((e) => e.id));
  const keep = (ids: readonly string[]) => [...new Set(ids)].filter((id) => known.has(id)).slice(0, 10);
  const mechanism: MechanismLink[] = out.mechanism.map((m) => ({
    from: { kind: "entity", ref: m.from }, to: { kind: "entity", ref: m.to }, relation: m.relation, evidenceIds: keep(m.evidenceIds),
  }));
  const predictions: Prediction[] = out.predictions.map((p) => ({
    id: "prd:" + hash(p.description, p.tool, p.payload),
    description: p.description,
    checkId: "chk:" + hash(p.tool, p.payload),
    request: { toolId: p.tool, payload: { ...p.payload } },
    outcomeIfTrue: (p.outcomeIfTrue ?? []).filter((t) => (TAGS as readonly string[]).includes(t)) as OutcomeTag[],
    outcomeIfFalse: (p.outcomeIfFalse ?? []).filter((t) => (TAGS as readonly string[]).includes(t)) as OutcomeTag[],
    distinguishingHypothesisIds: [],
    essentialForHypothesis: p.essential === true,
  }));
  return {
    statement: out.statement,
    mechanism,
    assumptions: out.assumptions.map((statement) => ({ id: "asm:" + hash(statement), statement, entityRefs: [], verification: "UNCHECKED" as const, evidenceIds: [] })),
    predictions,
    basisEvidenceIds: keep(out.basisEvidenceIds),
    alternativeRelations: [],
  };
}

export function toDrafts(out: HypothesesOutput, bundle: Pick<EvidenceBundle, "evidence">): HypothesisDraft[] {
  return out.hypotheses.map((h) => toDraft(h, bundle));
}

/** A synthetic context for the seeding call. The engine calls the proposer from inside a wave, which carries no
 *  CallContext of its own; the model call is attributed like any other system step, with a bounded deadline. */
export const seedContext = (): CallContext => ({
  requestId: randomUUID(), idempotencyKey: randomUUID(), actor: { principalId: "system:c22-seed", tenantId: "local", sessionId: "c22" },
  deadlineMs: Date.now() + 45_000, traceId: randomUUID(),
});