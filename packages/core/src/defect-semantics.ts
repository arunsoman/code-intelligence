export interface ControlFlowGraph { entry: string; blocks: string[]; edges: { from: string; to: string; condition?: string }[] }
export interface EffectSummary {
  reads: string[]; writes: string[]; mayBlock: boolean; mayThrow: boolean; io: boolean;
  purity: "PURE" | "IMPURE" | "UNKNOWN"; unresolvedCallees: string[];
}
export function computeDominators(graph: ControlFlowGraph): Map<string, Set<string>> {
  const blocks = new Set(graph.blocks);
  if (!blocks.has(graph.entry) || blocks.size !== graph.blocks.length || graph.blocks.length > 2000) throw new Error("Invalid or oversized CFG");
  const predecessors = new Map(graph.blocks.map((b) => [b, [] as string[]]));
  const successors = new Map(graph.blocks.map((b) => [b, [] as string[]]));
  for (const e of graph.edges) {
    if (!blocks.has(e.from) || !blocks.has(e.to)) throw new Error("CFG edge references a missing block");
    predecessors.get(e.to)!.push(e.from); successors.get(e.from)!.push(e.to);
  }
  const reachable = new Set<string>(), todo = [graph.entry];
  while (todo.length) { const b = todo.pop()!; if (reachable.has(b)) continue; reachable.add(b); todo.push(...successors.get(b)!); }
  const dom = new Map([...reachable].map((b) => [b, new Set(b === graph.entry ? [b] : reachable)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of reachable) {
      if (b === graph.entry) continue;
      const incoming = predecessors.get(b)!.filter((p) => reachable.has(p));
      const next = new Set([...dom.get(incoming[0])!].filter((x) => incoming.every((p) => dom.get(p)!.has(x))));
      next.add(b);
      const previous = dom.get(b)!;
      if (next.size !== previous.size || [...next].some((v) => !previous.has(v))) { dom.set(b, next); changed = true; }
    }
  }
  return dom;
}
export function identifyNaturalLoops(graph: ControlFlowGraph) {
  const dominators = computeDominators(graph), predecessors = new Map(graph.blocks.map((b) => [b, [] as string[]]));
  for (const e of graph.edges) predecessors.get(e.to)!.push(e.from);
  return graph.edges.filter((e) => dominators.get(e.from)?.has(e.to)).map((edge) => {
    const body = new Set([edge.to, edge.from]), pending = edge.from === edge.to ? [] : [edge.from];
    while (pending.length) for (const p of predecessors.get(pending.pop()!)!) if (!body.has(p) && dominators.has(p)) { body.add(p); pending.push(p); }
    return { header: edge.to, backedge: edge, blocks: [...body].sort(), exits: graph.edges.filter((e) => body.has(e.from) && !body.has(e.to)) };
  });
}
export function summarizeCallEffects(local: Map<string, EffectSummary>, calls: { caller: string; callee: string | null }[]): Map<string, EffectSummary> {
  const result = new Map([...local].map(([id, s]) => [id, structuredClone(s)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const call of calls) {
      const caller = result.get(call.caller); if (!caller) throw new Error("Call graph caller lacks an effect summary");
      const callee = call.callee ? result.get(call.callee) : null;
      const previous = JSON.stringify(caller);
      if (!callee) {
        caller.purity = "UNKNOWN"; caller.mayBlock = true; caller.mayThrow = true;
        caller.unresolvedCallees = [...new Set([...caller.unresolvedCallees, call.callee ?? "dynamic-dispatch"])].sort();
      } else {
        caller.reads = [...new Set([...caller.reads, ...callee.reads])].sort();
        caller.writes = [...new Set([...caller.writes, ...callee.writes])].sort();
        caller.unresolvedCallees = [...new Set([...caller.unresolvedCallees, ...callee.unresolvedCallees])].sort();
        caller.mayBlock ||= callee.mayBlock; caller.mayThrow ||= callee.mayThrow; caller.io ||= callee.io;
        if (caller.purity !== "UNKNOWN") caller.purity = callee.purity === "UNKNOWN" ? "UNKNOWN" : caller.purity === "IMPURE" || callee.purity === "IMPURE" ? "IMPURE" : "PURE";
      }
      if (JSON.stringify(caller) !== previous) changed = true;
    }
  }
  return result;
}
export interface LoopTransformationFacts {
  reads: { path: string; getter: boolean; volatile: boolean; concurrentMutation: boolean; aliasResolved: boolean }[];
  writes: string[]; effects: EffectSummary; mayBeEmpty: boolean; evaluationMovesBeforeLoop: boolean; benchmarkAvailable: boolean;
}
export function assessLoopTransformation(facts: LoopTransformationFacts): { safeCandidate: boolean; obligations: string[]; reasons: string[] } {
  const reasons: string[] = [];
  if (facts.effects.purity !== "PURE" || facts.effects.unresolvedCallees.length) reasons.push("purity or call effects are unresolved");
  if (facts.effects.io || facts.effects.mayBlock || facts.effects.writes.length) reasons.push("evaluation has externally visible or blocking effects");
  if (facts.effects.mayThrow && facts.evaluationMovesBeforeLoop) reasons.push("exception timing would change");
  for (const read of facts.reads) {
    if (!read.aliasResolved) reasons.push("alias identity is unresolved");
    if (read.getter || read.volatile || read.concurrentMutation) reasons.push("per-iteration read semantics may change");
    if (facts.writes.includes(read.path)) reasons.push("condition or computation depends on loop-mutated state");
  }
  if (facts.mayBeEmpty && facts.evaluationMovesBeforeLoop) reasons.push("empty-loop evaluation requires a guard or independent proof of equivalence");
  return { safeCandidate: reasons.length === 0, reasons: [...new Set(reasons)], obligations: ["Preserve output, error timing, ordering and per-iteration evaluation semantics.", ...(facts.benchmarkAvailable ? [] : ["Benchmark the actual build; no improvement has been measured."])] };
}
