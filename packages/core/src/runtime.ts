// C24: runtime signals joined to code without pretending. Raw volume stays in the telemetry backend: what is kept here is a bounded
// sample of spans per envelope, a handle to the backend, and the join. A join is only called exact when the revision the signal
// ran on, a deployment marker and a code location all agree; a name match, a revision mismatch or a missing marker is stated as such,
// and traffic that cannot be tied to code is fog, not a guess.
import { createHash } from "node:crypto";
import type { ApiError, Entity } from "@cie/schema";
import { applyContextEvent, currentSequence, sessionSnapshot, type ContextSnapshot } from "./context.ts";
import { observation } from "./forms/common.ts";
import { Registry } from "./registry.ts";
import type { Store } from "./store.ts";
import { locateFrames } from "./trace.ts";

export interface RtSpan { traceId: string; spanId: string; parentId?: string; name: string; startMs: number; endMs: number; error?: boolean; file?: string; line?: number; fn?: string }
export interface RuntimeEnvelope { id: string; sourceId: string; deploymentId?: string; codeRevision?: string; window: { from: number; to: number }; backendHandle: string; signalKind: "trace" | "log" | "metric" | "test"; samplingRate?: number; spans: RtSpan[] }
export interface RuntimeAttribution {
  id: string; runtimeId: string; entityRefs: string[]; evidenceIds: string[];
  method: "CODE_LOCATION_EXACT" | "CODE_LOCATION_OTHER_REVISION" | "FUNCTION_NAME" | "UNATTRIBUTED";
  exact: boolean; uncertaintyReason: string | null;
  perEntity: { entityId: string; spans: number; errors: number; estimatedSpans: number | null; p95Ms: number | null; exact: boolean; method: string }[];
  fog: { spans: number; reasons: string[] }; quality: string[]; samplingRate: number | null; counted: { valid: number; invalid: number; late: number };
}
type Fail = { ok: false; error: ApiError };

export const LIMITS = { maxSpansPerEnvelope: 5000, maxStoredSpansPerSource: 20_000, skewMs: 5 * 60_000, lateMs: 10 * 60_000 };
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const pctile = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null; };

export class Runtime {
  readonly store: Store;
  readonly registry: Registry;
  private now: () => number;
  constructor(store: Store, registry = new Registry(store), now: () => number = Date.now) { this.store = store; this.registry = registry; this.now = now; }

  /** Record that a deployment of a source runs a revision from a time on. This is the authoritative join for exact attribution. */
  recordMarker(m: { sourceId: string; deploymentId: string; revision: string; at: number }) {
    this.store.db.prepare("insert or replace into rt_markers values (?,?,?,?)").run(m.sourceId, m.deploymentId, m.revision, m.at);
  }

