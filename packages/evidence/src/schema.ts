// re-evidence-v1 — evidence records for reverse-engineering findings about artifacts you may not have
// source for (compiled addons, minified bundles, published packages). The vocabulary is deliberately
// close to REA's (morluto/rea) evidence schema — confidence observed/derived/inferred, an authority
// class, explicit limitations, typed locations — so a finding that crosses over arrives with its
// epistemic status intact. It is a rewrite, not a port: nothing here imports REA code.
//
// Every record is content-addressed with the repository's own cross-runtime identity protocol
// (pf-canon-v1, @cie/canon): the id is a digest over an explicit identity projection, so any edit to
// what was actually observed changes the id. Timing (observedAt) and custody (state) are NOT identity.
import { z } from "zod";

/** What was directly seen, what was computed from observations, and what only looks likely. Maps onto the claim classes: observed→FACT-eligible, derived→INFERENCE, inferred→HYPOTHESIS (see gates.ts; the five claim gates still apply upstream). */
export const reConfidenceSchema = z.enum(["observed", "derived", "inferred"]);
export type ReConfidence = z.infer<typeof reConfidenceSchema>;

/** Why this finding deserves weight. "analyst-inference" is the weakest: it names a person's guess, not a machine observation. */
export const reAuthoritySchema = z.enum([
  "shipped-artifact",
  "controlled-replay",
  "historical-reference",
  "external-service",
  "analyst-inference",
]);
export type ReAuthority = z.infer<typeof reAuthoritySchema>;

export const reLocationSchema = z.strictObject({
  kind: z.enum(["address", "fileOffset", "artifactPath", "path"]),
  value: z.string().min(1),
  endValue: z.string().min(1).optional(),
});
export type ReLocation = z.infer<typeof reLocationSchema>;

/** The identity projection of an evidence record: exactly these fields, no more, no less. Timestamps, ids, revision binding and display state are custody, not observation. */
export const reEvidenceIdentitySchema = z.strictObject({
  subject: z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), format: z.string().min(1) }),
  provider: z.strictObject({ id: z.string().min(1), name: z.string().min(1), version: z.string().min(1) }),
  predicate: z.string().min(1),
  confidence: reConfidenceSchema,
  authority: reAuthoritySchema,
  limitations: z.array(z.string()).max(64),
  locations: z.array(reLocationSchema).max(64),
});
export type ReEvidenceIdentity = z.infer<typeof reEvidenceIdentitySchema>;

/** A full record as stored and exported: identity plus custody. */
export const reEvidenceRecordSchema = reEvidenceIdentitySchema.extend({
  id: z.string().regex(/^ev_[0-9a-f]{64}$/),
  revision: z.string().min(1),
  state: z.enum(["CURRENT", "STALE"]),
  observedAt: z.string().min(1),
});
export type ReEvidenceRecord = z.infer<typeof reEvidenceRecordSchema>;

/** What may arrive at an identity-ingest point: identity fields, optionally trailed by custody fields, which are ignored. Strict elsewhere on purpose; here the extra keys are the point. */
export const reEvidenceIdentityInputSchema = reEvidenceIdentitySchema.extend({
  id: z.string().optional(),
  revision: z.string().optional(),
  state: z.enum(["CURRENT", "STALE"]).optional(),
  observedAt: z.string().optional(),
});

/** A structured "this could not be determined" record, with a lifecycle. Fog on a map is a display choice; this is its source. */
export const reUnknownStatusSchema = z.enum(["open", "resolved", "retired", "retracted"]);
export type ReUnknownStatus = z.infer<typeof reUnknownStatusSchema>;

export const reResidualUnknownSchema = z.strictObject({
  id: z.string().regex(/^ru_[0-9a-f]{64}$/),
  revision: z.string().min(1),
  question: z.string().min(1),
  status: reUnknownStatusSchema,
  reason: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ReResidualUnknown = z.infer<typeof reResidualUnknownSchema>;

export const reEvidenceBundleSchema = z.strictObject({
  version: z.literal("re-evidence-bundle.v1"),
  revision: z.string().min(1),
  records: z.array(reEvidenceRecordSchema),
  unknowns: z.array(reResidualUnknownSchema),
  /** Full-form pf-canon-v1 identity of the bundle: "pf-canon-v1/cie.re-evidence-bundle@1:<hex>". */
  digest: z.string().min(1),
});
export type ReEvidenceBundle = z.infer<typeof reEvidenceBundleSchema>;
