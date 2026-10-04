import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyContextEvent, currentSequence } from "../src/context.ts";
import { LIMITS, Runtime, type RtSpan, type RuntimeEnvelope } from "../src/runtime.ts";
import { buildRuntime } from "../src/forms/runtime.ts";
import { ctx, demoRepo, setup } from "./helpers.ts";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const NOW = T0 + 3_600_000;
const FRAUD = "function:src/payments/fraud.ts#checkFraud";
const span = (id: string, o: Partial<RtSpan> = {}): RtSpan => ({ traceId: "t1", spanId: id, name: "fraud.check", startMs: T0 + Number(id.replace(/\D/g, "")) * 100, endMs: T0 + Number(id.replace(/\D/g, "")) * 100 + 20, file: "src/payments/fraud.ts", line: 5, fn: "checkFraud", ...o });
const env = (id: string, spans: RtSpan[], o: Partial<RuntimeEnvelope> = {}): RuntimeEnvelope => ({ id, sourceId: "api", window: { from: T0, to: T0 + 60_000 }, backendHandle: "tempo://tenant/api", signalKind: "trace", spans, ...o });
async function world() {
  const dir = demoRepo();
  const t = await setup(undefined, dir);
  const rt = new Runtime(t.svc.store, t.svc.registry, () => NOW);
  return { ...t, dir, rt };
}
const att = (a: any) => { assert.ok(!("ok" in a), JSON.stringify(a)); return a as import("../src/runtime.ts").RuntimeAttribution; };

test("replay bounds span start times, preserves uncertainty, and ingested envelopes populate the runtime map", async () => {
  const { rt, revision, worker, svc } = await world();
  try {
    rt.ingest(env("bounded", [span("s1"), span("s2", { error: true }), span("s3")], { codeRevision: revision, samplingRate: 0.5 }));
    const window = { from: T0 + 150, to: T0 + 250 };
    const result = rt.replay(revision, window, T0 + 900);
    assert.equal(result.cursorMs, window.to);
    assert.deepEqual(result.entities, [{ entityId: FRAUD, spans: 1, errors: 1 }]);
    assert.ok(result.warnings.some((w) => /sampled/i.test(w)));
    assert.ok(result.warnings.some((w) => /no deployment marker/i.test(w)));
    assert.deepEqual(rt.replay(revision, window, T0).entities, []);
    assert.equal(rt.queryWindow(revision, window)[0].perEntity[0].spans, 1);
    const map = buildRuntime(svc.store, svc.store.revision(revision)!, "recorded runtime", "all");
    const node = map.view.nodes.find((n) => n.entityRefs.includes(FRAUD));
    assert.ok(node, "runtime intake must be visible even without pasted exceptions or trace files");
    assert.notEqual(node.displayMode, "FACT", "a hotspot interpretation is not promoted to fact");
    assert.ok(node.evidenceIds.length > 0);
    assert.ok(map.view.gaps.some((g) => /sampled/i.test(g)));
  } finally { worker.close(); }
});

test("replay rejects invalid windows and unknown revisions through the service", async () => {
  const { svc, revision, worker } = await world();
  try {
    for (const body of [{ revision, cursor: 0 }, { revision, window: { from: 5, to: 1 }, cursor: 2 }, { revision, window: { from: 0, to: 100 }, cursor: NaN }]) {
      const result = svc.runtimeOps["C24/replay"](ctx(), body);
      assert.ok(!result.ok && result.error.code === "INVALID_SCHEMA");
    }
    const missing = svc.runtimeOps["C24/replay"](ctx(), { revision: "missing", window: { from: 0, to: 100 }, cursor: 50 });
    assert.ok(!missing.ok && missing.error.code === "NOT_FOUND");
  } finally { worker.close(); }
});

