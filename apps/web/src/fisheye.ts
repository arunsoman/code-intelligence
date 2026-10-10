import type { RenderEdge, RenderNode } from "./graph.ts";

export interface Point { x: number; y: number }
export interface LensState {
  enabled: boolean; magnification: number; radius: number; falloff: number;
  easing: boolean; rings: boolean; pinned: boolean;
}
export const LENS_DEFAULTS: LensState = { enabled: true, magnification: 2.2, radius: 186.56, falloff: 1 / .88, easing: true, rings: true, pinned: false };
export const CHART_THEME = { background: "#0b0f17", panel: "#111827", text: "#e5e7eb", muted: "#94a3b8", accent: "#38bdf8" };
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Automatic sizing: 70% of the shorter side, capped at 520px diameter. */
export function automaticLensGeometry(width: number, height: number) {
  const short = Math.max(0, Math.min(width, height));
  const outer = Math.max(0, Math.min(short * .35, 260, (short - 16) / 2));
  return { outer, inner: outer * .88 };
}
export function boundedLensCentre(point: Point, width: number, height: number, radius: number): Point {
  return { x: clamp(point.x, radius + 8, Math.max(radius + 8, width - radius - 8)),
    y: clamp(point.y, radius + 8, Math.max(radius + 8, height - radius - 8)) };
}
function childGrid(radius: number) {
  const side = Math.max(1, radius * Math.SQRT2 - 16);
  const columns = side >= 220 ? 2 : 1;
  const rows = Math.max(1, Math.floor(side / 64));
  return { side, columns, rows, capacity: columns * rows };
}

/** Bounded radial lens: the boundary and everything outside it stay fixed.
 * Unlike an integrated magnification profile, it does not displace the periphery.
 */
export function projectLens(point: Point, centre: Point, magnification: number, radius: number): Point {
  const dx = point.x - centre.x, dy = point.y - centre.y, distance = Math.hypot(dx, dy);
  if (radius <= 0 || distance >= radius || magnification === 1) return { ...point };
  const m = clamp(magnification, 0.35, 4);
  const scale = radius * m / (radius + (m - 1) * distance);
  return { x: centre.x + dx * scale, y: centre.y + dy * scale };
}
export function invertLens(point: Point, centre: Point, magnification: number, radius: number): Point {
  const dx = point.x - centre.x, dy = point.y - centre.y, distance = Math.hypot(dx, dy);
  if (radius <= 0 || distance >= radius || magnification === 1) return { ...point };
  const m = clamp(magnification, 0.35, 4), scale = radius / (m * radius - (m - 1) * distance);
  return { x: centre.x + dx * scale, y: centre.y + dy * scale };
}

export function chartColor(file = "", kind = ""): string {
  if (/apps\/|frontend|web|tsx/.test(file + kind)) return "#a78bfa";
  if (/\.rs$|crates\/|rust/.test(file + kind)) return "#fbbf24";
  if (/schema/.test(file + kind)) return "#fb7185";
  if (/model|ollama/.test(file + kind)) return "#2dd4bf";
  if (/cache|store|external/.test(file + kind)) return "#94a3b8";
  return "#60a5fa";
}
export function chartFill(color: string): string {
  const base = [11, 15, 23], rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  return `rgb(${rgb.map((v, i) => Math.round(v * 0.15 + base[i] * 0.85)).join(",")})`;
}
export interface LensNode extends Point {
  id: string; label: string; width: number; height: number; color: string;
  details?: string[]; shape?: string; selected?: boolean; focused?: boolean;
  displayMode?: string; group?: boolean; ref?: RenderNode; element?: Element;
  movable?: boolean; compact?: boolean;
}
export interface LensEdge { id: string; from: string; to: string; points: Point[]; color: string; label?: string; dashed?: boolean; sourceArrow?: string; targetArrow?: string; arrowFill?: string; sourceArrowFill?: string; lineStyle?: string; ref?: RenderEdge }
export interface LensScene { nodes: LensNode[]; edges: LensEdge[] }
export interface Box extends Point { width: number; height: number }
const contains = (box: Box, p: Point) => Math.abs(p.x - box.x) <= box.width / 2 && Math.abs(p.y - box.y) <= box.height / 2;

