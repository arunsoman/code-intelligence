// V14 Implicit-Concept Atlas: the concepts that exist in how the code behaves rather than in its names, pinned onto the
// places that implement them, with how scattered each one is and where its enforcement is missing. Uses the structural concept hierarchy.
import type { Claim, ConceptCard } from "@cie/schema";
import type { RevisionRow, Store } from "../store.ts";
import { baseView, emptyForm, flowGraph, short } from "./common.ts";

export function buildAtlas(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const o = { rev, form: "ConceptAtlas" as const, question, kind: "atlas", caption: "", reason: "You asked about hidden concepts, so each hierarchy concept is pinned onto the code that implements it, with how scattered it is and where something is missing." };
  const cards = store.concepts(rev.id).filter((c) => c.kind !== "capability" || !!subject);
  const all = cards.filter((c) => !subject || c.title.toLowerCase().includes(subject.toLowerCase()) || c.kind === subject.toLowerCase());
  if (store.concepts(rev.id).length === 0) return emptyForm(o, "There is no concept hierarchy for this revision. Use “Build concept hierarchy” first, and the atlas will pin them onto the code.");
  if (!all.length) return emptyForm(o, subject ? `No concept is named like “${subject}”.` : "Only broad capability cards exist; there are no hidden concepts (invariants, workflows, failure modes) to map yet.");
  const flow = flowGraph(store, rev.id);
  const tx = new Set(store.factsByPredicate(rev.id, "uses_transaction").map((f) => f.subject));
  const writes = store.factsByPredicate(rev.id, "writes");
  const v = baseView({ ...o, caption: "" });
  const claims: Claim[] = [];
  // The concepts that say most about hidden structure come first: rules, then flows, then vocabulary, then failure modes.
  const PRIORITY: Record<string, number> = { invariant: 0, workflow: 1, "domain-concept": 2, "failure-mode": 3, capability: 4 };
  const ranked = [...all].sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9) || b.members.length - a.members.length || a.title.localeCompare(b.title));
  const shown = ranked.slice(0, 8);
  const placed = new Map<string, string>();
  let gaps = 0;
  shown.forEach((c: ConceptCard, ci: number) => {
    const sites = c.members.filter((m) => flow.entities.has(m));
    const files = new Set(sites.map((m) => flow.entities.get(m)!.file));
    const dirs = new Set([...files].map((f) => f.split("/").slice(0, -1).join("/")));
    const scatter = sites.length <= 1 ? 0 : Math.min(1, (files.size - 1) / (sites.length - 1));
    // Consistency meter, where the card's kind gives it a meaning: an invariant about a field is consistent if its writers are transactional.
    let consistency: { value: number; label: string } | null = null;
    const field = c.kind === "invariant" ? /(?:Invariant:\s*)?([A-Za-z_$][\w$]*)/.exec(c.title.replace(/^Invariant:\s*/i, ""))?.[1] : undefined;
    const fieldWriters = field ? [...new Map(writes.filter((f) => String((f.object as { value?: unknown }).value) === field).map((f) => [f.subject, f])).values()] : []; // one per writer
    if (fieldWriters.length) { const safe = fieldWriters.filter((f) => tx.has(f.subject)).length; consistency = { value: safe / fieldWriters.length, label: `${safe} of ${fieldWriters.length} writer(s) of ${field} are transactional` }; }
    const cid = `n:card:${c.id}`, x = ci * 340;
    const claim = store.getClaim(c.claimId);
    if (claim) claims.push(claim);
    v.nodes.push({ id: cid, entityRefs: sites.slice(0, 1), label: c.title, kind: "concept", file: "", claimIds: claim ? [claim.draft.id] : [], ownClaimId: claim?.draft.id, evidenceIds: c.evidenceIds.slice(0, 8), tier: "CRITICAL", displayMode: claim && claim.displayMode !== "HIDDEN" ? (claim.displayMode === "FACT" ? "INFERENCE" : claim.displayMode) : "INFERENCE", unresolvedCalls: 0, role: "concept", pos: { x, y: 0 }, badge: c.kind, heat: { value: scatter, label: `scattered over ${files.size} file(s) in ${dirs.size} folder(s)` }, notes: [c.summary, consistency ? `Consistency: ${consistency.label}.` : "No consistency measure applies to this kind of concept.", "Structural concept from the hierarchy; labels do not establish business behavior."] });
    sites.slice(0, 7).forEach((m, si) => {
      const e = flow.entities.get(m)!;
      let id = placed.get(m);
      if (!id) { id = `n:site:${m}`; placed.set(m, id); v.nodes.push({ id, entityRefs: [m], label: e.name, kind: e.kind, file: e.file, claimIds: [], evidenceIds: store.relationshipsFor(rev.id, m).filter((r) => r.kind === "contains" && r.to === m).flatMap((r) => r.evidence.map((x) => x.id)), tier: "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, role: "site", pos: { x, y: 130 + si * 62 }, notes: [`Implements “${c.title}”.`] }); }
      v.edges.push({ id: `e:${cid}:${m}`, fromNodeId: cid, toNodeId: id, kind: "implemented at", claimId: claim?.draft.id, evidenceIds: c.evidenceIds.slice(0, 3), displayMode: "INFERENCE", label: "" });
      // Missing enforcement: a writer that the invariant relies on but that has no transaction.
      if (field && fieldWriters.some((f) => f.subject === m) && !tx.has(m)) {
        gaps++;
        const w = fieldWriters.find((f) => f.subject === m)!;
        v.nodes.push({ id: `n:gap:${c.id}:${m}`, entityRefs: [m], label: "no transaction here", kind: "gap", file: e.file, claimIds: [], evidenceIds: w.evidence.map((x) => x.id), tier: "CRITICAL", displayMode: "FACT", unresolvedCalls: 0, role: "gap", ghost: true, pos: { x: x + 170, y: 130 + si * 62 }, badge: "missing enforcement", notes: [`${short(m)} writes ${field} without a transaction.`] });
        v.edges.push({ id: `e:gap:${c.id}:${m}`, fromNodeId: `n:gap:${c.id}:${m}`, toNodeId: id, kind: "missing at", evidenceIds: w.evidence.map((x) => x.id), displayMode: "FACT" });
      }
    });
  });
  v.caption = `${shown.length} concept(s) pinned onto the code${gaps ? `, ${gaps} place(s) where enforcement is missing` : ""}. Warmer means more scattered. Concepts are inferred until you confirm them.`;
  v.meta = { kind: "atlas", subject: subject ?? "" };
  v.params = subject ? { subject } : {};
  if (all.length > shown.length) v.gaps.push(`${all.length - shown.length} more concept(s) exist; ask about one by name to see it.`);
  v.gaps.push("Concepts come from the extraction step and are only as good as it was; confirm or refute them in the concept browser, and refuted ones disappear here.");
  return { view: v, claims };
}
