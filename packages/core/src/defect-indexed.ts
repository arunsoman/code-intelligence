import type { DetectorFinding, Fact, SourceSpan } from "@cie/schema";
import type { Store } from "./store.ts";
import { policyFor } from "./access.ts";
import { artifactHash } from "./defect-schedule.ts";
import { detectLockOrder } from "./defect/lockorder.ts";
import { detectPerformance } from "./defect/perf.ts";
import { detectLifecycle } from "./defect/lifecycle.ts";

const location = (f: Fact): SourceSpan | undefined => f.evidence.find((e) => e.location.kind === "CodeLocation")?.location.span as SourceSpan | undefined;
const offset = (f: Fact) => location(f)?.startByte ?? -1;
const field = (f: Fact) => `${f.object.qualifier ?? "?"}.${f.object.value}`;
function finding(revision: string, kind: DetectorFinding["kind"], rule: string, facts: Fact[], detail: string, gaps: string[], obligations: string[]): DetectorFinding {
  const id = `finding:${artifactHash([revision, rule, facts.map((f) => f.id).sort()])}`;
  return { id, version: 1, revision, kind, ruleId: rule, ruleVersion: 1, severity: "MEDIUM", evidenceLevel: "STATIC_CANDIDATE",
    entityIds: [...new Set(facts.map((f) => f.subject))].sort(), spans: facts.flatMap((f) => location(f) ? [location(f)!] : []),
    evidenceIds: [...new Set(facts.flatMap((f) => f.evidence.map((e) => e.id)))].sort(), coverageGaps: gaps,
    safetyObligations: obligations.map((description, i) => ({ id: `${id}:obligation:${i}`, description, predicateSchemaId: "defect.reviewed-property.v1", state: "PENDING", evidenceIds: [] })),
    witness: { kind, paths: facts.map((f) => [f.subject, f.id]), detail },
  };
}

/** Operates on revision-bound parser output. Lexical rules retain unknown control flow, aliases and effects. */
export function detectIndexedDefects(store: Store, revision: string, options: { maxFacts?: number; maxFindings?: number; entityIds?: string[] } = {}) {
  const rev = store.revision(revision);
  if (!rev) throw new Error("Revision is unavailable");
  const access = policyFor(store, rev.repoRoot), entities = new Map(store.entities(revision).map((e) => [e.entityId, e]));
  const all = store.allFacts(revision).filter((f) => !access.deniedEntity(f.subject, (id) => entities.get(id)?.file) && (!options.entityIds?.length || options.entityIds.includes(f.subject)) && f.evidence.every((e) => e.state === "CURRENT" && !access.deniedEntity(e.sourceId, (id) => entities.get(id)?.file))).sort((a, b) => a.id.localeCompare(b.id));
  const facts = all.slice(0, options.maxFacts ?? 10000), results: DetectorFinding[] = [];
  const bySubject = new Map<string, Fact[]>();
  for (const f of facts) bySubject.set(f.subject, [...(bySubject.get(f.subject) ?? []), f]);
  for (const [entityId, list] of bySubject) {
    const events = list.filter((f) => f.predicate === "defect.semantic-event.v1");
    const awaits = events.filter((f) => (f.object.value as { kind?: string })?.kind === "AWAIT");
    const reads = list.filter((f) => f.predicate === "reads"), writes = list.filter((f) => f.predicate === "writes");
    for (const r of reads) for (const w of writes) {
      if (field(r) !== field(w) || offset(r) >= offset(w)) continue;
      const boundary = awaits.find((a) => offset(a) > offset(r) && offset(a) < offset(w));
      if (!boundary) continue;
      results.push(finding(revision, "LOGICAL_RACE", "defect.await-read-write", [r, boundary, w], `Potential stale ${field(r)} decision across an await boundary.`,
        ["Lexical ordering only; branch feasibility, alias identity and concurrent invocation require investigation.", "Database isolation and surrounding synchronization have not been established."],
        ["State the intended business invariant independently of the proposed patch.", "Preserve atomicity, cancellation behavior and stale-version rejection."]));
    }
    for (const call of events.filter((f) => (f.object.value as { kind?: string })?.kind === "CALL")) {
      const value = call.object.value as { enclosingLoops?: number[]; callee?: string };
      if (!value.enclosingLoops?.length) continue;
      results.push(finding(revision, "REPEATED_EXTERNAL_CALL", "defect.call-in-loop", [call], `Repeated call candidate: ${value.callee ?? "unresolved call"} inside a lexical loop.`,
        ["Callee effects and loop cardinality are unresolved; this call may be local, pure or inexpensive.", "No workload timing establishes a bottleneck."],
        ["Establish call effects and measured frequency before batching or caching.", "Preserve ordering, error behavior, query equivalence and bounded memory use."]));
    }
  }
  // Lock order: held sets, releases, RAII scopes, try-locks, timeouts, reentrancy and gate locks are understood by the source scanner
  // (defect/source.ts); the earlier consecutive-lexical pairing treated "released before the next one" as nested and invented cycles.
  for (const f of detectLockOrder(store, rev, { entityIds: options.entityIds })) results.push(f);
  // Contention, N+1, loop conditions, serial awaits, and resources opened without a close.
  for (const f of detectPerformance(store, rev, { entityIds: options.entityIds })) results.push(f);
  for (const f of detectLifecycle(store, rev, { entityIds: options.entityIds })) results.push(f);
  const gaps = ["Parsed lexical semantic events do not provide complete CFG, interprocedural effects, alias resolution or concurrency reachability."];
  if (!facts.some((f) => f.predicate === "defect.semantic-event.v1")) gaps.push("No defect semantic events were indexed; reindex using a worker with defect.semantic-event.v1 support.");
  const limit = options.maxFindings ?? 1000;
  return { findings: results.sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit), truncated: all.length > facts.length || results.length > limit, coverageGaps: gaps };
}
