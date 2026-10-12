// C04.readRevisionPair / C23.compare: diffing two indexed revisions (file deltas, affected elements, commits).
import { existsSync } from "node:fs";
import type { ApiResult, CallContext, ChangesSince, SavedState } from "@cie/schema";
import { short } from "./forms/common.ts";
import { fail, hashFiles, ok } from "./service.ts";
import type { Service } from "./service.ts";

export class RevisionDiff {
  declare readonly svc: Service;
  constructor(svc: Service) { Object.defineProperty(this, "svc", { value: svc, enumerable: false }); }
  private get store() { return this.svc.store; }

  private fileHash(rev: string) {
    return new Map(this.store.entities(rev).filter((e) => e.kind === "file").map((e) => [e.file, e.spans[0]?.contentHash ?? ""]));
  }
  private fileDelta(rev0: string, rev1: string) {
    const h0 = this.fileHash(rev0), h1 = this.fileHash(rev1);
    return {
      added: [...h1.keys()].filter((f) => !h0.has(f)).sort(), removed: [...h0.keys()].filter((f) => !h1.has(f)).sort(),
      changed: [...h1.keys()].filter((f) => h0.has(f) && h0.get(f) !== h1.get(f)).sort(),
    };
  }
  private commitDelta(rev0: string, rev1: string) {
    const hist = (rev: string) => new Map(this.store.factsByPredicate(rev, "history").map((f) => [f.subject.replace(/^file:/, ""), (f.object as any).value]));
    const c0 = hist(rev0), c1 = hist(rev1);
    return [...c1].filter(([f, v]) => c0.get(f)?.lastCommit !== v.lastCommit).map(([file, v]) => ({ file, subject: v.lastSubject, author: v.lastAuthor, date: v.lastDate })).slice(0, 10);
  }

  /** "What changed since I left": re-index the repository and diff against the saved revision. */
  async changesSince(ctx: CallContext, req: { workspaceId: string }): Promise<ApiResult<ChangesSince>> {
    const row = this.store.db.prepare("select * from workspaces where id = ?").get(req.workspaceId) as any;
    const rev0 = row?.revision ? this.store.revision(row.revision) : null;
    if (!row || !rev0) return fail(ctx, { code: "NOT_FOUND", message: "no saved revision to compare against", retryable: false });
    if (!existsSync(rev0.repoRoot)) return fail(ctx, { code: "NOT_FOUND", message: `repository folder no longer exists: ${rev0.repoRoot}`, retryable: false });
    const ing = await this.svc.ingestRepository(ctx, { repoPath: rev0.repoRoot });
    if (!ing.ok) return ing as ApiResult<never>;
    const rev1 = ing.value;
    const state: SavedState = JSON.parse(row.json);
    const files = this.fileDelta(rev0.id, rev1.id);
    const changedSet = new Set(files.changed);
    const e0 = new Map(this.store.entities(rev0.id).map((e) => [e.entityId, e]));
    const e1 = new Map(this.store.entities(rev1.id).map((e) => [e.entityId, e]));
    const affectedNodes: ChangesSince["affectedNodes"] = [];
    for (const n of state.view?.nodes ?? []) {
      for (const id of n.entityRefs) {
        const cur = e1.get(id);
        if (!cur) affectedNodes.push({ nodeId: n.id, label: n.label, change: "removed" });
        // A node is affected when its own source changed (symbol hash), not merely when its file did.
        else if (changedSet.has(cur.file) && cur.symbolHash !== e0.get(id)?.symbolHash) affectedNodes.push({ nodeId: n.id, label: n.label, change: "changed" });
      }
    }
    const commits = this.commitDelta(rev0.id, rev1.id);
    const changed = rev1.id !== rev0.id;
    const summary = !changed ? "Nothing in the repository has changed since you saved this investigation."
      : `Since you left: ${files.changed.length} file(s) changed, ${files.added.length} added, ${files.removed.length} removed; ${affectedNodes.length} element(s) of this investigation are affected.${commits.length ? ` Latest: “${commits[0].subject}” by ${commits[0].author}.` : ""}`;
    return ok(ctx, { fromRevision: rev0.id, toRevision: rev1.id, changed, files, affectedNodes, commits, summary }, { revision: rev1.id });
  }

