// Identity: every record is named by what was observed, hashed with the repository's cross-runtime
// protocol. The same projection is implemented in crates/worker/src/evidence.rs; both sides are held
// to every vector in fixtures/canon/re-evidence-vectors.json. Changing this file without changing the
// Rust side (or without regenerating the fixture) breaks identities across the boundary — the tests
// are the contract.
import { canonDigest, compareBytes, canonicalize, parseStrictJson } from "@cie/canon";
import type { Canon } from "@cie/canon";
import {
  reEvidenceIdentityInputSchema,
  reEvidenceIdentitySchema,
  reResidualUnknownSchema,
  type ReEvidenceBundle,
  type ReEvidenceIdentity,
  type ReResidualUnknown,
} from "./schema.ts";
import { ReEvidenceError } from "./errors.ts";

export const EVIDENCE_SCHEMA = "cie.re-evidence";
export const UNKNOWN_SCHEMA = "cie.re-unknown";
export const BUNDLE_SCHEMA = "cie.re-evidence-bundle";
export const PROTOCOL_VERSION = "1";

const canonString = (s: string): Canon => s;
const canonArrayOfStrings = (values: readonly string[]): Canon => values.map(canonString);

/** Sort + dedupe by UTF-8 bytes: a limitation list is a set, and both runtimes must agree on that. */
const sortedUnique = (values: readonly string[]): string[] => {
  const sorted = [...values].sort(compareBytes);
  return sorted.filter((v, i) => i === 0 || v !== sorted[i - 1]);
};

/** The identity projection of an evidence record. Locations keep their given order (an ordered walk of addresses means something); limitations do not. Custody fields, when present, are ignored. */
export function evidenceIdentityProjection(input: ReEvidenceIdentity): Canon {
  const parsed = reEvidenceIdentityInputSchema.parse(input);
  return {
    authority: canonString(parsed.authority),
    confidence: canonString(parsed.confidence),
    limitations: canonArrayOfStrings(sortedUnique(parsed.limitations)),
    locations: parsed.locations.map((l): Canon => l.endValue === undefined ? { kind: canonString(l.kind), value: canonString(l.value) } : { endValue: canonString(l.endValue), kind: canonString(l.kind), value: canonString(l.value) }),
    predicate: canonString(parsed.predicate),
    provider: { id: canonString(parsed.provider.id), name: canonString(parsed.provider.name), version: canonString(parsed.provider.version) },
    subject: { format: canonString(parsed.subject.format), path: canonString(parsed.subject.path), sha256: canonString(parsed.subject.sha256) },
  };
}

/** `ev_<hex>` — the stored id. Observed facts get names, not timestamps. */
export function evidenceId(input: ReEvidenceIdentity): string {
  return `ev_${canonDigest(EVIDENCE_SCHEMA, PROTOCOL_VERSION, canonicalize(evidenceIdentityProjection(input)))}`;
}

/** The identity projection of a residual unknown: the question and the revision it was asked against, nothing else. Status changes are custody. */
export function unknownIdentityProjection(unknown: Pick<ReResidualUnknown, "question" | "revision">): Canon {
  // A fresh pair, not a pick().parse() of the caller's object: full records carry custody fields that a strict schema rightly refuses.
  const parsed = reResidualUnknownSchema.pick({ question: true, revision: true }).parse({ question: unknown.question, revision: unknown.revision });
  return { question: canonString(parsed.question), revision: canonString(parsed.revision) };
}

/** `ru_<hex>`. Asking the same question about the same revision twice is one unknown, not two. */
export function unknownId(input: Pick<ReResidualUnknown, "question" | "revision">): string {
  return `ru_${canonDigest(UNKNOWN_SCHEMA, PROTOCOL_VERSION, canonicalize(unknownIdentityProjection(input)))}`;
}

/** The identity projection of a bundle: every member's identity, sorted by id. Tampering with any observed field changes the digest. */
export function bundleIdentityProjection(bundle: Pick<ReEvidenceBundle, "revision" | "records" | "unknowns">): Canon {
  const records = [...bundle.records].sort((a, b) => compareBytes(a.id, b.id));
  const unknowns = [...bundle.unknowns].sort((a, b) => compareBytes(a.id, b.id));
  return {
    records: records.map((r): Canon => {
      const { id: _id, revision: _revision, state: _state, observedAt: _observedAt, ...identity } = r;
      return evidenceIdentityProjection(identity);
    }),
    revision: canonString(bundle.revision),
    unknowns: unknowns.map((u): Canon => unknownIdentityProjection(u)),
  };
}

/** Full-form pf-canon-v1 identity: "pf-canon-v1/cie.re-evidence-bundle@1:<hex>". */
export function bundleDigest(bundle: Pick<ReEvidenceBundle, "revision" | "records" | "unknowns">): string {
  return `${"pf-canon-v1"}/${BUNDLE_SCHEMA}@${PROTOCOL_VERSION}:${canonDigest(BUNDLE_SCHEMA, PROTOCOL_VERSION, canonicalize(bundleIdentityProjection(bundle)))}`;
}

/** Strict-JSON ingress for the shared fixture vectors: duplicate keys, floats, exponents and lone surrogates are refused, exactly as the Rust side refuses them. Custody fields may trail the identity; they are ignored. */
export function identityFromStrictJson(text: string): ReEvidenceIdentity {
  const value = parseStrictJson(text);
  const parsed = reEvidenceIdentityInputSchema.safeParse(value);
  if (!parsed.success) throw new ReEvidenceError("INVALID_SCHEMA", `not a valid evidence identity: ${parsed.error.issues[0]?.message ?? "unknown issue"}`);
  const { id: _id, revision: _rev, state: _state, observedAt: _at, ...identity } = parsed.data;
  return identity;
}
