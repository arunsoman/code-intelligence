// C07: keeping what was derived honest when the code changes. An edit produces a new revision; what rested on the old one is
// found through reverse dependencies, marked stale before the new revision is eligible, and re-derived on the new one only if its
// inputs are unchanged and stayed unchanged while it was checked. A full re-index and an incremental one must give the same graph.
import { createHash } from "node:crypto";
import type { Claim } from "@cie/schema";
import { StubProvider } from "@cie/model";
import { dependents } from "./graph.ts";
import type { Service } from "./service.ts";
import { Store } from "./store.ts";
import { WorkerClient } from "./worker.ts";

export interface DependencyImpact {
  fromRevision: string; toRevision: string;
  changed: string[]; added: string[]; removed: string[]; renamed: { from: string; to: string }[];
  /** Everything that calls (directly or through others) something that changed. */
  affectedEntities: string[];
  claims: string[]; concepts: string[]; workspaces: string[];
}

const SYMBOLS = new Set(["function", "method", "class"]);

export function graphDigest(store: Store, revision: string): { digest: string; entities: number; relationships: number; facts: number } {
  const ents = store.entities(revision).map((e) => [e.entityId, e.kind, e.name, e.file, e.symbolHash ?? ""].join("|")).sort();
  const rels = store.allRelationships(revision).map((r) => [r.from, r.to, r.kind, r.resolution, r.label ?? ""].join("|")).sort();
  const facts = store.allFacts(revision).map((f) => [f.subject, f.predicate, f.resolution, JSON.stringify(f.object)].join("|")).sort();
  return { digest: createHash("sha256").update([ents.join("\n"), rels.join("\n"), facts.join("\n")].join("\n--\n")).digest("hex").slice(0, 24), entities: ents.length, relationships: rels.length, facts: facts.length };
}

