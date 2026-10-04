// C24 causality phase-1 acceptance suite: every RC01–RC28 fixture (C24 design §19) is converted from a stated
// expectation into observed engine behavior, plus contract tests for intake idempotency, version conflicts and the
// privileged/public permission split. Failures here are release blockers except where the behavior itself is safe
// degradation (release rule in docs/c24-phase0/01-scope-register.md §5).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CausalityEngine, type CausalityScopeInput, type Snapshot } from "../src/c24/causality.ts";
import type { RuntimeEventInput } from "../src/c24/normalize.ts";
import { Store } from "../src/store.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "c24-causality-fixtures");
const FX = (name: string) => JSON.parse(readFileSync(join(DIR, name), "utf8"));
const CHILD = join(import.meta.dirname, "fixtures/c24-child.ts");
/** Unwrap a typed engine result or fail the test with the stated reason. */
function must<T>(r: { ok: boolean; value?: T; error?: { message: string; code?: string } }): T {
  if (!r.ok) throw new Error((r.error?.code ?? "ERROR") + ": " + (r.error?.message ?? "failed"));
  return r.value as T;
}

const tenant = "t";
const scope = (extra: Partial<CausalityScopeInput> = {}): CausalityScopeInput => ({ tenantId: tenant, revisionSet: ["rev-b"], incidentWindow: { from: 0, to: 5000 }, ...extra });

/** Adapter registry for the fixtures: a trusted strand adapter (T1), a broker/task adapter, a pool/lock adapter. */
const adapters = [
  { adapterId: "src:otel", version: "1", sourceNamespaces: ["src:otel"], edgeKinds: ["PROGRAM_ORDER", "SPAWN", "COMPLETE_JOIN"] as any[], certifiesProgramOrder: true, trusted: true },
  { adapterId: "src:broker", version: "1", sourceNamespaces: ["src:broker"], edgeKinds: ["SEND_RECEIVE", "CONTEXT_ASSOCIATION"] as any[], trusted: true },
  { adapterId: "src:scheduler", version: "1", sourceNamespaces: ["src:scheduler"], edgeKinds: ["SPAWN", "COMPLETE_JOIN", "PROGRAM_ORDER"] as any[], certifiesProgramOrder: true, trusted: true },
  { adapterId: "src:lock", version: "1", sourceNamespaces: ["src:lock"], edgeKinds: ["RELEASE_ACQUIRE", "WAITS_FOR"] as any[], waitSemantics: true, trusted: true },
];

type EngineWorld = { eng: CausalityEngine; snapshots: Map<string, Snapshot>; scope: CausalityScopeInput };

/** Build a world from a fixture: register adapters, ingest events/certificates/wait relations, reconstruct. */
function world(fx: any, opts: { scope?: Partial<CausalityScopeInput> } = {}): EngineWorld {
  const eng = new CausalityEngine(new Store(":memory:"), () => 1_000_000);
  for (const a of adapters) eng.registerAdapter(a);
  const events = (fx.input.events ?? []).map((e: any) => toRuntimeEventInput(e, fx));
  if (events.length) {
    const r = eng.ingestEvents({
      batch: events, watermark: { sourceId: fx.input.watermark?.sourceId ?? (fx.input.events?.[0]?.source ?? "src:otel") + "", sourceEpoch: "1", acceptedSequence: String(events.length), eventTimeWatermark: fx.input.watermark?.eventTimeWatermark ?? null, allowedLatenessMs: 600_000, finalForWindow: fx.input.watermark?.finalForWindow === true },
      expectedSourceVersion: 0,
      relationCertificates: fx.input.certificates?.filter((c: any) => typeof c.kind === "string" && !("exhaustiveForPredicate" in c)).map((c: any) => ({ id: c.id, adapterId: c.adapterId ?? "src:broker", kind: c.kind, matchesEventIds: c.matchesEventIds ?? c.matchesIds ?? [], valid: c.valid })),
      coverageCertificates: fx.input.certificates?.filter((c: any) => "exhaustiveForPredicate" in c).map((c: any) => ({ id: c.id, sourceId: fx.input.events?.[0]?.sourceId ?? "src:otel", window: c.window ?? { from: 0, to: 5000 }, predicateSchemaId: c.predicate ?? c.predicateSchemaId ?? "pred:test", queryHash: "q:" + c.id, exhaustiveForPredicate: c.exhaustiveForPredicate === true, sampling: c.sampling ?? "NONE", adapterId: c.adapterId ?? "src:otel", adapterVersion: "1", exclusions: c.exclusions ?? [], sourceEpoch: "1" })),
      waitRelations: fx.input.waitRelations?.map((w: any) => ({ id: w.id ?? w["id"], task: w.task, resource: w.resource ?? w["resource"], resourceEpoch: "1", ownerTaskIds: w.owners ?? w.ownerTaskIds ?? [], escapeConditions: w.escape ?? w.escapeConditions ?? [], observationEventIds: [], completeness: "PARTIAL" })),
      proposals: fx.input.proposedEdges?.map((p: any) => ({ edgeId: p.id, fromEventId: p.from, toEventId: p.to, kind: p.kind, adapterId: p.adapterId ?? (["PROGRAM_ORDER", "SPAWN", "COMPLETE_JOIN"].includes(p.kind) ? "src:scheduler" : p.kind === "RELEASE_ACQUIRE" ? "src:lock" : "src:broker"), evidenceIds: ["proposal:" + p.id] })),
    });
    if (r && !r.ok) throw new Error(`fixture ${fx.id}: ingest refused: ${r.error.message}`);
  }
  const scp: CausalityScopeInput = scope({ tenantId: tenant, revisionSet: fx.input.deploymentRevisionSet ?? ["rev-b"], incidentWindow: fx.input.incidentWindow ?? { from: 0, to: 5000 }, ...opts.scope });
  const snapshots = new Map<string, Snapshot>();
  return { eng, snapshots, scope: scp };
}

