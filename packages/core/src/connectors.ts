// C04: external sources (a forge's pull requests, reviews and issues) read through a transport that can fail in all the usual ways.
// Whatever arrives is untrusted data: every record is validated, a record that is not valid is set aside with its reason and the rest
// is kept, and the result says it is partial. A credential that expired is a stated state, not a retry loop; the secret is never stored
// or logged. A rate limit is waited out when short and resumed from a saved cursor when long. Inbound webhooks are authenticated,
// ordered and idempotent.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ApiError } from "@cie/schema";
import type { Store } from "./store.ts";

export interface HttpRequest { method: "GET"; url: string; headers: Record<string, string> }
export interface HttpResponse { status: number; headers: Record<string, string>; body: string }
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export type SourceState = "HEALTHY" | "PARTIAL" | "EXPIRED" | "RATE_LIMITED" | "UNREACHABLE" | "NEVER_RUN";
export interface PullRequest { number: number; title: string; state: "open" | "closed" | "merged"; author: string; body: string; createdAt: string; updatedAt: string; mergedAt: string | null; /** Text written by someone outside the system. It is shown and cited, never followed. */ untrusted: true }
export interface IngestReport { fetched: number; accepted: number; quarantined: number; pages: number; partial: boolean; state: SourceState; reasons: string[]; resumeAfter: number | null }
export interface Health { sourceId: string; state: SourceState; lastOk: string | null; lastError: string | null; items: number; quarantined: number; credentialExpiresAt: string | null; resumeAt: string | null; cursor: string | null }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Validate one record against the contract. Returns the record, or why it is not one. */
export function parsePullRequest(x: unknown): { ok: true; pr: PullRequest } | { ok: false; reason: string } {
  const o = x as Record<string, any>;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, reason: "not an object" };
  if (!Number.isInteger(o.number) || o.number <= 0) return { ok: false, reason: "number is not a positive integer" };
  if (typeof o.title !== "string" || !o.title.trim()) return { ok: false, reason: "title is missing or empty" };
  if (typeof o.title === "string" && o.title.length > 500) return { ok: false, reason: "title is implausibly long" };
  const state = o.merged_at ? "merged" : o.state;
  if (!["open", "closed", "merged"].includes(state)) return { ok: false, reason: `state ${JSON.stringify(o.state)} is not one of open, closed, merged` };
  if (typeof o.user?.login !== "string") return { ok: false, reason: "author is missing" };
  if (typeof o.created_at !== "string" || !ISO.test(o.created_at)) return { ok: false, reason: "created_at is not an ISO-8601 time" };
  if (typeof o.updated_at !== "string" || !ISO.test(o.updated_at)) return { ok: false, reason: "updated_at is not an ISO-8601 time" };
  if (Date.parse(o.updated_at) < Date.parse(o.created_at)) return { ok: false, reason: "updated_at is before created_at" };
  if (o.merged_at != null && (typeof o.merged_at !== "string" || !ISO.test(o.merged_at))) return { ok: false, reason: "merged_at is not an ISO-8601 time" };
  if (o.body != null && typeof o.body !== "string") return { ok: false, reason: "body is not text" };
  return { ok: true, pr: { number: o.number, title: o.title, state, author: o.user.login, body: (o.body ?? "").slice(0, 20_000), createdAt: o.created_at, updatedAt: o.updated_at, mergedAt: o.merged_at ?? null, untrusted: true } };
}

const nextLink = (h: Record<string, string>): string | null => { const l = h.link ?? h.Link; if (!l) return null; const m = /<([^>]+)>\s*;\s*rel="next"/.exec(l); return m ? m[1] : null; };
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

export interface ConnectorOptions {
  sourceId: string; baseUrl: string; repoRoot?: string; transport: Transport;
  /** Returns the credential at the moment of use. It is never stored, logged or put in an error. */
  token: () => string | null;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  maxPages?: number; maxWaitMs?: number;
}

