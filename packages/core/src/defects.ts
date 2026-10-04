import { createHash } from "node:crypto";
import type { BenchmarkPolicy, BenchmarkResult, DetectorFinding, LockOrderFact, MemoryAccessFact } from "@cie/schema";
import { sccs } from "./graph.ts";
import { DefectDetectionInputSchema } from "@cie/schema";
import { comparePairedBenchmarks, type BenchmarkTrial } from "./defect-benchmark.ts";

const stableId = (rule: string, revision: string, ids: string[]) => `finding:${createHash("sha256").update(JSON.stringify([rule, revision, [...ids].sort()])).digest("hex").slice(0, 24)}`;
const uniq = <T>(xs: T[]) => [...new Set(xs)];

export function detectLockOrderCycles(revision: string, facts: LockOrderFact[]): DetectorFinding[] {
  const usable = [...facts].filter((f) => f.acquireKind !== "REENTRANT").sort((a, b) => a.id.localeCompare(b.id));
  const nodes = uniq(usable.flatMap((f) => [f.heldLockId, f.acquiredLockId]));
  return sccs(nodes, usable.map((f) => [f.heldLockId, f.acquiredLockId])).map((locks) => {
    const inCycle = usable.filter((f) => locks.includes(f.heldLockId) && locks.includes(f.acquiredLockId));
    const gaps: string[] = ["path compatibility and simultaneous concurrent entry have not been demonstrated"];
    if (inCycle.some((f) => f.resolution !== "RESOLVED")) gaps.push("one or more lock identities or paths are not fully resolved");
    if (inCycle.some((f) => f.acquireKind === "TRY")) gaps.push("try-lock recovery may prevent blocking");
    if (new Set(inCycle.map((f) => f.globalGuardId).filter(Boolean)).size === 1 && inCycle.every((f) => f.globalGuardId)) gaps.push("a shared global guard may serialize the paths");
    if (new Set(inCycle.map((f) => f.entityId)).size < 2) gaps.push("concurrent entry-point feasibility is unresolved");
    const ids = inCycle.map((f) => f.id);
    return {
      id: stableId("lock-order-cycle", revision, ids), version: 1, kind: "DEADLOCK_CANDIDATE", revision,
      entityIds: uniq(inCycle.map((f) => f.entityId)).sort(), spans: inCycle.flatMap((f) => f.span ? [f.span] : []),
      ruleId: "defect.lock-order-cycle", ruleVersion: 1, evidenceIds: uniq(inCycle.flatMap((f) => f.evidenceIds)).sort(),
      coverageGaps: gaps, severity: gaps.length ? "MEDIUM" : "HIGH", evidenceLevel: "STATIC_CANDIDATE",
      safetyObligations: [{ id: stableId("lock-invariant", revision, ids), description: "Preserve every invariant protected by the locks when changing acquisition order or scope.", predicateSchemaId: "defect.lock-protected-invariant.v1", state: "PENDING", evidenceIds: [] }],
      witness: { kind: "LOCK_ORDER_CYCLE", paths: inCycle.map((f) => [f.entityId, f.heldLockId, f.acquiredLockId]), detail: "Potential lock-order inversion; runtime blocking has not been observed." },
    } satisfies DetectorFinding;
  });
}

