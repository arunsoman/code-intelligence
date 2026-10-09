// C30: what leaves the system keeps what it was when it left; what the recipient may not see does not leave; withdrawn access reaches
// stored exports and queued notices; and a webhook that is retried is the same delivery, never a second one.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { buildExport, COPY_LIMIT, validateWebhookUrl, type Sender } from "../src/exports.ts";
import { ctx, demoRepo, setup } from "./helpers.ts";

async function world() {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  await svc.buildConceptHierarchy(ctx(), { revision });
  const a = await svc.ask(ctx(), { question: "show me everything that could cause a payment to fail", revision });
  const b = await svc.ask(ctx(), { question: "walk me through createPayment", revision });
  assert.ok(a.ok && b.ok);
  const claims = [...a.value.claims, ...b.value.claims];
  return { svc, worker, revision, repo, claims, ids: claims.map((c) => c.draft.id), rev: svc.store.revision(revision)! };
}

test("C30: an export preserves how each claim is known, its confidence, its state and the revision; refuted claims do not leave; the copy says it cannot be recalled", async () => {
  const w = await world();
  const hyp = w.claims.find((c) => c.displayMode === "HYPOTHESIS"), inf = w.claims.find((c) => c.displayMode === "INFERENCE"), fact = w.claims.find((c) => c.displayMode === "FACT");
  assert.ok(hyp && inf, "the fixtures produce hypotheses and inferences");
  // Refute one claim: it must not leave, and what depends on it is marked.
  const victim = w.claims.find((c) => c.displayMode === "INFERENCE" && c !== inf) ?? inf!;
  const dep = w.svc.verdict({ ...ctx(), actor: { principalId: "dana", tenantId: "t", sessionId: "s" } }, { claimId: victim.draft.id, verdict: "REFUTE", explanation: "wrong", expectedVersion: 1 });
  assert.ok(dep.ok);
  const out = await w.svc.exportOps["C30/exportClaims"](ctx(), { revision: w.revision, title: "Payment failure review", claimIds: w.ids, format: "markdown" });
  assert.ok(out.ok);
  const art = out.value as ReturnType<typeof buildExport>;
  assert.equal(art.manifest.revision, w.revision, "the revision it described");
  assert.equal(art.manifest.revisionIndexedAt, w.rev.createdAt);
  assert.ok(art.manifest.omitted.refuted >= 1, "the refuted claim was left out");
  assert.ok(!art.content.includes(victim.draft.assertion), "its text is not in the export");
  assert.ok(art.manifest.limits.includes(COPY_LIMIT) && /cannot be recalled/.test(art.content), "it says it is a copy");
  // Each exported claim carries its own labels, read from the stored claim.
  const json = (await w.svc.exportOps["C30/exportClaims"](ctx(), { revision: w.revision, title: "t", claimIds: w.ids, format: "json" })) as any;
  const parsed = JSON.parse(json.value.content);
  assert.ok(parsed.claims.length >= 2);
  for (const c of parsed.claims) {
    const stored = w.svc.store.getClaim(c.id)!;
    assert.equal(c.howKnown, { FACT: "Fact", INFERENCE: "Inference", HYPOTHESIS: "Hypothesis", FOG: "Fog" }[stored.displayMode as "FACT"]);
    assert.equal(c.state, stored.state);
    assert.ok(/^(Not estimated|Uncalibrated|Calibrated)/.test(c.confidence), `confidence is stated, even when it is "not estimated": ${c.confidence}`);
    assert.ok(c.evidence.length > 0 && c.evidence.every((e: any) => e.id && e.where && e.class), "evidence is listed by location");
    assert.ok(!/function\s|=>/.test(JSON.stringify(c.evidence)), "evidence is a reference, not copied code");
  }
  assert.ok(parsed.claims.some((c: any) => c.howKnown === "Hypothesis") && parsed.claims.some((c: any) => c.howKnown === "Inference"), "nothing was upgraded to look surer");
  assert.ok(!parsed.claims.some((c: any) => c.howKnown === "Fact" && !w.svc.store.getClaim(c.id)!.draft.evidenceIds.length));
  assert.match(art.content, /\*\*Confidence:\*\* (Not estimated|Uncalibrated)/);
  assert.match(art.content, /Claims marked Inference or Hypothesis are not proven/);
  assert.ok(parsed.manifest.limits.some((l: string) => /refuted claim\(s\) were left out/.test(l)));
  // A stale claim is labelled stale. A caller cannot pass a claim's own label: it is read from the store.
  const staleIds = (w.svc.store.dependents(victim.draft.id) as any[]).map((c) => c.draft.id);
  if (staleIds.length) { const again = await w.svc.exportOps["C30/exportClaims"](ctx(), { revision: w.revision, title: "t", claimIds: staleIds, format: "json" }) as any; assert.ok(JSON.parse(again.value.content).claims.every((c: any) => c.stale === (w.svc.store.getClaim(c.id)!.state === "STALE"))); }
  assert.equal(art.contentHash.length, 64);
  for (const bad of [{ title: "", claimIds: w.ids, format: "markdown" }, { title: "t", claimIds: [], format: "markdown" }, { title: "t", claimIds: w.ids, format: "pdf" }]) assert.ok(!(await w.svc.exportOps["C30/exportClaims"](ctx(), { revision: w.revision, ...bad })).ok);
  void fact;
  w.worker.close();
});

