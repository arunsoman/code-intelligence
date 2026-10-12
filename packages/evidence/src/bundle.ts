// Bundles: an export/import envelope for reverse-engineering evidence, with an authenticable digest.
// Parse → validate → recompute every id and the bundle digest → only then trust the contents. A
// bundle whose records were edited without recomputing ids is refused (ID_MISMATCH); a bundle whose
// digest does not match its contents is refused (DIGEST_MISMATCH).
import {
  bundleDigest,
  bundleIdentityProjection,
  evidenceId,
  unknownId,
} from "./identity.ts";
import { reEvidenceBundleSchema, type ReEvidenceBundle, type ReEvidenceRecord, type ReResidualUnknown } from "./schema.ts";
import { ReEvidenceError } from "./errors.ts";

export const BUNDLE_FORMAT_VERSION = "re-evidence-bundle.v1" as const;

/** Assemble a bundle from already-stamped records. Every member must belong to the bundle's revision, and every id must already match its content — this function never rewrites an id to make a bundle fit. */
export function createReEvidenceBundle(input: { revision: string; records: readonly ReEvidenceRecord[]; unknowns: readonly ReResidualUnknown[] }): ReEvidenceBundle {
  const bundle = reEvidenceBundleSchema.omit({ digest: true }).parse({
    version: BUNDLE_FORMAT_VERSION,
    revision: input.revision,
    records: input.records,
    unknowns: input.unknowns,
  });
  for (const record of bundle.records) {
    if (record.revision !== bundle.revision) {
      throw new ReEvidenceError("INVALID_SCHEMA", `record ${record.id} belongs to revision ${record.revision}, but the bundle binds to ${bundle.revision}`);
    }
    const { id: _id, revision: _revision, state: _state, observedAt: _observedAt, ...identity } = record;
    if (record.id !== evidenceId(identity)) throw new ReEvidenceError("ID_MISMATCH", `record id ${record.id} does not match its content`);
  }
  for (const unknown of bundle.unknowns) {
    if (unknown.revision !== bundle.revision) {
      throw new ReEvidenceError("INVALID_SCHEMA", `unknown ${unknown.id} belongs to revision ${unknown.revision}, but the bundle binds to ${bundle.revision}`);
    }
    if (unknown.id !== unknownId({ question: unknown.question, revision: unknown.revision })) {
      throw new ReEvidenceError("ID_MISMATCH", `unknown id ${unknown.id} does not match its content`);
    }
  }
  return { ...bundle, digest: bundleDigest(bundle) };
}

export function serializeReEvidenceBundle(bundle: ReEvidenceBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** Recompute-and-compare authentication. Returns the parsed bundle or throws with the first reason found. */
export function parseReEvidenceBundle(text: string): ReEvidenceBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ReEvidenceError("INVALID_SCHEMA", `bundle is not JSON: ${(e as Error).message}`);
  }
  const parsed = reEvidenceBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReEvidenceError("INVALID_SCHEMA", `bundle does not match re-evidence-bundle.v1: ${parsed.error.issues[0]?.message ?? "unknown issue"}`);
  }
  return authenticateReEvidenceBundle(parsed.data);
}

/** Recompute every identity from content. Content comes first, ids second — a bundle never argues from its own ids. */
export function authenticateReEvidenceBundle(bundle: ReEvidenceBundle): ReEvidenceBundle {
  for (const record of bundle.records) {
    const { id: _id, revision: _revision, state: _state, observedAt: _observedAt, ...identity } = record;
    const expected = evidenceId(identity);
    if (record.id !== expected) throw new ReEvidenceError("ID_MISMATCH", `record claims id ${record.id} but its content is ${expected}`);
  }
  for (const unknown of bundle.unknowns) {
    const expected = unknownId({ question: unknown.question, revision: unknown.revision });
    if (unknown.id !== expected) throw new ReEvidenceError("ID_MISMATCH", `unknown claims id ${unknown.id} but its content is ${expected}`);
  }
  const expectedDigest = bundleDigest(bundle);
  if (bundle.digest !== expectedDigest) {
    throw new ReEvidenceError("DIGEST_MISMATCH", `bundle digest ${bundle.digest} does not match its contents (${expectedDigest})`);
  }
  return bundle;
}

/** The identity projection a reviewer can diff by hand, without the custody fields. */
export function bundleIdentityForReview(bundle: ReEvidenceBundle): unknown {
  return bundleIdentityProjection(bundle);
}
