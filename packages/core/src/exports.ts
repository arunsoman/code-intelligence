// C30 exports and notifications. What leaves this system is a copy, and a copy cannot be corrected or recalled, so it has to carry
// what the claim was when it left: how it is known (fact, inference, hypothesis), what its confidence was (including "not estimated"),
// what state it was in, and which revision it described. Refuted and hidden claims do not leave; code the recipient may not see does
// not leave; and the export says that later corrections and revoked access cannot reach it.
//
// Notifications are webhooks with one delivery per (event, subscription). A delivery is retried until it succeeds, always with the same
// idempotency key, so a receiver that did process the first attempt but whose reply was lost handles the retry as the same delivery,
// and this side never records two successes.
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Claim } from "@cie/schema";
import { policyFor } from "./access.ts";
import type { RevisionRow, Store } from "./store.ts";

export interface ExportedClaim {
  id: string; statement: string; howKnown: "Fact" | "Inference" | "Hypothesis" | "Fog"; confidence: string; state: string; stale: boolean;
  counterArgument: string; evidence: { id: string; where: string; class: string }[]; verdicts: { by: string; verdict: string; at: string }[];
}
export interface ExportArtifact {
  id: string; title: string; format: "markdown" | "json"; content: string; contentHash: string;
  manifest: { revision: string; revisionIndexedAt: string; repository: string; exportedAt: string; claims: number; omitted: { refuted: number; hidden: number; inaccessible: number }; limits: string[] };
}
export class ExportError extends Error { readonly code: "INVALID_SCHEMA" | "NOT_FOUND" | "FORBIDDEN"; constructor(code: ExportError["code"], message: string) { super(message); this.code = code; } }

const MODE = { FACT: "Fact", INFERENCE: "Inference", HYPOTHESIS: "Hypothesis", FOG: "Fog" } as const;
export const COPY_LIMIT = "This is a copy. If a claim here is later refuted, corrected or its source access is withdrawn, this copy does not change and cannot be recalled.";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

function confidenceText(c: Claim): string {
  const k = c.confidence;
  if (k.mode === "CALIBRATED" && k.band) return `Calibrated: ${(k.band.lower * 100).toFixed(0)}–${(k.band.upper * 100).toFixed(0)}% (${k.band.sampleCount} judged cases, ${(k.band.confidenceLevel * 100).toFixed(0)}% interval)`;
  if (k.mode === "UNCALIBRATED") return `Uncalibrated: ${k.reasonCodes.join(", ").toLowerCase() || "no calibration applies"}`;
  return `Not estimated: ${k.reasonCodes.join(", ").toLowerCase() || "no judged cases"}`;
}

/** The claims a recipient may receive, in the form they may receive them. Reads the stored claim, never what the caller says it is. */
export function exportableClaims(store: Store, rev: RevisionRow, ids: string[]): { claims: ExportedClaim[]; omitted: { refuted: number; hidden: number; inaccessible: number } } {
  const access = policyFor(store, rev.repoRoot);
  const ents = new Map(store.entities(rev.id).map((e) => [e.entityId, e]));
  const deniedNames = new Set<string>(); for (const e of ents.values()) if (access.denied(e.file) && e.kind !== "file" && e.name.length >= 3) deniedNames.add(e.name);
  const mentions = (s: string) => { for (const f of ents.values()) if (access.denied(f.file) && s.includes(f.file)) return true; for (const m of s.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) if (deniedNames.has(m[0])) return true; return access.prefixes.some((p) => s.includes(p + "/")); };
  const omitted = { refuted: 0, hidden: 0, inaccessible: 0 }; const out: ExportedClaim[] = [];
  for (const c of store.getClaims([...new Set(ids)])) {
    if (c.draft.revision !== rev.id) { omitted.inaccessible++; continue; }
    if (c.state === "REFUTED") { omitted.refuted++; continue; }
    if (c.displayMode === "HIDDEN") { omitted.hidden++; continue; }
    const about = [...(c.draft.subjects ?? []), ...(c.draft.structure?.entityIds ?? [])];
    if (about.some((id) => access.deniedEntity(id, (x) => ents.get(x)?.file)) || mentions(c.draft.assertion) || mentions(c.counterArgument)) { omitted.inaccessible++; continue; }
    const evidence = c.draft.evidenceIds.map((id) => store.evidence(rev.id, id)).filter((e): e is NonNullable<typeof e> => !!e).filter((e) => !access.denied(((e.location as any).span?.sourceId as string) ?? e.sourceId)).map((e) => ({ id: e.id, where: ((e.location as any).span?.sourceId as string) ?? e.sourceId, class: e.class }));
    out.push({
      id: c.draft.id, statement: c.draft.assertion, howKnown: MODE[c.displayMode as keyof typeof MODE], confidence: confidenceText(c), state: c.state, stale: c.state === "STALE",
      counterArgument: c.counterArgument, evidence, verdicts: c.verdicts.map((v) => ({ by: v.actorId, verdict: v.verdict, at: v.timestamp })),
    });
  }
  return { claims: out.sort((a, b) => a.id.localeCompare(b.id)), omitted };
}

