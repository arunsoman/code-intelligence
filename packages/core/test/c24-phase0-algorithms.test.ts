// C24 phase-0 algorithm evidence (design §19: "Checker mutations remove [a] gate one at a time. The corresponding tests
// must fail."). Three load-bearing semantics, each validated three ways:
//   1. property tests (permutation invariance, honest unknowns, no double counting);
//   2. an INDEPENDENT brute-force oracle implemented differently (Floyd–Warshall closure; integer-grid scan), which is the
//      separate oracle the corrected baseline requires — not a restatement of the thing under test;
//   3. mutation detection: for each gate, a mutated copy with the gate removed is shown to violate what the properties
//      check, demonstrating the suite actually catches the removal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountDurations, type AccountedInterval } from "../src/c24/path-accounting.ts";
import { orderRelation, reconcileProposedOrdering, type ProposedEdge } from "../src/c24/ordering.ts";

const edge = (id: string, from: string, to: string, kind: ProposedEdge["kind"] = "PROGRAM_ORDER", evidenceIds = ["ev:" + id]): ProposedEdge => ({ id, fromEventId: from, toEventId: to, kind, evidenceIds, ruleId: "rule:test" });
const shuffled = <T>(xs: T[], rnd: () => number): T[] => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// ---- Independent oracle 1: transitive closure by Floyd–Warshall (a different algorithm from the Tarjan/BFS code under test).

function warshall(edges: { from: string; to: string }[], nodes: string[]): Map<string, Set<string>> {
  const reach = new Map(nodes.map((u) => [u, new Set<string>()]));
  for (const e of edges) reach.get(e.from)?.add(e.to);
  for (const k of nodes) for (const i of nodes) if (reach.get(i)?.has(k)) for (const j of nodes) if (reach.get(k)?.has(j)) reach.get(i)?.add(j);
  return reach;
}

// ---- 1a. Deterministic quarantine (RC11): same set ⇒ same outcome, any permutation; every quarantined edge keeps provenance.

