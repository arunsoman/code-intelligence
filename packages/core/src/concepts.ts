// Offline concept extraction (spec: "offline semantic extraction → concept cards"): capabilities, domain concepts,
// invariants, workflows and failure modes, each with provenance and an explicitly uncalibrated stated confidence.
import { createHash } from "node:crypto";
import type { Claim, ConceptCard, ConceptsOutput, ModelRunRef } from "@cie/schema";
import { gateClaim } from "./claims.ts";
import { bundleFor } from "./retrieval.ts";
import type { Store } from "./store.ts";

const CHUNK = 120;
const dirOf = (file: string) => file.split("/").slice(0, -1).join("/") || ".";

/** Group symbol ids by directory, merging small neighbours so each model request stays bounded. */
export function chunkSymbols(store: Store, revision: string): string[][] {
  const byDir = new Map<string, string[]>();
  for (const e of store.entities(revision)) if (e.kind !== "file" && e.kind !== "test") byDir.set(dirOf(e.file), [...(byDir.get(dirOf(e.file)) ?? []), e.entityId]);
  const chunks: string[][] = [];
  let cur: string[] = [];
  for (const [, ids] of [...byDir].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (cur.length && cur.length + ids.length > CHUNK) { chunks.push(cur); cur = []; }
    cur.push(...ids);
    while (cur.length > CHUNK) chunks.push(cur.splice(0, CHUNK));
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function cardsFromOutput(store: Store, revision: string, out: ConceptsOutput, bundle: ReturnType<typeof bundleFor>, source: string, run?: ModelRunRef): { cards: ConceptCard[]; claims: Claim[]; dropped: string[] } {
  const exists = new Set(store.entities(revision).map((e) => e.entityId));
  const cards: ConceptCard[] = [], claims: Claim[] = [], dropped: string[] = [];
  for (const c of out.cards) {
    const members = c.memberEntityIds.filter((m) => exists.has(m));
    const claim = gateClaim({ assertion: `${c.title}: ${c.summary}`, claimClass: "concept-card", evidenceIds: c.evidenceIds, rationaleSummary: `Extracted ${c.kind}; confidence is the model's own, uncalibrated statement (${c.statedConfidence}).` }, bundle, { run, store });
    claims.push(claim);
    if (claim.displayMode === "HIDDEN" || members.length === 0) { dropped.push(`${c.title}: ${claim.displayMode === "HIDDEN" ? "ungrounded" : "no members in the repository"}`); continue; }
    cards.push({
      id: "card:" + createHash("sha256").update(revision + c.kind + c.title).digest("hex").slice(0, 12), revision, kind: c.kind, title: c.title, summary: c.summary,
      members, evidenceIds: c.evidenceIds, claimId: claim.draft.id, statedConfidence: c.statedConfidence, source,
    });
  }
  return { cards, claims, dropped };
}
