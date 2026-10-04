import type { DisplayMode } from "@cie/schema";

export const STATUS_LABELS = { FACT: "Fact", INFERENCE: "Inference", HYPOTHESIS: "Hypothesis", FOG: "Fog" } as const;

/** Counts display statuses, not confidence scores or evidence-source categories. */
export function epistemicSummary(elements: Iterable<{ displayMode: DisplayMode }>) {
  const counts = { FACT: 0, INFERENCE: 0, HYPOTHESIS: 0, FOG: 0 };
  let total = 0;
  for (const element of elements) {
    if (element.displayMode === "HIDDEN") continue;
    counts[element.displayMode]++; total++;
  }
  return { total, items: Object.entries(counts).map(([mode, count]) => ({
    mode, label: STATUS_LABELS[mode as keyof typeof STATUS_LABELS], count,
    percent: total ? Math.round(count / total * 100) : 0,
  })) };
}