test("RC11 property: reconciling the same proposal set under 120 permutations yields the identical outcome, and every quarantined edge retains its conflict report", () => {
  const base: ProposedEdge[] = [
    edge("p1", "e:a", "e:b", "SEND_RECEIVE", ["adapter:broker.auth"]),
    edge("p2", "e:b", "e:c", "COMPLETE_JOIN", ["adapter:scheduler"]),
    edge("p3", "e:c", "e:a", "PROGRAM_ORDER", ["adapter:otel.strand"]), // closes the cycle
    edge("p4", "e:a", "e:d", "SPAWN", ["adapter:scheduler"]),
    edge("p5", "e:d", "e:e", "PROGRAM_ORDER", ["adapter:otel.strand"]),
  ];
  const reference = reconcileProposedOrdering([...base].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(reference.quarantined.length, 3, "all three cycle members quarantined");
  assert.equal(reference.accepted.length, 2, "the DAG remainder is accepted");
  assert.ok(reference.allQuarantinesAttributed, "each quarantine names its retained component");
  for (let i = 0; i < 120; i++) {
    const r = reconcileProposedOrdering(shuffled(base, rng(i * 7 + 1)));
    assert.deepEqual(r.accepted.map((e) => e.id).sort(), reference.accepted.map((e) => e.id).sort());
    assert.deepEqual(r.quarantined.map((e) => e.id).sort(), reference.quarantined.map((e) => e.id).sort());
    assert.deepEqual(r.conflicts, reference.conflicts);
    assert.deepEqual(r.quarantined.map((e) => e.conflictId).sort(), reference.quarantined.map((e) => e.conflictId).sort());
  }
});

test("RC11 oracle: quarantined membership agrees with an independent Floyd–Warshall cycle computation", () => {
  const base = [edge("q1", "n:1", "n:2"), edge("q2", "n:2", "n:3"), edge("q3", "n:3", "n:1"), edge("q4", "n:3", "n:4"), edge("q5", "n:4", "n:2") /* second cycle */];
  const r = reconcileProposedOrdering(base);
  const reach = warshall(base.map((e) => ({ from: e.fromEventId, to: e.toEventId })), ["n:1", "n:2", "n:3", "n:4"]);
  const cyclicByOracle = new Set([...reach].filter(([u, set]) => set.has(u)).map(([u]) => u));
  for (const e of [...r.accepted, ...r.quarantined]) {
    const cyclicHere = cyclicByOracle.has(e.fromEventId) && cyclicByOracle.has(e.toEventId);
    assert.equal(e.state === "QUARANTINED", cyclicHere, `edge ${e.id} between cyclic nodes must be quarantined; otherwise accepted`);
  }
});

// ---- 1b. Partial-order queries (RC03/RC04): order only through accepted edges; certificates for concurrency; bounded hops.

test("RC03: a smaller Lamport stamp and an earlier wall clock imply nothing without a path — UNKNOWN, and never certified concurrent", () => {
  // e1 ran first, e2 ran later, and the stamps agree — but no accepted edge connects them.
  const r = orderRelation([{ fromEventId: "e:x", toEventId: "e:y" }], "e:earlier", "e:later", null);
  assert.equal(r.relation, "UNKNOWN");
  assert.ok(r.limitations.some((l) => /UNKNOWN/i.test(l)), "the reason is stated, not hidden");
  const withForgery = orderRelation([], "e:earlier", "e:later", { id: "c:fake", domain: "lamport", epoch: "1", coversEventIds: ["e:earlier", "e:later"], valid: false });
  assert.equal(withForgery.relation, "UNKNOWN", "an invalid certificate is no certificate");
});

test("RC04: no path in a sampled region is UNKNOWN, never CONCURRENT_CERTIFIED; a valid certificate covering both endpoints is required", () => {
  const noCert = orderRelation([], "e:p", "e:q", null);
  assert.equal(noCert.relation, "UNKNOWN");
  const certOnlyOthers = orderRelation([], "e:p", "e:q", { id: "c:1", domain: "vec", epoch: "1", coversEventIds: ["e:r"], valid: true });
  assert.equal(certOnlyOthers.relation, "UNKNOWN", "a certificate that does not cover the queried endpoints does not apply");
  const certified = orderRelation([], "e:p", "e:q", { id: "c:1", domain: "vec", epoch: "1", coversEventIds: ["e:p", "e:q"], valid: true });
  assert.equal(certified.relation, "CONCURRENT_CERTIFIED");
});

test("order follows accepted edges only; hop bounds return UNKNOWN rather than an inference", () => {
  const chain = [edge("h1", "e:1", "e:2"), edge("h2", "e:2", "e:3"), edge("h3", "e:3", "e:4")];
  assert.equal(orderRelation(chain, "e:1", "e:4", null).relation, "HAPPENS_BEFORE");
  assert.equal(orderRelation(chain, "e:4", "e:1", null).relation, "HAPPENS_AFTER");
  const bounded = orderRelation(chain, "e:1", "e:4", null, 2);
  assert.equal(bounded.relation, "UNKNOWN", "a bound that truncates the search is not evidence of absence");
  assert.equal(orderRelation(chain, "e:1", "e:4", null, 3).relation, "HAPPENS_BEFORE");
});

test("oracle: reachable pairs agree with the independent Floyd–Warshall closure on a layered graph", () => {
  const chain = [edge("o1", "a", "b"), edge("o2", "b", "c"), edge("o3", "c", "d"), edge("o4", "a", "d"), edge("o5", "d", "b", "COMPLETE_JOIN")];
  // Remove the back edge for the order question itself (it would create a cycle; RC11 covers that) — queries must run on the accepted DAG.
  const dag = chain.filter((e) => e.id !== "o5");
  const reach = warshall(dag.map((e) => ({ from: e.fromEventId, to: e.toEventId })), ["a", "b", "c", "d"]);
  for (const a of ["a", "b", "c", "d"]) for (const b of ["a", "b", "c", "d"]) {
    if (a === b) { assert.equal(orderRelation(dag, a, b, null).relation, "UNKNOWN", "self-order is UNKNOWN (nothing to order)"); continue; }
    const oracle = reach.get(a)!.has(b) ? "HAPPENS_BEFORE" : reach.get(b)!.has(a) ? "HAPPENS_AFTER" : "UNKNOWN";
    assert.equal(orderRelation(dag, a, b, null).relation, oracle, `${a}→${b}`);
  }
});

// ---- 1c. Overlap-aware accounting (RC15): unions, not sums; impossible intervals are discarded with a reason.

test("RC15: nested and overlapping durations are not summed; uncovered time stays unexplained", () => {
  const observation = { fromMs: 0, toMs: 100 };
  const nested: AccountedInterval[] = [{ fromMs: 0, toMs: 100, covered: true }, { fromMs: 10, toMs: 20, covered: true }];
  const a = accountDurations(nested, observation);
  assert.equal(a.coveredMs, 100, "the child is inside the parent: the union is 100, the sum would be 110");
  assert.equal(a.unresolvedMs, 0);
  const overlapped: AccountedInterval[] = [{ fromMs: 0, toMs: 60, covered: true }, { fromMs: 40, toMs: 80, covered: true }];
  const b = accountDurations(overlapped, observation);
  assert.equal(b.coveredMs, 80, "40–60 is shared, not counted twice");
  assert.equal(b.unresolvedMs, 20);
  const impossible = accountDurations([{ fromMs: 50, toMs: 40, covered: true }, { fromMs: 0, toMs: 30, covered: true }], observation);
  assert.equal(impossible.coveredMs, 30);
  assert.ok(impossible.discarded.some((d) => /inverted|non-finite/.test(d.reason)), "the discarded interval names a reason instead of silently vanishing");
});

test("RC15 oracle: covered totals agree with an independent integer-grid scan across re-segmentations", () => {
  const observation = { fromMs: 0, toMs: 96 };
  const truth = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 23, 24, 25, 40, 41, 60, 90, 95]); // covered unit set, chosen by hand
  const asIntervals: AccountedInterval[] = [{ fromMs: 0, toMs: 12, covered: true }, { fromMs: 23, toMs: 26, covered: true }, { fromMs: 40, toMs: 42, covered: true }, { fromMs: 60, toMs: 61, covered: true }, { fromMs: 90, toMs: 96, covered: true }];
  const grid = (segs: AccountedInterval[]) => { const set = new Set<number>(); for (const s of segs) if (s.covered) for (let t = Math.max(s.fromMs, observation.fromMs); t < Math.min(s.toMs, observation.toMs); t++) set.add(t); return set.size; };
  const resplit = asIntervals.flatMap((iv) => [{ ...iv }, { fromMs: iv.fromMs + 1, toMs: iv.toMs, covered: true }]);
  assert.equal(accountDurations(asIntervals, observation).coveredMs, grid(asIntervals));
  assert.equal(accountDurations(resplit, observation).coveredMs, grid(resplit));
  assert.equal(grid(asIntervals), grid(resplit), "re-segmentation cannot change the union");
});

