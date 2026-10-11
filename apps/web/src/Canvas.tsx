import { TableCanvas } from "./TableCanvas.tsx";
import { lazy, Suspense } from "react";
import type { RenderNode, RenderEdge, Rendered } from "./graph.ts";
import type { OverlayMark } from "./mapoverlays.ts";
import type { DetailPolicy } from "./detail.ts";
import type { CanvasState } from "./response-workspace.ts";
import "./zoom.css";

export interface CanvasProps {
  initialState?: CanvasState;
  onState?: (state: CanvasState) => void;
  rendered: Rendered;
  lensDetails?: Rendered;
  replayNodes?: Map<string, boolean>;
  overlayNodes?: Map<string, OverlayMark>;
  /** Changes when a new view (or new view version) replaces the old one; only then is the camera fitted. */
  viewKey: string;
  level: number;
  selected: Set<string>; // render-node ids
  boxSelect: boolean;
  onSelectNodes: (renderNodeIds: string[]) => void;
  onTapNode: (n: RenderNode) => void;
  onTapEdge: (e: RenderEdge) => void;
  caption: string;
  /** Bumps when the level was chosen explicitly (context selector); the camera then fits the new rendering. */
  fitTick: number;
  formId?: string;
  chartId?: string;
  policy?: DetailPolicy;
  onToggleNode: (n: RenderNode) => void;
  /** True for forms whose levels change the content (the semantic map); the others keep one drawing and only hide labels that are too small to read. */
  semanticLevels: boolean;
  onClear: () => void;
  onOpenOutline: () => void;
  announce: (text: string) => void;
}

const G6Canvas = lazy(() => import("./G6Canvas.tsx").then(m => ({ default: m.G6Canvas })));
const G6TimelineCanvas = lazy(() => import("./G6TimelineCanvas.tsx").then(m => ({ default: m.G6TimelineCanvas })));
export function Canvas(input: CanvasProps) {
  if (input.rendered.table) return <TableCanvas {...input} />;
  return <Suspense fallback={<div role="status">Loading diagram renderer…</div>}>
    {input.rendered.sequence || input.rendered.race ? <G6TimelineCanvas {...input} /> : <G6Canvas {...input} />}
  </Suspense>;
}