export function buildExport(store: Store, rev: RevisionRow, req: { title: string; claimIds: string[]; format: "markdown" | "json"; now?: Date }): ExportArtifact {
  if (!req.title?.trim() || req.title.length > 200) throw new ExportError("INVALID_SCHEMA", "a title of 1–200 characters is required");
  if (!["markdown", "json"].includes(req.format)) throw new ExportError("INVALID_SCHEMA", "format must be markdown or json");
  if (!req.claimIds?.length || req.claimIds.length > 500) throw new ExportError("INVALID_SCHEMA", "export 1–500 claims");
  const { claims, omitted } = exportableClaims(store, rev, req.claimIds);
  const at = (req.now ?? new Date()).toISOString();
  const limits = [COPY_LIMIT, "Evidence is listed by location, not copied: a recipient needs their own access to read the code behind a claim.", ...(omitted.refuted ? [`${omitted.refuted} refuted claim(s) were left out.`] : []), ...(omitted.inaccessible ? [`${omitted.inaccessible} claim(s) concerned code the recipient may not see and were left out.`] : []), ...(claims.some((c) => c.howKnown !== "Fact") ? ["Claims marked Inference or Hypothesis are not proven; they are reasoning from cited evidence."] : [])];
  const manifest = { revision: rev.id, revisionIndexedAt: rev.createdAt, repository: rev.repoRoot.split("/").filter(Boolean).pop() ?? "repository", exportedAt: at, claims: claims.length, omitted, limits };
  const id = "exp:" + randomUUID();
  const content = req.format === "json"
    ? JSON.stringify({ title: req.title.trim(), manifest, claims }, null, 2)
    : [`# ${req.title.trim()}`, "", `Revision \`${rev.id}\` of ${manifest.repository}, indexed ${rev.createdAt}. Exported ${at}.`, "",
      ...claims.flatMap((c) => [`## ${c.statement}`, "", `- **How it is known:** ${c.howKnown}${c.stale ? " (stale: the code it rests on has changed)" : ""}`, `- **Confidence:** ${c.confidence}`, `- **State:** ${c.state.toLowerCase()}`, ...(c.counterArgument ? [`- **Counter-argument:** ${c.counterArgument}`] : []), ...(c.verdicts.length ? [`- **Judgements:** ${c.verdicts.map((v) => `${v.verdict.toLowerCase()} by ${v.by}`).join("; ")}`] : []), `- **Evidence:** ${c.evidence.length ? c.evidence.map((e) => `${e.where} (${e.class.toLowerCase().replace(/_/g, " ")})`).join("; ") : "none that you may see"}`, ""]),
      "---", "", "**Limits**", "", ...limits.map((l) => `- ${l}`), ""].join("\n");
  return { id, title: req.title.trim(), format: req.format, content, contentHash: sha(content), manifest };
}

// ------------------------------------------------------------------------------------------------------ webhooks
export interface Subscription { id: string; url: string; secret: string; events: string[]; allowPrivate: boolean; createdAt: string; active: boolean }
export interface Delivery { deliveryId: string; subscriptionId: string; eventId: string; type: string; state: "PENDING" | "DELIVERED" | "DEAD" | "CANCELLED"; attempts: number; nextAt: number; lastError: string | null; deliveredAt: string | null; payload: string }
export interface Sender { (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<{ status: number }> }
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$|\[?fe80:)/i;

export function validateWebhookUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL; try { u = new URL(raw); } catch { throw new ExportError("INVALID_SCHEMA", "that is not a URL"); }
  if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:")) throw new ExportError("INVALID_SCHEMA", "webhooks must use https");
  if (u.username || u.password) throw new ExportError("INVALID_SCHEMA", "put credentials in the secret, not in the URL");
  if (PRIVATE.test(u.hostname) && !allowPrivate) throw new ExportError("FORBIDDEN", "a webhook cannot point at a private or loopback address");
  if (/^169\.254\.169\.254$|metadata\.google/.test(u.hostname)) throw new ExportError("FORBIDDEN", "a webhook cannot point at a cloud metadata address");
  return u;
}