test("missing marker: with no deployment marker or revision nothing is attributed (fog); a revision the signal merely claims is not exact; marker plus revision plus code location is", async () => {
  const { rt, revision, worker } = await world();
  const spans = [span("s1"), span("s2", { error: true }), span("s3")];
  assert.ok(rt.ingest(env("e-none", spans)).ok);
  const none = att(rt.attribute("e-none", revision));
  assert.equal(none.method, "UNATTRIBUTED"); assert.equal(none.exact, false);
  assert.deepEqual(none.entityRefs, []);
  assert.equal(none.fog.spans, 3);
  assert.match(none.uncertaintyReason!, /no deployment marker or revision/);
  assert.ok(none.quality.includes("NO_DEPLOYMENT_MARKER"));
  // The signal says which revision it ran, but nothing independent confirms it.
  rt.ingest(env("e-claim", spans, { codeRevision: revision }));
  const claimed = att(rt.attribute("e-claim", revision));
  assert.deepEqual(claimed.entityRefs, [FRAUD]);
  assert.equal(claimed.exact, false, "a self-declared revision is not a deterministic join");
  assert.match(claimed.uncertaintyReason!, /claimed by the signal itself/);
  // An authoritative deployment marker makes the same spans exact.
  rt.recordMarker({ sourceId: "api", deploymentId: "dep-7", revision, at: T0 - 1000 });
  rt.ingest(env("e-exact", spans, { deploymentId: "dep-7", codeRevision: revision }));
  const exact = att(rt.attribute("e-exact", revision));
  assert.equal(exact.exact, true); assert.equal(exact.method, "CODE_LOCATION_EXACT"); assert.equal(exact.uncertaintyReason, null);
  assert.deepEqual(exact.perEntity.map((p) => [p.entityId, p.spans, p.errors, p.exact]), [[FRAUD, 3, 1, true]]);
  for (const id of exact.evidenceIds) assert.equal(rt.store.evidence(revision, id)!.class, "RUNTIME");
  worker.close();
});

test("impossible timestamp: spans that end before they start or sit in the future are counted, kept out of every statistic, and flagged", async () => {
  const { rt, revision, worker } = await world();
  rt.recordMarker({ sourceId: "api", deploymentId: "d", revision, at: 0 });
  const good = [span("s1"), span("s2"), span("s3")];
  const bad = [span("s4", { startMs: T0 + 900, endMs: T0 + 100 }), span("s5", { startMs: NOW + 86_400_000, endMs: NOW + 86_400_050 }), span("s6", { startMs: NaN }), span("s7", { startMs: -5, endMs: 10 })];
  const r = rt.ingest(env("e-ts", [...good, ...bad], { deploymentId: "d", codeRevision: revision }));
  assert.ok(r.ok && r.quality.includes("TIMESTAMP_IMPOSSIBLE:4"), JSON.stringify(r));
  const a = att(rt.attribute("e-ts", revision));
  assert.equal(a.counted.valid, 3); assert.equal(a.counted.invalid, 4);
  assert.equal(a.perEntity[0].spans, 3, "bad spans are not counted as traffic");
  assert.equal(a.perEntity[0].p95Ms, 20, "and do not skew latency");
  worker.close();
});

test("sampling: a sampled signal reports estimates, labelled as such, and is never exact", async () => {
  const { rt, revision, worker } = await world();
  rt.recordMarker({ sourceId: "api", deploymentId: "d", revision, at: 0 });
  rt.ingest(env("e-s", [span("s1"), span("s2")], { deploymentId: "d", codeRevision: revision, samplingRate: 0.1 }));
  const a = att(rt.attribute("e-s", revision));
  assert.equal(a.samplingRate, 0.1);
  assert.equal(a.perEntity[0].spans, 2);
  assert.equal(a.perEntity[0].estimatedSpans, 20);
  assert.equal(a.perEntity[0].exact, false);
  assert.equal(a.exact, false);
  assert.match(a.uncertaintyReason!, /sampled at 0\.1: counts are estimates/);
  // Unsampled (rate 1) is exact.
  rt.ingest(env("e-u", [span("s1")], { deploymentId: "d", codeRevision: revision, samplingRate: 1 }));
  const u = att(rt.attribute("e-u", revision));
  assert.equal(u.samplingRate, null); assert.equal(u.exact, true); assert.equal(u.perEntity[0].estimatedSpans, null);
  worker.close();
});

