// V11 Counterfactual Overlay: the code as it is, and what would follow if part of it were removed. Everything hypothetical is
// ghost-outlined and every consequence is a hypothesis with its reasoning; "no consequence found" is a displayed outcome.
import type { Claim, Entity, ViewNode } from "@cie/schema";
import type { RevisionRow, Store } from "../store.ts";
import { entryPoints, guards, routes, sinks } from "./analysis.ts";
import { fieldKey, type FieldObject } from "./lineage.ts";
import { baseView, claimOf, containsEvidence, emptyForm, flowGraph, hash, short, isCode } from "./common.ts";

/** What "remove X" means: a function or class by name, or every piece of code in a module / file. */
export function resolveRemoval(store: Store, rev: string, question: string, subject?: string): { label: string; ids: string[] } | null {
  const entities = store.entities(rev).filter((e) => e.kind !== "file" && e.kind !== "test");
  const m = subject ? [null, subject] : /\b(?:remove|removes|removed|delete|deleting|drop|dropping|disable|without|extract|retire|eliminate)\s+(?:the\s+|our\s+|this\s+)?([A-Za-z_$][\w$./-]*)/i.exec(question);
  const word = m?.[1]?.toLowerCase();
  if (!word) return null;
  const exact = entities.filter((e) => e.name.toLowerCase() === word || e.name.split(".").pop()!.toLowerCase() === word);
  if (exact.length) return { label: exact.map((e) => e.name).join(", "), ids: exact.map((e) => e.entityId) };
  const inModule = entities.filter((e) => e.file.toLowerCase().split("/").some((seg) => seg.replace(/\.[a-z]+$/, "") === word || seg.replace(/\.[a-z]+$/, "").replace(/[-_.]/g, "") === word.replace(/[-_.]/g, "")));
  if (inModule.length) return { label: `the “${word}” module (${inModule.length} symbols)`, ids: inModule.map((e) => e.entityId) };
  const loose = entities.filter((e) => e.name.toLowerCase().includes(word));
  return loose.length ? { label: loose.map((e) => e.name).slice(0, 3).join(", "), ids: loose.map((e) => e.entityId) } : null;
}

