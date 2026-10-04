// C24 phase-0 algorithm evidence (C24_Runtime_Causality_Detailed_Design.md §6/§13). Not yet wired to an engine: these are
// the load-bearing semantics the RC tests hang on, written as pure functions with property tests, an independent
// brute-force oracle (c24-phase0-algorithms.test.ts), and demonstrated mutation detection.
//   reconcileProposedOrdering — RC11: contradictory ordering proposals are quarantined deterministically; ingest order never
//     decides which source is "truth"; all competing provenance is retained.
//   orderRelation            — RC03/RC04: happens-before only along accepted EXECUTION_ORDER edges; smaller Lamport stamps
//     and earlier wall clocks imply nothing; CONCURRENT_CERTIFIED only with a provided valid certificate; otherwise UNKNOWN.
import type { EdgeKind } from "@cie/schema";

/** Edge kinds that carry execution-order semantics (design §6 table, "Gate" column). CONTEXT_ASSOCIATION is explicitly
 *  kept outside the strict ordering closure; WAITS_FOR/CORRELATES_WITH/CAUSE_CANDIDATE/INTERVENTION_SUPPORTS are not
 *  time-order edges at all. */
export const ORDERING_KINDS: ReadonlySet<EdgeKind> = new Set(["PROGRAM_ORDER", "SPAWN", "SEND_RECEIVE", "COMPLETE_JOIN", "READS_FROM", "REQUEST_RESPONSE"]);

export interface ProposedEdge { id: string; fromEventId: string; toEventId: string; kind: EdgeKind; evidenceIds: string[]; ruleId: string }
export interface ReconciledEdge extends ProposedEdge { state: "ACCEPTED" | "QUARANTINED"; conflictId?: string; conflictReport?: string[] }
export interface Reconciliation { accepted: ReconciledEdge[]; quarantined: ReconciledEdge[]; conflicts: string[]; /** True when every quarantined edge carries a conflictId naming its retained component. */ allQuarantinesAttributed: boolean }

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Deterministically reconcile a SET of proposed ordering edges (design §13: the simplified loop "expresses validation,
 * not a first-edge-wins policy"; the cycle decision "must not arbitrarily decide which contradictory source is truth").
 * Every SCC of size > 1 among ordering-kind proposals is quarantined whole, with a conflict report that retains every
 * competing edge's provenance. The remaining DAG is accepted. Because Tarjan runs from canonically sorted node order and
 * no step consults input position, the output is permutation-invariant.
 */
export function reconcileProposedOrdering(proposals: ProposedEdge[]): Reconciliation {
  const edges = [...proposals].sort(byId);
  const accepted: ReconciledEdge[] = [];
  const quarantined: ReconciledEdge[] = [];
  const conflicts: string[] = [];
  const nodes = [...new Set(edges.flatMap((e) => [e.fromEventId, e.toEventId]))].sort();
  const adj = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const e of edges) if (e.fromEventId !== e.toEventId) { adj.get(e.fromEventId)!.push(e.toEventId); adj.get(e.fromEventId)!.sort(); }
  // Iterative Tarjan SCC, in canonical node order.
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>();
  const stack: string[] = []; const sccs: string[][] = []; let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) { continue; }
    const work: { node: string; child: number }[] = [{ node: root, child: 0 }];
    index.set(root, counter); low.set(root, counter); counter++; stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const succ = adj.get(frame.node)!;
      if (frame.child < succ.length) {
        const next = succ[frame.child++];
        if (!index.has(next)) {
          index.set(next, counter); low.set(next, counter); counter++; stack.push(next); onStack.add(next);
          work.push({ node: next, child: 0 });
        } else if (onStack.has(next)) { low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!)); }
      } else {
        work.pop();
        if (work.length) { const parent = work[work.length - 1].node; low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!)); }
        if (low.get(frame.node) === index.get(frame.node)) {
          const comp: string[] = [];
          for (;;) { const n = stack.pop()!; onStack.delete(n); comp.push(n); if (n === frame.node) break; }
          comp.sort(); sccs.push(comp);
        }
      }
    }
  }
  // Every non-trivial SCC is one quarantined component; provenance for all its edges is retained (design §6: contradictory
  // ordering edges are "quarantined with provenance, never silently dropped").
  const cyclic = new Set<string>();
  for (const comp of sccs) if (comp.length > 1) for (const n of comp) cyclic.add(n);
  for (const scc of sccs) {
    if (scc.length <= 1) continue;
    const conflictId = "conflict:" + scc.join("+");
    conflicts.push(conflictId);
    for (const e of edges) {
      if (!cyclic.has(e.fromEventId) || !cyclic.has(e.toEventId)) continue;
      quarantined.push({ ...e, state: "QUARANTINED", conflictId, conflictReport: [`competing ordering retained alongside ${scc.length - 1} other proposal(s) in ${conflictId}; quarantined whole, no first-edge-wins`] });
    }
  }
  for (const e of edges) {
    if (cyclic.has(e.fromEventId) && cyclic.has(e.toEventId)) continue;
    accepted.push({ ...e, state: "ACCEPTED" });
  }
  return { accepted, quarantined: quarantined.sort(byId), conflicts: conflicts.sort(), allQuarantinesAttributed: quarantined.every((q) => !!q.conflictId && q.conflictReport!.length > 0) };
}

export interface OrderingCertificate { id: string; domain: string; epoch: string; /** The events the certificate's completeness claim applies to. */ coversEventIds: string[]; valid: boolean }
export type OrderRelationResult = { relation: "HAPPENS_BEFORE" | "HAPPENS_AFTER" | "CONCURRENT_CERTIFIED" | "UNKNOWN"; hitBound: boolean; limitations: string[] };

/** Reachability along accepted EXECUTION_ORDER edges only, with a hop bound (design §6: "transitive reachability yields
 *  known order only through accepted ordering edges"; "No path in an incomplete graph means UNKNOWN, not necessarily
 *  CONCURRENT"; concurrency needs a backend completeness certificate). A hit hop bound yields UNKNOWN, never an inference. */
export function orderRelation(edges: { fromEventId: string; toEventId: string }[], from: string, to: string, certificate: OrderingCertificate | null, maxHops = 64): OrderRelationResult {
  if (from === to) return { relation: "UNKNOWN", hitBound: false, limitations: ["one event is not two endpoints; order of an event with itself carries no information"] };
  const reaches = (start: string, target: string): boolean => {
    let frontier = [start];
    const seen = new Set([start]);
    for (let hops = 0; hops < maxHops && frontier.length; hops++) {
      const next: string[] = [];
      for (const n of frontier) for (const e of edges) {
        if (e.fromEventId !== n || seen.has(e.toEventId)) continue;
        if (e.toEventId === target) return true;
        seen.add(e.toEventId); next.push(e.toEventId);
      }
      frontier = next;
    }
    return false;
  };
  if (reaches(from, to)) return { relation: "HAPPENS_BEFORE", hitBound: false, limitations: [] };
  if (reaches(to, from)) return { relation: "HAPPENS_AFTER", hitBound: false, limitations: [] };
  // No known path either way: concurrency only with a valid certificate covering both endpoints; otherwise UNKNOWN.
  if (certificate?.valid && certificate.coversEventIds.includes(from) && certificate.coversEventIds.includes(to)) return { relation: "CONCURRENT_CERTIFIED", hitBound: false, limitations: [] };
  return { relation: "UNKNOWN", hitBound: false, limitations: ["no valid completeness certificate applies, so incomparability stays UNKNOWN"] };
}