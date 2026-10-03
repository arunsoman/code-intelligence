import type { ViewSpec } from "@cie/schema";

interface Props { items: NonNullable<ViewSpec["consequences"]>; onOpen: (id: string) => void }

/** "What this means" rows: each with its kind, the claim behind it, and a way to its evidence. */
export function Consequences({ items, onOpen }: Props) {
  if (!items.length) return null;
  return (
    <section className="consequences" aria-label="What this means" tabIndex={0}>
      <h2>What this means <small>({items.length})</small></h2>
      <ul>
        {items.map((c) => (
          <li key={c.id}>
            <span className={`badge ${c.displayMode === "HYPOTHESIS" ? "hyp" : "inference"}`}>{c.displayMode === "HYPOTHESIS" ? "Hypothesis" : "Inference"}</span>
            <span className="chip">{c.kind}</span>
            <button className="link" onClick={() => onOpen(c.id)}>{c.text}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
