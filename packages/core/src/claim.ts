// CIE v2 stage 3, shadow mode. Claims re-describe evidence the chat agent already produced as a checkable graph
// instead of prose — nothing here changes retrieval or what the model does; it only runs after a turn has already
// finished, from `env`/`cited` the agent loop (chat-agent.ts) already built. Per the migration plan's own stage 3:
// "wrapping existing retrieval output, logged not yet user-facing." The verifier (verifier.ts) is the consumer.
import type { AnswerClaim, AnswerClaimRef, AnswerClaimVerification, Claim, Entity, ViewSpec } from "@cie/schema";
import type { ToolEnv } from "./chat-tools.ts";
import type { Store } from "./store.ts";
import { bundleFor } from "./retrieval.ts";
import { compileView } from "./viewspec.ts";
import { verifyClaims } from "./verifier.ts";

/** The one place an `AnswerClaim` object gets built from an entity the index already has, for any predicate — every
 * specific builder below (container members, a located entity, an arbitrary set shown in a view) differs only in
 * which entities and which predicate, never in how the claim or its evidence/status is assembled. */
function claimFrom(entity: Entity, revision: string, predicate: string, object: AnswerClaimRef | { literal: string }): AnswerClaim {
  const span = entity.spans[0];
  return {
    claimId: `claim:${revision}:${predicate}:${entity.entityId}`,
    predicate, subject: { entityId: entity.entityId, label: entity.name }, object,
    evidence: span ? [span] : [], derivation: "extracted",
    status: span ? "VERIFIED" : "UNRESOLVED",
    statusReason: span ? undefined : `${entity.name} has no recorded source span`,
    revision,
  };
}

/** The one place a result verifies its claims and renders the Proof section every answer-producing path (the
 * deterministic templates, the agent loop, and every chart-producing branch via `asView`) attaches to its message —
 * called once per result, never re-implemented per branch. */
export function verifyAndProve(store: Store, claims: AnswerClaim[]): { verifications: AnswerClaimVerification[]; proof: string } {
  const verifications = verifyClaims(store, claims);
  return { verifications, proof: renderProof(claims, verifications) };
}

/** Claims for an arbitrary set of entity ids (e.g. everything a chart shows) — the general case `asView` uses when
 * no more specific builder (container membership, a located entity) applies. */
export function claimsFromEntities(store: Store, revision: string, entityIds: string[], predicate = "shown_in_view"): AnswerClaim[] {
  return store.entitiesById(revision, entityIds).map((e) => claimFrom(e, revision, predicate, { literal: e.file }));
}

/**
 * One `cited_in_answer` claim per entity the final answer cited, for exactly the entities Gate A (chat-agent.ts's
 * `assess()`) already required to be fully `read_code`'d before the answer was accepted. A citation that only
 * reached `env.seen` (found/listed, never read) has no claim here — same as it has no answer-validation gap either,
 * since Gate A would already have forced a repair or UNRESOLVED for it.
 */
export function claimsFromAnswer(env: ToolEnv, revision: string, cited: string[]): AnswerClaim[] {
  const claims: AnswerClaim[] = [];
  for (const id of cited) {
    const seen = env.seen.get(id);
    const read = env.sourceReads?.get(id);
    if (!seen || !read) continue;
    let covered = 0;
    for (const [start, end] of read.ranges) { if (start > covered) break; covered = Math.max(covered, end); }
    const complete = covered >= read.total;
    claims.push({
      claimId: `claim:${revision}:${id}`,
      predicate: "cited_in_answer",
      subject: { entityId: id, label: seen.name },
      object: { literal: seen.file },
      evidence: [{ sourceId: seen.file, contentHash: read.contentHash, revision, startByte: 0, endByteExclusive: read.total }],
      derivation: "extracted",
      status: complete ? "VERIFIED" : "UNRESOLVED",
      statusReason: complete ? undefined : `only ${covered} of ${read.total} source byte(s) of ${seen.name} were read`,
      revision,
    });
  }
  return claims;
}

/**
 * Deterministic `enumerate` answering: one `member_of` claim per entity the index already records as contained in
 * `containerId` (the same `contains` relationship `read_code`'s "Contains" section uses, chat-tools.ts) — no model
 * call, no tool-calling loop, no budget to exhaust. This is the zero-LLM-call answer to "what/how many X are in Y":
 * the fan-out across many similarly-named members (several sibling error classes, several near-duplicate enums)
 * that used to burn the chat agent's investigation budget one `find_code`/`read_code` pair at a time is instead a
 * single relationship-table lookup, verified per member against its real indexed span.
 */
