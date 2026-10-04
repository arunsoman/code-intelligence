// C13: an investigation as an append-only event log. State is a reduction of the events, so resume restores what the person
// believed (claims, hypotheses, pins, notes, the view) and not only where nodes were drawn. Undo and redo are events too: they are
// attributed, replayable, and cannot be confused with a concurrent edit. A checkpoint is a cache of the reduction, never the truth.
import { randomUUID } from "node:crypto";
import type { ApiError, ViewSpec } from "@cie/schema";
import type { Store } from "./store.ts";

export type WorkspaceEvent =
  | { kind: "SET_VIEW"; view: ViewSpec | null }
  | { kind: "SELECT"; ids: string[] }
  | { kind: "PIN"; entityId: string; on: boolean }
  | { kind: "NOTE"; entityId: string; text: string }
  | { kind: "HYPOTHESIS"; id: string; text: string; state: "OPEN" | "SUPPORTED" | "REFUTED" | "UNRESOLVED" }
  | { kind: "CLAIMS"; ids: string[] }
  | { kind: "UNDO" } | { kind: "REDO" }
  | { kind: "STALE"; evidenceIds: string[]; reason: string };

export interface WorkspaceState {
  name: string; revision: string | null; view: ViewSpec | null; selection: string[]; pins: string[]; notes: Record<string, string>;
  hypotheses: Record<string, { text: string; state: string }>; claimIds: string[]; staleEvidence: string[];
}
export interface ResumedWorkspace {
  id: string; version: number; atSequence: number; state: WorkspaceState;
  /** Evidence ids the workspace cites that are no longer current, with why. */
  anchors: { stale: string[]; unavailable: string[] };
  claims: { id: string; state: string; displayMode: string; stale: boolean }[];
  sourceAvailable: boolean; warnings: string[]; fromCheckpoint: number;
}
type Fail = { ok: false; error: ApiError };
const fail = (code: ApiError["code"], message: string, extra: Partial<ApiError> = {}): Fail => ({ ok: false, error: { code, message, retryable: false, ...extra } });

/** Events that undo/redo can reverse. Control and system events are not on the stack. */
const MATERIAL = new Set(["SET_VIEW", "PIN", "NOTE", "HYPOTHESIS", "CLAIMS"]);
/** The thing an event is about: two events with different keys do not conflict. */
export function keyOf(e: WorkspaceEvent): string {
  switch (e.kind) {
    case "SET_VIEW": return "view"; case "SELECT": return "selection"; case "PIN": return `pin:${e.entityId}`; case "NOTE": return `note:${e.entityId}`;
    case "HYPOTHESIS": return `hyp:${e.id}`; case "CLAIMS": return "claims"; case "STALE": return "stale"; default: return "control";
  }
}
const empty = (name: string, revision: string | null): WorkspaceState => ({ name, revision, view: null, selection: [], pins: [], notes: {}, hypotheses: {}, claimIds: [], staleEvidence: [] });

function applyOne(s: WorkspaceState, e: WorkspaceEvent) {
  switch (e.kind) {
    case "SET_VIEW": s.view = e.view; break;
    case "SELECT": s.selection = e.ids; break;
    case "PIN": s.pins = e.on ? [...new Set([...s.pins, e.entityId])] : s.pins.filter((p) => p !== e.entityId); break;
    case "NOTE": if (e.text) s.notes[e.entityId] = e.text; else delete s.notes[e.entityId]; break;
    case "HYPOTHESIS": s.hypotheses[e.id] = { text: e.text, state: e.state }; break;
    case "CLAIMS": s.claimIds = [...new Set([...s.claimIds, ...e.ids])]; break;
    case "STALE": s.staleEvidence = [...new Set([...s.staleEvidence, ...e.evidenceIds])]; break;
    default: break;
  }
}