export function buildCounterfactual(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const o = { rev, form: "Counterfactual" as const, question, kind: "counterfactual", caption: "", reason: "You asked a what-if, so this shows the code as it is, what would be removed (ghost-outlined), and what would follow. Every consequence is a hypothesis with its reasoning." };
  const target = resolveRemoval(store, rev.id, question, subject);
  if (!target) return emptyForm(o, "I can't tell what to remove. Try “what if we remove the ledger module?” or “what happens without checkFraud?”.");
  const flow = flowGraph(store, rev.id);
  const R = new Set(target.ids);
  const v = baseView({ ...o, caption: "" });
  const claims: Claim[] = [];
  const name = (id: string) => short(id);
  const cons: NonNullable<typeof v.consequences> = [];
  const add = (c: Claim, kind: string, anchors: string[], ids?: string[]) => { claims.push(c); cons.push({ id: `c:${c.draft.id}`, text: c.draft.assertion, kind, displayMode: "HYPOTHESIS", claimId: c.draft.id, evidenceIds: c.draft.evidenceIds.slice(0, 6), entityIds: ids ?? anchors }); return c; };
  const pending: { c: Claim; kind: string; anchors: string[] }[] = [];

  // 1. Callers that would be left calling nothing.
  const broken = new Map<string, { to: string[]; ev: string[] }>();
  for (const id of R) for (const r of flow.inn.get(id) ?? []) if (!R.has(r.from) && r.kind === "calls") { const b = broken.get(r.from) ?? { to: [], ev: [] }; b.to.push(id); b.ev.push(...r.evidence.map((x) => x.id)); broken.set(r.from, b); }
  for (const [from, b] of broken) pending.push({ c: claimOf(store, rev.id, { assertion: `${name(from)} calls ${[...new Set(b.to)].map(name).join(", ")}, which would no longer exist: it would fail to compile or run.`, claimClass: "cf-broken-caller", evidenceIds: b.ev, rationaleSummary: "A resolved call edge points at removed code." }), kind: "broken caller", anchors: [from] });
  // 2. Asynchronous hand-offs left dangling.
  for (const rels of flow.out.values()) for (const r of rels) if (r.kind === "async-flow") {
    if (R.has(r.to) && !R.has(r.from)) pending.push({ c: claimOf(store, rev.id, { assertion: `${name(r.from)} would still publish ${r.label ?? "its event"}, but its handler ${name(r.to)} would be gone: those events would be dropped.`, claimClass: "cf-orphan-publisher", evidenceIds: r.evidence.map((x) => x.id), rationaleSummary: "A publish/subscribe pair loses its subscriber." }), kind: "events dropped", anchors: [r.from] });
    if (R.has(r.from) && !R.has(r.to)) pending.push({ c: claimOf(store, rev.id, { assertion: `${name(r.to)} would never receive ${r.label ?? "its event"} again, because ${name(r.from)} would be gone.`, claimClass: "cf-orphan-handler", evidenceIds: r.evidence.map((x) => x.id), rationaleSummary: "A publish/subscribe pair loses its publisher." }), kind: "handler starved", anchors: [r.to] });
  }
  // 3. Protection lost: routes to state that were behind a guard in the removal set.
  const g = guards(store, rev.id, flow), s = sinks(store, rev.id), entries = entryPoints(flow);
  const before = routes(flow, entries, new Set(s.keys()), new Set(g.keys()));
  const lost = before.filter((r) => r.gates.length > 0 && r.gates.every((x) => R.has(x)) && !R.has(r.entry.id) && !R.has(r.sink));
  for (const r of lost.slice(0, 6)) pending.push({ c: claimOf(store, rev.id, { assertion: `Without ${r.gates.filter((x) => R.has(x)).map(name).join(", ")}, ${name(r.entry.id)} would reach ${name(r.sink)} with no check in between.`, claimClass: "cf-protection-lost", evidenceIds: [...r.rels.flatMap((x) => x.evidence.map((e) => e.id)), ...(g.get(r.gates[0])?.evidenceIds ?? [])].slice(0, 8), rationaleSummary: "A path that is guarded today would no longer pass a function that can refuse the request.", structure: { kind: "path", entityIds: r.ids } }), kind: "protection lost", anchors: [r.sink] });
  // 4. Failure modes that disappear, state writers that disappear.
  for (const f of store.factsByPredicate(rev.id, "throws")) if (R.has(f.subject)) pending.push({ c: claimOf(store, rev.id, { assertion: `${String((f.object as { value?: unknown }).value)} could no longer be raised: ${name(f.subject)} is removed${[...flow.inn.get(f.subject) ?? []].some((r) => !R.has(r.from)) ? ", and its callers lose that check" : ""}.`, claimClass: "cf-failure-removed", evidenceIds: f.evidence.map((x) => x.id), rationaleSummary: "A throw site is part of the removed code." }), kind: "failure mode gone", anchors: [f.subject] });
  const fields = new Map<string, { before: number; gone: number; ev: string[] }>();
  for (const f of store.factsByPredicate(rev.id, "writes")) { const k = fieldKey(f.object as FieldObject); const c = fields.get(k) ?? { before: 0, gone: 0, ev: [] }; c.before++; if (R.has(f.subject)) { c.gone++; c.ev.push(...f.evidence.map((x) => x.id)); } fields.set(k, c); }
  for (const [k, c] of fields) if (c.gone) pending.push({ c: claimOf(store, rev.id, { assertion: `${c.gone} of the ${c.before} writer(s) of “${k}” would disappear${c.gone === c.before ? ": nothing would update it any more" : ""}.`, claimClass: "cf-writers-gone", evidenceIds: c.ev, rationaleSummary: "Writers in the removal set are counted against all writers." }), kind: "state no longer updated", anchors: [...R].filter((id) => store.factsFor(rev.id, id).some((f) => f.predicate === "writes" && fieldKey(f.object as FieldObject) === k)).slice(0, 1) });
  // 5. Tests that would break.
  const tests = store.entities(rev.id).filter((e) => e.kind === "test");
  const calls = store.relationshipsAmong(rev.id, "calls");
  for (const t of tests) { const hits = calls.filter((r) => r.from === t.entityId && R.has(r.to)); if (hits.length) pending.push({ c: claimOf(store, rev.id, { assertion: `The test “${t.name}” calls ${[...new Set(hits.map((h) => name(h.to)))].join(", ")} and would fail.`, claimClass: "cf-test-breaks", evidenceIds: hits.flatMap((h) => h.evidence.map((x) => x.id)).slice(0, 4), rationaleSummary: "A test calls code in the removal set." }), kind: "test breaks", anchors: [t.entityId] }); }

  // Draw: ghost removals in the middle, the surrounding code solid, consequences as ghost chips.
  const removed = [...R].map((id) => flow.entities.get(id)).filter((e): e is Entity => !!e && isCode(e) || (!!e && e.kind === "class")).slice(0, 14);
  const neighbours = new Set<string>();
  for (const e of removed) { for (const r of flow.inn.get(e.entityId) ?? []) if (!R.has(r.from)) neighbours.add(r.from); for (const r of flow.out.get(e.entityId) ?? []) if (!R.has(r.to)) neighbours.add(r.to); }
  const col = (xs: string[], x: number) => xs.sort().slice(0, 12).forEach((id, i) => { const e = flow.entities.get(id); if (!e) return; v.nodes.push({ id: `n:${id}`, entityRefs: [id], label: e.name, kind: e.kind, file: e.file, claimIds: [], evidenceIds: containsEvidence(store, rev.id, id), tier: "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, role: "present", pos: { x, y: i * 96 }, notes: ["Stays as it is today."] }); });
  const callers = [...neighbours].filter((id) => (flow.out.get(id) ?? []).some((r) => R.has(r.to))), callees = [...neighbours].filter((id) => !callers.includes(id));
  col(callers, -380); col(callees, 380);
  removed.forEach((e, i) => v.nodes.push({ id: `n:${e.entityId}`, entityRefs: [e.entityId], label: e.name, kind: e.kind, file: e.file, claimIds: [], evidenceIds: containsEvidence(store, rev.id, e.entityId), tier: "CRITICAL", displayMode: "HYPOTHESIS", unresolvedCalls: 0, role: "removed", ghost: true, pos: { x: 0, y: i * 96 }, badge: "removed in this scenario", notes: ["Hypothetical: this is what would be taken away."] }));
  const present = new Set(v.nodes.map((n) => n.id));
  for (const e of removed) { for (const r of flow.inn.get(e.entityId) ?? []) if (present.has(`n:${r.from}`)) v.edges.push({ id: `e:${r.id}`, fromNodeId: `n:${r.from}`, toNodeId: `n:${e.entityId}`, kind: r.kind, relationshipId: r.id, evidenceIds: r.evidence.map((x) => x.id), displayMode: "FACT", ghost: true, label: r.label }); for (const r of flow.out.get(e.entityId) ?? []) if (present.has(`n:${r.to}`)) v.edges.push({ id: `e:${r.id}`, fromNodeId: `n:${e.entityId}`, toNodeId: `n:${r.to}`, kind: r.kind, relationshipId: r.id, evidenceIds: r.evidence.map((x) => x.id), displayMode: "FACT", ghost: true, label: r.label }); }
  // A relationship between two removed elements is found from both ends; it is one edge.
  { const seen = new Set<string>(); v.edges = v.edges.filter((e) => !seen.has(e.id) && !!seen.add(e.id)); }
  for (const { c, kind, anchors } of pending) {
    add(c, kind, anchors);
    const anchor = anchors.map((a) => v.nodes.find((n) => n.id === `n:${a}`)).find(Boolean);
    const cid = `n:cons:${hash(c.draft.id)}`;
    const base = anchor?.pos ?? { x: 0, y: -120 };
    v.nodes.push({ id: cid, entityRefs: anchors, label: kind, kind: "consequence", file: "", claimIds: [c.draft.id], ownClaimId: c.draft.id, evidenceIds: c.draft.evidenceIds.slice(0, 8), tier: "CRITICAL", displayMode: "HYPOTHESIS", unresolvedCalls: 0, role: "consequence", ghost: true, pos: base.x === 0 ? { x: 230, y: base.y } : { x: base.x + (base.x < 0 ? -190 : 190), y: base.y + 52 }, badge: "consequence", notes: [c.draft.assertion] });
    if (anchor) v.edges.push({ id: `e:${cid}`, fromNodeId: cid, toNodeId: anchor.id, kind: "affects", claimId: c.draft.id, evidenceIds: c.draft.evidenceIds.slice(0, 4), displayMode: "HYPOTHESIS", ghost: true });
  }
  v.consequences = cons;
  v.caption = cons.length ? `If ${target.label} were removed: ${cons.length} consequence(s) found. Solid is today's code; ghost outlines are hypothetical.` : `If ${target.label} were removed, I found no consequence in the code I can see. That does not mean there are none: see the gaps below.`;
  v.meta = { kind: "counterfactual", subject: target.label };
  v.params = { subject: target.ids.length === 1 ? short(target.ids[0]) : target.label.replace(/^the “|” module.*$/g, "") };
  v.gaps.push("Consequences are derived from static relationships only; behaviour that depends on run-time data, configuration or other services cannot be seen.");
  v.gaps.push("Only removal is simulated; moving, merging or making code asynchronous is not.");
  if (R.size > removed.length) v.gaps.push(`${R.size - removed.length} more symbol(s) are in the removal set and counted in the consequences but not drawn.`);
  return { view: v, claims };
}
