// Residual unknowns: a structured record of what could not be determined, with a lifecycle. Where a
// map shows Fog, this is what stands behind it — the question, the revision it belongs to, and why it
// is open. REA's ResidualUnknown carries limitations on evidence; this carries them as first-class
// records so an investigation can list, close and audit what it never managed to pin down.
import { reResidualUnknownSchema, type ReResidualUnknown, type ReUnknownStatus } from "./schema.ts";
import { unknownId } from "./identity.ts";
import { ReEvidenceError } from "./errors.ts";

/** Allowed transitions. retired and retracted are terminal — history is kept in the ledger, not by re-opening a record. */
export const UNKNOWN_TRANSITIONS: Record<ReUnknownStatus, readonly ReUnknownStatus[]> = {
  open: ["resolved", "retired", "retracted"],
  resolved: ["retired"],
  retired: [],
  retracted: [],
};

export function canTransitionUnknown(from: ReUnknownStatus, to: ReUnknownStatus): boolean {
  return UNKNOWN_TRANSITIONS[from].includes(to);
}

/** Create a record for a question that static analysis could not answer on this revision. Two identical questions share one id — asking twice is one unknown. */
export function createResidualUnknown(input: { revision: string; question: string; createdAt?: string }): ReResidualUnknown {
  // A fresh pair, not a parse of the caller's object: createdAt is an option here, not an identity field.
  const draft = reResidualUnknownSchema.pick({ revision: true, question: true }).parse({ revision: input.revision, question: input.question });
  const now = input.createdAt ?? new Date().toISOString();
  const record: ReResidualUnknown = {
    id: unknownId(draft),
    revision: draft.revision,
    question: draft.question,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
  return reResidualUnknownSchema.parse(record);
}

/** Move an unknown through its lifecycle. The id never changes: identity is the question, not the status. */
export function transitionResidualUnknown(
  unknown: ReResidualUnknown,
  to: ReUnknownStatus,
  opts: { reason?: string; at?: string } = {},
): ReResidualUnknown {
  if (!canTransitionUnknown(unknown.status, to)) {
    throw new ReEvidenceError("UNKNOWN_STATUS", `a ${unknown.status} unknown cannot move to ${to}`);
  }
  return reResidualUnknownSchema.parse({
    ...unknown,
    status: to,
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    updatedAt: opts.at ?? new Date().toISOString(),
  });
}
