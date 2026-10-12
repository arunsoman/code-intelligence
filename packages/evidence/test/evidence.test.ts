// re-evidence-v1 tests. Two layers:
//  1. the cross-runtime contract — every vector in fixtures/canon/re-evidence-vectors.json must
//     reproduce exactly (the Rust side, crates/worker/src/evidence.rs, reads the same file);
//  2. behaviour — unknown lifecycle, gate mapping, bundle round-trip and tamper refusals.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseStrictJson } from "@cie/canon";
import {
  authenticateReEvidenceBundle,
  bundleDigest,
  createReEvidenceBundle,
  createResidualUnknown,
  displayModeFor,
  evidenceId,
  identityFromStrictJson,
  parseReEvidenceBundle,
  serializeReEvidenceBundle,
  transitionResidualUnknown,
  UNKNOWN_TRANSITIONS,
  unknownId,
  type ReEvidenceIdentity,
  type ReEvidenceRecord,
  type ReResidualUnknown,
} from "../src/index.ts";

const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/canon/re-evidence-vectors.json", import.meta.url)), "utf8")) as {
  protocol: string;
  vectors: Array<{ id: string; op: string; inputText: string; expectedId?: string; expectedDigest?: string }>;
};

const OBSERVED_AT = "2026-10-12T00:00:00Z";
const REVISION = "rev-test-1";
const SHA = "8c85cb009ad1a0008a01500008ef4000335e7040b6e97b0026e3900044c48000";

function identity(overrides: Partial<ReEvidenceIdentity> = {}): ReEvidenceIdentity {
  return {
    subject: { path: "node_modules/native-thing/build/Release/native.node", sha256: SHA, format: "macho" },
    provider: { id: "tool", name: "Tool", version: "1.0" },
    predicate: "contains_function",
    confidence: "observed",
    authority: "shipped-artifact",
    limitations: ["names come from the symbol table"],
    locations: [{ kind: "address", value: "0x401000" }],
    ...overrides,
  };
}

function record(overrides: Partial<ReEvidenceRecord> = {}): ReEvidenceRecord {
  const { id: _id, revision, state, observedAt, ...maybeIdentity } = overrides;
  // Only defined keys override the defaults: `identity({ subject: undefined })` must not blank a field out.
  const fields = identity(Object.fromEntries(Object.entries(maybeIdentity).filter(([, v]) => v !== undefined)) as Partial<ReEvidenceIdentity>);
  return { ...fields, id: evidenceId(fields), revision: revision ?? REVISION, state: state ?? "CURRENT", observedAt: observedAt ?? OBSERVED_AT };
}

function unknown(): ReResidualUnknown {
  return createResidualUnknown({ revision: REVISION, question: "why does the addon open a socket?", createdAt: OBSERVED_AT });
}

test("cross-runtime contract: every fixture vector reproduces", () => {
  assert.equal(FIXTURE.protocol, "pf-canon-v1");
  assert.ok(FIXTURE.vectors.length >= 8, "the fixture carries the full vector set");
  for (const vector of FIXTURE.vectors) {
    if (vector.op === "evidenceId") {
      assert.equal(evidenceId(identityFromStrictJson(vector.inputText)), vector.expectedId, `vector ${vector.id}`);
    } else if (vector.op === "unknownId") {
      const input = parseStrictJson(vector.inputText) as { question: string; revision: string };
      assert.equal(unknownId(input), vector.expectedId, `vector ${vector.id}`);
    } else if (vector.op === "bundleDigest") {
      const bundle = parseStrictJson(vector.inputText) as { revision: string; records: ReEvidenceRecord[]; unknowns: ReResidualUnknown[] };
      assert.equal(bundleDigest(bundle), vector.expectedDigest, `vector ${vector.id}`);
    } else {
      assert.fail(`vector ${vector.id} has unknown op ${vector.op}`);
    }
  }
});