export class Notifications {
  private store: Store;
  private send: Sender;
  /** Seconds between attempts: 1, 2, 4 … capped. Injected so tests do not wait. */
  backoffMs = (attempt: number) => Math.min(60_000, 1000 * 2 ** (attempt - 1));
  maxAttempts = 8;
  constructor(store: Store, send?: Sender) {
    this.store = store;
    this.send = send ?? (async (url, init) => { const r = await fetch(url, init); return { status: r.status }; });
  }
  setSender(s: Sender) { this.send = s; }

  subscribe(req: { url: string; secret: string; events: string[]; allowPrivate?: boolean }): Subscription {
    validateWebhookUrl(req.url, !!req.allowPrivate);
    if (!req.secret || req.secret.length < 16) throw new ExportError("INVALID_SCHEMA", "the signing secret must be at least 16 characters");
    if (!req.events?.length) throw new ExportError("INVALID_SCHEMA", "name at least one event");
    const sub: Subscription = { id: "sub:" + randomUUID(), url: req.url, secret: req.secret, events: [...new Set(req.events)], allowPrivate: !!req.allowPrivate, createdAt: new Date().toISOString(), active: true };
    this.store.db.prepare("insert into webhook_subs(id, json) values (?,?)").run(sub.id, JSON.stringify(sub));
    return sub;
  }
  unsubscribe(id: string) { const s = this.sub(id); if (s) { s.active = false; this.store.db.prepare("update webhook_subs set json = ? where id = ?").run(JSON.stringify(s), id); this.store.db.prepare("update webhook_deliveries set state = 'CANCELLED' where sub_id = ? and state = 'PENDING'").run(id); } }
  private sub(id: string): Subscription | null { const r = this.store.db.prepare("select json from webhook_subs where id = ?").get(id) as { json: string } | undefined; return r ? JSON.parse(r.json) : null; }
  subscriptions(): Subscription[] { return (this.store.db.prepare("select json from webhook_subs").all() as { json: string }[]).map((r) => JSON.parse(r.json)); }

  /**
   * Record one delivery per matching subscription. The delivery id is a function of the event and the subscription, so publishing the
   * same event twice (a replayed outbox, a retried command) creates nothing new.
   */
  publish(ev: { eventId: string; type: string; revision: string | null; summary: string; links?: Record<string, string> }): number {
    let n = 0;
    for (const sub of this.subscriptions().filter((s) => s.active && s.events.includes(ev.type))) {
      const deliveryId = "dlv:" + sha(`${ev.eventId}|${sub.id}`).slice(0, 32);
      // The payload names things by id and says what happened in a sentence the publisher already scrubbed: no code, no file contents.
      const payload = JSON.stringify({ id: deliveryId, event: ev.type, eventId: ev.eventId, revision: ev.revision, summary: ev.summary, links: ev.links ?? {} });
      const r = this.store.db.prepare("insert or ignore into webhook_deliveries(delivery_id, sub_id, event_id, type, state, attempts, next_at, last_error, delivered_at, claimed_until, revision, payload) values (?,?,?,?,'PENDING',0,0,null,null,0,?,?)").run(deliveryId, sub.id, ev.eventId, ev.type, ev.revision, payload);
      n += Number(r.changes);
    }
    return n;
  }
  deliveries(): Delivery[] { return (this.store.db.prepare("select * from webhook_deliveries order by rowid").all() as any[]).map((r) => ({ deliveryId: r.delivery_id, subscriptionId: r.sub_id, eventId: r.event_id, type: r.type, state: r.state, attempts: r.attempts, nextAt: r.next_at, lastError: r.last_error, deliveredAt: r.delivered_at, payload: r.payload })); }

