// Generates fixtures/canon/re-evidence-vectors.json — the one-file cross-runtime contract shared by
// packages/evidence (TypeScript) and crates/worker/src/evidence.rs (Rust), in the same spirit as
// fixtures/canon/canon-vectors.json for pf-canon-v1 itself. Expected values are computed here with
// the canon primitives only; the Rust implementation is written from the projection rules in
// packages/evidence/src/identity.ts and must reproduce every digest without reading this generator.
//
// Run: node scripts/gen-re-evidence-vectors.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonDigest, canonicalize } from "../packages/canon/src/index.ts";
import {
  BUNDLE_SCHEMA,
  EVIDENCE_SCHEMA,
  PROTOCOL_VERSION,
  UNKNOWN_SCHEMA,
  bundleIdentityProjection,
  bundleDigest,
  evidenceIdentityProjection,
  evidenceId,
  unknownId,
  unknownIdentityProjection,
} from "../packages/evidence/src/index.ts";
import type { ReEvidenceRecord, ReResidualUnknown } from "../packages/evidence/src/index.ts";

const OBSERVED_AT = "2026-10-12T00:00:00Z";
const REVISION = "rev-fixture-1";
const SHA = (s: string) => {
  // A stable stand-in sha256 for fixture subjects (64 hex chars, not a real digest of anything).
  let h = "";
  let seed = 0;
  for (const c of s) seed = (seed * 31 + c.codePointAt(0)!) >>> 0;
  for (let i = 0; i < 8; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    h += seed.toString(16).padStart(8, "0").slice(0, 8);
  }
  return h.slice(0, 64);
};

const identityOf = (r: ReEvidenceRecord) => {
  const { id: _id, revision: _revision, state: _state, observedAt: _observedAt, ...identity } = r;
  return identity;
};

const baseRecord: Omit<ReEvidenceRecord, "id"> = {
  revision: REVISION,
  state: "CURRENT",
  observedAt: OBSERVED_AT,
  subject: { path: "node_modules/native-thing/build/Release/native.node", sha256: SHA("native.node"), format: "macho" },
  provider: { id: "rea-inspired-tool", name: "RE Evidence Tool", version: "0.1.0" },
  predicate: "contains_function",
  confidence: "observed",
  authority: "shipped-artifact",
  limitations: ["naming comes from the symbol table, not from debug info", "control flow is not reconstructed"],
  locations: [{ kind: "address", value: "0x401000", endValue: "0x4010c4" }],
};

const recordA: ReEvidenceRecord = { ...baseRecord, id: "" };
const idA = evidenceId(identityOf(recordA));
recordA.id = idA;

const recordB: ReEvidenceRecord = {
  ...baseRecord,
  id: "",
  subject: { path: "dist/app.min.js", sha256: SHA("app.min.js"), format: "javascript-bundle" },
  predicate: "recovered_source_map",
  confidence: "derived",
  authority: "controlled-replay",
  limitations: ["recovered names may not match the original authors'"],
  locations: [{ kind: "artifactPath", value: "dist/app.min.js.map" }],
};
const idB = evidenceId(identityOf(recordB));
recordB.id = idB;

const unknown: ReResidualUnknown = {
  id: "",
  revision: REVISION,
  question: "does the native addon export symbols beyond its declared napi list?",
  status: "open",
  createdAt: OBSERVED_AT,
  updatedAt: OBSERVED_AT,
};
unknown.id = unknownId({ question: unknown.question, revision: unknown.revision });

const bundleInput = { revision: REVISION, records: [recordB, recordA], unknowns: [unknown] };

// --- vectors --------------------------------------------------------------------------------------------

const fullIdentityText = JSON.stringify(identityOf(recordA));
const expectedCanonical = canonicalize(evidenceIdentityProjection(identityOf(recordA)));

