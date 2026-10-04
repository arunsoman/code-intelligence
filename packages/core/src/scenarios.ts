// C27 counterfactual scenarios: "what would follow if ...", as typed, checkable scenarios rather than prose.
//   - a scenario is a list of operations (remove code, make a call asynchronous, scale a path's load) plus the assumptions it rests on
//   - every consequence says how it is known: STRUCTURAL (from the graph), MEASURED (from a recorded benchmark), INFERRED (reasoned)
//   - a consequence that depends on an assumption nobody has checked is conditional, and says so
//   - two results are compared only at the same level of abstraction and the same baseline
//   - capacity beyond what was measured is extrapolation, labelled as such, never a measurement
import { createHash } from "node:crypto";
import { buildCounterfactual, resolveRemoval } from "./forms/counterfactual.ts";
import { flowGraph, short } from "./forms/common.ts";
import type { RevisionRow, Store } from "./store.ts";

export type Level = "SYMBOL" | "FILE" | "CONCEPT";
export type ScenarioOp = { type: "REMOVE"; target: string } | { type: "MAKE_ASYNC"; callee: string } | { type: "SCALE"; path: string; factor: number };
export interface Assumption { id: string; statement: string }
export interface Scenario { id: string; name: string; level: Level; ops: ScenarioOp[]; assumptions: Assumption[] }
export type AssumptionState = "UNCHECKED" | "SUPPORTED" | "CONTRADICTED";
export interface AssumptionInput { id: string; state: AssumptionState; evidenceIds: string[] }
export interface CapacityPoint { concurrency: number; throughputPerSec: number; p95Ms: number; errorRate: number; runId: string }
export interface CapacityData { workloadHash: string; revision: string; points: CapacityPoint[] }

export type Basis = "STRUCTURAL" | "MEASURED" | "INTERPOLATED" | "EXTRAPOLATED" | "INFERRED";
export interface Consequence { id: string; text: string; basis: Basis; assumptionIds: string[]; conditional: boolean; evidenceIds: string[]; entityIds: string[] }
export interface ScenarioResult {
  scenarioHash: string; baselineRevision: string; level: Level;
  comparison: { unit: string; baseline: string; scenario: string; change: "removed" | "changed" | "unchanged" }[];
  consequences: Consequence[];
  assumptions: { id: string; statement: string; state: AssumptionState; evidenceIds: string[] }[];
  limits: string[];
}
export class ScenarioError extends Error { readonly problems: string[]; constructor(problems: string[]) { super(`invalid scenario: ${problems.join("; ")}`); this.problems = problems; } }

const h = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);

/** Reject a scenario that cannot mean anything: no operations, unknown things, contradictions, nonsense numbers. */
export function validateScenario(store: Store, rev: RevisionRow, s: Scenario): void {
  const problems: string[] = [];
  if (!s || typeof s.name !== "string" || !s.name.trim()) problems.push("a scenario needs a name");
  if (!["SYMBOL", "FILE", "CONCEPT"].includes(s?.level)) problems.push(`level must be SYMBOL, FILE or CONCEPT, not "${String(s?.level)}"`);
  if (!Array.isArray(s?.ops) || s.ops.length === 0) problems.push("a scenario needs at least one operation");
  if ((s?.ops?.length ?? 0) > 20) problems.push("a scenario is limited to 20 operations");
  const ids = new Set(store.entities(rev.id).map((e) => e.entityId));
  const removed = new Set<string>(), scaled = new Set<string>(), asynced = new Set<string>();
  for (const op of s?.ops ?? []) {
    if (op.type === "REMOVE") { const t = resolveRemoval(store, rev.id, "", op.target); if (!t) problems.push(`REMOVE: "${op.target}" is not code in this revision`); else t.ids.forEach((i) => removed.add(i)); }
    else if (op.type === "MAKE_ASYNC") { if (!ids.has(op.callee)) problems.push(`MAKE_ASYNC: "${op.callee}" is not an entity of this revision`); else asynced.add(op.callee); }
    else if (op.type === "SCALE") {
      if (!ids.has(op.path)) problems.push(`SCALE: "${op.path}" is not an entity of this revision`);
      if (!Number.isFinite(op.factor) || op.factor <= 0 || op.factor > 1000) problems.push("SCALE: the factor must be a positive number up to 1000");
      scaled.add(op.path);
    } else problems.push(`unknown operation "${String((op as { type?: unknown }).type)}"`);
  }
  for (const r of removed) { if (scaled.has(r)) problems.push(`${short(r)} is both removed and scaled`); if (asynced.has(r)) problems.push(`${short(r)} is both removed and made asynchronous`); }
  const aid = new Set<string>();
  for (const a of s?.assumptions ?? []) { if (!a?.id || !a.statement?.trim()) problems.push("every assumption needs an id and a statement"); else if (aid.has(a.id)) problems.push(`assumption id "${a.id}" is used twice`); else aid.add(a.id); }
  if (problems.length) throw new ScenarioError(problems);
}