test("out-of-order spans: arrival order does not change the attribution, disorder is flagged, and a missing parent is noted until it arrives", async () => {
  const { rt, revision, worker } = await world();
  rt.recordMarker({ sourceId: "api", deploymentId: "d", revision, at: 0 });
  const ordered = [span("s1"), span("s2", { parentId: "s1" }), span("s3", { parentId: "s2", error: true }), span("s4", { parentId: "s1" })];
  const shuffled = [ordered[3], ordered[1], ordered[2], ordered[0]];
  const a = rt.ingest(env("e-o", ordered, { deploymentId: "d", codeRevision: revision }));
  const b = rt.ingest(env("e-r", shuffled, { deploymentId: "d", codeRevision: revision }));
  assert.ok(a.ok && b.ok);
  assert.ok(!a.quality.some((q) => q.startsWith("OUT_OF_ORDER")));
  assert.ok(b.quality.some((q) => /^OUT_OF_ORDER:[1-9]/.test(q)), b.quality.join());
  const strip = (x: any) => JSON.stringify(x.perEntity);
  assert.equal(strip(att(rt.attribute("e-o", revision))), strip(att(rt.attribute("e-r", revision))));
  // A child whose parent is in a later envelope.
  const lone = rt.ingest(env("e-c", [span("s9", { traceId: "t9", parentId: "s8" })], { deploymentId: "d", codeRevision: revision }));
  assert.ok(lone.ok && lone.quality.includes("PARENT_MISSING:1"));
  rt.ingest(env("e-p", [span("s8", { traceId: "t9" })], { deploymentId: "d", codeRevision: revision }));
  const late = rt.ingest(env("e-c2", [span("s10", { traceId: "t9", parentId: "s8" })], { deploymentId: "d", codeRevision: revision }));
  assert.ok(late.ok && !late.quality.some((q) => q.startsWith("PARENT_MISSING")), "once the parent has arrived it is not missing");
  worker.close();
});

test("revision mismatch: spans from an older revision are joined through identity lineage, labelled inexact; code that no longer exists is fog", async () => {
  const { rt, revision: r1, worker, dir, svc } = await world();
  rt.recordMarker({ sourceId: "api", deploymentId: "old", revision: r1, at: 0 });
  rt.ingest(env("e-old", [span("s1"), span("s2", { fn: "adjustBalance", file: "src/ledger/ledger.ts", line: 28 }), span("s3", { fn: "reserve", file: "src/ledger/ledger.ts", line: 12 })], { deploymentId: "old", codeRevision: r1 }));
  // The current revision renames checkFraud and deletes adjustBalance.
  const edit = (rel: string, f: (s: string) => string) => writeFileSync(join(dir, rel), f(readFileSync(join(dir, rel), "utf8")));
  edit("src/payments/fraud.ts", (s) => s.replaceAll("checkFraud", "screenPayment")); edit("src/payments/payment-service.ts", (s) => s.replaceAll("checkFraud", "screenPayment")); edit("tests/payment-service.test.ts", (s) => s.replaceAll("checkFraud", "screenPayment"));
  edit("src/ledger/ledger.ts", (s) => s.slice(0, s.indexOf("// Used by background jobs"))); edit("src/jobs/reconciler.ts", (s) => s.replace(/adjustBalance/g, "getAccount"));
  const r2 = (await svc.ingestRepository(ctx(), { repoPath: dir }) as any).value.id;
  const a = att(rt.attribute("e-old", r2));
  const byId = new Map(a.perEntity.map((p) => [p.entityId, p]));
  assert.ok(byId.has("function:src/payments/fraud.ts#screenPayment"), `${[...byId.keys()]}`);
  assert.equal(byId.get("function:src/payments/fraud.ts#screenPayment")!.method, "CODE_LOCATION_OTHER_REVISION");
  assert.equal(byId.get("function:src/payments/fraud.ts#screenPayment")!.exact, false);
  assert.ok(byId.has("function:src/ledger/ledger.ts#reserve"), "unchanged code is still found");
  assert.ok(![...byId.keys()].some((k) => /adjustBalance/.test(k)));
  assert.equal(a.fog.spans, 1);
  assert.ok(a.fog.reasons.some((r) => /adjustBalance.*no longer exists/.test(r)));
  assert.equal(a.exact, false);
  assert.match(a.uncertaintyReason!, new RegExp(`ran revision ${r1}, not ${r2}`));
  worker.close();
});

