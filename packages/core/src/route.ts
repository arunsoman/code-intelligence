// Which visual does a question want? Three layers, cheapest first, and the answer always says which layer gave it:
//   1. rules      the explicit patterns on each visual (visuals.ts) plus failure / invariant / "how does it work" (router.ts)
//   2. similarity a weighted keyword score per form, for phrasings no rule names ("what would an attacker reach")
//   3. model      only when both are unsure, and only a form name comes back (service.ts); see ROUTE in the model gateway
// A misread costs the user one wrong chart, so the reading is never hidden: the view carries it, with the other readings.
import type { FormId, ViewRoute } from "@cie/schema";
import { INVARIANT_RE, FAIL_RE } from "./router.ts";
import { VISUALS } from "./visuals.ts";

type Alt = ViewRoute["alternatives"][number];
const NAMES: Record<string, string> = {
  SemanticMap: "Architecture map", "CausalGraph:failure": "Failure-space map", "CausalGraph:invariant": "Wrong-value map",
  ...Object.fromEntries(VISUALS.map((v) => [v.formId, v.name])),
};
const key = (form: string, kind?: string) => (kind ? `${form}:${kind}` : form);
const alt = (form: FormId, kind?: "failure" | "invariant"): Alt => ({ form, ...(kind ? { kind } : {}), name: NAMES[key(form, kind)] ?? form });

/** "How does X work", "explain X", "what does X do": the architecture map is the answer, so this is a rule, not a default. */
const EXPLAIN_RE = /\bhow (?:does|do|is|are|did)\b.{0,60}\b(?:work|works|handled|implemented|built|structured|organi[sz]ed)\b|\bexplain\b|\bwhat does\b.{0,40}\bdo\b|\barchitecture of\b|\bshow me (?:the )?(?:code|map|structure)\b|\bhow (?!come\b)[^?]{0,40}?\bworks?\b(?! (?:like|this|that|the way)\b)/i;

