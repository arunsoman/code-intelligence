// F10/WP-11 — race and ordering exploration.
// A queue simulation cannot speak to races. Candidate windows are extracted structurally, expressed as a
// reviewed finite model in the existing schedule DSL, and explored within bounds. A bounded result is
// reported as such and never upgraded to "race-free" (F10-A7).
import type { RaceFinding, RaceWindow, TwinStructure } from "@cie/schema";
import { artifactHash, exploreSchedules, validateHarness, type IndependentOracle, type ScheduleBounds, type ScheduleHarness } from "./defect-schedule.ts";
import type { AdapterCapability } from "@cie/schema";

export interface LineageWrite { stateKey: string; stationId: string; insideTransaction: boolean; insideLock: boolean }
export interface AsyncHandoff { from: string; to: string; sharedStateKeys: string[] }
export interface LockOrder { heldLockId: string; acquiredLockId: string; path: string }

/** Extract candidate race windows from writers, async hand-offs and lock-order cycles (existing detectors). */
export function candidateRaceWindows(structure: TwinStructure, input: { writes: LineageWrite[]; handoffs: AsyncHandoff[]; lockOrders: LockOrder[] }): RaceWindow[] {
  const windows: RaceWindow[] = [];
  const byState = new Map<string, LineageWrite[]>();
  for (const w of input.writes) byState.set(w.stateKey, [...(byState.get(w.stateKey) ?? []), w]);
  for (const [stateKey, writes] of byState) {
    const unprotected = writes.filter((w) => !w.insideTransaction && !w.insideLock);
    if (unprotected.length >= 2) windows.push({ id: `race:untransacted:${stateKey}`, description: `${unprotected.length} writers of ${stateKey} are not both inside a transaction or lock`, stationIds: [...new Set(unprotected.map((w) => w.stationId))], stateKeys: [stateKey], detector: "UNTRANSACTED_WRITERS" });
  }
  for (const ho of input.handoffs) if (ho.sharedStateKeys.length) windows.push({ id: `race:async:${ho.from}->${ho.to}`, description: `asynchronous hand-off ${ho.from} → ${ho.to} shares ${ho.sharedStateKeys.join(", ")} with its caller`, stationIds: [ho.from, ho.to], stateKeys: ho.sharedStateKeys, detector: "ASYNC_SHARED_STATE" });
  const lockEdges = new Map<string, string[]>();
  for (const l of input.lockOrders) lockEdges.set(l.heldLockId, [...(lockEdges.get(l.heldLockId) ?? []), l.acquiredLockId]);
  const cycles = findCycles(lockEdges);
  for (const cycle of cycles) windows.push({ id: `race:lockorder:${cycle.join(">")}`, description: `lock-order cycle ${cycle.join(" → ")}`, stationIds: structure.stations.filter((s) => s.resourceIds.some((r) => cycle.includes(r))).map((s) => s.id), stateKeys: [], detector: "LOCK_ORDER_CYCLE" });
  return windows;
}

function findCycles(edges: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visit = (node: string, path: string[]) => {
    if (path.includes(node)) { const cycle = path.slice(path.indexOf(node)); const key = [...cycle].sort().join("|"); if (!seen.has(key)) { seen.add(key); cycles.push(cycle); } return; }
    for (const next of edges.get(node) ?? []) visit(next, [...path, node]);
  };
  for (const node of edges.keys()) visit(node, []);
  return cycles;
}

export interface RaceExplorationInput {
  window: RaceWindow;
  harness: ScheduleHarness;
  oracle: IndependentOracle;
  bounds: ScheduleBounds;
  /** The adapter that would run the reviewed model; only its capability is consulted here. */
  adapterCapability: Pick<AdapterCapability, "supportsReplay" | "modelsWeakMemory" | "knownExclusions">;
  options?: { replay?: string[]; deadline?: number };
}

const BOUNDED_WORDING = "No violation found within the stated bounds. This does not show the code is race-free.";

/**
 * Explore one candidate window. An unreviewed oracle is refused; a violating schedule is returned with a
 * reproducible artifact hash; a bounded result carries the explicit non-claim.
 */
export async function exploreRaceWindow(input: RaceExplorationInput): Promise<RaceFinding> {
  if (!input.oracle.reviewedBy || !input.oracle.reviewedBy.trim()) throw new Error("race exploration refused: the oracle has no named reviewer");
  validateHarness(input.harness, input.oracle, input.bounds);
  const report = await exploreSchedules(input.harness, input.oracle, input.bounds, { replay: input.options?.replay, deadline: input.options?.deadline });
  const scheduleArtifactHash = report.schedule ? artifactHash({ schedule: report.schedule, state: report.state, harness: report.harnessHash, oracle: report.oracleHash }) : null;
  const replaySupported = input.adapterCapability.supportsReplay && !!scheduleArtifactHash;
  const wording = report.status === "PROPERTY_FAILED"
    ? `Violating schedule found among ${report.exploredSchedules} explored${report.completedSearch ? "" : " (search incomplete)"} within the stated bounds (${input.bounds.maxSchedules} schedules / ${input.bounds.maxSteps} steps). This does not show the code is race-free outside those bounds. ${replaySupported ? "The schedule is reproducible from its artifact hash." : "This adapter cannot replay the schedule on native code."}`
    : `${BOUNDED_WORDING} Explored ${report.exploredSchedules} schedules; search ${report.completedSearch ? "complete" : "incomplete"}; bounds ${input.bounds.maxSchedules} schedules / ${input.bounds.maxSteps} steps.`;
  return {
    explorationId: `explore-${artifactHash({ window: input.window.id, bounds: input.bounds, oracle: report.oracleHash })}`.slice(0, 64),
    twinId: "", window: input.window, bounds: input.bounds,
    status: report.status, exploredSchedules: report.exploredSchedules, completedSearch: report.completedSearch,
    schedule: report.schedule, scheduleArtifactHash, replaySupported, oracleReviewedBy: input.oracle.reviewedBy, wording,
    harnessHash: report.harnessHash, oracleHash: report.oracleHash,
  };
}

/** Replay a recorded schedule and return the state it reaches, so a finding can be reproduced exactly. */
export async function replayRaceSchedule(input: Omit<RaceExplorationInput, "options"> & { schedule: string[] }): Promise<{ state: Record<string, number> | null; status: RaceFinding["status"] }> {
  const report = await exploreSchedules(input.harness, input.oracle, input.bounds, { replay: input.schedule });
  return { state: report.state, status: report.status };
}

/** A race finding is always classed as a bounded correctness result, never a performance prediction. */
export function raceFindingClass(finding: RaceFinding): "BOUNDED_CORRECTNESS_RESULT" {
  void finding;
  return "BOUNDED_CORRECTNESS_RESULT";
}
