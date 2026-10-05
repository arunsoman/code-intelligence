import { useState } from "react";
import { EFFECTFUL_ACTIONS, STAGES, type WizardStage } from "./stages.ts";
import { FIXTURE_REQUEST_ID, buildFixtureWorkspace, localStore, type WizardStore } from "./fixture.ts";
import { advanceWizard, groupTasks, recordDecision, stageGate, statusBanners, type WizardTask, type WizardWorkspace } from "./wizard.ts";

/**
 * "Build feature" (Prompt-to-feature §43, task 1.H). A modal wizard shell over a persistent per-request
 * workspace: six stages, a status banner that follows every stage, §30.2 progress groups, and separate
 * effectful actions. It is fixture-driven until the backend lands (1.C intake, 1.B store, 2.N/3.P stage
 * contents); navigation never runs anything, and no stage claims "verified" — that wording belongs to
 * the eligibility function (task 2.J), which does not exist yet.
 */
export function BuildFeature({ onClose, store }: { onClose: () => void; store?: WizardStore }) {
  const persistence = store ?? localStore();
  const [ws, setWs] = useState<WizardWorkspace>(() => persistence.load(FIXTURE_REQUEST_ID) ?? buildFixtureWorkspace());
  const [note, setNote] = useState<string | null>(null);
  const [impact, setImpact] = useState<string | null>(null);
  const [draftAnswer, setDraftAnswer] = useState<Record<string, string>>({});

  const at = STAGES.findIndex((s) => s.id === ws.stage);
  const gate = stageGate(ws, ws.stage);
  const groups = groupTasks(ws.tasks);
  const banners = statusBanners(ws);
  const progressGroups: { label: string; items: (WizardTask & { independent?: WizardTask[] })[] }[] = [
    { label: "Running", items: groups.running },
    { label: "Ready", items: groups.ready },
    { label: "Blocked", items: groups.blocked },
    { label: "Failed", items: groups.failed },
    { label: "Needs your answer", items: groups.needsAnswer },
  ];

  const commit = (next: WizardWorkspace) => { persistence.save(next); setWs(next); };
  const move = (target: WizardStage) => {
    const r = advanceWizard(ws, target, ws.workspaceVersion);
    if (!r.ok) { setNote(r.error.message); return; }
    setNote(null); setImpact(null);
    commit(r.value);
  };
  const analyse = () => move("CLARIFY");
  const answer = (questionId: string, question: string, stage: WizardStage) => {
    const text = (draftAnswer[questionId] ?? "").trim();
    if (!text) return;
    const { workspace, impact: imp } = recordDecision(ws, { questionId, question, answer: text, stage, actor: "user" });
    commit(workspace);
    setImpact(imp.summary);
    setDraftAnswer((d) => ({ ...d, [questionId]: "" }));
  };

  const latestByQuestion = new Map<string, number>();
  ws.decisions.forEach((d, i) => latestByQuestion.set(d.questionId, i));
  const openQuestions = ws.blockers.filter((b) => b.question).map((b) => b.question!);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Build feature">
      <div className="modal" style={{ maxWidth: 1080, maxHeight: "88vh", overflow: "auto" }} tabIndex={-1} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <header className="row between">
          <h2>Build feature</h2>
          <button className="btn" onClick={onClose}>Close</button>
        </header>

        <p className="row" aria-label="Request summary" style={{ flexWrap: "wrap" }}>
          <span className="chip mono">request {ws.requestId}</span>
          {ws.issueRef && <span className="chip">issue {ws.issueRef}</span>}
          <span className="chip">contract v{ws.contractVersion}</span>
          {ws.candidate && <span className="chip mono">candidate {ws.candidate.hash} · {ws.candidate.status.toLowerCase()}</span>}
          <span className="chip muted">workspace v{ws.workspaceVersion}</span>
          <span className="chip">{ws.outcomeMode.toLowerCase().replaceAll("_", " ")}</span>
        </p>

        <div role="status" aria-live="polite" aria-label="Status banners" style={{ display: "grid", gap: 4 }}>
          {banners.map((b) => <p key={b} className="chip warn" style={{ margin: 0 }}>{b}</p>)}
        </div>
        {impact && <p role="alert" className="banner warn">{impact}</p>}
        {note && <p role="status" className="banner error">{note}</p>}

        <nav aria-label="Stages">
          <ol className="row" style={{ listStyle: "none", padding: 0, gap: 8, flexWrap: "wrap" }}>
            {STAGES.map((s, i) => (
              <li key={s.id}><button className={i === at ? "" : "secondary"} aria-current={i === at ? "step" : undefined} onClick={() => move(s.id)}>{i + 1} {s.label}</button></li>
            ))}
          </ol>
        </nav>

        <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
          <section aria-label={`${STAGES[at].label} stage`} style={{ flex: 2, minWidth: 320 }}>
            <h3>{STAGES[at].label}</h3>
            {gate.disabledReason && <p className="warn">Not ready: {gate.disabledReason}</p>}

            {ws.stage === "DESCRIBE" && (
              <div>
                <label>What should change? <textarea className="input" rows={3} value={ws.prompt} onChange={(e) => commit({ ...ws, prompt: e.target.value, workspaceVersion: ws.workspaceVersion + 1 })} /></label>
                <label>Outcome mode{" "}
                  <select className="input" value={ws.outcomeMode} onChange={(e) => commit({ ...ws, outcomeMode: e.target.value, workspaceVersion: ws.workspaceVersion + 1 })}>
                    <option value="BUILD_AND_PREVIEW">Build and preview</option>
                    <option value="PLAN_ONLY">Plan only</option>
                    <option value="DRAFT_PR">Draft PR</option>
                  </select>
                </label>
                <p className="muted small">Analysing stores the request in a local workspace and moves to Clarify. Analysis itself is fixture-backed until intake lands (task 1.C) — that label stays on every result.</p>
                <button className="btn primary" disabled={!gate.primaryEnabled} onClick={analyse}>Analyse request</button>
              </div>
            )}

            {ws.stage === "CLARIFY" && (
              <div>
                <p className="muted">Decisions keep their actor and can be revised; changing an earlier answer creates a new contract version and marks affected work stale before you move on (that is shown, not silent).</p>
                <ul className="dirs">
                  {ws.decisions.map((d, i) => (
                    <li key={d.id}>
                      <span>{d.question} — <strong>{d.answer}</strong> <span className="chip muted">{d.actor}</span>{latestByQuestion.get(d.questionId) !== i && <span className="chip warn">superseded by {ws.decisions[latestByQuestion.get(d.questionId)!]?.id}</span>}</span>
                      {latestByQuestion.get(d.questionId) === i && (
                        <span className="row" style={{ gap: 4 }}>
                          <input className="input" aria-label={`Change answer to ${d.question}`} placeholder="revise answer" value={draftAnswer[d.questionId] ?? ""} onChange={(e) => setDraftAnswer((x) => ({ ...x, [d.questionId]: e.target.value }))} />
                          <button className="secondary small" disabled={!(draftAnswer[d.questionId] ?? "").trim()} onClick={() => answer(d.questionId, d.question, "CLARIFY")}>Record new version</button>
                        </span>
                      )}
                    </li>
                  ))}
                  {openQuestions.map((q) => (
                    <li key={q}>
                      <span className="warn">{q} — unanswered; it blocks the task listed under “Needs your answer”.</span>
                      <span className="row" style={{ gap: 4 }}>
                        <input className="input" aria-label={`Answer ${q}`} value={draftAnswer[q] ?? ""} onChange={(e) => setDraftAnswer((x) => ({ ...x, [q]: e.target.value }))} />
                        <button className="secondary small" disabled={!(draftAnswer[q] ?? "").trim()} onClick={() => answer(q, ws.blockers.find((b) => b.question === q)?.text ?? q, "CLARIFY")}>Answer</button>
                      </span>
                    </li>
                  ))}
                </ul>
                {ws.decisions.length === 0 && openQuestions.length === 0 && <p className="muted">No questions yet. They appear here when intake (1.C) records them.</p>}
              </div>
            )}

            {ws.stage === "PLAN" && (
              <div>
                <p className="muted">Acceptance criteria and planned work. Criteria counts describe progress, not proof.</p>
                <ul className="dirs">
                  {ws.criteria.map((c) => (
                    <li key={c.id}><span className="chip">{c.validation}</span> <span className="chip muted">{c.implemented ? "implemented" : "not implemented"}</span> {c.id}: {c.text}{!c.mandatory && <span className="chip muted">advisory</span>}</li>
                  ))}
                </ul>
              </div>
            )}

            {ws.stage === "CHANGES" && (
              <div>
                {ws.candidate
                  ? <p>Current candidate <code>{ws.candidate.hash}</code> — {ws.candidate.status.toLowerCase()}. The file inventory, change graph and full code view land with task 2.N; browsing them here will not approve anything.</p>
                  : <p className="muted">No candidate yet.</p>}
              </div>
            )}

            {ws.stage === "VALIDATE" && (
              <div>
                <p className="muted">Per-criterion results bound to the exact candidate. NOT_RUN and INCOMPLETE stay visible — they are never relabelled as passes.</p>
                <ul className="dirs">
                  {ws.criteria.map((c) => <li key={c.id}><span className="chip">{c.validation}</span> {c.id}: {c.text}</li>)}
                </ul>
                {ws.evidence.some((e) => e.status === "STALE") && <p className="warn">Some evidence is stale against contract v{ws.contractVersion}; rerunning validation is required before export.</p>}
              </div>
            )}

            {ws.stage === "DELIVER" && (
              <div>
                <p className="muted">Publication eligibility is computed by task 2.J and does not exist in this shell; nothing here is labelled verified. Export and PR actions below stay disabled until the backend lands and the gates pass.</p>
                <p><span className="chip warn">REVIEW ONLY — VALIDATION INCOMPLETE</span></p>
              </div>
            )}
          </section>

          <section aria-label="Progress" style={{ flex: 1, minWidth: 240 }}>
            <h3>Progress</h3>
            {progressGroups.map(({ label, items }) => (
              <div key={label}>
                <h4>{label} {items.length > 0 && <small>({items.length})</small>}</h4>
                {items.length === 0 ? <p className="muted small">none</p> : (
                  <ul className="dirs">
                    {items.map((t) => (
                      <li key={`${label}-${t.id}`}>
                        <span>{t.label} <span className="chip muted">{t.requirementIds.join(", ")}</span></span>
                        {t.blocker && <span className="small"> — {t.blocker}</span>}
                        {t.question && <span className="small"> question: {t.question}</span>}
                        {t.nextAction && <span className="small"> next: {t.nextAction}</span>}
                        {t.waiting && <span className="chip">waiting: {t.waiting.toLowerCase()}</span>}
                        {t.independent && t.independent.length > 0 && <span className="small"> independent work continuing: {t.independent.map((x) => x.label).join("; ")}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </section>
        </div>

        <footer className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
          <button className="secondary" disabled={at === 0} onClick={() => move(STAGES[at - 1].id)}>Back</button>
          <span className="row" aria-label="Actions that change things (each is its own button)" style={{ flexWrap: "wrap" }}>
            {EFFECTFUL_ACTIONS.map((a) => <button key={a} className="secondary" disabled title="A separate, labelled effectful action — never hidden behind Next. The backend for it lands with tasks 2.N/3.P.">{a}</button>)}
          </span>
          <button disabled={at === STAGES.length - 1} onClick={() => move(STAGES[at + 1].id)} title="Moves the view only; it does not start, approve or publish anything. Blocked prerequisites are shown on the stage.">
            View next stage: {STAGES[at + 1]?.label ?? "—"}
          </button>
        </footer>
      </div>
    </div>
  );
}