test("bundle round-trip: create, serialize, parse, authenticate", () => {
  const bundle = createReEvidenceBundle({ revision: REVISION, records: [record()], unknowns: [unknown()] });
  const round = parseReEvidenceBundle(serializeReEvidenceBundle(bundle));
  assert.equal(round.digest, bundle.digest);
  assert.equal(authenticateReEvidenceBundle(bundle).digest, bundle.digest);
});

test("bundle refuses a record whose id does not match its content", () => {
  const bundle = createReEvidenceBundle({ revision: REVISION, records: [record()], unknowns: [] });
  const tampered = { ...bundle, records: [{ ...bundle.records[0]!, confidence: "inferred" as const }] };
  assert.throws(() => authenticateReEvidenceBundle(tampered), /but its content is/);
});

test("bundle refuses a digest that does not match its contents", () => {
  const bundle = createReEvidenceBundle({ revision: REVISION, records: [record()], unknowns: [] });
  const tampered = { ...bundle, digest: `pf-canon-v1/cie.re-evidence-bundle@1:${"0".repeat(64)}` };
  assert.throws(() => authenticateReEvidenceBundle(tampered), /DIGEST_MISMATCH|does not match its contents/);
});

test("bundle refuses members bound to a different revision", () => {
  const stranger = record({ revision: "rev-other" });
  assert.throws(() => createReEvidenceBundle({ revision: REVISION, records: [stranger], unknowns: [] }), /belongs to revision rev-other/);
});

test("parse refuses text that is not a bundle", () => {
  assert.throws(() => parseReEvidenceBundle('{"nope":true}'), /re-evidence-bundle/);
  assert.throws(() => parseReEvidenceBundle("not json at all"), /not JSON/);
});

test("unknown lifecycle: open → resolved → retired; retired is terminal", () => {
  const opened = unknown();
  const resolved = transitionResidualUnknown(opened, "resolved", { reason: "symbol table says no", at: OBSERVED_AT });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.id, opened.id, "identity is the question, not the status");
  const retired = transitionResidualUnknown(resolved, "retired", { at: OBSERVED_AT });
  assert.equal(retired.status, "retired");
  assert.throws(() => transitionResidualUnknown(retired, "open"), /cannot move/);
  assert.throws(() => transitionResidualUnknown(opened, "open"), /cannot move/);
});

test("unknown transitions table is closed", () => {
  // "retired" sorts before "retracted" (fourth code unit i < r).
  assert.deepEqual(Object.keys(UNKNOWN_TRANSITIONS).sort(), ["open", "resolved", "retired", "retracted"]);
});

test("gate mapping: observed→FACT, derived→INFERENCE, inferred→HYPOTHESIS; model-authored never FACT", () => {
  assert.equal(displayModeFor({ confidence: "observed" }), "FACT");
  assert.equal(displayModeFor({ confidence: "derived" }), "INFERENCE");
  assert.equal(displayModeFor({ confidence: "inferred" }), "HYPOTHESIS");
  assert.equal(displayModeFor({ confidence: "observed" }, { modelAuthored: true }), "INFERENCE");
  assert.equal(displayModeFor({ confidence: "inferred" }, { modelAuthored: true }), "HYPOTHESIS");
});

test("two records with the same observation but different custody share one id", () => {
  assert.equal(record().id, record({ observedAt: "1999-01-01T00:00:00Z", state: "STALE" }).id);
});

test("locations are a sequence: reordering them changes the id (limitations do not)", () => {
  const twoLocations = identity({ locations: [{ kind: "address", value: "0x401000" }, { kind: "fileOffset", value: "0x10" }] });
  assert.notEqual(evidenceId(twoLocations), evidenceId({ ...twoLocations, locations: [...twoLocations.locations].reverse() }));
  const flippedLimitations = identity({ limitations: [...identity().limitations].reverse() });
  assert.equal(evidenceId(identity()), evidenceId(flippedLimitations));
});
