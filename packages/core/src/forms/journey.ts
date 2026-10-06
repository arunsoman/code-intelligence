// V4 Transaction Journey: a business operation as a swim-lane sequence. Lanes are modules, steps follow call order,
// decision diamonds are the places it can refuse or fail, and asynchronous hand-offs are marked as such.
import { loadFunctions } from "../defect/functions.ts";
import type { Claim, ViewEdge, ViewGroup, ViewNode } from "@cie/schema";
import type { RevisionRow, Store } from "../store.ts";
import { queryTerms } from "../retrieval.ts";
import { entryPoints } from "./analysis.ts";
import { baseView, claimOf, containsEvidence, emptyForm, flowGraph, fogCount, short, type Flow } from "./common.ts";

const laneOf = (file: string) => { const d = file.split("/").slice(0, -1); return d[d.length - 1] ?? "(root)"; };
const callPos = (r: { evidence: { location: unknown }[] }) => { const loc = r.evidence[0]?.location as { span?: { startByte: number } } | undefined; return loc?.span?.startByte ?? 0; };

/** Pick the operation the question is about; fall back to the entry point with the longest journey. */
export function pickOperation(flow: Flow, question: string, subject?: string): string | null {
  const entries = entryPoints(flow).filter((e) => e.kind === "entry");
  const terms = subject ? [subject.toLowerCase()] : queryTerms(question);
  const named = entries.filter((e) => terms.some((t) => short(e.id).toLowerCase().includes(t) || flow.entities.get(e.id)!.file.toLowerCase().includes(t)));
  const pool = named.length ? named : subject ? [] : entries;
  const size = (id: string) => { const seen = new Set([id]); const q = [id]; while (q.length) for (const r of flow.out.get(q.shift()!) ?? []) if (!seen.has(r.to)) { seen.add(r.to); q.push(r.to); } return seen.size; };
  return pool.sort((a, b) => size(b.id) - size(a.id) || a.id.localeCompare(b.id))[0]?.id ?? null;
}


