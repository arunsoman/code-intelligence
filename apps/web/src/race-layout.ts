// Race replay scene geometry: simulated time runs along the x axis; one row per sampled request.
// All coordinates derive from the RaceSpec (simulated-model time); nothing here invents data.
import { RaceSpecSchema, type ViewSpec } from "@cie/schema";
import type { Rendered, RenderNode } from "./graph.ts";

export interface RaceScene {
  width: number; height: number; headerHeight: number; rowHeight: number; plotX: number; plotW: number;
  timeMaxMs: number;
  stations: { node: RenderNode; id: string; index: number; hue: number }[];
  blocks: { requestId: string; stationId: string; attempt: number; x: number; y: number; waitX: number; waitW: number; w: number; h: number; outcome: string; event: "SERVICE" | "TIMEOUT" | "FAULT" }[];
  rows: { requestId: string; y: number; outcome: string; latencyMs: number; retries: number }[];
}

const HEADER = 34, ROW = 16, PAD = 10, PLOT_X = 190, ROW_W = 980;

export function raceScene(view: ViewSpec, rendered: Rendered): RaceScene | undefined {
  const parsed = RaceSpecSchema.safeParse(view.race);
  if (!parsed.success) return;
  const spec = parsed.data;
  const byNode = new Map(rendered.nodes.map((n) => [n.id, n]));
  const stations = spec.stationIds.flatMap((id, i) => {
    const node = byNode.get(`n:race:${id}`);
    return node ? [{ node, id, index: i, hue: Math.round((i * 360) / Math.max(1, spec.stationIds.length)) }] : [];
  });
  if (!stations.length) return;
  const plotW = ROW_W - PLOT_X - PAD;
  const timeMaxMs = Math.max(1, ...spec.requests.flatMap((r) => r.spans.map((s) => s.endMs)));
  const at = (ms: number) => PLOT_X + (Math.max(0, ms) / timeMaxMs) * plotW;
  const blocks: RaceScene["blocks"] = [];
  const rows = spec.requests.map((r, i) => {
    const y = HEADER + i * ROW;
    for (const s of r.spans) {
      // Blocks stay visible (min 2px) and inside the time window: x is clamped before the width is applied.
      const x = Math.min(at(s.startMs), PLOT_X + plotW - 2);
      const w = Math.max(2, at(s.endMs) - at(s.startMs));
      blocks.push({
        requestId: r.requestId, stationId: s.stationId, attempt: s.attempt,
        x, y,
        waitX: at(s.startMs - s.waitMs), waitW: Math.max(0, x - at(s.startMs - s.waitMs)),
        w: Math.min(w, PLOT_X + plotW - x), h: ROW - 5,
        outcome: r.outcome, event: s.event,
      });
    }
    return { requestId: r.requestId, y, outcome: r.outcome, latencyMs: r.latencyMs, retries: r.retries };
  });
  return { width: ROW_W, height: HEADER + rows.length * ROW + 36, headerHeight: HEADER, rowHeight: ROW, plotX: PLOT_X, plotW, timeMaxMs, stations, blocks, rows };
}
