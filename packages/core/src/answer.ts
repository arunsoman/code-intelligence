// The words that go with every picture. A view is a visual answer; this composes the written one from the same
// material (nodes, edges, groups, matrix, terrain, claims), so the two cannot disagree: the sentence names what the
// picture shows, in the order of how much it matters, and says how sure each part is. Nothing here is invented; a
// model's own prose (when a form has it) is kept, and this is the grounded default for everything else.
import type { Claim, DisplayMode, ViewNode, ViewSpec } from "@cie/schema";

const MAX_POINTS = 5, MAX_CHAIN = 6;
const HEDGE: Partial<Record<DisplayMode, string>> = { INFERENCE: "inferred", HYPOTHESIS: "hypothesis", FOG: "partly unresolved" };

const sentence = (s: string) => { const t = s.replace(/\s+/g, " ").trim(); return !t ? "" : /[.!?”"]$/.test(t) ? t : t + "."; };
const list = (xs: string[]) => xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")}, and ${xs.at(-1)}`;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const TIER = { CRITICAL: 0, RELEVANT: 1, CONTEXT: 2, HIDDEN: 3 } as const;
/** Most important first: an explicit rank, then score or heat, then the tier the view gave it. */
function byImportance(a: ViewNode, b: ViewNode): number {
  const ra = a.rank ?? Infinity, rb = b.rank ?? Infinity;
  if (ra !== rb) return ra - rb;
  const sa = a.score ?? a.heat?.value ?? 0, sb = b.score ?? b.heat?.value ?? 0;
  if (sa !== sb) return sb - sa;
  return TIER[a.tier] - TIER[b.tier] || a.label.localeCompare(b.label);
}

function describe(n: ViewNode): string {
  const what = [n.role, n.badge, n.heat?.label].filter(Boolean)[0];
  const note = n.notes?.[0];
  const hedge = HEDGE[n.displayMode];
  return `${n.label}${what ? ` (${what})` : ""}${hedge ? ` [${hedge}]` : ""}${note ? ` — ${note.replace(/[.\s]+$/, "")}` : ""}`.replace(/\s+/g, " ");
}

/** The route a reader would follow: from something nothing else points to, along the most important edges. */
function chain(v: ViewSpec): string | null {
  const shown = new Map(v.nodes.filter((n) => n.tier !== "HIDDEN" && !n.ghost).map((n) => [n.id, n]));
  const edges = v.edges.filter((e) => !e.ghost && shown.has(e.fromNodeId) && shown.has(e.toNodeId) && e.fromNodeId !== e.toNodeId);
  if (edges.length < 2) return null;
  const into = new Set(edges.map((e) => e.toNodeId));
  const out = new Map<string, typeof edges>();
  for (const e of edges) out.set(e.fromNodeId, [...(out.get(e.fromNodeId) ?? []), e]);
  const starts = [...out.keys()].filter((id) => !into.has(id)).map((id) => shown.get(id)!).sort(byImportance);
  const start = starts[0];
  if (!start) return null;
  const seen = new Set([start.id]), path = [start];
  let cur = start;
  while (path.length < MAX_CHAIN) {
    const next = (out.get(cur.id) ?? []).filter((e) => !seen.has(e.toNodeId)).map((e) => shown.get(e.toNodeId)!).sort(byImportance)[0];
    if (!next) break;
    seen.add(next.id); path.push(next); cur = next;
  }
  if (path.length < 3) return null;
  const more = out.get(start.id)!.length > 1 ? `; other branches are in the map` : "";
  return `Following the connections from ${path[0].label}: ${path.slice(1).map((n) => n.label).join(" → ")}${more}.`;
}

function certainty(v: ViewSpec, claims: Claim[]): string | null {
  const nodes = v.nodes.filter((n) => n.tier !== "HIDDEN" && !n.ghost && n.kind !== "file");
  const count = (m: DisplayMode) => nodes.filter((n) => n.displayMode === m).length + v.edges.filter((e) => !e.ghost && e.displayMode === m).length;
  const inferred = count("INFERENCE"), hypo = count("HYPOTHESIS");
  const fog = nodes.reduce((n, x) => n + x.unresolvedCalls, 0);
  const refuted = claims.filter((c) => c.state === "REFUTED").length;
  const bits = [
    inferred ? `${plural(inferred, "part")} ${inferred === 1 ? "is" : "are"} inferred rather than proven` : "",
    hypo ? `${plural(hypo, "part")} ${hypo === 1 ? "is a" : "are"} hypothes${hypo === 1 ? "is" : "es"}` : "",
    fog ? `${plural(fog, "call")} could not be resolved statically` : "",
    refuted ? `${plural(refuted, "claim")} ${refuted === 1 ? "was" : "were"} refuted and left out` : "",
  ].filter(Boolean);
  return bits.length ? `Confidence: the rest is statically evidenced, but ${list(bits)}.` : nodes.length ? "Everything shown is backed by cited evidence." : null;
}

/** Findings that live outside the node list: change-risk terrain cells and matrix rows carrying a heat. */
function otherPoints(v: ViewSpec): string[] {
  if (v.terrain?.cells.length) {
    const f = v.terrain.factors, total = f.reduce((n, x) => n + x.weight, 0) || 1;
    const score = (c: (typeof v.terrain.cells)[number]) => f.reduce((n, x) => n + x.weight * (c.factors[x.id] ?? 0.5), 0) / total;
    return [...v.terrain.cells].sort((a, b) => score(b) - score(a) || a.file.localeCompare(b.file)).slice(0, 3).map((c) => `${c.label} (${(score(c) * 100).toFixed(0)}/100)`);
  }
  if (v.matrix?.rows.some((r) => r.heat)) return v.matrix.rows.filter((r) => r.heat).sort((a, b) => b.heat!.value - a.heat!.value || a.label.localeCompare(b.label)).slice(0, 3).map((r) => `${r.label} (${r.heat!.label})`);
  return [];
}

/** A grounded written answer for a view. `lead` is what the view already says in one sentence (its caption). */
export function composeAnswer(v: ViewSpec, claims: Claim[] = []): string | undefined {
  const parts: string[] = [];
  const lead = sentence(v.caption);
  if (lead) parts.push(lead);

  const conceptGroups = v.groups.filter((g) => g.kind === "concept" || g.kind === "cluster");
  const symbols = v.nodes.filter((n) => n.tier !== "HIDDEN" && !n.ghost && n.kind !== "file");
  const pool = (symbols.length ? symbols : v.nodes.filter((n) => n.tier !== "HIDDEN" && !n.ghost)).sort(byImportance);
  const other = otherPoints(v);

  if (v.formId === "SemanticMap" && conceptGroups.length) {
    const groups = conceptGroups.filter((g) => g.kind === "concept");
    if (groups.length) parts.push(sentence(`The code is organised into ${plural(groups.length, "responsibility", "responsibilities")}: ${list(groups.map((g) => `${g.label} (${plural(g.childNodeIds.length, "element")})`))}`));
  }
  const route = chain(v);
  if (route) parts.push(route);
  const points = other.length ? other : pool.slice(0, MAX_POINTS).map(describe);
  if (points.length) parts.push(sentence(`${other.length ? "Highest first" : v.formId === "SemanticMap" ? "Most central" : "Most important"}: ${list(points)}`));
  const left = (other.length ? 0 : pool.length - MAX_POINTS);
  if (left > 0) parts.push(`${plural(left, "more element")} ${left === 1 ? "is" : "are"} on the map.`);

  const c = certainty(v, claims);
  if (c && (symbols.length || other.length)) parts.push(c);
  const gap = v.gaps.filter(Boolean).slice(0, 2);
  if (gap.length) parts.push(`Limits: ${gap.map((g) => g.replace(/[.\s]+$/, "")).join("; ")}.`);
  const text = parts.join(" ").trim();
  return text || undefined;
}

/** Give a built view its written answer unless a more specific one (the model's, gated) is already there. */
export function withAnswer<T extends { view: ViewSpec; claims: Claim[] }>(built: T): T {
  if (!built.view.answer) { const a = composeAnswer(built.view, built.claims); if (a) built.view.answer = a; }
  return built;
}

/**
 * The chat reply for a view, split into what is shown and what stays as working notes. `lead` is never routing
 * boilerplate — it is this turn's own notice (a command's confirmation, a fallback explaining why the map changed),
 * so it always stays visible. `thinking` is the rest of the old, pre-answer text (why this form was picked, plus the
 * bare caption): worth keeping as a trace of how the reply was reached, but it only names what the map is, not an
 * answer to what was asked, so once a composed answer exists it moves out of the reply and into the trace.
 */
export function viewMessage(v: ViewSpec, lead: string, steering: boolean): { message: string; thinking?: string } {
  const leadText = lead.replace(/\s+/g, " ").trim();
  const picture = [steering ? "" : v.formReason, v.caption].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const answer = v.answer?.trim();
  if (!answer) return { message: [leadText, picture].filter(Boolean).join(" ").trim() };
  return { message: [leadText, answer].filter(Boolean).join(leadText ? "\n\n" : ""), ...(picture ? { thinking: picture } : {}) };
}

const firstSentence = (s: string) => (s.split(/\n/)[0] ?? "").split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";

/**
 * One reply for a multi-step analysis: what was found overall, then each step's own answer, then anything that could not be
 * done. A single completed step is just its answer. Steps that share a subject (risk, then its tests) are said to, so the
 * reader sees one story rather than separate captions.
 */
export function analysisMessage(results: { title: string; status: "complete" | "failed" | "skipped"; message: string; subject?: string }[]): string {
  const done = results.filter((r) => r.status === "complete");
  const undone = results.filter((r) => r.status !== "complete");
  if (results.length === 1 && done.length === 1) return done[0].message;
  const out: string[] = [];
  if (done.length > 1) {
    const subjects = [...new Set(done.map((r) => r.subject).filter((s): s is string => !!s))];
    const summary = done.map((r) => firstSentence(r.message)).filter(Boolean);
    out.push(`In short: ${summary.join(" ")}${subjects.length === 1 && done.filter((r) => r.subject === subjects[0]).length > 1 ? ` These findings all concern ${subjects[0]}.` : ""}`);
  }
  results.forEach((r, i) => {
    if (r.status !== "complete") return;
    out.push(`${i + 1}. ${r.title}\n${r.message}`);
  });
  if (undone.length) out.push(`Not completed: ${undone.map((r) => `${r.title} (${r.status}: ${firstSentence(r.message)})`).join("; ")}`);
  return out.join("\n\n");
}

/** The old reply shape for a multi-step analysis (one numbered block per step, no synthesis), kept as the trace. */
export function analysisThinking(results: { title: string; status: "complete" | "failed" | "skipped"; message: string }[]): string {
  return results.map((r, i) => `${i + 1}. ${r.title}${r.status !== "complete" ? ` (${r.status})` : ""}\n${r.message}`).join("\n\n");
}