/** How a call sits inside its caller: under a condition, in an else branch, once per element of a loop, or in a retry loop. Read from the source's structure. */
interface Context { kind: "if" | "else" | "loop" | "retry"; text: string }
const RETRY = /\b(?:retry|retries|attempt|attempts|backoff|tries|try_count|max_?retries)\b/i;
function contextOf(fn: ReturnType<typeof loadFunctions> extends Map<string, infer F> ? F : never, absByte: number): Context[] {
  const rel = Buffer.from(fn.src, "utf8").subarray(0, Math.max(0, absByte - fn.start)).toString("utf8").length;
  const out: Context[] = [];
  for (const l of fn.scan.loops) if (rel >= l.bodyStart && rel < l.bodyEnd) {
    const body = fn.src.slice(l.bodyStart, l.bodyEnd);
    const retry = RETRY.test(l.header) || RETRY.test(body.slice(0, 400)) || /\b(?:catch|except)\b/.test(body);
    out.push({ kind: retry ? "retry" : "loop", text: retry ? `${l.kind === "while" ? "while " : ""}${l.header || "loop"}`.trim() : l.iterable ? `each of ${l.iterable}` : l.header || l.kind });
  }
  for (const b of fn.scan.ifs) {
    if (rel >= b.bodyStart && rel < b.bodyEnd) out.push({ kind: "if", text: b.cond.trim().replace(/\s+/g, " ").slice(0, 80) });
    else if (fn.lang !== "python") { const after = fn.src.slice(b.bodyEnd + 1); const m = /^\s*else\b\s*(?!if\b)\{/.exec(after); if (m) { const open = b.bodyEnd + 1 + m[0].length - 1; let d = 0, close = open; for (; close < fn.src.length; close++) { if (fn.src[close] === "{") d++; else if (fn.src[close] === "}" && --d === 0) break; } if (rel > open && rel < close) out.push({ kind: "else", text: `not (${b.cond.trim().replace(/\s+/g, " ").slice(0, 70)})` }); } }
  }
  return out;
}

export function buildJourney(store: Store, rev: RevisionRow, question: string, subject?: string): { view: ReturnType<typeof baseView>; claims: Claim[] } {
  const o = { rev, form: "TransactionJourney" as const, question, kind: "journey", caption: "", reason: "You asked for a journey, so this lays one operation out step by step across the modules it passes through, with the places it can fail." };
  const flow = flowGraph(store, rev.id);
  const op = pickOperation(flow, question, subject);
  if (!op) return emptyForm(o, "I can't tell which operation you mean. Name one, e.g. “walk me through createPayment”.");

  // Steps in execution order: depth-first, callees ordered by where they are called in the caller's source.
  const order: string[] = [], seen = new Set<string>(), parentRel = new Map<string, import("@cie/schema").Relationship>();
  const visit = (id: string, depth: number) => {
    if (seen.has(id) || depth > 7 || order.length >= 40) return;
    seen.add(id); order.push(id);
    for (const r of [...(flow.out.get(id) ?? [])].sort((a, b) => callPos(a) - callPos(b))) { if (!seen.has(r.to)) parentRel.set(r.to, r); visit(r.to, depth + 1); }
  };
  visit(op, 0);

  const throwsAt = new Map<string, { cls: string; ev: string[] }[]>();
  for (const f of store.factsByPredicate(rev.id, "throws")) if (seen.has(f.subject)) throwsAt.set(f.subject, [...(throwsAt.get(f.subject) ?? []), { cls: String((f.object as { value?: unknown }).value), ev: f.evidence.map((x) => x.id) }]);

  // Transaction boundaries: any step that runs inside a transaction. Framework facts (Spring) are preferred
  // over name-based heuristics; the fact carries the framework name and whether it came from a method or class annotation.
  const txAt = new Set<string>();
  const txFramework = new Map<string, string>();
  for (const f of store.factsByPredicate(rev.id, "uses_transaction")) {
    if (seen.has(f.subject)) {
      txAt.add(f.subject);
      const framework = String((f.object as { framework?: unknown }).framework ?? "");
      if (framework) txFramework.set(f.subject, framework);
    }
  }

  // Control-flow context of each step, from where its call sits in the caller's source.
  const fns = loadFunctions(store, rev, new Set(order));
  const contextOfStep = new Map<string, Context[]>();
  for (const id of order) { const r = parentRel.get(id); const caller = r ? fns.get(r.from) : undefined; if (r && caller && r.kind === "calls") contextOfStep.set(id, contextOf(caller, callPos(r))); }

  const lanes: string[] = [];
  for (const id of order) { const l = laneOf(flow.entities.get(id)!.file); if (!lanes.includes(l)) lanes.push(l); }
  const afterAsync = new Set<string>(); // steps that only run after an async hand-off
  for (const id of order) { const r = parentRel.get(id); if (r && (r.kind === "async-flow" || afterAsync.has(r.from))) afterAsync.add(id); }

  const v = baseView({ ...o, caption: "" });
  const claims: Claim[] = [];
  const nodeId = (id: string) => `n:${id}`;
  order.forEach((id, i) => {
    const e = flow.entities.get(id)!, lane = laneOf(e.file), li = lanes.indexOf(lane);
    const node: ViewNode = {
      id: nodeId(id), entityRefs: [id], label: e.name, kind: e.kind, file: e.file, claimIds: [], evidenceIds: containsEvidence(store, rev.id, id), tier: i === 0 ? "CRITICAL" : "RELEVANT",
      displayMode: fogCount(store, rev.id, id) ? "FOG" : "FACT", unresolvedCalls: fogCount(store, rev.id, id), role: i === 0 ? "operation" : "step", lane, pos: { x: i * 170, y: li * 150 },
      notes: [`Step ${i + 1} of ${order.length}, in the “${lane}” lane.`],
    };
    const r = parentRel.get(id);
    const ctxs = contextOfStep.get(id) ?? [];
    for (const c of ctxs) node.notes!.push({ if: `Runs only if ${c.text}.`, else: `Runs only in the other branch: ${c.text}.`, loop: `Runs once per element: ${c.text}, so it can run many times.`, retry: `Inside a retry or error-handling loop (${c.text}): it may run several times, or again after a failure.` }[c.kind]);
    if (ctxs.length) node.badge = ctxs.some((c) => c.kind === "retry") ? "retry" : ctxs.some((c) => c.kind === "loop") ? "loop" : "conditional";
    if (txAt.has(id)) {
      const fw = txFramework.get(id);
      const fwLabel = fw ? fw.charAt(0).toUpperCase() + fw.slice(1) : "";
      node.notes!.push(fw ? `Runs inside a ${fwLabel} transaction.` : "Runs inside a transaction boundary.");
      node.badge = node.badge ? `${node.badge}, transactional` : "transactional";
    }
    if (afterAsync.has(id)) {
      const c = claimOf(store, rev.id, {
        assertion: `${e.name} runs after an asynchronous hand-off, so the caller does not observe its outcome.`, claimClass: "journey-async", evidenceIds: [...(r?.evidence.map((x) => x.id) ?? [])],
        rationaleSummary: "Steps behind an async hand-off complete independently of the request that started them.",
        structure: r ? { kind: "path", entityIds: [r.from, r.to] } : undefined,
      });
      claims.push(c); node.ownClaimId = c.draft.id; node.claimIds = [c.draft.id]; node.displayMode = c.displayMode === "HIDDEN" ? "HYPOTHESIS" : "HYPOTHESIS"; node.notes!.push("Runs after an async hand-off: its outcome is invisible to the original caller.");
    }
    v.nodes.push(node);
    // Decision diamonds: where this step can refuse or fail.
    (throwsAt.get(id) ?? []).forEach((t, k) => {
      v.nodes.push({ id: `n:fail:${id}:${t.cls}`, entityRefs: [id], label: `fails: ${t.cls}`, kind: "decision", file: e.file, claimIds: [], evidenceIds: t.ev, tier: "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, role: "decision", lane, pos: { x: i * 170, y: li * 150 + 70 + k * 40 }, notes: [`Thrown in ${e.name}.`] });
      v.edges.push({ id: `e:exit:${id}:${t.cls}`, fromNodeId: nodeId(id), toNodeId: `n:fail:${id}:${t.cls}`, kind: "exit", evidenceIds: t.ev, displayMode: "FACT" });
    });
  });
  const index = new Map(order.map((id, i) => [id, i]));
  for (const id of order) for (const r of flow.out.get(id) ?? []) {
    if (!seen.has(r.to)) continue;
    const back = (index.get(r.to) ?? 0) < (index.get(id) ?? 0);
    v.edges.push({ id: `e:${r.id}`, fromNodeId: nodeId(id), toNodeId: nodeId(r.to), kind: r.kind, relationshipId: r.id, evidenceIds: r.evidence.map((x) => x.id), displayMode: r.kind === "async-flow" ? "HYPOTHESIS" : "FACT", label: r.label, style: back ? "return" : undefined, claimId: r.kind === "async-flow" ? v.nodes.find((n) => n.id === nodeId(r.to))?.ownClaimId : undefined });
  }
  v.groups = lanes.map((l): ViewGroup => ({ id: `g:lane:${l}`, label: l, kind: "lane", childNodeIds: v.nodes.filter((n) => n.lane === l).map((n) => n.id), level: 1, evidenceIds: [], displayMode: "FACT" }));
  const fails = v.nodes.filter((n) => n.role === "decision").length, asyncSteps = afterAsync.size;
  v.caption = `Journey of “${short(op)}”: ${order.length} steps across ${lanes.length} module lane(s), ${fails} place(s) it can fail${asyncSteps ? `, ${asyncSteps} step(s) running after an async hand-off` : ""}. Left to right follows the calls: execution order for a short journey, call depth once it has many steps.`;
  v.meta = { kind: "journey", subject: op };
  v.params = { subject: short(op) };
  if (order.length >= 40) v.gaps.push("The journey is long; only the first 40 steps are shown.");
  const fog = order.reduce((n, id) => n + fogCount(store, rev.id, id), 0);
  if (fog) v.gaps.push(`${fog} call(s) on this journey could not be statically resolved; steps may be missing.`);
  v.gaps.push("Order follows where each call appears in its caller's source. Conditions, loops and retry loops are read from the source's structure and marked on the step; whether a branch is taken, or how often a loop runs, is not known.");
  return { view: v, claims };
}
