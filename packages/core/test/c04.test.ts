import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { ForgeConnector, parsePullRequest, type HttpRequest, type HttpResponse, type Transport } from "../src/connectors.ts";
import { Store } from "../src/store.ts";

// Exchanges written to the forge's documented list-pulls contract (Link-header pagination, rate-limit headers, 401/429/5xx).
// They are authored fixtures, not captured from a live service: capturing needs a real account.
const EX = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../fixtures/connectors/forge/exchanges.json"), "utf8")) as Record<string, { request: { url: string }; response: HttpResponse }>;
const BASE = "https://forge.example/api/v3/repos/acme/pay";
const SECRET_TOKEN = "ghp_SECRETTOKEN1234567890";
/** A forge that plays back recorded exchanges by URL; `override` replaces what a URL answers with, to inject faults. */
function forge(override: Record<string, string> = {}) {
  const calls: HttpRequest[] = [];
  const byUrl = new Map(Object.entries(EX).filter(([n]) => ["page1", "page2", "page3"].includes(n)).map(([n, e]) => [e.request.url, n]));
  const transport: Transport = async (req) => { calls.push(req); const n = override[req.url] ?? byUrl.get(req.url); if (!n || !EX[n]) return { status: 404, headers: {}, body: "{}" }; return EX[n].response; };
  return { transport, calls };
}
const mk = (o: Partial<ConstructorParameters<typeof ForgeConnector>[1]> & { transport: Transport }, now = () => Date.parse("2026-10-01T12:00:00Z")) => {
  const store = new Store(":memory:");
  const slept: number[] = [];
  const c = new ForgeConnector(store, { sourceId: "forge:acme/pay", baseUrl: BASE, token: () => SECRET_TOKEN, now, sleep: async (ms) => { slept.push(ms); }, ...o });
  return { store, c, slept };
};

test("recorded contract fixtures: three recorded pages are read through their next-links, every valid record is kept, and the invalid ones are set aside with their reasons", async () => {
  const f = forge();
  const { c, store } = mk({ transport: f.transport });
  const rep = await c.ingestPullRequests();
  assert.equal(rep.pages, 3);
  assert.equal(rep.fetched, 8);
  assert.equal(rep.accepted, 5, "231, 232, 233 and 237, and an older copy of 231");
  assert.equal(rep.quarantined, 3);
  assert.equal(rep.partial, true); assert.equal(rep.state, "PARTIAL");
  assert.match(rep.reasons.join(" "), /3 record\(s\) were set aside as invalid/);
  assert.deepEqual(f.calls.map((r) => r.url.replace(BASE, "")), ["/pulls?state=all&per_page=30", "/pulls?state=all&per_page=30&page=2", "/pulls?state=all&per_page=30&page=3"]);
  assert.deepEqual([231, 232, 233, 237].map((n) => c.item("pull_request", n)?.title), ["Tighten fraud threshold after chargebacks", "Retry budget for gateway", "Refund path: drop transaction", "Velocity checks"]);
  assert.equal(c.item("pull_request", 231)!.state, "merged");
  const reasons = (store.db.prepare("select reason from ext_quarantine order by id").all() as any[]).map((r) => r.reason);
  assert.deepEqual(reasons, ["number is not a positive integer", "title is missing or empty", "created_at is not an ISO-8601 time"]);
  // The older copy of 231 on the last page did not overwrite the newer one.
  assert.equal(c.item("pull_request", 231)!.updatedAt, "2026-09-02T10:00:00Z");
  const h = c.health();
  assert.deepEqual([h.state, h.items, h.quarantined], ["PARTIAL", 4, 3]);
  assert.equal(h.cursor, null, "finished: nothing left to resume");
});