export class ForgeConnector {
  readonly store: Store;
  private o: Required<Pick<ConnectorOptions, "now" | "sleep" | "maxPages" | "maxWaitMs">> & ConnectorOptions;
  constructor(store: Store, o: ConnectorOptions) {
    this.store = store;
    this.o = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), maxPages: 50, maxWaitMs: 5_000, ...o };
    if (!this.row()) this.store.db.prepare("insert into ext_sources values (?,?,?,?,?,?,?,?,?,?)").run(o.sourceId, "forge", o.repoRoot ?? null, "NEVER_RUN", null, null, null, null, null, this.o.now());
  }
  private row() { return this.store.db.prepare("select * from ext_sources where id = ?").get(this.o.sourceId) as any; }
  private set(f: Partial<{ state: SourceState; cred_expires_at: number | null; cursor: string | null; last_ok: number; last_error: string | null; rate_resume_at: number | null }>) {
    const cur = this.row(), next = { ...cur, ...f, updated_at: this.o.now() };
    this.store.db.prepare("update ext_sources set state=?, cred_expires_at=?, cursor=?, last_ok=?, last_error=?, rate_resume_at=?, updated_at=? where id=?").run(next.state, next.cred_expires_at, next.cursor, next.last_ok, next.last_error, next.rate_resume_at, next.updated_at, this.o.sourceId);
  }
  /** Tell the connector when the credential stops working, so it stops asking rather than being refused over and over. */
  setCredentialExpiry(atMs: number | null) { this.set({ cred_expires_at: atMs }); }

  health(): Health {
    const r = this.row();
    const n = (t: string) => Number((this.store.db.prepare(`select count(*) as n from ${t} where source = ?`).get(this.o.sourceId) as any).n);
    return { sourceId: this.o.sourceId, state: r.state, lastOk: r.last_ok ? new Date(r.last_ok).toISOString() : null, lastError: r.last_error, items: n("ext_items"), quarantined: n("ext_quarantine"), credentialExpiresAt: r.cred_expires_at ? new Date(r.cred_expires_at).toISOString() : null, resumeAt: r.rate_resume_at ? new Date(r.rate_resume_at).toISOString() : null, cursor: r.cursor };
  }

  private quarantine(kind: string, reason: string, raw: unknown) { this.store.db.prepare("insert into ext_quarantine(source, kind, reason, raw, at) values (?,?,?,?,?)").run(this.o.sourceId, kind, reason, JSON.stringify(raw).slice(0, 4000), this.o.now()); }

  /** Pull request pages, from the saved cursor if a previous run stopped part way. */
  async ingestPullRequests(opts: { fromStart?: boolean } = {}): Promise<IngestReport> {
    const rep: IngestReport = { fetched: 0, accepted: 0, quarantined: 0, pages: 0, partial: false, state: "HEALTHY", reasons: [], resumeAfter: null };
    const row = this.row();
    const now = this.o.now();
    if (row.cred_expires_at && now >= row.cred_expires_at) { this.set({ state: "EXPIRED", last_error: "the credential's expiry time has passed" }); return { ...rep, partial: true, state: "EXPIRED", reasons: ["the credential has expired; nothing was requested"] }; }
    if (row.rate_resume_at && now < row.rate_resume_at && !opts.fromStart) return { ...rep, partial: true, state: "RATE_LIMITED", reasons: [`rate limited until ${new Date(row.rate_resume_at).toISOString()}`], resumeAfter: row.rate_resume_at };
    let url: string | null = opts.fromStart || !row.cursor ? `${this.o.baseUrl}/pulls?state=all&per_page=30` : row.cursor;
    const seen = new Set<string>();
    while (url) {
      if (rep.pages >= this.o.maxPages) { rep.partial = true; rep.reasons.push(`stopped after ${this.o.maxPages} pages`); this.set({ cursor: url }); break; }
      if (seen.has(url)) { rep.partial = true; rep.reasons.push("the next-page link repeats an earlier page; stopped to avoid a loop"); break; }
      seen.add(url);
      const tok = this.o.token();
      if (!tok) { this.set({ state: "EXPIRED", last_error: "no credential is available" }); return { ...rep, partial: true, state: "EXPIRED", reasons: [...rep.reasons, "no credential is available"] }; }
      let res: HttpResponse;
      try { res = await this.o.transport({ method: "GET", url, headers: { authorization: `Bearer ${tok}`, accept: "application/json" } }); }
      catch (e) { this.set({ state: "UNREACHABLE", last_error: `request failed: ${String((e as Error).message).replace(tok, "[credential]").slice(0, 200)}`, cursor: url }); return { ...rep, partial: true, state: "UNREACHABLE", reasons: [...rep.reasons, "the source could not be reached"], resumeAfter: null }; }
      const h = lower(res.headers);
      if (res.status === 401 || res.status === 403 && !/rate limit/i.test(res.body) && h["x-ratelimit-remaining"] !== "0") {
        this.set({ state: "EXPIRED", last_error: `the source refused the credential (HTTP ${res.status})`, cursor: url });
        return { ...rep, partial: true, state: "EXPIRED", reasons: [...rep.reasons, `the source refused the credential (HTTP ${res.status}); no retry was made`] };
      }
      if (res.status === 429 || (res.status === 403 && h["x-ratelimit-remaining"] === "0")) {
        const resetAt = h["retry-after"] ? this.o.now() + Number(h["retry-after"]) * 1000 : h["x-ratelimit-reset"] ? Number(h["x-ratelimit-reset"]) * 1000 : this.o.now() + 60_000;
        const wait = Math.max(0, resetAt - this.o.now());
        if (wait <= this.o.maxWaitMs) { await this.o.sleep(wait); seen.delete(url); rep.reasons.push(`waited ${Math.ceil(wait / 1000)}s for the rate limit`); continue; }
        this.set({ state: "RATE_LIMITED", cursor: url, rate_resume_at: resetAt, last_error: "rate limited" });
        return { ...rep, partial: true, state: "RATE_LIMITED", reasons: [...rep.reasons, `rate limited; resume after ${new Date(resetAt).toISOString()}`], resumeAfter: resetAt };
      }
      if (res.status >= 500) { this.set({ state: "UNREACHABLE", last_error: `the source answered HTTP ${res.status}`, cursor: url }); return { ...rep, partial: true, state: "UNREACHABLE", reasons: [...rep.reasons, `the source answered HTTP ${res.status}`] }; }
      if (res.status !== 200) { this.set({ state: "PARTIAL", last_error: `unexpected HTTP ${res.status}`, cursor: url }); return { ...rep, partial: true, state: "PARTIAL", reasons: [...rep.reasons, `unexpected HTTP ${res.status}`] }; }
      let page: unknown;
      try { page = JSON.parse(res.body); } catch { rep.partial = true; rep.reasons.push(`page ${rep.pages + 1} was not valid JSON and was skipped`); this.quarantine("page", "not valid JSON", res.body.slice(0, 500)); rep.quarantined++; url = nextLink(h); rep.pages++; continue; }
      rep.pages++;
      if (!Array.isArray(page)) { rep.partial = true; rep.reasons.push(`page ${rep.pages} was not a list`); this.quarantine("page", "not a list", page); rep.quarantined++; url = nextLink(h); continue; }
      for (const item of page) {
        rep.fetched++;
        const v = parsePullRequest(item);
        if (!v.ok) { rep.quarantined++; this.quarantine("pull_request", v.reason, item); continue; }
        this.upsert(v.pr); rep.accepted++;
      }
      url = nextLink(h);
      this.set({ cursor: url });
    }
    if (rep.quarantined) { rep.partial = true; rep.reasons.push(`${rep.quarantined} record(s) were set aside as invalid`); }
    rep.state = rep.partial ? "PARTIAL" : "HEALTHY";
    this.set({ state: rep.state, last_ok: this.o.now(), last_error: rep.partial ? rep.reasons.join("; ").slice(0, 300) : null, cursor: url, rate_resume_at: null });
    return rep;
  }

  /** Insert or update, never letting an older version overwrite a newer one. */
  private upsert(pr: PullRequest): boolean {
    const cur = this.store.db.prepare("select updated_at from ext_items where source = ? and kind = 'pull_request' and external_id = ?").get(this.o.sourceId, String(pr.number)) as any;
    if (cur && cur.updated_at && Date.parse(cur.updated_at) > Date.parse(pr.updatedAt)) return false;
    this.store.db.prepare("insert or replace into ext_items values (?,?,?,?,?,?)").run(this.o.sourceId, "pull_request", String(pr.number), pr.updatedAt, JSON.stringify(pr), this.o.now());
    return true;
  }
  item(kind: "pull_request", number: number): PullRequest | null { const r = this.store.db.prepare("select json from ext_items where source = ? and kind = ? and external_id = ?").get(this.o.sourceId, kind, String(number)) as any; return r ? JSON.parse(r.json) : null; }

  // ------------------------------------------------------------------ webhooks
  /**
   * An inbound delivery: the signature must match the shared secret over the exact bytes, the time must be recent, a delivery id is
   * applied once however often it is sent, and an event older than what is stored changes nothing.
   */
  receiveWebhook(req: { secret: string; headers: Record<string, string>; rawBody: string; toleranceMs?: number }): { ok: true; applied: boolean; replayed: boolean; reason?: string } | { ok: false; error: ApiError } {
    const h = lower(req.headers);
    const bad = (code: ApiError["code"], message: string): { ok: false; error: ApiError } => ({ ok: false, error: { code, message, retryable: false } });
    const sig = (h["x-hub-signature-256"] ?? "").replace(/^sha256=/, "");
    const want = createHmac("sha256", req.secret).update(req.rawBody).digest("hex");
    const a = Buffer.from(sig, "hex"), b = Buffer.from(want, "hex");
    if (!sig || a.length !== b.length || !timingSafeEqual(a, b)) return bad("UNAUTHORIZED", "the signature does not match");
    const id = h["x-delivery-id"], ts = Number(h["x-delivery-timestamp"]);
    if (!id) return bad("INVALID_SCHEMA", "a delivery needs an id");
    if (!Number.isFinite(ts) || Math.abs(this.o.now() - ts * 1000) > (req.toleranceMs ?? 5 * 60_000)) return bad("INVALID_SCHEMA", "the delivery time is too far from now, so it is refused as a possible replay");
    const seen = this.store.db.prepare("select applied from ext_deliveries where source = ? and delivery_id = ?").get(this.o.sourceId, id) as any;
    if (seen) return { ok: true, applied: false, replayed: true, reason: "this delivery was already received" };
    let body: any; try { body = JSON.parse(req.rawBody); } catch { return bad("INVALID_SCHEMA", "the body is not valid JSON"); }
    const v = parsePullRequest(body?.pull_request);
    if (!v.ok) { this.quarantine("webhook", v.reason, body); this.store.db.prepare("insert into ext_deliveries values (?,?,?,0)").run(this.o.sourceId, id, this.o.now()); return { ok: true, applied: false, replayed: false, reason: `the record was invalid (${v.reason}) and was set aside` }; }
    const applied = this.upsert(v.pr);
    this.store.db.prepare("insert into ext_deliveries values (?,?,?,?)").run(this.o.sourceId, id, this.o.now(), applied ? 1 : 0);
    return { ok: true, applied, replayed: false, ...(applied ? {} : { reason: "a newer version is already stored" }) };
  }
}
