// What the concept-hierarchy dialog and the method toggle must say, kept pure so it can be tested without rendering React.
// The dialog only lays these strings and rows out.
import type { ArchConcept, ConceptHierarchyView, HierarchyStats, Invariant, JobView, LanguageSoundnessTier, SemanticConcept } from "@cie/schema";
import { conceptTitle } from "@cie/schema/concept-tree";
import { providerInfo } from "./concept-status.ts";

/** The structural hierarchy is the only concept-generation mechanism. */
export type ConceptMode = "hierarchy";
export const CONCEPT_MODE_KEY = "cie-concept-mode";
export interface ModeStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export const MODE_INFO: Record<ConceptMode, { label: string; jobKind: "concept-hierarchy"; button: string; help: string }> = {
  hierarchy: {
    label: "Structural hierarchy",
    jobKind: "concept-hierarchy",
    button: "Build concept hierarchy",
    help: "Reads the code's shape (control and data flow), groups functions that do the same kind of thing, finds guarded values, and lays the result over the package tree. A model only suggests names.",
  },

};

/** The browser's storage, or nothing when it is blocked (reading the property itself can throw). */
export function browserStorage(): ModeStorage | undefined { try { return globalThis.localStorage; } catch { return undefined; } }

/** The remembered choice. Storage can be off or throw (private windows); the default then stands. */
export function readConceptMode(storage?: ModeStorage): ConceptMode {
  return "hierarchy";
}
export function writeConceptMode(mode: ConceptMode, storage?: ModeStorage): void {
  try { storage?.setItem(CONCEPT_MODE_KEY, mode); } catch { /* the choice still holds for this session */ }
}

export interface BuildStatus { id: string; state: JobView["state"]; detail: string; interrupted: boolean; failed: boolean }
/** The hierarchy builds that belong to `revision`: queued, running, done or failed alike. */
export function hierarchyBuilds(jobs: JobView[], revision?: string): BuildStatus[] {
  return jobs
    .filter((j) => j.kind === "concept-hierarchy" && (!revision || !j.params.revision || j.params.revision === revision))
    .map((j) => {
      const interrupted = j.state === "FAILED" && /interrupted by a restart/i.test(j.message ?? "");
      const words = (j.message ?? "").trim() || j.phase || j.state.toLowerCase();
      return { id: j.id, state: j.state, detail: j.state === "QUEUED" ? "Waiting to start" : `Building concept hierarchy: ${words}`, interrupted, failed: j.state === "FAILED" };
    });
}

// ---------------------------------------------------------------- concepts

const shortId = (id: string) => id.replace(/^[a-z]+:/, "");
/** What to call a concept: the name it was given, or an honest placeholder. A name is a suggestion, never a claim. */
export { conceptTitle } from "@cie/schema/concept-tree";
/** Who produced a version's names, said plainly. A version saved without a provider says so rather than claiming a model. */
export interface NamingInfo { provider: string; known: boolean; deterministic: boolean; badge: string }
export function namingProvenance(provider: string | null | undefined): NamingInfo {
  if (!provider || provider === "unknown") return { provider: "unknown", known: false, deterministic: false, badge: "provider not recorded" };
  return { ...providerInfo(provider), known: true };
}
/** A name is only "from a model" when the version's provider really is one; the offline stub names things mechanically. */
export function namingBadge(c: Pick<SemanticConcept, "namedBy">, info?: NamingInfo): string {
  if (c.namedBy === null) return "not named";
  if (c.namedBy === "FALLBACK") return "mechanical name";
  if (info && !info.known) return "name from an unrecorded provider";
  return info?.deterministic ? "name from the offline stub, not model-read" : "name suggested by a model";
}
export const SOUNDNESS: Record<LanguageSoundnessTier, { label: string; help: string }> = {
  verified: { label: "verified", help: "Stated by an explicit assertion in the code." },
  supported: { label: "supported", help: "Follows from the guards on every path that writes it; nothing found that would defeat that." },
  speculative: { label: "speculative", help: "Could be defeated by an await, a closure or a dynamic property access; treat it as a lead, not a rule." },
};
const TIER_RANK: Record<LanguageSoundnessTier, number> = { verified: 0, supported: 1, speculative: 2 };