test("corrupted fields: the field-level contract rejects what cannot be trusted, and a corrupt page or a non-list is set aside without losing the other pages", async () => {
  const cases: [unknown, RegExp][] = [
    [null, /not an object/], [{ number: 1.5 }, /number/], [{ number: 1, title: "t", state: "weird", user: { login: "a" } }, /state "weird"/],
    [{ number: 1, title: "t", state: "open" }, /author is missing/], [{ number: 1, title: "t".repeat(501), state: "open", user: { login: "a" } }, /implausibly long/],
    [{ number: 1, title: "t", state: "open", user: { login: "a" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", body: 5 }, /body is not text/],
    [{ number: 1, title: "t", state: "open", user: { login: "a" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", merged_at: "soon" }, /merged_at/],
  ];
  for (const [x, re] of cases) { const r = parsePullRequest(x); assert.ok(!r.ok && re.test(r.reason), `${JSON.stringify(x)} → ${(r as any).reason}`); }
  const good = parsePullRequest({ number: 7, title: "ok", state: "closed", merged_at: "2026-01-02T00:00:00Z", user: { login: "a" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", body: "x" });
  assert.ok(good.ok && good.pr.state === "merged" && good.pr.untrusted === true);
  // A page that is not JSON, in the middle of three.
  const p2 = EX.page2.request.url;
  const f = forge({ [p2]: "not_json" });
  const { c } = mk({ transport: (r) => f.transport(r).then((res) => (r.url === p2 ? { ...res, headers: { Link: `<${EX.page3.request.url}>; rel="next"` } } : res)) });
  const rep = await c.ingestPullRequests();
  assert.ok(rep.partial && rep.pages === 3 && /page 2 was not valid JSON and was skipped/.test(rep.reasons.join(" ")));
  assert.ok(c.item("pull_request", 232) && c.item("pull_request", 237), "the pages around it were kept");
  // A server that loops its next-link is stopped.
  const { c: loop } = mk({ transport: async () => ({ status: 200, headers: { Link: `<${EX.page1.request.url}>; rel="next"` }, body: "[]" }) });
  const lr = await loop.ingestPullRequests();
  assert.ok(lr.partial && /repeats an earlier page/.test(lr.reasons.join(" ")));
});

test("credential expiry: a refused or expired credential is a stated state with no retry, the secret is never stored or shown, and nothing is requested once the expiry is known", async () => {
  const f = forge({ [EX.page1.request.url]: "expired" });
  const { c, store } = mk({ transport: f.transport });
  const rep = await c.ingestPullRequests();
  assert.equal(rep.state, "EXPIRED"); assert.equal(f.calls.length, 1, "one refusal, no retry loop");
  assert.match(rep.reasons.join(" "), /refused the credential \(HTTP 401\); no retry was made/);
  const h = c.health();
  assert.equal(h.state, "EXPIRED"); assert.match(h.lastError!, /refused the credential/);
  // The secret appears nowhere that was written.
  const dump = JSON.stringify([store.db.prepare("select * from ext_sources").all(), store.db.prepare("select * from ext_items").all(), store.db.prepare("select * from ext_quarantine").all(), store.auditEvents(100), rep, h]);
  assert.ok(!dump.includes(SECRET_TOKEN) && !dump.includes("SECRETTOKEN"));
  // A transport error that happens to echo the credential does not leak it into the stored message.
  const { c: leaky, store: s2 } = mk({ transport: async (r) => { throw new Error(`connect failed with ${r.headers.authorization}`); } });
  const lr = await leaky.ingestPullRequests();
  assert.equal(lr.state, "UNREACHABLE");
  assert.ok(!JSON.stringify(s2.db.prepare("select * from ext_sources").all()).includes("SECRETTOKEN"));
  // With a known expiry in the past, no request is made at all.
  const f2 = forge();
  const { c: timed } = mk({ transport: f2.transport });
  timed.setCredentialExpiry(Date.parse("2026-09-30T00:00:00Z"));
  const tr = await timed.ingestPullRequests();
  assert.equal(tr.state, "EXPIRED"); assert.equal(f2.calls.length, 0);
  assert.match(timed.health().credentialExpiresAt!, /2026-09-30/);
  // No credential at all is the same state, not a crash.
  const { c: none } = mk({ transport: f2.transport, token: () => null });
  assert.equal((await none.ingestPullRequests()).state, "EXPIRED");
});

test("pagination: a long listing is read to the end, a page cap stops it with a saved cursor, and the next run continues from there", async () => {
  const f = forge();
  const { c } = mk({ transport: f.transport, maxPages: 2 });
  const first = await c.ingestPullRequests();
  assert.equal(first.pages, 2); assert.ok(first.partial); assert.match(first.reasons.join(" "), /stopped after 2 pages/);
  assert.equal(c.health().cursor, EX.page3.request.url, "the next page is remembered");
  assert.equal(c.item("pull_request", 237), null);
  const f2 = forge();
  const { c: resumed, store } = mk({ transport: f2.transport, maxPages: 2 });
  store.db.prepare("update ext_sources set cursor = ? where id = ?").run(EX.page3.request.url, "forge:acme/pay");
  const rest = await resumed.ingestPullRequests();
  assert.equal(rest.pages, 1, "only the remaining page was requested");
  assert.equal(f2.calls[0].url, EX.page3.request.url);
  assert.ok(resumed.item("pull_request", 237));
  assert.equal(resumed.health().cursor, null);
});

test("rate limits: a short limit is waited out, a long one stops with a resume time and asks for nothing until then, and a server error is reported as unreachable with the cursor kept", async () => {
  let n = 0;
  const f = forge();
  const { c, slept } = mk({ transport: async (r) => (n++ === 0 ? EX.limited_short.response : f.transport(r)) });
  const ok = await c.ingestPullRequests();
  assert.deepEqual(slept, [2000], "waited exactly what the source asked for");
  assert.equal(ok.pages, 3); assert.match(ok.reasons.join(" "), /waited 2s for the rate limit/);
  // A long limit: stop, remember when, and do not ask again before then.
  const g = forge({ [EX.page1.request.url]: "limited" });
  const { c: lim, store } = mk({ transport: g.transport });
  const stop = await lim.ingestPullRequests();
  assert.equal(stop.state, "RATE_LIMITED"); assert.ok(stop.resumeAfter! > Date.parse("2026-10-01T12:00:00Z") + 3_000_000);
  assert.equal(g.calls.length, 1);
  const again = await lim.ingestPullRequests();
  assert.equal(again.state, "RATE_LIMITED"); assert.equal(g.calls.length, 1, "no request while limited");
  assert.match(lim.health().resumeAt!, /2026-10-01T13:00:00/);
  void store;
  // A 5xx and a page that never arrives.
  const e = forge({ [EX.page1.request.url]: "server_error" });
  const { c: down } = mk({ transport: e.transport });
  const dr = await down.ingestPullRequests();
  assert.equal(dr.state, "UNREACHABLE"); assert.equal(down.health().cursor, EX.page1.request.url, "it will start where it stopped");
});

test("webhook replay: only a correctly signed, recent, once-seen delivery is applied; a replay, a forged signature, an old timestamp and an out-of-date event change nothing", async () => {
  const { c, store } = mk({ transport: forge().transport });
  const secret = "whsec_test";
  const NOW = Date.parse("2026-10-01T12:00:00Z");
  const pr = (over: object = {}) => ({ pull_request: { number: 500, title: "Add limits", state: "open", user: { login: "dana" }, body: "", created_at: "2026-09-30T10:00:00Z", updated_at: "2026-09-30T11:00:00Z", merged_at: null, ...over } });
  const send = (body: object, o: { id?: string; ts?: number; secret?: string; tamper?: boolean } = {}) => {
    const raw = JSON.stringify(body);
    const sig = createHmac("sha256", o.secret ?? secret).update(raw).digest("hex");
    return c.receiveWebhook({ secret, rawBody: o.tamper ? raw.replace("Add limits", "Add LIMITS") : raw, headers: { "X-Hub-Signature-256": `sha256=${sig}`, "X-Delivery-Id": o.id ?? "d-1", "X-Delivery-Timestamp": String(o.ts ?? NOW / 1000) } });
  };
  const first = send(pr());
  assert.deepEqual(first, { ok: true, applied: true, replayed: false });
  assert.equal(c.item("pull_request", 500)!.title, "Add limits");
  // Replays of the same delivery, however many times, change nothing.
  const again = send(pr({ title: "Changed in a replay" }));
  assert.deepEqual([again.ok && again.applied, again.ok && again.replayed], [false, true]);
  assert.equal(c.item("pull_request", 500)!.title, "Add limits");
  // Forged: wrong secret, or the body altered after signing.
  const forged = send(pr(), { id: "d-2", secret: "other" }); assert.ok(!forged.ok && forged.error.code === "UNAUTHORIZED");
  const tampered = send(pr(), { id: "d-3", tamper: true }); assert.ok(!tampered.ok && tampered.error.code === "UNAUTHORIZED");
  // A captured delivery re-sent hours later.
  const stale = send(pr(), { id: "d-4", ts: NOW / 1000 - 3 * 3600 }); assert.ok(!stale.ok && /too far from now/.test(stale.error.message));
  // A missing id is refused; an invalid record is set aside, and the delivery is still counted so it is not retried forever.
  const raw = JSON.stringify(pr());
  const noId = c.receiveWebhook({ secret, rawBody: raw, headers: { "X-Hub-Signature-256": "sha256=" + createHmac("sha256", secret).update(raw).digest("hex"), "X-Delivery-Timestamp": String(NOW / 1000) } });
  assert.ok(!noId.ok && noId.error.code === "INVALID_SCHEMA");
  const bad = send({ pull_request: { number: -1 } }, { id: "d-5" });
  assert.ok(bad.ok && !bad.applied && /set aside/.test(bad.reason!));
  assert.equal(send({ pull_request: { number: -1 } }, { id: "d-5" }).ok && (send({ pull_request: { number: -1 } }, { id: "d-5" }) as any).replayed, true);
  // An event older than what is stored does not roll the record back; a newer one does update it.
  const old = send(pr({ title: "Old state", updated_at: "2026-09-30T10:30:00Z" }), { id: "d-6" });
  assert.ok(old.ok && !old.applied && /newer version/.test(old.reason!));
  const newer = send(pr({ title: "Merged now", state: "closed", merged_at: "2026-10-01T11:00:00Z", updated_at: "2026-10-01T11:00:00Z" }), { id: "d-7" });
  assert.ok(newer.ok && newer.applied);
  assert.deepEqual([c.item("pull_request", 500)!.title, c.item("pull_request", 500)!.state], ["Merged now", "merged"]);
  assert.equal((store.db.prepare("select count(*) as n from ext_deliveries").get() as any).n, 4, "d-1, d-5, d-6, d-7");
});

test("untrusted repository and forge text is data: instructions in a pull request are stored and shown as quoted text, flagged untrusted, and never acted on", async () => {
  const { c } = mk({ transport: forge().transport });
  await c.ingestPullRequests();
  const pr = c.item("pull_request", 233)!;
  assert.match(pr.body, /IGNORE ALL PREVIOUS INSTRUCTIONS/, "kept exactly as written, so it can be read and cited");
  assert.equal(pr.untrusted, true);
  const { modelText } = await import("../src/claims.ts");
  assert.equal(modelText(pr.body, "[withheld]").replaced, true, "and when it reaches a place where words pass for findings, it is replaced");
});

test("a connected forge fills an evidence gap: archaeology quotes the pull request as untrusted text and no longer reports it missing, while unconnected references stay gaps", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { History } = await import("../src/history.ts");
  const { demoRepo, setup } = await import("./helpers.ts");
  const dir = demoRepo();
  const { svc, worker } = await setup(undefined, dir);
  writeFileSync(join(dir, "src/payments/fraud.ts"), readFileSync(join(dir, "src/payments/fraud.ts"), "utf8") + "\n// tightened\n");
  execFileSync("git", ["-C", dir, "-c", "user.name=Sam", "-c", "user.email=s@x", "commit", "-qam", "Tighten fraud threshold after chargebacks (#231)", "--date", "2026-09-20T09:00:00Z"], { env: { ...process.env, GIT_COMMITTER_DATE: "2026-09-20T09:00:00Z" } });
  writeFileSync(join(dir, "src/payments/fraud.ts"), readFileSync(join(dir, "src/payments/fraud.ts"), "utf8") + "// again\n");
  execFileSync("git", ["-C", dir, "-c", "user.name=Sam", "-c", "user.email=s@x", "commit", "-qam", "Velocity spikes, fixes #42", "--date", "2026-09-25T09:00:00Z"], { env: { ...process.env, GIT_COMMITTER_DATE: "2026-09-25T09:00:00Z" } });
  const rev = (await svc.ingestRepository({ requestId: "r", idempotencyKey: "r", actor: { principalId: "t", tenantId: "t", sessionId: "s" }, deadlineMs: Date.now() + 60_000, traceId: "r" }, { repoPath: dir }) as any).value.id;
  const h = new History(svc.store, svc.registry);
  const before = h.archaeology(rev, "function:src/payments/fraud.ts#checkFraud");
  assert.deepEqual(before.gaps.map((g) => g.ref).sort(), ["PR #231", "issue #42"]);
  const c = new ForgeConnector(svc.store, { sourceId: "forge", baseUrl: BASE, token: () => "t", transport: forge().transport });
  await c.ingestPullRequests();
  const after = h.archaeology(rev, "function:src/payments/fraud.ts#checkFraud");
  assert.deepEqual(after.gaps.map((g) => g.ref), ["issue #42"], "only what is still unavailable is a gap");
  assert.equal(after.fromForge.length, 1);
  assert.deepEqual([after.fromForge[0].ref, after.fromForge[0].title, after.fromForge[0].untrusted], ["PR #231", "Tighten fraud threshold after chargebacks", true]);
  assert.equal(svc.store.evidence(rev, after.fromForge[0].evidenceId)!.class, "DOCUMENT");
  assert.ok(after.narrative.every((n) => n.displayMode !== "FACT"), "what the PR says about why is still an inference");
  worker.close();
});
