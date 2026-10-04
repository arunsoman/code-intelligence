// Access redaction for everything a view carries. Retrieval filters what the map form selects, but the specialised forms
// (journeys, lineage, trust, policy, matrices, terrain...) build their own views, so the rule is applied once, here, to the
// finished view and its claims: whatever the form made, a caller never receives code they may not see, or text that names it.
import type { Claim, ViewSpec } from "@cie/schema";
import { policyFor } from "./access.ts";
import type { RevisionRow, Store } from "./store.ts";

const TOKEN = /[A-Za-z_][A-Za-z0-9_]*/g;
export const GENERIC_GAP = "Some notes about code you do not have access to were left out.";

export function redactBuilt<T extends { view: ViewSpec; claims: Claim[] }>(store: Store, rev: RevisionRow, built: T): T & { redacted: number } {
  const acc = policyFor(store, rev.repoRoot);
  if (!acc.prefixes.length) return Object.assign(built, { redacted: 0 });
  const ents = store.entities(rev.id);
  const fileOf = new Map(ents.map((e) => [e.entityId, e.file]));
  const isDenied = (id: string) => acc.deniedEntity(id, (x) => fileOf.get(x));
  const names = new Set<string>(); const files = new Set<string>();
  for (const e of ents) if (acc.denied(e.file)) { files.add(e.file); if (e.kind !== "file" && e.name.length >= 3) names.add(e.name); for (const part of e.name.split(".")) if (part.length >= 4) names.add(part); }
  const mentions = (s: unknown): boolean => {
    if (typeof s !== "string" || !s) return false;
    for (const f of files) if (s.includes(f)) return true;
    for (const p of acc.prefixes) if (s.includes(p + "/")) return true;
    for (const m of s.matchAll(TOKEN)) if (names.has(m[0])) return true;
    return false;
  };
  const v = built.view;
  let removed = 0;
  // Nodes first: everything else is decided by which nodes are gone.
  const gone = new Set<string>(); const goneClaims = new Set<string>();
  v.nodes = v.nodes.filter((n) => { const bad = n.entityRefs.some(isDenied) || acc.denied(n.file) || mentions(n.label); if (bad) { gone.add(n.id); n.claimIds.forEach((c) => goneClaims.add(c)); removed++; } return !bad; });
  v.edges = v.edges.filter((e) => { const bad = gone.has(e.fromNodeId) || gone.has(e.toNodeId) || mentions(e.label); if (bad) { if (e.claimId) goneClaims.add(e.claimId); removed++; } return !bad; });
  v.groups = v.groups.map((g) => ({ ...g, childNodeIds: g.childNodeIds.filter((c) => !gone.has(c)) })).filter((g) => (g.childNodeIds.length > 0 || v.groups.some((o) => o.parentGroupId === g.id)) && !mentions(g.label));
  for (const n of v.nodes) { n.notes = n.notes?.filter((x) => !mentions(x)); n.claimIds = n.claimIds.filter((c) => !goneClaims.has(c)); }
  if (v.matrix) {
    const rows = v.matrix.rows.filter((r) => !r.entityRefs.some(isDenied) && !mentions(r.label) && !mentions(r.sub));
    const cols = v.matrix.cols.filter((c) => !c.entityRefs.some(isDenied) && !mentions(c.label) && !mentions(c.sub));
    const ok = new Set([...rows.map((r) => r.id), ...cols.map((c) => c.id)]);
    removed += v.matrix.rows.length - rows.length + v.matrix.cols.length - cols.length;
    v.matrix = { ...v.matrix, rows, cols, cells: v.matrix.cells.filter((c) => { const keep = ok.has(c.row) && ok.has(c.col) && !mentions(c.note); if (!keep && c.claimId) goneClaims.add(c.claimId); return keep; }) };
    for (const a of [...v.matrix.rows, ...v.matrix.cols]) { /* axes keep their own claim ids; only cell claims are dropped */ void a; }
  }
  if (v.consequences) v.consequences = v.consequences.filter((c) => { const bad = (c.entityIds ?? []).some(isDenied) || mentions(c.text); if (bad) { if (c.claimId) goneClaims.add(c.claimId); removed++; } return !bad; });
  if (v.terrain) { const before = v.terrain.cells.length; v.terrain = { ...v.terrain, cells: v.terrain.cells.filter((c) => !acc.denied(c.file) && !c.entityIds.some(isDenied) && !mentions(c.label)) }; removed += before - v.terrain.cells.length; }
  if (v.hidden) v.hidden = v.hidden.filter((h) => !isDenied(h.entityId) && !mentions(h.label) && !mentions(h.reason));
  // Free text that names denied code is withheld whole; a notice replaces it so the person knows something was removed.
  const before = v.gaps.length;
  v.gaps = v.gaps.filter((g) => !mentions(g));
  if (v.gaps.length < before && !v.gaps.includes(GENERIC_GAP)) v.gaps.push(GENERIC_GAP);
  const noticeAt = v.gaps.length;
  if (mentions(v.caption)) v.caption = "This view leaves out code you do not have access to.";
  if (mentions(v.formReason)) v.formReason = undefined;
  if (v.route && (mentions(v.route.because) || mentions(v.route.name))) v.route = { ...v.route, because: "The question was read from its wording." };
  if (v.system) v.system = { ...v.system, externals: v.system.externals.filter((x) => !mentions(x.name)) };
  v.legend = v.legend.filter((l) => !mentions(l.description));
  // Claims: those behind removed elements, those about denied code, and any whose text names it.
  built.claims = built.claims.filter((c) => {
    const bad = goneClaims.has(c.draft.id) || (c.draft.subjects ?? []).some(isDenied) || (c.draft.structure?.entityIds ?? []).some(isDenied) || mentions(c.draft.assertion) || mentions(c.counterArgument) || mentions(c.draft.rationaleSummary);
    if (bad) removed++;
    return !bad;
  });
  const keep = new Set(built.claims.map((c) => c.draft.id));
  for (const n of v.nodes) n.claimIds = n.claimIds.filter((c) => keep.has(c));
  for (const e of v.edges) if (e.claimId && !keep.has(e.claimId)) e.claimId = undefined;
  if (removed > 0) v.gaps.splice(noticeAt, 0, `${removed} element(s) of this view are in code you do not have access to and were left out.`);
  return Object.assign(built, { redacted: removed });
}
