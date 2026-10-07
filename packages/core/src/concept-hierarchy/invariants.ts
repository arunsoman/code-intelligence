// Invariants over the same graphs (plan §1). The soundness tier is a language-level claim, not a
// judgment: "verified" requires an explicit assertion on the guarded path — nothing else ever gets it
// (review checklist §8); a guard that crosses an await, a dynamic property write or a closure write is
// "speculative"; everything else is "supported". The tier is carried verbatim into the schema.
import { createHash } from "node:crypto";
import type { Invariant } from "@cie/schema";
import type { Store } from "../store.ts";
import { matchMotifs } from "./motifs.ts";
import type { LanguageSoundnessTier, Pdg } from "./types.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const LANGUAGE_SOUNDNESS_TIER = {
  /** Explicit assertion found on the guarded path. The only route to "verified". */
  VERIFIED: "verified" as LanguageSoundnessTier,
  /** The structure alone supports the claim. */
  SUPPORTED: "supported" as LanguageSoundnessTier,
  /** The guard crosses await, a dynamic property write or a closure write; the claim can be broken between them. */
  SPECULATIVE: "speculative" as LanguageSoundnessTier,
};

const guardedRegion = (pdg: Pdg, branchId: string) => pdg.nodes.filter((n) => pdg.edges.some((e) => e.from === branchId && e.to === n.id && e.kind === "guard"));

export function buildInvariants(store: Store, revision: string, pdgs: Pdg[]): Invariant[] {
  void store;
  const out: Invariant[] = [];
  for (const pdg of pdgs) {
    for (const m of matchMotifs(pdg).filter((x) => x.motif === "guarded-write")) {
      const branchId = m.nodes[0];
      const defId = m.nodes[1];
      const branch = pdg.nodes.find((n) => n.id === branchId);
      const def = pdg.nodes.find((n) => n.id === defId);
      if (!branch || !def?.name) continue;
      const region = guardedRegion(pdg, branchId);
      const regionIds = new Set(region.map((n) => n.id));
      const crossesAwait = region.some((n) => n.kind === "await");
      const crossesDynamicWrite = region.some((n) => n.kind === "def" && n.dynamicWrite);
      const hasAssertion = region.some((n) => n.kind === "assert");
      let tier: LanguageSoundnessTier = LANGUAGE_SOUNDNESS_TIER.SUPPORTED;
      let basis = `the write to ${def.name} sits under the guard shown; structure only`;
      if (crossesAwait || crossesDynamicWrite) {
        tier = LANGUAGE_SOUNDNESS_TIER.SPECULATIVE;
        basis = `the guard crosses ${crossesAwait ? "an await" : "a dynamic property write"}; the condition may not hold past it`;
      } else if (hasAssertion) {
        tier = LANGUAGE_SOUNDNESS_TIER.VERIFIED;
        basis = "an explicit assertion sits on the guarded path";
      }
      out.push({
        id: `inv:${sha(`${pdg.entityId}|${def.name}|${branchId}`).slice(0, 12)}`,
        revision,
        subjectEntityId: pdg.entityId,
        variable: def.name,
        statement: `${def.name} is written only under the guard in ${pdg.entityId.split("#").pop()}`,
        tier,
        basis,
        guardCondition: branch.name ?? null,
        evidenceIds: [],
        members: regionIds.size,
      } as Invariant);
    }
  }
  return out;
}
