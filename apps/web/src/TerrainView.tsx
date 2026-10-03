import { useMemo, useState } from "react";
import type { TerrainCell, ViewSpec } from "@cie/schema";
import { composite, squarify } from "./graph.ts";

interface Props { view: ViewSpec; weights: Record<string, number>; onWeights: (w: Record<string, number>) => void; selected: Set<string>; onPick: (cellId: string) => void; onToggle: (cellId: string) => void }

const W = 900, H = 560;
/** Cool → hot, as a hex ramp the text stays readable on in both themes (set in CSS as --heat-cool / --heat-hot). */
function tint(t: number): string { return `color-mix(in srgb, var(--heat-hot) ${Math.round(t * 100)}%, var(--heat-cool))`; }

export function TerrainView({ view, weights, onWeights, selected, onPick, onToggle }: Props) {
  const t = view.terrain!;
  const [focus, setFocus] = useState<string | null>(null);
  const scored = useMemo(() => t.cells.map((c) => ({ c, risk: composite(c.factors, weights) })), [t, weights]);
  // Colour is relative to this repository: the coolest file is the coolest colour, the hardest the hottest.
  const lo = Math.min(...scored.map((x) => x.risk)), hi = Math.max(...scored.map((x) => x.risk));
  const rel = (r: number) => (hi - lo < 0.02 ? 0.5 : (r - lo) / (hi - lo));
  const rects = useMemo(() => squarify(t.cells.map((c) => c.area), { x: 0, y: 0, w: W, h: H }), [t]);
  const hardest = useMemo(() => [...scored].sort((a, b) => b.risk - a.risk).slice(0, 3).map((x) => x.c.id), [scored]);
  const top = (c: TerrainCell) => Object.entries(c.factors).sort((a, b) => b[1] * (weights[b[0]] ?? 0) - a[1] * (weights[a[0]] ?? 0)).slice(0, 2).map(([k]) => t.factors.find((f) => f.id === k)?.label.toLowerCase()).join(" and ");
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="terrain">
      <div className="terrain-weights" role="group" aria-label="Weights of the composite risk">
        {t.factors.map((f) => (
          <label key={f.id} title={f.description}>
            <span>{f.label} <small>{Math.round(((weights[f.id] ?? 0) / total) * 100)}%</small></span>
            <input type="range" min={0} max={100} step={5} value={Math.round((weights[f.id] ?? 0) * 100)} onChange={(e) => onWeights({ ...weights, [f.id]: Number(e.target.value) / 100 })} aria-label={`${f.label} weight`} />
          </label>
        ))}
        <button className="secondary small" onClick={() => onWeights(Object.fromEntries(t.factors.map((f) => [f.id, f.weight])))}>Reset weights</button>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Change-risk terrain: each rectangle is a file, sized by how much code it holds and tinted by composite risk" className="terrain-svg">
        {scored.map(({ c, risk }, i) => {
          const r = rects[i];
          if (!r || r.w < 2 || r.h < 2) return null;
          const fog = !!c.note;
          const label = `${c.label}, risk ${Math.round(risk * 100)} percent, driven by ${top(c)}${fog ? ", some data missing" : ""}`;
          return (
            <g key={c.id} transform={`translate(${r.x},${r.y})`} tabIndex={0} role="button" aria-label={label} aria-pressed={selected.has(c.id)} className={`cell ${focus === c.id ? "focus" : ""}`}
              onFocus={() => setFocus(c.id)} onBlur={() => setFocus(null)} onClick={() => onPick(c.id)} onDoubleClick={() => onToggle(c.id)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onPick(c.id); } else if (e.key === " ") { e.preventDefault(); onToggle(c.id); } }}>
              <rect width={Math.max(0, r.w - 2)} height={Math.max(0, r.h - 2)} rx={4} style={{ fill: tint(rel(risk)) }} className={`${fog ? "fog" : ""} ${selected.has(c.id) ? "sel" : ""}`} />
              {fog && <rect width={Math.max(0, r.w - 2)} height={Math.max(0, r.h - 2)} rx={4} className="fogmask" />}
              {r.w > 70 && r.h > 34 && <text x={8} y={18} className="cell-label">{hardest.includes(c.id) ? "▲ " : ""}{c.label.length > Math.floor(r.w / 7) ? c.label.slice(0, Math.floor(r.w / 7) - 1) + "…" : c.label}</text>}
              {r.w > 70 && r.h > 50 && <text x={8} y={36} className="cell-sub">risk {Math.round(risk * 100)}% · {top(c)}</text>}
            </g>
          );
        })}
      </svg>
      <p className="muted small">{t.formula} ▲ marks the three hardest places. Hatched cells are missing data. Colours are relative to this repository ({Math.round(lo * 100)}% to {Math.round(hi * 100)}%).</p>
    </div>
  );
}