/** Display-only relaxation. Fixed/context boxes never move and source items are not changed. */
export function relaxLensNodes(nodes: LensNode[], centre: Point, radius: number): LensNode[] {
  const result = nodes.map((n) => ({ ...n }));
  const near = result.filter((n) => n.movable || !n.compact && Math.hypot(n.x - centre.x, n.y - centre.y) < radius + Math.hypot(n.width, n.height) / 2);
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
      const a = near[i], b = near[j]; if ((!a.movable && !b.movable) || a.group || b.group) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const ox = (a.width + b.width) / 2 + 10 - Math.abs(dx), oy = (a.height + b.height) / 2 + 10 - Math.abs(dy);
      if (ox <= 0 || oy <= 0) continue;
      const fraction = a.movable && b.movable ? .5 : 1;
      if (ox < oy) { const push = Math.sign(dx || (i % 2 ? -1 : 1)) * ox * fraction; if (a.movable) a.x -= push; if (b.movable) b.x += push; }
      else { const push = Math.sign(dy || (j % 2 ? -1 : 1)) * oy * fraction; if (a.movable) a.y -= push; if (b.movable) b.y += push; }
    }
    for (const n of result) if (n.movable) {
      const d = Math.hypot(n.x - centre.x, n.y - centre.y), limit = Math.max(0, radius - Math.min(radius / 2, Math.hypot(n.width, n.height) / 2));
      if (d > limit && d) { n.x = centre.x + (n.x - centre.x) * limit / d; n.y = centre.y + (n.y - centre.y) * limit / d; }
    }
  }
  return result;
}

/** Portions of a line outside all node boxes. This clips endpoints and intervening boxes. */
export function clipLink(a: Point, b: Point, boxes: Box[], gap = 3): [Point, Point][] {
  const dx = b.x - a.x, dy = b.y - a.y;
  let intervals: [number, number][] = [[0, 1]];
  for (const box of boxes) {
    const x1 = box.x - box.width / 2 - gap, x2 = box.x + box.width / 2 + gap;
    const y1 = box.y - box.height / 2 - gap, y2 = box.y + box.height / 2 + gap;
    let lo = 0, hi = 1, misses = false;
    for (const [start, delta, min, max] of [[a.x, dx, x1, x2], [a.y, dy, y1, y2]]) {
      if (Math.abs(delta) < 1e-8) { if (start < min || start > max) { misses = true; break; } }
      else { const p = (min - start) / delta, q = (max - start) / delta; lo = Math.max(lo, Math.min(p, q)); hi = Math.min(hi, Math.max(p, q)); }
    }
    if (misses || lo >= hi) continue;
    intervals = intervals.flatMap(([l, h]) => hi <= l || lo >= h ? [[l, h] as [number, number]] : [
      ...(lo > l ? [[l, lo] as [number, number]] : []), ...(hi < h ? [[hi, h] as [number, number]] : []),
    ]);
  }
  return intervals.filter(([l, h]) => h - l > 1e-6).map(([l, h]) => [{ x: a.x + dx * l, y: a.y + dy * l }, { x: a.x + dx * h, y: a.y + dy * h }]);
}