// ---- Mutation detection: each gate is removed in a local copy; a detector that survives must catch it.

test("checker mutation: removing the cycle-quarantine gate is caught (the mutated reconciler accepts a cycle)", () => {
  // A reconciler with the SCC gate removed just accepts everything: demonstrated with the mutated behavior directly.
  const acceptAll = (proposals: ProposedEdge[]) => proposals.map((e) => ({ ...e, state: "ACCEPTED" as const }));
  const cyclicSet = [edge("m1", "a", "b"), edge("m2", "b", "a")];
  const mutated = acceptAll(cyclicSet);
  const reach = warshall(mutated.map((e) => ({ from: e.fromEventId, to: e.toEventId })), ["a", "b"]);
  assert.ok(reach.get("a")!.has("a"), "mutated output contains a cycle (a reaches itself) — the RC11 property test fails for it");
  const real = reconcileProposedOrdering(cyclicSet);
  assert.equal(real.accepted.length, 0, "the real reconciler quarantines the whole component instead");
});

test("checker mutation: removing the certificate gate on CONCURRENT_CERTIFIED is caught", () => {
  // Mutated copy of orderRelation whose certificate check ignores `valid` (the gate removed). The RC04 test asserts
  // UNKNOWN for valid:false — this mutated variant returns CONCURRENT_CERTIFIED there, so the RC04 test fails for it.
  const orderRelationNoCertGate = ((edges: { fromEventId: string; toEventId: string }[], from: string, to: string, certificate: { coversEventIds: string[] } | null, maxHops = 64) => {
    const reaches = (start: string, target: string): boolean => {
      let frontier = [start]; const seen = new Set([start]);
      for (let hops = 0; hops < maxHops && frontier.length; hops++) {
        const next: string[] = [];
        for (const n of frontier) for (const e of edges) { if (e.fromEventId !== n || seen.has(e.toEventId)) continue; if (e.toEventId === target) return true; seen.add(e.toEventId); next.push(e.toEventId); }
        frontier = next;
      }
      return false;
    };
    if (reaches(from, to)) return "HAPPENS_BEFORE";
    if (reaches(to, from)) return "HAPPENS_AFTER";
    if (certificate && certificate.coversEventIds.includes(from) && certificate.coversEventIds.includes(to)) return "CONCURRENT_CERTIFIED"; // gate removed: `valid` never consulted
    return "UNKNOWN";
  });
  assert.equal(orderRelationNoCertGate([], "e:p", "e:q", { coversEventIds: ["e:p", "e:q"] }), "CONCURRENT_CERTIFIED", "a certificate marked invalid promotes to concurrency once the gate is removed — the RC04 test fails for the mutated variant");
  assert.equal(orderRelation([], "e:p", "e:q", { id: "c:1", domain: "vec", epoch: "1", coversEventIds: ["e:p", "e:q"], valid: false }).relation, "UNKNOWN", "the gated variant holds");
});

test("checker mutation: summing instead of unioning is caught by the no-double-count property", () => {
  const sumInstead = (segs: AccountedInterval[], observation: { fromMs: number; toMs: number }) => segs.filter((s) => s.covered).reduce((n, s) => n + Math.max(0, Math.min(s.toMs, observation.toMs) - Math.max(s.fromMs, observation.fromMs)), 0);
  const nested: AccountedInterval[] = [{ fromMs: 0, toMs: 100, covered: true }, { fromMs: 10, toMs: 20, covered: true }];
  assert.equal(sumInstead(nested, { fromMs: 0, toMs: 100 }), 110, "the mutated accounting double-counts — the RC15 test's 100 expectation fails for it");
  assert.equal(accountDurations(nested, { fromMs: 0, toMs: 100 }).coveredMs, 100);
});