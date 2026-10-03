import { useEffect, useState } from "react";
import { call } from "./api.ts";

export interface CatalogEntry { code: string; formId: string; name: string; blurb: string; example: string; needs: string[]; available: boolean; reason?: string }
interface Props { revision?: string; onClose: () => void; onShow: (entry: CatalogEntry, question: string) => void }

/** All sixteen forms from the spec's catalogue, each with what it answers, what it needs, and whether it can be shown right now. */
export function VisualsGallery({ revision, onClose, onShow }: Props) {
  const [items, setItems] = useState<CatalogEntry[] | null>(null);
  const [text, setText] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void call<CatalogEntry[]>("C19", "visuals", { revision }).then((r) => (r.ok ? setItems(r.value) : setError(r.error.message))); }, [revision]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide tall" role="dialog" aria-modal="true" aria-labelledby="gal-title" tabIndex={-1} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <h2 id="gal-title">Visuals <span className="muted small">sixteen ways to see the code; the question you ask picks one, or choose here</span></h2>
        {error && <div className="banner error" role="alert">{error}</div>}
        <ul className="gallery" tabIndex={0} aria-label="Visuals">
          {(items ?? []).map((it) => {
            const q = text[it.code] ?? it.example;
            const isTrace = it.formId === "HypothesisGraph";
            return (
              <li key={it.code} className={it.available ? "" : "off"}>
                <div className="between"><span><span className="chip">{it.code}</span> <strong>{it.name}</strong></span>{!it.available && <span className="badge warn">{it.reason}</span>}</div>
                <p>{it.blurb}</p>
                {isTrace ? <p className="muted small">Paste a stack trace into the conversation to open this view.</p> : (
                  <div className="row">
                    <label className="sr" htmlFor={`g-${it.code}`}>Question for {it.name}</label>
                    <input id={`g-${it.code}`} value={q} onChange={(e) => setText({ ...text, [it.code]: e.target.value })} />
                    <button disabled={!it.available || !q.trim()} title={it.available ? "Show this visual" : it.reason} onClick={() => onShow(it, q)}>Show</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <div className="modal-actions"><span className="muted small">Greyed ones need something the repository does not have yet.</span><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