/** Expand only a focused aggregate in screen space. Source graph/layout are immutable. */
export function localChildren(parent: LensNode, children: RenderNode[], edges: RenderEdge[], centre: Point, radius: number, page = 0): LensScene {
  const grid = childGrid(radius), capacity = grid.capacity;
  const shown = children.slice(page * capacity, (page + 1) * capacity);
  const columns = Math.max(1, Math.min(grid.columns, shown.length)), rows = Math.ceil(shown.length / columns);
  const width = Math.min(180, (grid.side - (columns - 1) * 12) / columns), stepY = 64;
  const nodes: LensNode[] = shown.map((n, index) => ({
    id: n.id, ref: n, label: n.label, details: [n.node?.kind ?? n.role ?? "", ...(n.node?.notes ?? [])].filter(Boolean),
    color: chartColor(n.node?.file ?? parent.ref?.node?.file, n.role), displayMode: n.displayMode,
    x: centre.x + ((index % columns) - (columns - 1) / 2) * (width + 12),
    y: centre.y + (Math.floor(index / columns) - (rows - 1) / 2) * stepY, width, height: 46,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return { nodes, edges: edges.filter((e) => byId.has(e.from) && byId.has(e.to)).map((e) => ({
    id: e.id, from: e.from, to: e.to, color: CHART_THEME.accent, label: e.label, ref: e,
    dashed: e.displayMode !== "FACT", points: [byId.get(e.from)!, byId.get(e.to)!],
  })) };
}

export type PreviewCapture = { kind: "node"; node: LensNode; children: RenderNode[]; edges: RenderEdge[] }
  | { kind: "edge"; edge: LensEdge; source?: LensNode; target?: LensNode };
/** Isolated screen-space preview. It never reads or projects unrelated chart elements. */
export function focusedPreview(capture: PreviewCapture, centre: Point, radius: number, page = 0): LensScene {
  if (capture.kind === "node") {
    if (capture.children.length) return localChildren(capture.node, capture.children, capture.edges, centre, radius, page);
    const details = (capture.node.details ?? []).slice(0, Math.max(1, Math.min(12, Math.floor((radius * 1.3 - 32) / 16))));
    return { nodes: [{ ...capture.node, ...centre, width: radius * 1.45, height: Math.min(radius * 1.3, Math.max(48, 32 + details.length * 16)), details: details.length ? details : ["No deeper detail available"], focused: true }], edges: [] };
  }
  const width = Math.max(1, radius * .72), gap = Math.min(20, radius * .12);
  const node = (original: LensNode | undefined, id: string, offset: number): LensNode => ({
    ...(original ?? { id, label: "Endpoint unavailable", color: CHART_THEME.muted }),
    x: centre.x + offset, y: centre.y, width, height: Math.min(48, radius * .5), details: [], focused: true,
  });
  const a = node(capture.source, capture.edge.from, -(width + gap) / 2), b = node(capture.target, capture.edge.to, (width + gap) / 2);
  // Duplicate endpoint identity on a self edge still needs two distinct preview boxes.
  if (a.id === b.id) b.id = `${b.id}:preview-target`;
  return { nodes: [a, b], edges: [{ ...capture.edge, from: a.id, to: b.id, points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] }] };
}

export interface LensOptions {
  scene: () => LensScene;
  children?: (parent: LensNode) => { nodes: RenderNode[]; edges: RenderEdge[] };
  onNode?: (node: LensNode, toggle: boolean) => void;
  onEdge?: (edge: LensEdge) => void;
  onChange?: (state: LensState) => void;
  controls?: boolean;
  interactive?: () => boolean;
}
export interface LensEngine {
  configure: (patch: Partial<LensState>) => void; focus: (point: Point) => void;
  refresh: () => void; nextPage: (delta: number) => void; dispose: () => void;
}

/** A chart-independent display layer; adapters supply screen geometry and evidence-bearing objects. */
export function attachFisheye(host: HTMLElement, options: LensOptions): LensEngine {
  const canvas = document.createElement("canvas"); canvas.className = "fisheye-surface";
  canvas.setAttribute("aria-hidden", "true"); host.append(canvas);
  const ctx = canvas.getContext("2d")!;
  const state = { ...LENS_DEFAULTS, easing: !matchMedia("(prefers-reduced-motion: reduce)").matches };
  const controls = options.controls ? document.createElement("div") : null;
  if (controls) {
    controls.className = "lens-controls";
    controls.setAttribute("role", "group"); controls.setAttribute("aria-label", "Hover expansion");
    controls.innerHTML = '<button type="button" aria-pressed="false">Pause hover expansion</button>';
    controls.querySelector("button")!.onclick = () => { clearHover(); state.enabled = !state.enabled; if (!state.enabled) active = false; notify(); };
    host.append(controls);
  }
  let target: Point = { x: 0, y: 0 }, centre = { ...target }, mouse = { ...target }, active = false;
  let currentM = state.magnification, raf = 0, last = 0, disposed = false, page = 0, expandedId = "", lastFocusedId = "";
  let drawnNodes: LensNode[] = [], drawnEdges: LensEdge[] = [];
  let hoverTimer: ReturnType<typeof setTimeout> | undefined, hoverId = "";
  let anchor: Point = { x: 0, y: 0 };
  let captured: PreviewCapture | undefined;
  const clearHover = () => { clearTimeout(hoverTimer); hoverTimer = undefined; hoverId = ""; };
  const geometry = () => { const g = automaticLensGeometry(host.clientWidth, host.clientHeight); state.radius = g.inner; state.falloff = 1 / .88; return g; };
  const position = (e: MouseEvent) => { const b = host.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  const notify = () => {
    if (controls) {
      const button = controls.querySelector("button")!;
      button.textContent = state.enabled ? "Pause hover expansion" : "Resume hover expansion";
      button.setAttribute("aria-pressed", String(!state.enabled));
    }
    options.onChange?.({ ...state }); schedule();
  };
  const publish = () => {
    host.dataset.lensEnabled = String(state.enabled); host.dataset.lensMagnification = String(state.magnification);
    host.dataset.lensExpanded = expandedId; host.dataset.lensChildren = String(drawnNodes.filter((n) => n.focused).length);
    host.dataset.lensRadius = String(state.radius); host.dataset.lensOuterRadius = String(state.radius * state.falloff);
    host.dataset.lensTarget = captured?.kind === "node" ? captured.node.id : captured?.edge.id ?? "";
    host.dataset.lensX = String(centre.x); host.dataset.lensY = String(centre.y); host.dataset.lensActive = String(active && state.enabled);
    host.dataset.lensPage = String(page); host.dataset.lensPinned = String(state.pinned);
  };
  function schedule() { if (!raf && !disposed) raf = requestAnimationFrame(paint); }
  function paint(now: number) {
    raf = 0; const dt = Math.min(0.05, (now - (last || now - 16)) / 1000); last = now;
    const k = state.easing ? 1 - Math.exp(-dt * 16) : 1;
    centre.x += (target.x - centre.x) * k; centre.y += (target.y - centre.y) * k;
    const wanted = LENS_DEFAULTS.magnification;
    currentM += (wanted - currentM) * k;
    const w = host.clientWidth, h = host.clientHeight, dpr = devicePixelRatio || 1;
    geometry(); target = boundedLensCentre(target, w, h, state.radius * state.falloff);
    if (!state.easing) centre = { ...target };
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    drawnNodes = []; drawnEdges = []; expandedId = "";
    if (!active || !state.enabled || options.interactive?.() === false || state.radius <= 0) { publish(); return; }
    const radius = state.radius * state.falloff;
    if (!captured) { active = false; publish(); return; }
    const title = captured.kind === "node" ? captured.node.label : captured.edge.label ?? "Relationship";
    const detail = captured.kind === "node" && captured.children.length ? captured : undefined;
    if (detail) page = Math.min(page, Math.ceil(detail.children.length / childGrid(state.radius).capacity) - 1);
    const preview = focusedPreview(captured, centre, state.radius, page);
    drawnNodes = preview.nodes; drawnEdges = preview.edges;
    if (detail) expandedId = detail.node.id;
    ctx.save(); ctx.beginPath(); ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = CHART_THEME.background; ctx.fillRect(centre.x - radius, centre.y - radius, radius * 2, radius * 2);
    const visibleNodes = drawnNodes.filter((n) => Math.hypot(n.x - centre.x, n.y - centre.y) < radius + Math.hypot(n.width, n.height) / 2);
    const boxes = visibleNodes.filter((n) => !n.group);
    for (const edge of drawnEdges) {
      ctx.strokeStyle = edge.color; ctx.lineWidth = 1.5; ctx.setLineDash(edge.lineStyle === "dotted" ? [1, 3] : edge.dashed ? [5, 4] : []);
      ctx.beginPath(); let firstSegment: [Point, Point] | undefined, lastSegment: [Point, Point] | undefined;
      for (let i = 1; i < edge.points.length; i++) for (const segment of clipLink(edge.points[i - 1], edge.points[i], boxes)) { ctx.moveTo(segment[0].x, segment[0].y); ctx.lineTo(segment[1].x, segment[1].y); firstSegment ??= segment; lastSegment = segment; }
      ctx.stroke(); ctx.setLineDash([]);
      if (firstSegment && edge.sourceArrow && edge.sourceArrow !== "none") arrow(firstSegment[1], firstSegment[0], edge.sourceArrow, edge.color, edge.sourceArrowFill ?? edge.arrowFill);
      if (lastSegment && edge.targetArrow !== "none") arrow(lastSegment[0], lastSegment[1], edge.targetArrow ?? "triangle", edge.color, edge.arrowFill);
      if (edge.label && edge.points.length > 1) {
        const mid = edge.points[Math.floor(edge.points.length / 2)];
        if (!boxes.some((box) => contains(box, mid))) {
          ctx.font = "10px system-ui"; ctx.textAlign = "center";
          const labelWidth = Math.min(160, ctx.measureText(edge.label).width + 8);
          ctx.fillStyle = CHART_THEME.background; ctx.fillRect(mid.x - labelWidth / 2, mid.y - 9, labelWidth, 15);
          ctx.fillStyle = CHART_THEME.muted; ctx.fillText(edge.label, mid.x, mid.y + 2, labelWidth - 8);
        }
      }
    }
    for (const node of visibleNodes.filter((n) => !n.focused)) drawNode(node);
    for (const node of visibleNodes.filter((n) => n.focused)) drawNode(node);
    ctx.fillStyle = CHART_THEME.muted; ctx.font = "11px system-ui"; ctx.textAlign = "center";
    ctx.fillText(`Focused: ${title}`, centre.x, centre.y - radius + 18, state.radius * 1.6);
    if (detail) ctx.fillText(`${drawnNodes.length} of ${detail.children.length} · [ / ] pages`, centre.x, centre.y + radius - 18);
    ctx.restore();
    if (state.rings) { ctx.strokeStyle = "rgba(56,189,248,.35)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(centre.x, centre.y, state.radius, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([6, 7]); ctx.strokeStyle = "rgba(148,163,184,.4)"; ctx.beginPath(); ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    publish();
    if (state.easing && (Math.hypot(target.x - centre.x, target.y - centre.y) > .2 || Math.abs(currentM - wanted) > .005)) schedule();
  }
  function arrow(a: Point, b: Point, shape: string, color: string, fill = "filled") {
    ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(Math.atan2(b.y - a.y, b.x - a.x));
    ctx.beginPath(); ctx.moveTo(0, 0);
    if (shape === "diamond") { ctx.lineTo(-6, -4); ctx.lineTo(-12, 0); ctx.lineTo(-6, 4); }
    else if (shape === "tee") { ctx.moveTo(0, -5); ctx.lineTo(0, 5); }
    else { ctx.lineTo(-8, -4); ctx.lineTo(-8, 4); }
    if (shape !== "tee") { ctx.closePath(); ctx.fillStyle = fill === "hollow" ? CHART_THEME.background : color; ctx.fill(); }
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.stroke(); ctx.restore();
  }
  function drawNode(node: LensNode) {
    const x = node.x - node.width / 2, y = node.y - node.height / 2;
    ctx.save(); ctx.shadowColor = node.color; ctx.shadowBlur = node.focused || node.selected ? 16 : 4;
    ctx.beginPath();
    if (node.shape === "ellipse" || node.shape === "barrel") ctx.ellipse(node.x, node.y, node.width / 2, node.height / 2, 0, 0, Math.PI * 2);
    else if (node.shape === "diamond") { ctx.moveTo(node.x, y); ctx.lineTo(x + node.width, node.y); ctx.lineTo(node.x, y + node.height); ctx.lineTo(x, node.y); ctx.closePath(); }
    else ctx.roundRect(x, y, node.width, node.height, 8);
    ctx.fillStyle = chartFill(node.color); ctx.fill(); ctx.shadowBlur = 0;
    ctx.strokeStyle = node.color; ctx.lineWidth = node.selected ? 3 : 1.5;
    if (node.displayMode && node.displayMode !== "FACT") ctx.setLineDash(node.displayMode === "HYPOTHESIS" ? [2, 4] : [6, 4]);
    ctx.stroke(); ctx.setLineDash([]); ctx.beginPath(); ctx.rect(x + 5, y + 2, node.width - 10, node.height - 4); ctx.clip();
    ctx.fillStyle = CHART_THEME.text; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const font = node.focused ? 15 : 13; ctx.font = `600 ${font}px system-ui`;
    const fitText = (text: string) => {
      if (ctx.measureText(text).width <= node.width - 18) return text;
      let shortened = text;
      while (shortened.length && ctx.measureText(shortened + "…").width > node.width - 18) shortened = shortened.slice(0, -1);
      return shortened + "…";
    };
    ctx.fillText(fitText(node.label), node.x, node.details?.length ? y + 17 : node.y);
    if (node.details?.length) {
      ctx.font = "11px ui-monospace,monospace"; ctx.fillStyle = node.color;
      for (let i = 0; i < node.details.length; i++) ctx.fillText(fitText(node.details[i]), node.x, y + 38 + i * 16);
    }
    ctx.restore();
  }
  const hit = (point: Point) => [...drawnNodes].reverse().find((n) => !n.group && contains(n, point));
  const ignored = (e: Event) => !!(e.target as Element)?.closest?.(".lens-controls, input, textarea, select, button:not(.mcell), a, [contenteditable=true]") || options.interactive?.() === false;
  const sourceHit = (point: Point) => {
    const scene = options.scene();
    const node = scene.nodes.filter((n) => !n.group && contains(n, point)).sort((a, b) => a.width * a.height - b.width * b.height)[0];
    if (node) return { id: node.id, point: { x: node.x, y: node.y }, node: true };
    const edge = edgeHit(scene.edges, point);
    return edge ? { id: edge.id, point, node: false } : undefined;
  };
  const activate = (point: Point, nodeId = "", edgeId = "") => {
    clearHover(); geometry();
    const scene = options.scene();
    const node = scene.nodes.find((n) => n.id === nodeId);
    const edge = scene.edges.find((e) => e.id === edgeId);
    const copyNode = (n: LensNode | undefined) => n ? { ...n, details: [...(n.details ?? [])] } : undefined;
    if (node) {
      const children = options.children?.(node);
      captured = { kind: "node", node: { ...node, details: [...(node.details ?? [])] }, children: (children?.nodes ?? []).map((n) => ({ ...n, members: [...n.members] })), edges: (children?.edges ?? []).map((e) => ({ ...e })) };
    } else if (edge) captured = { kind: "edge", edge: { ...edge, points: edge.points.map((p) => ({ ...p })) }, source: copyNode(scene.nodes.find((n) => n.id === edge.from)), target: copyNode(scene.nodes.find((n) => n.id === edge.to)) };
    else { captured = undefined; active = false; schedule(); return; }
    anchor = { ...point }; lastFocusedId = nodeId; page = 0;
    target = boundedLensCentre(point, host.clientWidth, host.clientHeight, state.radius * state.falloff);
    centre = { ...target }; active = true; schedule();
  };
  const move = (e: PointerEvent) => {
    if (ignored(e) || !state.enabled) { clearHover(); return; }
    mouse = position(e);
    if (active) {
      const sourceNode = captured?.kind === "node" ? captured.node : undefined;
      // Keep a small corridor from an edge-clamped source to its expanded content.
      const dx = centre.x - anchor.x, dy = centre.y - anchor.y, length = dx * dx + dy * dy;
      const t = length ? clamp(((mouse.x - anchor.x) * dx + (mouse.y - anchor.y) * dy) / length, 0, 1) : 0;
      const corridor = Math.hypot(mouse.x - anchor.x - t * dx, mouse.y - anchor.y - t * dy) <= 20;
      if (Math.hypot(mouse.x - centre.x, mouse.y - centre.y) <= state.radius * state.falloff || sourceNode && contains(sourceNode, mouse) || corridor) return;
    }
    if (state.pinned) return;
    if (active) { active = false; lastFocusedId = ""; schedule(); }
    const candidate = sourceHit(mouse);
    if (!candidate) { clearHover(); return; }
    if (candidate.id === hoverId) return;
    clearHover(); hoverId = candidate.id;
    hoverTimer = setTimeout(() => { if (!disposed && state.enabled && options.interactive?.() !== false) activate(candidate.point, candidate.node ? candidate.id : "", candidate.node ? "" : candidate.id); }, 200);
  };
  const leave = () => { clearHover(); if (!state.pinned) { active = false; lastFocusedId = ""; schedule(); } };
  const edgeHit = (edges: LensEdge[], point: Point) => edges.find((edge) => edge.points.slice(1).some((b, i) => {
    const a = edge.points[i], dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const t = length ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / length, 0, 1) : 0;
    return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) < 5;
  }));
  const click = (e: MouseEvent) => {
    if (!active || !state.enabled || ignored(e) || e.detail === 0 || Math.hypot(position(e).x - centre.x, position(e).y - centre.y) > state.radius * state.falloff) return;
    e.preventDefault(); e.stopImmediatePropagation(); const node = hit(position(e));
    if (node) options.onNode?.(node, e.ctrlKey || e.metaKey || e.shiftKey);
    else {
      const point = position(e);
      const edge = edgeHit(drawnEdges, point);
      if (edge && options.onEdge) options.onEdge(edge);
      else { active = false; lastFocusedId = ""; schedule(); }
    }
  };
  const down = (e: MouseEvent) => { if (!ignored(e) && active && state.enabled && Math.hypot(position(e).x - centre.x, position(e).y - centre.y) < state.radius * state.falloff) e.stopImmediatePropagation(); };
  const key = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.matches("input,textarea,select,[contenteditable=true]")) return;
    if (e.key.toLowerCase() === "l") { e.preventDefault(); e.stopImmediatePropagation(); clearHover(); state.enabled = !state.enabled; if (!state.enabled) active = false; notify(); }
    if (e.key === "Escape" && active) { e.preventDefault(); e.stopImmediatePropagation(); clearHover(); state.pinned = false; active = false; lastFocusedId = ""; notify(); }
    if (e.key === "[" || e.key === "]") { e.preventDefault(); page = Math.max(0, page + (e.key === "[" ? -1 : 1)); schedule(); }
  };
  const focusElement = (e: FocusEvent) => {
    const node = options.scene().nodes.find((n) => n.element === e.target);
    if (node && state.enabled) activate(node, node.id);
  };
  const touch = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || ignored(e) || !state.enabled) return;
    const candidate = sourceHit(position(e));
    if (candidate && !active) activate(candidate.point, candidate.node ? candidate.id : "", candidate.node ? "" : candidate.id);
  };
  const blur = () => { clearHover(); active = false; state.pinned = false; schedule(); };
  host.addEventListener("pointermove", move); host.addEventListener("pointerleave", leave);
  host.addEventListener("pointerdown", touch); host.addEventListener("focusin", focusElement); host.addEventListener("pointerdown", down, true);
  host.addEventListener("mousedown", down, true); host.addEventListener("mouseup", down, true);
  host.addEventListener("click", click, true); host.addEventListener("keydown", key, true);
  window.addEventListener("blur", blur);
  const observer = new ResizeObserver(() => { geometry(); target = boundedLensCentre(target, host.clientWidth, host.clientHeight, state.radius * state.falloff); centre = { ...target }; options.onChange?.({ ...state }); schedule(); }); observer.observe(host); geometry(); notify(); publish();
  return {
    configure(patch) { if (patch.enabled != null) state.enabled = patch.enabled; state.pinned = false; state.magnification = LENS_DEFAULTS.magnification; state.rings = true; state.easing = !matchMedia("(prefers-reduced-motion: reduce)").matches; geometry(); if (!state.enabled) { clearHover(); active = false; } notify(); },
    focus(point) { if (!state.enabled) return; mouse = { ...point }; const candidate = sourceHit(point); activate(candidate?.point ?? point, candidate?.node ? candidate.id : "", candidate && !candidate.node ? candidate.id : ""); },
    refresh: schedule,
    nextPage(delta) { page = Math.max(0, page + delta); schedule(); },
    dispose() { disposed = true; clearHover(); cancelAnimationFrame(raf); observer.disconnect(); canvas.remove(); controls?.remove(); host.removeEventListener("pointermove", move); host.removeEventListener("pointerleave", leave); host.removeEventListener("pointerdown", touch); host.removeEventListener("focusin", focusElement); host.removeEventListener("pointerdown", down, true); host.removeEventListener("mousedown", down, true); host.removeEventListener("mouseup", down, true); host.removeEventListener("click", click, true); host.removeEventListener("keydown", key, true); window.removeEventListener("blur", blur); },
  };
}

