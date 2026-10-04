// C08: stable identities across revisions. Entity ids in one revision are names; a canonical id outlives a rename or a move.
// Matching is cautious: an identical body (name aside) that appears exactly once on each side is a supported rename; a name alone
// never merges anything; splits and merges, and any match that is ambiguous, stay proposals until a person confirms them, and any
// confirmation can be reversed with its history kept.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ApiError, Entity } from "@cie/schema";
import type { Store } from "./store.ts";

export type ProposalKind = "RENAME" | "MERGE" | "SPLIT";
export type ProposalState = "SUPPORTED" | "PROPOSED" | "CONFIRMED" | "DISPUTED" | "REVERSED";
export interface Proposal { id: string; kind: ProposalKind; state: ProposalState; version: number; fromRevision: string; toRevision: string; oldIds: string[]; newIds: string[]; canonBefore: string[]; evidence: string[]; strength: "BODY_IDENTICAL" | "SHAPE_ONLY" | "PARTITION" }
type Fail = { ok: false; error: ApiError };
const fail = (code: ApiError["code"], message: string, extra: Partial<ApiError> = {}): Fail => ({ ok: false, error: { code, message, retryable: false, ...extra } });
const CODE_KINDS = new Set(["function", "method", "class"]);

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const canonOfNew = (revision: string, entityId: string) => "canon:" + sha(revision + "|" + entityId);

/** Digest of a symbol's text with its own name blanked, so that renaming it does not change the digest. */
function bodyDigest(store: Store, revision: string, e: Entity, files: Map<string, Buffer | null>): string | null {
  const rev = store.revision(revision, true);
  const sp = e.spans[0];
  if (!rev || !sp) return null;
  try {
    let buf = files.get(e.file);
    if (buf === undefined) { try { buf = readFileSync(resolve(rev.repoRoot, e.file)); } catch { buf = null; } files.set(e.file, buf); }
    if (!buf) return null;
    const text = buf.subarray(sp.startByte, sp.endByteExclusive).toString("utf8");
    const short = e.name.split(".").pop()!;
    return sha(text.split(short).join("$").replace(/\s+/g, " "));
  } catch { return null; }
}

function shapeOf(store: Store, revision: string): Map<string, { callees: string[]; callers: string[] }> {
  const m = new Map<string, { callees: Set<string>; callers: Set<string> }>();
  const get = (id: string) => { let x = m.get(id); if (!x) { x = { callees: new Set(), callers: new Set() }; m.set(id, x); } return x; };
  for (const r of store.allRelationships(revision)) if (r.kind === "calls") { get(r.from).callees.add(r.to); get(r.to).callers.add(r.from); }
  return new Map([...m].map(([k, v]) => [k, { callees: [...v.callees].sort(), callers: [...v.callers].sort() }]));
}