/** Reduce events to a state. The undo stack is derived from the events themselves, so replaying any prefix gives that moment's state. */
export function reduce(name: string, revision: string | null, events: { seq: number; event: WorkspaceEvent }[]): WorkspaceState {
  const done: { seq: number; event: WorkspaceEvent }[] = []; // material events currently in effect, in order
  const undone: { seq: number; event: WorkspaceEvent }[] = [];
  const system: WorkspaceEvent[] = [];
  for (const { seq, event } of events) {
    if (event.kind === "UNDO") { const x = done.pop(); if (x) undone.push(x); }
    else if (event.kind === "REDO") { const x = undone.pop(); if (x) done.push(x); }
    else if (event.kind === "STALE" || event.kind === "SELECT") system.push(event); // ambient: not on the undo stack
    else if (MATERIAL.has(event.kind)) { done.push({ seq, event }); undone.length = 0; }
  }
  const s = empty(name, revision);
  for (const x of done) applyOne(s, x.event);
  for (const x of system) applyOne(s, x);
  return s;
}

export interface WorkspaceOptions {
  now?: () => number;
  /** Longest time ephemeral events (selections) may sit unflushed. Material events always commit at once. */
  maxLossMs?: number;
  /** Is this evidence still what it was? Supplied by the service, which can read the source. */
  evidenceState?: (revision: string, evidenceId: string) => "CURRENT" | "STALE" | "UNAVAILABLE";
  sourceAvailable?: (revision: string) => boolean;
  allowed?: (revision: string | null) => boolean;
}
export const CHECKPOINT_BOUND_MS = 5000;
const CHECKPOINT_EVERY = 25;

export class WorkspaceLog {
  private buffer = new Map<string, { event: WorkspaceEvent; actor: string; at: string }[]>();
  private timers = new Map<string, NodeJS.Timeout>();
  readonly store: Store;
  private o: Required<Pick<WorkspaceOptions, "now" | "maxLossMs">> & WorkspaceOptions;
  constructor(store: Store, o: WorkspaceOptions = {}) { this.store = store; this.o = { now: Date.now, maxLossMs: 2000, ...o }; }

  private version(ws: string): number { return Number((this.store.db.prepare("select coalesce(max(seq),0) as n from ws_events where ws = ?").get(ws) as any).n); }
  private meta(ws: string) { return this.store.db.prepare("select * from ws_meta where ws = ?").get(ws) as any; }

  create(actor: string, req: { name: string; revision: string | null; id?: string }): { ok: true; id: string; version: number } | Fail {
    const name = req.name.trim();
    if (!name || name.length > 120) return fail("INVALID_SCHEMA", "name must be 1–120 characters");
    const id = req.id ?? `ws:${randomUUID()}`;
    if (this.meta(id)) return fail("VERSION_CONFLICT", "a workspace with that id exists");
    this.store.db.prepare("insert into ws_meta values (?,?,?,?)").run(id, name, req.revision, new Date(this.o.now()).toISOString());
    void actor;
    return { ok: true, id, version: 0 };
  }

  /**
   * Append at an expected version. A stale version is a conflict that carries what happened since; with `rebase` the event is
   * applied after them when none of them touched the same thing, and refused when one did.
   */
  append(actor: string, req: { workspaceId: string; event: WorkspaceEvent; expectedVersion: number; rebase?: boolean; ephemeral?: boolean }): { ok: true; version: number; rebased: boolean } | (Fail & { since?: { seq: number; kind: string; key: string; actor: string }[] }) {
    const ws = req.workspaceId;
    if (!this.meta(ws)) return fail("NOT_FOUND", "no such workspace");
    if (this.o.allowed && !this.o.allowed(this.meta(ws).revision)) return fail("FORBIDDEN", "access to the source this workspace was made against was withdrawn");
    this.flush(ws);
    return this.store.tx(() => {
      const cur = this.version(ws);
      let rebased = false;
      if (req.expectedVersion !== cur) {
        const since = (this.store.db.prepare("select seq, kind, key, actor from ws_events where ws = ? and seq > ? order by seq").all(ws, req.expectedVersion) as any[]);
        const key = keyOf(req.event);
        const clash = since.filter((x) => x.key === key || (x.kind === "UNDO" || x.kind === "REDO") || key === "control");
        if (!req.rebase || clash.length) return { ...fail("VERSION_CONFLICT", clash.length && req.rebase ? `someone else changed the same thing (${clash[0].kind} ${clash[0].key}) since version ${req.expectedVersion}` : `workspace is at version ${cur}`, { currentVersion: cur }), since };
        rebased = true;
      }
      if (req.event.kind === "UNDO" || req.event.kind === "REDO") {
        const st = this.stack(ws);
        if (req.event.kind === "UNDO" && st.done === 0) return fail("INVALID_SCHEMA", "nothing to undo");
        if (req.event.kind === "REDO" && st.undone === 0) return fail("INVALID_SCHEMA", "nothing to redo");
      }
      const seq = cur + 1;
      const at = new Date(this.o.now()).toISOString();
      this.store.db.prepare("insert into ws_events values (?,?,?,?,?,?,?)").run(ws, seq, req.event.kind, keyOf(req.event), JSON.stringify(req.event), actor, at);
      if (seq % CHECKPOINT_EVERY === 0) this.checkpoint(ws);
      return { ok: true as const, version: seq, rebased };
    });
  }