/** Matrix and terrain adapters use the same projection, controls, glow and hit testing. */
export function attachElementFisheye(host: HTMLElement, selector: string): LensEngine {
  const engine = attachFisheye(host, {
    controls: true,
    scene: () => {
      const bounds = host.getBoundingClientRect();
      return { edges: [], nodes: [...host.querySelectorAll(selector)].map((element, index) => {
        const box = element.getBoundingClientRect(), description = element.getAttribute("aria-label") ?? element.textContent ?? "";
        const terrain = element.matches(".terrain-svg g.cell"), label = terrain ? description.split(", risk ")[0] : element.textContent?.trim() || description.split(",")[0];
        const displayMode = element.classList.contains("m-hypothesis") ? "HYPOTHESIS" : element.classList.contains("m-inference") ? "INFERENCE" : element.classList.contains("m-fog") || element.querySelector(".fogmask") ? "FOG" : "FACT";
        return { id: `cell:${index}`, element, compact: true, displayMode, label, details: terrain ? description.split(", ").slice(1) : [description], color: chartColor(description), x: box.left - bounds.left + box.width / 2, y: box.top - bounds.top + box.height / 2, width: box.width, height: box.height, selected: element.getAttribute("aria-pressed") === "true" || element.closest("[aria-selected=true]") != null };
      }) };
    },
    onNode(node, toggle) { node.element?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: toggle, detail: 0 })); },
  });
  const observer = new MutationObserver(engine.refresh); observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-pressed", "aria-selected"] });
  const refresh = () => engine.refresh(); host.addEventListener("scroll", refresh, true);
  return { ...engine, dispose() { observer.disconnect(); host.removeEventListener("scroll", refresh, true); engine.dispose(); } };
}