export class Registry {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }

  /**
   * Register a revision: every entity gets a canonical id. Unchanged ids keep theirs. New ids are matched against what disappeared
   * from the parent revision; supported renames inherit the canonical id, everything else gets a fresh one and, where there is a
   * plausible link, a proposal. `branch` names the line of history this revision belongs to.
   */
  registerRevision(revision: string, parent: string | null, branch = "main"): { canon: number; proposals: Proposal[] } {
    return this.store.tx(() => {
      const db = this.store.db;
      // Registering again with the same parent and branch changes nothing (and so cannot undo a person's decision); a different
      // parent or branch means the history was re-described, and identities are rebuilt for this revision.
      const was = db.prepare("select parent, branch from canon_lineage where revision = ?").get(revision) as any;
      if (was && (was.parent ?? null) === parent && was.branch === branch) return { canon: Number((db.prepare("select count(*) as n from canon_nodes where revision = ?").get(revision) as any).n), proposals: this.proposals({ revision }) };
      if (was) db.prepare("delete from canon_nodes where revision = ?").run(revision);
      db.prepare("insert or replace into canon_lineage values (?,?,?,?)").run(revision, parent, branch, new Date().toISOString());
      const entities = this.store.entities(revision).filter((e) => CODE_KINDS.has(e.kind));
      const shapes = shapeOf(this.store, revision);
      const row = (rev: string, id: string) => db.prepare("select canon_id, body_digest, shape from canon_nodes where revision = ? and entity_id = ?").get(rev, id) as any;
      const ins = db.prepare("insert or replace into canon_nodes values (?,?,?,?,?)");
      const parentIds = new Set(parent ? (db.prepare("select entity_id from canon_nodes where revision = ?").all(parent) as any[]).map((r) => r.entity_id as string) : []);
      const nowIds = new Set(entities.map((e) => e.entityId));
      const newOnly: Entity[] = [], carried: Entity[] = [];
      for (const e of entities) (parent && parentIds.has(e.entityId) ? carried : newOnly).push(e);
      const oldOnly = parent ? [...parentIds].filter((id) => !nowIds.has(id)) : [];
      const files = new Map<string, Buffer | null>();
      const digest = new Map(entities.map((e) => [e.entityId, bodyDigest(this.store, revision, e, files)]));
      for (const e of carried) { const p = row(parent!, e.entityId); ins.run(revision, e.entityId, p.canon_id, digest.get(e.entityId) ?? null, JSON.stringify(shapes.get(e.entityId) ?? { callees: [], callers: [] })); }
      const proposals: Proposal[] = [];
      const claimedNew = new Set<string>(), claimedOld = new Set<string>();
      if (parent) {
        const oldRows = oldOnly.map((id) => ({ id, ...row(parent, id) }));
        // 1. Identical body, matched one to one: a supported rename or move. Several candidates on either side: nothing is merged.
        const oldByDigest = new Map<string, typeof oldRows>(), newByDigest = new Map<string, Entity[]>();
        for (const o of oldRows) if (o.body_digest) oldByDigest.set(o.body_digest, [...(oldByDigest.get(o.body_digest) ?? []), o]);
        for (const n of newOnly) { const d = digest.get(n.entityId); if (d) newByDigest.set(d, [...(newByDigest.get(d) ?? []), n]); }
        for (const [d, olds] of oldByDigest) {
          const news = newByDigest.get(d) ?? [];
          if (!news.length) continue;
          if (olds.length === 1 && news.length === 1) {
            proposals.push(this.propose("RENAME", parent, revision, [olds[0].id], [news[0].entityId], [olds[0].canon_id], "SUPPORTED", "BODY_IDENTICAL", [`identical body digest ${d}`]));
            claimedNew.add(news[0].entityId); claimedOld.add(olds[0].id);
          } else {
            // Ambiguous: keep every candidate as an unconfirmed proposal; none is applied.
            for (const o of olds) for (const n of news) proposals.push(this.propose("RENAME", parent, revision, [o.id], [n.entityId], [o.canon_id], "PROPOSED", "BODY_IDENTICAL", [`identical body digest ${d}, but ${olds.length} old and ${news.length} new candidates`]));
          }
        }
        // 2. Same callers and callees, body edited as well: only a proposal.
        const sig = (s: { callees: string[]; callers: string[] }) => JSON.stringify([s.callees, s.callers]);
        for (const o of oldRows.filter((x) => !claimedOld.has(x.id))) {
          const os = JSON.parse(o.shape) as { callees: string[]; callers: string[] };
          if (!os.callees.length && !os.callers.length) continue;
          const cands = newOnly.filter((n) => !claimedNew.has(n.entityId) && sig(shapes.get(n.entityId) ?? { callees: [], callers: [] }) === sig(os));
          if (cands.length === 1) proposals.push(this.propose("RENAME", parent, revision, [o.id], [cands[0].entityId], [o.canon_id], "PROPOSED", "SHAPE_ONLY", ["same callers and callees; the body also changed"]));
        }
        // 3. A split: one old symbol whose callees are divided between two or more new ones.
        for (const o of oldRows.filter((x) => !claimedOld.has(x.id))) {
          const os = JSON.parse(o.shape) as { callees: string[] };
          if (os.callees.length < 2) continue;
          const parts = newOnly.filter((n) => !claimedNew.has(n.entityId)).map((n) => ({ n, c: (shapes.get(n.entityId)?.callees ?? []).filter((x) => os.callees.includes(x)) })).filter((x) => x.c.length > 0);
          const covered = new Set(parts.flatMap((p) => p.c));
          if (parts.length >= 2 && os.callees.every((c) => covered.has(c)) && parts.every((p) => p.c.length < os.callees.length))
            proposals.push(this.propose("SPLIT", parent, revision, [o.id], parts.map((p) => p.n.entityId), [o.canon_id], "PROPOSED", "PARTITION", [`callees of ${o.id.replace(/^.*#/, "")} are divided between ${parts.length} new symbols`]));
        }
        // 4. A merge: several old symbols whose callees are all found in one new symbol.
        for (const n of newOnly.filter((x) => !claimedNew.has(x.entityId))) {
          const ncal = new Set(shapes.get(n.entityId)?.callees ?? []);
          const olds = oldRows.filter((o) => !claimedOld.has(o.id)).filter((o) => { const c = (JSON.parse(o.shape) as { callees: string[] }).callees; return c.length > 0 && c.every((x) => ncal.has(x)); });
          if (olds.length >= 2) proposals.push(this.propose("MERGE", parent, revision, olds.map((o) => o.id), [n.entityId], olds.map((o) => o.canon_id), "PROPOSED", "PARTITION", [`${n.name} calls everything ${olds.map((o) => o.id.replace(/^.*#/, "")).join(" and ")} called`]));
        }
      }
      // Canonical ids: supported renames inherit; everything else new gets its own. Names alone never link anything.
      const inherit = new Map<string, string>();
      for (const p of proposals) if (p.state === "SUPPORTED" && p.kind === "RENAME") inherit.set(p.newIds[0], p.canonBefore[0]);
      for (const e of newOnly) ins.run(revision, e.entityId, inherit.get(e.entityId) ?? canonOfNew(revision, e.entityId), digest.get(e.entityId) ?? null, JSON.stringify(shapes.get(e.entityId) ?? { callees: [], callers: [] }));
      for (const p of proposals) if (p.state === "SUPPORTED" && !(db.prepare("select 1 from canon_history where proposal_id = ? and event = 'RENAMED'").get(p.id))) this.log(p.id, p.canonBefore[0], "RENAMED", { from: p.oldIds[0], to: p.newIds[0], evidence: p.evidence }, "system");
      return { canon: entities.length, proposals };
    });
  }

  private propose(kind: ProposalKind, from: string, to: string, oldIds: string[], newIds: string[], canonBefore: string[], state: ProposalState, strength: Proposal["strength"], evidence: string[]): Proposal {
    const id = "idp:" + sha([kind, from, to, ...oldIds, ...newIds].join("|"));
    this.store.db.prepare("insert or ignore into canon_proposals values (?,?,?,?,?,?,?,?,?,?,?,?)").run(id, kind, state, 1, from, to, JSON.stringify(oldIds), JSON.stringify(newIds), JSON.stringify(canonBefore), JSON.stringify(evidence), strength, new Date().toISOString());
    return { id, kind, state, version: 1, fromRevision: from, toRevision: to, oldIds, newIds, canonBefore, evidence, strength };
  }
  private log(proposalId: string | null, canonId: string, event: string, detail: unknown, actor: string) {
    this.store.db.prepare("insert into canon_history(proposal_id, canon_id, event, detail, actor, at) values (?,?,?,?,?,?)").run(proposalId, canonId, event, JSON.stringify(detail), actor, new Date().toISOString());
  }

  canonOf(revision: string, entityId: string): string | null { return (this.store.db.prepare("select canon_id from canon_nodes where revision = ? and entity_id = ?").get(revision, entityId) as any)?.canon_id ?? null; }
  /** The entity a canonical id names in a revision, if it exists there. */
  entityIn(revision: string, canonId: string): string[] { return (this.store.db.prepare("select entity_id from canon_nodes where revision = ? and canon_id = ? order by entity_id").all(revision, canonId) as any[]).map((r) => r.entity_id); }
  /** Revisions from this one back through its ancestors, nearest first. */
  ancestry(revision: string): string[] {
    const out: string[] = []; let cur: string | null = revision;
    while (cur && !out.includes(cur)) { out.push(cur); cur = (this.store.db.prepare("select parent from canon_lineage where revision = ?").get(cur) as any)?.parent ?? null; }
    return out;
  }
  /** Every name a canonical identity has had along one line of history. */
  lineage(canonId: string, revision: string): { revision: string; entityId: string }[] {
    return this.ancestry(revision).reverse().flatMap((r) => this.entityIn(r, canonId).map((entityId) => ({ revision: r, entityId })));
  }
  /** Same short name, different canonical identities: reported as aliases to look at, never merged. */
  duplicateNames(revision: string): { name: string; canon: { canonId: string; entityId: string }[] }[] {
    const by = new Map<string, { canonId: string; entityId: string }[]>();
    for (const r of this.store.db.prepare("select entity_id, canon_id from canon_nodes where revision = ?").all(revision) as any[]) {
      const short = String(r.entity_id).replace(/^.*#/, "").split(".").pop()!;
      by.set(short, [...(by.get(short) ?? []), { canonId: r.canon_id, entityId: r.entity_id }]);
    }
    return [...by].filter(([, v]) => new Set(v.map((x) => x.canonId)).size > 1).map(([name, canon]) => ({ name, canon })).sort((a, b) => a.name.localeCompare(b.name));
  }
  proposals(filter: { state?: ProposalState; revision?: string } = {}): Proposal[] {
    return (this.store.db.prepare("select * from canon_proposals order by created_at, id").all() as any[])
      .filter((r) => (!filter.state || r.state === filter.state) && (!filter.revision || r.to_revision === filter.revision))
      .map((r) => ({ id: r.id, kind: r.kind, state: r.state, version: r.version, fromRevision: r.from_revision, toRevision: r.to_revision, oldIds: JSON.parse(r.old_ids), newIds: JSON.parse(r.new_ids), canonBefore: JSON.parse(r.canon_before), evidence: JSON.parse(r.evidence), strength: r.strength }));
  }
  history(canonId: string) { return (this.store.db.prepare("select seq, proposal_id, event, detail, actor, at from canon_history where canon_id = ? order by seq").all(canonId) as any[]).map((r) => ({ ...r, detail: JSON.parse(r.detail) })); }

  /**
   * A person decides an identity proposal. CONFIRM applies it (a rename carries the canonical id over; a merge unites ids; a split
   * gives each part its own and keeps the parent as an ancestor). DISPUTE leaves things as they are, flagged. REFUTE on a confirmed
   * or supported proposal reverses it. Every step is attributed and the alias history is kept.
   */
  applyIdentityVerdict(actor: string, req: { proposalId: string; verdict: "CONFIRM" | "DISPUTE" | "REFUTE"; expectedVersion: number }): { ok: true; proposal: Proposal } | Fail {
    return this.store.tx(() => {
      const p = this.proposals().find((x) => x.id === req.proposalId);
      if (!p) return fail("NOT_FOUND", "no such identity proposal");
      if (p.version !== req.expectedVersion) return fail("VERSION_CONFLICT", `proposal is at version ${p.version}`, { currentVersion: p.version });
      const db = this.store.db;
      const set = (state: ProposalState) => db.prepare("update canon_proposals set state = ?, version = version + 1 where id = ?").run(state, p.id);
      const relink = (entityId: string, canon: string) => db.prepare("update canon_nodes set canon_id = ? where revision = ? and entity_id = ?").run(canon, p.toRevision, entityId);
      if (req.verdict === "DISPUTE") { set("DISPUTED"); this.log(p.id, p.canonBefore[0], "DISPUTED", {}, actor); }
      else if (req.verdict === "CONFIRM") {
        if (p.state === "CONFIRMED" || p.state === "SUPPORTED") return fail("INVALID_SCHEMA", `already ${p.state.toLowerCase()}`);
        if (p.kind === "RENAME") relink(p.newIds[0], p.canonBefore[0]);
        else if (p.kind === "MERGE") for (const c of p.canonBefore.slice(1)) { relink(p.newIds[0], p.canonBefore[0]); this.log(p.id, c, "MERGED_INTO", { into: p.canonBefore[0] }, actor); }
        else if (p.kind === "SPLIT") { for (const id of p.newIds) relink(id, canonOfNew(p.toRevision, id)); this.log(p.id, p.canonBefore[0], "SPLIT_INTO", { parts: p.newIds }, actor); }
        set("CONFIRMED"); this.log(p.id, p.canonBefore[0], "CONFIRMED", { kind: p.kind }, actor);
      } else {
        if (p.state !== "CONFIRMED" && p.state !== "SUPPORTED" && p.state !== "PROPOSED" && p.state !== "DISPUTED") return fail("INVALID_SCHEMA", `cannot refute a ${p.state.toLowerCase()} proposal`);
        // Reversal: give the new entities back identities of their own; the old canonical id keeps its history up to here.
        for (const id of p.newIds) if (p.canonBefore.includes(this.canonOf(p.toRevision, id) ?? "")) relink(id, canonOfNew(p.toRevision, id)); // only what is actually linked
        set("REVERSED"); this.log(p.id, p.canonBefore[0], "REVERSED", { was: p.state }, actor);
      }
      return { ok: true as const, proposal: this.proposals().find((x) => x.id === p.id)! };
    });
  }

  /**
   * Two revisions on different branches: what each side changed relative to the merge base, by canonical identity, and where the
   * same identity was changed differently on both. Neither side's identities are rewritten by the other.
   */
  diverge(a: string, b: string): { base: string | null; onlyA: string[]; onlyB: string[]; conflicts: { canonId: string; a: string; b: string }[]; aBranch: string; bBranch: string } {
    const ancA = this.ancestry(a), ancB = new Set(this.ancestry(b));
    const base = ancA.find((r) => ancB.has(r)) ?? null;
    const idsOf = (rev: string) => new Map((this.store.db.prepare("select entity_id, canon_id from canon_nodes where revision = ?").all(rev) as any[]).map((r) => [r.canon_id as string, r.entity_id as string]));
    const A = idsOf(a), B = idsOf(b), base0 = base ? idsOf(base) : new Map<string, string>();
    const changed = (side: Map<string, string>) => new Set([...new Set([...side.keys(), ...base0.keys()])].filter((c) => side.get(c) !== base0.get(c)));
    const cA = changed(A), cB = changed(B);
    const conflicts = [...cA].filter((c) => cB.has(c) && A.get(c) !== B.get(c) && A.has(c) && B.has(c)).map((c) => ({ canonId: c, a: A.get(c)!, b: B.get(c)! }));
    const br = (r: string) => (this.store.db.prepare("select branch from canon_lineage where revision = ?").get(r) as any)?.branch ?? "?";
    return { base, onlyA: [...cA].filter((c) => !cB.has(c)).sort(), onlyB: [...cB].filter((c) => !cA.has(c)).sort(), conflicts, aBranch: br(a), bBranch: br(b) };
  }
}
