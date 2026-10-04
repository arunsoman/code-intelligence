// Reading a question with a small local language model. There are no patterns here: the model is shown a closed list of labels (the kinds of view,
// plus the conversational requests that make sense right now), the few labelled examples nearest to the question, and must answer with one label and,
// for a request that names something ("pin charge"), the words it named. The label is constrained by the daemon's JSON schema, so it can only be one
// of the candidates; the target is free text and is matched against the code afterwards, never trusted.
//
// What this costs and buys is measured, not assumed: scripts/eval-tiny-models.ts (docs/eval-tiny-models.json). Without a model the router says so and the
// caller falls back to the general map; nothing is guessed in its place.
import type { FormId, ViewRoute } from "@cie/schema";
import { HashEmbedder, cosine } from "./embeddings.ts";
import { EXEMPLARS, INTENT_EXEMPLARS } from "./route-exemplars.ts";
import { VISUALS } from "./visuals.ts";

export type Intent =
  | { type: "resume"; name: string }
  | { type: "whyShown" }
  | { type: "whyHidden"; target: string }
  | { type: "ignore" | "restore" | "whySuspect"; target: string }
  | { type: "pin" | "unpin" | "boost" | "demote"; target: string }
  | { type: "overview" }
  | { type: "zoom"; direction: "in" | "out" | "overview" }
  | { type: "connected" }
  | { type: "investigate" }
  | { type: "ask"; route?: ViewRoute };

export interface IntentContext { hasView: boolean; viewForm?: string; selectionCount: number; looksLikeTrace: boolean }

export interface RouterRequest { system: string; user: string; labels: string[] }
export interface RouterAnswer { label: string; target: string }
/** Anything that can pick one label from a closed list: a local Ollama model in production, a scripted one in tests. */
export interface RouterModel { readonly name: string; choose(req: RouterRequest): Promise<RouterAnswer | null> }

export const FORM_LABELS: Record<string, string> = {
  SemanticMap: "how one feature or module is built and how its parts fit together",
  "CausalGraph:failure": "everything that could make an operation fail, error, throw or be rejected",
  "CausalGraph:invariant": "how a value could become wrong, inconsistent, stale, negative or out of sync",
  TransactionJourney: "one operation followed step by step, in order, from start to finish",
  DataLineage: "who reads or writes a field, column, table or piece of state",
  SemanticDiff: "what changed between two versions or since the last index",
  Archaeology: "why the code became the way it is: history, reasons, origin of a decision",
  TrustBoundary: "who can reach what; authentication, authorisation, privileges, attack surface",
  RuntimeOverlay: "errors, incidents, exceptions and failing tests seen in production or reports",
  RaceWindow: "concurrency: races, locks, threads, things that could run twice at once",
  Counterfactual: "what would happen or break if something were removed, disabled or went away",
  TestConfidence: "test coverage, untested behaviour, how much tests can be trusted",
  Ownership: "who wrote or owns the code, who to ask, bus factor",
  ConceptAtlas: "hidden domain concepts, business rules and unwritten conventions in the code",
  PolicyMap: "which rules or policies are enforced in code and where they can be bypassed",
  ChangeRisk: "which parts are risky, fragile or hard to change safely",
};
const INTENT_LABELS: Record<string, { says: string; when: (c: IntentContext) => boolean }> = {
  overview: { says: "the project as a whole: its architecture, structure, purpose, technology stack", when: () => true },
  resume: { says: "reopen a saved investigation by name", when: () => true },
  zoomIn: { says: "show more detail on the current map", when: (c) => c.hasView },
  zoomOut: { says: "show less detail on the current map", when: (c) => c.hasView },
  whyHidden: { says: "ask why a named element is not on the current map", when: (c) => c.hasView },
  pin: { says: "keep a named element always visible", when: (c) => c.hasView },
  unpin: { says: "stop keeping a named element pinned or boosted", when: (c) => c.hasView },
  boost: { says: "rank a named element higher", when: (c) => c.hasView },
  demote: { says: "rank a named element lower", when: (c) => c.hasView },
  whyShown: { says: "ask why the selected element is on the map", when: (c) => c.selectionCount >= 1 },
  connected: { says: "ask how the selected elements are related, or explain them", when: (c) => c.selectionCount >= 1 },
  ignore: { says: "rule a named suspect out", when: (c) => c.viewForm === "HypothesisGraph" },
  restore: { says: "bring a ruled-out suspect back", when: (c) => c.viewForm === "HypothesisGraph" },
  whySuspect: { says: "ask why a suspect is ranked where it is", when: (c) => c.viewForm === "HypothesisGraph" },
};

