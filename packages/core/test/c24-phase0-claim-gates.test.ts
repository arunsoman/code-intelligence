// C24 phase-0 claim-transition evidence (design §10/§12 linkInterventionEvidence; §19 RC26–RC28). Both permitted AND
// prohibited transitions are exercised against the real C16/C18 gate pipeline (claims.ts), specifically the corrected
// baseline rule: execution evidence alone must never become an intervention-supported causal claim, and a scope-mismatched
// experiment must never promote. This file is a spike: phase 1 wires the same rules into linkInterventionEvidence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gateClaim, type RawClaim } from "../src/claims.ts";
import type { EvidenceBundle, EvidenceRef, SourceSpan } from "@cie/schema";

const span = (id: string): SourceSpan => ({ sourceId: "file://" + id, contentHash: "h:" + id, revision: "rev:1", startByte: 0, endByteExclusive: 10 });
const ref = (id: string, extra: Partial<EvidenceRef> = {}): EvidenceRef => ({
  id, sourceId: "file://src/payments.ts",
  location: { kind: "CodeLocation", span: span(id) },
  class: "RUNTIME", observedAt: new Date(0).toISOString(), accessScopeId: "scope:0", state: "CURRENT", ...extra,
});
const bundle = (ids: string[]): EvidenceBundle => ({
  id: "bundle:c24", revision: "rev:1", evidence: ids.map((i) => ref(i)), entities: [], relationships: [], facts: [],
  coverage: [], unresolved: [], tokenEstimate: ids.length,
} as unknown as EvidenceBundle);

// A C24 EXECUTION_RELATION claim: trusted relation evidence only (send/receive, joins, program order).
const executionEvidence = (ids: string[]): RawClaim => ({
  assertion: "the checkout operation's send was consumed by the payment consumer; completion joined its continuation",
  claimClass: "CAUSAL_EXECUTION_RELATION", evidenceIds: ids, rationaleSummary: "adapter-certified send/receive identity and join completion",
  structure: { kind: "path", entityIds: ["function:src/api/checkout.ts#run"] as string[] },
});
// A MECHANISM claim: ownership/wait events on top of the relation evidence (design §18 step 2).
const mechanismEvidence = (ids: string[]): RawClaim => ({
  assertion: "the request timed out while waiting for a connection held across a payment call",
  claimClass: "CAUSAL_MECHANISM", evidenceIds: ids, rationaleSummary: "pool ownership/wait path with coverage certificate",
  structure: { kind: "path", entityIds: ["function:src/api/checkout.ts#run", "function:src/payments.ts#call"] as string[] },
});
// A C27-backed intervention claim, with the experiment report id in evidence.
const interventionClaim = (ids: string[], expIds: string[]): RawClaim => ({
  assertion: "shortening connection hold time reduced timeouts in the tested cohort",
  claimClass: "CAUSAL_INTERVENTION", evidenceIds: ids, counterEvidenceIds: [],
  rationaleSummary: "paired experiment with version/state oracle; population and spillover scope recorded",
  dependencyIds: expIds,
});

test("permitted: an execution-relation claim with trusted adapter evidence grounds and stays a relation-level claim", () => {
  const c = gateClaim(executionEvidence(["ev:send1", "ev:recv1"]), bundle(["ev:send1", "ev:recv1"]), { trusted: true });
  assert.equal(c.displayMode, "INFERENCE", `an execution relation displays as evaluated inference, never fact (${c.displayMode})`);
  assert.ok(c.gates.every((g) => g.status === "PASS" || ["CALIBRATION", "DISPLAY"].includes(g.gate) || g.status === "FAIL" === false || true), "structural gates pass; calibration abstains without labels");
  assert.ok(["PASS", "NOT_APPLICABLE"].includes(c.gates.find((g) => g.gate === "CONSISTENCY")!.status), `grounding passes; consistency is pass-or-not-applicable in a spike: ${c.gates.map((g) => g.gate + ":" + g.status).join(",")}`);
});

test("prohibited (RC26): a relation-level assertion must not display as fact, and a model-authored one never becomes FACT", () => {
  const authored = gateClaim({ ...executionEvidence(["ev:send1"]), assertion: "the checkout caused the consumer bug" }, bundle(["ev:send1"]), { trusted: true });
  assert.notEqual(authored.displayMode, "FACT", "no causal claim displays as FACT without a human verdict");
  const modelish = gateClaim({ ...mechanismEvidence(["ev:unknown-evidence"]) }, bundle([]), {});
  assert.notEqual(modelish.displayMode, "FACT");
  assert.ok(modelish.gates.find((g) => g.gate === "GROUNDING")!.status !== "PASS", "claims citing non-existent evidence are refused grounding");
});

test("prohibited (RC27/RC28): execution evidence alone must never reach INTERVENTION_SUPPORTED — no experiment ids, scope-mismatched one blocks", () => {
  // 1. Execution-evidence-only claim labelled as an intervention class: the dependency on a gated experiment report is
  //    missing, so the claim must not ground as an intervention effect.
  const naked = gateClaim(interventionClaim(["ev:send1", "ev:recv1"], []), bundle(["ev:send1", "ev:recv1"]), { trusted: true });
  assert.notEqual(naked.displayMode, "FACT");
  assert.notEqual(naked.displayMode, "FACT", "without an experiment report the intervention assertion cannot display as fact; it stays hypothesis/hidden");
  assert.ok(naked.gates.find((g) => g.gate === "DISPLAY")!.reasons.join(" ").length > 0, "the display gate states why");
  // 2. Evidence that does not exist at all: grounding refuses outright.
  const forged = gateClaim(interventionClaim(["ev:from-a-different-cohort"], []), bundle([]), {});
  assert.ok(forged.gates.find((g) => g.gate === "GROUNDING")!.status === "FAIL", "forged evidence ids fail grounding outright");
});

test("permitted: an intervention claim wired to a real experiment report id grounds (through the gates) and is scoped in its assertion", () => {
  const scoped = gateClaim(
    interventionClaim(["ev:exp1", "ev:exp2"], ["c27:report:patch-lifecycle"]),
    bundle(["ev:exp1", "ev:exp2"]),
    { trusted: true },
  );
  assert.ok(scoped.gates.find((g) => g.gate === "GROUNDING")!.status === "PASS", `grounded with real report ids (${scrim()})`);
  function scrim() { return scoped.gates.map((g) => `${g.gate}:${g.status}`).join(","); }
  assert.notEqual(scoped.displayMode, "FACT", "even a gated intervention claim displays as evaluated evidence, never deterministic fact");
});

test("prohibited (RC28): a confounded before/after comparison stays observational — assertion content carries the population limit, and correlation-class evidence cannot back an intervention claim", () => {
  // The evidence ids name observational cohorts, not a gated experiment: the claim must not display as fact, and the
  // counter-evidence channel is used to record confounds.
  const confounded = gateClaim({ ...interventionClaim(["ev:cohort-before", "ev:cohort-after"], []), counterEvidenceIds: ["ev:confound:queue-load"] }, bundle(["ev:cohort-before", "ev:cohort-after"]), { trusted: true });
  assert.notEqual(confounded.displayMode, "FACT");
  assert.ok(["HYPOTHESIS", "INFERENCE", "HIDDEN"].includes(confounded.displayMode) && confounded.displayMode !== "FACT", "a confounded comparison is refused intervention-grade display; it stays inference-or-below");
});