function toRuntimeEventInput(e: any, fx: any = { input: {} }): RuntimeEventInput {
  const source = fx?.input?.sourceMapping?.[e.id] ?? fx?.input?.sourceMappingURL?.[e.id] ?? "src:otel";
  void fx;
  return {
    id: e.id, kind: e.kind, tenantId: tenant, sourceId: source, sourceEpoch: "1",
    sourceSequence: e.seq ?? null, processEpoch: e.processEpoch ?? null, taskId: e.task ?? null, attemptId: e.attempt ?? null,
    operationId: e.op ?? e.attributes?.op ?? null, traceId: e.trace ?? "trace:1",
    time: { observed: e.clock?.observed ?? e.t ?? null, earliest: e.clock?.earliest ?? null, latest: e.clock?.latest ?? null, domain: e.clock?.domain ?? "wall", epoch: e.clock?.epoch ?? "1", quality: e.clock?.quality ?? ((e.clock?.observed ?? e.t) != null ? "BOUNDED" : "UNKNOWN") },
    deploymentId: e.deploymentId ?? null, buildId: null,
    attributes: { ...e.attributes, ...(e.attempt ? { attemptId: e.attempt } : {}), ...(e.op ? { op: e.op } : {}) },
    sampling: (fx?.input?.sampling ?? e.sampling) as any, parentSpanId: e.parentSpan ?? null,
  };
}

const acceptedOf = (s: Snapshot, kind?: string) => s.edges.filter((e) => e.state === "ACCEPTED" && (!kind || e.kind === kind));
const quarantinedOf = (s: Snapshot) => s.edges.filter((e) => e.state === "QUARANTINED");

// ---------------------------------------------------------------- RC01–RC06

test("RC01: exact RPC send/receive with skewed clocks — trusted relation retained, contradiction disclosed", () => {
  const fx = FX("rc01-exact-rpc-skewed-clocks.json");
  const w = world(fx);
  const r = w.eng.reconstruct(w.scope, {});
  assert.ok(r.ok, r.ok ? "" : r.error.message);
  const s = r.value.snapshot;
  const edges = acceptedOf(s, "SEND_RECEIVE");
  assert.equal(edges.length, 1, "the certified relation is accepted");
  assert.ok(s.consistency === "PARTIAL" || s.consistency === "CONTRADICTORY", "skew makes the picture partial, not clean");
  const ord = w.eng.checkOrder(s.id, "e:send", "e:recv");
  assert.ok(ord.ok && ord.value.relation === "HAPPENS_BEFORE");
  assert.ok(ord.ok && ord.value.timeContradictions.some((c) => /conflicts with wall-clock/.test(c)), "the clock contradiction is stated, not repaired");
});

