import { useEffect, useRef } from "react";
import { outline, type Rendered } from "./graph.ts";

interface Props { rendered: Rendered; level: number; onClose: () => void; onPick: (id: string) => void }

/** The whole map as structured text: every element, how it is known, and what it links to. */
export function Outline({ rendered, level, onClose, onPick }: Props) {
  const items = outline(rendered);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="outline-title" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <h2 id="outline-title">Text outline of this map <span className="muted small">level {level}, {items.length} element(s)</span></h2>
        <ul className="outline" tabIndex={0} aria-label="Map elements">
          {items.map((it, i) => (
            <li key={it.id}>
              <button ref={i === 0 ? first : undefined} className="link" onClick={() => onPick(it.id)}>{it.text}</button>
              {it.links.length > 0 && <ul>{it.links.map((l, j) => <li key={j}>{l}</li>)}</ul>}
            </li>
          ))}
          {items.length === 0 && <li>The map is empty.</li>}
        </ul>
        <div className="modal-actions"><span className="muted small">Same content as the picture, in reading order from left to right.</span><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
