import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnswerInvestigation } from "@cie/schema";
import { pendingSourceReads, recoveryPlan, reusableObservation } from "../src/investigation-recovery.ts";
import { summarizeValidation } from "../src/answer-validation.ts";

const checkpoint = (): AnswerInvestigation => ({ id: "inv", revision: "r", question: "charged without topup or refund?", nextAction: "continue", missingEvidence: ["Recovery implementation unread"], inspectedIds: ["method:Recovery#run"], sourceHashes: {}, sourceReads: { "method:Recovery#run": { total: 100, contentHash: "h", ranges: [[50, 75], [0, 25], [20, 50]] } }, observations: [{ name: "read_code", arguments: { id: "method:Recovery#run" }, content: "source page" }, { name: "read_code", arguments: {}, content: "Failed: connection reset" }] });
test("recovery selects the first unread offset, preserves holes, and never credits a failed observation", () => {
  const c = checkpoint();
  assert.deepEqual(pendingSourceReads(c.sourceReads), [{ id: "method:Recovery#run", offset: 75 }]);
  assert.deepEqual(c.sourceReads["method:Recovery#run"].ranges, [[50, 75], [0, 25], [20, 50]]);
  c.sourceReads["method:Recovery#run"].ranges = [[0, 25], [50, 100]];
  assert.equal(recoveryPlan(c).actions[0].offset, 25);
  assert.equal(recoveryPlan(c).retainedObservations, 1);
  for (const prefix of ["Failed: timeout", "Refused: denied", "Not run: budget", "Source changed since indexing. Reindex."]) assert.equal(reusableObservation(prefix), false);
});
test("external blockers stay actionable without becoming automatic continuation or a runtime proof", () => {
  const c = checkpoint();
  for (const next of ["request_source", "request_access", "clarify", "test", "inspect_conflict"] as const) {
    c.nextAction = next;
    assert.equal(recoveryPlan(c).retryable, false);
    assert.ok(recoveryPlan(c).reason.length);
  }
  c.nextAction = "test";
  assert.match(recoveryPlan(c).reason, /isolated failure-injection/);
  c.recovery = recoveryPlan(c);
  const summary = summarizeValidation({ question: c.question, status: "UNRESOLVED", repairAttempts: 0, review: { verdict: "UNRESOLVED", relevance: false, coverage: false, evidence: false, certainty: false, consistency: false, requirements: [], gaps: c.missingEvidence, nextAction: "test" }, investigation: c });
  assert.deepEqual(summary.investigation?.recovery, c.recovery);
  assert.ok(!("observations" in summary.investigation!));
});
test("display plan is bounded while retaining the unfinished-read count", () => {
  const c = checkpoint();
  c.sourceReads = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`id:${i}`, { total: 10, contentHash: "h", ranges: [] }]));
  assert.equal(recoveryPlan(c).actions.length, 8);
  assert.equal(recoveryPlan(c).remainingSourceReads, 20);
});
