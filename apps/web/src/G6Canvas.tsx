import { Graph, GraphEvent, type IElementEvent } from "@antv/g6";
import { useEffect, useRef, useState } from "react";
import type { CanvasProps } from "./Canvas.tsx";
import { g6Data, g6Layout } from "./g6-adapter.ts";
import { attachFisheye, chartColor, LENS_DEFAULTS, type LensEngine, type LensScene } from "./fisheye.ts";
import { describeNode, nextByDirection, type Dir } from "./graph.ts";
import type { CanvasState } from "./response-workspace.ts";
import { g6LensNotation, g6NodeSize, g6NodeType } from "./g6-notation.ts";
import { registerG6Notation } from "./g6-elements.ts";

/** G6 owns graph geometry; the shared lens owns captured-element previews. */
export function G6Canvas(p: CanvasProps) {
  const host = useRef<HTMLDivElement>(null), surface = useRef<HTMLDivElement>(null);
  const graph = useRef<Graph | null>(null), lens = useRef<LensEngine | null>(null);
  const cb = useRef(p); cb.current = p;
  const camera = useRef<CanvasState>(p.initialState ?? { zoom: 1, pan: { x: 0, y: 0 }, lens: { ...LENS_DEFAULTS } });
  const focusMembers = useRef<string[]>([]);
  const focus = useRef<string | null>(null), ready = useRef(false);
  const lastView = useRef(""), lastRepresentation = useRef("");
  const [status, setStatus] = useState("Arranging graph…"), [paused, setPaused] = useState(!camera.current.lens.enabled);
  const [offscreen, setOffscreen] = useState(0);
  const save = () => {
    const g = graph.current; if (!g || !host.current || !ready.current || g.destroyed) return;
    const pan = g.getViewportByCanvas([0, 0]);
    camera.current = { zoom: g.getZoom(), pan: { x: pan[0], y: pan[1] }, lens: camera.current.lens };
    host.current!.dataset.zoom = String(g.getZoom());
    host.current!.dataset.worldNodes = JSON.stringify(cb.current.rendered.nodes.filter(n=>!n.decorative).map(n=>({id:n.id,position:g.getElementPosition(n.id)})));
    host.current!.dataset.edgeIds = JSON.stringify(cb.current.rendered.edges.map(e=>e.id));
    host.current!.dataset.pan = JSON.stringify({x:pan[0],y:pan[1]});
    host.current!.dataset.nodePositions = JSON.stringify(cb.current.rendered.nodes.map(n => { const q = g.getViewportByCanvas(g.getElementPosition(n.id)); return { id: n.id, x: q[0], y: q[1] }; }));
    const bounds = (id: string) => { const box = g.getElementRenderBounds(id); return { id, x1: box.min[0], y1: box.min[1], x2: box.max[0], y2: box.max[1] }; };
    host.current!.dataset.nodeBounds = JSON.stringify(cb.current.rendered.nodes.map(n => bounds(n.id)));
    host.current!.dataset.edgeRoutes = JSON.stringify(g.getEdgeData().map(e => ({ id: e.id, source: e.source, target: e.target, label: e.style?.labelText, sourceCardinality:e.style?.sourceCardinality,targetCardinality:e.style?.targetCardinality, curveOffset: e.style?.curveOffset, type: e.type })));
    host.current!.dataset.groupBounds = JSON.stringify(cb.current.rendered.groups.map(group => bounds(group.id)));
    cb.current.onState?.(camera.current);
    lens.current?.refresh();
    const w = host.current!.clientWidth, h = host.current!.clientHeight;
    setOffscreen(cb.current.rendered.nodes.filter(n => { const pt = g.getViewportByCanvas(g.getElementPosition(n.id)); return pt[0] < 0 || pt[0] > w || pt[1] < 0 || pt[1] > h; }).length);
  };
  const states = () => {
    const g = graph.current; if (!g || !ready.current || g.destroyed) return;
    const replay = cb.current.replayNodes;
    const replayIds = cb.current.rendered.nodes.filter(n => n.members.some(id => replay?.has(id)));
    if (host.current) { host.current.dataset.replayObserved = JSON.stringify(replayIds.map(n=>n.id)); host.current.dataset.replayErrors = JSON.stringify(replayIds.filter(n=>n.members.some(id=>replay?.get(id))).map(n=>n.id)); }
    void g.setElementState(Object.fromEntries(cb.current.rendered.nodes.map(n => [n.id, [...(cb.current.selected.has(n.id) ? ["selected"] : []), ...(focus.current === n.id ? ["focused"] : []), ...(n.members.some(id=>replay?.has(id)) ? [n.members.some(id=>replay?.get(id))?"replay-error":"replay-observed"] : [])]])), false);
  };
  const fit = async () => {
    const g = graph.current; if (!g || !ready.current) return;
    await g.fitView({ when: "always" }, false);
    // Fit must not make all labels unreadable: larger graphs remain pannable.
    if (g.getZoom() < .9 || g.getZoom() > 1) await g.zoomTo(Math.max(.9, Math.min(1, g.getZoom())), false);
    // The entry point of a large call graph must not disappear in a
    // label-preserving fit. Keep it visible and let the user pan downstream.
    const root = cb.current.rendered.nodes.find(n => !n.decorative);
    if (root) {
      const point = g.getViewportByCanvas(g.getElementPosition(root.id));
      const width = host.current?.clientWidth ?? 800, height = host.current?.clientHeight ?? 600;
      const [nodeWidth, nodeHeight] = g6NodeSize(root), halfWidth = nodeWidth * g.getZoom() / 2, halfHeight = nodeHeight * g.getZoom() / 2;
      if (point[0] < halfWidth + 16 || point[0] > width - halfWidth - 16 || point[1] < halfHeight + 52 || point[1] > height - halfHeight - 16)
        await g.translateBy([Math.min(width / 2, halfWidth + 32) - point[0], Math.min(height / 2, halfHeight + 70) - point[1]], false);
    }
    save();
  };
  useEffect(() => {
    const element = host.current!, container = surface.current!;
    const representation = p.rendered.nodes.map(n=>n.id).join("\n");
    const changedRepresentation = lastView.current === p.viewKey && lastRepresentation.current !== representation;
    lastRepresentation.current = representation;
    const restore = changedRepresentation ? undefined : p.initialState ? structuredClone(p.initialState) : lastView.current === p.viewKey ? structuredClone(camera.current) : undefined;
    lastView.current = p.viewKey;
    let live = true;
    ready.current = false; delete element.dataset.nodeCount; delete element.dataset.chartId; setStatus("Arranging graph…");
    registerG6Notation();
    const parallelIds = p.rendered.edges.filter(e=>!e.kind?.startsWith("er-")).map(e=>e.id);
    const layout = g6Layout(p.rendered, element.clientWidth, element.clientHeight, p.formId, p.chartId);
    const g = new Graph({ container, width: element.clientWidth, height: element.clientHeight, animation: false, padding: 48, zoomRange: [.15, 4],
      data: g6Data(p.rendered, !layout), layout,
      transforms: layout && parallelIds.length ? [{ type: "process-parallel-edges", mode: "bundle", distance: 90, edges: parallelIds }] : [],
      node: { type: datum => datum.data?.drawing ? "cie-drawing" : datum.data?.classCard ? "cie-class-card" : g6NodeType(String(datum.data?.role ?? "")), state: { selected: { stroke: "#38bdf8", lineWidth: 4 }, focused: { halo: true, haloStroke: "#fbbf24", haloLineWidth: 5 }, "replay-observed": { halo: true, haloStroke: "#38bdf8", haloLineWidth: 8 }, "replay-error": { halo: true, haloStroke: "#fb7185", haloLineWidth: 10 } } }, edge: { type: datum => String(datum.type ?? "polyline") }, combo: { type: "rect" },
      behaviors: [{ type: "drag-canvas", enable: () => !cb.current.boxSelect && !lens.current?.isActive() }], });
    graph.current = g;
    const scene = (): LensScene => {
      if (!ready.current || g.destroyed) return { nodes: [], edges: [] };
      const nodes = cb.current.rendered.nodes.filter(n => !n.decorative).map(n => { const pt = g.getViewportByCanvas(g.getElementPosition(n.id)), [width, height] = g6NodeSize(n); return { id: n.id, ref: n, label: n.label, x: pt[0], y: pt[1], width: width * g.getZoom(), height: height * g.getZoom(), color: chartColor(n.node?.file ?? n.label, n.role), shape: n.role === "c4-person" ? "ellipse" : "round-rectangle", displayMode: n.displayMode, selected: cb.current.selected.has(n.id), details: [n.role?.replace(/^(c4|uml)-/, "") ?? "", ...(n.node?.notes ?? []), ...(cb.current.overlayNodes?.get(n.id)?.notes ?? [])].filter(Boolean) }; });
      const points = new Map(nodes.map(n => [n.id, n]));
      const edges = cb.current.rendered.edges.flatMap(e => {
        const a = points.get(e.from), b = points.get(e.to); if (!a || !b) return [];
        const data = g.getEdgeData(e.id), controls = data.style?.controlPoints as number[][] | undefined;
        return [{ id: e.id, ref: e, from: e.from, to: e.to, label: [e.sourceLabel,e.label,e.targetLabel].filter(Boolean).join(" · "), ...g6LensNotation(e), points: [{ x: a.x, y: a.y }, ...(controls ?? []).map(pt => { const v = g.getViewportByCanvas([pt[0], pt[1]]); return { x: v[0], y: v[1] }; }), { x: b.x, y: b.y }] }];
      });
      return { nodes, edges };
    };
    const preview = attachFisheye(element, { blockWheelWhenActive: true, interactive: () => ready.current && !cb.current.boxSelect, scene,
      children: parent => { if(parent.ref?.kind!=="agg")return {nodes:[],edges:[]}; const members = new Set(parent.ref?.members); return { nodes: cb.current.lensDetails?.nodes.filter(n => members.has(n.id)) ?? [], edges: cb.current.lensDetails?.edges ?? [] }; },
      onNode: (n, toggle) => { if (n.ref) toggle ? cb.current.onToggleNode(n.ref) : cb.current.onTapNode(n.ref); }, onEdge: e => { if (e.ref) cb.current.onTapEdge(e.ref); },
      onChange: state => { camera.current.lens = state; setPaused(!state.enabled); save(); }, });
    lens.current = preview; preview.configure(camera.current.lens);
    for (const kind of ["node", "edge"] as const) {
      g.on(`${kind}:pointerover`, (event: IElementEvent) => {
        const rect = element.getBoundingClientRect();
        // G6 copies federated event fields; clientX/clientY prototype getters
        // are not retained, while the client point is.
        preview.hoverElement(kind, event.target.id, { x: event.client.x - rect.left, y: event.client.y - rect.top });
      });
      g.on(`${kind}:pointerout`, (event: IElementEvent) => preview.leaveElement(event.target.id));
    }
    g.on("node:click", (event: IElementEvent) => { if (cb.current.boxSelect) return; const n = cb.current.rendered.nodes.find(n => n.id === event.target.id); if (n) event.shiftKey || event.ctrlKey || event.metaKey ? cb.current.onToggleNode(n) : cb.current.onTapNode(n); });
    g.on("edge:click", (event: IElementEvent) => { const e = cb.current.rendered.edges.find(e => e.id === event.target.id); if (e && !cb.current.boxSelect) cb.current.onTapEdge(e); });
    g.on(GraphEvent.AFTER_TRANSFORM, save);
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); if (!ready.current || preview.isActive()) return;
      const rect = element.getBoundingClientRect(), delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      void g.zoomTo(Math.max(.15, Math.min(4, g.getZoom() * Math.exp(-Math.max(-240, Math.min(240, delta)) * .002))), false, [event.clientX - rect.left, event.clientY - rect.top]);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    const observer = new ResizeObserver(() => { if (ready.current && !g.destroyed) { g.resize(element.clientWidth, element.clientHeight); save(); } }); observer.observe(element);
    void g.render().then(async () => {
      if (!live) return;
      ready.current = true;
      if (restore) {
        await g.zoomTo(restore.zoom, false);
        const current = g.getViewportByCanvas([0, 0]); await g.translateBy([restore.pan.x - current[0], restore.pan.y - current[1]], false);
      } else await fit();
      if (!live) return;
      element.dataset.nodeCount = String(p.rendered.nodes.length); element.dataset.edgeCount = String(g.getEdgeData().length); element.dataset.chartId = p.chartId;
      const anchored = p.semanticLevels && focusMembers.current.length ? p.rendered.nodes.find(n=>n.members.some(id=>focusMembers.current.includes(id))) : undefined;
      if(anchored) { focus.current=anchored.id; await g.focusElement(anchored.id,false); }
      setStatus(""); states(); save();
    }).catch(error => { if (live) { setStatus("Graph rendering failed. Open the text outline to inspect the response."); console.error("[g6-render]", error); } });
    return () => { live = false; ready.current = false; observer.disconnect(); element.removeEventListener("wheel", wheel); preview.dispose(); lens.current = null; g.destroy(); graph.current = null; };
  }, [p.rendered, p.viewKey]);
  useEffect(states, [p.selected, p.replayNodes]);
  useEffect(() => { const g=graph.current;if(!g||!ready.current)return;g.updateNodeData(p.rendered.nodes.filter(n=>!n.decorative).map(n=>({id:n.id,style:{badge:!!p.overlayNodes?.get(n.id),badges:p.overlayNodes?.get(n.id)?[{text:p.overlayNodes.get(n.id)!.summary,placement:"bottom",fill:"#e5e7eb",backgroundFill:"#334155"}]:[]}})));void g.draw(); },[p.overlayNodes]);
  const fitTick = useRef(p.fitTick);
  useEffect(() => { if (fitTick.current !== p.fitTick) { fitTick.current = p.fitTick; void fit(); } }, [p.fitTick]);
  const setFocus = (id: string) => {
    focus.current = id; focusMembers.current = cb.current.rendered.nodes.find(n=>n.id===id)?.members ?? []; states(); const n = cb.current.rendered.nodes.find(n => n.id === id); if (n) cb.current.announce(describeNode(n, cb.current.rendered, cb.current.selected.has(id)));
  };
  const box = useRef<{ x: number; y: number } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  return <>
    <div className="canvas g6-canvas" ref={host} tabIndex={0} role="application" aria-label={`Map. ${p.caption}`} aria-describedby="canvas-help" aria-busy={!!status} data-layout-engine="g6" data-renderer="g6"
      onMouseDown={event => { host.current?.focus(); if (p.boxSelect) { const r = host.current!.getBoundingClientRect(); box.current = { x: event.clientX - r.left, y: event.clientY - r.top }; } }}
      onMouseMove={event => { if (box.current) { const r = host.current!.getBoundingClientRect(), x = event.clientX - r.left, y = event.clientY - r.top; setSelectionBox({ x: Math.min(x, box.current.x), y: Math.min(y, box.current.y), width: Math.abs(x - box.current.x), height: Math.abs(y - box.current.y) }); } }}
      onMouseUp={() => { if (selectionBox && graph.current) { const g = graph.current; p.onSelectNodes(p.rendered.nodes.filter(n => !n.decorative).filter(n => { const v = g.getViewportByCanvas(g.getElementPosition(n.id)); return v[0] >= selectionBox.x && v[0] <= selectionBox.x + selectionBox.width && v[1] >= selectionBox.y && v[1] <= selectionBox.y + selectionBox.height; }).map(n => n.id)); } box.current = null; setSelectionBox(null); }}
      onMouseLeave={() => { box.current = null; setSelectionBox(null); }}
      onKeyDown={event => {
        const g = graph.current; if (!g || !ready.current || event.ctrlKey || event.metaKey || event.altKey) return;
        const dirs: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
        const n = p.rendered.nodes.find(n => n.id === focus.current);
        if (dirs[event.key] || event.key === "Home" || event.key === "End") { event.preventDefault(); const items = p.rendered.nodes.filter(n => !n.decorative).map(n => { const q = g.getElementPosition(n.id); return { id: n.id, x: q[0], y: q[1] }; }); const id = event.key === "Home" ? items[0]?.id : event.key === "End" ? items.at(-1)?.id : nextByDirection(items, focus.current, dirs[event.key]); if (id) { setFocus(id); void g.focusElement(id, false); } }
        else if (event.key === "Enter" && n) { event.preventDefault(); p.onTapNode(n); }
        else if (event.key === " " && n) { event.preventDefault(); p.onToggleNode(n); }
        else if (event.key.toLowerCase() === "e" && n) { const pt = g.getViewportByCanvas(g.getElementPosition(n.id)); lens.current?.focus({ x: pt[0], y: pt[1] }); }
        else if (["+", "=", "-"].includes(event.key)) { event.preventDefault(); if (!lens.current?.isActive()) void g.zoomTo(Math.max(.15, Math.min(4, g.getZoom() * (event.key === "-" ? 1 / 1.15 : 1.15))), false); }
        else if (event.key.toLowerCase() === "o") p.onOpenOutline();
        else if (event.key === "Escape") p.onClear();
      }}>
      <div className="g6-surface" ref={surface} />
      {selectionBox && <div className="g6-selection" style={{ left: selectionBox.x, top: selectionBox.y, width: selectionBox.width, height: selectionBox.height }} />}
    </div>
    <div className="lens-controls" role="group" aria-label="Hover expansion"><button type="button" aria-pressed={paused} onClick={() => lens.current?.configure({ enabled: paused })}>{paused ? "Resume hover expansion" : "Pause hover expansion"}</button><span>Scroll: zoom · pause: expand · E: focused element · O: text outline</span></div>
    {(status || offscreen > 0) && <div className="canvas-hint" role="status">{status || `${offscreen} of ${p.rendered.nodes.length} elements off-screen`}{!status && <button type="button" onClick={() => void fit()}>Bring into view</button>}</div>}
  </>;
}
