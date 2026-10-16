import type { AnswerInvestigation } from "@cie/schema";

/** A failed tool call is an attempt, never reusable evidence. */
export function reusableObservation(content: string): boolean {
  return !/^(Failed\b|Refused\b|Not run\b|Source changed since indexing\b)/i.test(content.trimStart());
}

export function pendingSourceReads(reads: AnswerInvestigation["sourceReads"]): { id: string; offset: number }[] {
  return Object.entries(reads).flatMap(([id, read]) => {
    let covered = 0;
    for (const [start, end] of [...read.ranges].sort((a, b) => a[0] - b[0])) {
      if (start > covered) break;
      covered = Math.max(covered, end);
    }
    return covered < read.total ? [{ id, offset: covered }] : [];
  });
}

/** Derived from validated checkpoint state, not model-authored tool commands. */
export function recoveryPlan(investigation: AnswerInvestigation): NonNullable<AnswerInvestigation["recovery"]> {
  const reads = pendingSourceReads(investigation.sourceReads);
  const actions = reads.slice(0, 8).map(read => ({ kind: "READ_SOURCE" as const, ...read }));
  const reason = { continue: "Continue from retained evidence; finish relevant unread source before searching more broadly.", request_source: "Provide the missing implementation or repository, then re-index.", request_access: "An authorized reader must provide or inspect the missing source.", clarify: "Clarify the unresolved requirement before drawing a conclusion.", test: "Run an isolated failure-injection test or obtain a permitted execution trace; static provenance alone cannot resolve this gap.", inspect_conflict: "Compare the conflicting implementations and identify which is active." }[investigation.nextAction];
  return { version: "recovery.v1", actions, remainingSourceReads: reads.length, reason,
    retryable: investigation.nextAction === "continue", retainedObservations: investigation.observations.filter(o => reusableObservation(o.content)).length };
}
