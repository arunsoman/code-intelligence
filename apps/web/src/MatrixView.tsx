import { useEffect, useRef, useState } from "react";
import { attachElementFisheye } from "./fisheye.ts";
import type { MatrixAxis, MatrixCell, ViewMatrix } from "@cie/schema";
import { cellKey } from "./graph.ts";

interface Props { matrix: ViewMatrix; stale: Set<string>; selected: Set<string>; onPick: (cell: MatrixCell | null, row: MatrixAxis, col: MatrixAxis, additive?: boolean) => void }

const MODE = { FACT: "Fact", INFERENCE: "Inference", HYPOTHESIS: "Hypothesis", FOG: "Fog", HIDDEN: "Hidden" } as const;
const tint = (t: number) => `color-mix(in srgb, var(--heat-hot) ${Math.round(t * 100)}%, var(--heat-cool))`;

/**
 * The grid drawing of a many-to-many relation. It is a real table (row and column headers, one tab stop, arrow keys
 * move between cells), so a screen reader gets "route X, rule Y: can get around" without any visual. Each cell says
 * how it is known with its border (solid fact, dashed inference, dotted hypothesis) and in words, never by colour alone.
 */
export function MatrixView({ matrix, stale, selected, onPick }: Props) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!host.current) return; const lens = attachElementFisheye(host.current, ".mcell"); return () => lens.dispose(); }, []);
  const [focus, setFocus] = useState<[number, number]>([0, 0]);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const cellAt = new Map(matrix.cells.map((c) => [`${c.row}|${c.col}`, c]));
  const R = matrix.rows.length, C = matrix.cols.length;
  const go = (r: number, c: number) => { const rr = Math.max(0, Math.min(R - 1, r)), cc = Math.max(0, Math.min(C - 1, c)); setFocus([rr, cc]); refs.current.get(`${rr}|${cc}`)?.focus(); };
  const onKey = (e: React.KeyboardEvent, r: number, c: number) => {
    const k = e.key;
    // Space selects (adds to "these"); Enter and click inspect, as on the map.
    if (k === " ") { e.preventDefault(); onPick(cellAt.get(`${matrix.rows[r].id}|${matrix.cols[c].id}`) ?? null, matrix.rows[r], matrix.cols[c], true); return; }
    if (k === "ArrowRight") go(r, c + 1); else if (k === "ArrowLeft") go(r, c - 1); else if (k === "ArrowDown") go(r + 1, c); else if (k === "ArrowUp") go(r - 1, c);
    else if (k === "Home") go(r, 0); else if (k === "End") go(r, C - 1);
    else return;
    e.preventDefault();
  };
  const used = [...new Set(matrix.cells.map((c) => c.state))].filter((s) => matrix.states[s]);
  return (
    <div className="matrix chart-lens-host" ref={host}>
      {/* A compact key (one wrapping line) plus the full definitions on demand: the matrix, not the legend, gets the height. */}
      <div id="matrix-legend" className="matrix-key">
        <ul aria-label="Cell key">
          {used.map((s) => <li key={s}><span className={`glyph s-${s}`} aria-hidden>{matrix.states[s].glyph}</span> <strong>{matrix.states[s].label}</strong></li>)}
          <li><span className="glyph" aria-hidden>·</span> <strong>empty</strong></li>
        </ul>
        <details>
          <summary>What the symbols mean</summary>
          <ul>
            {used.map((s) => <li key={s}><span className={`glyph s-${s}`} aria-hidden>{matrix.states[s].glyph}</span> <strong>{matrix.states[s].label}</strong> — {matrix.states[s].description}</li>)}
            <li><span className="glyph" aria-hidden>·</span> <strong>empty</strong> — {matrix.emptyMeaning}</li>
            <li className="muted small">Border: solid is a fact, dashed an inference, dotted a hypothesis. Click a cell for its evidence. Space, or Shift-click, adds cells to the question you type; the chat shows them as chips.</li>
          </ul>
        </details>
      </div>
      <div className="matrix-scroll" tabIndex={-1}>
        <table role="grid" aria-label={`${matrix.rowTitle} by ${matrix.colTitle}`} aria-multiselectable="true" aria-describedby="matrix-legend" aria-rowcount={R + 1} aria-colcount={C + 1}>
          <thead>
            <tr>
              <th scope="col" className="corner"><span className="sr">{matrix.rowTitle}, </span><span aria-hidden>{matrix.rowTitle} ↓ · {matrix.colTitle} →</span></th>
              {matrix.cols.map((c) => (
                <th key={c.id} scope="col" title={`${c.label}${c.sub ? ` — ${c.sub}` : ""}`} className={`colhead ${c.role ?? ""}`}>
                  <span className="lbl">{c.label}</span>{c.sub && <small>{c.sub}</small>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row, ri) => (
              <tr key={row.id}>
                <th scope="row" title={`${row.label}${row.sub ? ` — ${row.sub}` : ""}`} className="rowhead">
                  <span className="lbl">{row.label}</span>{row.sub && <small>{row.sub}</small>}
                  {row.heat && <span className="rowheat" style={{ background: tint(row.heat.value) }}>{row.heat.label}</span>}
                </th>
                {matrix.cols.map((col, ci) => {
                  const cell = cellAt.get(`${row.id}|${col.id}`);
                  const st = cell ? matrix.states[cell.state] : null;
                  const isStale = !!cell && stale.has(cellKey(cell));
                  const key = cellKey({ row: row.id, col: col.id });
                  const isSel = selected.has(key);
                  const label = cell && st
                    ? `${row.label}, ${col.label}: ${st.label}${cell.strength != null ? `, reaches ${Math.round(cell.strength * 100)} percent of its code` : ""}. ${MODE[cell.displayMode]}${isStale ? ", stale" : ""}.`
                    : `${row.label}, ${col.label}: no relation found.`;
                  return (
                    <td key={col.id} role="gridcell" aria-selected={isSel}>
                      <button ref={(el) => { if (el) refs.current.set(`${ri}|${ci}`, el); }} tabIndex={focus[0] === ri && focus[1] === ci ? 0 : -1}
                        className={`mcell ${cell ? `m-${cell.displayMode.toLowerCase()} s-${cell.state}` : "empty"} ${isStale ? "stale" : ""} ${isSel ? "sel" : ""}`}
                        style={cell?.strength != null ? ({ "--fill": `${Math.round(cell.strength * 100)}%` } as React.CSSProperties) : undefined}
                        aria-label={label} onFocus={() => setFocus([ri, ci])} onKeyDown={(e) => onKey(e, ri, ci)} onClick={(e) => onPick(cell ?? null, row, col, e.shiftKey || e.ctrlKey || e.metaKey)}>
                        {cell && st ? <><span className="glyph" aria-hidden>{st.glyph}</span>{cell.strength != null && <span className="pct" aria-hidden>{Math.round(cell.strength * 100)}%</span>}</> : <span aria-hidden>·</span>}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