const vectors: Array<Record<string, string>> = [
  // Key order must not matter: the same record written with keys in the other order hashes identically.
  { id: "ev-keys-order-a", op: "evidenceId", inputText: fullIdentityText, expectedCanonical, expectedId: idA },
  {
    id: "ev-keys-order-b",
    op: "evidenceId",
    inputText: JSON.stringify({
      locations: identityOf(recordA).locations,
      limitations: identityOf(recordA).limitations,
      authority: identityOf(recordA).authority,
      predicate: identityOf(recordA).predicate,
      confidence: identityOf(recordA).confidence,
      provider: identityOf(recordA).provider,
      subject: identityOf(recordA).subject,
    }),
    expectedCanonical,
    expectedId: idA,
  },
  // Multibyte strings survive the round trip: the canonical bytes carry them literally.
  {
    id: "ev-unicode",
    op: "evidenceId",
    inputText: JSON.stringify({
      subject: { path: "node_modules/日本語-パック/∑.wasm", sha256: SHA("unicode"), format: "wasm" },
      provider: { id: "résumé", name: "Tööl", version: "1.0" },
      predicate: "exports_symbol ✅",
      confidence: "observed",
      authority: "shipped-artifact",
      limitations: ["emoji limitations are allowed: 🧩"],
      locations: [{ kind: "address", value: "0x0" }],
    }),
    expectedId: evidenceId({
      subject: { path: "node_modules/日本語-パック/∑.wasm", sha256: SHA("unicode"), format: "wasm" },
      provider: { id: "résumé", name: "Tööl", version: "1.0" },
      predicate: "exports_symbol ✅",
      confidence: "observed",
      authority: "shipped-artifact",
      limitations: ["emoji limitations are allowed: 🧩"],
      locations: [{ kind: "address", value: "0x0" }],
    }),
  },
  // Limitations are a set: order must not matter.
  {
    id: "ev-limitations-order",
    op: "evidenceId",
    inputText: JSON.stringify({ ...identityOf(recordA), limitations: [...identityOf(recordA).limitations].reverse() }),
    expectedId: idA,
  },
  // (Locations are a sequence, so reversing them changes the id — asserted as unit tests on both runtimes, not as an equality vector.)
  // Custody fields are not identity: the same observation recorded twice at different times is one finding.
  {
    id: "ev-custody-ignored",
    op: "evidenceId",
    inputText: JSON.stringify({ ...identityOf(recordA), state: "STALE", observedAt: "1999-01-01T00:00:00Z", revision: "rev-other" }),
    expectedId: idA,
  },
  // Residual unknown.
  { id: "ru-basic", op: "unknownId", inputText: JSON.stringify({ question: unknown.question, revision: REVISION }), expectedId: unknown.id },
  {
    id: "ru-keys-order",
    op: "unknownId",
    inputText: JSON.stringify({ revision: REVISION, question: unknown.question }),
    expectedId: unknown.id,
  },
  // Bundle digest: members given out of id order still hash to the sorted identity.
  { id: "reb-two-records", op: "bundleDigest", inputText: JSON.stringify(bundleInput), expectedDigest: bundleDigest(bundleInput) },
  {
    id: "reb-records-sorted",
    op: "bundleDigest",
    inputText: JSON.stringify({ revision: REVISION, records: [recordA, recordB], unknowns: [unknown] }),
    expectedDigest: bundleDigest(bundleInput),
  },
  // Tampering with an observed field changes the digest even when ids are untouched.
  {
    id: "reb-tampered",
    op: "bundleDigest",
    inputText: JSON.stringify({
      ...bundleInput,
      records: bundleInput.records.map((r) => (r.id === recordA.id ? { ...r, confidence: "inferred" } : r)),
    }),
    expectedDigest: bundleDigest({ ...bundleInput, records: bundleInput.records.map((r) => (r.id === recordA.id ? { ...r, confidence: "inferred" } : r)) }),
  },
];

const fixture = {
  protocol: "pf-canon-v1",
  note: "re-evidence-v1: digests computed by scripts/gen-re-evidence-vectors.ts with @cie/canon; evidence ids are ev_<hex over cie.re-evidence@1>, unknowns ru_<hex over cie.re-unknown@1>, bundles full-form pf-canon-v1/cie.re-evidence-bundle@1:<hex>. Read by node --test and cargo test.",
  schema: EVIDENCE_SCHEMA,
  version: PROTOCOL_VERSION,
  unknownSchema: UNKNOWN_SCHEMA,
  bundleSchema: BUNDLE_SCHEMA,
  vectors,
};

const out = fileURLToPath(new URL("../fixtures/canon/re-evidence-vectors.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${out} with ${vectors.length} vectors`);
console.log(`  evidence id: ${idA.slice(0, 24)}…`);
console.log(`  bundle digest: ${bundleDigest(bundleInput).slice(0, 48)}…`);
// Sanity: the shared projection helper must agree with the plain digest path.
const sanity = `${"pf-canon-v1"}/${BUNDLE_SCHEMA}@1:${canonDigest(BUNDLE_SCHEMA, "1", canonicalize(bundleIdentityProjection(bundleInput)))}`;
if (sanity !== bundleDigest(bundleInput)) throw new Error("bundle digest mismatch between helpers");
