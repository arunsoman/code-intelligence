// V9 Runtime Overlay: what has been reported as going wrong, projected onto the structure it happened in.
// These are reported exceptions, recorded test failures and ingested trace exports — not live telemetry:
// when a trace export is present the view gains latency and request counts; otherwise it says so. Frames
// outside the repository are shown as fog, never as lines.
import type { Claim, ViewNode } from "@cie/schema";
import type { RevisionRow, Store } from "../store.ts";
import { locateFrames, parseTrace } from "../trace.ts";
import { Runtime } from "../runtime.ts";
import { autoLayout, baseView, claimOf, containsEvidence, emptyForm, flowGraph, fogCount, observation, short } from "./common.ts";

const WINDOWS: Record<string, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, all: Infinity };

export function buildRuntime(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const win = subject && subject in WINDOWS ? subject : /\b(24 ?h|today|last day)\b/i.test(question) ? "24h" : /\b(7 ?d|week)\b/i.test(question) ? "7d" : "all";
  const o = { rev, form: "RuntimeOverlay" as const, question, kind: "runtime", caption: "", reason: "You asked what is going wrong in practice, so this overlays reported exceptions and failing tests on the structure, tinted by how often and how recently." };
  const flow = flowGraph(store, rev.id);
  const now = Date.now();
  const exs = store.exceptions(false).filter((x) => now - Date.parse(x.lastSeen) <= WINDOWS[win]);
  const entities = store.entities(rev.id);
  const heat = new Map<string, { value: number; notes: string[]; ev: string[]; count: number }>();
  const bump = (id: string, value: number, note: string, ev: string, count: number) => { const h = heat.get(id) ?? { value: 0, notes: [], ev: [], count: 0 }; h.value = Math.max(h.value, value); h.notes.push(note); h.ev.push(ev); h.count += count; heat.set(id, h); };
  let outside = 0, total = 0;
  for (const x of exs) {
    const located = locateFrames(store, rev, parseTrace(x.trace), entities);
    total += x.count;
    if (!located.some((f) => f.file)) { outside += x.count; continue; }
    located.forEach((f, pos) => {
      if (!f.entityId) return;
      const e = observation(store, rev.id, `rt:${x.id}:${f.entityId}`, "RUNTIME", f.file ?? "", `${x.errorClass} reported ${x.count}× by ${x.source} (last ${x.lastSeen.slice(0, 16).replace("T", " ")}): ${f.frame.raw}`, x.lastSeen, "RuntimeLocation");
      const recency = Math.exp(-(now - Date.parse(x.lastSeen)) / (3 * 86_400_000));
      bump(f.entityId, Math.min(1, (0.35 + 0.15 * Math.log2(1 + x.count)) * (0.6 + 0.4 * recency) * Math.max(0.4, 1 - pos * 0.2)), `${x.count}× ${x.errorClass}${pos === 0 ? " raised here" : " passed through"} (${x.source})`, e.id, x.count);
    });
  }
  const tests = store.factsByPredicate(rev.id, "test_result").filter((f) => (f.object as { value?: { status?: string } }).value?.status === "failed");
  // Ingested trace exports (post-MVP FR-13): p50/p95 latency and request counts per entity, from files the
  // project's own tooling wrote earlier.
  const spans = new Map<string, { op: string; count: number; errors: number; p50: number | null; p95: number | null; evidenceIds: string[] }>();
  for (const f of store.factsByPredicate(rev.id, "span")) {
    const v = (f.object as unknown as { value?: { op: string; count: number; errors: number; p50: number | null; p95: number | null; from?: string; until?: string } }).value;
    if (!v) continue;
    const untilMs = v.until ? Date.parse(v.until) : 0;
    if (Number.isFinite(untilMs) && untilMs > 0 && now - untilMs > WINDOWS[win]) continue; // outside the selected window
    spans.set(f.subject, { op: v.op, count: v.count, errors: v.errors, p50: v.p50, p95: v.p95, evidenceIds: f.evidence.map((x) => x.id) });
  }
  const calls = new Map<string, string[]>();
  for (const r of store.relationshipsAmong(rev.id, "calls")) calls.set(r.from, [...(calls.get(r.from) ?? []), r.to]);
  for (const f of tests) {
    const name = ((f.object as unknown) as { value: { name: string } }).value.name;
    for (const to of calls.get(f.subject) ?? []) bump(to, 0.55, `Failing test “${name}” calls this`, f.evidence[0].id, 1);
  }
  for (const [id, s] of spans) bump(id, 0.5 + (s.errors ? 0.2 : 0) + Math.min(0.2, (s.p95 ?? 0) / 5000), s.errors ? `${s.op}: ${s.count} span(s), ${s.errors} error span(s)` : `${s.op}: ${s.count} span(s), p95 ${s.p95} ms`, s.evidenceIds[0], s.count);
  const recorded = new Runtime(store).queryWindow(rev.id, { from: Math.max(0, now - WINDOWS[win]), to: now });
  const runtimeWarnings = [...new Set(recorded.flatMap((a) => [...a.quality, ...(a.uncertaintyReason ? [a.uncertaintyReason] : [])]))];
  for (const a of recorded) for (const [i, p] of a.perEntity.entries()) {
    bump(p.entityId, p.errors ? 0.8 : 0.5, `Recorded runtime: ${p.spans} span(s), ${p.errors} error(s); ${p.exact ? "exact attribution" : "inexact attribution"}${p.p95Ms === null ? "" : `; p95 ${p.p95Ms} ms`}`, a.evidenceIds[i], p.spans);
  }
  if (heat.size === 0) {
    const empty = emptyForm(o, exs.length === 0 && tests.length === 0
    ? `Nothing has been reported in the ${win === "all" ? "available data" : "last " + win}. Apps can send exceptions here with @cie/reporter, or paste a stack trace.`
    : `${outside} reported exception(s) came from outside this repository, so there is nothing to draw on this structure.`);
    empty.view.gaps.push(...runtimeWarnings);
    return empty;
  }

  const v = baseView({ ...o, caption: "" });
  const claims: Claim[] = [];
  const include = new Set(heat.keys());
  for (const id of [...heat.keys()]) { for (const r of flow.out.get(id) ?? []) include.add(r.to); for (const r of flow.inn.get(id) ?? []) include.add(r.from); }
  const ids = [...include].filter((id) => flow.entities.has(id)).sort((a, b) => (heat.get(b)?.value ?? 0) - (heat.get(a)?.value ?? 0) || a.localeCompare(b)).slice(0, 36);
  const keep = new Set(ids);
  const nodesById = new Map(store.entities(rev.id).map((e) => [e.entityId, e]));
  for (const id of ids) {
    const e = (flow.entities.get(id) ?? nodesById.get(id))!, h = heat.get(id);
    const span = spans.get(id);
    const spanNote = span ? `Trace export: ${span.count} span(s) of ${span.op}${span.errors ? `, ${span.errors} error span(s)` : ""}${span.p50 !== null ? `, p50 ${span.p50} ms / p95 ${span.p95} ms` : ""}.` : null;
    const node: ViewNode = { id: `n:${id}`, entityRefs: [id], label: e.name, kind: e.kind, file: e.file, claimIds: [], evidenceIds: h ? [...new Set(h.ev)] : containsEvidence(store, rev.id, id), tier: h ? "CRITICAL" : "CONTEXT", displayMode: fogCount(store, rev.id, id) ? "FOG" : "FACT", unresolvedCalls: fogCount(store, rev.id, id), role: h ? "hot" : "structure", heat: h ? { value: h.value, label: `${h.count} report(s)/failure(s)` } : undefined, notes: h ? h.notes.slice(0, 4) : ["No reported problem here; shown for context."] };
    if (h) {
      const c = claimOf(store, rev.id, { assertion: `${e.name} has recorded runtime or test observations: ${h.notes[0]}.`, claimClass: "runtime-hotspot", evidenceIds: [...new Set(h.ev)], subjects: [id], rationaleSummary: "Built from recorded exceptions, tests or trace samples, not live telemetry; attribution uncertainty is retained in the view gaps." });
      claims.push(c); node.claimIds = [c.draft.id]; node.ownClaimId = c.draft.id; node.displayMode = c.displayMode === "HIDDEN" ? "HYPOTHESIS" : "INFERENCE";
      if (spanNote && node.notes) node.notes.push(spanNote);
    }
    v.nodes.push(node);
  }
  for (const id of ids) for (const r of flow.out.get(id) ?? []) if (keep.has(r.to)) v.edges.push({ id: `e:${r.id}`, fromNodeId: `n:${id}`, toNodeId: `n:${r.to}`, kind: r.kind, relationshipId: r.id, evidenceIds: r.evidence.map((x) => x.id), displayMode: r.kind === "async-flow" ? "HYPOTHESIS" : "FACT", label: r.label });
  autoLayout(v);
  const winSpan = [...spans.values()];
  v.caption = `${heat.size} place(s) with reported problems in the ${win === "all" ? "available data" : "last " + win}: ${exs.length} distinct exception(s), ${total} report(s)${tests.length ? `, ${tests.length} failing test(s)` : ""}${winSpan.length ? `, ${winSpan.reduce((n, s) => n + s.count, 0)} trace span(s)${winSpan.some((s) => s.p95 !== null) ? ` (worst p95 ${Math.max(...winSpan.filter((s) => s.p95 !== null).map((s) => s.p95!))} ms)` : ""}` : ""}. Warmer means more, and more recent.`;
  v.meta = { kind: "runtime", subject: win };
  v.params = { subject: win };
  if (outside) v.gaps.push(`${outside} reported exception(s) came from frames outside this repository and are not drawn: uninstrumented code is fog, not a line.`);
  if (spans.size) v.gaps.push("Trace spans come from exports the project's own tooling wrote earlier (a recorded sample), not live telemetry.");
  v.gaps.push("This is recorded data, not live telemetry. Replay uses ingested runtime envelopes; indexed trace-export summaries and pasted exceptions are not replayable. Replay highlights cumulative observations without changing the map's baseline heat.", ...runtimeWarnings);
  return { view: v, claims };
}
