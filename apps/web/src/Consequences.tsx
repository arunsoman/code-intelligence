import type { ViewSpec } from "@cie/schema";

interface Props { items: NonNullable<ViewSpec["consequences"]>; onOpen: (id: string) => void }

/** "What this means" rows: each with its kind, the claim behind it, and a way to its evidence. Collapsed by default so
 *  it informs without crowding the drawing above it; open, it scrolls rather than pushing the view down. */
export function Consequences({ items, onOpen }: Props) {
  if (!items.length) return null;
  return (
    <details className="consequences">
      <summary>What this means ({items.length})</summary>
      <ul aria-label="What this means">
        {items.map((c) => (
          <li key={c.id}>
            <span className={`badge ${c.displayMode === "HYPOTHESIS" ? "hyp" : "inference"}`}>{c.displayMode === "HYPOTHESIS" ? "Hypothesis" : "Inference"}</span>
            <span className="chip">{c.kind}</span>
            <button className="link" onClick={() => onOpen(c.id)}>{c.text}</button>
          </li>
        ))}
      </ul>
    </details>
  );
}