export class Indexer {
  declare readonly svc: Service;
  private timers = new Map<string, NodeJS.Timeout>();
  private pending = new Map<string, Set<string>>();
  private waiters = new Map<string, { resolve: (v: { revision: string; coalesced: number }) => void; reject: (e: unknown) => void }[]>();
  private setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  constructor(svc: Service, opts: { setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout } = {}) { Object.defineProperty(this, "svc", { value: svc, enumerable: false }); this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)); }
  private get store() { return this.svc.store; }

  // ------------------------------------------------------------------ the fence
  generation(repoRoot: string): number { return Number((this.store.db.prepare("select generation from index_generation where repo_root = ?").get(repoRoot) as any)?.generation ?? 0); }
  /** Move the fence: results computed under an older generation are no longer eligible to be applied. */
  bump(repoRoot: string): number { const g = this.generation(repoRoot) + 1; this.store.db.prepare("insert or replace into index_generation values (?,?)").run(repoRoot, g); return g; }

  // ------------------------------------------------------------------ impact
  computeImpact(from: string, to: string): DependencyImpact {
    const store = this.store;
    const A = new Map(store.entities(from).filter((e) => SYMBOLS.has(e.kind)).map((e) => [e.entityId, e])), B = new Map(store.entities(to).filter((e) => SYMBOLS.has(e.kind)).map((e) => [e.entityId, e]));
    const changed = [...B.keys()].filter((id) => A.has(id) && A.get(id)!.symbolHash !== B.get(id)!.symbolHash);
    const removedAll = [...A.keys()].filter((id) => !B.has(id)), addedAll = [...B.keys()].filter((id) => !A.has(id));
    const canonA = new Map(removedAll.map((id) => [this.svc.registry.canonOf(from, id), id])), renamed: { from: string; to: string }[] = [];
    for (const id of addedAll) { const c = this.svc.registry.canonOf(to, id); const old = c ? canonA.get(c) : undefined; if (old) renamed.push({ from: old, to: id }); }
    const renamedFrom = new Set(renamed.map((r) => r.from)), renamedTo = new Set(renamed.map((r) => r.to));
    const removed = removedAll.filter((id) => !renamedFrom.has(id)), added = addedAll.filter((id) => !renamedTo.has(id));
    // Reverse dependencies, on the new graph for what still exists and on the old graph for what went away (their callers are affected too).
    const affected = new Set<string>([...changed, ...renamed.map((r) => r.to)]);
    for (const id of changed) for (const n of dependents(store, to, id, { maxDepth: 8 }).nodes) affected.add(n.id);
    for (const id of [...removed, ...renamed.map((r) => r.from)]) for (const n of dependents(store, from, id, { maxDepth: 8 }).nodes) if (B.has(n.id) || renamedFrom.has(n.id)) affected.add(n.id);
    const touched = new Set([...changed, ...removed, ...renamed.map((r) => r.from), ...affected]);
    // Claims on the old revision resting on any of it: by what they cite, what they are about, or what they were derived from.
    const claimIds = new Set<string>();
    const rowsC = this.store.db.prepare("select json from claims where revision = ?").all(from) as any[];
    const claims = rowsC.map((r) => JSON.parse(r.json) as Claim);
    const evidenceOf = (id: string) => store.relationshipsFor(from, id).flatMap((r) => r.evidence.map((e) => e.id));
    const touchedEvidence = new Set([...touched].flatMap(evidenceOf));
    const rootsOf = (c: Claim) => [...(c.draft.subjects ?? []), ...(c.draft.structure?.entityIds ?? [])];
    for (const c of claims) if (c.draft.evidenceIds.some((e) => touchedEvidence.has(e)) || rootsOf(c).some((s) => touched.has(s))) claimIds.add(c.draft.id);
    // Transitively: whatever was derived from a claim that is now in doubt.
    for (let grew = true; grew;) { grew = false; for (const c of claims) if (!claimIds.has(c.draft.id) && (c.draft.dependencyIds ?? []).some((d) => claimIds.has(d))) { claimIds.add(c.draft.id); grew = true; } }
    const concepts = store.concepts(from, { includeRefuted: true }).filter((c) => c.members.some((m) => touched.has(m)) || claimIds.has(c.claimId)).map((c) => c.id);
    const workspaces = (this.store.db.prepare("select ws, revision from ws_meta where revision = ?").all(from) as any[]).filter((w) => { const r = this.svc.workspaceLog.resume(w.ws); return r.ok && ((r.workspace.state.view?.nodes ?? []).some((n) => n.entityRefs.some((e) => touched.has(e))) || r.workspace.state.claimIds.some((c) => claimIds.has(c))); }).map((w) => w.ws);
    return { fromRevision: from, toRevision: to, changed: changed.sort(), added: added.sort(), removed: removed.sort(), renamed, affectedEntities: [...affected].sort(), claims: [...claimIds].sort(), concepts: concepts.sort(), workspaces: workspaces.sort() };
  }

  /**
   * Mark everything the impact names as stale before the new revision is used for anything, then re-derive. Re-derivation
   * happens only for claims whose cited code is byte-identical in the new revision, and is abandoned if the fence moved while it ran.
   */
  async invalidateAndRevalidate(impact: DependencyImpact, opts: { betweenSteps?: () => Promise<void> | void } = {}): Promise<{ stale: string[]; restored: { from: string; to: string }[]; abandoned: string[]; generation: number }> {
    const store = this.store;
    const rev = store.revision(impact.toRevision)!;
    const gen = this.bump(rev.repoRoot);
    const stale: string[] = [];
    for (const id of impact.claims) {
      const c = store.getClaim(id); if (!c || c.state === "REFUTED" || c.state === "RETIRED" || c.state === "STALE") continue;
      store.putClaim({ ...c, version: c.version + 1, state: "STALE", displayMode: c.displayMode === "HIDDEN" ? "HIDDEN" : "HYPOTHESIS" }, "indexer", "stale.invalidate");
      stale.push(id);
    }
    const restored: { from: string; to: string }[] = [], abandoned: string[] = [];
    for (const id of stale) {
      await opts.betweenSteps?.();
      // The fence: something newer arrived while we were working, so this result must not be applied.
      if (this.generation(rev.repoRoot) !== gen) { abandoned.push(id); continue; }
      const old = store.getClaim(id)!;
      const sameInputs = old.draft.evidenceIds.every((e) => this.unchanged(impact, old.draft.revision, e));
      if (!sameInputs || (old.draft.structure?.entityIds ?? []).some((e) => impact.changed.includes(e) || impact.removed.includes(e))) continue;
      // Re-derive on the new revision: the same assertion over the same cited text, gated again from scratch.
      const newEvidence = old.draft.evidenceIds.map((e) => this.mapEvidence(impact, e)).filter((e): e is string => !!e);
      if (newEvidence.length !== old.draft.evidenceIds.length) continue;
      const { gateClaim } = await import("./claims.ts");
      const fresh = gateClaim({ assertion: old.draft.assertion, claimClass: old.draft.claimClass, evidenceIds: newEvidence, rationaleSummary: old.draft.rationaleSummary, structure: old.draft.structure, subjects: old.draft.subjects }, { id: "reval", revision: impact.toRevision, evidence: [], entities: [], relationships: [], facts: [], coverage: [], unresolved: [], tokenEstimate: 0 }, { store, trusted: true });
      if (this.generation(rev.repoRoot) !== gen) { abandoned.push(id); continue; }
      if (fresh.displayMode === "HIDDEN") continue;
      store.putClaim(fresh, "indexer", "revalidated");
      restored.push({ from: id, to: fresh.draft.id });
    }
    return { stale, restored, abandoned, generation: gen };
  }
  /** Evidence ids are content-addressed: the same id in the new revision means the same bytes at the same place. */
  private mapEvidence(impact: DependencyImpact, evId: string): string | null { return this.store.evidence(impact.toRevision, evId) ? evId : null; }
  private unchanged(impact: DependencyImpact, fromRevision: string, evId: string): boolean {
    const ev = this.store.evidence(fromRevision, evId), now = this.store.evidence(impact.toRevision, evId);
    if (!ev || !now) return false;
    const a = (ev.location as any)?.span, b = (now.location as any)?.span;
    return !!a && !!b && a.contentHash === b.contentHash && a.startByte === b.startByte && a.endByteExclusive === b.endByteExclusive;
  }

  // ------------------------------------------------------------------ equivalence with a clean index
  /** Index the same path from nothing, in a separate store and parser, and compare the graphs. */
  async compareWithCleanIndex(revision: string): Promise<{ equivalent: boolean; incremental: ReturnType<typeof graphDigest>; clean: ReturnType<typeof graphDigest>; differences: string[] }> {
    const rev = this.store.revision(revision)!;
    const worker = new WorkerClient();
    try {
      const { Service } = await import("./service.ts");
      const clean = new Service(new Store(":memory:"), worker, new StubProvider());
      const r = await clean.ingestRepository({ requestId: "c", idempotencyKey: "c", actor: { principalId: "indexer", tenantId: "t", sessionId: "s" }, deadlineMs: Date.now() + 120_000, traceId: "c" }, { repoPath: rev.repoRoot });
      if (!r.ok) throw new Error(r.error.message);
      const a = graphDigest(this.store, revision), b = graphDigest(clean.store, r.value.id);
      const differences: string[] = [];
      if (a.digest !== b.digest) {
        const set = (s: Store, id: string) => new Set([...s.entities(id).map((e) => `entity ${e.entityId}`), ...s.allRelationships(id).map((x) => `edge ${x.from}>${x.to}:${x.kind}`), ...s.allFacts(id).map((f) => `fact ${f.subject} ${f.predicate} ${JSON.stringify(f.object)}`)]);
        const A = set(this.store, revision), B = set(clean.store, r.value.id);
        for (const x of A) if (!B.has(x)) differences.push(`only incremental: ${x}`);
        for (const x of B) if (!A.has(x)) differences.push(`only clean: ${x}`);
      }
      return { equivalent: a.digest === b.digest, incremental: a, clean: b, differences: differences.slice(0, 20) };
    } finally { worker.close(); }
  }

  // ------------------------------------------------------------------ edits arriving
  /** Coalesce a burst of edits into one index run. Returns when the run has finished. */
  notifyChange(repoPath: string, files: string[], opts: { debounceMs?: number } = {}): Promise<{ revision: string; coalesced: number }> {
    const set = this.pending.get(repoPath) ?? new Set<string>(); for (const f of files) set.add(f); this.pending.set(repoPath, set);
    const t = this.timers.get(repoPath); if (t) clearTimeout(t);
    return new Promise((resolve, reject) => {
      this.waiters.set(repoPath, [...(this.waiters.get(repoPath) ?? []), { resolve, reject }]);
      this.timers.set(repoPath, this.setTimer(async () => {
        this.timers.delete(repoPath);
        const batch = this.pending.get(repoPath)!; this.pending.delete(repoPath);
        const ws = this.waiters.get(repoPath) ?? []; this.waiters.delete(repoPath);
        try {
          const r = await this.svc.ingestRepository({ requestId: "i", idempotencyKey: "i", actor: { principalId: "indexer", tenantId: "t", sessionId: "s" }, deadlineMs: Date.now() + 120_000, traceId: "i" }, { repoPath });
          if (!r.ok) throw new Error(r.error.message);
          for (const w of ws) w.resolve({ revision: r.value.id, coalesced: batch.size });
        } catch (e) { for (const w of ws) w.reject(e); }
      }, opts.debounceMs ?? 400));
    });
  }
}
