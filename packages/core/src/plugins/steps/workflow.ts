import type { WorkflowStep } from "@cie/schema";
export function orderSteps<C>(steps: readonly WorkflowStep<C>[]): WorkflowStep<C>[] {
  const map = new Map<string, WorkflowStep<C>>();
  for (const s of steps) { if (map.has(s.id)) throw new Error(`Duplicate workflow step: ${s.id}`); map.set(s.id, s); }
  const edges = new Map(steps.map(s => [s.id, new Set<string>()]));
  const link = (a: string, b: string) => {
    if (!map.has(a) || !map.has(b)) throw new Error(`Unknown workflow dependency: ${a} -> ${b}`);
    edges.get(a)!.add(b);
  };
  for (const s of steps) { for (const a of s.after ?? []) link(a, s.id); for (const b of s.before ?? []) link(s.id, b); }
  const remaining = new Set(map.keys()), result: WorkflowStep<C>[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(id => ![...remaining].some(other => edges.get(other)!.has(id))).sort();
    if (!ready.length) throw new Error(`Workflow cycle among: ${[...remaining].sort().join(" -> ")}`);
    for (const id of ready) { remaining.delete(id); result.push(map.get(id)!); }
  }
  return result;
}
export function runWorkflow<C>(steps: readonly WorkflowStep<C>[], ctx: C): C {
  for (const step of orderSteps(steps)) if (!step.appliesTo || step.appliesTo(ctx)) step.run(ctx);
  return ctx;
}
