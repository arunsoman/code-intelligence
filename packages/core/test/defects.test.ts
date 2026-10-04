import assert from "node:assert/strict";
import { test } from "node:test";
import type { LockOrderFact, MemoryAccessFact } from "@cie/schema";
import { compareBenchmark, detectDefects, detectLockOrderCycles, detectMemoryRaces } from "../src/defects.ts";
import { ctx, setup } from "./helpers.ts";

const lock = (id: string, entityId: string, heldLockId: string, acquiredLockId: string, over: Partial<LockOrderFact> = {}): LockOrderFact => ({
  id, entityId, heldLockId, acquiredLockId, acquireKind: "BLOCKING", evidenceIds: [`ev:${id}`], resolution: "RESOLVED", ...over,
});
const access = (id: string, entityId: string, contextId: string, mode: "READ" | "WRITE", over: Partial<MemoryAccessFact> = {}): MemoryAccessFact => ({
  id, entityId, contextId, mode, accessPath: "account.balance", atomic: false, concurrentWith: [], happensBefore: [], evidenceIds: [`ev:${id}`], aliasState: "RESOLVED", ...over,
});

test("DP01: lock inversion produces a static candidate with both paths, never an observed-deadlock claim", () => {
  const findings = detectLockOrderCycles("rev", [lock("a", "worker-a", "L1", "L2"), lock("b", "worker-b", "L2", "L1")]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "DEADLOCK_CANDIDATE");
  assert.equal(findings[0].evidenceLevel, "STATIC_CANDIDATE");
  assert.equal(findings[0].witness?.paths.length, 2);
  assert.match(findings[0].witness!.detail, /Potential/);
});

test("DP02: reentrant edges are excluded and try-lock/global-guard controls remain explicit gaps", () => {
  assert.equal(detectLockOrderCycles("rev", [lock("r", "one", "L", "L", { acquireKind: "REENTRANT" })]).length, 0);
  const result = detectLockOrderCycles("rev", [
    lock("a", "one", "L1", "L2", { acquireKind: "TRY", globalGuardId: "G" }),
    lock("b", "two", "L2", "L1", { globalGuardId: "G" }),
  ])[0];
  assert.match(result.coverageGaps.join(" "), /try-lock/);
  assert.match(result.coverageGaps.join(" "), /global guard/);
});

test("DP03: conflicting concurrent accesses are candidates; reads, atomics and happens-before are controls", () => {
  const a = access("a", "debit", "t1", "READ", { concurrentWith: ["t2"] });
  const b = access("b", "credit", "t2", "WRITE", { concurrentWith: ["t1"] });
  assert.equal(detectMemoryRaces("rev", [a, b]).length, 1);
  assert.equal(detectMemoryRaces("rev", [a, { ...b, mode: "READ" }]).length, 0);
  assert.equal(detectMemoryRaces("rev", [a, { ...b, atomic: true }]).length, 1, "mixed atomic/non-atomic accesses still conflict");
  assert.equal(detectMemoryRaces("rev", [{ ...a, atomic: true }, { ...b, atomic: true }]).length, 0);
  assert.equal(detectMemoryRaces("rev", [{ ...a, happensBefore: ["b"] }, b]).length, 0);
});

test("DP07/20: bounds produce partial analysis and unknown aliases stay visible", () => {
  const a = access("a", "one", "t1", "WRITE", { accessPath: "x", aliasState: "UNKNOWN", concurrentWith: ["t2"] });
  const b = access("b", "two", "t2", "WRITE", { accessPath: "y", aliasState: "UNKNOWN", concurrentWith: ["t1"] });
  const found = detectDefects("rev", { memoryAccesses: [a, b], maxFacts: 2, maxFindings: 1 });
  assert.equal(found.findings.length, 1);
  assert.match(found.findings[0].coverageGaps.join(" "), /may alias/);
  const bounded = detectDefects("rev", { memoryAccesses: [a, b, access("c", "three", "t3", "READ")], maxFacts: 2 });
  assert.equal(bounded.truncated, true);
  assert.match(bounded.findings[0].coverageGaps.join(" "), /truncated/);
});

test("DP13: benchmark thresholds classify improvement, regression, noise and insufficient evidence", () => {
  const p = { minimumImprovement: 0.05, maximumRegression: 0.03, minimumSamples: 3 };
  assert.equal(compareBenchmark([100, 100, 100], [90, 90, 90], p).verdict, "IMPROVED");
  assert.equal(compareBenchmark([100, 100, 100], [104, 104, 104], p).verdict, "REGRESSED");
  assert.equal(compareBenchmark([100, 100, 100], [98, 98, 98], p).verdict, "NO_MATERIAL_CHANGE");
  assert.equal(compareBenchmark([100], [90], p).verdict, "INCONCLUSIVE");
});

test("C26 service pins reports to an accessible indexed revision and exposes partial metadata", async () => {
  const { svc, worker, revision } = await setup();
  const rel = svc.store.allRelationships(revision)[0];
  const a = lock("a", rel.from, "L1", "L2", { evidenceIds: [rel.evidence[0].id] });
  const b = lock("b", rel.to, "L2", "L1", { evidenceIds: [rel.evidence[0].id] });
  const result = svc.detectDefects(ctx(), { revision, lockOrders: [a, b], budget: { maxFacts: 1 } });
  assert.ok(result.ok && result.metadata.completeness === "PARTIAL");
  const fabricated = svc.detectDefects(ctx(), { revision, lockOrders: [{ ...a, entityId: "invented" }] });
  assert.ok(!fabricated.ok && fabricated.error.code === "INVALID_SCHEMA");
  const missing = svc.detectDefects(ctx(), { revision: "missing" });
  assert.ok(!missing.ok && missing.error.code === "NOT_FOUND");
  worker.close();
});
