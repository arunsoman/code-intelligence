// Axis B: semantic concepts (plan §1). Motif matches become concepts; composition rules derive the
// forms the catalogue deliberately does not name (debit/credit/transfer, leak candidates). Nothing
// here assigns business meaning: "debit-form" is a shape claim (a guarded subtraction), and the
// anchored name a model later gives it is stored separately and never gated as a claim.
import { createHash } from "node:crypto";
import type { SemanticConcept } from "@cie/schema";
import type { Store } from "../store.ts";
import { conceptConfig } from "./config.ts";
import { canonicalMotifHash } from "./canonicalize.ts";
import { matchMotifs } from "./motifs.ts";
import type { Pdg } from "./types.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface SemanticBuildResult {
  concepts: SemanticConcept[];
  /** Concepts whose id (and so label) carried over from the previous run. */
  carried: number;
  gaps: string[];
}

const evidenceFor = (store: Store, revision: string, entityId: string): string[] => {
  const out: string[] = [];
  for (const predicate of ["throws", "writes", "uses_transaction", "publishes", "subscribes"]) {
    for (const f of store.factsFor(revision, entityId)) {
      if (f.predicate !== predicate) continue;
      for (const e of f.evidence) if (!out.includes(e.id)) out.push(e.id);
      if (out.length >= 8) return out;
    }
  }
  return out;
};

interface Draft {
  entityId: string | null;
  kind: string;
  motifs: string[];
  features: Record<string, number>;
  compositionRule: string | null;
  /** The variable the decisive motif bound, for complementary-pair matching. */
  variable: string | null;
  tier: SemanticConcept["soundness"]["tier"];
  basis: string;
  source: SemanticConcept["source"];
}

const motifDraft = (entityId: string, motif: string, count: number, ops: Record<string, number>): Draft => ({
  entityId,
  kind: motif,
  motifs: [motif],
  features: { [`motif:${motif}`]: count, ...ops },
  compositionRule: null,
  variable: null,
  tier: "supported",
  basis: `matched structural motif ${motif}`,
  source: "MOTIF",
});

const hashOf = (d: Draft) => canonicalMotifHash({ motifs: d.motifs, features: d.features, compositionRule: d.compositionRule });

/**
 * One pass over the graphs. A function contributes one concept per distinct motif shape; composed
 * forms (debit/credit/transfer, leak candidates) replace the plain motif concept they specialise.
 */
export function buildSemanticConcepts(store: Store, revision: string, pdgs: Pdg[], previous: SemanticConcept[] = []): SemanticBuildResult {
  const minMembers = conceptConfig().composedMinMembers.value;
  const drafts: Draft[] = [];
  for (const pdg of pdgs) {
    const matches = matchMotifs(pdg);
    const byMotif = new Map<string, number>();
    for (const m of matches) byMotif.set(m.motif, (byMotif.get(m.motif) ?? 0) + 1);
    const ops: Record<string, number> = {};
    for (const n of pdg.nodes) if (n.kind === "def" && n.op) ops[n.op] = (ops[n.op] ?? 0) + 1;

    // Composition 1: guarded-write specialised by the operator that computes the written value.
    const gw = matches.find((m) => m.motif === "guarded-write");
    let composed = false;
    if (gw) {
      const defNode = pdg.nodes.find((n) => gw.nodes.includes(n.id) && n.kind === "def");
      if (defNode?.op === "op:sub") {
        drafts.push({ entityId: pdg.entityId, kind: "debit-form", motifs: ["guarded-write"], features: { "motif:guarded-write": 1, "op:sub": 1 }, compositionRule: "guarded-write+op:sub", variable: gw.binds.var ?? null, tier: "supported", basis: "a guarded write whose value is a subtraction", source: "COMPOSITION" });
        composed = true;
      } else if (defNode?.op === "op:add") {
        drafts.push({ entityId: pdg.entityId, kind: "credit-form", motifs: ["guarded-write"], features: { "motif:guarded-write": 1, "op:add": 1 }, compositionRule: "guarded-write+op:add", variable: gw.binds.var ?? null, tier: "supported", basis: "a guarded write whose value is an addition", source: "COMPOSITION" });
        composed = true;
      }
    }
    // Composition 2: an acquire with no release after it is a leak candidate (speculative).
    if (!byMotif.has("resource-acquire-release") && pdg.nodes.some((n) => n.kind === "acquire")) {
      drafts.push({ entityId: pdg.entityId, kind: "leak-candidate", motifs: ["resource-acquire-release"], features: { "motif:resource-acquire-release": 1 }, compositionRule: "acquire-without-release", variable: null, tier: "speculative", basis: "an acquire call with no matching release call on any path the graph shows", source: "COMPOSITION" });
      composed = true;
    }
    // Plain motif concepts: every matched motif except the one a composed form consumed.
    for (const [motif, count] of byMotif) {
      if (composed && motif === "guarded-write") continue;
      if (composed && motif === "resource-acquire-release") continue;
      drafts.push(motifDraft(pdg.entityId, motif, count, ops));
    }
  }

  // Composition 3: a complementary pair — a debit-form and a credit-form over the same variable,
  // in different functions — is the shape of a transfer. Its members are the two functions.
  const debits = drafts.filter((d) => d.kind === "debit-form");
  const credits = drafts.filter((d) => d.kind === "credit-form");
  const consumed = new Set<Draft>();
  const transfers: { members: string[]; variable: string | null }[] = [];
  for (const d of debits) {
    if (!d.variable || !d.entityId) continue;
    const credit = credits.find((c) => c !== d && !consumed.has(c) && c.variable === d.variable && c.entityId && c.entityId !== d.entityId);
    if (!credit) continue;
    consumed.add(d); consumed.add(credit);
    transfers.push({ members: [d.entityId, credit.entityId!], variable: d.variable });
    drafts.push({
      entityId: null, kind: "transfer-form", motifs: ["guarded-write", "guarded-write"],
      features: { "op:add": 1, "op:sub": 1 }, compositionRule: "complementary-pair",
      variable: d.variable, tier: "supported",
      basis: `a debit-form and a credit-form over the same variable (${d.variable}) in different functions`,
      source: "COMPOSITION",
    });
  }
  const finalDrafts = drafts.filter((d) => d.kind === "transfer-form" || !consumed.has(d));

  const concepts: SemanticConcept[] = [];
  let ti = 0;
  const prevById = new Map(previous.map((p) => [p.id, p]));
  let carried = 0;
  for (const d of finalDrafts) {
    const members = d.kind === "transfer-form" ? transfers[ti++]?.members ?? [] : [d.entityId!];
    if (members.length < (d.kind === "transfer-form" ? minMembers : 1)) continue;
    const hash = hashOf(d);
    const memberKey = sha([...members].sort().join("|")).slice(0, 10);
    const id = `sc:${hash}-${memberKey}`;
    const prev = prevById.get(id);
    if (prev) carried++;
    concepts.push({
      id,
      revision,
      kind: d.kind,
      label: prev?.label ?? null,
      namedBy: prev?.namedBy ?? null,
      members,
      evidenceIds: members.flatMap((m) => evidenceFor(store, revision, m)).slice(0, 8),
      canonicalMotifHash: hash,
      compositionRule: d.compositionRule,
      features: d.features,
      soundness: { tier: d.tier, basis: d.basis },
      source: d.source,
    });
  }
  const seen = new Set<string>();
  const unique = concepts.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  return { concepts: unique, carried, gaps: [] };
}
