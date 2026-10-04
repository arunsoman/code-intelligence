import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RETENTION, LENSES, applyContextEvent, currentSequence, getPolicy, setMemoryPolicy, snapshotAt, sessionSnapshot, type ContextEvent } from "../src/context.ts";
import { retrieveForQuestion } from "../src/retrieval.ts";
import { ctx, demoRepo, setup, traceFor } from "./helpers.ts";

const FRAUD = "function:src/payments/fraud.ts#checkFraud";
const ev = (store: any, s: string, e: ContextEvent, at?: () => string) => { const r = applyContextEvent(store, s, { event: e, expectedSequence: currentSequence(store, s) }, at); assert.ok(r.ok, JSON.stringify(r)); return (r as any).snapshot; };

test("All six salience factors: each is reported for every element, with a reason, and each one moves a score when its signal is present", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  await svc.extractConcepts(ctx(), { revision });
  svc.reportException(ctx(), { trace: traceFor(repo), source: "api-server" });
  svc.setOverride(ctx(), { revision, entityId: FRAUD, mode: "pin" });
  const r = await svc.ask(ctx(), { question: "how do fraud checks and payments work", revision });
  assert.ok(r.ok);
  const nodes = r.value.view.nodes.filter((n) => n.factors?.length);
  assert.ok(nodes.length > 3);
  const names = ["TASK_MATCH", "RECENCY", "STRUCTURAL_CENTRALITY", "RUNTIME_HOTNESS", "USER_OVERRIDE", "SEMANTIC_JUDGMENT"];
  for (const n of nodes) {
    assert.deepEqual(names.filter((f) => !n.factors!.some((x) => x.factor === f)), [], n.label);
    for (const f of n.factors!) assert.ok(f.reason.length > 0 && f.normalizedScore >= 0 && f.normalizedScore <= 1);
  }
  for (const f of names) assert.ok(nodes.some((n) => n.factors!.find((x) => x.factor === f)!.normalizedScore > 0), `${f} never contributes`);
  worker.close();
});

test("why-hidden query: a hidden element is explained from its factor scores, and an unknown name says nothing matches", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const r = await svc.ask(ctx(), { question: "how do refunds work", revision });
  assert.ok(r.ok && !r.value.view.nodes.some((n) => n.label === "checkFraud"));
  const why = svc.whyHidden(ctx(), { view: r.value.view, query: "checkFraud" });
  assert.ok(why.ok);
  assert.match(why.value.summary, /checkFraud/);
  assert.match(why.value.summary, /relevance \d\.\d\d|:/);
  const none = svc.whyHidden(ctx(), { view: r.value.view, query: "doesNotExistAnywhere" });
  assert.ok(none.ok && /Nothing in this repository is named like/.test(none.value.summary));
  worker.close();
});

test("pin override: a pin forces CRITICAL presence under every lens", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  svc.setOverride(ctx(), { revision, entityId: FRAUD, mode: "pin" });
  for (const lens of Object.keys(LENSES)) {
    const rt = retrieveForQuestion(svc.store, revision, "how do refunds work", { lens, pins: new Set() });
    assert.equal(rt.scored.get(FRAUD)?.tier, "CRITICAL", lens);
  }
  worker.close();
});

test("retention: working memory is bounded, older events lose their text, expired ones lose their payload, counts survive, and the sequence stays gap-free", async () => {
  const { svc, worker } = await setup();
  const s = "sess-ret";
  assert.ok(setMemoryPolicy(svc.store, { policy: { workingEvents: 3, episodicMaxAgeMs: 1000, maxPayloadChars: 400 }, expectedVersion: 0 }).ok);
  assert.ok(!setMemoryPolicy(svc.store, { policy: DEFAULT_RETENTION, expectedVersion: 0 }).ok, "stale policy version is rejected");
  assert.ok(!setMemoryPolicy(svc.store, { policy: { workingEvents: 0, episodicMaxAgeMs: 1, maxPayloadChars: 1 }, expectedVersion: 1 }).ok);
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const at = (ms: number) => () => new Date(t0 + ms).toISOString();
  ev(svc.store, s, { kind: "QUERY", text: "how does login work" }, at(0));
  ev(svc.store, s, { kind: "FOCUS", entityId: FRAUD }, at(1));
  ev(svc.store, s, { kind: "FOCUS", entityId: FRAUD }, at(2));
  ev(svc.store, s, { kind: "EDIT", file: "a.ts" }, at(3));
  const mid = ev(svc.store, s, { kind: "EDIT", file: "b.ts" }, at(4));
  const tiers = (svc.store.db.prepare("select seq, tier, payload from ctx_events where session = ? order by seq").all(s) as any[]);
  assert.deepEqual(tiers.map((r) => r.tier), ["EPISODIC", "EPISODIC", "WORKING", "WORKING", "WORKING"]);
  assert.match(tiers[0].payload, /text dropped/);
  assert.deepEqual(mid.recentQueries, ["[episodic: text dropped]"]);
  // Long after: episodic events expire entirely.
  const late = ev(svc.store, s, { kind: "EDIT", file: "c.ts" }, at(10_000));
  const expired = (svc.store.db.prepare("select seq, tier, payload from ctx_events where session = ? order by seq").all(s) as any[]);
  assert.deepEqual(expired.map((r) => r.tier), ["EXPIRED", "EXPIRED", "EXPIRED", "WORKING", "WORKING", "WORKING"]);
  assert.ok(expired.filter((r) => r.tier === "EXPIRED").every((r) => r.payload === null));
  assert.deepEqual(expired.map((r) => r.seq), [1, 2, 3, 4, 5, 6], "no gaps");
  assert.ok(late.pruned >= 1);
  assert.ok(getPolicy(svc.store).version === 1);
  worker.close();
});

