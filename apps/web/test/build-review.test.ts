import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeatureReview, ReviewFile } from "../../../packages/core/src/feature/presentation.ts";
import { countsLine, criterionEvidence, defaultRepresentation, downloadName, filePosition, filterFiles, lineNotice, pageOf, parseSplitRows, representationDisabled, selectFromGraph, viewerPath } from "../src/build/review-view.ts";

const file = (over: Partial<ReviewFile> = {}): ReviewFile => ({ path: "src/a.ts", kind: "MODIFIED", requirementIds: ["r1"], taskIds: ["t1"], componentIds: ["C28"], attribution: "COMPLETE", gaps: [], ...over });
const files = [file({ path: "src/export/csv.ts", kind: "ADDED", requirementIds: ["r1"] }), file({ path: "src/domain/Errors.ts", oldPath: "src/errors.ts", kind: "RENAMED", requirementIds: ["r2"] }), file({ path: "src/jobs/old.ts", kind: "DELETED", requirementIds: [] }), file({ path: "docs/export.md", kind: "PLANNED", requirementIds: ["r1", "r2"] })];

test("PF-071 file filters: requirement, status and a case-insensitive path search combine", () => {
  const paths = (f: Partial<{ requirement: string; status: string; filter: string }>) => filterFiles(files, { requirement: "", status: "", filter: "", ...f }).map((x) => x.path);
  assert.equal(paths({}).length, 4);
  assert.deepEqual(paths({ requirement: "r2" }), ["src/domain/Errors.ts", "docs/export.md"]); assert.deepEqual(paths({ status: "ADDED" }), ["src/export/csv.ts"]);
  assert.deepEqual(paths({ filter: "ERRORS" }), ["src/domain/Errors.ts"], "search ignores case"); assert.deepEqual(paths({ requirement: "r1", status: "PLANNED", filter: "docs" }), ["docs/export.md"]); assert.deepEqual(paths({ requirement: "r3" }), []);
  assert.equal(countsLine({ ADDED: 2, MODIFIED: 0, DELETED: 1 }), "ADDED: 2 · DELETED: 1"); assert.equal(countsLine({ ADDED: 0 }), "No files recorded."); assert.equal(countsLine({}), "No files recorded.");
});

test("PF-072 paging: 40 per page, the range text matches, and the controls follow the page", () => {
  const many = Array.from({ length: 95 }, (_, i) => i);
  const p0 = pageOf(many, 0), p1 = pageOf(many, 1), p2 = pageOf(many, 2);
  assert.deepEqual([p0.items.length, p0.from, p0.to, p0.hasPrev, p0.hasNext, p0.paged], [40, 1, 40, false, true, true]); assert.deepEqual([p1.from, p1.to, p1.hasPrev, p1.hasNext], [41, 80, true, true]);
  assert.deepEqual([p2.items.length, p2.from, p2.to, p2.hasNext, p2.total], [15, 81, 95, false, 95]);
  assert.equal(pageOf([1, 2, 3], 0).paged, false, "a short list shows no pager"); assert.equal(pageOf(many.slice(0, 40), 0).paged, false); assert.equal(pageOf(many.slice(0, 41), 0).paged, true);
  assert.deepEqual(pageOf([], 0).items, []);
});

test("AT-71/73 graph and list stay equivalent: a node selects the file or narrows to the requirement, anything else does nothing", () => {
  assert.deepEqual(selectFromGraph("file:src/a.ts"), { file: "src/a.ts" }); assert.deepEqual(selectFromGraph("requirement:r1"), { requirement: "r1" });
  assert.deepEqual(selectFromGraph("component:C28"), {}); assert.deepEqual(selectFromGraph("file:"), { file: "" });
  assert.equal(filePosition(files[1]!), "RENAMED: src/errors.ts → src/domain/Errors.ts"); assert.equal(filePosition(files[0]!), "ADDED: src/export/csv.ts"); assert.equal(filePosition(file({ oldPath: "src/a.ts" })), "MODIFIED: src/a.ts", "an unchanged old path is not shown as a move");
});

