// C19 compile-time validation, run on an assembled spec. It never calls the compiler (verify must not invoke compile).
// A spec that fails any of these cannot be shown: a structural claim without evidence, a reference to evidence that is not
// stored, a group that drops or invents members, a hypothesis styled as fact, or a safety fact hidden by tier.
import type { Claim, DisplayMode, ViewSpec } from "@cie/schema";
import type { Store } from "./store.ts";

export interface Violation { code: "EVIDENCE_MISSING" | "EVIDENCE_UNKNOWN" | "DANGLING_EDGE" | "GROUP_MEMBER_UNKNOWN" | "GROUP_CYCLE" | "GROUP_PARENT_UNKNOWN" | "ORPHAN_NODE" | "HYPOTHESIS_AS_FACT" | "DANGEROUS_FACT_HIDDEN" | "UNBOUNDED" | "DUPLICATE_ID" | "CLAIM_UNKNOWN"; where: string; message: string }

export interface ValidateOptions {
  claims?: Claim[]; maxNodes?: number; maxEdges?: number;
  /** Forms that place nodes by their own layout need no file groups; the map form does. */
  requireGroupCover?: boolean;
}
const SPECULATIVE: DisplayMode[] = ["HYPOTHESIS"];

export function validateView(store: Store, view: ViewSpec, opts: ValidateOptions = {}): Violation[] {
  const out: Violation[] = [];
  const v = (code: Violation["code"], where: string, message: string) => out.push({ code, where, message });
  const claimById = new Map((opts.claims ?? []).map((c) => [c.draft.id, c]));
  const seen = new Set<string>();
  for (const id of [...view.nodes.map((n) => n.id), ...view.edges.map((e) => e.id), ...view.groups.map((g) => g.id)]) { if (seen.has(id)) v("DUPLICATE_ID", id, "an id is used twice, so identity is ambiguous"); seen.add(id); }
  if (view.nodes.length > (opts.maxNodes ?? 2000) || view.edges.length > (opts.maxEdges ?? 6000)) v("UNBOUNDED", view.id, `${view.nodes.length} nodes / ${view.edges.length} edges exceeds the bound`);

  const evidenceOk = (where: string, ids: string[], needed: boolean) => {
    if (needed && ids.length === 0) v("EVIDENCE_MISSING", where, "a structural element must cite evidence");
    for (const id of ids) if (!store.evidence(view.revision, id)) v("EVIDENCE_UNKNOWN", where, `evidence ${id} is not stored for revision ${view.revision}`);
  };
  const nodeIds = new Set(view.nodes.map((n) => n.id));
  for (const n of view.nodes) {
    // Synthetic nodes (a ghost removal, a symptom, a bracket) carry their own claim instead of code evidence.
    evidenceOk(`node ${n.id}`, n.evidenceIds, n.entityRefs.length > 0 && !n.ghost && n.displayMode !== "HYPOTHESIS" && n.claimIds.length === 0 && !n.ownClaimId);
    for (const c of [...n.claimIds, ...(n.ownClaimId ? [n.ownClaimId] : [])]) if (opts.claims && !claimById.has(c)) v("CLAIM_UNKNOWN", `node ${n.id}`, `claim ${c} is not among the compiled claims`);
  }
  for (const e of view.edges) {
    if (!nodeIds.has(e.fromNodeId) || !nodeIds.has(e.toNodeId)) v("DANGLING_EDGE", `edge ${e.id}`, "an endpoint is not a node of this view");
    evidenceOk(`edge ${e.id}`, e.evidenceIds, e.displayMode === "FACT" || e.displayMode === "INFERENCE");
    if (e.claimId && opts.claims) {
      const c = claimById.get(e.claimId);
      if (!c) v("CLAIM_UNKNOWN", `edge ${e.id}`, `claim ${e.claimId} is not among the compiled claims`);
      else if (e.displayMode === "FACT" && c.displayMode !== "FACT") v("HYPOTHESIS_AS_FACT", `edge ${e.id}`, `shown as fact but its claim is ${c.displayMode}`);
      else if (SPECULATIVE.includes(c.displayMode) && e.displayMode !== "HYPOTHESIS" && e.displayMode !== "FOG") v("HYPOTHESIS_AS_FACT", `edge ${e.id}`, `claim is a hypothesis but the edge is shown as ${e.displayMode}`);
    }
  }
  const groups = new Map(view.groups.map((g) => [g.id, g]));
  for (const g of view.groups) {
    evidenceOk(`group ${g.id}`, g.evidenceIds, false);
    for (const c of g.childNodeIds) if (!nodeIds.has(c)) v("GROUP_MEMBER_UNKNOWN", `group ${g.id}`, `member ${c} is not a node of this view`);
    if (g.parentGroupId && !groups.has(g.parentGroupId)) v("GROUP_PARENT_UNKNOWN", `group ${g.id}`, `parent ${g.parentGroupId} does not exist`);
    for (let p = g.parentGroupId, hops = 0; p; p = groups.get(p)?.parentGroupId, hops++) if (p === g.id || hops > groups.size) { v("GROUP_CYCLE", `group ${g.id}`, "group parents form a cycle"); break; }
  }
  if (opts.requireGroupCover && view.groups.length) {
    const grouped = new Set(view.groups.flatMap((g) => g.childNodeIds));
    for (const n of view.nodes) if (!grouped.has(n.id)) v("ORPHAN_NODE", `node ${n.id}`, "in no group, so collapsing would lose it");
  }
  // Dangerous facts: a node that a failure points at is never hidden, whatever the lens.
  for (const n of view.nodes) {
    const hot = n.factors?.find((f) => f.factor === "RUNTIME_HOTNESS")?.normalizedScore ?? 0;
    if (hot >= 0.5 && n.tier === "HIDDEN") v("DANGEROUS_FACT_HIDDEN", `node ${n.id}`, "code that a failure points at is tiered HIDDEN");
  }
  return out;
}
