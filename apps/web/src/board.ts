// C22 board updates on the client (design §11, §14). A committed delta changes what the board shows, never where the
// user is looking: the camera and the selection belong to the user, and a patch computed against an older version of the
// view cannot override a camera that moved while it was compiling.
import type { BoardDelta, BoardSnapshot } from "../../../packages/core/src/c22/types.ts";

export interface Camera { x: number; y: number; zoom: number }
export interface BoardState { version: number; sequence: number; generation: number; hypotheses: BoardSnapshot["hypotheses"]; camera: Camera; selection: string[] }
export interface Applied { state: BoardState; applied: boolean; needsFull: boolean; reason?: string }

export function fromSnapshot(s: BoardSnapshot, camera: Camera = { x: 0, y: 0, zoom: 1 }, selection: string[] = []): BoardState {
  return { version: s.investigationVersion, sequence: s.sequence, generation: s.generation, hypotheses: s.hypotheses, camera, selection };
}

/**
 * Apply a delta on top of the state it was computed from. If the client is not at the delta's base version it asks for a
 * full snapshot instead of guessing. `changed` carries the new rows (the delta lists ids; the caller supplies their rows).
 */
export function applyBoardDelta(state: BoardState, delta: BoardDelta, rows: BoardSnapshot["hypotheses"]): Applied {
  if (delta.baseVersion !== state.version) return { state, applied: false, needsFull: true, reason: `the update is for version ${delta.baseVersion} and this view is at ${state.version}` };
  const removed = new Set(delta.removedHypothesisIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const next = [...state.hypotheses.filter((h) => !removed.has(h.id)).map((h) => byId.get(h.id) ?? h), ...rows.filter((r) => !state.hypotheses.some((h) => h.id === r.id))];
  // The user's camera and selection are carried over as they are now. Selected items that no longer exist are dropped from the selection only.
  const selection = state.selection.filter((id) => !removed.has(id));
  return { state: { ...state, version: delta.newVersion, sequence: delta.toSequence, generation: delta.generation, hypotheses: next, selection }, applied: true, needsFull: false };
}
