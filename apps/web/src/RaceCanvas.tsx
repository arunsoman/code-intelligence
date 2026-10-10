import { useEffect, useId, useRef, useState } from "react";
import type { CanvasProps } from "./Canvas.tsx";
import type { CanvasState } from "./response-workspace.ts";
import { LENS_DEFAULTS } from "./fisheye.ts";
import type { RenderNode } from "./graph.ts";

interface Preview { title: string; lines: string[]; node?: RenderNode; x: number; y: number }

const OUTCOME_FILL: Record<string, string> = { SUCCESS: "var(--ok, #2e7d32)", ERROR: "var(--warn, #b26a00)", TIMEOUT: "#b3261e", CANCELLED: "#757575" };

/** A replay surface: time-proportional request rows in simulated time. The lens stays dormant here —
 *  rows are sparse and the honest magnifier is the table alternative. */
export function RaceCanvas(p: CanvasProps) {
  const scene = p.rendered.race!;
  const host = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [camera, setCamera] = useState<CanvasState>(p.initialState ?? { zoom: 1, pan: { x: 0, y: 0 }, lens: { ...LENS_DEFAULTS, enabled: false } });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const ids = useId().replace(/:/g, ""), fit = useRef(p.fitTick), initial = useRef(true);
  const drag = useRef<{ x: number; y: number; pan: { x: number; y: number } } | undefined>(undefined);
  const nodeById = new Map(p.rendered.nodes.map((n) => [n.id, n]));
  const point = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = svg.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left - camera.pan.x) / camera.zoom, y: (e.clientY - rect.top - camera.pan.y) / camera.zoom };
  };
  const fitCamera = (width: number, height: number) => {
    const zoom = Math.max(0.65, Math.min(1.2, (width - 40) / scene.width, (height - 40) / scene.height));
    setCamera(c => ({ ...c, zoom, pan: { x: Math.max(16, (width - scene.width * zoom) / 2), y: 24 } }));
  };
  useEffect(() => {
    const element = host.current!;
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth, height = element.clientHeight;
      setSize({ width, height });
      if (initial.current) { initial.current = false; if (!p.initialState) fitCamera(width, height); }
    });
    const preventZoom = (event: WheelEvent) => { if (event.ctrlKey || event.metaKey) event.preventDefault(); };
    element.addEventListener("wheel", preventZoom, { passive: false });
    observer.observe(element);
    return () => { observer.disconnect(); element.removeEventListener("wheel", preventZoom); };
  }, []);
  useEffect(() => { if (fit.current !== p.fitTick) { fit.current = p.fitTick; fitCamera(size.width, size.height); } }, [p.fitTick]);
  useEffect(() => { p.onState?.(camera); }, [camera, p.onState]);
  useEffect(() => { setPreview(null); }, [p.viewKey]);
  const activate = (node?: RenderNode) => { if (node) p.onTapNode(node); };
  const keyboard = (e: React.KeyboardEvent, node?: RenderNode) => {
    if (e.key === "Enter") { e.preventDefault(); activate(node); }
    if (e.key === "Escape") { setPreview(null); p.onClear(); }
  };
  const blockTitle = (b: (typeof scene.blocks)[number]) => {
    const row = scene.rows.find((r) => r.requestId === b.requestId)!;
    const station = scene.stations.find((s) => s.id === b.stationId);
    return {
      title: `${b.requestId} · ${b.stationId}`,
      lines: [
        `outcome ${row.outcome} after ${Math.round(row.latencyMs)} ms${row.retries ? `, attempt #${b.attempt + 1} of ${row.retries + 1}` : ""}`,
        `service ${Math.round((b.x + b.w - b.x) * scene.timeMaxMs / scene.plotW)} ms window${b.waitW > 0 ? ` after waiting` : ""}`,
        `station ${station?.node.label ?? b.stationId} (${b.event.toLowerCase()})`,
        "Simulated-model time — not a production measurement.",
      ],
    };
  };
  return (
    <div ref={host} className="race-canvas" data-race-host={ids} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <svg
        ref={svg} role="img" aria-label={p.caption}
        width={size.width} height={size.height}
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, pan: { ...camera.pan } }; (e.currentTarget as Element).setPointerCapture?.(e.pointerId); }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
          if (Math.abs(dx) + Math.abs(dy) > 2) setCamera((c) => ({ ...c, pan: { x: drag.current!.pan.x + dx, y: drag.current!.pan.y + dy } }));
        }}
        onPointerUp={() => { drag.current = undefined; }}
        onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); const factor = e.deltaY < 0 ? 1.06 : 0.94; setCamera((c) => ({ ...c, zoom: Math.max(0.4, Math.min(3, c.zoom * factor)) })); } }}
      >
        <defs>
          <pattern id={`wait-${ids}`} width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="2" opacity="0.35" />
          </pattern>
        </defs>
        <g transform={`translate(${camera.pan.x},${camera.pan.y}) scale(${camera.zoom})`}>
          <text x={12} y={16} className="race-title" style={{ fontSize: 12, fontWeight: 600 }}>
            {`Replay · ${scene.rows.length} sampled requests · window ${Math.round(scene.timeMaxMs) / 1000}s (simulated)`}
          </text>
          {scene.stations.map((s) => (
            <g key={s.id} data-race-element="station" data-node-id={s.node.id} role="button" tabIndex={0}
              aria-label={`Station ${s.node.label}. Inspect station claims.`}
              className={`race-station ${p.selected.has(s.node.id) ? "selected" : ""}`}
              style={{ cursor: "pointer" }}
              onFocus={() => setPreview({ title: s.node.label, lines: ["Select to inspect station claims and evidence."], node: s.node, x: 0, y: 0 })}
              onBlur={() => setPreview(null)}
              onKeyDown={(e) => keyboard(e, s.node)}
              onClick={(e) => { if (e.shiftKey) p.onToggleNode(s.node); else activate(s.node); }}
              onMouseEnter={(e) => setPreview({ title: s.node.label, lines: ["Select to inspect station claims and evidence."], node: s.node, x: point(e).x, y: point(e).y })}
              onMouseLeave={() => setPreview(null)}
            >
              <rect x={12 + s.index * 118} y={4} width={110} height={18} rx={4} fill={`hsl(${s.hue} 45% 88%)`} stroke={`hsl(${s.hue} 45% 55%)`} />
              <text x={18 + s.index * 118} y={17} style={{ fontSize: 10 }}>{s.id}</text>
            </g>
          ))}
          {/* time axis ticks */}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line x1={scene.plotX + t * scene.plotW} y1={scene.headerHeight - 6} x2={scene.plotX + t * scene.plotW} y2={scene.headerHeight + scene.rows.length * scene.rowHeight} stroke="currentColor" opacity={0.12} />
              <text x={scene.plotX + t * scene.plotW} y={scene.headerHeight - 10} style={{ fontSize: 9 }} textAnchor="middle">{`${Math.round(t * scene.timeMaxMs)}ms`}</text>
            </g>
          ))}
          {scene.rows.map((r) => (
            <g key={r.requestId} data-race-element="row">
              <text x={8} y={r.y + 11} style={{ fontSize: 9, fill: OUTCOME_FILL[r.outcome] ?? "currentColor" }}>{`${r.requestId} · ${r.outcome}${r.retries ? ` ·${r.retries}r` : ""}`}</text>
              <line x1={scene.plotX} y1={r.y + 5} x2={scene.plotX + scene.plotW} y2={r.y + 5} stroke="currentColor" opacity={0.06} />
            </g>
          ))}
          {scene.blocks.map((b, i) => {
            const station = scene.stations.find((s) => s.id === b.stationId)!;
            const info = blockTitle(b);
            return (
              <g key={`${b.requestId}:${b.stationId}:${b.attempt}:${i}}`} data-race-element="block" data-request-id={b.requestId}
                role="button" tabIndex={0}
                aria-label={`Request ${b.requestId} at ${b.stationId}: ${b.event}, outcome ${b.outcome}.`}
                className={`race-block ${b.event !== "SERVICE" ? "race-block-fault" : ""}`}
                onFocus={() => setPreview({ ...info, x: b.x, y: b.y })}
                onBlur={() => setPreview(null)}
                onKeyDown={(e) => keyboard(e, station.node)}
                onClick={() => activate(station.node)}
                onMouseEnter={(e) => setPreview({ ...info, x: point(e).x, y: point(e).y })}
                onMouseLeave={() => setPreview(null)}
              >
                {b.waitW > 2 && <rect x={b.waitX} y={b.y} width={b.waitW} height={b.h} fill={`url(#wait-${ids})`} stroke={`hsl(${station.hue} 45% 55%)`} strokeOpacity={0.5} strokeWidth={0.5} />}
                <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={2}
                  fill={b.event === "SERVICE" ? `hsl(${station.hue} 55% 62%)` : OUTCOME_FILL[b.outcome] ?? "#b3261e"}
                  stroke={`hsl(${station.hue} 55% 35%)`} strokeWidth={0.75} style={{ cursor: "pointer" }} />
              </g>
            );
          })}
        </g>
      </svg>
      <div style={{ position: "absolute", top: 8, right: 10, display: "flex", gap: 6 }}>
        <button className="secondary small" onClick={() => fitCamera(size.width, size.height)}>Fit</button>
        <button className="secondary small" onClick={() => setZoom(camera, setCamera, 1.15)}>+</button>
        <button className="secondary small" onClick={() => setZoom(camera, setCamera, 0.87)}>−</button>
        <button className="secondary small" onClick={() => setTableOpen(!tableOpen)} aria-expanded={tableOpen}>{tableOpen ? "Hide table" : "Table view"}</button>
      </div>
      {preview && (
        <div role="status" className="race-preview" style={{ position: "absolute", left: Math.min(preview.x + 14, size.width - 260), top: Math.max(4, preview.y + 14), pointerEvents: "none" }}>
          <strong>{preview.title}</strong>
          {preview.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      {tableOpen && (
        <section className="race-table" aria-label="Replay requests as a table" style={{ position: "absolute", inset: 0, background: "var(--bg, #fff)", overflow: "auto", padding: 12 }}>
          <button className="secondary small" onClick={() => setTableOpen(false)}>Close table</button>
          <table><caption>Replay metrics are a deterministic model run, not production timing.</caption>
            <thead><tr>{["Request", "Outcome", "Latency", "Retries", "Stations"].map((h) => <th scope="col" key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {scene.rows.map((r) => {
                const spans = scene.blocks.filter((b) => b.requestId === r.requestId);
                return (
                  <tr key={r.requestId}>
                    <td>{r.requestId}</td><td>{r.outcome}</td><td>{Math.round(r.latencyMs)} ms</td><td>{r.retries}</td>
                    <td>{spans.map((b) => `${b.stationId}→${b.event.toLowerCase()}`).join(", ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function setZoom(camera: CanvasState, set: (fn: (c: CanvasState) => CanvasState) => void, factor: number) {
  set((c) => ({ ...c, zoom: Math.max(0.4, Math.min(3, camera.zoom * factor)) }));
}
