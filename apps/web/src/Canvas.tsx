import cytoscape from "cytoscape";
import { useEffect, useRef } from "react";
import { describeNode, nextByDirection, nextLevel, zoomForLevel, type Dir, type RenderEdge, type RenderNode, type Rendered } from "./graph.ts";

interface Props {
  rendered: Rendered;
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
  onClear: () => void;
  onOpenOutline: () => void;
  announce: (text: string) => void;
}

const DWELL_MS = 250;
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function style(): cytoscape.StylesheetJson {
  const heatCool = css("--heat-cool"), heatHot = css("--heat-hot"), fact = css("--fact"), inf = css("--inference"), fog = css("--fog"), hyp = css("--hyp"), warn = css("--warn"), ok = css("--ok"), ink = css("--ink"), muted = css("--muted"), panel = css("--panel"), accent = css("--accent");
  return [
    { selector: "node", style: { label: "data(label)", "font-size": 11, color: ink, "text-valign": "center", "text-halign": "center", "text-wrap": "ellipsis", "text-max-width": "136px", width: 150, height: 28, shape: "round-rectangle", "background-color": panel, "border-width": 2, "border-color": fact } },
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
    { selector: "edge", style: { width: 2, "line-color": fact, "target-arrow-color": fact, "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 0.9, label: "data(label)", "font-size": 9, color: muted, "text-background-color": panel, "text-background-opacity": 1, "text-background-padding": "2px" } },
    { selector: "edge[display = 'INFERENCE']", style: { "line-style": "dashed", "line-color": inf, "target-arrow-color": inf, color: inf } },
    { selector: "edge[display = 'HYPOTHESIS']", style: { "line-style": "dotted", width: 3, "line-color": hyp, "target-arrow-color": hyp, color: hyp } },
    { selector: "edge[display = 'FOG']", style: { "line-style": "dotted", "line-color": fog, "target-arrow-color": fog } },
    { selector: "edge[kind = 'depends-on']", style: { "line-style": "dashed", "line-color": muted, "target-arrow-color": muted } },
    { selector: "edge[kind = 'raises']", style: { "line-color": warn, "target-arrow-color": warn, color: warn } },
    { selector: "edge[count > 1]", style: { width: "mapData(count, 2, 12, 3, 8)" } },
    { selector: "edge.stale", style: { opacity: 0.4 } },
    { selector: "node.kbfocus", style: { "overlay-color": accent, "overlay-opacity": 0.28, "overlay-padding": 9, "border-width": 4, "border-color": accent } },
    { selector: ":selected", style: { "overlay-color": accent, "overlay-opacity": 0.25, "overlay-padding": 6 } },
  ] as cytoscape.StylesheetJson;
}

/** Fit the whole map, but never smaller than readable: a very wide layout starts at a legible zoom at its left edge and is panned from there. */
const MIN_READABLE = 0.5;
function fitReadable(c: cytoscape.Core) {
  c.resize(); c.fit(undefined, 40);
  if (c.zoom() > 1.4) { c.zoom(1.4); c.center(); }
  else if (c.zoom() < MIN_READABLE) {
    const bb = c.elements().boundingBox();
    c.zoom(MIN_READABLE);
    c.pan({ x: 40 - bb.x1 * MIN_READABLE, y: Math.max(40, (c.height() - (bb.y2 - bb.y1) * MIN_READABLE) / 2) - bb.y1 * MIN_READABLE });
  }
}

export function Canvas(p: Props) {
  const host = useRef<HTMLDivElement>(null);
  const cy = useRef<cytoscape.Core | null>(null);
  const cb = useRef(p);
  cb.current = p;
  const syncing = useRef(false);
  const baseZoom = useRef(1);
  const levelRef = useRef(p.level);
  const lockZoom = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const lastViewKey = useRef("");
  const focusId = useRef<string | null>(null);

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
    // Semantic zoom: propose a level from the relative zoom, report it only once the zoom has settled.
    c.on("zoom", () => {
      if (lockZoom.current !== null) {
        if (Math.abs(c.zoom() - lockZoom.current) / lockZoom.current < 0.02) return;
        lockZoom.current = null; // the user moved the camera again; zoom drives the level once more
      }
      const rel = c.zoom() / baseZoom.current;
      const proposal = nextLevel(levelRef.current, rel);
      if (timer.current) window.clearTimeout(timer.current);
      if (proposal === levelRef.current) return;
      timer.current = window.setTimeout(() => {
        const again = nextLevel(levelRef.current, c.zoom() / baseZoom.current);
        if (again !== levelRef.current) { levelRef.current = again; cb.current.onZoomLevel(again); }
      }, DWELL_MS);
    });
    // The stage can be resized after mount (caption wraps, panels resize); keep cytoscape's measurements current.
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(host.current);
    return () => { ro.disconnect(); if (timer.current) window.clearTimeout(timer.current); c.destroy(); cy.current = null; };
  }, []);

  // A level chosen explicitly (stepper, chat) must not be undone by the next stray zoom event.
  useEffect(() => {
    if (levelRef.current !== p.level) { levelRef.current = p.level; if (cy.current) lockZoom.current = cy.current.zoom(); }
  }, [p.level]);

  // Rebuild elements when the rendering changes. The camera moves only for a new view; level changes and
  // verdicts keep it exactly where the user left it (cameraPolicy PRESERVE).
  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    const { rendered, level } = p;
    syncing.current = true;
    c.elements().remove();
    const els: cytoscape.ElementDefinition[] = [
      ...rendered.groups.map((g) => ({ data: { id: g.id, label: g.label, group: g.kind, parent: g.parent && rendered.groups.some((x) => x.id === g.parent) ? g.parent : undefined } })),
      ...rendered.nodes.map((n) => {
        const bd = n.node?.badge;
        const detail = level >= 6 && n.node ? `${n.label}\n${[n.role === "symbol" ? n.node.kind : n.role, n.node.notes?.length ? `${n.node.notes.length} note(s)` : "", n.node.unresolvedCalls ? `${n.node.unresolvedCalls} fog` : ""].filter(Boolean).join(" · ")}` : n.label;
        const labelText = bd && level < 6 ? `${n.label}\n${bd}` : detail;
        return { data: { id: n.id, label: labelText, hasBadge: bd ? 1 : 0, heatv: n.node?.heat ? n.node.heat.value : -1, ghost: n.node?.ghost ? 1 : 0, inTx: n.inTx ? 1 : 0, detail: level >= 6 ? 1 : 0, tier: n.tier, display: n.displayMode, role: n.role ?? "", kind: n.kind, parent: n.parent }, position: { ...n.pos }, classes: n.stale ? "stale" : "" };
      }),
      ...rendered.edges.map((e) => ({ data: { id: e.id, source: e.from, target: e.to, display: e.displayMode, kind: e.kind ?? "", label: level >= 5 || e.count > 1 ? e.label : "", count: e.count, ghost: e.ghost ? 1 : 0, ret: e.ret ? 1 : 0 }, classes: e.stale ? "stale" : "" })),
    ];
    c.add(els);
    if (p.viewKey !== lastViewKey.current) {
      lastViewKey.current = p.viewKey;
      fitReadable(c);
      baseZoom.current = c.zoom();
      lockZoom.current = null;
    }
    // Reapply selection to the fresh elements.
    c.batch(() => { for (const id of p.selected) c.getElementById(id).select(); });
    syncing.current = false;
  }, [p.rendered, p.viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { cy.current?.userPanningEnabled(!p.boxSelect); }, [p.boxSelect]);

  // An explicit level choice is a request to see that level: fit it, and re-anchor "relative zoom" so wheel zoom continues from here.
  const lastFit = useRef(p.fitTick);
  useEffect(() => {
    const c = cy.current;
    if (!c || p.fitTick === lastFit.current) return;
    lastFit.current = p.fitTick;
    fitReadable(c);
    lockZoom.current = c.zoom();
    baseZoom.current = c.zoom() / zoomForLevel(p.level);
  }, [p.fitTick, p.rendered]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    syncing.current = true;
    c.batch(() => { c.nodes().unselect(); for (const id of p.selected) c.getElementById(id).select(); });
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
    <div className="canvas" ref={host} tabIndex={0} role="application" aria-label={`Map. ${p.caption || "Empty."}`} aria-describedby="canvas-help" onKeyDown={onKeyDown}
      onFocus={() => { if (!focusId.current && cb.current.rendered.nodes.length) { const c = cy.current!; const first = [...cb.current.rendered.nodes].sort((a, b) => { const qa = c.getElementById(a.id).position(), qb = c.getElementById(b.id).position(); return qa.x - qb.x || qa.y - qb.y; })[0]; setFocus(first.id); } }} />
  );
}