export interface ConceptGroup { kind: string; concepts: SemanticConcept[] }
/** Concepts grouped by shape, the biggest group first; inside a group the widest concept first. */
export function groupConcepts(concepts: SemanticConcept[], filter = ""): ConceptGroup[] {
  const q = filter.trim().toLowerCase();
  const kept = q ? concepts.filter((c) => conceptTitle(c).toLowerCase().includes(q) || c.kind.toLowerCase().includes(q) || c.members.some((m) => m.toLowerCase().includes(q))) : concepts;
  const by = new Map<string, SemanticConcept[]>();
  for (const c of kept) by.set(c.kind, [...(by.get(c.kind) ?? []), c]);
  return [...by].map(([kind, cs]) => ({ kind, concepts: [...cs].sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id)) }))
    .sort((a, b) => b.concepts.length - a.concepts.length || a.kind.localeCompare(b.kind));
}
export function memberNames(c: Pick<SemanticConcept, "members">, max = 4): string {
  const names = c.members.slice(0, max).map(shortId);
  return names.join(", ") + (c.members.length > max ? ` and ${c.members.length - max} more` : "");
}

/** Invariants with the surest first. */
export function sortInvariants(invariants: Invariant[]): Invariant[] {
  return [...invariants].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.subjectEntityId.localeCompare(b.subjectEntityId) || a.variable.localeCompare(b.variable));
}

// ---------------------------------------------------------------- architecture tree

export interface ArchRow { node: ArchConcept; depth: number }
/** The containment tree flattened depth-first, in the order each parent lists its children. Cycles and dangling ids cannot loop or crash. */
export function archRows(arch: ArchConcept[], limit = 2000): ArchRow[] {
  const byId = new Map(arch.map((n) => [n.id, n]));
  const roots = arch.filter((n) => !n.parent || !byId.has(n.parent));
  const rows: ArchRow[] = [], seen = new Set<string>();
  const walk = (n: ArchConcept, depth: number) => {
    if (rows.length >= limit || seen.has(n.id)) return;
    seen.add(n.id); rows.push({ node: n, depth });
    for (const id of n.children) { const child = byId.get(id); if (child) walk(child, depth + 1); }
  };
  for (const r of roots) walk(r, 0);
  return rows;
}

// ---------------------------------------------------------------- summaries and provenance

export const isEmptyHierarchy = (v: ConceptHierarchyView | null): boolean => !v || v.version === 0;
export function hierarchySummary(v: ConceptHierarchyView): string {
  const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  return [n(v.concepts.length, "concept"), n(v.invariants.length, "invariant"), n(v.crossPackage.length, "cross-package concept"), n(v.arch.length, "tree node")].join(" · ");
}
/** What the build did, in plain words: reuse, naming, and anything that was skipped. */
export function statsNotes(s: HierarchyStats | null): string[] {
  if (!s) return ["Build statistics are kept only for the current version."];
  const out: string[] = [];
  out.push(s.fullRebuild ? `Full rebuild (${s.files.changed} of ${s.files.total} files changed).` : `Incremental: ${s.files.changed} of ${s.files.total} files changed; ${s.pdgs.reused} graph(s) reused, ${s.pdgs.built} rebuilt.`);
  if (s.pdgs.skipped || s.pdgs.unresolved) out.push(`${s.pdgs.skipped} function(s) skipped over budget, ${s.pdgs.unresolved} whose source could not be read. They are not in the results.`);
  out.push(`Names: ${s.naming.named} from a model, ${s.naming.fallback} mechanical${s.naming.cacheHits ? `, ${s.naming.cacheHits} reused from earlier builds` : ""}.`);
  for (const w of s.warnings) out.push(w);
  return out;
}
/**
 * When no model wrote any name, say so and say why, so "collect-and-return in saveOrder" is understood as the fallback it is.
 * Null when at least one name came from a model (the per-concept badge says which) or the build kept no statistics.
 */
export function mechanicalNamesNotice(s: HierarchyStats | null): string | null {
  if (!s || s.naming.fallback === 0 || s.naming.named > 0) return null;
  const why = s.warnings.find((w) => /not approved|budget/i.test(w));
  const base = "Every name here is mechanical: the shape plus the function it sits in. No model wrote them.";
  return why ? `${base} ${why} Approve it, then build again to get descriptive names.` : `${base} No model was available when this was built.`;
}

export const HIERARCHY_HELP = "Concepts here are structural: functions grouped because their code has the same control and data shape. A name is a suggestion, not a finding. An invariant is inferred from guards in the code; its tier says how sure that is. Nothing here has been run.";
