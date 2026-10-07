// The orchestrator (plan §1): one entry point that builds the whole hierarchy for a revision, reusing
// everything the previous revision can prove unchanged.
//
// Incremental discipline:
//   - the changed-file ratio (from the stored per-file digests) above fullRebuildThreshold forces a
//     full rebuild; below it, every phase receives `previous` and reuses what it can,
//   - PDGs: a function whose bodyHash is unchanged is reused whole (no file re-read),
//   - concepts: a concept whose members and shape are unchanged keeps its id and label,
//   - names: the anchoring rule (fingerprint.shouldRename) decides per concept whether the model is
//     asked again; everything else comes from the naming cache.
// The blast radius of a single-line edit is therefore the edited function's graph, its concepts, and
// nothing else — the incremental test asserts exactly that.
import type { ArchConcept, CrossPackageConcept, EntryPoint, ExportSurface, Invariant, SemanticConcept } from "@cie/schema";
import type { Store } from "../store.ts";
import { conceptConfig } from "./config.ts";
import { buildAllPdgs, clearPdgSourceCache } from "./pdg.ts";
import { buildSemanticConcepts } from "./semantic-concepts.ts";
import { buildInvariants } from "./invariants.ts";
import { buildArchitecturalTree } from "./architecture.ts";
import { linkAxes } from "./cross-axis.ts";
import { shouldRename } from "./fingerprint.ts";
import { nameConcepts, type NamingAdapter } from "./naming.ts";
import type { Pdg } from "./types.ts";

export interface HierarchyBuildResult {
  revision: string;
  concepts: SemanticConcept[];
  invariants: Invariant[];
  arch: ArchConcept[];
  surfaces: ExportSurface[];
  entryPoints: EntryPoint[];
  crossPackage: CrossPackageConcept[];
  links: { conceptId: string; archNodeId: string; revision: string }[];
  /** The graphs themselves, persisted so the next revision can reuse them by bodyHash. */
  pdgs: Pdg[];
  stats: {
    fullRebuild: boolean;
    changedFileRatio: number;
    files: { changed: number; total: number };
    pdgs: { built: number; reused: number; skipped: number; unresolved: number };
    conceptsCarried: number;
    renamed: number;
    naming: { named: number; fallback: number; cacheHits: number };
    phasesMs: Record<string, number>;
    warnings: string[];
  };
}

export interface HierarchyProgress {
  checkpoint?(): void;
  progress?(p: { phase: string; message: string }): void;
}

export interface VersionSnapshot {
  concepts: SemanticConcept[];
  invariants: Invariant[];
  surfaces: ExportSurface[];
  crossPackage: CrossPackageConcept[];
  provider: string;
  stats: Record<string, unknown> | null;
}

const lap = <T,>(phases: Record<string, number>, name: string, fn: () => T): T => {
  const t = performance.now();
  const v = fn();
  phases[name] = Math.round((phases[name] ?? 0) + performance.now() - t);
  return v;
};

