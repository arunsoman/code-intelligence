import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvidenceAssessment } from "../../../packages/core/src/c22/types.ts";
import { comparison, discriminates } from "../src/investigation.ts";

const h = { id: "h1", version: 2, evaluation: { freshness: "CURRENT" as const } };
const other = { ...h, id: "h2" };
const o = { id: "o", retracted: false };
const assessment = (over: Partial<EvidenceAssessment> = {}): EvidenceAssessment => ({
  id: "a", hypothesisId: h.id, hypothesisVersion: h.version, observationId: o.id,
  relation: "SUPPORTS", predictionId: "p", claimId: "c", gateReportId: "g", correlationGroupId: "source", snapshotHash: "s", scopeHash: "s", accepted: true, stale: false, reasonCodes: [], createdAt: "", ...over,
});
test("comparison never turns missing, rejected, retracted, old-version or stale evidence into a contradiction", () => {
  assert.equal(comparison(h, o, []).label, "Not assessed");
  assert.equal(comparison(h, o, [assessment({ hypothesisVersion: 1, relation: "CONTRADICTS" })]).label, "Not assessed");
  assert.equal(comparison(h, o, [assessment({ accepted: false, relation: "CONTRADICTS" })]).label, "Not accepted");
  assert.equal(comparison(h, o, [assessment({ stale: true })]).label, "Stale");
  assert.equal(comparison(h, { ...o, retracted: true }, [assessment()]).label, "Retracted");
  assert.equal(comparison({ ...h, evaluation: { freshness: "STALE" } }, o, [assessment()]).label, "Stale");
});
test("discrimination requires accepted current support and contradiction across candidates", () => {
  const a = assessment(), b = assessment({ id: "b", hypothesisId: other.id, relation: "CONTRADICTS" });
  assert.equal(discriminates([h, other], o, [a, b]), true);
  assert.equal(discriminates([h, other], o, [a, { ...b, stale: true }]), false);
  assert.equal(discriminates([h, other], { ...o, retracted: true }, [a, b]), false);
  assert.equal(discriminates([h, other], o, [a]), false);
  assert.equal(discriminates([h], o, [a, { ...b, hypothesisId: h.id }]), false);
});
