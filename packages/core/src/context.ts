// C12: the developer-context stream, memory tiers, retention, and persona lenses.
// Events are ordered per session (a gap or a repeat is rejected, not guessed at), sensitive text is minimised before it is stored,
// and a snapshot at any sequence is rebuilt from the stored events alone. Lenses change weights; they never hide safety facts.
import { createHash } from "node:crypto";
import type { ApiError, ViewNode } from "@cie/schema";
import { detectSecret } from "./policy.ts";
import type { Weights } from "./salience.ts";
import { WEIGHTS } from "./salience.ts";
import type { Store } from "./store.ts";

export type ContextEvent =
  | { kind: "FOCUS"; entityId: string }
  | { kind: "SELECT"; entityIds: string[] }
  | { kind: "QUERY"; text: string }
  | { kind: "PASTE"; text: string }
  | { kind: "EDIT"; file: string }
  | { kind: "LENS"; lensId: string }
  /** Context writes of the interaction catalogue (I-01…I-20): what the person did, in a closed vocabulary. */
  | { kind: "ACTION"; action: ActionName; ids?: string[]; value?: string | number };
export type ActionName = "TASK" | "REFERENT" | "ZOOM" | "FILTER" | "TIME" | "PIN" | "ABSTRACTION" | "TRUST" | "RUNTIME" | "SALIENCE_FEEDBACK" | "INTENT" | "NOTE" | "RECENT" | "INCIDENT";

/** Memory tiers: working = recent, episodic = older but kept for a while, semantic = counts that outlive the raw events. */
export interface RetentionPolicy { workingEvents: number; episodicMaxAgeMs: number; maxPayloadChars: number }
export const DEFAULT_RETENTION: RetentionPolicy = { workingEvents: 50, episodicMaxAgeMs: 7 * 86_400_000, maxPayloadChars: 400 };

export interface ContextSnapshot {
  session: string; sequence: number; lens: string;
  focus: string | null; selection: string[]; edited: string[];
  recentQueries: string[];
  /** Entities by how often they were the focus: semantic memory, kept after the raw events are pruned. */
  frequent: Record<string, number>;
  /** Raw payloads dropped or minimised, so a reader knows what the snapshot no longer contains. */
  minimised: number; pruned: number;
  taskFrame: string | null; referent: string[]; zoomLevel: number | null; filters: string[]; timeWindow: string | null; pins: string[];
  abstraction: Record<string, string>; actions: string[]; recent: string[];
}

type Fail = { ok: false; error: ApiError };
const fail = (code: ApiError["code"], message: string): Fail => ({ ok: false, error: { code, message, retryable: false } });

export function getPolicy(store: Store): { version: number; policy: RetentionPolicy } {
  const r = store.db.prepare("select version, json from context_policy where id = 1").get() as any;
  return r ? { version: r.version, policy: JSON.parse(r.json) } : { version: 0, policy: DEFAULT_RETENTION };
}
export function setMemoryPolicy(store: Store, req: { policy: RetentionPolicy; expectedVersion: number }): { ok: true; version: number } | Fail {
  const p = req.policy;
  if (!(p.workingEvents >= 1 && p.episodicMaxAgeMs >= 0 && p.maxPayloadChars >= 0)) return fail("INVALID_SCHEMA", "retention needs workingEvents ≥ 1 and non-negative ages and sizes");
  const cur = getPolicy(store);
  if (cur.version !== req.expectedVersion) return fail("VERSION_CONFLICT", `policy is at version ${cur.version}`);
  store.db.prepare("insert into context_policy values (1,?,?) on conflict(id) do update set version = excluded.version, json = excluded.json").run(cur.version + 1, JSON.stringify(p));
  return { ok: true, version: cur.version + 1 };
}

