// CIE v2 stage 3, shadow mode: deterministic claim verification. No model call and no timeout-based fail-closed gate
// the way answer-validation.ts's reviewAnswer has — a claim is checked against the store and the live file directly.
// Today this only verifies the one claim shape claim.ts builds (`cited_in_answer`); a later stage's computed/inferred
// claims extend the checks here, they do not replace this function.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { AnswerClaim, AnswerClaimVerification } from "@cie/schema";
import type { Store } from "./store.ts";

export function verifyClaim(store: Store, claim: AnswerClaim): AnswerClaimVerification {
  const span = claim.evidence[0];
  if (!span) return { claimId: claim.claimId, status: "UNRESOLVED", reason: "no evidence span recorded" };
  const entity = store.entitiesById(claim.revision, [claim.subject.entityId])[0];
  if (!entity) return { claimId: claim.claimId, status: "UNRESOLVED", reason: `${claim.subject.entityId} is not indexed in revision ${claim.revision}` };
  if (claim.status === "UNRESOLVED") return { claimId: claim.claimId, status: "UNRESOLVED", reason: claim.statusReason ?? "incomplete source coverage" };
  const rev = store.revision(claim.revision, true);
  if (!rev) return { claimId: claim.claimId, status: "UNRESOLVED", reason: `revision ${claim.revision} is no longer available` };
  try {
    const path = realpathSync(resolve(rev.repoRoot, span.sourceId));
    const liveHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (liveHash !== span.contentHash) return { claimId: claim.claimId, status: "UNRESOLVED", reason: `${span.sourceId} changed on disk since this claim was recorded` };
  } catch { return { claimId: claim.claimId, status: "UNRESOLVED", reason: `${span.sourceId} could not be read to verify this claim` }; }
  return { claimId: claim.claimId, status: "VERIFIED", reason: "the cited entity is indexed, its source is unchanged, and the full span was read" };
}

export function verifyClaims(store: Store, claims: AnswerClaim[]): AnswerClaimVerification[] { return claims.map((c) => verifyClaim(store, c)); }
