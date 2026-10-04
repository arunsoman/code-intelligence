import cytoscape from "cytoscape";
import { useEffect, useRef, useState } from "react";
import { describeNode, MAX_LEVEL, nextByDirection, viaToSegments, type Dir, type RenderEdge, type RenderNode, type Rendered } from "./graph.ts";
import type { OverlayMark } from "./mapoverlays.ts";
import { POLICY, fontPx, levelMove, panFor, pullInside, resolveAnchor, visibility, zoomAfterSwitch, type AnchorNode, type Move } from "./legibility.ts";
import "./zoom.css";

interface Props {
  rendered: Rendered;
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
  onExpand: (n: RenderNode) => void;
  /** A level proposed by a zoom gesture, reported only after the zoom has settled. */
  onZoomLevel: (level: number) => void;
  caption: string;
  /** Bumps when the level was chosen explicitly (stepper, chat); the camera then fits the new rendering. */
  fitTick: number;
  onToggleNode: (n: RenderNode) => void;
  onStepLevel: (delta: number) => void;
  /** True for forms whose levels change the content (the semantic map); the others keep one drawing and only hide labels that are too small to read. */
  semanticLevels: boolean;
  onClear: () => void;
  onOpenOutline: () => void;
  announce: (text: string) => void;
}

const DWELL_MS = 120; // short: labels must not stay unreadable while a switch waits (below the hard minimum it is immediate)
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function style(): cytoscape.StylesheetJson {
  const heatCool = css("--heat-cool"), heatHot = css("--heat-hot"), fact = css("--fact"), inf = css("--inference"), fog = css("--fog"), hyp = css("--hyp"), warn = css("--warn"), ok = css("--ok"), ink = css("--ink"), muted = css("--muted"), panel = css("--panel"), accent = css("--accent");
  return [
    { selector: "node", style: { label: "data(label)", "min-zoomed-font-size": POLICY.hardMinPx, "font-size": 11, color: ink, "text-valign": "center", "text-halign": "center", "text-wrap": "ellipsis", "text-max-width": "136px", width: 150, height: 28, shape: "round-rectangle", "background-color": panel, "border-width": 2, "border-color": fact } },
    { selector: "node[tier = 'CRITICAL']", style: { "border-width": 3, "font-weight": 700 } },
    { selector: "node[tier = 'CONTEXT']", style: { opacity: 0.8, "border-width": 1 } },
    { selector: "node[display = 'INFERENCE']", style: { "border-style": "dashed", "border-color": inf } },
    { selector: "node[display = 'HYPOTHESIS']", style: { "border-style": "dotted", "border-color": hyp, "border-width": 3 } },
    { selector: "node[display = 'FOG']", style: { "border-style": "double", "border-width": 4, "border-color": fog } },
    { selector: "node[role = 'failure-site']", style: { shape: "octagon", width: 170, height: 40, "background-color": panel, "border-color": warn } },
    { selector: "node[role = 'failure-site'][display = 'HYPOTHESIS']", style: { "border-color": hyp } },
    { selector: "node[role = 'symptom']", style: { shape: "hexagon", width: 190, height: 46, "border-width": 4, "border-color": warn, "font-weight": 700, "text-max-width": "170px" } },
    { selector: "node[role = 'state']", style: { shape: "barrel", width: 130, height: 44, "border-width": 4, "font-weight": 700 } },
    { selector: "node[kind = 'ext']", style: { shape: "tag", width: 150, height: 30, "border-style": "dashed", "border-color": muted, color: muted, "background-opacity": 0.5 } },
    { selector: "node[group = 'cluster']", style: { "border-style": "dashed", "border-width": 2, "border-color": inf, "background-color": inf, "background-opacity": 0.04, "font-size": 13, "font-weight": 700, color: inf, padding: "22px" } },
    // Heat: a value 0..1 tints the node from cool to hot (risk, attention, thin knowledge). The words explaining it are in the drawer.
    { selector: "node[heatv >= 0][kind = 'node']", style: { "background-color": `mapData(heatv, 0, 1, ${heatCool}, ${heatHot})` } as never },
    { selector: "node[hasBadge = 1][kind = 'node']", style: { height: 44, "text-wrap": "wrap", "font-size": 10 } },
    { selector: "node[ghost = 1]", style: { "border-style": "dashed", "border-color": hyp, opacity: 0.8, "background-opacity": 0.35 } },
    { selector: "node[inTx = 1]", style: { "border-style": "double", "border-width": 5 } },
    { selector: "node[role = 'gate'], node[role = 'policy']", style: { shape: "diamond", width: 150, height: 64, "text-max-width": "110px" } },
    { selector: "node[role = 'decision']", style: { shape: "diamond", width: 150, height: 54, "border-color": warn, "text-max-width": "110px" } },
    { selector: "node[role = 'hazard'], node[role = 'race'], node[role = 'unprotected'], node[role = 'consequence'], node[role = 'gap']", style: { shape: "octagon", width: 160, height: 44, "border-color": hyp, "border-width": 3, "border-style": "dashed" } },
    { selector: "node[role = 'event'], node[role = 'commit']", style: { shape: "ellipse", width: 190, height: 52, "text-max-width": "160px" } },
    { selector: "node[role = 'constraint']", style: { shape: "round-tag", width: 190, height: 52, "border-style": "dashed", "text-max-width": "160px" } },
    { selector: "node[role = 'test']", style: { shape: "cut-rectangle", "border-color": ok } },
    { selector: "node[role = 'behavior'], node[role = 'concept']", style: { shape: "round-rectangle", width: 200, height: 52, "border-width": 4, "font-weight": 700, "text-max-width": "180px" } },
    { selector: "node[role = 'external']", style: { shape: "tag" } },
    { selector: "node[group = 'lane']", style: { "border-style": "solid", "border-width": 1, "border-color": muted, "background-opacity": 0.05, "text-halign": "left", "text-valign": "top", "font-size": 12, "font-weight": 700, color: ink, padding: "26px" } },
    { selector: "node[group = 'region']", style: { "border-style": "solid", "border-width": 3, "border-color": ink, "background-opacity": 0.04, "font-size": 12, "font-weight": 700, color: ink, padding: "30px" } },
    { selector: "edge[ghost = 1]", style: { "line-style": "dashed", opacity: 0.6, "line-color": muted, "target-arrow-color": muted } },
    { selector: "edge[kind = 'escape route'], edge[kind = 'can reach'], edge[kind = 'interleaves'], edge[kind = 'may-explain'][display = 'HYPOTHESIS']", style: { "line-color": hyp, "target-arrow-color": hyp, color: hyp } },
    { selector: "edge[ret = 1]", style: { "curve-style": "unbundled-bezier", "control-point-distances": [-60], "control-point-weights": [0.5], "line-style": "dotted" } },
    { selector: "node[kind = 'agg']", style: { width: 190, height: 44, "border-width": 3, "font-weight": 700, "text-max-width": "170px", "background-color": panel } },
    { selector: "node[detail = 1][kind = 'node']", style: { height: 46, "text-wrap": "wrap", "font-size": 10 } },
    { selector: "node.stale", style: { opacity: 0.45, "border-style": "dotted", "border-color": muted } },
    { selector: ":parent", style: { "text-valign": "top", "text-halign": "center", "background-opacity": 0.06, "background-color": ink, "border-width": 1, "border-style": "solid", "border-color": muted, "font-size": 11, color: muted, padding: "14px", shape: "round-rectangle", "font-weight": 400 } },
    { selector: "node[group = 'concept']", style: { "border-style": "dashed", "border-color": inf, "background-color": inf, "background-opacity": 0.06, "font-size": 12 } },
    { selector: "edge", style: { "min-zoomed-font-size": POLICY.hardMinPx, width: 2, "line-color": fact, "target-arrow-color": fact, "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 0.9, label: "data(label)", "font-size": 9, color: muted, "text-background-color": panel, "text-background-opacity": 1, "text-background-padding": "2px" } },
    { selector: "edge[display = 'INFERENCE']", style: { "line-style": "dashed", "line-color": inf, "target-arrow-color": inf, color: inf } },
    { selector: "edge[display = 'HYPOTHESIS']", style: { "line-style": "dotted", width: 3, "line-color": hyp, "target-arrow-color": hyp, color: hyp } },
    { selector: "edge[display = 'FOG']", style: { "line-style": "dotted", "line-color": fog, "target-arrow-color": fog } },
    { selector: "edge[kind = 'depends-on']", style: { "line-style": "dashed", "line-color": muted, "target-arrow-color": muted } },
    { selector: "edge[kind = 'raises']", style: { "line-color": warn, "target-arrow-color": warn, color: warn } },
    { selector: "edge[count > 1]", style: { width: "mapData(count, 2, 12, 3, 8)" } },
    { selector: "edge.stale", style: { opacity: 0.4 } },
    { selector: "edge[ambient = 1]", style: { opacity: 0.14, width: 1, "target-arrow-shape": "none", label: "" } },
    { selector: "edge.focus", style: { opacity: 1, width: 2, "target-arrow-shape": "triangle" } },
    { selector: "node.kbfocus", style: { "overlay-color": accent, "overlay-opacity": 0.28, "overlay-padding": 9, "border-width": 4, "border-color": accent } },
    { selector: "node.replay-observed", style: { "underlay-color": accent, "underlay-opacity": 0.3, "underlay-padding": 10 } },
    { selector: "node.replay-error", style: { "underlay-color": warn, "underlay-opacity": 0.45, "underlay-padding": 12 } },
    { selector: "node", style: { "pie-size": "100%", "pie-1-background-color": muted, "pie-1-background-size": "data(testOverlaySize)", "pie-2-background-color": inf, "pie-2-background-size": "data(runtimeOverlaySize)" } },
    { selector: "node.test-overlay-failing", style: { "pie-1-background-color": warn } },
    { selector: "node.runtime-overlay-errors", style: { "pie-2-background-color": warn } },
    { selector: "node.test-overlay-covered", style: { "pie-1-background-color": ok } },
    { selector: "node.test-overlay-low", style: { "pie-1-background-color": inf } },
    { selector: "node.test-overlay-linked", style: { "pie-1-background-color": accent } },
    { selector: "node.runtime-overlay-observed", style: { "pie-2-background-color": accent } },
    { selector: ":selected", style: { "overlay-color": accent, "overlay-opacity": 0.25, "overlay-padding": 6 } },
  ] as cytoscape.StylesheetJson;
}

/** Ambient edges are faint until one of their ends is selected or has keyboard focus. */
function focusEdges(c: cytoscape.Core, focusId: string | null) {
  c.batch(() => {
    c.edges().removeClass("focus");
    const ends = c.nodes(":selected");
    ends.connectedEdges().addClass("focus");
    if (focusId) c.getElementById(focusId).connectedEdges().addClass("focus");
  });
}

/**
 * Fit the whole map, never larger than 1.4. It is never cropped: when the fit leaves labels too small to read, the caller moves to a coarser level
 * (new views), and below the hard minimum the labels are simply not drawn (Cytoscape `min-zoomed-font-size`), so the drawing is whole and honest.
 */
function fitReadable(c: cytoscape.Core) {
  c.resize(); c.fit(undefined, 40);
  if (c.zoom() > 1.4) { c.zoom(1.4); c.center(); }
}
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** What the camera was looking at when a level change was proposed, and what the change is. */
interface Pending { kind: "switch" | "fit"; move: Exclude<Move, "none">; ids: string[]; screen: { x: number; y: number } | null }

/** The thing the person was looking at: what is under the pointer (or near it), else the selection, else what is nearest the middle of the view. */
function captureAnchor(c: cytoscape.Core, rendered: Rendered, selected: Set<string>, pointer: { x: number; y: number } | null, focusId: string | null): { ids: string[]; screen: { x: number; y: number } } {
  const w = c.width(), h = c.height(), centre = { x: w / 2, y: h / 2 };
  const byId = new Map(rendered.nodes.map((n) => [n.id, n]));
  const nearest = (pt: { x: number; y: number }) => {
    let best: cytoscape.NodeSingular | null = null, dist = Infinity;
    c.nodes().forEach((n) => {
      if (n.isParent()) return;
      const b = n.renderedBoundingBox(), inside = pt.x >= b.x1 && pt.x <= b.x2 && pt.y >= b.y1 && pt.y <= b.y2;
      const d = inside ? 0 : Math.hypot(pt.x - (b.x1 + b.x2) / 2, pt.y - (b.y1 + b.y2) / 2);
      if (d < dist) { dist = d; best = n; }
    });
    return { node: best as cytoscape.NodeSingular | null, dist };
  };
  const preferred = [...(focusId ? [focusId] : []), ...selected].flatMap((id) => byId.get(id)?.members ?? []);
  const pt = pointer ?? centre;
  const under = nearest(pt);
  if (under.node && (pointer ? under.dist <= 80 : true) && byId.get(under.node.id())) {
    const ms = byId.get(under.node.id())!.members;
    return { ids: [...ms.filter((m) => preferred.includes(m)), ...ms.filter((m) => !preferred.includes(m))], screen: pt };
  }
  if (preferred.length) {
    const first = [...(focusId ? [focusId] : []), ...selected].map((id) => c.getElementById(id)).find((e) => !e.empty());
    const b = first?.renderedBoundingBox();
    return { ids: preferred, screen: b ? { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 } : pt };
  }
  const mid = nearest(centre);
  return { ids: mid.node ? byId.get(mid.node.id())?.members ?? [] : [], screen: centre };
}

export function Canvas(p: Props) {
  const host = useRef<HTMLDivElement>(null);
  const cy = useRef<cytoscape.Core | null>(null);
  const cb = useRef(p);
  cb.current = p;
  const syncing = useRef(false);
  const levelRef = useRef(p.level);
  const pending = useRef<Pending | null>(null);
  const animating = useRef(false);
  const programmatic = useRef(false); // true while the app itself moves the camera (a fit): those zoom events are not the person zooming
  const lastZoom = useRef(1);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [hint, setHint] = useState<{ off: number; total: number; labelsHidden: boolean }>({ off: 0, total: 0, labelsHidden: false });
  const lockZoom = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const lastViewKey = useRef("");
  const focusId = useRef<string | null>(null);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!host.current) return;
    const c = cytoscape({ container: host.current, style: style(), boxSelectionEnabled: true, wheelSensitivity: 0.25, minZoom: 0.05, maxZoom: 4 });
    cy.current = c;
    c.on("select unselect", "node", () => {
      if (syncing.current) return;
      cb.current.onSelectNodes(c.nodes(":selected").filter((n) => !n.isParent()).map((n) => n.id()));
    });
    c.on("tap", "node", (e) => { if (e.target.isParent()) return; const n = cb.current.rendered.nodes.find((x) => x.id === e.target.id()); if (n) cb.current.onTapNode(n); });
    c.on("dbltap", "node", (e) => { const n = cb.current.rendered.nodes.find((x) => x.id === e.target.id()); if (n) cb.current.onExpand(n); });
    c.on("tap", "edge", (e) => { const ed = cb.current.rendered.edges.find((x) => x.id === e.target.id()); if (ed) cb.current.onTapEdge(ed); });
    // What the person can see: how many elements are outside the viewport, and whether labels are too small to be drawn.
    let raf = 0;
    const refresh = () => {
      raf = 0;
      const boxes = c.nodes().filter((n) => !n.isParent()).map((n) => n.renderedBoundingBox());
      const v = visibility(boxes, c.width(), c.height());
      const labelsHidden = boxes.length > 0 && fontPx(c.zoom()) < POLICY.hardMinPx;
      setHint((h) => (h.off === v.offscreen && h.total === v.total && h.labelsHidden === labelsHidden ? h : { off: v.offscreen, total: v.total, labelsHidden }));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(refresh); };
    c.on("pan zoom resize", schedule);
    refreshRef.current = refresh;
    host.current.addEventListener("wheel", (e) => { const r = host.current!.getBoundingClientRect(); pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top }; }, { passive: true, capture: true });
    // Semantic zoom: the level changes when labels become unreadable (zooming out) or large (zooming in), not at a fixed relative zoom.
    // Zoom lock: a level chosen explicitly (stepper, fit) is not undone by the next stray zoom event.
    lastZoom.current = c.zoom();
    c.on("zoom", () => {
      const z = c.zoom(), moving = z < lastZoom.current ? "out" : "in";
      lastZoom.current = z;
      if (animating.current || programmatic.current || !cb.current.semanticLevels) return;
      if (lockZoom.current !== null) {
        if (Math.abs(z - lockZoom.current) / lockZoom.current < 0.02) return;
        lockZoom.current = null; // the user moved the camera again; zoom drives the level once more
      }
      if (timer.current) window.clearTimeout(timer.current);
      const move = levelMove(z, moving, levelRef.current, MAX_LEVEL);
      if (move === "none") return;
      const go = () => {
        const again = levelMove(c.zoom(), moving, levelRef.current, MAX_LEVEL);
        if (again === "none") return;
        pending.current = { kind: "switch", move: again, ...captureAnchor(c, cb.current.rendered, cb.current.selected, pointer.current, focusId.current) };
        levelRef.current += again === "coarser" ? -1 : 1;
        cb.current.onZoomLevel(levelRef.current);
      };
      if (move === "coarser" && fontPx(z) < POLICY.hardMinPx) go(); else timer.current = window.setTimeout(go, DWELL_MS);
    });
    // The stage can be resized after mount (caption wraps, panels resize); keep cytoscape's measurements current.
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(host.current);
    return () => { ro.disconnect(); if (timer.current) window.clearTimeout(timer.current); if (raf) cancelAnimationFrame(raf); c.destroy(); cy.current = null; };
  }, []);

  // A level chosen explicitly (stepper, chat) must not be undone by the next stray zoom event.
  useEffect(() => {
    if (levelRef.current !== p.level) { levelRef.current = p.level; if (cy.current) lockZoom.current = cy.current.zoom(); }
  }, [p.level]);

  /** Move the camera from code. The zoom events this causes are ignored by the level logic, so a fit cannot undo a level that was just chosen. */
  const quietly = (c: cytoscape.Core, fn: () => void) => {
    programmatic.current = true;
    try { fn(); } finally { lastZoom.current = c.zoom(); requestAnimationFrame(() => { programmatic.current = false; lastZoom.current = c.zoom(); }); }
  };

  /**
   * The elements have just been replaced by another level. Put the camera where the person was looking: the node that now stands for what was under
   * the pointer goes back to the same place on screen, at a zoom where labels are readable, and a drawing that fits is pulled fully into view.
   */
  const settleLevelChange = (c: cytoscape.Core, rendered: Rendered, pend: Pending) => {
    const w = c.width(), h = c.height(), pad = 40;
    const bb = c.elements().boundingBox();
    const zFit = bb.w > 0 && bb.h > 0 ? Math.min((w - 2 * pad) / bb.w, (h - 2 * pad) / bb.h) : 1;
    const z = zoomAfterSwitch(pend.move, zFit);
    const nodes: AnchorNode[] = rendered.nodes.map((n) => { const q = c.getElementById(n.id).position(); return { id: n.id, members: n.members, x: q.x, y: q.y }; });
    const anchor = resolveAnchor(pend.ids, nodes);
    const model = anchor ? { x: anchor.x, y: anchor.y } : { x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 };
    const screen = anchor && pend.screen ? pend.screen : { x: w / 2, y: h / 2 };
    let pan = panFor(model, screen, z);
    if (pend.move === "coarser") pan = pullInside(pan, bb, z, w, h);
    lockZoom.current = null;
    if (reduceMotion()) { quietly(c, () => c.viewport({ zoom: z, pan })); return; }
    animating.current = true;
    c.animate({ zoom: z, pan }, { duration: 160, complete: () => { animating.current = false; lastZoom.current = c.zoom(); refreshRef.current(); } });
  };

  /** "Bring into view": fit everything; labels that would be too small to read are then not drawn, and the outline keeps the names. */
  const bringIntoView = () => {
    const c = cy.current; if (!c) return;
    lockZoom.current = null;
    if (reduceMotion()) { quietly(c, () => fitReadable(c)); refreshRef.current(); return; }
    animating.current = true;
    c.animate({ fit: { eles: c.elements(), padding: 40 }, duration: 180, complete: () => { if (c.zoom() > 1.4) c.zoom(1.4); animating.current = false; lastZoom.current = c.zoom(); refreshRef.current(); } });
  };

  // Rebuild elements when the rendering changes. The camera moves only for a new view; level changes and
  // verdicts keep it exactly where the user left it (cameraPolicy PRESERVE).
  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    const { rendered, level } = p;
    syncing.current = true;
    c.elements().remove();
    const nodePos = new Map(rendered.nodes.map((n) => [n.id, n.pos]));
    const els: cytoscape.ElementDefinition[] = [
      ...rendered.groups.map((g) => ({ data: { id: g.id, label: g.label, group: g.kind, parent: g.parent && rendered.groups.some((x) => x.id === g.parent) ? g.parent : undefined } })),
      ...rendered.nodes.map((n) => {
        const bd = n.node?.badge;
        const detail = level >= 6 && n.node ? `${n.label}\n${[n.role === "symbol" ? n.node.kind : n.role, n.node.notes?.length ? `${n.node.notes.length} note(s)` : "", n.node.unresolvedCalls ? `${n.node.unresolvedCalls} fog` : ""].filter(Boolean).join(" · ")}` : n.label;
        const labelText = bd && level < 6 ? `${n.label}\n${bd}` : detail;
        return { data: { id: n.id, label: labelText, hasBadge: bd ? 1 : 0, heatv: n.node?.heat ? n.node.heat.value : -1, ghost: n.node?.ghost ? 1 : 0, inTx: n.inTx ? 1 : 0, detail: level >= 6 ? 1 : 0, tier: n.tier, display: n.displayMode, role: n.role ?? "", kind: n.kind, parent: n.parent }, position: { ...n.pos }, classes: n.stale ? "stale" : "" };
      }),
      ...rendered.edges.map((e) => {
        const at = (id: string) => nodePos.get(id);
        const a = at(e.from), b = at(e.to);
        const seg = e.via && a && b ? viaToSegments(a, b, e.via) : null;
        return { ...({ data: { id: e.id, source: e.from, target: e.to, display: e.displayMode, kind: e.kind ?? "", label: level >= 5 || e.count > 1 ? e.label : "", count: e.count, ghost: e.ghost ? 1 : 0, ret: e.ret ? 1 : 0, ambient: e.ambient ? 1 : 0 }, classes: e.stale ? "stale" : "" }), ...(seg ? { style: { "curve-style": "segments", "segment-weights": seg.weights, "segment-distances": seg.distances, "edge-distances": "node-position" } } : {}) };
      }),
    ];
    c.add(els);
    const pend = pending.current;
    if (pend && pend.kind === "switch") {
      pending.current = null;
      settleLevelChange(c, rendered, pend);
    } else if (p.viewKey !== lastViewKey.current || pend?.kind === "fit") {
      lastViewKey.current = p.viewKey;
      pending.current = null;
      quietly(c, () => fitReadable(c));
      lockZoom.current = null;
      // A new view starts at the finest level that fits with readable labels: if these are too small, try the next coarser level (the effect runs again).
      if (cb.current.semanticLevels && fontPx(c.zoom()) < POLICY.aggregateBelowPx && p.level > 0) {
        pending.current = { kind: "fit", move: "coarser", ids: [], screen: null };
        levelRef.current = p.level - 1;
        window.setTimeout(() => cb.current.onZoomLevel(p.level - 1), 0);
      }
    }
    // Reapply selection to the fresh elements.
    c.batch(() => { for (const id of p.selected) c.getElementById(id).select(); });
    focusEdges(c, focusId.current);
    syncing.current = false;
    refreshRef.current();
  }, [p.rendered, p.viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Replay decorates existing elements without moving the camera or changing provenance styles.
  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    c.batch(() => {
      c.nodes().removeClass("replay-observed replay-error");
      for (const n of p.rendered.nodes) {
        const hits = n.members.filter((id) => p.replayNodes?.has(id));
        if (hits.length) c.getElementById(n.id).addClass(hits.some((id) => p.replayNodes?.get(id)) ? "replay-observed replay-error" : "replay-observed");
      }
    });
  }, [p.replayNodes, p.rendered]);

  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    c.batch(() => {
      for (const n of p.rendered.nodes) {
        const el = c.getElementById(n.id);
        el.removeClass("test-overlay-failing test-overlay-covered test-overlay-low test-overlay-linked test-overlay-unknown runtime-overlay-errors runtime-overlay-observed runtime-overlay-unknown");
        const mark = p.overlayNodes?.get(n.id);
        el.data({ testOverlaySize: mark?.testSize ?? 0, runtimeOverlaySize: mark?.runtimeSize ?? 0 });
        if (mark) el.addClass(`test-overlay-${mark.test} runtime-overlay-${mark.runtime}`);
      }
    });
  }, [p.overlayNodes, p.rendered]);

  useEffect(() => {
    const refreshStyle = () => { cy.current?.style(style()); };
    const observer = new MutationObserver(refreshStyle);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-contrast"] });
    const theme = matchMedia("(prefers-color-scheme: dark)");
    theme.addEventListener("change", refreshStyle);
    return () => { observer.disconnect(); theme.removeEventListener("change", refreshStyle); };
  }, []);

  useEffect(() => { cy.current?.userPanningEnabled(!p.boxSelect); }, [p.boxSelect]);

  // An explicit level choice is a request to see that level: fit it, and re-anchor "relative zoom" so wheel zoom continues from here.
  const lastFit = useRef(p.fitTick);
  useEffect(() => {
    const c = cy.current;
    if (!c || p.fitTick === lastFit.current) return;
    lastFit.current = p.fitTick;
    quietly(c, () => fitReadable(c));
    lockZoom.current = c.zoom();
    refreshRef.current();
  }, [p.fitTick, p.rendered]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    syncing.current = true;
    c.batch(() => { c.nodes().unselect(); for (const id of p.selected) c.getElementById(id).select(); });
    focusEdges(c, focusId.current);
    syncing.current = false;
  }, [p.selected]);

  const setFocus = (id: string | null, say = true) => {
    const c = cy.current; if (!c) return;
    c.nodes().removeClass("kbfocus");
    focusId.current = id;
    if (!id) return;
    const el = c.getElementById(id);
    if (el.empty()) { focusId.current = null; return; }
    el.addClass("kbfocus");
    focusEdges(c, id);
    // A keyboard move is the user asking to look there: pan only if the node is off screen, never change zoom.
    const bb = el.renderedBoundingBox(), w = c.width(), h = c.height();
    if (bb.x1 < 0 || bb.y1 < 0 || bb.x2 > w || bb.y2 > h) c.center(el);
    const n = cb.current.rendered.nodes.find((x) => x.id === id);
    if (n && say) cb.current.announce(describeNode(n, cb.current.rendered, cb.current.selected.has(id)));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const c = cy.current; if (!c || e.altKey || e.ctrlKey || e.metaKey) return;
    const nodes = cb.current.rendered.nodes;
    const dirs: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    const cur = nodes.find((n) => n.id === focusId.current) ?? null;
    if (dirs[e.key]) {
      e.preventDefault();
      const items = nodes.map((n) => { const q = c.getElementById(n.id).position(); return { id: n.id, x: q.x, y: q.y }; });
      const next = nextByDirection(items, focusId.current, dirs[e.key]);
      if (next) setFocus(next); else if (focusId.current) cb.current.announce("No element further in that direction");
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const sorted = nodes.map((n) => { const q = c.getElementById(n.id).position(); return { id: n.id, x: q.x, y: q.y }; }).sort((a, b) => a.x - b.x || a.y - b.y);
      if (sorted.length) setFocus(e.key === "Home" ? sorted[0].id : sorted[sorted.length - 1].id);
    } else if (e.key === "Enter" && cur) { e.preventDefault(); cb.current.onTapNode(cur); }
    else if (e.key === " " && cur) { e.preventDefault(); cb.current.onToggleNode(cur); }
    else if ((e.key === "e" || e.key === "E") && cur) { e.preventDefault(); cb.current.onExpand(cur); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); cb.current.onStepLevel(1); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); cb.current.onStepLevel(-1); }
    else if (e.key === "Escape") { cb.current.onClear(); cb.current.announce("Selection cleared"); }
    else if (e.key === "o" || e.key === "O") { e.preventDefault(); cb.current.onOpenOutline(); }
  };

  // Keep the focus ring on the same element across re-renders (verdicts, level changes); drop it if the element is gone.
  useEffect(() => { if (focusId.current) setFocus(focusId.current, false); }, [p.rendered]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
    <div className="canvas" ref={host} tabIndex={0} role="application" aria-label={`Map. ${p.caption || "Empty."}`} aria-describedby="canvas-help" onKeyDown={onKeyDown}
      onFocus={() => { if (!focusId.current && cb.current.rendered.nodes.length) { const c = cy.current!; const first = [...cb.current.rendered.nodes].sort((a, b) => { const qa = c.getElementById(a.id).position(), qb = c.getElementById(b.id).position(); return qa.x - qb.x || qa.y - qb.y; })[0]; setFocus(first.id); } }} />
    {(hint.off > 0 || hint.labelsHidden) && (
      <div className="canvas-hint" role="status">
        {hint.off > 0 && <span>{hint.off} of {hint.total} element{hint.total === 1 ? "" : "s"} off-screen <button type="button" className="tool" onClick={bringIntoView}>Bring into view</button></span>}
        {hint.labelsHidden && <span>Labels are hidden at this zoom: zoom in, or open the text outline (O).</span>}
      </div>
    )}
    </>
  );
}