test("PF-072 file viewer rules: the right side is chosen per change, impossible views are disabled, a renamed baseline is at its old path", () => {
  assert.deepEqual(files.map(defaultRepresentation), ["CANDIDATE", "CANDIDATE", "BASELINE", "CANDIDATE"]);
  const [added, renamed, deleted] = [files[0]!, files[1]!, files[2]!];
  assert.deepEqual(["CANDIDATE", "BASELINE", "UNIFIED_DIFF", "SPLIT_DIFF"].map((r) => representationDisabled(added, r)), [false, true, false, false], "an added file has no baseline");
  assert.deepEqual(["CANDIDATE", "BASELINE", "UNIFIED_DIFF", "SPLIT_DIFF"].map((r) => representationDisabled(deleted, r)), [true, false, false, false], "a deleted file has no candidate");
  assert.deepEqual(["CANDIDATE", "BASELINE"].map((r) => representationDisabled(renamed, r)), [false, false]);
  assert.equal(viewerPath(renamed, "BASELINE"), "src/errors.ts"); assert.equal(viewerPath(renamed, "CANDIDATE"), "src/domain/Errors.ts"); assert.equal(viewerPath(renamed, "UNIFIED_DIFF"), "src/domain/Errors.ts"); assert.equal(viewerPath(added, "BASELINE"), "src/export/csv.ts");
  assert.equal(downloadName("src/export/csv.ts", "CANDIDATE"), "csv.ts"); assert.equal(downloadName("src/export/csv.ts", "UNIFIED_DIFF"), "csv.ts.diff"); assert.equal(downloadName("src/export/csv.ts", "SPLIT_DIFF"), "csv.ts.diff"); assert.equal(downloadName("README", "BASELINE"), "README");
  assert.deepEqual(parseSplitRows('[{"left":"a","right":null}]'), [{ left: "a", right: null }]); assert.equal(parseSplitRows("{ not json"), undefined, "malformed split content is an error, never rendered as source");
});

test("PF-075 line links are honest about their scope and name the requirement and tasks, or say none is recorded", () => {
  assert.equal(lineNotice(file(), 12), "Line 12: linked at file-mutation scope to r1; tasks t1. Exact line causation is not established.");
  assert.equal(lineNotice(file({ requirementIds: [], taskIds: [] }), 3), "Line 3: linked at file-mutation scope to no recorded requirement; tasks unassigned. Exact line causation is not established.");
  assert.match(lineNotice(file({ requirementIds: ["r1", "r2"] }), 1), /to r1, r2;/);
});

test("AT-70 related criterion evidence lists every recorded result, and 'not run' when there is none", () => {
  const review = { criteria: [{ id: "ac1", requirementIds: ["r1"], expectedOutcome: "csv rows" }, { id: "ac2", requirementIds: ["r2"], expectedOutcome: "errors grouped" }, { id: "ac3", requirementIds: ["r9"], expectedOutcome: "other" }],
    results: [{ id: "res1", acceptanceId: "ac1", kind: "UNIT", status: "PASS" }, { id: "res2", acceptanceId: "ac1", kind: "BROWSER", status: "INCOMPLETE" }] } as unknown as FeatureReview;
  assert.deepEqual(criterionEvidence(review, file({ requirementIds: ["r1", "r2"] })), [{ id: "ac1", expectedOutcome: "csv rows", evidence: "UNIT: PASS (res1); BROWSER: INCOMPLETE (res2)" }, { id: "ac2", expectedOutcome: "errors grouped", evidence: "NOT_RUN — no related evidence recorded" }]);
  assert.deepEqual(criterionEvidence(review, file({ requirementIds: [] })), [], "a file with no requirement has no criteria to show");
});