const ASSUME_NO_RESULT = { id: "a:callers-ignore-result", statement: "The callers do not use the return value, or the error, of the call that becomes asynchronous." };
const ASSUME_IDEMPOTENT = { id: "a:callee-retry-safe", statement: "The call that becomes asynchronous can be retried or delivered twice without harm." };
const ASSUME_STEADY = { id: "a:load-is-like-the-measurement", statement: "The load on the scaled path behaves like the load in the recorded measurement (same mix, same dependencies)." };

/** Evaluate a scenario against a revision. Pure: no clock, no writes. */
export function evaluateScenario(store: Store, rev: RevisionRow, s: Scenario, opts: { assumptions?: AssumptionInput[]; capacity?: CapacityData | null } = {}): ScenarioResult {
  validateScenario(store, rev, s);
  const given = new Map((opts.assumptions ?? []).map((a) => [a.id, a]));
  for (const a of opts.assumptions ?? []) if (a.state === "SUPPORTED" && !(a.evidenceIds.length && a.evidenceIds.every((e) => store.evidence(rev.id, e)))) throw new ScenarioError([`assumption "${a.id}" cannot be marked supported without evidence that exists in this revision`]);
  const ents = new Map(store.entities(rev.id).map((e) => [e.entityId, e]));
  const flow = flowGraph(store, rev.id);
  const declared = new Map<string, string>((s.assumptions ?? []).map((a) => [a.id, a.statement]));
  const consequences: Consequence[] = []; const limits: string[] = [];
  const comparison = new Map<string, { baseline: string; scenario: string; change: "removed" | "changed" | "unchanged" }>();
  const unitOf = (entityId: string) => { const e = ents.get(entityId)!; if (s.level === "FILE") return e.file; if (s.level === "CONCEPT") return store.concepts(rev.id).find((c) => c.members.includes(entityId))?.title ?? `(no concept) ${e.file}`; return e.name; };
  const mark = (id: string, change: "removed" | "changed", scenario: string) => { const u = unitOf(id); const cur = comparison.get(u); if (!cur || (cur.change === "changed" && change === "removed")) comparison.set(u, { baseline: "present", scenario, change }); };
  const use = (a: { id: string; statement: string }) => { if (!declared.has(a.id)) declared.set(a.id, a.statement); return a.id; };

  s.ops.forEach((op, i) => {
    if (op.type === "REMOVE") {
      const t = resolveRemoval(store, rev.id, "", op.target)!;
      const built = buildCounterfactual(store, rev, `what if we remove ${op.target}`, op.target);
      t.ids.forEach((id) => mark(id, "removed", "removed"));
      for (const c of built.view.consequences ?? []) {
        (c.entityIds ?? []).forEach((id) => { if (ents.has(id) && !t.ids.includes(id)) mark(id, "changed", c.kind); });
        consequences.push({ id: `c:${i}:${c.id}`, text: c.text, basis: "STRUCTURAL", assumptionIds: [], conditional: false, evidenceIds: c.evidenceIds, entityIds: c.entityIds ?? [] });
      }
      if (!(built.view.consequences ?? []).length) consequences.push({ id: `c:${i}:none`, text: `No consequence of removing ${t.label} was found in the call graph. That is not a finding that nothing depends on it: dynamic calls, configuration and external callers are not visible.`, basis: "STRUCTURAL", assumptionIds: [], conditional: false, evidenceIds: [], entityIds: t.ids });
    } else if (op.type === "MAKE_ASYNC") {
      const callee = ents.get(op.callee)!;
      const callers = (flow.inn.get(op.callee) ?? []).filter((r) => r.kind === "calls");
      const a1 = use(ASSUME_NO_RESULT), a2 = use(ASSUME_IDEMPOTENT);
      mark(op.callee, "changed", "asynchronous");
      if (!callers.length) consequences.push({ id: `c:${i}:nocallers`, text: `${callee.name} has no resolved callers, so making it asynchronous changes nothing the graph can see.`, basis: "STRUCTURAL", assumptionIds: [], conditional: false, evidenceIds: [], entityIds: [op.callee] });
      for (const r of callers) {
        const caller = ents.get(r.from)!; mark(r.from, "changed", "continues without waiting");
        const tx = store.factsFor(rev.id, r.from).some((f) => f.predicate === "uses_transaction");
        consequences.push({ id: `c:${i}:${r.id}`, text: `${caller.name} would continue without waiting for ${callee.name}: it would no longer see its result or its error at that point, and anything after the call could run before the call's effects.`, basis: "STRUCTURAL", assumptionIds: [a1], conditional: true, evidenceIds: r.evidence.map((e) => e.id).slice(0, 4), entityIds: [r.from, op.callee] });
        if (tx) consequences.push({ id: `c:${i}:${r.id}:tx`, text: `${caller.name} runs inside a transaction: ${callee.name}'s effects would happen outside it, so a rollback would not undo them.`, basis: "STRUCTURAL", assumptionIds: [a1], conditional: true, evidenceIds: r.evidence.map((e) => e.id).slice(0, 4), entityIds: [r.from, op.callee] });
      }
      consequences.push({ id: `c:${i}:retry`, text: `If delivery can repeat or be retried after the change, ${callee.name} must tolerate running twice.`, basis: "INFERRED", assumptionIds: [a2], conditional: true, evidenceIds: [], entityIds: [op.callee] });
    } else {
      const entry = ents.get(op.path)!; mark(op.path, "changed", `${op.factor}× load`);
      const cap = opts.capacity && opts.capacity.revision === rev.id ? opts.capacity : null;
      if (opts.capacity && !cap) limits.push("The capacity measurement is for another revision and was not used.");
      const a = use(ASSUME_STEADY);
      if (!cap || cap.points.length === 0) {
        consequences.push({ id: `c:${i}:nocap`, text: `${entry.name} at ${op.factor}× load: no capacity was measured for this path, so how it would behave is not known. Nothing here is a prediction.`, basis: "INFERRED", assumptionIds: [a], conditional: true, evidenceIds: [], entityIds: [op.path] });
      } else {
        const pts = [...cap.points].sort((x, y) => x.concurrency - y.concurrency);
        const now = pts[0].concurrency, want = now * op.factor, lo = pts[0], hi = pts[pts.length - 1];
        const evidence = pts.map((p) => p.runId);
        const plateau = pts.length >= 3 && pts[pts.length - 1].throughputPerSec <= pts[pts.length - 2].throughputPerSec * 1.03;
        if (want < lo.concurrency || want > hi.concurrency) {
          const grow = hi.p95Ms / Math.max(lo.p95Ms, 1e-9);
          consequences.push({ id: `c:${i}:extrap`, text: `${entry.name} at ${op.factor}× would be at concurrency ${want}, beyond the highest measured (${hi.concurrency}). Latency there is an extrapolation, not a measurement: it was ${lo.p95Ms} ms (p95) at ${lo.concurrency} and ${hi.p95Ms} ms at ${hi.concurrency}${plateau ? `, and throughput had stopped rising by ${hi.concurrency}, so it may saturate before ${want}` : ""}. The system could saturate earlier or later than any straight-line guess (${grow.toFixed(1)}× growth so far).`, basis: "EXTRAPOLATED", assumptionIds: [a], conditional: true, evidenceIds: evidence, entityIds: [op.path] });
        } else {
          const exact = pts.find((p) => p.concurrency === want);
          if (exact) consequences.push({ id: `c:${i}:measured`, text: `${entry.name} at ${op.factor}× (concurrency ${want}) was measured: p95 ${exact.p95Ms} ms, ${exact.throughputPerSec}/s, error rate ${(exact.errorRate * 100).toFixed(1)}%, in workload ${cap.workloadHash.slice(0, 8)}.`, basis: "MEASURED", assumptionIds: [a], conditional: true, evidenceIds: [exact.runId], entityIds: [op.path] });
          else { const below = [...pts].reverse().find((p) => p.concurrency < want)!, above = pts.find((p) => p.concurrency > want)!; const t = (want - below.concurrency) / (above.concurrency - below.concurrency); consequences.push({ id: `c:${i}:interp`, text: `${entry.name} at ${op.factor}× (concurrency ${want}) lies between two measured points (${below.concurrency} and ${above.concurrency}); p95 of about ${(below.p95Ms + t * (above.p95Ms - below.p95Ms)).toFixed(0)} ms is interpolated between ${below.p95Ms} and ${above.p95Ms} ms, not measured at ${want}.`, basis: "INTERPOLATED", assumptionIds: [a], conditional: true, evidenceIds: [below.runId, above.runId], entityIds: [op.path] }); }
        }
      }
    }
  });

  // A consequence is conditional until every assumption it rests on has been checked and supported; a contradicted one is shown as such.
  const state = (id: string): AssumptionState => given.get(id)?.state ?? "UNCHECKED";
  for (const c of consequences) {
    c.conditional = c.assumptionIds.some((id) => state(id) !== "SUPPORTED");
    if (c.assumptionIds.some((id) => state(id) === "CONTRADICTED")) c.text = `Does not hold, because an assumption it rests on was contradicted: ${c.text}`;
  }
  const assumptions = [...declared].map(([id, statement]) => ({ id, statement, state: state(id), evidenceIds: given.get(id)?.evidenceIds ?? [] }));
  limits.push("A scenario reasons over the indexed call graph and recorded measurements. Dynamic calls, configuration, external callers and behaviour under real load are not modelled unless a measurement says so.");
  const scenarioHash = h({ level: s.level, ops: s.ops, assumptions: s.assumptions, given: [...given.values()].map((a) => [a.id, a.state]).sort() });
  return {
    scenarioHash, baselineRevision: rev.id, level: s.level,
    comparison: [...comparison].map(([unit, c]) => ({ unit, ...c })).sort((a, b) => a.unit.localeCompare(b.unit)),
    consequences, assumptions, limits,
  };
}

/** Two results are comparable only when they describe the same baseline at the same level. Anything else would compare different things under one name. */
export function compareScenarios(a: ScenarioResult, b: ScenarioResult): { onlyInA: string[]; onlyInB: string[]; both: string[]; level: Level } {
  if (a.baselineRevision !== b.baselineRevision) throw new ScenarioError(["the two scenarios start from different revisions"]);
  if (a.level !== b.level) throw new ScenarioError([`the two scenarios are at different levels (${a.level} and ${b.level}); evaluate both at the same level to compare them`]);
  const A = new Set(a.comparison.map((c) => c.unit)), B = new Set(b.comparison.map((c) => c.unit));
  return { level: a.level, onlyInA: [...A].filter((x) => !B.has(x)).sort(), onlyInB: [...B].filter((x) => !A.has(x)).sort(), both: [...A].filter((x) => B.has(x)).sort() };
}
