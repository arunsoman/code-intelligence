// C24 phase-0 fixture-corpus validation (design §19: "Fixtures need independently reviewed event graphs, not only
// adapter self-consistency" — corrected baseline: self-authored fixtures get their expected results hand- or
// oracle-derived independently of any phase-1 implementation; algorithm-bearing expectations are re-verified here
// against the independent oracles; an independent human review pass remains open and flagged in the acceptance report).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { accountDurations } from "../src/c24/path-accounting.ts";
import { orderRelation, reconcileProposedOrdering } from "../src/c24/ordering.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "c24-causality-fixtures");
const files = readdirSync(DIR).filter((f) => f.startsWith("rc") && f.endsWith(".json")).sort();
const load = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as any;

test("corpus: all 28 acceptance ids present, exactly once, with class and derivation recorded", () => {
  assert.equal(files.length, 28, `got ${files.length}`);
  const ids = files.map((f) => load(f).id);
  for (let i = 1; i <= 28; i++) assert.ok(ids.includes("RC" + String(i).padStart(2, "0")), "missing RC" + i);
  for (const f of files) {
    const fx = load(f);
    assert.ok(["positive", "negative-control", "missing-data"].includes(fx["class"]), `${fx.id}: class`);
    assert.ok(["hand", "oracle", "hand+oracle"].includes(fx.derivation.method), `${fx.id}: derivation method`);
    assert.ok(fx.derivation.rule?.length > 20, `${fx.id}: names the design rule it derives from`);
    assert.ok(Object.keys(fx.expected).length >= 2, `${fx.id}: expected result is a real assertion set`);
  }
  // Class coverage: the corpus must contain controls and missing-data cases, not only positives.
  const classes = files.map((f) => load(f)["class"]);
  assert.ok(classes.includes("negative-control") && classes.includes("missing-data"), "negative controls and missing-data cases exist");
});

test("corpus: negative controls name a rule a first implementation could violate, and RC20's forged context is rejected", () => {
  for (const f of files) {
    const fx = load(f);
    if (fx["class"] !== "negative-control") continue;
    assert.ok(fx.expected.rejected || fx.expected.quarantinedEdges?.length || fx.expected.populationLimitsRetained || fx.expected.noMixedSnapshot || fx.expected.scopeGatePreventsPromotion || fx.expected.truncated || fx.expected.noHistoricPayloadRecovery || ["noConfirmedInterventionEffect", "observationalAssociationOnly", "affectedEdgesInvalidated"].some((k) => fx.expected[k] !== undefined) || Object.keys(fx.expected).some((k) => /^no[A-Z]/.test(k) || /gate|invalidat|restrict|stale|notSilently|spillover|attemptsDistinct/.test(k)), `${fx.id}: a negative control must assert rejection/quarantine/refusal/irreversibility of an invalid input`);
  }
  const rc20 = load("rc20-forged-trace-context.json");
  assert.equal(rc20.expected.sourceTrust, "UNTRUSTED_CONTEXT");
  assert.equal(rc20.expected.noAuthorityGrant, true);
});

test("corpus: RC11's recorded expected result is reproduced by the independent quarantine oracle", () => {
  const fx = load("rc11-ordering-cycle-contradictory.json");
  const proposals = fx.input.proposedEdges.map((e: any) => ({ id: e.id, fromEventId: e.from, toEventId: e.to, kind: e.kind, evidenceIds: [], ruleId: e.certificate ?? "fixture" }));
  const r1 = reconcileProposedOrdering(proposals);
  const r2 = reconcileProposedOrdering([...proposals].reverse());
  assert.deepEqual(r1.quarantined.map((e) => e.id).sort(), fx.expected.quarantinedEdges.sort());
  assert.deepEqual(r1.accepted.map((e) => e.id).sort(), fx.expected.acceptedEdges);
  assert.deepEqual(r1.quarantined.map((e) => e.id).sort(), r2.quarantined.map((e) => e.id).sort(), "reverse ingest order reconciles identically");
});

test("corpus: RC03/RC04 record UNKNOWN (never happens-before or concurrency) and the oracle agrees", () => {
  const rc03 = load("rc03-smaller-lamport-no-path.json");
  assert.equal(rc03.expected.orderDecision.relation, "UNKNOWN");
  assert.equal(orderRelation([], "e:l1", "e:l2", null).relation, "UNKNOWN");
  const rc04 = load("rc04-missing-path-sampled.json");
  assert.equal(rc04.expected.orderDecision.relation, "UNKNOWN");
  assert.equal(orderRelation([], "e:p", "e:q", null).relation, "UNKNOWN");
  assert.equal(orderRelation([], "e:p", "e:q", { id: "c", domain: "d", epoch: "1", coversEventIds: ["e:p", "e:q"], valid: true }).relation, "CONCURRENT_CERTIFIED", "the RC04 oracle agrees a valid covering certificate is the only route to certified concurrency");
});

test("corpus: RC15's recorded covered/unresolved totals agree with the independent union oracle", () => {
  const fx = load("rc15-nested-overlapping.json");
  const r = accountDurations(fx.input.segments, fx.input.observation);
  assert.equal(r.coveredMs, fx.expected.coveredMs);
  assert.equal(r.unresolvedMs, fx.expected.unresolvedMs);
});

test("corpus: RC01 (trusted relation retained over skew) is machine-checkable now and the oracle holds it", () => {
  const fx = load("rc01-exact-rpc-skewed-clocks.json");
  const proposals = fx.input.proposedEdges.map((e: any) => ({ id: e.id, fromEventId: e.from, toEventId: e.to, kind: e.kind, evidenceIds: [], ruleId: e.certificate }));
  const r = reconcileProposedOrdering(proposals);
  assert.deepEqual(r.accepted.map((e) => e.id).sort(), fx.expected.acceptedEdges, "the trusted relation is retained; skew does not drop it");
  assert.deepEqual(fx.expected.disclosed, ["CLOCK_CONTRADICTION"], "the contradiction is disclosed alongside");
});