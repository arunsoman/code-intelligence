// The visualization catalogue (spec §14): sixteen forms, each a different answer to a different kind of question.
// A form is chosen from the question, or explicitly from the gallery. Order matters: more specific forms first.
import type { Claim, FormId, ViewSpec } from "@cie/schema";
import { buildAtlas } from "./forms/atlas.ts";
import { buildCounterfactual } from "./forms/counterfactual.ts";
import { buildDiff } from "./forms/diffview.ts";
import { buildArchaeology } from "./forms/archaeology.ts";
import { buildJourney } from "./forms/journey.ts";
import { buildLineage } from "./forms/lineage.ts";
import { buildOwnership } from "./forms/ownership.ts";
import { buildRace } from "./forms/race.ts";
import { buildRuntime } from "./forms/runtime.ts";
import { buildTerrain } from "./forms/terrain.ts";
import { buildTestConfidence } from "./forms/testconf.ts";
import { buildPolicy, buildTrust } from "./forms/trust.ts";
import type { RevisionRow, Store } from "./store.ts";
import { claimOf, short } from "./forms/common.ts";

export type Need = "git" | "concepts" | "tests" | "coverage" | "exceptions" | "two revisions" | "stack trace";
export type Built = { view: ViewSpec; claims: Claim[] };
export interface VisualDef {
  code: string; formId: FormId; name: string; blurb: string; example: string; needs: Need[]; match?: RegExp;
  build?: (store: Store, rev: RevisionRow, question: string, subject?: string) => Built;
}