/** The labels this question may take right now: every kind of view, and only the requests that make sense for what is on screen. */
export function candidateLabels(c: IntentContext, formsOnly = false): string[] {
  const forms = Object.keys(FORM_LABELS);
  return formsOnly ? forms : [...forms, ...Object.entries(INTENT_LABELS).filter(([, v]) => v.when(c)).map(([k]) => k)];
}

// ---- the closest labelled examples, by character n-grams (so a misspelt word still lands near its correctly spelt neighbours)
interface Shot { q: string; label: string; target: string; v: Float32Array }
const hasher = new HashEmbedder();
let bank: Shot[] | null = null;
const shots = (): Shot[] => bank ??= [
  ...Object.entries(EXEMPLARS).flatMap(([label, qs]) => qs.map((q) => ({ q, label, target: "" }))),
  ...Object.entries(INTENT_EXEMPLARS).flatMap(([label, xs]) => xs.map(([q, target]) => ({ q, label, target }))),
].map((x) => ({ ...x, v: hasher.embed([x.q])[0] as Float32Array }));
export function nearest(question: string, labels: string[], k = 8): (Shot & { score: number })[] {
  const v = hasher.embed([question])[0] as Float32Array, ok = new Set(labels);
  return shots().filter((s) => ok.has(s.label)).map((s) => ({ ...s, score: cosine(v, s.v) })).sort((a, b) => b.score - a.score).slice(0, k);
}

export function buildRequest(question: string, labels: string[]): RouterRequest {
  const menu = labels.map((l) => `- ${l}: ${FORM_LABELS[l] ?? INTENT_LABELS[l]?.says}`).join("\n");
  const ex = nearest(question, labels).reverse().map((s) => `Q: ${s.q}\nA: ${JSON.stringify({ label: s.label, target: s.target })}`).join("\n");
  return {
    system: `You read a developer's message about a codebase (it may contain typos) and choose what they want. Reply with a JSON object: "label", one label from this list, and "target", the name they mention (copied from their message), or "" when they name nothing.\n${menu}\n\nSimilar messages and their answers:\n${ex}`,
    user: `Q: ${question}\nA:`, labels,
  };
}

/** A small model running in the local Ollama daemon. A hosted (":cloud") model is refused: the question would leave the machine. */
export class OllamaRouter implements RouterModel {
  readonly name: string;
  private opts: { model?: string; baseUrl?: string; timeoutMs?: number };
  constructor(opts: { model?: string; baseUrl?: string; timeoutMs?: number } = {}) {
    this.opts = opts;
    this.name = opts.model ?? DEFAULT_ROUTER_MODEL;
    if (/(:|-)cloud$/.test(this.name)) throw new Error(`router model "${this.name}" is hosted; the router only runs models on this machine`);
  }
  async choose(req: RouterRequest): Promise<RouterAnswer | null> {
    const base = this.opts.baseUrl ?? process.env.CIE_OLLAMA_URL ?? "http://127.0.0.1:11434";
    const body = {
      model: this.name, stream: false, think: false, keep_alive: "30m", options: { temperature: 0, num_predict: 40, num_ctx: 4096 },
      format: { type: "object", properties: { label: { type: "string", enum: req.labels }, target: { type: "string" } }, required: ["label", "target"] },
      messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
    };
    try {
      const r = await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) });
      if (!r.ok) return null;
      const a = JSON.parse(((await r.json()) as { message?: { content?: string } }).message?.content ?? "{}") as Partial<RouterAnswer>;
      return typeof a.label === "string" && req.labels.includes(a.label) ? { label: a.label, target: typeof a.target === "string" ? a.target.slice(0, 120) : "" } : null;
    } catch { return null; }
  }
}
export const DEFAULT_ROUTER_MODEL = "qwen3:0.6b";
/** CIE_ROUTER=off turns the model router off (the general map is used); CIE_ROUTER_MODEL names another local model. */
export function routerFromEnv(env: Record<string, string | undefined> = process.env): RouterModel | null {
  return env.CIE_ROUTER === "off" ? null : new OllamaRouter({ model: env.CIE_ROUTER_MODEL, baseUrl: env.CIE_OLLAMA_URL });
}

/** The model named on the command line: `--router-model <name>` or `--router-model=<name>` (`off` disables). */
export function routerArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--router-model") return argv[i + 1];
    if (argv[i].startsWith("--router-model=")) return argv[i].slice("--router-model=".length);
  }
  return undefined;
}

const installedModels = async (base: string): Promise<string[] | null> => {
  try { const j = (await (await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) })).json()) as { models?: { name: string }[] }; return (j.models ?? []).map((m) => m.name); } catch { return null; }
};
const has = (names: string[], want: string) => names.includes(want) || names.includes(`${want}:latest`);