test("C30: code the recipient may not see does not leave: claims about it, their text and their evidence are removed, and the export says how many, not which", async () => {
  const w = await world();
  const open = buildExport(w.svc.store, w.rev, { title: "t", claimIds: w.ids, format: "json" });
  assert.ok(open.content.includes("checkFraud") || open.content.includes("fraud.ts"), "before: it mentions the fraud check");
  w.svc.store.denyPath(w.repo, "src/payments");
  const art = buildExport(w.svc.store, w.rev, { title: "t", claimIds: w.ids, format: "json" });
  for (const secret of ["checkFraud", "fraud.ts", "payment-service.ts", "velocity", "FraudRejectedError", "src/payments"]) assert.ok(!art.content.includes(secret), `"${secret}" left in the export`);
  assert.ok(art.manifest.omitted.inaccessible >= 1);
  assert.ok(art.manifest.limits.some((l) => /concerned code the recipient may not see and were left out/.test(l)));
  const md = buildExport(w.svc.store, w.rev, { title: "t", claimIds: w.ids, format: "markdown" });
  assert.ok(!/src\/payments|checkFraud/.test(md.content));
  // Evidence of an allowed claim that sits in denied code is dropped from its list, never shown.
  const parsed = JSON.parse(art.content);
  assert.ok(parsed.claims.every((c: any) => c.evidence.every((e: any) => !e.where.startsWith("src/payments"))));
  w.worker.close();
});

test("C30: revoked access reaches what was stored and what was queued: a stored export stops being readable, pending notices are cancelled, and nothing about the source is sent afterwards", async () => {
  const w = await world();
  const stored = await w.svc.exportOps["C30/exportClaims"](ctx(), { revision: w.revision, title: "t", claimIds: w.ids, format: "markdown" }) as any;
  assert.ok(stored.ok);
  const got = await w.svc.exportOps["C30/getExport"](ctx(), { exportId: stored.value.id }) as any;
  assert.ok(got.ok && got.value.content === stored.value.content);
  const sub = w.svc.notifications.subscribe({ url: "http://127.0.0.1:9/hook", secret: "s".repeat(20), events: ["verdict.recorded"], allowPrivate: true });
  const victim = w.claims.find((c) => c.displayMode === "INFERENCE")!;
  assert.ok(w.svc.verdict({ ...ctx(), actor: { principalId: "dana", tenantId: "t", sessionId: "s" } }, { claimId: victim.draft.id, verdict: "CONFIRM", explanation: "yes", expectedVersion: 1 }).ok);
  assert.equal(w.svc.notifications.deliveries().filter((d) => d.state === "PENDING").length, 1, "a notice about this source is queued");
  let sent = 0; w.svc.notifications.setSender(async () => { sent++; return { status: 200 }; });
  // Access is withdrawn before it is sent.
  assert.ok(w.svc.revokeSource(ctx(), { repoRoot: w.repo, purge: false }).ok);
  const after = await w.svc.exportOps["C30/getExport"](ctx(), { exportId: stored.value.id }) as any;
  assert.ok(!after.ok && after.error.code === "FORBIDDEN" && /withdrawn/.test(after.error.message), "the stored export is no longer readable");
  assert.ok(!(await w.svc.exportOps["C30/exportClaims"](ctx(), { revision: w.revision, title: "t", claimIds: w.ids, format: "markdown" })).ok, "and nothing new can be exported");
  const r = await w.svc.notifications.dispatch();
  assert.equal(sent, 0, "the queued notice was never sent");
  assert.equal(r.sent, 0);
  const d = w.svc.notifications.deliveries()[0];
  assert.equal(d.state, "CANCELLED");
  assert.ok(!d.payload.includes(victim.draft.id) && !/payment|fraud/i.test(d.payload), "even the stored payload no longer says anything about it");
  assert.ok(sub.id);
  // After the purge nothing remains.
  assert.ok(w.svc.revokeSource(ctx(), { repoRoot: w.repo }).ok);
  assert.equal(Number((w.svc.store.db.prepare("select count(*) n from exports").get() as any).n), 0);
  w.worker.close();
});

