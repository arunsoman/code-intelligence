import { useRef } from "react";
import { outline, type Rendered } from "./graph.ts";
import { Modal } from "./Modal.tsx";

interface Props { rendered: Rendered; level: number; onClose: () => void; onPick: (id: string) => void }

/** The whole map as structured text: every element, how it is known, and what it links to. */
export function Outline({ rendered, level, onClose, onPick }: Props) {
  const items = outline(rendered);
  const first = useRef<HTMLButtonElement>(null);
  return (
    <Modal title={`Text outline · level ${level} · ${items.length} element(s)`} onClose={onClose}
      className="wide"
      actions={<><span className="muted small">Same content as the picture, in reading order from left to right.</span><button onClick={onClose}>Done</button></>}
      initialFocusRef={first}>
      <ul className="outline" tabIndex={0} aria-label="Map elements">
        {items.map((it, i) => (
          <li key={it.id}>
            <button ref={i === 0 ? first : undefined} className="link" onClick={() => onPick(it.id)}>{it.text}</button>
            {it.links.length > 0 && <ul>{it.links.map((l, j) => <li key={j}>{l}</li>)}</ul>}
          </li>
        ))}
        {items.length === 0 && <li>The map is empty.</li>}
      </ul>
    </Modal>
  );
}