test("applyContextEvent: ordering is enforced, sensitive text is minimised before storage, and snapshots replay deterministically", async () => {
  const { svc, worker } = await setup();
  const s = "sess-order";
  ev(svc.store, s, { kind: "QUERY", text: "how does login work" });
  const stale = applyContextEvent(svc.store, s, { event: { kind: "FOCUS", entityId: "x" }, expectedSequence: 0 });
  assert.ok(!stale.ok && stale.error.code === "VERSION_CONFLICT", "a reordered or repeated event is rejected");
  const ahead = applyContextEvent(svc.store, s, { event: { kind: "FOCUS", entityId: "x" }, expectedSequence: 5 });
  assert.ok(!ahead.ok, "a gap is rejected");
  const secret = "token = sk_live_" + "A1b2C3d4".repeat(5);
  const snap = ev(svc.store, s, { kind: "PASTE", text: secret });
  assert.equal(snap.minimised, 1);
  const stored = JSON.stringify(svc.store.db.prepare("select * from ctx_events where session = ?").all(s));
  assert.ok(!stored.includes("sk_live_"), "the raw secret is never stored");
  ev(svc.store, s, { kind: "FOCUS", entityId: FRAUD });
  ev(svc.store, s, { kind: "SELECT", entityIds: [FRAUD, "b"] });
  const full = sessionSnapshot(svc.store, s);
  assert.equal(full.focus, FRAUD); assert.deepEqual(full.selection, [FRAUD, "b"]);
  assert.deepEqual(snapshotAt(svc.store, s, 1).focus, null);
  assert.deepEqual(snapshotAt(svc.store, s, 3), snapshotAt(svc.store, s, 3));
  assert.equal(snapshotAt(svc.store, s, 3).focus, FRAUD);
  assert.ok(!applyContextEvent(svc.store, s, { event: { kind: "LENS", lensId: "nope" }, expectedSequence: 4 }).ok);
  worker.close();
});

test("persona fidelity: lenses reorder elements, but anything a failing test, exception or pin points at is never hidden by one", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const q = "how do refunds work";
  const byLens = (lens: string) => retrieveForQuestion(svc.store, revision, q, { lens });
  const order = (lens: string) => [...byLens(lens).scored.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 8).map((s) => s.id);
  assert.notDeepEqual(order("newcomer"), order("reviewer"), "different lenses rank differently");
  // checkFraud is far from this question. Make it a safety fact.
  svc.reportException(ctx(), { trace: traceFor(repo), source: "api-server" });
  svc.reportException(ctx(), { trace: traceFor(repo), source: "api-server" });
  for (const lens of Object.keys(LENSES).filter((l) => l !== "default")) {
    const t = byLens(lens).scored.get(FRAUD)!;
    assert.ok(t.tier === "RELEVANT" || t.tier === "CRITICAL", `${lens} must keep code a reported exception points at at RELEVANT or above, got ${t.tier}`);
    assert.ok(t.factors.find((f) => f.factor === "RUNTIME_HOTNESS")!.normalizedScore >= 0.5);
  }
  worker.close();
});

test("event-to-context latency: applying an event and rebuilding the snapshot stays within 50 ms at p95 over 300 events", async () => {
  const { svc, worker } = await setup();
  const s = "sess-lat";
  const times: number[] = [];
  for (let i = 0; i < 300; i++) {
    const t = performance.now();
    const r = applyContextEvent(svc.store, s, { event: i % 3 ? { kind: "FOCUS", entityId: `e${i % 17}` } : { kind: "QUERY", text: `q${i}` }, expectedSequence: i });
    assert.ok(r.ok);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  assert.ok(p95 < 50, `p95 ${p95.toFixed(1)}ms`);
  worker.close();
});