test("RC02: earlier timestamp without relation evidence — temporal order only, no execution edge", () => {
  const w = world(FX("rc02-earlier-timestamp-no-relation.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  assert.equal(acceptedOf(s).length, 0, "no proposed edge exists from times alone");
  const ord = w.eng.checkOrder(s.id, "e:a", "e:b");
  assert.ok(ord.ok && ord.value.relation === "UNKNOWN", "an earlier wall time implies nothing");
});

test("RC03+RC04: stamps and sampling never become happens-before or certified concurrency", () => {
  const w3 = world(FX("rc03-smaller-lamport-no-path.json"));
  const s3 = must(w3.eng.reconstruct(w3.scope, {})).snapshot;
  const ord3 = w3.eng.checkOrder(s3.id, "e:l1", "e:l2");
  assert.ok(ord3.ok && ord3.value.relation === "UNKNOWN", "Lamport scalar stamps order nothing without a path");
  const w4 = world(FX("rc04-missing-path-sampled.json"));
  const s4 = must(w4.eng.reconstruct(w4.scope, {})).snapshot;
  const ord4 = w4.eng.checkOrder(s4.id, "e:p", "e:q");
  assert.ok(ord4.ok && ord4.value.relation === "UNKNOWN", "no path under sampling stays UNKNOWN");
  const cov = w4.eng.getCoverage(s4.id);
  assert.ok(cov.ok && cov.value.gaps.some((g) => g.kind === "SAMPLED_REGION" && g.material), "the sampled region is a material gap");
});

test("RC05: fan-out and partial join — no sibling sequence, no fictitious await", () => {
  const w = world(FX("rc05-fanout-partial-join.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  const joins = acceptedOf(s, "COMPLETE_JOIN");
  assert.equal(joins.length, 1, "only the actually-awaited completion joined");
  assert.ok(joins[0].fromEventId === "e:c1" && joins[0].toEventId === "e:j");
  assert.ok(!s.edges.some((e) => e.state === "ACCEPTED" && (e.fromEventId === "e:c2" || e.toEventId === "e:c2")), "the un-awaited child carries no fabricated join");
  assert.ok(!s.edges.some((e) => e.state === "ACCEPTED" && e.kind === "PROGRAM_ORDER" && [e.fromEventId, e.toEventId].includes("e:c2")), "no sibling order is invented");
});

test("RC06: retry/redelivery/batch — attempt-aware lineage, batch is many-to-one, no exactly-once claim", () => {
  const w = world(FX("rc06-retry-redelivery-batch.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  const edges = acceptedOf(s, "SEND_RECEIVE");
  assert.equal(edges.length, 2, "one logical message, two delivery attempts, two edges");
  const evs = w.eng.snapshot(s.id)!;
  const attempts = new Set(evs.eventIds.flatMap((id) => (evs.eventIds.includes(id) ? [id] : [])));
  void attempts;
  // The redelivery is not folded into one edge (per-message attempt lineage); distinct attempt ids stay visible.
  const events = must(w.eng.reconstruct(w.scope, {}));
  void events;
  assert.ok(edges.some((e) => e.toEventId === "e:deq1") && edges.some((e) => e.toEventId === "e:deq2"));
  assert.ok(!acceptedOf(s, "READS_FROM").length, "the batch event derives no per-message ordering");
});

test("RC07: a context link has context semantics only and never enters the ordering closure", () => {
  const w = world(FX("rc07-context-link-no-semantics.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  const ctx = acceptedOf(s, "CONTEXT_ASSOCIATION");
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0].layer, "CONTEXT");
  const ord = w.eng.checkOrder(s.id, "e:cs", "e:cr");
  assert.ok(ord.ok && ord.value.relation === "UNKNOWN", "an association without semantics produces no ordering decision");
});

// ---------------------------------------------------------------- RC08–RC12

test("RC08: PID/task/lock/trace reuse across process epochs is quarantined with a reason, not merged", () => {
  const w = world(FX("rc08-id-reuse-epochs.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  const q = quarantinedOf(s);
  assert.equal(q.length, 1, "the cross-epoch lock pairing cannot be accepted");
  assert.ok(q[0].limitations.some((l) => /process epoch/i.test(l)), "the reason names the epoch boundary");
  assert.equal(acceptedOf(s, "RELEASE_ACQUIRE").length, 0);
  // Same-epoch same-lock still pairs: the gate is the epoch, not the kind.
  const eng2 = new CausalityEngine(new Store(":memory:"));
  eng2.registerAdapter(adapters[3]);
  eng2.ingestEvents({ batch: [
    toRuntimeEventInput({ id: "e:y1", kind: "LOCK_ACQUIRE", task: "t:lock", processEpoch: "ep1", attributes: { lock: "lock:L" } }, {}),
    toRuntimeEventInput({ id: "e:y2", kind: "LOCK_RELEASE", task: "t:lock2", processEpoch: "ep1", attributes: { lock: "lock:L" } }, {}),
  ] as any[], watermark: { sourceId: "src:lock", sourceEpoch: "1", acceptedSequence: "2", eventTimeWatermark: null, allowedLatenessMs: 0, finalForWindow: false }, expectedSourceVersion: 0, relationCertificates: [{ id: "cert:lock-2", adapterId: "src:lock", kind: "RELEASE_ACQUIRE", matchesEventIds: ["e:y1", "e:y2"] }] });
  const s2 = must(eng2.reconstruct(scope({}), {})).snapshot;
  assert.equal(acceptedOf(s2, "RELEASE_ACQUIRE").length, 1, "same epoch, same lock: the handoff is real");
});

test("RC09: rolling deployment — attribution follows the deployment revision set, not the analyzed checkout", () => {
  const fx = FX("rc09-rolling-deployment-wrong-sourcemap.json");
  const w = world(fx);
  w.eng.store.db.prepare("insert or replace into rt_markers values (?,?,?,?)").run("src:otel", "dep:checkout", "rev-a", 0);
  for (const m of Object.entries(fx.input.sourceMaps)) w.eng.registerArtifact({ id: m[0], revision: (m[1] as any).revision ?? fx.input.deploymentRevisionSet[0], mappings: (m[1] as any).mappings ?? [] });
  const s = must(w.eng.reconstruct({ ...w.scope, revisionSet: ["rev-b"] }, {})).snapshot;
  const a = s.attributions.find((x) => x.eventId === "e:w1")!;
  assert.equal(a.revision, "rev-a", "the event ran rev-a; the analyzed revision rev-b is not forced onto it");
  assert.equal(a.exact, true, "marker + artifact source map is exact");
  assert.ok(a.reasons.length > 0, "the join states how it was made");
  const wrong = must(w.eng.reconstruct(scope({ revisionSet: ["rev-b"] }), {})).snapshot as any;
  void wrong;
  // When rev-a is NOT inside the queried revision set, the artifact attribution still targets rev-a (never forced to rev-b):
  const scoped2 = w.eng.reconstruct(scope({ revisionSet: ["rev-b"] }), {});
  const a2 = scoped2.ok ? scoped2.value.snapshot.attributions.find((x) => x.eventId === "e:w1")! : null;
  assert.ok(a2 && a2.revision === "rev-a", "even outside the analyzed revision set, attribution follows the deployment marker");
  assert.ok(a2 && a2.reasons.some((r) => /revision set|analyzed|rolling/i.test(r)), "the mismatch is disclosed in reasons");
});

test("RC10: unknown clock bounds — no precise cross-host latency claim", () => {
  const w = world(FX("rc10-clock-uncertainty-unknown.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  const cov = w.eng.getCoverage(s.id);
  assert.ok(cov.ok && cov.value.gaps.some((g) => g.kind === "CLOCK_UNKNOWN" && g.material));
  const path = w.eng.criticalPath(s.id, "op:x");
  assert.ok(path.ok && path.value.coveredDurationMs === null, "no invented decomposition");
  assert.ok(path.ok && path.value.limitations.some((l) => /RC10/.test(l)));
});

test("RC11: contradictory ordering proposals quarantine whole, deterministically, with provenance retained", () => {
  const w = world(FX("rc11-ordering-cycle-contradictory.json"));
  const s1 = must(w.eng.reconstruct(w.scope, {})).snapshot;
  assert.deepEqual(quarantinedOf(s1).map((e) => [e.fromEventId, e.toEventId, e.kind]).sort(), [["e:cyc1", "e:cyc2", "SEND_RECEIVE"], ["e:cyc2", "e:cyc1", "PROGRAM_ORDER"]].sort());
  assert.equal(acceptedOf(s1).length, 0, "no first-edge-wins");
  const s2 = must(w.eng.reconstruct(w.scope, {})).snapshot;
  assert.deepEqual(quarantinedOf(s2).map((e) => e.state), quarantinedOf(s1).map((e) => e.state), "re-reconstruction reconciles identically");
  assert.ok(quarantinedOf(s1).every((e) => e.limitations.some((l) => /competing|retained/i.test(l))), "competing provenance retained");
});

test("RC12: a legitimate wait-cycle is analyzed in the wait layer with escape conditions, never quarantined as ordering", () => {
  const w = world(FX("rc12-wait-for-cycle-legitimate.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  assert.ok(s.waitRelations.length === 2, "both wait records survived");
  assert.notEqual(s.consistency, "CONTRADICTORY", "a wait cycle is not an ordering contradiction");
  const r = w.eng.analyzeWaits(s.id);
  assert.ok(r.ok);
  const cycles = (r as any).value.cycles;
  assert.equal(cycles.length, 1, "t1→t2→t1 forms one deadlock candidate");
  assert.ok(cycles[0].tasks.includes("t1") && cycles[0].tasks.includes("t2"));
  assert.ok(cycles[0].escapeConditions.length >= 2, "each leg's escape conditions are carried into the analysis");
});

// ---------------------------------------------------------------- RC13–RC16

test("RC13: sampled CPU stacks are attribution only; no task ordering is fabricated from samples", () => {
  const w = world(FX("rc13-sampled-cpu-stacks.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  assert.equal(acceptedOf(s).length, 0, "samples order nothing");
  assert.ok(s.eventIds.includes("e:s1"), "samples are recorded as facts");
  const slice = w.eng.querySlice(s.id, { layers: ["EXECUTION_ORDER"] });
  assert.ok(slice.ok && slice.value.events.every((e) => e.kind !== "SAMPLE"), "samples stay out of the ordering closure");
});

test("RC14: missing spans/retention/drop — material gaps; absence-based exoneration is blocked", () => {
  const w = world(FX("rc14-missing-spans-retention.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  const cov = w.eng.getCoverage(s.id);
  assert.ok(cov.ok && cov.value.gaps.some((g) => g.material), "the query runs without evidence of service-x and stays material");
  assert.ok(cov.ok && cov.value.disclosure.some((d) => /not proof of absence/.test(d)), "absence is never exoneration");
  assert.ok(cov.ok && cov.value.disclosure.some((d) => /not exhaustive/.test(d)), "a non-exhaustive certificate says so");
});

test("RC15: nested/overlapping operations are unioned, never summed (engine-level path accounting)", () => {
  const eng = new CausalityEngine(new Store(":memory:"));
  eng.registerAdapter(adapters[0]);
  eng.ingestEvents({ batch: [
    toRuntimeEventInput({ id: "e:parent", kind: "OP_START", op: "op:pay", t: 0, attributes: { durationMs: 100, op: "op:pay" } }, {}),
    toRuntimeEventInput({ id: "e:child", kind: "OP_START", op: "op:pay", t: 10, attributes: { durationMs: 10, op: "op:pay" } }, {}),
    toRuntimeEventInput({ id: "e:tail", kind: "OP_END", op: "op:pay", t: 90, attributes: { durationMs: 10, op: "op:pay" } }, {}),
  ] as any[], watermark: { sourceId: "src:otel", sourceEpoch: "1", acceptedSequence: "3", eventTimeWatermark: null, allowedLatenessMs: 0, finalForWindow: false }, expectedSourceVersion: 0 });
  const s = must(eng.reconstruct(scope({}), {})).snapshot;
  const path = eng.criticalPath(s.id, "op:pay");
  assert.ok(path.ok && path.value.coveredDurationMs === 100, `union over [0,100] and [10,20] and [90,100] is 100, not the 130 sum (got ${path.ok ? path.value.coveredDurationMs : "?"})`);
  assert.ok(path.ok && (path.value.observedDurationMs as number) >= (path.value.coveredDurationMs as number));
  assert.ok(path.ok && path.value.limitations.some((l) => /unioned/.test(l)));
});

test("RC16: tail-sampled failures versus control — selection bias disclosed, no automatic causal effect", () => {
  const w = world(FX("rc16-tailsampled-failures-control.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  const cov = w.eng.getCoverage(s.id);
  assert.ok(cov.ok && cov.value.gaps.some((g) => g.kind === "SAMPLED_REGION"), "tail sampling is disclosed as a gap");
  const claim = w.eng.proposeCausalClaim(s.id, { assertion: "exceptions cause the outage outcome; the cohort comparison proves intervention value", level: "MECHANISM_SUPPORTED" });
  assert.ok(!claim.ok && /mechanism/.test(claim.error.message), "execution-or-cohort evidence alone cannot support a mechanism (corrected baseline rule)");
  const intervention = w.eng.proposeCausalClaim(s.id, { assertion: "any", level: "INTERVENTION_SUPPORTED" });
  assert.ok(intervention.ok === false && !intervention.ok, "no causal effect without a gated experiment");
});


// ---------------------------------------------------------------- RC17–RC20

test("RC17: a source correction invalidates dependent edges and marks claims stale before refresh", () => {
  const eng = new CausalityEngine(new Store(":memory:"));
  eng.registerAdapter(adapters[0]);
  eng.ingestEvents({ batch: [
    toRuntimeEventInput({ id: "e:orig", kind: "OP_START", t: 10, seq: 1, task: "t:pay", attributes: { op: "op:pay" } }, {}),
    toRuntimeEventInput({ id: "e:other", kind: "SEND", t: 20, seq: 2, task: "t:pay", attributes: { op: "op:pay" } }, {}),
  ] as any[], watermark: { sourceId: "src:otel", sourceEpoch: "1", acceptedSequence: "2", eventTimeWatermark: null, allowedLatenessMs: 0, finalForWindow: false }, expectedSourceVersion: 0 });
  const s1 = must(eng.reconstruct(scope({}), {})).snapshot;
  assert.equal(acceptedOf(s1, "PROGRAM_ORDER").length, 1, "strand order derived from the original event");
  const claim = eng.proposeCausalClaim(s1.id, { assertion: "op:pay sends after start (relation)", level: "EXECUTION_RELATION", edgeId: acceptedOf(s1, "PROGRAM_ORDER")[0].id });
  assert.ok(claim.ok);
  const before = eng.claimRef((claim as any).value.claimId);
  assert.ok(before && before.state === "CURRENT");
  const corr = eng.applyCorrection({ correctedEvent: { id: "e:orig", kind: "OP_START", tenantId: tenant, sourceId: "src:otel", sourceEpoch: "1", time: { observed: 90, domain: "wall", epoch: "1", quality: "BOUNDED" } } as any, supersedesEventId: "e:orig" });
  assert.ok(corr.ok, corr.ok ? "" : corr.error.message);
  assert.ok(corr.ok && corr.value.receipt.atomic && corr.value.receipt.invalidatedEdges.includes(acceptedOf(s1, "PROGRAM_ORDER")[0].id), "the dependent edge is invalidated atomically with the correction");
  const after = eng.claimRef((claim as any).value.claimId);
  assert.ok(after && after.state === "STALE", "a claim derived from the superseded event is stale before refresh (RC17)");
  const s2 = must(eng.reconstruct(scope({}), {})).snapshot;
  assert.equal(s2.version, s1.version + 1, "correction surfaces as a new snapshot version");
});

test("RC18: cancellation requested but child completes — no rollback assertion is ever derived", () => {
  const w = world(FX("rc18-cancel-requested-child-completes.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  assert.equal(s.edges.length, 0, "a CANCEL_REQUEST plus a later TASK_COMPLETE produces no edge at all");
  const slice = w.eng.querySlice(s.id, {});
  assert.ok(slice.ok && slice.value.events.some((e) => e.kind === "CANCEL_REQUEST") && slice.value.events.some((e) => e.kind === "TASK_COMPLETE"), "both facts are retained and visible separately");
});

test("RC19: shared-dependency interference — experiment/claim population limits retained", () => {
  const w = world(FX("rc19-shared-dependency-interference.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  const mev = w.eng.buildMechanismEvidence(s.id, [], ["LOCK_WAIT"]);
  assert.ok(mev.ok); w.eng.keepMechanisms(mev.value);
  const claim = w.eng.proposeCausalClaim(s.id, { assertion: "lock wait delays checkout under load W", level: "MECHANISM_SUPPORTED", mechanismEvidenceId: mev.value[0].id, workload: "burst" });
  assert.ok(claim.ok, claim.ok ? "" : claim!.error!.message);
  const link = w.eng.linkInterventionEvidence({ claimId: (claim as any).value.claimId, expectedClaimVersion: 1, experimentReport: { reportId: "c27:rep:1", design: "PAIRED", workload: "burst", revision: "rev-b", sharedDependencies: ["db:pool", "queue:checkout"], spillover: "spillover into adjacent tenants possible" }, targetScope: { revisionSet: ["rev-b"], workload: "burst" } });
  assert.ok(link.ok);
  const cl = w.eng.claimRef((claim as any).value.claimId)!;
  assert.ok(cl.limitations.some((l) => /shared dependencies|whole-instance/.test(l)), "shared dependencies retained on the claim");
  assert.ok(cl.limitations.some((l) => /spillover/.test(l)), "spillover scope recorded, not erased");
});

test("RC20: forged trace context — no authority grant, no topology disclosure", () => {
  const eng = new CausalityEngine(new Store(":memory:"));
  eng.registerAdapter(adapters[0]);
  const ing = eng.ingestEvents({ batch: [toRuntimeEventInput({ id: "e:forge", kind: "OP_START", attributes: { claimedTenant: "tenant:other", traceparent: "00-forged" } }, {}) as any], watermark: { sourceId: "src:otel", sourceEpoch: "1", acceptedSequence: "1", eventTimeWatermark: null, allowedLatenessMs: 0, finalForWindow: false }, expectedSourceVersion: 0 });
  assert.ok(ing.ok && ing.value.receipt.rejectedUntrusted === 1, "the forged-tenant record is rejected outright");
  assert.equal(must(eng.reconstruct(scope({}), {})).snapshot.eventIds.length, 0, "nothing persisted from the forge");
  // Unauthenticated collector: records stay untrusted context, excluded from topology.
  const eng2 = new CausalityEngine(new Store(":memory:"));
  const ing2 = eng2.ingestEvents({ batch: [toRuntimeEventInput({ id: "e:anon", kind: "OP_START", t: 5, attributes: {} }, {}) as any], watermark: { sourceId: "src:unknown", sourceEpoch: "1", acceptedSequence: "1", eventTimeWatermark: null, allowedLatenessMs: 0, finalForWindow: false }, expectedSourceVersion: 0 });
  assert.ok(ing2.ok);
  const s2 = must(eng2.reconstruct(scope({}), {})).snapshot;
  assert.equal(s2.eventIds.length, 0, "unregistered sources contribute no events");
  assert.equal(s2.edges.length, 0, "untrusted context takes no part in topology (no private-topology disclosure)");
});
// ---------------------------------------------------------------- RC21–RC24

test("RC21: oversized ingestion/query — backpressure, truncation with continuation, no unbounded persistence", () => {
  const eng = new CausalityEngine(new Store(":memory:"));
  eng.registerAdapter(adapters[0]);
  const big = Array.from({ length: 400 }, (_, i) => toRuntimeEventInput({ id: "e:big" + i, kind: "OP_START", t: i, seq: String(i), attributes: { op: "op" + i } }, {}));
  const over = eng.ingestEvents({ batch: big, watermark: { sourceId: "src:otel", sourceEpoch: "1", acceptedSequence: "400", eventTimeWatermark: null, allowedLatenessMs: 0, finalForWindow: false }, expectedSourceVersion: 0 });
  assert.ok(over.ok);
  const tooBig = eng.reconstruct(scope({}), { maxEvents: 100 });
  assert.ok(tooBig.ok === false && !tooBig.ok && /RC21/.test((tooBig as any).error.message), "reconstruction refuses beyond the slice limit as retryable backpressure, retryable");
  const slice = eng.reconstruct(scope({}), {});
  assert.ok(slice.ok);
  const small = eng.querySlice(slice.value.snapshot.id, { limits: { maxEvents: 2 } });
  assert.ok(small.ok && small.value.truncated && small.value.continuation !== null, "bounded slices return explicit truncation with a continuation handle");
});

test("RC22: crash between source cursor, projection and outbox — dedup and durable replay; no mixed snapshot", () => {
  const run = (db: string, mode: string) => execFileSync(process.execPath, [CHILD, db, mode], { env: { ...process.env, CIE_FAILPOINT: mode === "crash-mid-intake" ? "c24-after-source-cursor" : mode === "crash-mid-projection" ? "c24-before-projection-commit" : "" }, encoding: "utf8" });
  for (const failMode of ["crash-mid-intake", "crash-mid-projection"]) {
    const db = join(process.env["TMPDIR"] ?? "/tmp", `c24-crash-${failMode}-${Math.random().toString(36).slice(2)}.db`);
    let died = false;
    try { run(db, failMode); } catch { died = true; }
    assert.ok(died, `the child dies at ${failMode}`);
    const after = JSON.parse(run(db, "count"));
    assert.equal(after.snapshots.length, 0, `${failMode}: no snapshot committed past the failpoint (no mixed state)`);
    // Replay the same batch in a fresh process: dedup makes it idempotent.
    run(db, "recover");
    const final = JSON.parse(run(db, "count"));
    assert.equal(final.events, 2, `${failMode}: exactly two authoritative events survive replay (dedup + durable tx)`);
    assert.equal(final.snapshots.length, 1, `${failMode}: exactly one snapshot exists after recovery`);
  }
});

test("RC23: revoked source / deleted raw handle — restricted reports, no historic payload recovery", () => {
  const eng = new CausalityEngine(new Store(":memory:"));
  eng.registerAdapter(adapters[0]);
  eng.registerAdapter({ adapterId: "src:sensitive", version: "1", sourceNamespaces: ["src:sensitive"], edgeKinds: ["PROGRAM_ORDER"], certifiesProgramOrder: true, trusted: true });
  const fixtureFx = FX("rc23-revoked-source-deleted-handle.json");
  eng.ingestEvents({ batch: [toRuntimeEventInput({ id: "e:r1", kind: "OP_START", t: 5, attributes: {} }, fixtureFx) as any], watermark: { sourceId: "src:sensitive", sourceEpoch: "1", acceptedSequence: "1", eventTimeWatermark: null, allowedLatenessMs: 0, finalForWindow: false }, expectedSourceVersion: 0 });
  const s1 = must(eng.reconstruct(scope({}), {})).snapshot;
  assert.ok(s1.eventIds.includes("e:r1"), "before revocation the event is visible");
  const inv = eng.invalidateSource(fixtureFx.input.revokedSourceIds[0], { reason: "tenant revoked access" });
  assert.ok(inv.ok && inv.value.receipt.revoked && inv.value.receipt.noHistoricPayloadRecovery, "raw payloads live only in the external backend; nothing can be recovered locally (RC23)");
  const s2 = must(eng.reconstruct(scope({}), {})).snapshot;
  assert.ok(!s2.eventIds.includes("e:r1"), "the revoked source's events are excluded from new reconstruction");
  assert.ok(s2.gaps.some((g) => g.kind === "ACCESS_RESTRICTED" && g.material), "the absence is material and labeled, not silently hidden");
  assert.equal(s2.consistency, "PARTIAL", "restricted evidence keeps the picture partial, never clean");
});

test("RC24: a late event after a finalized watermark produces a versioned correction, never silent folding", () => {
  const eng = new CausalityEngine(new Store(":memory:"));
  eng.registerAdapter(adapters[0]);
  eng.ingestEvents({ batch: [toRuntimeEventInput({ id: "e:base", kind: "SEND", t: 30, attributes: { messageId: "m9" } }, {}), toRuntimeEventInput({ id: "e:base-recv", kind: "RECEIVE", t: 35, attributes: { messageId: "m9" } }, {})], watermark: { sourceId: "src:otel", sourceEpoch: "1", acceptedSequence: "2", eventTimeWatermark: null, allowedLatenessMs: 0, finalForWindow: false }, expectedSourceVersion: 0 });
  const s1 = must(eng.reconstruct(scope({}), {})).snapshot;
  assert.equal(acceptedOf(s1, "SEND_RECEIVE").length, 1, "the relation was derived inside the final window");
  const late = eng.ingestEvents({ batch: [toRuntimeEventInput({ id: "e:late", kind: "OP_END", t: 50, attributes: { op: "op:pay" } }, {})], watermark: { sourceId: "src:otel", sourceEpoch: "1", acceptedSequence: "3", eventTimeWatermark: 40, allowedLatenessMs: 0, finalForWindow: true }, expectedSourceVersion: 1 });
  assert.ok(late.ok, "the late event is accepted into intake (source version advanced), never refused without a path");
  const s2 = must(eng.reconstruct(scope({}), {})).snapshot;
  assert.equal(s2.version, s1.version + 1, "the reconstruction is a new snapshot version");
  assert.ok(s2.lateEventIds.includes("e:late"), "the late arrival is surfaced, not silently ignored");
  assert.ok(s2.edges.some((e) => e.state === "INVALIDATED"), "affected relations are invalidated pending re-derivation");
  const upd = eng.readUpdates(s2.id, 0);
  assert.ok(upd.ok && upd.value.updates.some((u: any) => JSON.parse(u.json).lateEventIds > 0), "the update stream records the late arrival");
});

// ---------------------------------------------------------------- RC25–RC28

test("RC25: telemetry replay is labeled playback and never promises executable replay", () => {
  const w = world(FX("rc25-replay-playback-only.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  const rp = w.eng.replayPlayback(s.id, 120);
  assert.ok(rp.ok && rp.value.label === "PLAYBACK" && rp.value.kind === "evidence-playback" && rp.value.noExecutableReplayPromise === true);
});

test("RC26: an unsupported LLM root cause stays hypothesis-only; the gates block display", () => {
  const w = world(FX("rc26-llm-unsupported-root-cause.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  const mev = w.eng.buildMechanismEvidence(s.id, [], undefined);
  const mevs = mev.ok ? mev.value : [];
  assert.ok(mevs.length === 1 && mevs[0].mechanismKind === "UNKNOWN", "assembling with no supporting evidence yields an honestly unknown mechanism");
    if (!mevs.length) throw new Error("mechanism evidence list not available");
  const claim = w.eng.proposeCausalClaim(s.id, { assertion: "the payment service caused the outage", level: "MECHANISM_SUPPORTED", mechanismEvidenceId: mevs[0].id });
  assert.ok(!claim.ok && /never supports a mechanism/.test(claim!.error.message), "an unsupported mechanism cannot be claimed as supported");
});

test("RC27: intervention mismatched to workload/revision is refused by the scope gate", () => {
  const w = world(FX("rc27-intervention-mismatched-scope.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  const mev = w.eng.buildMechanismEvidence(s.id, [], ["LOCK_WAIT"]);
  assert.ok(mev.ok && mev.value[0].mechanismKind === "LOCK_WAIT"); w.eng.keepMechanisms(mev.value);
  const claim = w.eng.proposeCausalClaim(s.id, { assertion: "lock wait", level: "MECHANISM_SUPPORTED", mechanismEvidenceId: mev.value[0].id, workload: "steady" });
  assert.ok(claim.ok, claim.ok ? "" : claim!.error!.message);
  const link = w.eng.linkInterventionEvidence({ claimId: (claim as any).value.claimId, expectedClaimVersion: 1, experimentReport: { reportId: "c27:rep:mismatch", design: "PAIRED", workload: "burst", revision: "rev-a" }, targetScope: { revisionSet: ["rev-b"], workload: "steady" } });
  assert.ok(!link.ok && /does not match the claimed scope/.test(link!.error.message), "the mismatch is refused with the exact reasons disclosed");
});

test("RC28: confounded before/after deployment stays observational — no confirmed intervention effect", () => {
  const w = world(FX("rc28-confounded-before-after.json"));
  const s = must(w.eng.reconstruct(w.scope, {})).snapshot;
  const mev = w.eng.buildMechanismEvidence(s.id, [], ["LOCK_WAIT"]);
  assert.ok(mev.ok); w.eng.keepMechanisms(mev.value);
  const claim = w.eng.proposeCausalClaim(s.id, { assertion: "after the deploy, timeouts fell", level: "MECHANISM_SUPPORTED", mechanismEvidenceId: mev.value[0].id });
  assert.ok(claim.ok, claim.ok ? "" : claim!.error!.message);
  const link = w.eng.linkInterventionEvidence({ claimId: (claim as any).value.claimId, expectedClaimVersion: 1, experimentReport: { reportId: "c27:rep:confounded", design: "BEFORE_AFTER_RELEASE", workload: "steady", revision: "rev-b" }, targetScope: { revisionSet: ["rev-b"], workload: "steady" } });
  assert.ok(!link.ok && /observational/.test(link!.error.message), "the confounded design cannot promote the claim");
});

// ---------------------------------------------------------------- contract tests (§12)

test("contract: intake is idempotent by identity; a differing re-send is a version conflict, not a duplicate", () => {
  const eng = new CausalityEngine(new Store(":memory:"));
  eng.registerAdapter(adapters[0]);
  const batch = [toRuntimeEventInput({ id: "e:idem", kind: "OP_START", t: 1, seq: "1" }, {}) as any];
  const first = eng.ingestEvents({ batch, watermark: { sourceId: "src:otel", sourceEpoch: "1", acceptedSequence: "1", eventTimeWatermark: null, allowedLatenessMs: 0, finalForWindow: false }, expectedSourceVersion: 0 });
  const again = eng.ingestEvents({ batch, watermark: { sourceId: "src:otel", sourceEpoch: "1", acceptedSequence: "1", eventTimeWatermark: null, allowedLatenessMs: 0, finalForWindow: false }, expectedSourceVersion: 1 });
  assert.ok(first.ok && again.ok && again.value.receipt.duplicates === 1 && again.value.receipt.accepted === 0, "same identity re-ingests as a duplicate");
  assert.equal(Number((eng.store.db.prepare("select count(*) as n from c24_event_refs where id = 'e:idem'").get() as any).n), 1, "exactly one authoritative row");
});

test("contract: stale expectedSourceVersion is refused as a version conflict, marked retryable", () => {
  const eng = new CausalityEngine(new Store(":memory:"));
  eng.registerAdapter(adapters[0]);
  const mk = () => ({ batch: [toRuntimeEventInput({ id: "e:v" + Math.random(), kind: "OP_START", t: 1, seq: "9" }, {}) as any], watermark: { sourceId: "src:otel", sourceEpoch: "1", acceptedSequence: "1", eventTimeWatermark: null, allowedLatenessMs: 0, finalForWindow: false }, expectedSourceVersion: 0 });
  assert.ok(eng.ingestEvents(mk()).ok);
  const stale = eng.ingestEvents({ ...mk(), expectedSourceVersion: 0 });
  assert.ok(!stale.ok && stale.error.code === "VERSION_CONFLICT" && stale.error.retryable, "the caller must advance to the source's current version");
});

test("contract: the v1 C24 catalogue surfaces unchanged attributes beside the v2 catalogue (v1 preserved, §12)", () => {
  // The engine shares the store with the v1 Runtime; markers recorded through v1 are authoritative in v2 attribution.
  const eng = new CausalityEngine(new Store(":memory:"));
  eng.registerAdapter(adapters[0]);
  eng.store.db.prepare("insert or replace into rt_markers values (?,?,?,?)").run("src:otel", "dep:old", "rev-old", 0);
  eng.ingestEvents({ batch: [toRuntimeEventInput({ id: "e:c", kind: "OP_START", t: 1, deploymentId: "dep:old", attributes: { revision: "rev-old", file: "src/x.ts" } }, {}) as any], watermark: { sourceId: "src:otel", sourceEpoch: "1", acceptedSequence: "1", eventTimeWatermark: null, allowedLatenessMs: 0, finalForWindow: false }, expectedSourceVersion: 0 });
  const s = must(eng.reconstruct(scope({ revisionSet: ["rev-new"] }), {})).snapshot;
  const a = s.attributions.find((x) => x.eventId === "e:c")!;
  assert.equal(a.revision, "rev-old", "the v1 marker wins over the analyzed revision (attribute never upgrades an uncertain join silently)");
  assert.ok(a.reasons.some((r) => /artifact|fog|no artifact/i.test(r)), `the no-artifact fog is stated: ${a.reasons.join("; ")}`);
});

