// The findings list machinery is pure and tested here: identity per row, filters, grouping,
// virtualized windowing and honest severity counts. The React shell around it is not rendered by tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetectorFinding, ResolvedEvidence, Severity } from "@cie/schema";
import { filterFindings, flatten, groupByFile, plural, rowLabel, severityCounts, cumulative, truncateMiddle, windowByOffsets, windowOf, type ListOptions, type TriageStatus } from "../src/defect-list.ts";

const finding = (id: string, overrides: Partial<DetectorFinding> = {}): DetectorFinding => ({
  id, version: 1, kind: "REPEATED_EXTERNAL_CALL", revision: "r", entityIds: [], spans: [], ruleId: "defect.call-in-loop",
  ruleVersion: 1, evidenceIds: [`ev:${id}`], coverageGaps: [], severity: "MEDIUM" as Severity, evidenceLevel: "STATIC_CANDIDATE", safetyObligations: [], ...overrides,
}) as DetectorFinding;

const ev = (id: string, file: string, line: number): ResolvedEvidence => ({ id, class: "STATIC_RESOLVED", file, startByte: 0, endByte: 0, startLine: line, endLine: line, snippet: `snippet of ${file}`, state: "CURRENT" });

const A = finding("a"); // medium, Reader.java:139
const B = finding("b"); // medium, Reader.java:410
const C = finding("c", { ruleId: "defect.other" });
const missing = finding("d"); // no evidence at all
const files = new Map<string, ResolvedEvidence>([
  ["ev:a", ev("ev:a", "src/pay/Reader.java", 139)],
  ["ev:b", ev("ev:b", "src/pay/Reader.java", 410)],
  ["ev:c", ev("ev:c", "src/util/Cache.java", 20)],
]);
const opts = (over: Partial<ListOptions> = {}): ListOptions => ({ search: "", severities: new Set(), kindFilter: "", statusFilter: "ALL", groupByFile: true, ...over });

test("row identity: every row's label carries kind, severity and a unique location (UX-01/24/31)", () => {
  const labelA = rowLabel(A, files.get("ev:a")!);
  const labelB = rowLabel(B, files.get("ev:b")!);
  assert.ok(/Repeated external call, MEDIUM — Reader\.java:139/.test(labelA), labelA);
  assert.notEqual(labelA, labelB, "rows in the same file must still differ by line");
  assert.ok(rowLabel(C, files.get("ev:c")!).includes("Cache.java:20"));
  const bare = rowLabel(missing, null);
  assert.ok(bare.endsWith("no source evidence"), bare);
});

test("filters: severity toggles, status, kind and text all narrow the list; sort orders by severity then file then line (UX-02)", () => {
  const fs = [A, B, C, missing, finding("e", { severity: "LOW" as Severity, kind: "RESOURCE_LEAK", ruleId: "defect.leak" })];
  const triage = new Map([["e", "DISMISSED" as TriageStatus]]);
  assert.deepEqual(filterFindings(fs, files, triage, opts({ severities: new Set(["LOW" as Severity]) })).map((f) => f.id), ["e"]);
  assert.deepEqual(filterFindings(fs, files, triage, opts({ statusFilter: "DISMISSED" })).map((f) => f.id), ["e"]);
  assert.deepEqual(filterFindings(fs, files, triage, opts({ kindFilter: "RESOURCE_LEAK" })).map((f) => f.id), ["e"]);
  assert.equal(filterFindings(fs, files, triage, opts({ search: "reader" })).length, 2);
  assert.equal(filterFindings(fs, files, triage, opts({ search: "nonsense-only" })).length, 0);
  const sorted = filterFindings(fs, files, triage, opts({}));
  assert.equal(sorted[4].severity, "LOW", "the low finding sorts last (severity desc)");
  assert.deepEqual(sorted.map((f) => f.id), ["a", "b", "c", "d", "e"], "severity first, then file, then line; unlocated findings last");
});
test("grouping: same-file findings share one group; collapsed groups contribute only a header row (UX-03)", () => {
  const ordered = [A, B, C, missing];
  const groups = groupByFile(ordered, files);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0].file, "src/pay/Reader.java");
  assert.deepEqual(groups[0].findings, [A, B]);
  const collapsed = flatten(ordered, files, opts({}), new Set());
  assert.equal(collapsed.every((r) => r.type === "group"), true, "collapsed groups render only their header");
  const open = flatten(ordered, files, opts({}), new Set(["src/pay/Reader.java"]));
  assert.equal(open.filter((r) => r.type === "group").length, 3);
  assert.equal(open.length, 5, "three headers plus the two expanded findings");
  const flat = flatten(ordered, files, opts({ groupByFile: false }), new Set());
  assert.equal(flat.length, 4);
});

