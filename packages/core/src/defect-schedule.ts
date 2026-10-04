import { createHash } from "node:crypto";

export type Expression = number | { ref: string } | { op: "ADD" | "SUB" | "EQ" | "NE" | "LT" | "LE" | "AND" | "OR"; left: Expression; right: Expression };
export type Instruction = { op: "SET"; target: string; value: Expression } | { op: "AWAIT" } | { op: "CHECK"; condition: Expression; skip: number };
export interface ScheduleHarness {
  schemaId: "defect.schedule.v1";
  initial: Record<string, number>;
  tasks: { id: string; instructions: Instruction[] }[];
}
export interface IndependentOracle { schemaId: "defect.oracle.v1"; description: string; reviewedBy: string; condition: Expression; checkAt: "EVERY_STEP" | "COMPLETION" }
export interface ScheduleBounds { maxSchedules: number; maxSteps: number }
export interface ScheduleReport {
  status: "SUCCEEDED" | "PROPERTY_FAILED" | "BUDGET_STOPPED" | "INCONCLUSIVE" | "CANCELLED";
  exploredSchedules: number; completedSearch: boolean; schedule: string[] | null;
  state: Record<string, number> | null; oracleHash: string; harnessHash: string; exclusions: string[];
}
export const artifactHash = (value: unknown): string => {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
};
const NAME = /^[a-zA-Z][a-zA-Z0-9_.]{0,127}$/;
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
function name(s: unknown): asserts s is string { if (typeof s !== "string" || !NAME.test(s) || forbidden.has(s)) throw new Error("Invalid state or task name"); }
function expression(x: Expression, depth = 0): void {
  if (depth > 24) throw new Error("Expression depth exceeds bound");
  if (typeof x === "number") { if (!Number.isSafeInteger(x)) throw new Error("Expression constants must be safe integers"); return; }
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("Invalid expression");
  if ("ref" in x) { if (Object.keys(x).length !== 1) throw new Error("Invalid reference"); name(x.ref); return; }
  if (!["ADD", "SUB", "EQ", "NE", "LT", "LE", "AND", "OR"].includes(x.op) || Object.keys(x).length !== 3) throw new Error("Invalid expression operation");
  expression(x.left, depth + 1); expression(x.right, depth + 1);
}
export function validateHarness(h: ScheduleHarness, oracle: IndependentOracle, bounds: ScheduleBounds) {
  if (!h || h.schemaId !== "defect.schedule.v1" || !h.initial || !Array.isArray(h.tasks) || h.tasks.length < 1 || h.tasks.length > 8) throw new Error("Invalid bounded schedule harness");
  for (const [key, value] of Object.entries(h.initial)) { name(key); if (!Number.isSafeInteger(value)) throw new Error("State must contain safe integers"); }
  if (Object.keys(h.initial).length > 256) throw new Error("State size exceeds bound");
  if (new Set(h.tasks.map((t) => t.id)).size !== h.tasks.length) throw new Error("Duplicate task IDs");
  for (const t of h.tasks) {
    name(t.id);
    if (!Array.isArray(t.instructions) || t.instructions.length > 64) throw new Error("Task length exceeds bound");
    for (const i of t.instructions) {
      if (i.op === "SET") { name(i.target); expression(i.value); if (!Object.hasOwn(h.initial, i.target)) throw new Error("Every state variable must be declared"); }
      else if (i.op === "CHECK") { expression(i.condition); if (!Number.isSafeInteger(i.skip) || i.skip < 0 || i.skip > 64) throw new Error("Invalid branch bound"); }
      else if (i.op !== "AWAIT") throw new Error("Unknown instruction");
    }
  }
  if (!oracle || oracle.schemaId !== "defect.oracle.v1" || !oracle.description || !oracle.reviewedBy || !["EVERY_STEP", "COMPLETION"].includes(oracle.checkAt)) throw new Error("An independently reviewed property is required");
  expression(oracle.condition);
  if (!Number.isSafeInteger(bounds.maxSchedules) || bounds.maxSchedules < 1 || bounds.maxSchedules > 100000 || !Number.isSafeInteger(bounds.maxSteps) || bounds.maxSteps < 1 || bounds.maxSteps > 512) throw new Error("Invalid schedule bounds");
}
function evaluate(x: Expression, s: Record<string, number>): number {
  if (typeof x === "number") return x;
  if ("ref" in x) { if (!Object.hasOwn(s, x.ref)) throw new Error("Expression references undeclared state"); return s[x.ref]; }
  const a = evaluate(x.left, s), b = evaluate(x.right, s);
  const v = x.op === "ADD" ? a + b : x.op === "SUB" ? a - b : x.op === "EQ" ? +(a === b) : x.op === "NE" ? +(a !== b) : x.op === "LT" ? +(a < b) : x.op === "LE" ? +(a <= b) : x.op === "AND" ? +(!!a && !!b) : +(!!a || !!b);
  if (!Number.isSafeInteger(v)) throw new Error("Model arithmetic overflow");
  return v;
}
interface Node { state: Record<string, number>; positions: number[]; schedule: string[] }
/** One selected task runs until its next await or completion, matching supported async scheduling boundaries. */
function advance(h: ScheduleHarness, node: Node, task: number): Node {
  const next = structuredClone(node), program = h.tasks[task].instructions;
  next.schedule.push(h.tasks[task].id);
  while (next.positions[task] < program.length) {
    const i = program[next.positions[task]++];
    if (i.op === "AWAIT") break;
    if (i.op === "SET") next.state[i.target] = evaluate(i.value, next.state);
    if (i.op === "CHECK" && !evaluate(i.condition, next.state)) next.positions[task] += i.skip;
  }
  return next;
}
export async function exploreSchedules(h: ScheduleHarness, oracle: IndependentOracle, bounds: ScheduleBounds, options: { replay?: string[]; signal?: AbortSignal; deadline?: number } = {}): Promise<ScheduleReport> {
  validateHarness(h, oracle, bounds);
  const report: ScheduleReport = { status: "INCONCLUSIVE", exploredSchedules: 0, completedSearch: false, schedule: null, state: null, oracleHash: artifactHash(oracle), harnessHash: artifactHash(h), exclusions: ["Finite async state model only; external I/O, database isolation, weak memory and native code are not modeled."] };
  const stack: Node[] = [{ state: { ...h.initial }, positions: h.tasks.map(() => 0), schedule: [] }];
  let steps = 0, cut = false;
  while (stack.length) {
    if (++steps % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    if (options.signal?.aborted) return { ...report, status: "CANCELLED" };
    if (Date.now() >= (options.deadline ?? Infinity)) return { ...report, status: "BUDGET_STOPPED" };
    const n = stack.pop()!;
    const runnable = h.tasks.map((t, i) => n.positions[i] < t.instructions.length ? i : -1).filter((i) => i >= 0);
    if ((oracle.checkAt === "EVERY_STEP" || !runnable.length) && !evaluate(oracle.condition, n.state)) return { ...report, status: "PROPERTY_FAILED", exploredSchedules: report.exploredSchedules + 1, schedule: n.schedule, state: n.state };
    if (!runnable.length) {
      report.exploredSchedules++;
      if (report.exploredSchedules >= bounds.maxSchedules && stack.length) return { ...report, status: "BUDGET_STOPPED" };
      continue;
    }
    if (n.schedule.length >= bounds.maxSteps) { cut = true; continue; }
    if (options.replay) {
      const selected = h.tasks.findIndex((t) => t.id === options.replay![n.schedule.length]);
      if (!runnable.includes(selected)) throw new Error("Replay schedule is incomplete or selects a task that is not runnable");
      stack.push(advance(h, n, selected));
    } else for (const i of runnable.reverse()) stack.push(advance(h, n, i));
  }
  return { ...report, status: cut ? "BUDGET_STOPPED" : "SUCCEEDED", completedSearch: !cut && !options.replay };
}