test("C30: a webhook retried after a lost reply is the same delivery: one record, one idempotency key, the receiver processes it once, and a second success is never recorded", async () => {
  const w = await world();
  // A real receiver: it processes each distinct Idempotency-Key once, and for the first attempt it processes the request but never answers.
  const seen: { key: string; sig: string; ts: string; body: string }[] = []; const effects = new Set<string>(); let attempt = 0; let received = 0;
  const srv = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      received++; attempt++;
      const key = String(req.headers["idempotency-key"]);
      seen.push({ key, sig: String(req.headers["x-cie-signature"]), ts: String(req.headers["x-cie-timestamp"]), body });
      effects.add(key); // processed, whatever happens to the reply
      if (attempt === 1) return; // the reply is lost: no response at all
      res.writeHead(200); res.end("ok");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`;
  const secret = "topsecret-signing-key";
  const n = w.svc.notifications; n.backoffMs = () => 10;
  const sub = n.subscribe({ url, secret, events: ["verdict.recorded"], allowPrivate: true });
  const claim = w.claims.find((c) => c.displayMode === "INFERENCE")!;
  const who = { ...ctx(), actor: { principalId: "dana", tenantId: "t", sessionId: "s" } };
  assert.ok(w.svc.verdict(who, { claimId: claim.draft.id, verdict: "CONFIRM", explanation: "yes", expectedVersion: 1 }).ok);
  // The same event published again (a replayed outbox) creates nothing new.
  assert.equal(n.publish({ eventId: `verdict:${claim.draft.id}:2`, type: "verdict.recorded", revision: w.revision, summary: "again" }), 0);
  assert.equal(n.deliveries().length, 1);
  const first = await n.dispatch(Date.now(), 150);
  assert.deepEqual([first.sent, first.delivered, first.retried], [1, 0, 1], "no answer within the timeout: a retry is scheduled, not a failure recorded");
  assert.equal(n.deliveries()[0].state, "PENDING");
  assert.match(n.deliveries()[0].lastError!, /no answer within the timeout/);
  await new Promise((r) => setTimeout(r, 30));
  const second = await n.dispatch(Date.now(), 1000);
  assert.deepEqual([second.sent, second.delivered], [1, 1]);
  const d = n.deliveries()[0];
  assert.equal(d.state, "DELIVERED"); assert.equal(d.attempts, 2);
  assert.equal(received, 2, "the receiver saw two requests");
  assert.equal(effects.size, 1, "but they were one delivery: the same idempotency key, so one effect");
  assert.equal(seen[0].key, seen[1].key); assert.equal(seen[0].key, d.deliveryId);
  // Signed: the receiver can check the payload and the time.
  const expected = createHmac("sha256", secret).update(`${seen[1].ts}.${seen[1].body}`).digest("hex");
  assert.equal(seen[1].sig, `sha256=${expected}`);
  const payload = JSON.parse(seen[1].body);
  assert.deepEqual(Object.keys(payload).sort(), ["event", "eventId", "id", "links", "revision", "summary"], "ids, a sentence and links: no code, no names");
  // Delivered is final: nothing is sent again, however often it is dispatched.
  for (let i = 0; i < 3; i++) await n.dispatch(Date.now() + 10_000);
  assert.equal(received, 2);
  assert.equal(n.deliveries().filter((x) => x.state === "DELIVERED").length, 1);
  // Two dispatchers at once do not send the same delivery twice.
  const claim2 = w.claims.filter((c) => c.displayMode === "INFERENCE")[1] ?? claim;
  n.publish({ eventId: "e2", type: "verdict.recorded", revision: w.revision, summary: "second event" });
  let inflight = 0, maxInflight = 0; n.setSender(async () => { inflight++; maxInflight = Math.max(maxInflight, inflight); await new Promise((r) => setTimeout(r, 40)); inflight--; return { status: 200 }; });
  await Promise.all([n.dispatch(Date.now()), n.dispatch(Date.now()), n.dispatch(Date.now())]);
  assert.equal(maxInflight, 1, "the delivery was claimed once");
  assert.equal(n.deliveries().filter((x) => x.eventId === "e2").length, 1);
  void claim2; void sub;
  srv.close(); w.worker.close();
});

test("C30: webhook failures are classified: the receiver rejecting is final, a server error is retried with backoff and ends dead after the attempts, unsafe URLs and weak secrets are refused, and unsubscribing cancels what is queued", async () => {
  const w = await world();
  const n = w.svc.notifications; n.backoffMs = (a) => a * 10; n.maxAttempts = 3;
  const sub = n.subscribe({ url: "http://127.0.0.1:9/x", secret: "k".repeat(20), events: ["verdict.recorded", "investigation.completed"], allowPrivate: true });
  const post = (type: string, id: string) => n.publish({ eventId: id, type, revision: w.revision, summary: "s" });
  const statuses: number[] = [];
  const answer = (...codes: number[]): Sender => async () => { const s = codes[Math.min(statuses.length, codes.length - 1)]; statuses.push(s); return { status: s }; };
  // 4xx: the receiver refused it; retrying cannot help.
  n.setSender(answer(400)); post("verdict.recorded", "a"); await n.dispatch(Date.now());
  assert.deepEqual([n.deliveries()[0].state, n.deliveries()[0].lastError], ["DEAD", "rejected with 400"]);
  // 5xx: retried with growing delay, then dead.
  statuses.length = 0; n.setSender(answer(503)); post("verdict.recorded", "b");
  let t = Date.now();
  for (let i = 0; i < 6; i++) { await n.dispatch(t); t += 1000; }
  const b = n.deliveries().find((d) => d.eventId === "b")!;
  assert.equal(b.state, "DEAD"); assert.equal(b.attempts, 3, "stopped at the attempt limit"); assert.equal(statuses.length, 3);
  // 429 and 408 are retried, not final.
  statuses.length = 0; n.setSender(answer(429, 200)); post("verdict.recorded", "c");
  await n.dispatch(Date.now()); assert.equal(n.deliveries().find((d) => d.eventId === "c")!.state, "PENDING");
  await n.dispatch(Date.now() + 5000); assert.equal(n.deliveries().find((d) => d.eventId === "c")!.state, "DELIVERED");
  // Events a subscription did not ask for create nothing.
  assert.equal(n.publish({ eventId: "z", type: "something.else", revision: null, summary: "s" }), 0);
  // Unsafe destinations and weak secrets.
  for (const [url, re] of [["http://example.com/x", /https/], ["https://127.0.0.1/x", /private or loopback/], ["https://10.0.0.5/x", /private or loopback/], ["https://169.254.169.254/latest", /private|metadata/], ["https://user:pw@example.com/x", /credentials/], ["notaurl", /not a URL/]] as const)
    assert.throws(() => validateWebhookUrl(url, false), re, url);
  assert.doesNotThrow(() => validateWebhookUrl("https://hooks.example.com/x", false));
  assert.throws(() => n.subscribe({ url: "https://hooks.example.com/x", secret: "short", events: ["verdict.recorded"] }), /at least 16 characters/);
  assert.throws(() => n.subscribe({ url: "https://hooks.example.com/x", secret: "k".repeat(20), events: [] }), /at least one event/);
  // Unsubscribing cancels what is queued.
  statuses.length = 0; n.setSender(answer(500)); post("investigation.completed", "d");
  n.unsubscribe(sub.id);
  assert.equal(n.deliveries().find((d) => d.eventId === "d")!.state, "CANCELLED");
  await n.dispatch(Date.now() + 100_000); assert.equal(statuses.length, 0);
  w.worker.close();
});