test("windowing: a 953-row list renders a bounded slice near the scroll offset, never all of it (UX-17)", () => {
  const many = Array.from({ length: 953 }, (_, i) => finding(`f${i}`));
  const evs = new Map(many.map((f, i) => [f.evidenceIds[0], ev(f.evidenceIds[0], `src/m${Math.floor(i / 100)}/f${i}.java`, i + 1)]));
  const rows = flatten(many, evs, opts({ groupByFile: false }), new Set());
  assert.equal(rows.length, 953);
  const [, e0] = windowOf(rows.length, 0, 600, 40);
  assert.ok(e0 <= 600 / 40 + 16 + 1, `visible + overscan stays small: ${e0}`);
  const [s1] = windowOf(rows.length, 40 * 500, 600, 40);
  assert.ok(Math.abs(s1 - 500) <= 9, `window follows the offset: ${s1}`);
  const [, e1] = windowOf(rows.length, 40 * 500, 600, 40);
  assert.ok(e1 <= 953);
});

test("severity counts and truncation are exact and honest (UX-10/26)", () => {
  const counts = severityCounts([A, A, finding("x", { severity: "LOW" as Severity }), finding("z", { severity: "CRITICAL" as Severity })]);
  assert.equal(counts.get("MEDIUM"), 2);
  assert.equal(counts.get("LOW"), 1);
  assert.equal(counts.get("CRITICAL"), 1);
  assert.equal(counts.get("HIGH"), 0, "an absent severity reports zero, not undefined");
  assert.equal(truncateMiddle("a".repeat(42)), "a".repeat(42), "unchanged under the cap");
  const long = "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/app/Reader.java";
  const cut = truncateMiddle(long, 30);
  assert.ok(cut.length < long.length && cut.includes("…"));
  assert.ok(truncateMiddle("src/pay/Reader.java", 26) === "src/pay/Reader.java", "typical paths are untouched");
});// UX-41 grouping: variable-height virtualization for rule-grouped lists.
test("mixed-height windowing: cumulative offsets start at 0 and sum the heights", () => {
  const rows = [{ h: 44 }, { h: 96 }, { h: 44 }, { h: 44 }, { h: 44 }];
  assert.deepEqual(cumulative(rows), [0, 44, 140, 184, 228, 272]);
  assert.deepEqual(cumulative([]), [0]);
});
test("mixed-height windowing: windowByOffsets covers the viewport plus overscan on both sides", () => {
  const offs = cumulative([{ h: 44 }, { h: 96 }, { h: 44 }, { h: 44 }, { h: 44 }]);
  assert.deepEqual(windowByOffsets(offs, 0, 200, 0), [0, 4]);
  // 150..200 starts inside item 2 (which spans 140..184) and cuts before item 4 (228..272).
  assert.deepEqual(windowByOffsets(offs, 150, 50, 0), [2, 4]);
  assert.deepEqual(windowByOffsets(offs, 150, 50, 4), [0, 5]);
  assert.deepEqual(windowByOffsets(cumulative([]), 0, 400, 4), [0, 0]);
});
test("plural reads like a person wrote it", () => {
  assert.equal(plural(1, "piece of evidence"), "1 piece of evidence");
  assert.equal(plural(3, "piece of evidence", "pieces of evidence"), "3 pieces of evidence");
});