  /** Flags per span: impossible timestamps are kept out of every statistic and counted. */
  private flagsOf(s: RtSpan, env: RuntimeEnvelope, maxStart: number): string[] {
    const f: string[] = [];
    const t = this.now();
    if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs) || s.startMs < 0 || s.endMs < s.startMs) f.push("TIMESTAMP_IMPOSSIBLE");
    else if (s.startMs > t + LIMITS.skewMs || s.endMs > t + LIMITS.skewMs) f.push("TIMESTAMP_IMPOSSIBLE");
    else if (s.startMs < env.window.from - LIMITS.lateMs || s.endMs > env.window.to + LIMITS.lateMs) f.push("OUTSIDE_WINDOW");
    if (s.startMs < maxStart) f.push("OUT_OF_ORDER");
    return f;
  }

  ingest(env: RuntimeEnvelope): { ok: true; replayed: boolean; accepted: number; quality: string[] } | Fail {
    const db = this.store.db;
    if (!env.id || !env.sourceId || !env.backendHandle) return { ok: false, error: { code: "INVALID_SCHEMA", message: "an envelope needs an id, a source and a backend handle", retryable: false } };
    if (env.spans.length > LIMITS.maxSpansPerEnvelope) return { ok: false, error: { code: "RESOURCE_LIMIT", message: `at most ${LIMITS.maxSpansPerEnvelope} spans per envelope; send the rest as another envelope, the raw volume stays in your telemetry backend`, retryable: true } };
    const digest = sha(JSON.stringify(env));
    const prior = db.prepare("select digest, quality, span_count from rt_envelopes where id = ?").get(env.id) as any;
    if (prior) return prior.digest === digest ? { ok: true, replayed: true, accepted: prior.span_count, quality: JSON.parse(prior.quality) } : { ok: false, error: { code: "VERSION_CONFLICT", message: "an envelope with this id and different content was already ingested", retryable: false } };
    // Backpressure: a bounded store per source. A full one says so and when to come back; it never drops silently.
    const held = Number((db.prepare("select coalesce(sum(span_count),0) as n from rt_envelopes where source = ? and rejected = 0").get(env.sourceId) as any).n);
    if (held + env.spans.length > LIMITS.maxStoredSpansPerSource) return { ok: false, error: { code: "RESOURCE_LIMIT", message: `this source already holds ${held} spans (limit ${LIMITS.maxStoredSpansPerSource}); retry after older envelopes are compacted or send fewer`, retryable: true } };
    return this.store.tx(() => {
      const quality: string[] = [];
      let maxStart = -Infinity, ooo = 0, bad = 0, late = 0, accepted = 0;
      const ins = db.prepare("insert or ignore into rt_spans values (?,?,?,?,?,?,?,?,?,?,?,?,?)");
      env.spans.forEach((s, seq) => {
        const flags = this.flagsOf(s, env, maxStart);
        if (Number.isFinite(s.startMs)) maxStart = Math.max(maxStart, s.startMs);
        if (flags.includes("OUT_OF_ORDER")) ooo++;
        if (flags.includes("TIMESTAMP_IMPOSSIBLE")) bad++;
        if (flags.includes("OUTSIDE_WINDOW")) late++;
        ins.run(env.id, seq, s.traceId, s.spanId, s.parentId ?? null, s.name, Math.trunc(s.startMs) || 0, Math.trunc(s.endMs) || 0, s.error ? 1 : 0, s.file ?? null, s.line ?? null, s.fn ?? null, flags.join(","));
        accepted++;
      });
      if (bad) quality.push(`TIMESTAMP_IMPOSSIBLE:${bad}`);
      if (ooo) quality.push(`OUT_OF_ORDER:${ooo}`);
      if (late) quality.push(`OUTSIDE_WINDOW:${late}`);
      if (env.samplingRate !== undefined && env.samplingRate < 1) quality.push(`SAMPLED:${env.samplingRate}`);
      const marker = env.deploymentId ? db.prepare("select revision from rt_markers where source = ? and deployment = ?").get(env.sourceId, env.deploymentId) as any : null;
      if (!env.deploymentId || !marker) quality.push("NO_DEPLOYMENT_MARKER");
      if (!env.codeRevision && !marker) quality.push("NO_REVISION");
      // Parents that did not arrive yet (they may come in a later envelope for the same trace).
      const ids = new Set(env.spans.map((s) => s.spanId));
      const orphan = env.spans.filter((s) => s.parentId && !ids.has(s.parentId) && !db.prepare("select 1 from rt_spans where trace_id = ? and span_id = ?").get(s.traceId, s.parentId)).length;
      if (orphan) quality.push(`PARENT_MISSING:${orphan}`);
      db.prepare("insert into rt_envelopes values (?,?,?,?,?,?,?,?,?,?,?,?,0)").run(env.id, env.sourceId, env.deploymentId ?? null, env.codeRevision ?? null, env.window.from, env.window.to, env.backendHandle, env.signalKind, JSON.stringify(quality), digest, this.now(), accepted);
      return { ok: true as const, replayed: false, accepted, quality };
    });
  }

  private envelope(id: string) { return this.store.db.prepare("select * from rt_envelopes where id = ?").get(id) as any; }

  /**
   * Join an ingested envelope to a revision's code. The result says how sure it is: exact only when the envelope ran this
   * revision (by its own field or a deployment marker), and the span carries a code location inside the entity. Anything else is
   * labelled with why, and what cannot be tied to code is counted as fog.
   */
  attribute(envelopeId: string, revisionId: string, opts: { cursorMs?: number; fromMs?: number } = {}): RuntimeAttribution | Fail {
    const env = this.envelope(envelopeId);
    const rev = this.store.revision(revisionId);
    if (!env) return { ok: false, error: { code: "NOT_FOUND", message: "no such envelope", retryable: false } };
    if (!rev) return { ok: false, error: { code: "NOT_FOUND", message: "unknown revision", retryable: false } };
    const quality = JSON.parse(env.quality) as string[];
    const marker = env.deployment ? this.store.db.prepare("select revision from rt_markers where source = ? and deployment = ?").get(env.source, env.deployment) as any : null;
    const ranRevision: string | null = marker?.revision ?? env.revision ?? null;
    const sampled = Number((quality.find((q) => q.startsWith("SAMPLED:")) ?? "").split(":")[1]) || null;
    const spans = (this.store.db.prepare("select * from rt_spans where envelope = ? order by start_ms, seq").all(envelopeId) as any[]).filter((s) => !String(s.flags).includes("TIMESTAMP_IMPOSSIBLE") && (opts.cursorMs === undefined || s.start_ms <= opts.cursorMs) && (opts.fromMs === undefined || s.start_ms >= opts.fromMs));
    const counted = { valid: spans.length, invalid: Number((this.store.db.prepare("select count(*) as n from rt_spans where envelope = ? and flags like '%TIMESTAMP_IMPOSSIBLE%'").get(envelopeId) as any).n), late: spans.filter((s) => String(s.flags).includes("OUTSIDE_WINDOW")).length };
    const reasons = new Set<string>();
    if (!ranRevision) reasons.add("no deployment marker or revision on the signal, so which code ran is not known");
    else if (!marker && env.revision) reasons.add("the revision is claimed by the signal itself; no deployment marker confirms it");
    const sameRevision = ranRevision === revisionId;
    if (ranRevision && !sameRevision) reasons.add(`the signal ran revision ${ranRevision}, not ${revisionId}`);
    if (sampled) reasons.add(`sampled at ${sampled}: counts are estimates`);
    const entities = this.store.entities(revisionId);
    const byEntity = new Map<string, { spans: number; errors: number; durs: number[]; exact: boolean; method: string }>();
    let fog = 0; const fogReasons = new Set<string>();
    for (const s of spans) {
      let id: string | null = null, exact = false, method: RuntimeAttribution["method"] = "UNATTRIBUTED";
      if (!ranRevision) { fog++; fogReasons.add("no revision or deployment marker"); continue; }
      if (sameRevision && s.file && s.line) {
        const loc = locateFrames(this.store, rev, { errorClass: null, message: "", frames: [{ fn: s.fn ?? undefined, file: s.file, line: s.line, col: 1, raw: s.name }] }, entities)[0];
        if (loc?.entityId) { id = loc.entityId; exact = !!marker; method = "CODE_LOCATION_EXACT"; }
      }
      if (!id && s.fn) {
        // A name is a guess. It is used only to offer a place to look, and is never called exact.
        const named = this.byName(ranRevision, s.fn, s.file);
        if (named) {
          if (sameRevision) { id = named; method = "FUNCTION_NAME"; }
          else { const canon = this.registry.canonOf(ranRevision, named); const here = canon ? this.registry.entityIn(revisionId, canon)[0] : undefined; if (here) { id = here; method = "CODE_LOCATION_OTHER_REVISION"; } else { fog++; fogReasons.add(`code the signal ran (${s.fn}) no longer exists in ${revisionId}`); continue; } }
        }
      }
      if (!id) { fog++; fogReasons.add("the span names no code in this revision"); continue; }
      const b = byEntity.get(id) ?? { spans: 0, errors: 0, durs: [], exact: true, method };
      b.spans++; if (s.error) b.errors++; b.durs.push(s.end_ms - s.start_ms); b.exact = b.exact && exact; if (method !== "CODE_LOCATION_EXACT") b.method = method;
      byEntity.set(id, b);
    }
    for (const r of fogReasons) reasons.add(r);
    const perEntity = [...byEntity].map(([entityId, b]) => ({ entityId, spans: b.spans, errors: b.errors, estimatedSpans: sampled ? Math.round(b.spans / sampled) : null, p95Ms: pctile(b.durs, 95), exact: b.exact && !sampled, method: b.method })).sort((a, b) => b.spans - a.spans || a.entityId.localeCompare(b.entityId));
    const evidenceIds = perEntity.map((p) => observation(this.store, revisionId, `rt:${envelopeId}:${p.entityId}:${opts.cursorMs ?? "all"}${opts.fromMs === undefined ? "" : `:from:${opts.fromMs}`}`, "RUNTIME", rev.repoRoot, `${p.spans} span(s) (${p.errors} error(s)) from ${env.source} in ${new Date(opts.fromMs ?? env.win_from).toISOString()}–${new Date(opts.cursorMs ?? env.win_to).toISOString()} attributed by ${p.method}${sampled ? ` (sampled at ${sampled})` : ""}`, new Date(this.now()).toISOString(), "RuntimeLocation").id);
    const exactAll = perEntity.length > 0 && perEntity.every((p) => p.exact) && fog === 0 && reasons.size === 0;
    const method: RuntimeAttribution["method"] = !perEntity.length ? "UNATTRIBUTED" : perEntity.every((p) => p.method === "CODE_LOCATION_EXACT") ? "CODE_LOCATION_EXACT" : perEntity.some((p) => p.method === "CODE_LOCATION_OTHER_REVISION") ? "CODE_LOCATION_OTHER_REVISION" : "FUNCTION_NAME";
    return { id: "att:" + sha(envelopeId + revisionId + (opts.cursorMs ?? "") + (opts.fromMs === undefined ? "" : `:from:${opts.fromMs}`)), runtimeId: envelopeId, entityRefs: perEntity.map((p) => p.entityId), evidenceIds, method, exact: exactAll, uncertaintyReason: reasons.size ? [...reasons].join("; ") : null, perEntity, fog: { spans: fog, reasons: [...fogReasons] }, quality, samplingRate: sampled, counted };
  }

  private byName(revision: string, fn: string, file?: string | null): string | null {
    const c = this.store.entities(revision).filter((e: Entity) => ["function", "method"].includes(e.kind) && (e.name === fn || e.name.split(".").pop() === fn));
    const narrowed = file ? c.filter((e) => file.endsWith(e.file)) : c;
    return (narrowed.length === 1 ? narrowed : c.length === 1 ? c : [])[0]?.entityId ?? null;
  }

  /** Everything attributed in a window, across envelopes, for the roots asked about (or all). */
  queryWindow(revision: string, window: { from: number; to: number }, roots?: string[]) {
    const ids = (this.store.db.prepare("select id from rt_envelopes where win_to >= ? and win_from <= ? and rejected = 0 order by win_from, id").all(window.from, window.to) as any[]).map((r) => r.id as string);
    return ids.flatMap((id) => { const a = this.attribute(id, revision, { fromMs: window.from, cursorMs: window.to }); if ("ok" in a) return []; const p = a.perEntity.filter((x) => !roots?.length || roots.includes(x.entityId)); return p.length || !roots?.length ? [{ ...a, perEntity: p }] : []; });
  }

  /** Scrub to a time: the same envelopes seen as of `cursorMs`. Deterministic, so replaying twice gives the same picture. */
  replay(revision: string, window: { from: number; to: number }, cursorMs: number) {
    cursorMs = Math.max(window.from, Math.min(cursorMs, window.to));
    const ids = (this.store.db.prepare("select id from rt_envelopes where win_to >= ? and win_from <= ? and rejected = 0 order by win_from, id").all(window.from, window.to) as any[]).map((r) => r.id as string);
    const frames = ids.flatMap((id) => { const a = this.attribute(id, revision, { cursorMs, fromMs: window.from }); return "ok" in a ? [] : [a]; });
    const totals = new Map<string, { spans: number; errors: number }>();
    for (const a of frames) for (const p of a.perEntity) { const t = totals.get(p.entityId) ?? { spans: 0, errors: 0 }; t.spans += p.spans; t.errors += p.errors; totals.set(p.entityId, t); }
    return { cursorMs, window, envelopes: ids, entities: [...totals].map(([entityId, t]) => ({ entityId, ...t })).sort((a, b) => a.entityId.localeCompare(b.entityId)), fogSpans: frames.reduce((n, f) => n + f.fog.spans, 0), warnings: [...new Set(frames.flatMap((f) => [...f.quality, ...(f.uncertaintyReason ? [f.uncertaintyReason] : [])]))] };
  }

  /**
   * A runtime signal that lands on what the person is already looking at or working on (focus, selection, pins, frequent code,
   * an incident task) is added to their context as a runtime event; one that lands elsewhere is not pushed at them.
   */
  notifyRelevantContext(session: string, att: RuntimeAttribution): { relevant: string[]; snapshot: ContextSnapshot } {
    const snap = sessionSnapshot(this.store, session);
    const mine = new Set([snap.focus, ...snap.selection, ...snap.pins, ...snap.referent, ...Object.keys(snap.frequent), ...snap.recent].filter(Boolean) as string[]);
    const relevant = att.perEntity.filter((p) => mine.has(p.entityId) && (p.errors > 0 || snap.taskFrame === "incident" || p.spans > 0)).map((p) => p.entityId);
    if (!relevant.length) return { relevant, snapshot: snap };
    const r = applyContextEvent(this.store, session, { event: { kind: "ACTION", action: "RUNTIME", ids: relevant, value: att.exact ? "exact" : "inexact" }, expectedSequence: currentSequence(this.store, session) });
    return { relevant, snapshot: r.ok ? r.snapshot : snap };
  }
}