const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Raw sensitive context is minimised: a pasted secret is never stored, and long text is cut. */
function filterSensitive(e: ContextEvent, maxChars: number): { payload: ContextEvent; minimised: boolean } {
  if (e.kind !== "QUERY" && e.kind !== "PASTE") return { payload: e, minimised: false };
  if (detectSecret(e.text) || /(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+/i.test(e.text) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(e.text)) return { payload: { ...e, text: "[withheld: looks like a secret]" }, minimised: true };
  if (e.text.length > maxChars) return { payload: { ...e, text: e.text.slice(0, maxChars) }, minimised: true };
  return { payload: e, minimised: false };
}

export function currentSequence(store: Store, session: string): number {
  return Number((store.db.prepare("select coalesce(max(seq),0) as n from ctx_events where session = ?").get(session) as any).n);
}

export function applyContextEvent(store: Store, session: string, req: { event: ContextEvent; expectedSequence: number }, now: () => string = () => new Date().toISOString()): { ok: true; snapshot: ContextSnapshot } | Fail {
  return store.tx(() => {
    const cur = currentSequence(store, session);
    if (req.expectedSequence !== cur) return fail("VERSION_CONFLICT", `session is at sequence ${cur}, not ${req.expectedSequence}: the event is stale or out of order`);
    if (req.event.kind === "LENS" && !(req.event.lensId in LENSES)) return fail("INVALID_SCHEMA", `unknown lens ${req.event.lensId}`);
    const { policy } = getPolicy(store);
    const { payload, minimised } = filterSensitive(req.event, policy.maxPayloadChars);
    const at = now();
    store.db.prepare("insert into ctx_events values (?,?,?,?,?,?,?)").run(session, cur + 1, req.event.kind, "WORKING", JSON.stringify(payload), digest(JSON.stringify(req.event)), at);
    if (minimised) store.db.prepare("update ctx_events set tier = 'WORKING-MINIMISED' where session = ? and seq = ?").run(session, cur + 1);
    applyMemoryTierPolicy(store, session, policy, Date.parse(at));
    return { ok: true as const, snapshot: snapshotAt(store, session, cur + 1) };
  });
}

/**
 * Working memory keeps the last N events in full. Older events move to episodic memory (kept, but payload text dropped for
 * queries and pastes), and past the episodic age limit the payload goes entirely while a digest and kind remain, so the sequence
 * stays gap-free and the semantic counts survive.
 */
export function applyMemoryTierPolicy(store: Store, session: string, policy: RetentionPolicy, nowMs: number) {
  const cur = currentSequence(store, session);
  const cutoff = cur - policy.workingEvents;
  if (cutoff > 0) store.db.prepare("update ctx_events set tier = 'EPISODIC', payload = case when kind in ('QUERY','PASTE') then json_set(payload, '$.text', '[episodic: text dropped]') else payload end where session = ? and seq <= ? and tier like 'WORKING%'").run(session, cutoff);
  const old = new Date(nowMs - policy.episodicMaxAgeMs).toISOString();
  store.db.prepare("update ctx_events set tier = 'EXPIRED', payload = null where session = ? and tier = 'EPISODIC' and at < ?").run(session, old);
}

/** Rebuild the context at a sequence number from stored events. Deterministic: same events, same snapshot. */
export function snapshotAt(store: Store, session: string, sequence: number): ContextSnapshot {
  const rows = store.db.prepare("select seq, kind, tier, payload from ctx_events where session = ? and seq <= ? order by seq").all(session, sequence) as any[];
  const s: ContextSnapshot = { session, sequence: Math.min(sequence, rows.at(-1)?.seq ?? 0), lens: "default", focus: null, selection: [], edited: [], recentQueries: [], frequent: {}, minimised: 0, pruned: 0, taskFrame: null, referent: [], zoomLevel: null, filters: [], timeWindow: null, pins: [], abstraction: {}, actions: [], recent: [] };
  for (const r of rows) {
    if (r.tier === "WORKING-MINIMISED") s.minimised++;
    if (r.tier === "EXPIRED") s.pruned++;
    const e: ContextEvent | null = r.payload ? JSON.parse(r.payload) : null;
    if (!e) continue;
    if (e.kind === "FOCUS") { s.focus = e.entityId; s.frequent[e.entityId] = (s.frequent[e.entityId] ?? 0) + 1; }
    else if (e.kind === "SELECT") s.selection = e.entityIds;
    else if (e.kind === "QUERY") s.recentQueries = [...s.recentQueries, e.text].slice(-5);
    else if (e.kind === "EDIT") s.edited = [...new Set([...s.edited, e.file])];
    else if (e.kind === "LENS") s.lens = e.lensId;
    else if (e.kind === "ACTION") {
      s.actions = [...s.actions, e.action].slice(-20);
      const ids = e.ids ?? [];
      switch (e.action) {
        case "TASK": s.taskFrame = String(e.value ?? ""); break;
        case "REFERENT": s.referent = ids; break;
        case "ZOOM": s.zoomLevel = Number(e.value); break;
        case "FILTER": s.filters = [...s.filters, String(e.value ?? "")].slice(-5); break;
        case "TIME": s.timeWindow = String(e.value ?? ""); break;
        case "PIN": s.pins = e.value === "unpin" ? s.pins.filter((p) => !ids.includes(p)) : [...new Set([...s.pins, ...ids])]; break;
        case "ABSTRACTION": for (const id of ids) s.abstraction[id] = String(e.value); break;
        case "RECENT": s.recent = [...new Set([...ids, ...s.recent])].slice(0, 10); break;
        default: break;
      }
    }
  }
  return s;
}

export function sessionSnapshot(store: Store, session: string): ContextSnapshot { return snapshotAt(store, session, currentSequence(store, session)); }

// ---- persona lenses ----
export interface Lens { id: string; weights: Weights; description: string }
const w = (over: Partial<Weights>): Weights => ({ ...WEIGHTS.map, ...over });
export const LENSES: Record<string, Lens> = {
  default: { id: "default", weights: WEIGHTS.map, description: "balanced" },
  newcomer: { id: "newcomer", weights: w({ STRUCTURAL_CENTRALITY: 0.35, RECENCY: 0.02, SEMANTIC_JUDGMENT: 0.3 }), description: "the structurally central parts first" },
  reviewer: { id: "reviewer", weights: w({ RECENCY: 0.35, STRUCTURAL_CENTRALITY: 0.1 }), description: "what changed recently first" },
  oncall: { id: "oncall", weights: w({ RUNTIME_HOTNESS: 0.45, TASK_MATCH: 0.3, RECENCY: 0.15 }), description: "what is failing first" },
};

const ORDER: ViewNode["tier"][] = ["HIDDEN", "CONTEXT", "RELEVANT", "CRITICAL"];
/**
 * A persona may re-weight and reorder, but important safety facts cannot be hidden by one: code that a failing test, a reported
 * exception or a pasted stack points at, and anything pinned, keeps at least RELEVANT whatever the lens thinks of it.
 */
export function protectedTier(tier: ViewNode["tier"], factors: { factor: string; normalizedScore: number }[]): { tier: ViewNode["tier"]; protectedBy: string | null } {
  const hot = factors.find((f) => f.factor === "RUNTIME_HOTNESS")?.normalizedScore ?? 0;
  const pinned = (factors.find((f) => f.factor === "USER_OVERRIDE")?.normalizedScore ?? 0) >= 1;
  const floor: ViewNode["tier"] | null = pinned ? "CRITICAL" : hot >= 0.5 ? "RELEVANT" : null;
  if (floor && ORDER.indexOf(tier) < ORDER.indexOf(floor)) return { tier: floor, protectedBy: pinned ? "pinned by you" : "failing test, exception or stack frame points here" };
  return { tier, protectedBy: null };
}
