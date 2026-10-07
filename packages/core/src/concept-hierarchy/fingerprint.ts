// Anchoring (plan §1): the exact rule that decides whether a kept concept is re-named. The rule, in
// order, with short-circuits:
//   1. no previous label                          → rename
//   2. member Jaccard similarity > T_stable       → keep (the members barely moved)
//   3. the module's export surface changed        → rename
//   4. feature-histogram shift < T_histogram      → keep
//   5. otherwise                                  → rename
// Every threshold comes from concept-config and is uncalibrated (plan §0.4).
import type { ExportSurface } from "@cie/schema";
import { conceptConfig } from "./config.ts";
import { histogramShift } from "./canonicalize.ts";

export interface AnchorInput {
  prevLabel: string | null;
  prevMembers: string[];
  nextMembers: string[];
  prevFeatures: Record<string, number>;
  nextFeatures: Record<string, number>;
  /** The module(s) the members live in, for the export-surface rule. */
  moduleIds: string[];
  prevSurfaces: ExportSurface[];
  nextSurfaces: ExportSurface[];
}

export type AnchorDecision = { rename: true; reason: string } | { rename: false; reason: string };

export function shouldRename(input: AnchorInput): AnchorDecision {
  const cfg = conceptConfig();
  if (!input.prevLabel) return { rename: true, reason: "no previous label" };
  const a = new Set(input.prevMembers), b = new Set(input.nextMembers);
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  const jaccard = union === 0 ? 0 : inter / union;
  if (jaccard > cfg.jaccardStable.value) return { rename: false, reason: `member Jaccard ${jaccard.toFixed(2)} > T_stable ${cfg.jaccardStable.value}` };
  const surfaceChanged = input.moduleIds.some((m) => !sameSurface(input.prevSurfaces.find((s) => s.moduleId === m), input.nextSurfaces.find((s) => s.moduleId === m)));
  if (surfaceChanged) return { rename: true, reason: "the module's export surface changed" };
  const shift = histogramShift(input.prevFeatures, input.nextFeatures);
  if (shift < cfg.histogramShift.value) return { rename: false, reason: `histogram shift ${shift.toFixed(3)} < T_histogram ${cfg.histogramShift.value}` };
  return { rename: true, reason: `histogram shift ${shift.toFixed(3)} >= T_histogram ${cfg.histogramShift.value}` };
}

function sameSurface(a: ExportSurface | undefined, b: ExportSurface | undefined): boolean {
  const key = (s?: ExportSurface) => s ? s.exports.map((e) => `${e.name}:${e.kind}`).join("|") : "";
  return key(a) === key(b);
}
