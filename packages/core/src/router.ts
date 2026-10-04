// Deterministic intent routing for the conversation panel and for choosing a visualization form.
// Rules are explicit and ordered so behavior is predictable and testable; unmatched text is a new question.
export type FormChoice = { form: "SemanticMap" | "CausalGraph"; kind?: "failure" | "invariant"; reason: string };

export const FAIL_RE = /\b(fail(s|ed|ure|ures|ing)?|break(s)?|crash(es)?|go(es)? wrong|can(not|'t)? (complete|succeed)|reject(ed|s)?|error(s)?|declin(e|ed)|time ?out|cause[sd]?)\b/i;
export const INVARIANT_RE = /\b(incorrect|wrong|invariant|inconsisten\w*|corrupt\w*|drift\w*|mismatch\w*|out of sync|stale|go(es)? negative|double[- ]?(spend|charge|count))\b/i;

export function chooseForm(question: string): FormChoice {
  if (INVARIANT_RE.test(question)) return { form: "CausalGraph", kind: "invariant", reason: "The question is about a value becoming incorrect, so I mapped every writer of that state." };
  if (FAIL_RE.test(question)) return { form: "CausalGraph", kind: "failure", reason: "The question is about what can make something fail, so I mapped failure sites reachable from the operation." };
  return { form: "SemanticMap", reason: "The question is about how something works, so I composed a map of the relevant code, grouped by responsibility." };
}

export type Intent =
  | { type: "resume"; name: string }
  | { type: "whyShown" }
  | { type: "whyHidden"; target: string }
  | { type: "ignore"; target: string }
  | { type: "restore"; target: string }
  | { type: "whySuspect"; target: string }
  | { type: "pin" | "unpin" | "boost" | "demote"; target: string }
  | { type: "overview" }
  | { type: "zoom"; direction: "in" | "out" | "overview" }
  | { type: "connected" }
  | { type: "investigate" }
  | { type: "ask" };

export interface IntentContext { hasView: boolean; viewForm?: string; selectionCount: number; looksLikeTrace: boolean }

export function routeIntent(text: string, c: IntentContext): Intent {
  const t = text.trim();
  if (c.looksLikeTrace) return { type: "investigate" };
  let m = /^(?:please\s+)?(?:continue|resume|reopen|open)\b(?:\s+(?:the|my))?\s+(.*?)\s*(?:investigation|session|work)?\s*$/i.exec(t);
  if (m && /investigation|session|work|continue|resume|reopen/i.test(t) && !/^open\s+\S+\.\w+$/i.test(t)) return { type: "resume", name: m[1].replace(/\b(investigation|session)\b/gi, "").trim() };
  // "project overview" / "overview of the codebase" is a question about the repository, with or without a map on screen.
  if (/\b(project|repo(?:sitory)?|code ?base|system|app(?:lication)?|architecture)\b.{0,20}\b(overview|summary|big picture)\b|\b(overview|summary|big picture|tour)\b.{0,20}\b(of|for)\b.{0,12}\b(the |this |my )?(project|repo(?:sitory)?|code ?base|system|app(?:lication)?|architecture)\b|\bwhat does (this|the) (project|repo(?:sitory)?|code ?base|app(?:lication)?) do\b/i.test(t)) return { type: "overview" };
  // "flow diagram for the whole project", "map the entire codebase": a whole-repository scope, so no keyword can match a symbol.
  const PROJECT = "(?:project|repo(?:sitory)?|code ?base|system|app(?:lication)?)";
  if (new RegExp(`\\b(?:whole|entire|full|complete|overall|all of)\\s+(?:the\\s+|this\\s+|my\\s+)?${PROJECT}\\b|\\b(?:flow|architecture|dependency|component|module|system|block)\\s+(?:diagram|map|chart|graph)\\b.{0,20}\\b(?:of|for)\\s+(?:the\\s+|this\\s+|my\\s+)?${PROJECT}\\b`, "i").test(t)) return { type: "overview" };
  if (c.hasView && /\b(zoom out|zoom-out|overview|big picture|higher level|less detail)\b/i.test(t)) return { type: "zoom", direction: /overview|big picture/i.test(t) ? "overview" : "out" };
  if (c.hasView && /\b(zoom in|zoom-in|more detail|drill (down|in))\b/i.test(t)) return { type: "zoom", direction: "in" };
  if (c.hasView && (m = /why\s+(?:isn'?t|is not|aren'?t|are not|wasn'?t|doesn'?t)\s+(.+?)\s+(?:shown|showing|included|displayed|there|in (?:the )?(?:map|view|graph)|appear(?:ing)?)\s*\??$/i.exec(t))) return { type: "whyHidden", target: m[1].replace(/^(the|a)\s+/i, "").trim() };
  if (c.hasView && (m = /why\b.*\b(?:hidden|missing|not shown|isn'?t (?:shown|there|included)|left out|not included|not there|aren'?t (?:shown|there))\b\s*:?\s*(.*)$/i.exec(t))) return { type: "whyHidden", target: (m[1] || t.replace(/^.*?\b(?:is|are|was|were)\s+/i, "")).replace(/^(the|a)\s+/i, "").replace(/[?.]$/, "").trim() };
  if (c.hasView && (m = /why\b.*?\b(?:isn'?t|is not|aren'?t|are not|not)\s+(?:showing|shown|included|there)\s+(.+)$/i.exec(t))) return { type: "whyHidden", target: m[1].replace(/[?.]$/, "").trim() };
  if (c.hasView && (m = /^(?:please\s+)?(pin|unpin|unboost|reset|boost|prioriti[sz]e|demote|deprioriti[sz]e|downrank)\b\s*(.*)$/i.exec(t))) {
    const verb = m[1].toLowerCase();
    const type = /^pin$/.test(verb) ? "pin" : /^(unpin|unboost|reset)$/.test(verb) ? "unpin" : /^(boost|prioriti)/.test(verb) ? "boost" : "demote";
    const target = m[2].replace(/^(the|a)\s+/i, "").replace(/[?.]$/, "").trim();
    if (target || c.selectionCount > 0) return { type, target };
  }
  if (c.viewForm === "HypothesisGraph") {
    if ((m = /^(?:ignore|exclude|drop|prune|dismiss|rule out)\s+(.+)$/i.exec(t))) return { type: "ignore", target: m[1].replace(/[?.]$/, "").trim() };
    if ((m = /^(?:restore|unignore|bring back|include)\s+(.+)$/i.exec(t))) return { type: "restore", target: m[1].replace(/[?.]$/, "").trim() };
    if ((m = /why\b.*\b(?:suspect(?:ed)?|suspicious|rank(?:ed)?|top|first)\b\s*(.*)$/i.exec(t))) return { type: "whySuspect", target: m[1].replace(/^(?:for|of|is|the)\s+/i, "").replace(/[?.]$/, "").trim() };
  }
  if (c.hasView && c.selectionCount >= 1 && /\bwhy\b.*\b(show(ing|n)?|display(ed)?|here|included|in (the )?(map|view|graph))\b/i.test(t)) return { type: "whyShown" };
  if (c.hasView && c.selectionCount >= 2 && /\b(connect(ed|ion|s)?|relat(ed|ion)|link(ed)?|path|depend(s|ency)?|why|how|explain)\b/i.test(t)) return { type: "connected" };
  if (c.hasView && c.selectionCount === 1 && /\b(explain|what does|what is this|how does this)\b/i.test(t)) return { type: "connected" };
  return { type: "ask" };
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
