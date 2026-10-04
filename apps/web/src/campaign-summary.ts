// F08 campaign presentation helpers. The copy rules of §12.2 are enforced here so the panel cannot accidentally show a
// single success score, an "all good" aggregate, or an unrequired compatibility mode as "compatible".
import type { ChildState, CompatibilityState } from "@cie/schema";

export const CAMPAIGN_COPY = {
  completed: "CIE has finished its work; changes are not merged or deployed.",
  noAggregate: "Results are shown per child. There is no single campaign health score or pass percentage.",
  notEvaluated: "not evaluated",
  hiddenNote: "You can see the repositories you have access to.",
  draft: "Every child is a draft. CIE never merges or deploys.",
} as const;

/** The order states are listed in the children-table filter, so the list is stable. */
export const CHILD_STATE_ORDER: ChildState[] = [
  "NOT_STARTED", "PLANNED", "RUNNING", "REVIEW_READY", "PUBLISHED", "FAILED", "BLOCKED", "STALE", "EXCLUDED", "CANCELLED", "CLOSED_ON_GITHUB",
];

/** Text plus tone for a child state; never a bare colour. */
export function stateCell(state: ChildState): { glyph: string; label: string; tone: "ok" | "warn" | "bad" | "muted" } {
  switch (state) {
    case "PUBLISHED": return { glyph: "✓", label: "published", tone: "ok" };
    case "REVIEW_READY": return { glyph: "✓", label: "ready for review", tone: "ok" };
    case "FAILED": return { glyph: "✗", label: "failed", tone: "bad" };
    case "BLOCKED": return { glyph: "⛔", label: "blocked", tone: "bad" };
    case "STALE": return { glyph: "↻", label: "stale", tone: "warn" };
    case "EXCLUDED": return { glyph: "·", label: "excluded", tone: "muted" };
    case "CANCELLED": return { glyph: "·", label: "cancelled", tone: "muted" };
    case "CLOSED_ON_GITHUB": return { glyph: "·", label: "closed on GitHub", tone: "warn" };
    case "RUNNING": return { glyph: "…", label: "running", tone: "muted" };
    case "PLANNED": return { glyph: "…", label: "planned", tone: "muted" };
    default: return { glyph: "·", label: "not started", tone: "muted" };
  }
}

/** Counts as rows per state (never a single total or a percentage). */
export function countRows(counts: Partial<Record<string, number>>): { state: ChildState; count: number }[] {
  return CHILD_STATE_ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => ({ state: s, count: counts[s] ?? 0 }));
}

/** A compatibility mode that was not evaluated reads "not evaluated", never "compatible" or "passed". */
export function compatibilityLabel(state: CompatibilityState): string {
  switch (state) {
    case "PASSED": return "passed";
    case "FAILED": return "failed";
    case "PENDING": return "pending";
    case "NOT_EVALUABLE": return "not evaluable";
    case "NOT_EVALUATED": return CAMPAIGN_COPY.notEvaluated;
  }
}

export function compatibilityTone(state: CompatibilityState): "ok" | "warn" | "bad" | "muted" {
  if (state === "PASSED") return "ok";
  if (state === "FAILED") return "bad";
  if (state === "PENDING") return "warn";
  return "muted";
}

/** Progress is a count of visible terminal children over visible children; it is never labelled a success rate. */
export function progressText(completed: number, total: number): string {
  return `${completed} of ${total} child(ren) CIE can see have reached a terminal state`;
}
