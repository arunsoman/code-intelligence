import type { MapOverlayEntity, MapOverlays, ViewNode } from "@cie/schema";
import type { RenderNode, Rendered } from "./graph.ts";

export interface OverlayMark {
  test: string; runtime: string; testSize: number; runtimeSize: number;
  summary: string; notes: string[]; evidenceIds: string[];
}

/** Roll symbol-level signals up to the existing rendered node without changing its identity or position. */
export function overlayMarks(rendered: Rendered, nodes: Map<string, ViewNode>, data: MapOverlays | null, showTests: boolean, showRuntime: boolean): Map<string, OverlayMark> {
  const byEntity = new Map((data?.entities ?? []).map((row) => [row.entityId, row]));
  const marks = new Map<string, OverlayMark>();
  for (const node of rendered.nodes) {
    const refs = [...new Set(node.members.flatMap((member) => nodes.get(member)?.entityRefs ?? []))];
    const rows = refs.flatMap((ref) => byEntity.has(ref) ? [byEntity.get(ref)!] : []);
    if (!refs.length || (!showTests && !showRuntime)) continue;
    const test = showTests ? testTone(rows) : "off";
    const runtime = showRuntime ? runtimeTone(rows) : "off";
    const testSize = showTests ? showRuntime ? 50 : 100 : 0;
    const runtimeSize = showRuntime ? showTests ? 50 : 100 : 0;
    const notes = [
      ...(showTests ? testNotes(rows, refs.length) : []),
      ...(showRuntime ? runtimeNotes(rows, refs.length) : []),
    ];
    const evidenceIds = [...new Set(rows.flatMap((row) => [
      ...(showTests ? row.tests.evidenceIds : []), ...(showRuntime ? row.runtime.evidenceIds : []),
    ]))];
    marks.set(node.id, { test, runtime, testSize, runtimeSize, summary: [showTests ? `Tests: ${testLabel(test)}` : "", showRuntime ? `Runtime: ${runtimeLabel(runtime)}` : ""].filter(Boolean).join(". "), notes, evidenceIds });
  }
  return marks;
}

function testTone(rows: MapOverlayEntity[]): string {
  if (!rows.length || rows.every((r) => r.tests.state === "UNKNOWN")) return "unknown";
  if (rows.some((r) => r.tests.state === "FAILING")) return "failing";
  const measured = rows.flatMap((r) => r.tests.coveragePercent === null ? [] : [r.tests.coveragePercent]);
  if (measured.length && Math.min(...measured) < 50) return "low";
  if (measured.length) return "covered";
  return "linked";
}
function runtimeTone(rows: MapOverlayEntity[]): string {
  if (!rows.length || rows.every((r) => !r.runtime.spans)) return "unknown";
  return rows.some((r) => r.runtime.errors > 0) ? "errors" : "observed";
}
function testLabel(tone: string) { return ({ failing: "a mapped test fails", covered: "line coverage measured", low: "low line coverage measured", linked: "tests reach this code", unknown: "no matching test data" } as Record<string, string>)[tone] ?? "off"; }
function runtimeLabel(tone: string) { return ({ errors: "recorded errors", observed: "recorded spans", unknown: "no recorded spans in window" } as Record<string, string>)[tone] ?? "off"; }
function testNotes(rows: MapOverlayEntity[], refs: number): string[] {
  if (!rows.length) return [`No accessible overlay data for these ${refs} code item(s).`];
  const present = rows.map((r) => r.tests), measured = present.flatMap((x) => x.coveragePercent === null ? [] : [x.coveragePercent]);
  return [
    `${present.reduce((n, x) => n + x.reachingTests, 0)} test-to-code reach link(s) found within three static caller hops; unresolved calls may be missing.`,
    measured.length ? `Lowest available line coverage across ${measured.length} measured item(s): ${Math.min(...measured)}%. Line coverage is not behavioral correctness.` : "No accessible line-coverage measurements for this code.",
    ...(present.reduce((n, x) => n + x.failedTests, 0) ? ["At least one reaching test is recorded as failing; this does not show that this code caused the failure."] : []),
  ];
}
function runtimeNotes(rows: MapOverlayEntity[], refs: number): string[] {
  if (!rows.length) return [`No accessible runtime attribution for these ${refs} code item(s).`];
  const spans = rows.reduce((n, r) => n + r.runtime.spans, 0), errors = rows.reduce((n, r) => n + r.runtime.errors, 0);
  return [
    `${spans} recorded span(s), ${errors} error span(s); the display does not show currently executing requests.`,
    ...new Set(rows.flatMap((r) => r.runtime.notes)),
  ];
}
