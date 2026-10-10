import { wrapSequenceText } from "./sequence-layout.ts";
import { useEffect, useId, useRef, useState } from "react";
import type { CanvasProps } from "./Canvas.tsx";
import type { RenderNode, RenderEdge } from "./graph.ts";
import { automaticLensGeometry, boundedLensCentre, chartColor, LENS_DEFAULTS } from "./fisheye.ts";
import type { CanvasState } from "./response-workspace.ts";

interface Preview { label: string; lines: string[]; node?: RenderNode; edge?: RenderEdge; x: number; y: number }

/** An SVG surface: time and message endpoints remain independent of graph layout. */
export function SequenceCanvas(p: CanvasProps) {
  const scene = p.rendered.sequence!;
  const host = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [camera, setCamera] = useState<CanvasState>(p.initialState ?? { zoom: 1, pan: { x: 0, y: 0 }, lens: { ...LENS_DEFAULTS } });
  const [tableOpen,setTableOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drag = useRef<{ x: number; y: number; pan: { x: number; y: number }; selecting: boolean } | undefined>(undefined);
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const ids = useId().replace(/:/g, ""), fit = useRef(p.fitTick), initial = useRef(true);
  const nodeById = new Map(p.rendered.nodes.map(n => [n.id,n]));
  const fitCamera = (width: number, height: number) => {
    const zoom = Math.max(.65, Math.min(1.2, (width - 60) / scene.width, (height - 70) / scene.height));
    setCamera(c => ({ ...c, zoom, pan: { x: Math.max(30,(width - scene.width * zoom) / 2), y: 35 } }));
  };
  useEffect(() => {
    const element = host.current!;
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth, height = element.clientHeight;
      setSize({ width, height });
      if (initial.current) { initial.current = false; if (!p.initialState) fitCamera(width,height); }
    });
    const preventZoom = (event: WheelEvent) => { if (event.ctrlKey || event.metaKey) event.preventDefault(); };
    element.addEventListener("wheel",preventZoom,{ passive: false });
    observer.observe(element); return () => { observer.disconnect(); clearTimeout(timer.current); element.removeEventListener("wheel",preventZoom); };
  }, []);
  useEffect(() => { if (fit.current !== p.fitTick) { fit.current = p.fitTick; fitCamera(size.width,size.height); } }, [p.fitTick]);
  useEffect(() => { p.onState?.(camera); }, [camera, p.onState]);
  useEffect(() => { clearTimeout(timer.current); setPreview(null); }, [p.viewKey]);
  const stopPreview = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setPreview(null), 150); };
  const capture = (node: RenderNode | undefined, edge: RenderEdge | undefined, point?: { x: number; y: number }) => {
    clearTimeout(timer.current);
    if (!camera.lens.enabled) return;
    const value = structuredClone({ label: node?.label ?? edge?.label ?? "Interaction", lines: node ? ["Participant", ...(node.node?.notes ?? []), `${node.node?.evidenceIds.length ?? 0} evidence links`] : [`${nodeById.get(edge!.from)?.label} → ${nodeById.get(edge!.to)?.label}`, "Order inferred from the static plan", `${edge!.evidenceIds.length} evidence links`], node, edge, x: point?.x ?? size.width / 2, y: point?.y ?? size.height / 2 });
    if (!point) {
      const target = node ? scene.participants.find(part => part.node.id === node.id) : scene.messages.find(m => m.edge.id === edge?.id);
      if (target) { const x = "x" in target ? target.x : (target.x1 + target.x2) / 2, y = "y" in target ? target.y : 40;
        const screenX = x * camera.zoom + camera.pan.x, screenY = y * camera.zoom + camera.pan.y;
        if (screenX < 24 || screenX > size.width - 24 || screenY < 24 || screenY > size.height - 50) setCamera(c => ({ ...c, pan: { x: size.width / 2 - x * c.zoom, y: size.height / 2 - y * c.zoom } }));
      }
    }
    p.announce(value.label + (edge ? ". Message order is inferred." : ". Participant."));
    timer.current = setTimeout(() => setPreview(value), 200);
  };
  const point = (event: React.PointerEvent | React.MouseEvent) => { const rect = host.current!.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const activate = (node?: RenderNode, edge?: RenderEdge) => { if (node) p.onTapNode(node); else if (edge) p.onTapEdge(edge); };
  const keyboard = (event: React.KeyboardEvent, node?: RenderNode, edge?: RenderEdge) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (event.key === " " && node) p.onToggleNode(node); else activate(node,edge); }
  };
  const geometry = automaticLensGeometry(size.width,size.height);
  const center = preview ? boundedLensCentre({ x: preview.x + geometry.outer + 24, y: preview.y },size.width,size.height,geometry.outer) : { x: 0, y: 0 };
  return <div className="sequence-surface" ref={host}>
    <svg ref={svg} className="canvas sequence-canvas" width="100%" height="100%" role="group" aria-label={`Sequence diagram. ${p.caption}. Time progresses downward. Ordering is inferred.`} tabIndex={0}
      onKeyDown={event => {
        if (event.key === "Escape") { setPreview(null); clearTimeout(timer.current); p.onClear(); }
        else if (event.target !== svg.current && ["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(event.key)) {
          const elements = [...svg.current!.querySelectorAll<SVGElement>("[data-sequence-element]")], index = elements.indexOf(event.target as SVGElement);
          if (index >= 0) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? elements.length - 1 : Math.max(0,Math.min(elements.length-1,index+(["ArrowLeft","ArrowUp"].includes(event.key)?-1:1))); elements[next]?.focus(); }
        }
        else if (event.target === svg.current && ["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key)) { event.preventDefault(); setCamera(c => ({ ...c, pan: { x: c.pan.x + (event.key === "ArrowLeft" ? 60 : event.key === "ArrowRight" ? -60 : 0), y: c.pan.y + (event.key === "ArrowUp" ? 60 : event.key === "ArrowDown" ? -60 : 0) } })); }
        else if (event.target === svg.current && ["+","-"].includes(event.key)) { event.preventDefault(); setCamera(c => ({ ...c, zoom: Math.max(.35,Math.min(3,c.zoom * (event.key === "+" ? 1.15 : 1 / 1.15))) })); }
        else if (event.target === svg.current && event.key.toLowerCase() === "o") p.onOpenOutline();
      }}
      onWheel={event => {
        if (event.ctrlKey || event.metaKey) { event.preventDefault(); const rect = host.current!.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top; setCamera(c => { const zoom = Math.max(.35,Math.min(3,c.zoom * Math.exp(-event.deltaY * .002))); return { ...c, zoom, pan: { x: x - (x-c.pan.x) * zoom/c.zoom, y: y - (y-c.pan.y) * zoom/c.zoom } }; }); }
        else setCamera(c => ({ ...c, pan: { x: c.pan.x - event.deltaX, y: c.pan.y - event.deltaY } }));
      }}
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as Element).closest("[data-sequence-element]")) return;
        const pt = point(event); drag.current = { ...pt, pan: { ...camera.pan }, selecting: p.boxSelect }; event.currentTarget.setPointerCapture(event.pointerId); setPreview(null);
      }}
      onPointerMove={event => { const d=drag.current; if (!d) return; const pt=point(event); if (d.selecting) setBox({ x: Math.min(d.x,pt.x), y: Math.min(d.y,pt.y), width: Math.abs(pt.x-d.x), height: Math.abs(pt.y-d.y) }); else setCamera(c => ({ ...c, pan: { x: d.pan.x+pt.x-d.x, y: d.pan.y+pt.y-d.y } })); }}
      onPointerUp={event => { if (drag.current?.selecting && box) { p.onSelectNodes(scene.participants.filter(part => { const x=part.x*camera.zoom+camera.pan.x,y=40*camera.zoom+camera.pan.y; return x>=box.x && x<=box.x+box.width && y>=box.y && y<=box.y+box.height; }).map(part=>part.node.id)); } drag.current=undefined; setBox(null); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag.current=undefined; setBox(null); }}>
      <defs><marker id={`${ids}-solid`} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" fill="context-stroke" /></marker><marker id={`${ids}-open`} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10" fill="none" stroke="context-stroke" /></marker><clipPath id={`${ids}-lens`}><circle cx={center.x} cy={center.y} r={geometry.inner} /></clipPath></defs>
      <g transform={`translate(${camera.pan.x} ${camera.pan.y}) scale(${camera.zoom})`}>
        {scene.fragments.map((fragment,index) => <g key={`${fragment.id}:${index}`} className="sequence-fragment"><rect x={20} y={fragment.y} width={scene.width-40} height={fragment.height} rx={4} /><text x={30} y={fragment.y+18}>{fragment.label.slice(0,100)}</text><title>{fragment.label}. Fragment inferred; {fragment.evidenceIds.length} evidence links.</title></g>)}
        {scene.participants.map(({node,x}) => <g key={node.id}>
          <line x1={x} x2={x} y1={14+scene.headerHeight} y2={scene.height-20} className="sequence-lifeline" />
          <g data-sequence-element="participant" data-node-id={node.id} role="button" tabIndex={0} aria-label={`Participant ${node.label}. Inspect source evidence.`} className={`sequence-participant ${p.selected.has(node.id) ? "selected" : ""} ${node.stale ? "stale" : ""}`} onFocus={() => capture(node,undefined)} onBlur={stopPreview} onMouseEnter={e => capture(node,undefined,point(e))} onMouseLeave={stopPreview} onKeyDown={e=>keyboard(e,node)} onClick={e => { if(e.shiftKey) p.onToggleNode(node); else activate(node); }}>
            <rect x={x-100} y={14} width={200} height={scene.headerHeight} rx={6} stroke={chartColor(node.displayMode,node.role)} /><text x={x} y={35} textAnchor="middle">{wrapSequenceText(node.label,25).map((line,i)=><tspan key={i} x={x} dy={i ? 16 : 0}>{line}</tspan>)}</text><title>{node.label}</title>
          </g>
        </g>)}
        {scene.messages.map(message => {
          const {edge,x1,x2,y,kind}=message, self=x1===x2;
          const path=self ? `M ${x1} ${y} H ${x1+55} V ${y+28} H ${x1}` : `M ${x1} ${y} H ${x2}`;
          const labelX=self ? x1+70 : (x1+x2)/2;
          return <g key={edge.id} data-sequence-element="message" data-edge-id={edge.id} role="button" tabIndex={0} aria-label={`${message.order}. ${nodeById.get(edge.from)?.label} to ${nodeById.get(edge.to)?.label}: ${edge.label}. ${kind}. Inferred ordering.`} className={`sequence-message ${edge.stale ? "stale" : ""}`} onFocus={()=>capture(undefined,edge)} onBlur={stopPreview} onMouseEnter={e=>capture(undefined,edge,point(e))} onMouseLeave={stopPreview} onKeyDown={e=>keyboard(e,undefined,edge)} onClick={()=>activate(undefined,edge)}>
            <path d={path} className="sequence-hit" /><path d={path} fill="none" stroke={chartColor(edge.displayMode)} strokeWidth={2} strokeDasharray={kind==="return" ? "7 5" : kind==="async" ? "3 3" : undefined} markerEnd={`url(#${ids}-${kind==="async"||kind==="return" ? "open" : "solid"})`} />
            <text x={labelX} y={y-14-(wrapSequenceText(`${message.order}. ${edge.label}`).length-1)*16} textAnchor={self ? "start" : "middle"}>{wrapSequenceText(`${message.order}. ${edge.label}`).map((line,i)=><tspan x={labelX} dy={i ? 16 : 0} key={i}>{line}</tspan>)}</text><title>{edge.label}. {edge.evidenceIds.length} evidence links. {kind}.</title>
          </g>;
        })}
      </g>
      {box && <rect {...box} fill="#38bdf833" stroke="#38bdf8" />}
      {preview && geometry.outer>0 && <g className="sequence-preview" role="button" tabIndex={0} aria-label={`Focused preview: ${preview.label}`} onMouseEnter={()=>clearTimeout(timer.current)} onMouseLeave={stopPreview} onKeyDown={e=>keyboard(e,preview.node,preview.edge)} onClick={()=>activate(preview.node,preview.edge)}>
        <circle cx={center.x} cy={center.y} r={geometry.outer} /><circle cx={center.x} cy={center.y} r={geometry.inner} className="sequence-inner" />
        <g clipPath={`url(#${ids}-lens)`}><text x={center.x} y={center.y-60} textAnchor="middle">{wrapSequenceText(preview.label,28).slice(0,3).map((line,i)=><tspan x={center.x} dy={i?20:0} key={i}>{line}</tspan>)}</text><text x={center.x} y={center.y+10} textAnchor="middle" className="sequence-preview-detail">{preview.lines.flatMap(line=>wrapSequenceText(line,30)).slice(0,5).map((line,i)=><tspan x={center.x} dy={i?18:0} key={i}>{line}</tspan>)}</text></g>
      </g>}
    </svg>
    <div className="sequence-notice"><button className="secondary small" aria-expanded={tableOpen} onClick={()=>{setTableOpen(!tableOpen);setPreview(null);clearTimeout(timer.current);}}>Message table</button>Time ↓ · order inferred from static evidence · scroll or drag to pan · Ctrl+scroll to zoom <button className="secondary small" aria-pressed={!camera.lens.enabled} onClick={()=>{setPreview(null);clearTimeout(timer.current);setCamera(c=>({...c,lens:{...c.lens,enabled:!c.lens.enabled}}));}}>{camera.lens.enabled?"Pause preview":"Resume preview"}</button></div>
    {tableOpen && <section className="sequence-table" aria-label="Sequence messages as a table"><button className="secondary small" onClick={()=>setTableOpen(false)}>Close message table</button><table><caption>Message order is inferred from the static plan.</caption><thead><tr>{["Order","From","To","Message","Kind","Evidence"].map(label=><th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{scene.messages.map(m=><tr key={m.edge.id}><td>{m.order}</td><td>{nodeById.get(m.edge.from)?.label}</td><td>{nodeById.get(m.edge.to)?.label}</td><td>{m.edge.label}</td><td>{m.kind}</td><td><button className="link small" onClick={()=>p.onTapEdge(m.edge)} aria-label={`Inspect evidence for message ${m.order}`}>{m.edge.evidenceIds.length} links</button></td></tr>)}</tbody></table></section>}
  </div>;
}