  /** Work that is due: claim it under a lease (two dispatchers never send the same delivery at once), send, record. */
  async dispatch(now = Date.now(), timeoutMs = 5000): Promise<{ sent: number; delivered: number; retried: number; dead: number }> {
    const out = { sent: 0, delivered: 0, retried: 0, dead: 0 };
    const due = this.store.db.prepare("select * from webhook_deliveries where state = 'PENDING' and next_at <= ? and claimed_until <= ? order by rowid limit 50").all(now, now) as any[];
    for (const d of due) {
      const claimed = this.store.db.prepare("update webhook_deliveries set claimed_until = ? where delivery_id = ? and state = 'PENDING' and claimed_until <= ?").run(now + timeoutMs + 5000, d.delivery_id, now);
      if (!claimed.changes) continue;
      const sub = this.sub(d.sub_id);
      if (!sub || !sub.active) { this.store.db.prepare("update webhook_deliveries set state = 'CANCELLED' where delivery_id = ?").run(d.delivery_id); continue; }
      // A delivery about a source whose access was withdrawn is not sent: the notice would itself reveal something about it.
      if (d.revision && !this.store.revision(d.revision)) { this.store.db.prepare("update webhook_deliveries set state = 'CANCELLED', payload = ?, last_error = ? where delivery_id = ?").run(JSON.stringify({ id: d.delivery_id, cancelled: true }), "access to the source was withdrawn", d.delivery_id); continue; }
      const ts = String(Math.floor(now / 1000));
      const sig = createHmac("sha256", sub.secret).update(`${ts}.${d.payload}`).digest("hex");
      const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
      out.sent++;
      let err: string | null = null;
      try {
        validateWebhookUrl(sub.url, sub.allowPrivate);
        const res = await this.send(sub.url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": d.delivery_id, "x-cie-delivery": d.delivery_id, "x-cie-timestamp": ts, "x-cie-signature": `sha256=${sig}` }, body: d.payload, signal: ac.signal });
        if (res.status >= 200 && res.status < 300) { this.store.db.prepare("update webhook_deliveries set state = 'DELIVERED', delivered_at = ?, attempts = attempts + 1, last_error = null where delivery_id = ? and state = 'PENDING'").run(new Date(now).toISOString(), d.delivery_id); out.delivered++; clearTimeout(timer); continue; }
        err = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 ? `rejected with ${res.status}` : `server answered ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) { this.store.db.prepare("update webhook_deliveries set state = 'DEAD', attempts = attempts + 1, last_error = ? where delivery_id = ?").run(err, d.delivery_id); out.dead++; clearTimeout(timer); continue; }
      } catch (e) { err = ac.signal.aborted ? "no answer within the timeout" : (e as Error).message.slice(0, 160); }
      clearTimeout(timer);
      // An error is not a failure of delivery: the receiver may have processed it. The retry carries the same key.
      const attempts = d.attempts + 1;
      if (attempts >= this.maxAttempts) { this.store.db.prepare("update webhook_deliveries set state = 'DEAD', attempts = ?, last_error = ?, claimed_until = 0 where delivery_id = ?").run(attempts, err, d.delivery_id); out.dead++; }
      else { this.store.db.prepare("update webhook_deliveries set attempts = ?, last_error = ?, next_at = ?, claimed_until = 0 where delivery_id = ?").run(attempts, err, now + this.backoffMs(attempts), d.delivery_id); out.retried++; }
    }
    return out;
  }
  /** A source's access was withdrawn: whatever has not been sent about it never will be. */
  cancelForRevision(revision: string): number { return Number(this.store.db.prepare("update webhook_deliveries set state = 'CANCELLED', payload = ?, last_error = 'access to the source was withdrawn' where revision = ? and state = 'PENDING'").run(JSON.stringify({ cancelled: true }), revision).changes); }
}

// --------------------------------------------------------------------------------------------------- stored exports
export class ExportStore {
  private store: Store;
  constructor(store: Store) { this.store = store; }
  create(rev: RevisionRow, a: ExportArtifact, by: string) { this.store.db.prepare("insert into exports(id, revision, created_by, created_at, json) values (?,?,?,?,?)").run(a.id, rev.id, by, a.manifest.exportedAt, JSON.stringify(a)); this.store.audit(by, "export.create", a.id, { claims: a.manifest.claims, omitted: a.manifest.omitted, format: a.format }); return a; }
  /** Reading a stored export needs current access to what it describes. */
  get(id: string): ExportArtifact {
    const r = this.store.db.prepare("select revision, json from exports where id = ?").get(id) as { revision: string; json: string } | undefined;
    if (!r) throw new ExportError("NOT_FOUND", "no such export");
    if (!this.store.revision(r.revision)) throw new ExportError("FORBIDDEN", "access to the source this export describes was withdrawn");
    return JSON.parse(r.json);
  }
}
