import type { DisplayMode } from "@cie/schema";
import { epistemicSummary } from "./epistemic.ts";

export function EpistemicSummary({ elements, scope, stale }: { elements: { displayMode: DisplayMode }[]; scope: string; stale: number }) {
  const summary = epistemicSummary(elements);
  return <section className="epistemic-summary" aria-label="Evidence status summary">
    <strong>Evidence status</strong> · {summary.total} {scope}
    {summary.total > 0 && <ul>{summary.items.filter((x) => x.count).map((x) => <li key={x.mode}>{x.label}: {x.count} ({x.percent}%)</li>)}</ul>}
    {stale > 0 && <span> · {stale} stale</span>}
    <span className="muted"> · Display categories, not a confidence score.</span>
  </section>;
}