  /** Bounded freshness probe: compares bytes without replacing the indexed graph. */
  probeIndexChanges(ctx: CallContext, req: { revision?: string }): ApiResult<unknown> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "No indexed revision.", retryable: false });
    const scanned = hashFiles(rev.repoRoot, Math.max(1, Math.min(2000, ctx.deadlineMs - Date.now())), 5000);
    if (scanned.error) return fail(ctx, { code: "BUDGET_EXCEEDED", message: "Freshness scan exceeded its bound; freshness is unknown.", retryable: true });
    const indexed = new Map(this.store.entities(rev.id).filter(e => e.kind === "file").map(e => [e.file, e.spans[0]?.contentHash]));
    const supported = (path: string) => /\.(?:[cm]?[jt]sx?|rs|java|go|py|nir|sql|ya?ml|properties)$/.test(path);
    const added = [...scanned.map.keys()].filter(path => !indexed.has(path) && supported(path));
    const removed = [...indexed.keys()].filter(path => !scanned.map.has(path));
    const changed = [...indexed.keys()].filter(path => scanned.map.has(path) && scanned.map.get(path) !== indexed.get(path));
    return ok(ctx, { changed: added.length + removed.length + changed.length > 0, files: { added, removed, changed } }, { revision: rev.id });
  }

  /** "What changed since my last index?": re-index the repository without a saved investigation and summarise the delta. */
  async changesSinceIndex(ctx: CallContext, req: { revision?: string }): Promise<ApiResult<ChangesSince>> {
    const from = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!from) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision to compare against", retryable: false });
    const ing = await this.svc.ingestRepository(ctx, { repoPath: from.repoRoot });
    if (!ing.ok) return ing as ApiResult<never>;
    return this.changesBetween(ctx, from.id, ing.value.id);
  }

  /** Post-MVP (C04.readRevisionPair): an indexed revision id may name any earlier revision. */
  async changesBetweenRevisions(ctx: CallContext, req: { fromRevision: string; toRevision?: string }): Promise<ApiResult<ChangesSince>> {
    const from = this.store.revision(req.fromRevision);
    if (!from) return fail(ctx, { code: "NOT_FOUND", message: `no such revision: ${req.fromRevision}`, retryable: false });
    const to = (req.toRevision ? this.store.revision(req.toRevision) : null) ?? this.store.latestRevision(from.repoRoot);
    if (!to) return fail(ctx, { code: "NOT_FOUND", message: "no later revision of this repository is indexed", retryable: false });
    return this.changesBetween(ctx, from.id, to.id);
  }

  /** Diff two stored revisions (C04.readRevisionPair, C23.compare): file deltas, affected elements, commits. */
  changesBetween(ctx: CallContext, rev0id: string, rev1id: string): ApiResult<ChangesSince> {
    const rev0 = this.store.revision(rev0id), rev1 = this.store.revision(rev1id);
    if (!rev0 || !rev1) return fail(ctx, { code: "NOT_FOUND", message: "no such revision", retryable: false });
    const files = this.fileDelta(rev0.id, rev1.id);
    const kinds = ["function", "method", "class"];
    const e0 = new Map(this.store.entities(rev0.id).filter((e) => kinds.includes(e.kind)).map((e) => [e.entityId, e]));
    const e1 = new Map(this.store.entities(rev1.id).filter((e) => kinds.includes(e.kind)).map((e) => [e.entityId, e]));
    // Element-level changes: symbols whose text changed inside a changed file (no workspace needed).
    const affectedNodes: ChangesSince["affectedNodes"] = [];
    for (const [id, cur] of e1) {
      const before = e0.get(id);
      if (!before) affectedNodes.push({ nodeId: `n:${id}`, label: cur.name, change: "added" });
      else if (cur.symbolHash && before.symbolHash && cur.symbolHash !== before.symbolHash) affectedNodes.push({ nodeId: `n:${id}`, label: cur.name, change: "changed" });
    }
    for (const [id] of e0) if (!e1.has(id)) affectedNodes.push({ nodeId: `n:${id}`, label: short(id), change: "removed" });
    const commits = this.commitDelta(rev0.id, rev1.id);
    const changed = rev1.id !== rev0.id;
    const summary = !changed ? "Nothing in the repository has changed since this revision was indexed."
      : `Between revisions: ${files.changed.length} file(s) changed, ${files.added.length} added, ${files.removed.length} removed; ${affectedNodes.length} symbol(s) changed.${commits.length ? ` Latest: “${commits[0].subject}” by ${commits[0].author}.` : ""}`;
    return ok(ctx, { fromRevision: rev0.id, toRevision: rev1.id, changed, files, affectedNodes, commits, summary }, { revision: rev1.id });
  }

  /** System status (post-MVP worker stats): indexed revisions, file/symbol counts, last analyzer run. */
  revisionStats(ctx: CallContext, req: { revision?: string }): ApiResult<{ revision: string | null; files: number; symbols: number; diagnostics: string[] }> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return ok(ctx, { revision: null, files: 0, symbols: 0, diagnostics: [] });
    const ents = this.store.entities(rev.id);
    return ok(ctx, {
      revision: rev.id, files: ents.filter((e) => e.kind === "file").length,
      symbols: ents.filter((e) => ["function", "method", "class"].includes(e.kind)).length,
      diagnostics: rev.diagnostics.map((d) => d.message),
      repoRoot: rev.repoRoot, gitHead: rev.gitHead, createdAt: rev.createdAt,
    }, { revision: rev.id });
  }
}