/** Weighted vocabulary per form, matched on word prefixes. A strong word (2) names the form's subject; a weak word (1) leans toward it. */
const LEXICON: Record<string, [string, number][]> = {
  "CausalGraph:failure": [["fail", 2], ["break", 2], ["crash", 2], ["error", 2], ["exception", 1], ["reject", 1], ["decline", 1], ["timeout", 2], ["go wrong", 2], ["goes wrong", 2], ["cause", 1], ["bug", 1], ["why would", 1], ["can't", 1], ["cannot", 1]],
  "CausalGraph:invariant": [["incorrect", 2], ["wrong", 1], ["inconsisten", 2], ["corrupt", 2], ["drift", 2], ["mismatch", 2], ["out of sync", 2], ["negative", 1], ["invariant", 2], ["stale", 1]],
  TransactionJourney: [["journey", 2], ["walk", 2], ["step", 1], ["flow", 1], ["sequence", 1], ["end to end", 2], ["lifecycle", 1], ["trace through", 2], ["follow", 1], ["happens when", 2], ["life of", 2], ["take me through", 2], ["what occurs", 2], ["what happens", 2], ["trace what", 2], ["the flow", 1]],
  DataLineage: [["read", 1], ["write", 1], ["written", 1], ["updat", 1], ["lineage", 2], ["mutat", 2], ["touch", 1], ["field", 1], ["column", 1], ["table", 1], ["state", 1], ["where does", 1], ["who changes", 2], ["modif", 1]],
  SemanticDiff: [["changed", 2], ["change since", 2], ["diff", 2], ["before and after", 2], ["new in", 1], ["recent", 1], ["last release", 2], ["since", 1], ["compare", 1], ["between versions", 2], ["revision", 1]],
  Archaeology: [["history", 2], ["why is", 1], ["why was", 2], ["why did", 1], ["origin", 2], ["came to", 2], ["legacy", 1], ["commit", 1], ["who wrote", 1], ["historical", 2], ["used to", 1], ["evolv", 2], ["come from", 2], ["where did", 1], ["workaround", 1]],
  TrustBoundary: [["secur", 2], ["attack", 2], ["privilege", 2], ["permission", 2], ["authori", 2], ["access", 1], ["protect", 2], ["guard", 1], ["reach", 1], ["unauthenti", 2], ["exposed", 2], ["public", 1], ["expose", 2], ["entry point", 1], ["vulnerab", 2]],
  RuntimeOverlay: [["production", 2], ["runtime", 2], ["reported", 1], ["exception", 1], ["incident", 2], ["outage", 2], ["telemetry", 2], ["last week", 1], ["last 7 days", 2], ["failing test", 1], ["hot", 1], ["going wrong", 2], ["reported", 2], ["this week", 1]],
  RaceWindow: [["race", 2], ["concurren", 2], ["parallel", 1], ["simultaneous", 2], ["same time", 2], ["interleav", 2], ["lock", 1], ["thread", 1], ["atomic", 1], ["double", 1], ["twice", 1], ["idempoten", 1], ["thread safety", 2]],
  Counterfactual: [["what if", 2], ["remove", 1], ["delete", 1], ["drop", 1], ["without", 2], ["impact", 1], ["break if", 2], ["depend on", 1], ["rely on", 1], ["blast radius", 2], ["retire", 2], ["disable", 1], ["safe to remove", 2]],
  TestConfidence: [["test", 2], ["tested", 2], ["coverage", 2], ["assert", 1], ["confidence", 1], ["untested", 2], ["spec", 1], ["regression", 1], ["flaky", 2], ["safety net", 2]],
  Ownership: [["owner", 2], ["owns", 2], ["bus factor", 2], ["maintain", 1], ["team", 1], ["knowledge", 1], ["expert", 2], ["who knows", 2], ["codeowners", 2], ["responsible for", 1], ["who should", 1], ["contributor", 1], ["who maintains", 2], ["one person", 2], ["who should review", 2]],
  ConceptAtlas: [["implicit", 2], ["concept", 2], ["business rule", 2], ["domain", 1], ["undocumented", 2], ["hidden", 1], ["unwritten", 2], ["de facto", 2], ["tribal", 2], ["assumption", 1], ["convention", 1], ["glossary", 2], ["vocabular", 1], ["wrote down", 2], ["nobody wrote", 2]],
  PolicyMap: [["polic", 2], ["enforce", 2], ["compliance", 2], ["rule", 1], ["escape", 1], ["bypass", 2], ["skip", 1], ["around the", 1], ["gap", 1], ["audit", 1], ["must always", 1], ["regulat", 2], ["get around", 2]],
  ChangeRisk: [["risk", 2], ["risky", 2], ["fragile", 2], ["brittle", 2], ["refactor", 1], ["hardest to change", 2], ["safe to change", 2], ["churn", 2], ["hotspot", 1], ["coupling", 1], ["technical debt", 2], ["tech debt", 2], ["where should we", 1], ["hurt most", 2], ["hurt", 1]],
};

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'");
function similarity(question: string): { alt: Alt; score: number }[] {
  const q = ` ${norm(question)} `;
  const out: { alt: Alt; score: number }[] = [];
  for (const [k, words] of Object.entries(LEXICON)) {
    let score = 0;
    for (const [w, weight] of words) if (q.includes(` ${w}`) || (!w.includes(" ") && q.includes(w) && w.length >= 5)) score += weight;
    if (score > 0) { const [form, kind] = k.split(":"); out.push({ alt: alt(form as FormId, kind as "failure" | "invariant" | undefined), score }); }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The rule layer on its own: every rule that fires, in the order the router tries them. */
export function ruleHits(question: string): Alt[] {
  const hits: Alt[] = [];
  const add = (a: Alt) => { if (!hits.some((h) => key(h.form, h.kind) === key(a.form, a.kind))) hits.push(a); };
  for (const v of VISUALS) if (v.match && v.build && v.match.test(question)) add(alt(v.formId));
  if (INVARIANT_RE.test(question)) add(alt("CausalGraph", "invariant"));
  else if (FAIL_RE.test(question)) add(alt("CausalGraph", "failure"));
  if (EXPLAIN_RE.test(question)) add(alt("SemanticMap"));
  return hits;
}

/** A question can ask for two things at once ("why would the payment fail and who can reach it"); the first rule wins, the rest are offered. */
export function routeQuestion(question: string): ViewRoute {
  const hits = ruleHits(question);
  const sim = similarity(question);
  if (hits.length) {
    const [top, ...rest] = hits;
    const generic = (a: Alt) => a.form === "CausalGraph" || a.form === "SemanticMap";
    // "what breaks without X" fires the failure rule, but "without" names the counterfactual form. When a specific form's
    // vocabulary is at least as strong as a generic rule's, it wins and the generic reading is offered instead.
    const specific = generic(top) ? sim.find((x) => !generic(x.alt) && x.score >= 2 && x.score >= (sim.find((y) => key(y.alt.form, y.alt.kind) === key(top.form, top.kind))?.score ?? 0)) : undefined;
    const primary = specific ? specific.alt : top;
    const pool = [...(specific ? [top] : []), ...rest, ...sim.map((x) => x.alt)];
    const others = pool.filter((a, i, all) => key(a.form, a.kind) !== key(primary.form, primary.kind) && all.findIndex((b) => key(b.form, b.kind) === key(a.form, a.kind)) === i).slice(0, 3);
    if (specific) return { source: "similarity", confidence: "medium", ...primary, because: "A general rule matched, but the words point more strongly at this kind of view.", alternatives: others };
    return { source: "rule", confidence: rest.length ? "medium" : generic(top) && sim.some((x) => !generic(x.alt) && x.score >= 2) ? "medium" : "high", ...primary, because: rest.length ? `The wording matches ${hits.length} kinds of view; I picked the first.` : "The wording names this kind of view.", alternatives: others };
  }
  const [top, second] = sim;
  if (top && top.score >= 2 && top.score > (second?.score ?? 0)) {
    return { source: "similarity", confidence: top.score >= 3 && top.score >= (second?.score ?? 0) + 2 ? "medium" : "low", ...top.alt, because: "No exact rule matched, but the words are closest to this kind of view.", alternatives: sim.slice(1, 4).map((s) => s.alt) };
  }
  const map = alt("SemanticMap");
  return { source: "default", confidence: "low", ...map, because: "Nothing in the wording points to a specific kind of view, so I used the general architecture map.", alternatives: sim.slice(0, 3).map((s) => s.alt).filter((a) => a.form !== "SemanticMap") };
}
