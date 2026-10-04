import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBoardDelta, fromSnapshot, type BoardState } from "../src/board.ts";
import type { BoardDelta, BoardSnapshot } from "../../../packages/core/src/c22/types.ts";

const row = (id: string, state: any = "OPEN") => ({ id, version: 1, statement: id, state, freshness: "CURRENT" as const, claimId: "c" + id, priority: 0.5, disputed: false, independentSupportGroups: 0, reasonCodes: [] });
const snap = (version: number, rows: ReturnType<typeof row>[]): BoardSnapshot => ({ investigationId: "i", investigationVersion: version, sequence: version * 3, generation: 1, scopeHash: "h", restricted: false, hypothesisIds: rows.map((r) => r.id), claimIds: [], evidenceIds: [], checkIds: [], unknownGapIds: [], execution: "RUNNING", disposition: "UNASSESSED", hypotheses: rows });
const delta = (base: number, next: number, changed: string[], removed: string[] = []): BoardDelta => ({ investigationId: "i", baseVersion: base, newVersion: next, fromSequence: base * 3, toSequence: next * 3, generation: 1, changedHypothesisIds: changed, removedHypothesisIds: removed, changedClaimIds: [], addedEvidenceIds: [], requiresRecompile: true });

test("H23: a board update never moves the camera or the selection, even when the camera moved while the update was compiling", () => {
  let st: BoardState = fromSnapshot(snap(1, [row("a"), row("b")]), { x: 10, y: 20, zoom: 1 }, ["a"]);
  // The update starts compiling against camera {10,20}; meanwhile the user pans and zooms.
  const compiling = delta(1, 2, ["b"]);
  st = { ...st, camera: { x: 400, y: -50, zoom: 2.5 }, selection: ["a", "b"] };
  const r = applyBoardDelta(st, compiling, [row("b", "SUPPORTED")]);
  assert.equal(r.applied, true);
  assert.deepEqual(r.state.camera, { x: 400, y: -50, zoom: 2.5 }, "the camera is the user's, as it is now");
  assert.deepEqual(r.state.selection, ["a", "b"]);
  assert.equal(r.state.hypotheses.find((h) => h.id === "b")!.state, "SUPPORTED", "but the content did update");
  assert.equal(r.state.version, 2);
});

test("H23: a patch built for another version is refused and a full snapshot is requested instead of applied", () => {
  const st = fromSnapshot(snap(3, [row("a")]), { x: 1, y: 2, zoom: 1 }, ["a"]);
  const stale = applyBoardDelta(st, delta(1, 2, ["a"]), [row("a", "REFUTED")]);
  assert.deepEqual([stale.applied, stale.needsFull], [false, true]);
  assert.equal(stale.state, st, "the view is untouched");
  assert.match(stale.reason!, /version 1.*version 3|at 3/);
  // A removed hypothesis leaves the selection, and only the selection; the camera stays.
  const gone = applyBoardDelta(st, delta(3, 4, [], ["a"]), []);
  assert.deepEqual(gone.state.selection, []);
  assert.deepEqual(gone.state.camera, st.camera);
  assert.equal(gone.state.hypotheses.length, 0);
});
