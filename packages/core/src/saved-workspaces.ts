// C13: saved investigations (workspaces) - save, list, and resume with staleness detection.
import { randomUUID } from "node:crypto";
import type { ApiResult, CallContext, Claim, SavedState } from "@cie/schema";
import type { CommitReceipt } from "./journal.ts";
import { actor, fail, ok } from "./service.ts";
import type { Service } from "./service.ts";

export class SavedWorkspaces {
  declare readonly svc: Service;
  constructor(svc: Service) { Object.defineProperty(this, "svc", { value: svc, enumerable: false }); }
  private get store() { return this.svc.store; }

  saveWorkspace(ctx: CallContext, req: { workspaceId?: string; name: string; expectedVersion: number; revision?: string; state: SavedState }): ApiResult<{ workspaceId: string; receipt: CommitReceipt; replayed: boolean }> {
    const name = (req.name ?? "").trim();
    if (!name || name.length > 120) return fail(ctx, { code: "INVALID_SCHEMA", message: "name must be 1–120 characters", retryable: false });
    const workspaceId = req.workspaceId ?? `ws:${randomUUID()}`;
    const r = this.svc.journal.submit(ctx, { id: ctx.requestId, type: "UPDATE_WORKSPACE", subjectId: workspaceId, expectedVersion: req.expectedVersion ?? 0, payload: { name, revision: req.revision, state: req.state } });
    if (!r.ok) return fail(ctx, r.error);
    if (!r.replayed) this.store.audit(actor(ctx), "workspace.save", workspaceId, { version: r.receipt.resourceVersion });
    return ok(ctx, { workspaceId, receipt: r.receipt, replayed: r.replayed }, { resourceVersion: r.receipt.resourceVersion, revision: req.revision });
  }

  listWorkspaces(ctx: CallContext): ApiResult<{ id: string; name: string; version: number; revision: string | null; updatedAt: string }[]> {
    const rows = (this.store.db.prepare("select id, name, version, revision, updated_at from workspaces order by updated_at desc").all() as any[])
      .filter((r) => { const o = r.revision ? this.store.revision(r.revision, true) : null; return !(o && this.store.isRevoked(o.repoRoot)); });
    return ok(ctx, rows.map((r) => ({ id: r.id, name: r.name, version: r.version, revision: r.revision, updatedAt: r.updated_at })));
  }

  /** Resume: saved state plus staleness (evidence whose source changed) and the current state of every saved claim. */
  openWorkspace(ctx: CallContext, req: { workspaceId: string }): ApiResult<{ id: string; name: string; version: number; revision: string | null; state: SavedState; staleEvidence: string[]; staleFiles: string[]; revisionIndexed: boolean; claimStates: Claim[] }> {
    const row = this.store.db.prepare("select * from workspaces where id = ?").get(req.workspaceId) as any;
    if (!row) return fail(ctx, { code: "NOT_FOUND", message: "no such workspace", retryable: false });
    // A saved investigation over a source whose permission was withdrawn is not served, even before it is purged.
    const owner = row.revision ? this.store.revision(row.revision, true) : null;
    if (owner && this.store.isRevoked(owner.repoRoot)) return fail(ctx, { code: "FORBIDDEN", message: "access to the source this was saved against was withdrawn", retryable: false });
    const state: SavedState = JSON.parse(row.json);
    const rev = row.revision ? this.store.revision(row.revision) : null;
    const ids = new Set<string>();
    for (const n of state.view?.nodes ?? []) n.evidenceIds.forEach((i) => ids.add(i));
    for (const e of state.view?.edges ?? []) e.evidenceIds.forEach((i) => ids.add(i));
    for (const c of [...state.claims, ...(state.explanation?.claims ?? [])]) c.draft.evidenceIds.forEach((i) => ids.add(i));
    const staleEvidence: string[] = [];
    const staleFiles = new Set<string>();
    if (rev) {
      for (const id of ids) {
        const ev = this.store.evidence(rev.id, id);
        if (!ev) continue;
        const res = this.svc.resolveEvidence(rev, ev);
        if (res.state === "STALE" || res.state === "UNAVAILABLE") { staleEvidence.push(id); staleFiles.add(res.file); }
      }
    }
    const claimIds = [...new Set([...state.claims, ...(state.explanation?.claims ?? [])].map((c) => c.draft.id))];
    this.store.audit(actor(ctx), "workspace.open", row.id, { stale: staleEvidence.length });
    return ok(ctx, { id: row.id, name: row.name, version: row.version, revision: row.revision, state, staleEvidence, staleFiles: [...staleFiles].sort(), revisionIndexed: !!rev, claimStates: this.store.getClaims(claimIds) },
      { revision: row.revision ?? undefined, resourceVersion: row.version, completeness: staleEvidence.length ? "PARTIAL" : "COMPLETE", warnings: staleEvidence.length ? [`${staleEvidence.length} evidence span(s) changed since this was saved`] : [] });
  }
}