export function detectMemoryRaces(revision: string, facts: MemoryAccessFact[], bounds: { maxFindings?: number; onTruncated?: () => void } = {}): DetectorFinding[] {
  const out: DetectorFinding[] = [];
  const sorted = [...facts].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(sorted.map((f) => [f.id, f]));
  const closure = new Map<string, Set<string>>();
  const reachable = (from: MemoryAccessFact, to: string) => {
    if (closure.has(from.id)) return closure.get(from.id)!.has(to);
    const seen = new Set<string>(), pending = [...from.happensBefore];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id); pending.push(...(byId.get(id)?.happensBefore ?? []));
    }
    closure.set(from.id, seen);
    return seen.has(to);
  };
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    const a = sorted[i], b = sorted[j];
    if ((a.atomic && b.atomic) || (a.mode === "READ" && b.mode === "READ")) continue;
    const aliases = a.accessPath === b.accessPath || a.aliasState !== "RESOLVED" || b.aliasState !== "RESOLVED";
    const concurrent = a.concurrentWith.includes(b.contextId) || b.concurrentWith.includes(a.contextId);
    const ordered = reachable(a, b.id) || reachable(b, a.id);
    if (!aliases || !concurrent || ordered) continue;
    if (out.length >= (bounds.maxFindings ?? 1000)) { bounds.onTruncated?.(); return out; }
    const ids = [a.id, b.id]; const gaps: string[] = [];
    if (a.accessPath !== b.accessPath) gaps.push("accesses may alias but identity is unresolved");
    out.push({
      id: stableId("memory-race", revision, ids), version: 1, kind: "MEMORY_RACE", revision,
      entityIds: uniq([a.entityId, b.entityId]).sort(), spans: [a.span, b.span].filter((x): x is NonNullable<typeof x> => !!x),
      ruleId: "defect.unsynchronized-conflicting-access", ruleVersion: 1, evidenceIds: uniq([...a.evidenceIds, ...b.evidenceIds]).sort(),
      coverageGaps: [...gaps, "static happens-before and concurrency models may be incomplete"], severity: "HIGH", evidenceLevel: "STATIC_CANDIDATE",
      safetyObligations: [{ id: stableId("race-invariant", revision, ids), description: "Preserve the intended state invariant and verify it independently under the conflicting schedule.", predicateSchemaId: "defect.concurrent-state-invariant.v1", state: "PENDING", evidenceIds: [] }],
      witness: { kind: "CONFLICTING_ACCESSES", paths: [[a.entityId, a.id], [b.entityId, b.id]], detail: `${a.mode}/${b.mode} on ${a.accessPath === b.accessPath ? a.accessPath : "possibly aliased paths"} without recognized ordering.` },
    });
  }
  return out;
}

export function detectDefects(revision: string, input: { lockOrders?: LockOrderFact[]; memoryAccesses?: MemoryAccessFact[]; maxFacts?: number; maxFindings?: number }): { findings: DetectorFinding[]; truncated: boolean } {
  DefectDetectionInputSchema.parse({ revision, lockOrders: input.lockOrders, memoryAccesses: input.memoryAccesses, budget: { maxFacts: input.maxFacts, maxFindings: input.maxFindings } });
  const maxFacts = Math.max(1, Math.min(input.maxFacts ?? 10_000, 100_000));
  const maxFindings = Math.max(1, Math.min(input.maxFindings ?? 1_000, 10_000));
  const all = [...(input.lockOrders ?? []), ...(input.memoryAccesses ?? [])];
  const truncatedFacts = all.length > maxFacts;
  let remaining = maxFacts;
  const locks = (input.lockOrders ?? []).slice(0, remaining); remaining -= locks.length;
  const accesses = (input.memoryAccesses ?? []).slice(0, remaining);
  let truncatedPairs = false;
  const findings = [...detectLockOrderCycles(revision, locks), ...detectMemoryRaces(revision, accesses, { maxFindings, onTruncated: () => { truncatedPairs = true; } })].sort((a, b) => a.id.localeCompare(b.id));
  if (truncatedFacts) for (const f of findings) f.coverageGaps.push(`input truncated at ${maxFacts} facts`);
  return { findings: findings.slice(0, maxFindings), truncated: truncatedFacts || truncatedPairs || findings.length > maxFindings };
}

export function compareBenchmark(baseline: number[], candidate: number[], policy: BenchmarkPolicy): BenchmarkResult {
  if (!baseline.length || !candidate.length) return { effectEstimate: null, verdict: "INCONCLUSIVE", limitations: ["insufficient samples"] };
  const trials = (xs: number[], side: string): BenchmarkTrial[] => xs.map((value, i) => ({ runId: `${side}:${i}`, pairId: String(i), workloadHash: "unspecified", environmentHash: "unspecified", oracleHash: "unspecified", buildSettingsHash: "unspecified", instrumented: false, correctnessPassed: true, metrics: { value } }));
  const comparison = comparePairedBenchmarks(trials(baseline, "baseline"), trials(candidate, "candidate"), { id: "legacy-paired", primaryMetric: "value", direction: "LOWER", minimumPairs: Math.max(3, policy.minimumSamples), minimumImprovement: policy.minimumImprovement, confidenceLevel: 0.95, regressionLimits: { value: { direction: "LOWER", maximumRelativeRegression: policy.maximumRegression } } });
  return { effectEstimate: comparison.uncertaintyInterval ? comparison.effectEstimate : null, verdict: comparison.verdict, limitations: [...comparison.limitations, "Raw-number compatibility API assumes paired positions; source, environment, correctness and secondary metrics are not verified."] };
}