export function claimsFromContainer(store: Store, revision: string, containerId: string): AnswerClaim[] {
  const container = store.entitiesById(revision, [containerId])[0];
  if (!container) return [];
  const memberIds = store.relationshipsFor(revision, containerId).filter((r) => r.kind === "contains" && r.from === containerId).map((r) => r.to);
  return store.entitiesById(revision, memberIds).map((m) => claimFrom(m, revision, "member_of", { entityId: containerId, label: container.name }));
}

/**
 * Deterministic `locate` answering: one claim naming exactly where an entity is defined, directly from its own
 * indexed span — no relationship lookup, no model call.
 */
export function claimsFromLocate(store: Store, revision: string, entityId: string): AnswerClaim[] {
  const entity = store.entitiesById(revision, [entityId])[0];
  return entity ? [claimFrom(entity, revision, "located_at", { literal: entity.file })] : [];
}

export function renderLocation(entity: { name: string; kind: string; file: string }, verifications: AnswerClaimVerification[]): string {
  const status = verifications[0];
  if (status?.status !== "VERIFIED") return `${entity.name} could not be independently verified: ${status?.reason ?? "no evidence recorded"}.`;
  return `${entity.name} is defined in ${entity.file} (${entity.kind}), verified against the indexed source, with no model call involved.`;
}

/** Renders `claimsFromContainer`'s output as the plain-text answer a user would read — one sentence stating what
 * was found and verified, naming exactly what was left out rather than silently dropping it. `kindOf` looks up each
 * member's entity kind (from the same store query that produced the claims) so a container with a single uniform
 * kind of member (the common case: a file of classes, an enum's variants) reads naturally. */
export function renderEnumeration(containerName: string, claims: AnswerClaim[], verifications: AnswerClaimVerification[], kindOf: (entityId: string) => string | undefined): string {
  const statusOf = new Map(verifications.map((v) => [v.claimId, v]));
  const verified = claims.filter((c) => statusOf.get(c.claimId)?.status === "VERIFIED");
  const kinds = new Set(verified.map((c) => kindOf(c.subject.entityId)).filter((k): k is string => !!k));
  const noun = kinds.size === 1 ? `${[...kinds][0]}${verified.length === 1 ? "" : "es"}` : `member${verified.length === 1 ? "" : "s"}`;
  const names = verified.map((c) => c.subject.label).sort();
  const unresolved = claims.length - verified.length;
  return [
    `${containerName} defines ${verified.length} ${noun}: ${names.join(", ")}.`,
    unresolved ? `${unresolved} other member(s) could not be independently verified and were left out of the count.` : `All ${verified.length} were independently verified against the indexed source, with no model call involved.`,
  ].join(" ");
}

/** The proof section every deterministic answer carries: one line per claim, naming exactly what was verified and
 * why, or exactly why it was not — never silent about which parts of the answer are actually backed by evidence. */
export function renderProof(claims: AnswerClaim[], verifications: AnswerClaimVerification[]): string {
  const statusOf = new Map(verifications.map((v) => [v.claimId, v]));
  const lines = claims.map((c) => {
    const v = statusOf.get(c.claimId);
    const file = c.evidence[0]?.sourceId;
    return `- ${c.subject.label ?? c.subject.entityId}${file ? ` (${file})` : ""}: ${v?.status ?? "UNKNOWN"}${v?.reason ? ` — ${v.reason}` : ""}`;
  });
  return ["Proof:", ...lines].join("\n");
}

/**
 * The initial chart for a deterministic answer: a minimal, guaranteed-correct view built directly from the claims
 * that actually verified, reusing the same `bundleFor` + `compileView` machinery chat-agent.ts already uses to
 * rebuild a chart when a model-chosen one doesn't match the answer's citations (chat-agent.ts). `answerEntityRefs`
 * is set on the view's params so the outer `Answering.converse` automatically attaches alternate representations
 * (`manifestFor`) — the "explore this answer as" visuals — without this function needing to build them itself.
 */
export function buildAnswerView(store: Store, revision: string, question: string, systemName: string, claims: AnswerClaim[], verifications: AnswerClaimVerification[]): { view: ViewSpec; claims: Claim[] } | null {
  const statusOf = new Map(verifications.map((v) => [v.claimId, v]));
  const verifiedIds = [...new Set(claims.filter((c) => statusOf.get(c.claimId)?.status === "VERIFIED").map((c) => c.subject.entityId))];
  if (!verifiedIds.length) return null;
  const bundle = bundleFor(store, revision, verifiedIds);
  const tiers = new Map(verifiedIds.map((id) => [id, "CRITICAL" as const]));
  const compiled = compileView({ question, bundle, tiers, store, systemName });
  compiled.view.params = { ...compiled.view.params, answerEntityRefs: verifiedIds.join("\n") };
  return compiled;
}
