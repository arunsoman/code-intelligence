import { useEffect, useState } from "react";
import { call } from "./api.ts";
import { Loading } from "./Skeleton.tsx";
import { Modal } from "./Modal.tsx";
import { CHART_REGISTRY, type ChartId } from "@cie/schema";

export interface CatalogEntry { code: string; formId: string; name: string; blurb: string; example: string; needs: string[]; available: boolean; reason?: string }
interface Props { revision?: string; onClose: () => void; onShow: (entry: CatalogEntry, question: string) => void }

export const SYSTEM_CHARTS: Pick<CatalogEntry, "code" | "formId" | "name" | "blurb" | "example" | "needs">[] = Object.values(CHART_REGISTRY)
  .filter((d) => d.id !== "generic" && d.compiler !== "missing")
  .map((d) => ({ code: d.id, formId: d.form, name: d.name, blurb: d.description, example: d.example, needs: [...d.needs] }));

/** All sixteen forms from the spec's catalogue, each with what it answers, what it needs, and whether it can be shown right now. */
export function VisualsGallery({ revision, onClose, onShow }: Props) {
  const [items, setItems] = useState<CatalogEntry[] | null>(null);
  // Shared editable-question state for both system charts and built-in visuals, keyed by chart code.
  const [text, setText] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void call<CatalogEntry[]>("C19", "visuals", { revision }).then((r) => (r.ok ? setItems(r.value) : setError(r.error.message))); }, [revision]);

  return (
    <Modal title="Visuals" onClose={onClose} className="wide tall"
      actions={<><span className="muted small">Greyed ones need something the repository does not have yet.</span><button onClick={onClose}>Done</button></>}>
      <p className="muted small">Choose a built-in analysis or a focused system-design view. Edit the question before clicking Show to tailor it to your codebase.</p>
      {error && <div className="banner error" role="alert">{error}</div>}

      {/* ── System-design charts (S1–S28) ────────────────────────────────────────────── */}
      <div className="gallery-section-header">
        <h3>System-design charts</h3>
        <p className="muted small">Focused views for exploring a codebase's structure, behavior and data: architecture, sequences, state machines, event flows, ER diagrams, DFDs, decision tables, saga graphs, outbox topology, idempotency guarantees, DI wiring, class/package/communication/interaction-overview diagrams, CRC cards, call and module graphs, layered views, transition tables, FMEA and metrics maps, system context and sequence notation. Each renders on the interactive canvas with zoom, click-to-inspect, and evidence links. All 35 standard diagram types are covered by S1–S28 here and by the built-in V1–V19 visuals below (types like the race-condition timeline, threat model, test traceability and profiling views live in the built-ins).</p>
      </div>
      <ul className="gallery" tabIndex={0} aria-label="System-design charts">
        {SYSTEM_CHARTS.map((chart) => {
          const testVisual = chart.formId === "TestConfidence" ? items?.find((item) => item.formId === "TestConfidence") : undefined;
          const compilerAvailable = CHART_REGISTRY[chart.code as ChartId]?.compiler !== "missing";
          const available = !!revision && compilerAvailable && (chart.formId !== "TestConfidence" || !!testVisual?.available);
          const reason = !revision
            ? "index a repository first"
            : !compilerAvailable
              ? "chart compiler is not implemented yet"
            : chart.formId === "TestConfidence"
              ? (testVisual?.reason ?? "loading test availability")
              : undefined;
          const name = CHART_REGISTRY[chart.code as ChartId]?.name ?? chart.name;
          const entry: CatalogEntry = { ...chart, name, available, ...(reason ? { reason } : {}) };
          const q = text[chart.code] ?? chart.example;
          const isTrace = chart.formId === "HypothesisGraph";
          return (
            <li key={chart.code} className={available ? "" : "off"}>
              <div className="between">
                <span><span className="chip system-chip">{chart.code}</span> <strong>{name}</strong></span>
                {!available && <span className="badge warn">{reason}</span>}
              </div>
              <p>{chart.blurb}</p>
              {isTrace
                ? <p className="muted small">Paste a stack trace into the conversation to open this view.</p>
                : (
                  <div className="row">
                    <label className="sr" htmlFor={`g-${chart.code}`}>Question for {name}</label>
                    <input
                      id={`g-${chart.code}`}
                      value={q}
                      onChange={(e) => setText({ ...text, [chart.code]: e.target.value })}
                      title="Edit the question to match your codebase before showing"
                    />
                    <button
                      disabled={!available || !q.trim()}
                      title={available ? "Render this view on the interactive canvas" : reason}
                      onClick={() => onShow(entry, q)}
                    >Show</button>
                  </div>
                )}
            </li>
          );
        })}
      </ul>

      {/* ── Built-in visuals (V1–V19) ─────────────────────────────────────────────────── */}
      <div className="gallery-section-header">
        <h3>Built-in visuals</h3>
      </div>
      <Loading pending={items === null && !error} label="Loading the visuals catalogue" rows={3} lines={2} />
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
    </Modal>
  );
}
