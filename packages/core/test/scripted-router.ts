// A router for tests that is not a model: answers exactly what a script says, and for anything else the general architecture map (what the product itself
// falls back to). No pattern in it reads the question. It makes the plumbing around the router deterministic;
// how well a real model reads questions is measured by scripts/eval-tiny-models.ts and route-live.test.ts, not here.
import { candidateLabels, type RouterAnswer, type RouterModel, type RouterRequest } from "../src/llm-router.ts";

/** What the questions the suite asks are read as. Keys are lower case without a trailing "?"; anything not listed gets the general map. */
const READINGS: Record<string, string> = {
  "show me everything that could cause a payment to fail": "CausalGraph:failure", "why could this balance become incorrect": "CausalGraph:invariant",
  "walk me through createpayment": "TransactionJourney", "walk me through createpayment step by step": "TransactionJourney", "walk me through place_order step by step": "TransactionJourney", "walk me through checkout step by step": "TransactionJourney",
  "who reads and writes balance": "DataLineage", "why is adjustbalance not transactional": "Archaeology", "why is adjustbalancev2 not transactional": "Archaeology",
  "who owns what and where is the bus factor 1": "Ownership", "who can reach adjustbalance and what stops them": "TrustBoundary", "show the trust boundaries": "TrustBoundary",
  "which policies are enforced and where do they have gaps": "PolicyMap", "where is it risky to change things": "ChangeRisk", "where is it risky to change things for a security review": "ChangeRisk",
  "where can balance race": "RaceWindow", "what if we remove the ledger module": "Counterfactual", "what happens without checkfraud": "Counterfactual", "what if we remove the flux capacitor": "Counterfactual",
  "what has been going wrong in the last 7 days": "RuntimeOverlay", "what changed since the last index": "SemanticDiff", "show the implicit concepts in this code": "ConceptAtlas",
  "how well tested are our operations": "TestConfidence", "give me an overview of the whole project": "overview", "why are these connected": "connected", "explain this": "connected", "what stops a fraudulent payment": "TrustBoundary",
};
const norm = (q: string) => q.trim().toLowerCase().replace(/\?+$/, "");

export class ScriptedRouter implements RouterModel {
  readonly name = "scripted";
  seen: RouterRequest[] = [];
  private script: Record<string, RouterAnswer | null>;
  private rules?: (q: string) => RouterAnswer | undefined;
  /** `rules` answers for questions that cannot be listed ahead of time (names found while the test runs). */
  constructor(script: Record<string, RouterAnswer | null> = {}, rules?: (q: string) => RouterAnswer | undefined) { this.script = script; this.rules = rules; }
  async choose(req: RouterRequest): Promise<RouterAnswer | null> {
    this.seen.push(req);
    const q = req.user.replace(/^Q: /, "").replace(/\nA:$/, "");
    if (q in this.script) return this.script[q];
    const ruled = this.rules?.(q);
    if (ruled && req.labels.includes(ruled.label)) return ruled;
    const read = READINGS[norm(q)];
    if (read && req.labels.includes(read)) return { label: read, target: "" };
    if (process.env.CIE_LOG_UNSCRIPTED) console.error("UNSCRIPTED::" + q);
    return { label: "SemanticMap", target: "" };
  }
}
export { candidateLabels };