export const VISUALS: VisualDef[] = [
  { code: "V11", formId: "Counterfactual", name: "Counterfactual overlay", blurb: "What would follow if part of the code were removed: today's code solid, the hypothetical ghost-outlined, consequences attached.", example: "What if we remove the ledger module?", needs: [], match: /\bwhat (?:if|would happen if|happens if)\b.*\b(?:remove|delete|drop|disable|retire|extract)|\bwhat happens without\b|\bwithout the\b.{0,30}\b(?:module|service|check|function)\b|\bif we (?:remove|delete|drop|disable)\b/i, build: buildCounterfactual },
  { code: "V6", formId: "SemanticDiff", name: "Semantic diff timeline", blurb: "What conceptually changed between two indexed revisions: before and after side by side, with what it means.", example: "What changed since the last index?", needs: ["two revisions"], match: /\b(?:what(?:'s| has| have)? changed|changes? since|semantic diff|before and after|change narrative|what's new)\b/i, build: buildDiff },
  { code: "V7", formId: "Archaeology", name: "Archaeology chain", blurb: "Why code became what it is: the commits that shaped it beside the constraints written in it that still apply.", example: "Why is adjustBalance not transactional?", needs: ["git"], match: /\bwhy is\b.{0,60}\b(?:like this|like that|written|this way|not|so)\b|\bhistory of\b|\barchaeolog|\bhow did\b.{0,40}\b(?:come to|end up)\b|\borigin of\b|\bwho wrote\b.{0,30}\bwhy\b/i, build: buildArchaeology },
  { code: "V10", formId: "RaceWindow", name: "Concurrency and race-window map", blurb: "Execution paths touching shared state side by side, with transaction brackets and where two can interleave badly.", example: "Where can balance race?", needs: [], match: /\brace(?:s| conditions?| windows?)?\b|\bconcurren|\binterleav|\bsimultaneous|\bat the same time\b|\bdouble.?(?:spend|charge|credit)/i, build: buildRace },
  { code: "V15", formId: "PolicyMap", name: "Policy enforcement map", blurb: "A routes-by-rules matrix (or graph): where code enforces each rule, and the routes that get around it. Rules held only by convention are marked as such.", example: "Which policies are enforced and where do they have gaps?", needs: [], match: /\bpolic(?:y|ies)\b|\benforce(?:d|ment)\b|\bcompliance\b|\bescape routes?\b|\bheld by convention\b/i, build: buildPolicy },
  { code: "V8", formId: "TrustBoundary", name: "Trust-boundary and privilege map", blurb: "Where requests enter, the gates that can refuse them, and the state they can reach, with unprotected paths shown as hypotheses.", example: "Who can reach adjustBalance and what stops them?", needs: [], match: /\btrust boundar|\bwho can reach\b|\bprivilege|\bunprotected\b|\battack surface\b|\bsecurity map\b|\bwhat (?:protects|guards|stops)\b|\benforcement points?\b|\bgates?\b/i, build: buildTrust },
  { code: "V5", formId: "DataLineage", name: "Data lineage and mutation graph", blurb: "Every writer and reader of a piece of data, with transaction boundaries and order-of-application risks.", example: "Who reads and writes balance?", needs: [], match: /\bwho (?:writes|reads|updates|touches|changes)\b|\bwriters? and readers?\b|\blineage\b|\bwhere is\b.{0,30}\b(?:written|updated|read|changed)\b|\bmutat(?:es|ion)\b/i, build: buildLineage },
  { code: "V4", formId: "TransactionJourney", name: "Transaction journey map", blurb: "One operation as a swim-lane sequence across modules, with decision points and asynchronous hand-offs.", example: "Walk me through createPayment step by step", needs: [], match: /\bjourney\b|\bwalk me through\b|\bstep by step\b|\bend to end\b|\btransaction flow\b|\bsequence of\b/i, build: buildJourney },
  { code: "V9", formId: "RuntimeOverlay", name: "Runtime overlay", blurb: "Reported exceptions and failing tests projected onto the structure, tinted by how often and how recently. Reported data, not live telemetry.", example: "What has been going wrong in the last 7 days?", needs: ["exceptions"], match: /\bruntime\b|\breported (?:exceptions?|errors?)\b|\bin production\b|\bhot ?spots?\b|\bwhat(?:'s| is) (?:failing|going wrong|breaking)\b|\bgoing wrong\b/i, build: buildRuntime },
  { code: "V12", formId: "TestConfidence", name: "Test-confidence map", blurb: "A behaviours-by-tests matrix (or graph): how much of each behaviour a test reaches, which tests fail, and which properties no test asserts.", example: "How well tested are our operations?", needs: ["tests"], match: /\btest confidence\b|\bprotected by tests?\b|\bwhich tests\b|\bhow well tested\b|\bwell.tested\b|\buntested\b|\btest coverage\b/i, build: buildTestConfidence },
  { code: "V13", formId: "Ownership", name: "Ownership and knowledge map", blurb: "Who owns code formally and in practice, where knowledge is thin, and whose has gone stale.", example: "Who owns what and where is the bus factor 1?", needs: ["git"], match: /\bwho owns\b|\bownership\b|\bbus factor\b|\bwho (?:understands|knows)\b|\bknowledge map\b|\bcode ?owners\b/i, build: buildOwnership },
  { code: "V14", formId: "ConceptAtlas", name: "Implicit-concept atlas", blurb: "Hidden concepts (rules, workflows, failure modes) pinned onto the code that implements them, with scatter and missing enforcement.", example: "Show the implicit concepts in this code", needs: ["concepts"], match: /\bimplicit concepts?\b|\bconcept atlas\b|\bscattered\b|\bundocumented (?:rules|boundaries)\b|\bbusiness rules\b|\bde facto\b|\bhidden concepts?\b/i, build: buildAtlas },
  { code: "V16", formId: "ChangeRisk", name: "Change-risk terrain", blurb: "A relief map of how hard each part is to change, composed from coupling, churn, incidents, test gaps and thin knowledge, with tunable weights.", example: "Where is it risky to change things?", needs: [], match: /\bchange.?risk\b|\brisky to change\b|\bsafe to change\b|\bterrain\b|\bhardest to change\b|\brefactor(?:ing)? risk\b|\bwhere is it risky\b/i, build: buildTerrain },
  // Forms built earlier; they are chosen by the router in router.ts / by pasting a trace.
  { code: "V1", formId: "SemanticMap", name: "Intent-relative architecture map", blurb: "Relevant code grouped by responsibility, with semantic zoom from the whole system down to the code.", example: "Show me how authentication works", needs: [] },
  { code: "V2", formId: "HypothesisGraph", name: "Causal hypothesis graph", blurb: "A pasted exception becomes ranked suspects with the evidence that discriminates between them; you can steer it.", example: "Paste a stack trace into the conversation", needs: ["stack trace"] },
  { code: "V3", formId: "CausalGraph", name: "Failure-space map", blurb: "Everything that could make an operation fail, or make a value wrong, each cited.", example: "Show me everything that could cause a payment to fail", needs: [] },
];

/** Any inferred or hypothetical edge without its own claim (asynchronous hand-offs, mostly) gets one, so nothing uncertain is shown unexplained. */
export function ensureEdgeClaims(store: Store, rev: RevisionRow, built: Built): Built {
  const rels = new Map(store.allRelationships(rev.id).map((r) => [r.id, r]));
  const have = new Map(built.claims.map((c) => [c.draft.id, c]));
  const made = new Map<string, Claim>();
  for (const e of built.view.edges) {
    if (e.claimId || (e.displayMode !== "HYPOTHESIS" && e.displayMode !== "INFERENCE")) continue;
    const r = e.relationshipId ? rels.get(e.relationshipId) : undefined;
    if (!r || r.kind !== "async-flow") continue;
    let c = made.get(r.id);
    if (!c) { c = claimOf(store, rev.id, { assertion: `${short(r.from)} hands work to ${short(r.to)} asynchronously${r.label ? ` via ${r.label}` : ""}; ordering and failures are not visible to the caller.`, claimClass: "async-handoff", evidenceIds: r.evidence.map((x) => x.id), rationaleSummary: "A publish/subscribe pair joined by a literal topic name.", structure: { kind: "path", entityIds: [r.from, r.to] } }); made.set(r.id, c); }
    e.claimId = c.draft.id;
  }
  for (const c of made.values()) if (!have.has(c.draft.id)) built.claims.push(c);
  return built;
}

export function matchVisual(question: string): VisualDef | null {
  return VISUALS.find((v) => v.match && v.build && v.match.test(question)) ?? null;
}
export const visualByForm = (f: string) => VISUALS.find((v) => v.formId === f || v.code === f) ?? null;

export interface CatalogEntry { code: string; formId: FormId; name: string; blurb: string; example: string; needs: Need[]; available: boolean; reason?: string }
export function catalog(store: Store, rev: RevisionRow | null, git: boolean): CatalogEntry[] {
  const have = {
    git, concepts: rev ? store.concepts(rev.id).length > 0 : false,
    tests: rev ? store.factsByPredicate(rev.id, "test_result").length > 0 : false,
    coverage: rev ? store.factsByPredicate(rev.id, "coverage").length > 0 : false,
    exceptions: store.exceptions(false).length > 0, "two revisions": rev ? !!store.previousRevision(rev.id) : false, "stack trace": true,
  } as Record<Need, boolean>;
  const why: Record<Need, string> = { git: "needs a git repository", concepts: "needs concept cards (Extract concepts)", tests: "needs a test results file", coverage: "needs a coverage report", exceptions: "needs reported exceptions", "two revisions": "needs two indexed revisions (change something and re-index)", "stack trace": "" };
  const staleCards = !!rev && !have.concepts && store.conceptVersions(rev.repoRoot).length > 0;
  return VISUALS.map((v) => {
    const missing = v.needs.find((n) => !have[n]);
    return { code: v.code, formId: v.formId, name: v.name, blurb: v.blurb, example: v.example, needs: v.needs, available: !!rev && !missing, reason: !rev ? "index a repository first" : missing === "concepts" && staleCards ? "concept cards are from an older revision (Extract concepts again)" : missing ? why[missing] : undefined };
  }).sort((a, b) => Number(a.code.slice(1)) - Number(b.code.slice(1)));
}
