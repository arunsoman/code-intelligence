// V5 Data Lineage and Mutation Graph: the data at the centre, every writer and reader around it, transaction boundaries,
// and the order-of-application risks between them.
import type { Claim, ViewGroup, ViewNode } from "@cie/schema";
import type { RevisionRow, Store } from "../store.ts";
import { queryTerms } from "../retrieval.ts";
import { baseView, claimOf, containsEvidence, emptyForm, flowGraph, short } from "./common.ts";
import { entryPoints } from "./analysis.ts";
import { reach } from "./common.ts";

/** The key a read/write fact is filed under: `qualifier.field` when the receiver is known, else the bare name. */
export type FieldObject = { value?: unknown; qualifier?: unknown };
export const fieldKey = (o: FieldObject): string => {
  const v = String((o.value ?? "") as string);
  const q = typeof o.qualifier === "string" && o.qualifier.trim() ? o.qualifier.trim() : null;
  return q ? `${q}.${v}` : v;
};

export function pickField(store: Store, rev: string, question: string, subject?: string): string | null {
  const keys = new Map<string, Set<string>>();
  for (const pred of ["writes", "reads"] as const) for (const f of store.factsByPredicate(rev, pred)) { const k = fieldKey(f.object as FieldObject); keys.set(k, (keys.get(k) ?? new Set()).add(f.subject)); }
  const terms = subject ? [subject.toLowerCase()] : queryTerms(question);
  const hits = [...keys].filter(([k]) => terms.some((t) => k.toLowerCase() === t || k.toLowerCase().includes(t) || t.includes(k.toLowerCase())));
  // An exact name wins; otherwise the group with the most code behind it.
  const pool = hits.length ? hits : subject ? [] : [...keys];
  return pool.sort((a, b) => Number(terms.some((t) => b[0].toLowerCase() === t)) - Number(terms.some((t) => a[0].toLowerCase() === t)) || b[1].size - a[1].size || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

export function buildLineage(store: Store, rev: RevisionRow, question: string, subject?: string): { view: ReturnType<typeof baseView>; claims: Claim[] } {
  const o = { rev, form: "DataLineage" as const, question, kind: "lineage", caption: "", reason: "You asked who touches some data, so this puts it at the centre with every writer and reader around it, and the transaction boundaries between them." };
  const field = pickField(store, rev.id, question, subject);
  if (!field) return emptyForm(o, "I can't tell which data you mean. Name a field, e.g. “who writes account.balance?”.");
  const flow = flowGraph(store, rev.id);
  const tx = new Set(store.factsByPredicate(rev.id, "uses_transaction").map((f) => f.subject));
  const pick = (pred: string) => { const m = new Map<string, string[]>(); for (const f of store.factsByPredicate(rev.id, pred)) if (fieldKey(f.object as FieldObject) === field && flow.entities.has(f.subject)) m.set(f.subject, [...(m.get(f.subject) ?? []), ...f.evidence.map((x) => x.id)]); return m; };
  const writers = pick("writes"), readers = pick("reads");
  const fieldId = `n:data:${field}`;
  const v = baseView({ ...o, caption: "" });
  const claims: Claim[] = [];
  const place = (ids: string[], x: number): { id: string; pos: { x: number; y: number } }[] =>
    [...ids].sort((a, b) => a.localeCompare(b)).map((id, i) => ({ id, pos: { x, y: (i - (ids.length - 1) / 2) * 90 } }));
  const writerPos = new Map(place([...writers.keys()], -360).map((p) => [p.id, p.pos]));
  const readerOnly = [...readers.keys()].filter((id) => !writers.has(id));
  const readerPos = new Map(place(readerOnly, 360).map((p) => [p.id, p.pos]));

  v.nodes.push({ id: fieldId, entityRefs: [], label: field, kind: "state", file: "", claimIds: [], evidenceIds: [...new Set([...writers.values(), ...readers.values()].flat())].slice(0, 12), tier: "CRITICAL", displayMode: "FACT", unresolvedCalls: 0, role: "state", pos: { x: 0, y: 0 }, notes: [`${writers.size} writer(s), ${readers.size} reader(s).`] });
  const entries = entryPoints(flow).filter((e) => e.kind === "entry").map((e) => e.id);
  const reachedBy = (id: string) => entries.filter((en) => reach([en], flow.out, (r) => r.to, 8, 200).has(id)).map(short);
  for (const [id, ev] of writers) {
    const e = flow.entities.get(id)!;
    v.nodes.push({ id: `n:${id}`, entityRefs: [id], label: e.name, kind: e.kind, file: e.file, claimIds: [], evidenceIds: [...new Set(ev)], tier: "CRITICAL", displayMode: "FACT", unresolvedCalls: 0, role: "writer", pos: writerPos.get(id)!, badge: tx.has(id) ? "in transaction" : "no transaction", notes: [tx.has(id) ? "Writes inside a transaction." : "Writes outside any transaction.", `Reached from: ${reachedBy(id).join(", ") || "no entry point found"}.`] });
    v.edges.push({ id: `e:w:${id}`, fromNodeId: `n:${id}`, toNodeId: fieldId, kind: "writes", evidenceIds: [...new Set(ev)], displayMode: "FACT", label: "writes" });
  }
  for (const [id, ev] of readers) {
    const e = flow.entities.get(id)!;
    const pos = readerPos.get(id);
    if (pos) v.nodes.push({ id: `n:${id}`, entityRefs: [id], label: e.name, kind: e.kind, file: e.file, claimIds: [], evidenceIds: [...new Set(ev)], tier: "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, role: "reader", pos, badge: tx.has(id) ? "in transaction" : "no transaction", notes: [tx.has(id) ? "Reads inside a transaction." : "Reads outside any transaction."] });
    v.edges.push({ id: `e:r:${id}`, fromNodeId: fieldId, toNodeId: `n:${id}`, kind: "reads", evidenceIds: [...new Set(ev)], displayMode: "FACT", label: "read by", style: undefined });
  }
  // Transaction boundaries: one region around the transactional participants.
  const inTx = [...new Set([...writers.keys(), ...readers.keys()])].filter((id) => tx.has(id));
  if (inTx.length) v.groups.push({ id: "g:region:tx", label: "inside a transaction", kind: "region", childNodeIds: inTx.map((id) => `n:${id}`), level: 3, evidenceIds: [], displayMode: "FACT" } as ViewGroup);

  // Order-of-application risks: a transactional writer next to a non-transactional one, reached from different entry points.
  const wl = [...writers.keys()].sort();
  let hazards = 0;
  for (let i = 0; i < wl.length; i++) for (let j = i + 1; j < wl.length; j++) {
    const [a, b] = [wl[i], wl[j]];
    if (tx.has(a) === tx.has(b)) continue;
    const ra = reachedBy(a).join(","), rb = reachedBy(b).join(",");
    const same = ra === rb && ra !== "";
    const [safe, bare] = tx.has(a) ? [a, b] : [b, a];
    const evidenceIds = [...new Set([...(writers.get(a) ?? []), ...(writers.get(b) ?? [])])];
    const c = claimOf(store, rev.id, {
      assertion: `${short(bare)} and ${short(safe)} both write ${field}, but only ${short(safe)} is transactional, so ${field} can end up inconsistent if they interleave${same ? "" : " (they are reached from different entry points)"}.`,
      claimClass: "order-of-application", evidenceIds, subjects: [a, b], rationaleSummary: "A non-transactional write can interleave with a transactional one; static analysis cannot show the actual ordering at run time.",
    });
    claims.push(c); hazards++;
    const hid = `n:hazard:${i}:${j}`;
    const ya = ((writerPos.get(a)?.y ?? 0) + (writerPos.get(b)?.y ?? 0)) / 2;
    v.nodes.push({ id: hid, entityRefs: [a, b], label: "order risk", kind: "hazard", file: "", claimIds: [c.draft.id], ownClaimId: c.draft.id, evidenceIds, tier: "CRITICAL", displayMode: c.displayMode === "HIDDEN" ? "HYPOTHESIS" : "HYPOTHESIS", unresolvedCalls: 0, role: "hazard", pos: { x: -180, y: ya }, notes: [c.draft.assertion] });
    v.edges.push({ id: `e:hz:${i}:${j}:a`, fromNodeId: hid, toNodeId: `n:${a}`, kind: "interleaves", claimId: c.draft.id, evidenceIds: writers.get(a) ?? [], displayMode: "HYPOTHESIS" }, { id: `e:hz:${i}:${j}:b`, fromNodeId: hid, toNodeId: `n:${b}`, kind: "interleaves", claimId: c.draft.id, evidenceIds: writers.get(b) ?? [], displayMode: "HYPOTHESIS" });
  }
  // Stale-read risk: readers that see the data outside a transaction while a writer is transactional.
  const bareReaders = readerOnly.filter((id) => !tx.has(id));
  if (bareReaders.length && inTx.some((id) => writers.has(id))) {
    for (const id of bareReaders.slice(0, 3)) {
      const c = claimOf(store, rev.id, { assertion: `${short(id)} reads ${field} outside a transaction while ${field} is written transactionally, so it may observe a partially applied update.`, claimClass: "stale-read", evidenceIds: readers.get(id) ?? [], subjects: [id], rationaleSummary: "Isolation depends on the datastore's level, which is not visible in the code." });
      claims.push(c);
      const n = v.nodes.find((x) => x.id === `n:${id}`); if (n) { n.claimIds = [c.draft.id]; n.ownClaimId = c.draft.id; n.displayMode = "HYPOTHESIS"; n.notes!.push("May read a partially applied update."); }
    }
  }
  v.caption = `“${field}”: ${writers.size} writer(s) (${[...writers.keys()].filter((id) => !tx.has(id)).length} outside a transaction), ${readerOnly.length} reader(s) that only read, ${hazards} order-of-application risk(s). Writers on the left, readers on the right.`;
  v.meta = { kind: "lineage", field, subject: field };
  v.params = { subject: field };
  if (readers.size === 0) v.gaps.push("No readers of this field were found; reads through destructuring, helpers or an ORM are not visible.");
  const siblings = new Map<string, number>();
  for (const pred of ["writes", "reads"] as const) for (const f of store.factsByPredicate(rev.id, pred)) { const k = fieldKey(f.object as FieldObject); if (k !== field && k.split(".").pop() === field.split(".").pop()) siblings.set(k, (siblings.get(k) ?? 0) + 1); }
  if (siblings.size) v.gaps.push(`Other state named “${field.split(".").pop()}” sits in its own group (${[...siblings.keys()].join(", ")}); a receiver-free same-named write cannot be told apart from them statically.`);
  v.gaps.push("Fields are matched by their receiver and name when the code names one (`account.balance`), so two unrelated same-named fields stay apart; writes with no visible object (bare literals, values not statically tied to an object) still share one key.");
  return { view: v, claims };
}