  /**
   * Ephemeral events (selection changes, many per second) are buffered and written at most `maxLossMs` later, or earlier when
   * a material event arrives. A crash can therefore cost at most that much of them; it can never cost a material event.
   */
  appendEphemeral(actor: string, ws: string, event: WorkspaceEvent) {
    const b = this.buffer.get(ws) ?? []; b.push({ event, actor, at: new Date(this.o.now()).toISOString() }); this.buffer.set(ws, b);
    if (!this.timers.has(ws)) { const t = setTimeout(() => this.flush(ws), this.o.maxLossMs); t.unref(); this.timers.set(ws, t); }
  }
  flush(ws: string) {
    const t = this.timers.get(ws); if (t) clearTimeout(t); this.timers.delete(ws);
    const b = this.buffer.get(ws); this.buffer.delete(ws);
    if (!b?.length) return;
    this.store.tx(() => { let seq = this.version(ws); for (const x of b) this.store.db.prepare("insert into ws_events values (?,?,?,?,?,?,?)").run(ws, ++seq, x.event.kind, keyOf(x.event), JSON.stringify(x.event), x.actor, x.at); });
  }

  private events(ws: string, from = 0, to = Infinity) {
    return (this.store.db.prepare("select seq, json from ws_events where ws = ? and seq > ? and seq <= ? order by seq").all(ws, from, Number.isFinite(to) ? to : 2 ** 53) as any[]).map((r) => ({ seq: r.seq as number, event: JSON.parse(r.json) as WorkspaceEvent }));
  }
  private stack(ws: string) {
    let done = 0, undone = 0;
    for (const { event } of this.events(ws)) { if (event.kind === "UNDO") { done--; undone++; } else if (event.kind === "REDO") { undone--; done++; } else if (MATERIAL.has(event.kind)) { done++; undone = 0; } }
    return { done, undone };
  }

  /** Persist the reduction at the current version. Reads never need it; it only shortens replay. */
  checkpoint(ws: string): { ok: true; version: number; at: string } | Fail {
    const m = this.meta(ws); if (!m) return fail("NOT_FOUND", "no such workspace");
    this.flush(ws);
    const version = this.version(ws);
    const at = new Date(this.o.now()).toISOString();
    this.store.db.prepare("insert or replace into ws_checkpoints values (?,?,?,?)").run(ws, version, JSON.stringify(reduce(m.name, m.revision, this.events(ws))), at);
    return { ok: true, version, at };
  }