/**
 * Which router to run: the command-line argument, else CIE_ROUTER_MODEL, else the default. A model that is hosted or not installed is not used silently:
 * the default takes its place and the note says so. Without Ollama at all the router is still created (it answers "no answer", and the general map is used).
 */
export async function chooseRouter(argv: string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<{ router: RouterModel | null; note?: string }> {
  const asked = routerArg(argv) ?? env.CIE_ROUTER_MODEL;
  if (asked === "off" || env.CIE_ROUTER === "off") return { router: null, note: "router model off: questions get the general map" };
  const baseUrl = env.CIE_OLLAMA_URL;
  const base = baseUrl ?? "http://127.0.0.1:11434";
  if (!asked) return { router: new OllamaRouter({ baseUrl }) };
  if (/(:|-)cloud$/.test(asked)) return { router: new OllamaRouter({ baseUrl }), note: `router model "${asked}" is hosted and the router only runs models on this machine; using ${DEFAULT_ROUTER_MODEL}` };
  const names = await installedModels(base);
  if (names && !has(names, asked)) return { router: new OllamaRouter({ baseUrl }), note: `router model "${asked}" is not installed (ollama pull ${asked}); using ${DEFAULT_ROUTER_MODEL}` };
  return { router: new OllamaRouter({ model: asked, baseUrl }) };
}

// ---- from an answer to something the service can act on
const NAMES: Record<string, string> = { SemanticMap: "Architecture map", "CausalGraph:failure": "Failure-space map", "CausalGraph:invariant": "Wrong-value map", ...Object.fromEntries(VISUALS.map((v) => [v.formId, v.name])) };
const routeFor = (label: string): Pick<ViewRoute, "form" | "kind" | "name"> => { const [form, kind] = label.split(":"); return { form: form as FormId, ...(kind ? { kind: kind as "failure" | "invariant" } : {}), name: NAMES[label] ?? form }; };

export interface Reading { intent: Intent; label: string | null; because: string }
const strip = (t: string) => t.replace(/^(the|a)\s+/i, "").trim();

/** One question in, one reading out. `null` model or a model that does not answer gives the plain default, and says so. */
export async function readText(model: RouterModel | null, text: string, c: IntentContext, formsOnly = false): Promise<Reading> {
  const fallback = (why: string): Reading => ({ intent: { type: "ask", route: { source: "default", confidence: "low", ...routeFor("SemanticMap"), because: `${why} I used the general architecture map; pick another kind of view from the gallery if it is not what you meant.`, alternatives: [] } }, label: null, because: why });
  if (c.looksLikeTrace && !formsOnly) return { intent: { type: "investigate" }, label: "investigate", because: "The text parses as a stack trace." };
  if (!model) return fallback("No router model is configured, so I could not read what kind of view you wanted.");
  const labels = candidateLabels(c, formsOnly);
  const answer = await model.choose(buildRequest(text, labels));
  if (!answer || !labels.includes(answer.label)) return fallback(`The router model (${model.name}) did not answer.`);
  const target = strip(answer.target);
  const because = `${model.name} read this as "${answer.label}" (a small model: usually right, never certain).`;
  const L = answer.label;
  const intent: Intent =
    L === "overview" ? { type: "overview" }
    : L === "resume" ? { type: "resume", name: target }
    : L === "zoomIn" ? { type: "zoom", direction: "in" }
    : L === "zoomOut" ? { type: "zoom", direction: "out" }
    : L === "whyShown" ? { type: "whyShown" }
    : L === "connected" ? { type: "connected" }
    : L === "whyHidden" || L === "ignore" || L === "restore" || L === "whySuspect" || L === "pin" || L === "unpin" || L === "boost" || L === "demote" ? { type: L, target }
    : { type: "ask", route: { source: "model", confidence: "medium", ...routeFor(L), because, alternatives: nearest(text, Object.keys(FORM_LABELS)).filter((s) => s.label !== L).map((s) => s.label).filter((l, i, all) => all.indexOf(l) === i).slice(0, 3).map(routeFor) } };
  return { intent, label: L, because };
}

/** Pick the saved investigation whose name shares the most words with the request. */
export function matchName<T extends { name: string }>(want: string, items: T[]): T | null {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2 && !["the", "and", "investigation", "session"].includes(w)) ?? []);
  const w = words(want);
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const n = words(item.name);
    const score = w.size === 0 ? 0 : [...w].filter((x) => n.has(x) || [...n].some((y) => y.startsWith(x.slice(0, 5)) && x.length >= 5)).length;
    if (score > 0 && (!best || score > best.score)) best = { item, score };
  }
  return best?.item ?? (w.size === 0 ? items[0] ?? null : null);
}
