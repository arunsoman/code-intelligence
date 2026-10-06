// Pure view logic for the Clarify, Plan and Changes stages (task 2.N), extracted unchanged from ReviewStages.tsx so it can be tested
// without a browser. Nothing here changes what the components show; it only gives each rule a name.
import type { FeatureReview, ReviewFile } from "../../../../packages/core/src/feature/presentation.ts";

export const FILE_PAGE_SIZE = 40;
export const REPRESENTATIONS = ["CANDIDATE", "BASELINE", "UNIFIED_DIFF", "SPLIT_DIFF"] as const;
export type Representation = (typeof REPRESENTATIONS)[number];

export function filterFiles(files: ReviewFile[], f: { requirement: string; status: string; filter: string }): ReviewFile[] {
  return files.filter((x) => (!f.requirement || x.requirementIds.includes(f.requirement)) && (!f.status || x.kind === f.status) && x.path.toLowerCase().includes(f.filter.toLowerCase()));
}

export function pageOf<T>(items: T[], page: number, size = FILE_PAGE_SIZE): { items: T[]; from: number; to: number; total: number; hasPrev: boolean; hasNext: boolean; paged: boolean } {
  return { items: items.slice(page * size, page * size + size), from: page * size + 1, to: Math.min(items.length, page * size + size), total: items.length, hasPrev: page > 0, hasNext: (page + 1) * size < items.length, paged: items.length > size };
}

export const countsLine = (counts: Record<string, number>): string => Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(" · ") || "No files recorded.";

/** Clicking a graph node selects the file or narrows to the requirement; any other node does nothing. */
export function selectFromGraph(id: string): { file?: string; requirement?: string } {
  if (id.startsWith("file:")) return { file: id.slice(5) };
  if (id.startsWith("requirement:")) return { requirement: id.slice(12) };
  return {};
}

export const defaultRepresentation = (file: ReviewFile): Representation => (file.kind === "DELETED" ? "BASELINE" : "CANDIDATE");
/** A representation that does not exist for this change is disabled, not hidden: an added file has no baseline, a deleted one no candidate. */
export const representationDisabled = (file: ReviewFile, r: string): boolean => (file.kind === "ADDED" && r === "BASELINE") || (file.kind === "DELETED" && r === "CANDIDATE");
/** The baseline of a renamed file lives at its old path. */
export const viewerPath = (file: ReviewFile, representation: string): string => (representation === "BASELINE" && file.kind === "RENAMED" ? file.oldPath! : file.path);
export const downloadName = (path: string, representation: string): string => path.split("/").at(-1)! + (representation.includes("DIFF") ? ".diff" : "");

export type SplitRow = { left: string | null; right: string | null };
/** Malformed split-diff content is reported as an error by the caller, never rendered as if it were source. */
export function parseSplitRows(content: string): SplitRow[] | undefined { try { return JSON.parse(content); } catch { return undefined; } }

/** Line links are at file-mutation scope; the text says so and does not claim line-level causation. */
export const lineNotice = (file: ReviewFile, line: number): string =>
  `Line ${line}: linked at file-mutation scope to ${file.requirementIds.join(", ") || "no recorded requirement"}; tasks ${file.taskIds.join(", ") || "unassigned"}. Exact line causation is not established.`;

export type CriterionRow = { id: string; expectedOutcome: string; evidence: string };
/** Criteria that cover any requirement the selected file implements, with every recorded result; no result is "NOT_RUN", not blank. */
export function criterionEvidence(review: FeatureReview, file: ReviewFile): CriterionRow[] {
  return review.criteria.filter((a) => a.requirementIds.some((id) => file.requirementIds.includes(id))).map((a) => ({
    id: a.id, expectedOutcome: a.expectedOutcome,
    evidence: review.results.filter((r) => r.acceptanceId === a.id).map((r) => `${r.kind}: ${r.status} (${r.id})`).join("; ") || "NOT_RUN — no related evidence recorded",
  }));
}

/** What kind of thing a file is, beyond its text: a binary, a link (and where it points) and a changed executable bit. Text files at the default mode say nothing extra. */
export function fileBadges(f: ReviewFile): string[] {
  const out: string[] = [];
  if (f.entryKind === "BINARY") out.push("binary"); if (f.entryKind === "SYMLINK") out.push(`symlink${f.target ? ` → ${f.target}` : ""}`);
  if (f.beforeMode !== f.afterMode && (f.beforeMode === "100755" || f.afterMode === "100755")) out.push(f.afterMode === "100755" ? (f.beforeMode ? "now executable" : "executable") : "no longer executable");
  return out;
}
export const filePosition = (f: ReviewFile): string => { const badges = fileBadges(f); return `${f.kind}: ${f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ` : ""}${f.path}${badges.length ? ` (${badges.join(", ")})` : ""}`; };
