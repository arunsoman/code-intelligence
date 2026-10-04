// C29: working together without widening anyone's access. A workspace is shared with a person only if that person can already read
// the code it is about, and what they see is cut to what they may read; a handover says what the recipient cannot see without showing it;
// edits are attributed and conflicts are settled by an explicit choice, never by an implicit merge; a team's confirmation of a concept
// reaches everyone who can see the concept and nobody else.
import type { ApiError, ViewSpec } from "@cie/schema";
import { applyVerdict } from "./claims.ts";
import { Security } from "./security.ts";
import type { Store } from "./store.ts";
import { WorkspaceLog, type ResumedWorkspace, type WorkspaceEvent } from "./workspaces.ts";

export type Role = "viewer" | "editor" | "owner";
type Fail = { ok: false; error: ApiError };
const fail = (code: ApiError["code"], message: string, extra: Partial<ApiError> = {}): Fail => ({ ok: false, error: { code, message, retryable: false, ...extra } });
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export interface Withheld { items: number; note: string }

export class Collab {
  readonly store: Store;
  readonly log: WorkspaceLog;
  constructor(store: Store, log: WorkspaceLog) { this.store = store; this.log = log; }

  // ------------------------------------------------------------------ people and their source access
  addPrincipal(principal: string, tenant: string) { this.store.db.prepare("insert or replace into collab_principals values (?,?)").run(principal, tenant); }
  tenantOf(principal: string): string | null { return (this.store.db.prepare("select tenant from collab_principals where principal = ?").get(principal) as any)?.tenant ?? null; }
  setAccess(principal: string, repoRoot: string, a: { allowed: boolean; deniedPrefixes?: string[] }) { this.store.db.prepare("insert or replace into collab_access values (?,?,?,?)").run(principal, repoRoot, a.allowed ? 1 : 0, JSON.stringify(a.deniedPrefixes ?? [])); }
  /** What this person may read of a repository. No record means no access: sharing is never the way in. */
  access(principal: string, repoRoot: string | null): { allowed: boolean; denied: (file: string) => boolean } {
    if (!repoRoot) return { allowed: true, denied: () => false };
    const r = this.store.db.prepare("select allowed, denied from collab_access where principal = ? and repo_root = ?").get(principal, repoRoot) as any;
    const own: string[] = r ? JSON.parse(r.denied) : [];
    const prefixes = [...own, ...this.store.deniedPrefixes(repoRoot)];
    const norm = (f: string) => f.replace(/^\.?\//, "");
    return { allowed: !!r?.allowed && !this.store.isRevoked(repoRoot), denied: (file) => { const f = norm(file); return prefixes.some((p) => f === p || f.startsWith(p.endsWith("/") ? p : p + "/")); } };
  }

  // ------------------------------------------------------------------ workspaces
  private row(ws: string) { return this.store.db.prepare("select ws, name, revision from ws_meta where ws = ?").get(ws) as any; }
  private repoOf(ws: string): string | null { const r = this.row(ws); return r?.revision ? this.store.revision(r.revision, true)?.repoRoot ?? null : null; }
  private roleOf(ws: string, principal: string): Role | null { return ((this.store.db.prepare("select role from collab_shares where ws = ? and principal = ? and active = 1").get(ws, principal) as any)?.role as Role) ?? null; }
  private opLog(ws: string, kind: string, actor: string, detail: unknown) { this.store.db.prepare("insert into collab_ops(ws, kind, actor, detail, at) values (?,?,?,?,?)").run(ws, kind, actor, JSON.stringify(detail), new Date().toISOString()); }
  history(ws: string) { return (this.store.db.prepare("select seq, kind, actor, detail, at from collab_ops where ws = ? order by seq").all(ws) as any[]).map((r) => ({ ...r, detail: JSON.parse(r.detail) })); }

  /** Create a workspace the actor owns. They must be able to read the code it is about. */
  create(actor: string, req: { name: string; revision: string | null }): { ok: true; id: string } | Fail {
    const t = this.tenantOf(actor); if (!t) return fail("UNAUTHORIZED", "unknown principal");
    const repo = req.revision ? this.store.revision(req.revision)?.repoRoot ?? null : null;
    if (!this.access(actor, repo).allowed) return fail("FORBIDDEN", "you do not have access to that source");
    const c = this.log.create(actor, req); if (!c.ok) return c;
    this.store.db.prepare("insert into collab_shares values (?,?,?,?,?,1)").run(c.id, actor, "owner", actor, new Date().toISOString());
    return { ok: true, id: c.id };
  }

  /** Workspaces another tenant owns do not exist as far as this caller can tell. */
  private visible(ws: string, principal: string): { role: Role } | Fail {
    const t = this.tenantOf(principal);
    const owner = (this.store.db.prepare("select principal from collab_shares where ws = ? and role = 'owner' and active = 1").get(ws) as any)?.principal;
    if (!this.row(ws) || !t || !owner || this.tenantOf(owner) !== t) return fail("NOT_FOUND", "no such workspace");
    const role = this.roleOf(ws, principal);
    if (!role) return fail("NOT_FOUND", "no such workspace");
    if (!this.access(principal, this.repoOf(ws)).allowed) return fail("FORBIDDEN", "your access to the source this was made against has ended");
    return { role };
  }

  /** Share with someone: only a person who can already read the underlying code, in the same tenant, and never above the sharer's own role. */
  share(actor: string, req: { workspaceId: string; principalId: string; role: Role }): { ok: true; grant: { workspaceId: string; principalId: string; role: Role } } | Fail {
    const v = this.visible(req.workspaceId, actor); if ("ok" in v) return v;
    if (RANK[v.role] < RANK.editor) return fail("FORBIDDEN", "only an editor or owner can share");
    if (!(req.role in RANK) || req.role === "owner") return fail("INVALID_SCHEMA", "a share is viewer or editor; ownership moves by handover");
    if (RANK[req.role] > RANK[v.role]) return fail("FORBIDDEN", "you cannot grant more than you have");
    const ta = this.tenantOf(actor), tb = this.tenantOf(req.principalId);
    if (!tb || ta !== tb) return fail("FORBIDDEN", "that person is not in your organisation");
    // The recipient must already have the access; the message does not say why not in more detail than that.
    if (!this.access(req.principalId, this.repoOf(req.workspaceId)).allowed) { this.opLog(req.workspaceId, "SHARE_REFUSED", actor, { principal: req.principalId, reason: "no source access" }); return fail("FORBIDDEN", "that person does not have access to the source this investigation is about, and sharing cannot give it to them"); }
    this.store.db.prepare("insert or replace into collab_shares values (?,?,?,?,?,1)").run(req.workspaceId, req.principalId, req.role, actor, new Date().toISOString());
    this.opLog(req.workspaceId, "SHARED", actor, { principal: req.principalId, role: req.role });
    return { ok: true, grant: { workspaceId: req.workspaceId, principalId: req.principalId, role: req.role } };
  }
  unshare(actor: string, req: { workspaceId: string; principalId: string }): { ok: true } | Fail {
    const v = this.visible(req.workspaceId, actor); if ("ok" in v) return v;
    if (v.role !== "owner") return fail("FORBIDDEN", "only the owner can remove access");
    this.store.db.prepare("update collab_shares set active = 0 where ws = ? and principal = ? and role <> 'owner'").run(req.workspaceId, req.principalId);
    this.opLog(req.workspaceId, "UNSHARED", actor, { principal: req.principalId });
    return { ok: true };
  }

  /** The workspace as this person may see it: parts about code they cannot read are removed and counted, never named. */
  read(principal: string, workspaceId: string): { ok: true; workspace: ResumedWorkspace; role: Role; withheld: Withheld } | Fail {
    const v = this.visible(workspaceId, principal); if ("ok" in v) return v;
    const r = this.log.resume(workspaceId); if (!r.ok) return r;
    const { workspace, withheld } = this.redactFor(principal, workspaceId, r.workspace);
    return { ok: true, workspace, role: v.role, withheld };
  }
  private redactFor(principal: string, workspaceId: string, resumed: ResumedWorkspace): { workspace: ResumedWorkspace; withheld: Withheld } {
    const acc = this.access(principal, this.repoOf(workspaceId));
    const w = structuredClone(resumed);
    let withheld = 0;
    const fileOf = new Map<string, string>(); for (const n of w.state.view?.nodes ?? []) for (const e of n.entityRefs) fileOf.set(e, n.file);
    const entFile = (id: string) => fileOf.get(id) ?? /^[a-z]+:([^#]+)/.exec(id)?.[1] ?? "";
    if (w.state.view) {
      const keep = new Set<string>();
      const nodes = w.state.view.nodes.filter((n) => { const d = acc.denied(n.file); if (d) withheld++; else keep.add(n.id); return !d; });
      const view: ViewSpec = { ...w.state.view, nodes, edges: w.state.view.edges.filter((e) => keep.has(e.fromNodeId) && keep.has(e.toNodeId)), groups: w.state.view.groups.map((g) => ({ ...g, childNodeIds: g.childNodeIds.filter((c) => keep.has(c)) })), hidden: [] };
      w.state.view = view;
    }
    const pinsBefore = w.state.pins.length, notesBefore = Object.keys(w.state.notes).length;
    w.state.pins = w.state.pins.filter((p) => !acc.denied(entFile(p)));
    for (const k of Object.keys(w.state.notes)) if (acc.denied(entFile(k))) delete w.state.notes[k];
    w.state.selection = w.state.selection.filter((s) => !acc.denied(entFile(s)));
    withheld += pinsBefore - w.state.pins.length + notesBefore - Object.keys(w.state.notes).length;
    return { workspace: w, withheld: { items: withheld, note: withheld ? `${withheld} item(s) are about code you do not have access to and are not shown.` : "" } };
  }

  /** An edit by a named person. Viewers cannot edit; a stale version is a conflict with what changed; every edit keeps its author. */
  applyOperation(actor: string, req: { workspaceId: string; event: WorkspaceEvent; expectedVersion: number; rebase?: boolean; resolves?: number[] }): { ok: true; version: number; rebased: boolean } | (Fail & { since?: unknown }) {
    const v = this.visible(req.workspaceId, actor); if ("ok" in v) return v;
    if (RANK[v.role] < RANK.editor) return fail("FORBIDDEN", "you can read this investigation but not change it");
    // An edit about code the actor cannot read is refused, so the log never holds content its author could not see.
    const target = (req.event as any).entityId as string | undefined;
    if (target && this.access(actor, this.repoOf(req.workspaceId)).denied(/^[a-z]+:([^#]+)/.exec(target)?.[1] ?? "")) return fail("FORBIDDEN", "that element is not available to you");
    const r = this.log.append(actor, { workspaceId: req.workspaceId, event: req.event, expectedVersion: req.expectedVersion, rebase: req.rebase });
    if (r.ok && req.resolves?.length) this.opLog(req.workspaceId, "CONFLICT_RESOLVED", actor, { resolves: req.resolves, seq: r.version });
    if (!r.ok) this.opLog(req.workspaceId, "CONFLICT", actor, { code: r.error.code, expected: req.expectedVersion, current: r.error.currentVersion ?? null });
    return r;
  }

  /**
   * Ownership moves to someone who can read the code, at the version the owner saw. What the recipient cannot see is counted, not
   * shown; unresolved security candidates they may see are handed over with it.
   */
  handover(actor: string, req: { workspaceId: string; principalId: string; expectedVersion: number }): { ok: true; recipient: { gaps: Withheld; openHypotheses: string[]; unresolvedFindings: string[]; staleEvidence: number }; version: number } | Fail {
    const v = this.visible(req.workspaceId, actor); if ("ok" in v) return v;
    if (v.role !== "owner") return fail("FORBIDDEN", "only the owner can hand an investigation over");
    if (this.tenantOf(req.principalId) !== this.tenantOf(actor)) return fail("FORBIDDEN", "that person is not in your organisation");
    const repo = this.repoOf(req.workspaceId), acc = this.access(req.principalId, repo);
    if (!acc.allowed) return fail("FORBIDDEN", "that person has no access to the source this is about, so it cannot be handed to them");
    const cur = this.log.resume(req.workspaceId); if (!cur.ok) return cur;
    if (cur.workspace.version !== req.expectedVersion) return fail("VERSION_CONFLICT", `the investigation changed since you looked (version ${cur.workspace.version})`, { currentVersion: cur.workspace.version });
    // Prepare for the recipient using only what they may read, before anything changes.
    const { workspace: w, withheld } = this.redactFor(req.principalId, req.workspaceId, cur.workspace);
    const findings = w.state.revision ? new Security(this.store).list(w.state.revision).filter((f) => f.state === "CANDIDATE").filter((f) => !acc.denied(/^[a-z]+:([^#]+)/.exec(f.subject.split("@")[0].split(">")[0])?.[1] ?? "")).map((f) => f.summary) : [];
    this.store.tx(() => {
      this.store.db.prepare("insert or replace into collab_shares values (?,?,?,?,?,1)").run(req.workspaceId, req.principalId, "owner", actor, new Date().toISOString());
      this.store.db.prepare("update collab_shares set role = 'editor' where ws = ? and principal = ?").run(req.workspaceId, actor);
    });
    const hidden = Object.entries(w.state.hypotheses).filter(([, h]) => h.state === "OPEN" || h.state === "UNRESOLVED").map(([id, h]) => `${id}: ${h.text}`);
    this.opLog(req.workspaceId, "HANDOVER", actor, { to: req.principalId, atVersion: cur.workspace.version, withheldFromRecipient: withheld.items });
    return { ok: true, version: cur.workspace.version, recipient: { gaps: withheld, openHypotheses: hidden, unresolvedFindings: findings, staleEvidence: w.anchors.stale.length } };
  }

  // ------------------------------------------------------------------ shared concepts
  private cardOf(conceptId: string) { for (const r of this.store.db.prepare("select distinct revision from concepts").all() as any[]) { const c = this.store.concepts(r.revision, { includeRefuted: true }).find((x) => x.id === conceptId); if (c) return c; } return null; }
  private canSeeCard(principal: string, card: { revision: string; members: string[] }): boolean {
    const rev = this.store.revision(card.revision, true);
    const acc = this.access(principal, rev?.repoRoot ?? null);
    return acc.allowed && !card.members.some((m) => acc.denied(/^[a-z]+:([^#]+)/.exec(m)?.[1] ?? ""));
  }
  /** Concepts for one person: the ones whose every member they may read, with their team-confirmed or refuted state; the rest are counted. */
  conceptsFor(principal: string, revision: string) {
    const all = this.store.concepts(revision, { includeRefuted: true });
    const mine = all.filter((c) => this.canSeeCard(principal, c));
    return { concepts: mine.map((c) => { const cl = this.store.getClaim(c.claimId); return { id: c.id, title: c.title, kind: c.kind, state: cl?.state ?? "UNKNOWN", displayMode: cl?.displayMode ?? "HIDDEN", confirmedBy: (cl?.verdicts ?? []).filter((x) => x.verdict === "CONFIRM").map((x) => x.actorId), refutedBy: (cl?.verdicts ?? []).filter((x) => x.verdict === "REFUTE").map((x) => x.actorId) }; }), withheld: all.length - mine.length };
  }
  /** A team member confirms or corrects a concept. It needs access to everything the concept rests on, it is attributed, and it never makes proof. */
  confirmSharedConcept(actor: string, req: { conceptId: string; verdict: "CONFIRM" | "REFUTE" | "DISPUTE"; explanation: string; expectedVersion: number }): { ok: true; state: string; displayMode: string; attributedTo: string } | Fail {
    const card = this.cardOf(req.conceptId);
    if (!card || !this.tenantOf(actor)) return fail("NOT_FOUND", "no such concept");
    if (!this.canSeeCard(actor, card)) return fail("NOT_FOUND", "no such concept");
    const r = applyVerdict(this.store, { claimId: card.claimId, verdict: req.verdict, explanation: req.explanation, actorId: actor, expectedVersion: req.expectedVersion });
    if (!r.ok) return r;
    return { ok: true, state: r.claim.state, displayMode: r.claim.displayMode, attributedTo: actor };
  }
}