  resume(ws: string, atSequence?: number): { ok: true; workspace: ResumedWorkspace } | Fail {
    const m = this.meta(ws); if (!m) return fail("NOT_FOUND", "no such workspace");
    if (this.o.allowed && !this.o.allowed(m.revision)) return fail("FORBIDDEN", "access to the source this workspace was made against was withdrawn");
    this.flush(ws);
    const version = this.version(ws);
    const at = Math.min(atSequence ?? version, version);
    // Replay always starts from the events (the undo stack depends on all of them); a checkpoint only proves the log is intact.
    const state = reduce(m.name, m.revision, this.events(ws, 0, at));
    const cp = this.store.db.prepare("select seq from ws_checkpoints where ws = ? and seq <= ? order by seq desc limit 1").get(ws, at) as any;
    const warnings: string[] = [];
    const sourceAvailable = m.revision ? (this.o.sourceAvailable ? this.o.sourceAvailable(m.revision) : true) : true;
    if (!sourceAvailable) warnings.push("The source this investigation was made against is not available here. Your view, notes and hypotheses are restored; evidence cannot be re-checked.");
    const ids = new Set<string>();
    for (const n of state.view?.nodes ?? []) n.evidenceIds.forEach((i) => ids.add(i));
    for (const e of state.view?.edges ?? []) e.evidenceIds.forEach((i) => ids.add(i));
    const claims = state.claimIds.map((id) => this.store.getClaim(id));
    for (const c of claims) c?.draft.evidenceIds.forEach((i) => ids.add(i));
    const stale: string[] = [], unavailable: string[] = [];
    for (const id of ids) {
      if (!m.revision || !sourceAvailable) { unavailable.push(id); continue; }
      const st = this.o.evidenceState ? this.o.evidenceState(m.revision, id) : "CURRENT";
      if (st === "STALE") stale.push(id); else if (st === "UNAVAILABLE") unavailable.push(id);
    }
    for (const id of state.staleEvidence) if (!stale.includes(id)) stale.push(id);
    if (stale.length) warnings.push(`${stale.length} piece(s) of evidence changed since this was saved; those parts are marked stale, not hidden.`);
    const staleSet = new Set([...stale, ...unavailable]);
    return {
      ok: true,
      workspace: {
        id: ws, version, atSequence: at, state, anchors: { stale: stale.sort(), unavailable: unavailable.sort() }, sourceAvailable, warnings, fromCheckpoint: cp?.seq ?? 0,
        claims: state.claimIds.map((id, i) => { const c = claims[i]; return { id, state: c?.state ?? "UNKNOWN", displayMode: c?.displayMode ?? "HIDDEN", stale: !c || c.state === "STALE" || c.state === "REFUTED" || c.draft.evidenceIds.some((e) => staleSet.has(e)) }; }),
      },
    };
  }

  /** A change elsewhere (a file edit, a refuted claim) marks every workspace that depended on it; nothing is deleted. */
  annotateStaleness(actor: string, impact: { evidenceIds: string[]; reason: string }): { affected: string[] } {
    const affected: string[] = [];
    for (const m of this.store.db.prepare("select ws from ws_meta").all() as any[]) {
      const r = this.resume(m.ws);
      if (!r.ok) continue;
      const cited = new Set<string>();
      for (const n of r.workspace.state.view?.nodes ?? []) n.evidenceIds.forEach((i) => cited.add(i));
      for (const e of r.workspace.state.view?.edges ?? []) e.evidenceIds.forEach((i) => cited.add(i));
      for (const id of r.workspace.state.claimIds) this.store.getClaim(id)?.draft.evidenceIds.forEach((i) => cited.add(i));
      const hit = impact.evidenceIds.filter((i) => cited.has(i));
      if (!hit.length) continue;
      this.store.db.prepare("insert into ws_events values (?,?,?,?,?,?,?)").run(m.ws, this.version(m.ws) + 1, "STALE", "stale", JSON.stringify({ kind: "STALE", evidenceIds: hit, reason: impact.reason }), actor, new Date(this.o.now()).toISOString());
      affected.push(m.ws);
    }
    return { affected };
  }

  /** Past investigations about the same code, newest first, limited to what the caller may see. */
  resurface(refs: string[], limit = 5): { id: string; name: string; version: number; overlap: string[] }[] {
    const out: { id: string; name: string; version: number; overlap: string[]; at: string }[] = [];
    for (const m of this.store.db.prepare("select * from ws_meta").all() as any[]) {
      if (this.o.allowed && !this.o.allowed(m.revision)) continue;
      const r = this.resume(m.ws);
      if (!r.ok) continue;
      const s = r.workspace.state;
      const mentioned = new Set<string>([...s.pins, ...Object.keys(s.notes), ...s.selection, ...(s.view?.nodes.flatMap((n) => n.entityRefs) ?? [])]);
      const overlap = refs.filter((x) => mentioned.has(x));
      if (overlap.length) out.push({ id: m.ws, name: m.name, version: r.workspace.version, overlap, at: (this.store.db.prepare("select max(at) as a from ws_events where ws = ?").get(m.ws) as any).a ?? m.created_at });
    }
    return out.sort((a, b) => b.overlap.length - a.overlap.length || b.at.localeCompare(a.at)).slice(0, limit).map(({ at, ...x }) => (void at, x));
  }
}
