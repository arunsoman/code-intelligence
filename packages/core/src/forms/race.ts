// V10 Concurrency and Race-Window Map: execution strands touching one piece of shared state, side by side, with the
// transaction brackets and the windows in which two strands can interleave badly. The windows are claims that cite the exact
// statements; a static view can show that interleaving is possible, never that it happened.
import type { Claim, ViewGroup, ViewNode } from "@cie/schema";
import type { RevisionRow, Store } from "../store.ts";
import { entryPoints } from "./analysis.ts";
import { baseView, claimOf, containsEvidence, emptyForm, flowGraph, hash, pathTo, reach, short } from "./common.ts";
import { pickField, fieldKey, type FieldObject } from "./lineage.ts";

export function buildRace(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const o = { rev, form: "RaceWindow" as const, question, kind: "race", caption: "", reason: "You asked about concurrency, so this lays out each execution path that touches the data side by side and marks where two of them can interleave." };
  const field = pickField(store, rev.id, question, subject);
  if (!field) return emptyForm(o, "I can't tell which shared state you mean. Name a field, e.g. “where can account.balance race?”.");
  const flow = flowGraph(store, rev.id);
  const tx = new Set(store.factsByPredicate(rev.id, "uses_transaction").map((f) => f.subject));
  // Locks (post-MVP): which entities acquire a shared lock in this revision's code. A pair of
  // strands that both hold the same named lock is not a race window; only unprotected pairs are.
  const locks = new Map<string, string[]>(); // entity → lock objects it acquires
  for (const f of store.factsByPredicate(rev.id, "uses_lock")) locks.set(f.subject, [...(locks.get(f.subject) ?? []), String((f.object as { value?: unknown }).value)]);
  const sharedLock = (a: string, b: string) => (locks.get(a) ?? []).filter((x) => (locks.get(b) ?? []).includes(x));
  const acc = new Map<string, { kind: "writer" | "reader"; ev: string[] }>();
  for (const pred of ["writes", "reads"] as const) for (const f of store.factsByPredicate(rev.id, pred)) {
    if (fieldKey(f.object as FieldObject) !== field || !flow.entities.has(f.subject)) continue;
    const cur = acc.get(f.subject); acc.set(f.subject, { kind: pred === "writes" ? "writer" : cur?.kind ?? "reader", ev: [...(cur?.ev ?? []), ...f.evidence.map((x) => x.id)] });
  }
  void locks;
  const entries = entryPoints(flow);
  // One strand per entry point (or async handler) that reaches the data.
  const strands = entries.map((en) => {
    const info = reach([en.id], flow.out, (r) => r.to, 8, 200);
    const hit = [...acc.keys()].filter((id) => info.has(id));
    if (!hit.length) return null;
    const ids: string[] = [];
    for (const h of hit) for (const id of pathTo(info, h).ids) if (!ids.includes(id)) ids.push(id);
    return { entry: en, ids, hit, viaAsync: hit.some((h) => info.get(h)!.viaAsync) };
  }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 6);
  if (strands.length === 0) return emptyForm(o, `No entry point reaches any code that touches “${field}”.`);

  const v = baseView({ ...o, caption: "" });
  const claims: Claim[] = [];
  const nodeOf = new Map<string, string>(); // `${strandIndex}:${entityId}` → node id
  strands.forEach((s, si) => {
    s.ids.forEach((id, i) => {
      const e = flow.entities.get(id)!, a = acc.get(id), nid = `n:s${si}:${id}`;
      nodeOf.set(`${si}:${id}`, nid);
      v.nodes.push({ id: nid, entityRefs: [id], label: e.name, kind: e.kind, file: e.file, claimIds: [], evidenceIds: a ? [...new Set(a.ev)] : containsEvidence(store, rev.id, id), tier: a ? "CRITICAL" : "CONTEXT", displayMode: "FACT", unresolvedCalls: 0, role: a ? a.kind : "step", lane: `s${si}`, pos: { x: i * 175, y: si * 190 }, badge: a ? `${a.kind === "writer" ? "writes" : "reads"} ${field}${tx.has(id) ? " · in tx" : " · no tx"}` : undefined, notes: a ? [`${a.kind === "writer" ? "Writes" : "Reads"} ${field} ${tx.has(id) ? "inside" : "outside"} a transaction.`] : [] });
      if (i > 0) v.edges.push({ id: `e:s${si}:${i}`, fromNodeId: nodeOf.get(`${si}:${s.ids[i - 1]}`)!, toNodeId: nid, kind: "then", evidenceIds: containsEvidence(store, rev.id, id), displayMode: "FACT" });
    });
  });
  v.groups = strands.map((s, si): ViewGroup => ({ id: `g:lane:s${si}`, label: `${short(s.entry.id)}${s.entry.kind === "handler" ? " (async handler)" : s.viaAsync ? " (via async)" : ""}`, kind: "lane", childNodeIds: v.nodes.filter((n) => n.lane === `s${si}`).map((n) => n.id), level: 1, evidenceIds: [], displayMode: "FACT" }));
  // Transaction brackets.
  strands.forEach((s, si) => { const t = s.ids.filter((id) => tx.has(id)).map((id) => nodeOf.get(`${si}:${id}`)!); if (t.length) v.groups.push({ id: `g:region:tx${si}`, label: "transaction", kind: "region", childNodeIds: t, level: 3, evidenceIds: [], displayMode: "FACT" }); });

  // Windows: two different strands touching the data where at least one writes and at least one is outside a
  // transaction. A pair protected by the same named lock is not a window; only one-sided protection is.
  let windows = 0, protectedPairs = 0;
  const touch = strands.flatMap((s, si) => s.hit.map((id) => ({ si, id, ...acc.get(id)! })));
  const pairs: [typeof touch[number], typeof touch[number]][] = [];
  for (let i = 0; i < touch.length; i++) for (let j = i + 1; j < touch.length; j++) {
    const [a, b] = [touch[i], touch[j]];
    if (a.si === b.si || a.id === b.id) continue;
    if (a.kind !== "writer" && b.kind !== "writer") continue;
    if (tx.has(a.id) && tx.has(b.id)) continue;
    const shared = sharedLock(a.id, b.id);
    if (shared.length) { protectedPairs++; continue; } // both sides hold the same lock: no interleaving window
    pairs.push([a, b]);
  }
  pairs.sort((p, q) => Number(q[0].kind === "writer" && q[1].kind === "writer") - Number(p[0].kind === "writer" && p[1].kind === "writer"));
  const seenWindows = new Set<string>();
  for (const [a, b] of pairs) {
    // The same two symbols can meet on several paths; one window per pair, or the map draws duplicate nodes and claims.
    const pairKey = hash(a.id, b.id);
    if (seenWindows.has(pairKey)) continue;
    if (seenWindows.size >= 6) break;
    seenWindows.add(pairKey);
    const ev = [...new Set([...a.ev, ...b.ev])];
    const protected_: string[] = [a, b].flatMap((x) => (locks.get(x.id) ?? []).map((l) => `${short(x.id)} holds ${l}`));
    const what = a.kind === "writer" && b.kind === "writer" ? "both write" : "one writes while the other reads";
    const c = claimOf(store, rev.id, { assertion: `${short(a.id)} and ${short(b.id)} run on different paths and ${what} ${field}; ${[a, b].filter((x) => !tx.has(x.id)).map((x) => short(x.id)).join(" and ")} ${[a, b].filter((x) => !tx.has(x.id)).length > 1 ? "are" : "is"} outside a transaction, so their effects can interleave${protected_.length ? ` (${protected_.join(", ")}, so one side may reach the data while the other holds the lock)` : ""}.`, claimClass: "race-window", evidenceIds: ev, subjects: [a.id, b.id], rationaleSummary: protected_.length ? "One side is locked, but the other touches the state without that lock." : "Two independent execution paths reach the same state without a shared transaction or a shared lock; whether they actually overlap depends on run-time scheduling." });
    claims.push(c); windows++;
    const na = nodeOf.get(`${a.si}:${a.id}`)!, nb = nodeOf.get(`${b.si}:${b.id}`)!;
    const pa = v.nodes.find((n) => n.id === na)!.pos!, pb = v.nodes.find((n) => n.id === nb)!.pos!;
    const hid = `n:race:${hash(a.id, b.id)}`;
    v.nodes.push({ id: hid, entityRefs: [a.id, b.id], label: "race window", kind: "hazard", file: "", claimIds: [c.draft.id], ownClaimId: c.draft.id, evidenceIds: ev, tier: "CRITICAL", displayMode: "HYPOTHESIS", unresolvedCalls: 0, role: "race", pos: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 + 26 }, badge: "interleaving risk", notes: [c.draft.assertion] });
    v.edges.push({ id: `e:${hid}:a`, fromNodeId: hid, toNodeId: na, kind: "interleaves", claimId: c.draft.id, evidenceIds: a.ev, displayMode: "HYPOTHESIS" }, { id: `e:${hid}:b`, fromNodeId: hid, toNodeId: nb, kind: "interleaves", claimId: c.draft.id, evidenceIds: b.ev, displayMode: "HYPOTHESIS" });
  }
  v.caption = `${strands.length} execution path(s) touch “${field}”; ${windows} flagged interleaving window(s)${protectedPairs ? `, ${protectedPairs} pair(s) excluded because both sides hold the same named lock` : ""}. Each lane is one path; transaction brackets surround the steps inside a transaction.`;
  v.meta = { kind: "race", field, subject: field };
  v.params = { subject: field };
  if (strands.length === 1) v.gaps.push("Only one execution path reaches this data, so no interleaving between paths is possible statically.");
  v.gaps.push("This shows that interleaving is possible, not that it happens. Lock acquisition is read from the code and pairs holding the same named lock are excluded, but lock scope (when the lock is released), queues, worker counts and scheduler settings are not read, and a reproduced interleaving would need a failing test.");
  return { view: v, claims };
}