test("replay and backpressure: ingest is idempotent, oversize and over-capacity are refused as retryable, and scrubbing to a time is deterministic and monotone", async () => {
  const { rt, revision, worker } = await world();
  rt.recordMarker({ sourceId: "api", deploymentId: "d", revision, at: 0 });
  const spans = Array.from({ length: 10 }, (_, i) => span(`s${i + 1}`));
  const e = env("e-1", spans, { deploymentId: "d", codeRevision: revision });
  const first = rt.ingest(e), again = rt.ingest(e);
  assert.ok(first.ok && !first.replayed && again.ok && again.replayed);
  const conflict = rt.ingest({ ...e, spans: spans.slice(0, 5) });
  assert.ok(!conflict.ok && conflict.error.code === "VERSION_CONFLICT");
  const big = rt.ingest(env("e-big", Array.from({ length: LIMITS.maxSpansPerEnvelope + 1 }, (_, i) => span(`s${i}`)), { deploymentId: "d" }));
  assert.ok(!big.ok && big.error.code === "RESOURCE_LIMIT" && big.error.retryable);
  // Fill the per-source budget; the next envelope is refused with a retryable error and nothing is stored for it.
  for (let i = 0; i < 4; i++) assert.ok(rt.ingest(env(`fill-${i}`, Array.from({ length: i < 3 ? LIMITS.maxSpansPerEnvelope : LIMITS.maxSpansPerEnvelope - 10 }, (_, k) => span(`f${i}-${k}`, { traceId: `tf${i}` })), { deploymentId: "d", codeRevision: revision })).ok);
  const full = rt.ingest(env("e-over", [span("s1")], { deploymentId: "d" }));
  assert.ok(!full.ok && full.error.code === "RESOURCE_LIMIT" && full.error.retryable && /retry after/.test(full.error.message));
  assert.equal((rt.store.db.prepare("select count(*) as n from rt_envelopes where id = 'e-over'").get() as any).n, 0);
  // Scrubbing: the same cursor gives the same picture, later cursors never show less.
  const win = { from: T0, to: T0 + 60_000 };
  const at = (c: number) => rt.replay(revision, win, c);
  assert.deepEqual(at(T0 + 450), at(T0 + 450));
  const counts = [T0 + 150, T0 + 450, T0 + 1050, T0 + 59_000].map((c) => at(c).entities.find((x) => x.entityId === FRAUD)?.spans ?? 0);
  assert.deepEqual(counts, [...counts].sort((a, b) => a - b), "monotone");
  assert.ok(counts[0] < counts[2], `${counts}`);
  assert.deepEqual(rt.queryWindow(revision, win, ["function:src/ledger/ledger.ts#reserve"]), []);
  assert.ok(rt.queryWindow(revision, win, [FRAUD]).length >= 1);
  worker.close();
});

test("runtime signals matching what the person is looking at become context events; ones elsewhere are not pushed", async () => {
  const { rt, revision, worker, svc } = await world();
  rt.recordMarker({ sourceId: "api", deploymentId: "d", revision, at: 0 });
  rt.ingest(env("e-n", [span("s1", { error: true })], { deploymentId: "d", codeRevision: revision }));
  const a = att(rt.attribute("e-n", revision));
  const S = "sess";
  const quiet = rt.notifyRelevantContext(S, a);
  assert.deepEqual(quiet.relevant, [], "nothing in their context matches");
  applyContextEvent(svc.store, S, { event: { kind: "FOCUS", entityId: FRAUD }, expectedSequence: currentSequence(svc.store, S) });
  const hit = rt.notifyRelevantContext(S, a);
  assert.deepEqual(hit.relevant, [FRAUD]);
  assert.ok(hit.snapshot.actions.includes("RUNTIME"));
  worker.close();
});
