import type { RendererModule } from "@cie/schema";
import { render, type Rendered } from "../../graph.ts";
import { raceScene } from "../../race-layout.ts";
export const id = "race-timeline" as const;
export default {
  id, description: "Twin replay timeline: sampled request lifecycles in simulated time with waits, retries, timeouts and run metrics.",
  render(view, _level, positions, stale) {
    // Replay semantics do not aggregate by graph zoom level; stations are the rows' vocabulary, not a graph.
    const base = render({ ...view, edges: [] }, 5, positions, stale);
    return { ...base, race: raceScene(view, base) };
  },
  textAlternative(view) {
    const spec = view.race;
    if (!spec) return view.caption;
    const fmt = (ms: number) => `${Math.round(ms)} ms`;
    return [
      view.caption,
      `Result class ${spec.resultClass.replaceAll("_", " ").toLowerCase()}: deterministic twin run ${spec.runId} (seed ${spec.seed}); simulated time, not production timing.`,
      `Run metrics: ${spec.metrics.completed}/${spec.metrics.offered} completed, ${spec.metrics.timedOut} timed out, ${spec.metrics.failed} failed, ${spec.metrics.dropped} dropped, ${spec.metrics.retried} retries; p50 ${fmt(spec.metrics.p50)}, p95 ${fmt(spec.metrics.p95)}, throughput ${spec.metrics.throughput}/s.`,
      ...spec.requests.map((r) => `${r.requestId}: ${r.outcome} after ${fmt(r.latencyMs)}${r.retries ? `, ${r.retries} retr${r.retries === 1 ? "y" : "ies"}` : ""} — ${r.spans.map((s) => `${s.stationId}${s.attempt ? `#${s.attempt}` : ""}${s.waitMs ? ` (waited ${fmt(s.waitMs)})` : ""} → ${s.event}`).join(", ")}`),
      ...spec.claims.map((c) => `${c.kind}: ${c.text}`),
      ...spec.gaps.map((g) => `Gap: ${g}`),
    ].join("\n");
  },
} satisfies RendererModule<typeof id, Rendered>;