export async function buildHierarchy(
  store: Store,
  revision: string,
  opts: { repoRoot: string; adapter: NamingAdapter | null; control?: HierarchyProgress; provider?: string },
): Promise<HierarchyBuildResult> {
  const cfg = conceptConfig();
  const phases: Record<string, number> = {};
  const warnings: string[] = [];
  const { checkpoint, progress } = opts.control ?? {};
  checkpoint?.();

  // --- what changed relative to the previous revision of this repository
  const prev = store.previousRevision(revision);
  const prevFiles = prev ? store.revisionFiles(prev.id) : {};
  const curFiles = store.revisionFiles(revision);
  let changed = 0;
  for (const [f, digest] of Object.entries(curFiles)) if (prevFiles[f] !== digest) changed++;
  const total = Math.max(Object.keys(curFiles).length, 1);
  const ratio = changed / total;
  const fullRebuild = !prev || ratio > cfg.fullRebuildThreshold.value;
  if (fullRebuild && prev) warnings.push(`changed-file ratio ${ratio.toFixed(2)} exceeds the (uncalibrated) full-rebuild threshold; rebuilt from scratch`);
  progress?.({ phase: "pdg", message: fullRebuild ? "Building program dependence graphs…" : "Reusing unchanged program dependence graphs…" });

  // --- phase 1: graphs
  const previousPdgs: Pdg[] = fullRebuild || !prev ? [] : store.pdgs(prev.id);
  clearPdgSourceCache();
  const g = lap(phases, "pdg", () => buildAllPdgs(store, revision, opts.repoRoot, previousPdgs));
  if (g.skipped.length) warnings.push(`${g.skipped.length} function(s) past the (uncalibrated) graph budget were not graphed`);
  if (g.unresolved.length) warnings.push(`${g.unresolved.length} function(s) had no locatable body in the source tree`);
  checkpoint?.();

  // --- phase 2: semantic concepts, anchored to the previous set
  progress?.({ phase: "concepts", message: "Matching motifs and composing concepts…" });
  const previousConcepts = fullRebuild || !prev ? [] : store.semanticConcepts(prev.id);
  const sem = lap(phases, "semantic", () => buildSemanticConcepts(store, revision, g.pdgs, previousConcepts));
  checkpoint?.();

  // --- phase 3: invariants
  const invs = lap(phases, "invariants", () => buildInvariants(store, revision, g.pdgs));

  // --- phase 4: architecture
  progress?.({ phase: "architecture", message: "Building the architectural tree…" });
  const arch = lap(phases, "architecture", () => buildArchitecturalTree(store, revision, opts.repoRoot));
  checkpoint?.();

  // --- phase 5: cross-axis links
  const links = lap(phases, "cross-axis", () => linkAxes(sem.concepts, arch.nodes, revision));

  // --- phase 6: anchoring + naming
  progress?.({ phase: "naming", message: "Naming concepts…" });
  const prevSnapshot = fullRebuild || !prev ? null : store.latestSemanticVersionSnapshot(prev.id);
  const prevSurfaces = (prevSnapshot?.surfaces as ExportSurface[] | undefined) ?? [];
  const moduleOf = new Map(arch.nodes.filter((n) => n.kind === "function").map((n) => {
    const file = n.path.replace(/^[a-z]+:/, "").split("#")[0];
    return [n.memberEntityIds[0], `arch:mod:${file}`];
  }));
  const anchored: SemanticConcept[] = sem.concepts.map((c) => {
    const p = previousConcepts.find((x) => x.id === c.id);
    if (!p?.label) return c;
    const decision = shouldRename({
      prevLabel: p.label, prevMembers: p.members, nextMembers: c.members,
      prevFeatures: p.features, nextFeatures: c.features,
      moduleIds: c.members.map((m) => moduleOf.get(m) ?? "").filter(Boolean),
      prevSurfaces, nextSurfaces: arch.surfaces,
    });
    if (!decision.rename) return { ...c, label: p.label, namedBy: p.namedBy };
    warnings.push(`renaming ${p.label}: ${decision.reason}`);
    return { ...c, label: null, namedBy: null };
  });
  const renamed = anchored.filter((c) => c.label === null).length;
  const named = opts.adapter
    ? await nameConcepts(store, {
        concepts: anchored,
        arch: arch.nodes,
        adapter: opts.adapter,
      })
    : {
        concepts: anchored.map((c) => ({ ...c, label: c.label ?? `${c.kind} (${c.members[0]?.split("#").pop() ?? c.members[0] ?? "?"})`.slice(0, 60), namedBy: c.label ? c.namedBy : "FALLBACK" as const })),
        arch: arch.nodes, named: 0, fallback: anchored.filter((c) => !c.label).length, cacheHits: 0,
      };

  const stats = {
    fullRebuild,
    changedFileRatio: ratio,
    files: { changed, total },
    pdgs: { built: g.pdgs.length - g.reused, reused: g.reused, skipped: g.skipped.length, unresolved: g.unresolved.length },
    conceptsCarried: sem.carried,
    renamed,
    naming: { named: named.named, fallback: named.fallback, cacheHits: named.cacheHits },
    phasesMs: phases,
    warnings,
  };

  return {
    revision,
    concepts: named.concepts,
    invariants: invs,
    arch: named.arch,
    surfaces: arch.surfaces,
    entryPoints: arch.entryPoints,
    crossPackage: links.crossPackage,
    links: links.links,
    pdgs: g.pdgs,
    stats,
  };
}

/** Persist one build atomically and record an immutable version snapshot for the repository. */
export function persistHierarchy(store: Store, result: HierarchyBuildResult, provider: string): number {
  const snapshot: VersionSnapshot = {
    concepts: result.concepts, invariants: result.invariants, surfaces: result.surfaces,
    crossPackage: result.crossPackage, provider, stats: result.stats,
  };
  store.putPdgs(result.revision, result.pdgs);
  return store.replaceSemanticConcepts(
    result.revision,
    { concepts: result.concepts, invariants: result.invariants, arch: result.arch, links: result.links, snapshot },
  );
}
