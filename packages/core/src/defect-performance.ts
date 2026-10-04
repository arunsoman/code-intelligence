import { sccs } from "./graph.ts";

export interface TimedSpan {
  id: string; parentId: string | null; entityId: string | null; startMs: number; endMs: number;
  revision: string; buildHash: string; workloadHash: string; clock: string;
  category: "CPU" | "IO" | "LOCK" | "POOL" | "QUEUE" | "OTHER";
}
export interface SpanCosts { id: string; inclusiveMs: number; exclusiveMs: number; gaps: string[] }

/** Subtract the union of child intervals, so overlapping children are counted once. */
export function computeExclusiveCosts(input: TimedSpan[]): { spans: SpanCosts[]; gaps: string[] } {
  const gaps: string[] = [], spans = new Map<string, TimedSpan>();
  for (const s of input) {
    if (![s.startMs, s.endMs].every(Number.isFinite) || s.endMs < s.startMs) { gaps.push(`invalid duration for ${s.id}`); continue; }
    const old = spans.get(s.id);
    if (old && JSON.stringify(old) !== JSON.stringify(s)) throw new Error(`Conflicting duplicate span: ${s.id}`);
    spans.set(s.id, s);
  }
  if (sccs([...spans.keys()], [...spans.values()].filter((s) => s.parentId && spans.has(s.parentId)).map((s) => [s.parentId!, s.id])).length) throw new Error("Cyclic span ancestry");
  const costs: SpanCosts[] = [];
  for (const s of spans.values()) {
    const local: string[] = [];
    if (s.parentId && !spans.has(s.parentId)) local.push("missing parent span");
    const intervals: [number, number][] = [];
    for (const child of spans.values()) if (child.parentId === s.id) {
      if (child.clock !== s.clock || child.revision !== s.revision || child.buildHash !== s.buildHash || child.workloadHash !== s.workloadHash) { local.push("child clock or execution attribution differs"); continue; }
      if (child.startMs < s.startMs || child.endMs > s.endMs) local.push("child interval exceeds its parent; clamped for cost calculation");
      const lo = Math.max(s.startMs, child.startMs), hi = Math.min(s.endMs, child.endMs);
      if (hi > lo) intervals.push([lo, hi]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    let covered = 0, end = -Infinity;
    for (const [lo, hi] of intervals) { covered += Math.max(0, hi - Math.max(lo, end)); end = Math.max(end, hi); }
    const inclusiveMs = s.endMs - s.startMs;
    costs.push({ id: s.id, inclusiveMs, exclusiveMs: inclusiveMs - covered, gaps: [...new Set(local)] });
  }
  return { spans: costs.sort((a, b) => a.id.localeCompare(b.id)), gaps: [...new Set(gaps)] };
}

/** Caller supplies disjoint execution segments and actual dependency edges, not nested inclusive span costs. */
export function reconstructCriticalPath(segments: { id: string; durationMs: number }[], edges: [string, string][]): { path: string[]; durationMs: number; gaps: string[] } {
  const byId = new Map(segments.map((s) => [s.id, s]));
  if (byId.size !== segments.length || segments.some((s) => !Number.isFinite(s.durationMs) || s.durationMs < 0)) throw new Error("Invalid execution segments");
  const gaps: string[] = [], adj = new Map<string, string[]>(), indegree = new Map(segments.map((s) => [s.id, 0]));
  for (const [a, b] of new Map(edges.map((e) => [JSON.stringify(e), e])).values()) {
    if (!byId.has(a) || !byId.has(b)) { gaps.push("dependency endpoint is missing"); continue; }
    adj.set(a, [...(adj.get(a) ?? []), b]); indegree.set(b, indegree.get(b)! + 1);
  }
  const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id).sort();
  const cost = new Map(segments.map((s) => [s.id, s.durationMs])), previous = new Map<string, string>();
  let visited = 0;
  while (queue.length) {
    const a = queue.shift()!; visited++;
    for (const b of adj.get(a) ?? []) {
      const c = cost.get(a)! + byId.get(b)!.durationMs;
      if (c > cost.get(b)!) { cost.set(b, c); previous.set(b, a); }
      indegree.set(b, indegree.get(b)! - 1); if (indegree.get(b) === 0) queue.push(b);
    }
  }
  if (visited !== segments.length) throw new Error("Execution dependencies contain a cycle");
  const last = [...cost].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const path: string[] = [];
  for (let id: string | undefined = last?.[0]; id; id = previous.get(id)) path.unshift(id);
  return { path, durationMs: last?.[1] ?? 0, gaps: [...new Set(gaps)] };
}

export interface WaitSnapshot {
  captureId: string; revision: string; stable: boolean;
  resources: { id: string; instances: number; owners: string[] }[];
  waits: { taskId: string; resourceId: string; blocking: boolean; escapes: ("TIMEOUT" | "CANCELLATION" | "LEASE" | "EXTERNAL_PROGRESS")[] }[];
}
export function analyzeWaits(snapshot: WaitSnapshot) {
  const resources = new Map(snapshot.resources.map((r) => [r.id, r]));
  const edges: [string, string][] = [], gaps: string[] = [];
  for (const r of resources.values()) {
    if (r.instances !== 1 || r.owners.length > 1) { gaps.push("multiple-instance resource analysis is unsupported"); continue; }
    for (const owner of r.owners) edges.push([`resource:${r.id}`, `task:${owner}`]);
  }
  for (const w of snapshot.waits) {
    if (!resources.has(w.resourceId)) gaps.push("wait references an uncaptured resource");
    if (w.blocking) edges.push([`task:${w.taskId}`, `resource:${w.resourceId}`]);
  }
  if (!snapshot.stable) gaps.push("capture stability has not been established");
  const cycles = sccs([...new Set(edges.flat())], edges).map((members) => {
    const escapes = [...new Set(snapshot.waits.filter((w) => members.includes(`task:${w.taskId}`) && members.includes(`resource:${w.resourceId}`)).flatMap((w) => w.escapes))];
    return { members, escapes, assessment: gaps.length || escapes.length ? "POTENTIAL_WAIT_CYCLE" : "STABLE_BLOCKING_CYCLE" };
  });
  return { captureId: snapshot.captureId, revision: snapshot.revision, cycles, gaps: [...new Set(gaps)] };
}
