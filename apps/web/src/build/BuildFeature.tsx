import { useState } from "react";
import { EFFECTFUL_ACTIONS, STAGES, type WizardStage } from "./stages.ts";

/**
 * "Build feature" (Prompt-to-feature §43). Scaffold only: the six stages, the persistent status banner and the
 * separate effectful actions are in place; the stage contents arrive with tasks 1.H and 2.N. Navigation never runs
 * anything, and the banner never says "verified" until the eligibility function (task 2.J) computes it.
 */
export function BuildFeature({ onClose }: { onClose: () => void }) {
  const [stage, setStage] = useState<WizardStage>("DESCRIBE");
  const at = STAGES.findIndex((s) => s.id === stage);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Build feature">
      <div className="modal" style={{ maxWidth: 1080, maxHeight: "88vh", overflow: "auto" }} tabIndex={-1} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <header className="row between"><h2>Build feature</h2><button className="btn" onClick={onClose}>Close</button></header>
        <p role="status" className="chip">NOT IMPLEMENTED — scaffold only. Nothing is built, validated or verified.</p>
        <nav aria-label="Stages">
          <ol className="row" style={{ listStyle: "none", padding: 0, gap: 8 }}>
            {STAGES.map((s, i) => (
              <li key={s.id}><button className={i === at ? "" : "secondary"} aria-current={i === at ? "step" : undefined} onClick={() => setStage(s.id)}>{i + 1} {s.label}</button></li>
            ))}
          </ol>
        </nav>
        <section aria-label={`${STAGES[at].label} stage`}>
          <h3>{STAGES[at].label}</h3>
          <p className="muted">This stage is not built yet. Primary action when it is: {STAGES[at].primary}.</p>
        </section>
        <footer className="row between">
          <button className="secondary" disabled={at === 0} onClick={() => setStage(STAGES[at - 1].id)}>Back</button>
          <span className="row" aria-label="Actions that change things (each is its own button)">
            {EFFECTFUL_ACTIONS.map((a) => <button key={a} className="secondary" disabled title="Not available yet">{a}</button>)}
          </span>
          <button disabled={at === STAGES.length - 1} onClick={() => setStage(STAGES[at + 1].id)} title="Moves the view only; it does not start, approve or publish anything">View next stage</button>
        </footer>
      </div>
    </div>
  );
}
