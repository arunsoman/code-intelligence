import { useEffect, useRef, useState } from "react";
import { STAGES, type WizardStage } from "./stages.ts";
import { blankWorkspace, localStore, type WizardStore } from "./store.ts";
import { advanceRemote, openRemote, type RemoteCall } from "./remote.ts";
import { advanceWizard, recordDecision, stageGate, type WizardWorkspace } from "./wizard.ts";
import { MODES, STATUS_WORDS, digestOf, issueLink, landingStage, openQuestions, primaryOf, refKind, retryTask, sectionsOf, stepsOf, summaryNotes, type TaskCard } from "./view.ts";
import { Modal } from "../Modal.tsx";
import "./build.css";
import { FeatureWorkbench, rememberBuildJob } from "./FeatureWorkbench.tsx";
import { ChangeReview, ClarifyReview, PlanReview } from "./ReviewStages.tsx";
import { DeliverReview, ValidateReview } from "./DeliverStages.tsx";

/**
 * "Build feature" (Prompt-to-feature §43, task 1.H). A modal wizard shell over a persistent per-request
 * workspace: six stages, a status banner that follows every stage, §30.2 progress groups, and separate
 * effectful actions. Everything it shows comes from the server; before the server has answered it is empty.
 * Navigation never runs anything, and no stage claims "verified" — that wording belongs to the
 * eligibility function (computeEligibility).
 */
const KEY = (repo: string) => `cie.build.request.${repo}`;
const MODE_OUT: Record<string, string> = { PLAN_ONLY: "PLAN", BUILD_AND_PREVIEW: "BUILD_PREVIEW", DRAFT_PR: "CREATE_DRAFT_PR" };
const uid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

export function BuildFeature({ onClose, store, api, releaseId, initialRequestId }: {
  onClose: () => void; store?: WizardStore;
  /** The server and repository to build against; without it the shell stays empty. */
  api?: { repositoryId: string; call: RemoteCall };
  /** Tag a brand-new request to this release (release-scope.ts's Release) so the Release Board can find it later. */
  releaseId?: string;
  /** Open this exact request instead of whatever this repository's localStorage last remembered — how the Release Board opens a specific row. */
  initialRequestId?: string;
}) {
  const [requestId, setRequestId] = useState<string | null>(() => { if (initialRequestId) return initialRequestId; try { return api ? localStorage.getItem(KEY(api.repositoryId)) : null; } catch { return null; } });
  const currentRequest = useRef(requestId); currentRequest.current = requestId;
  const remote = api && requestId ? { requestId, call: api.call } : undefined;
  const persistence = store ?? localStore();
  const [ws, setWs] = useState<WizardWorkspace>(() => { const w = blankWorkspace(); return { ...w, stage: landingStage(w) }; });
  const [analysing, setAnalysing] = useState(false);
  const intakeAction = useRef<{ identity: string; key: string } | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);
  const [impact, setImpact] = useState<string | null>(null);
  const [draftAnswer, setDraftAnswer] = useState<Record<string, string>>({});

  const [focusQ, setFocusQ] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement | null>());
  useEffect(() => { if (focusQ && ws.stage === "CLARIFY") { inputs.current.get(focusQ)?.focus(); setFocusQ(null); } }, [focusQ, ws.stage]);

  const at = STAGES.findIndex((s) => s.id === ws.stage);
  const gate = stageGate(ws, ws.stage);
  const oq = openQuestions(ws);
  const digest = digestOf(ws);
  const notes = summaryNotes(ws);
  const steps = stepsOf(ws);
  const sections = sectionsOf(ws);
  const primary = primaryOf(ws, draftAnswer);
  const issue = issueLink(ws.issueRef);

  const commit = (next: WizardWorkspace) => { if (next.requestId) persistence.save(next); setWs(next); };
  const refresh = async () => { if (!remote) return; const r = await openRemote(remote.call, { ...ws, workspaceVersion: -1 }, remote.requestId); if (currentRequest.current !== remote.requestId) return; if (r.ok && !r.unchanged) commit(r.value); else if (!r.ok) setNote(r.message); };
  useEffect(() => {
    if (!remote) return;
    let live = true;
    void openRemote(remote.call, ws, remote.requestId).then((r) => { if (!live) return; if (r.ok) { if (!r.unchanged) commit(r.value); } else setNote(r.message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote?.requestId]);
  const refreshRemote = async () => { if (!remote) return; const o = await openRemote(remote.call, { ...ws, workspaceVersion: -1 }, remote.requestId); if (currentRequest.current !== remote.requestId) return; if (o.ok && !o.unchanged) commit(o.value); };
  const move = (target: WizardStage) => {
    if (remote) {
      void advanceRemote(remote.call, ws, target).then((r) => {
        if (r.ok) { setNote(null); setImpact(null); commit(r.value); return; }
        setNote(r.message);
        if (r.conflict) void openRemote(remote.call, { ...ws, workspaceVersion: -1 }, remote.requestId).then((o) => { if (o.ok && !o.unchanged) commit(o.value); });
      });
      return;
    }
    const r = advanceWizard(ws, target, ws.workspaceVersion);
    if (!r.ok) { setNote(r.error.message); return; }
    setNote(null); setImpact(null);
    commit(r.value);
  };
  const analyse = async () => {
    if (!api || requestId) { move("CLARIFY"); return; }
    setAnalysing(true);
    try {
    const identity = JSON.stringify([ws.prompt, ws.outcomeMode, api.repositoryId]);
    if (intakeAction.current?.identity !== identity) intakeAction.current = { identity, key: uid() };
    const key = intakeAction.current.key;
    const sub = await api.call<{ requestId: string; warnings?: string[] }>("C02", "submitFeature", { text: ws.prompt, repositoryId: api.repositoryId, mode: MODE_OUT[ws.outcomeMode] ?? "PLAN", ...(releaseId ? { releaseId } : {}) }, key);
    if (!sub.ok) { setNote(sub.error.message); return; }
    const found = await api.call("C10", "discoverFeatureContext", { requestId: sub.value.requestId, retrievalBudget: { tokens: 8000, files: 5000 } }, uid());
    try { localStorage.setItem(KEY(api.repositoryId), sub.value.requestId); } catch { /* a private window: the request still exists on the server */ }
    setRequestId(sub.value.requestId);
    setNote(found.ok ? (sub.value.warnings ?? []).join(" ") || null : `Request saved, but discovery failed: ${found.error.message}`);
    const o = await openRemote(api.call, { ...ws, requestId: sub.value.requestId, workspaceVersion: -1 }, sub.value.requestId);
    if (!o.ok || o.unchanged) return;
    commit(o.value);
    if (found.ok) {
      const plan = await api.call<{ jobId: string }>("C02", "prepareFeaturePlan", { requestId: sub.value.requestId }, uid());
      if (plan.ok) rememberBuildJob(sub.value.requestId, plan.value.jobId); else setNote(plan.error.message);
    }
    const a = await advanceRemote(api.call, o.value, "CLARIFY");
    if (a.ok) commit(a.value); else setNote(a.message);
    } catch { setNote("Analysis connection failed. Retry to resume the same saved request."); } finally { setAnalysing(false); }
  };
  const answer = (questionId: string, question: string, stage: WizardStage) => {
    const text = (draftAnswer[questionId] ?? "").trim();
    if (!text) return;
    const { workspace, impact: imp } = recordDecision(ws, { questionId, question, answer: text, stage, actor: "user" });
    commit(workspace);
    setImpact(imp.summary);
    setDraftAnswer((d) => ({ ...d, [questionId]: "" }));
  };

  const copy = (text: string) => { try { void navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ } };
  const latestByQuestion = new Map<string, number>();
  ws.decisions.forEach((d, i) => latestByQuestion.set(d.questionId, i));
  const Ref = ({ id }: { id: string }) => {
    const c = ws.criteria.find((x) => x.id === id);
    return <abbr className="chip bf-term" title={`${refKind(id)} ${id}${c ? `: ${c.text}` : ""}`}>{id}</abbr>;
  };
  const goAnswer = (qid: string) => { if (ws.stage !== "CLARIFY") move("CLARIFY"); setFocusQ(qid); };
  const runPrimary = () => {
    if (primary.kind === "SUBMIT_ANSWER") { const q = oq.find((x) => x.id === primary.questionId)!; answer(q.id, `${q.id}: ${q.text}`, "CLARIFY"); }
    else if (primary.kind === "FOCUS_ANSWER") goAnswer(primary.questionId);
    else if (primary.kind === "ANALYSE") void analyse();
    else if (primary.kind === "GO") move(primary.target);
  };
  const primaryDisabled = analysing || primary.kind === "NONE" || (primary.kind === "ANALYSE" && !!primary.disabledReason);
  const Card = ({ c }: { c: TaskCard }) => (
    <li className={`bf-card ${c.tone}`}>
      <div className="bf-head"><span className="chip">{c.chip}</span><span className="bf-name">{c.task.label}</span></div>
      <div className="bf-head">{c.task.requirementIds.map((r) => <Ref key={r} id={r} />)}</div>
      {c.tone === "run" && <div className="bf-bar" role="progressbar" aria-label={`${c.task.label} in progress`}><i /></div>}
      {c.detail && <p className="bf-detail">{c.detail}</p>}
      {c.task.nextAction && c.action?.kind !== "ANSWER" && <p className="bf-next"><strong>Next:</strong> {c.task.nextAction}</p>}
      {c.action && (
        <div className="bf-btns">
          {c.action.kind === "ANSWER" && <button className="secondary small" onClick={() => goAnswer(c.action!.questionId!)}>{c.action.label} →</button>}
          {c.action.kind === "RETRY" && <button className="secondary small" onClick={() => commit(retryTask(ws, c.task.id))}>Retry</button>}
        </div>
      )}
    </li>
  );

  return (
    <Modal title="Build feature" onClose={onClose} className="bf-dialog"
      actions={<>
        <button className="secondary" disabled={at === 0} onClick={() => move(STAGES[at - 1].id)}>← {at > 0 ? STAGES[at - 1].label : "Back"}</button>
        <span className="bf-grow" />
        <button className="secondary" onClick={() => void refresh().catch(() => setNote("Could not refresh the saved request."))}>Refresh saved state</button>
        {requestId && <button className="secondary" disabled={analysing} onClick={() => { try { if (api) localStorage.removeItem(KEY(api.repositoryId)); } catch {} setRequestId(null); intakeAction.current = undefined; commit(blankWorkspace()); setNote(null); }}>New feature</button>}
        <button className={primary.kind === "ANALYSE" ? undefined : "secondary"} disabled={primaryDisabled} title={primary.kind === "ANALYSE" ? primary.disabledReason ?? undefined : undefined} onClick={runPrimary}>{analysing ? "Analysing…" : primary.label}</button>
      </>}>
      <div className="bf-top">
          <div className="bf-chiprow" aria-label="Source">
            <span className="bf-label">Source</span>
            <span className="chip" title="The request this wizard follows">request {ws.requestId}</span>
            {issue && (issue.href ? <a className="chip" href={issue.href} target="_blank" rel="noreferrer noopener">issue {issue.text} ↗</a> : <span className="chip" title="No tracker link is available for this issue reference">issue {issue.text}</span>)}
            <span className="chip" title="The agreed requirements and acceptance criteria. Changing an answer creates a new version.">contract v{ws.contractVersion}</span>
          </div>
          <div className="bf-chiprow" aria-label="State">
            <span className="bf-label">State</span>
            {ws.candidate ? <span className="chip" title="A candidate is a saved set of proposed changes; it has not been applied to your files.">candidate {STATUS_WORDS[ws.candidate.status]}</span> : <span className="chip">no candidate yet</span>}
            <label className="bf-chiprow" style={{ gap: 4 }}><span className="sr">Outcome mode</span>
              <span className="chip" title={MODES.find((m) => m.value === ws.outcomeMode)?.explain}>mode: {MODES.find((m) => m.value === ws.outcomeMode)?.label ?? ws.outcomeMode}</span>
            </label>
            <details className="bf-details">
              <summary className="chip" style={{ cursor: "pointer" }}>Details</summary>
              <div className="bf-pop" role="region" aria-label="Identifiers">
                {[["Request", ws.requestId], ["Candidate", ws.candidate?.hash ?? "—"], ["Workspace version", `v${ws.workspaceVersion}`], ["Contract version", `v${ws.contractVersion}`]].map(([k, v]) => (
                  <div className="bf-kv" key={k}><span className="muted">{k}</span><code>{v}</code><button className="secondary small" onClick={() => copy(v!)} aria-label={`Copy ${k}`}>Copy</button></div>
                ))}
              </div>
            </details>
          </div>

          {oq.length > 0 && (
            <div className="bf-decision" role="region" aria-label="Decision needed">
              <div className="bf-q">
                <span className="chip warn">Needs your answer{oq.length > 1 ? ` (${oq.length})` : ""}</span>
                <strong>{oq[0]!.id}: {oq[0]!.text}</strong>
                <span className="muted small">{oq[0]!.blockedTasks.length ? `Blocks: ${oq[0]!.blockedTasks.join("; ")}. ` : ""}Everything that does not depend on it keeps running.</span>
              </div>
              <button className="secondary" onClick={() => goAnswer(oq[0]!.id)}>Answer {oq[0]!.id} →</button>
            </div>
          )}

          <div className="bf-digest" role="status" aria-live="polite" aria-label="Status summary">
            {digest.needsAnswer > 0 && <span className="bf-pill blocked">⛔ {digest.needsAnswer} needs your answer</span>}
            {digest.blocked - digest.needsAnswer > 0 && <span className="bf-pill blocked">⛔ {digest.blocked - digest.needsAnswer} blocked</span>}
            {digest.running > 0 && <span className="bf-pill">▶ {digest.running} running</span>}
            {digest.ready > 0 && <span className="bf-pill">⏳ {digest.ready} ready</span>}
            {digest.failed > 0 && <span className="bf-pill blocked">✗ {digest.failed} failed</span>}
            <span className="bf-pill" title="Acceptance criteria that passed. This is progress, not proof.">{digest.criteria.passed}/{digest.criteria.total} criteria passed</span>
            {digest.stale && <span className="bf-pill blocked">stale work</span>}
          </div>
          <div className="bf-notes">
            {notes.shown.map((n) => <p key={n.text} className={`bf-note ${n.severity}`}><span className="sr">{n.severity}: </span>{n.text}</p>)}
            {notes.all.length > notes.shown.length && (
              <details><summary className="muted small" style={{ cursor: "pointer" }}>Show all {notes.all.length} status notes</summary>
                {notes.all.map((n) => <p key={n.text} className={`bf-note ${n.severity}`}>{n.text}</p>)}
              </details>
            )}
          </div>
          {impact && <p role="alert" className="bf-banner warn">{impact}</p>}
          {note && <p role="status" className="bf-banner">{note}</p>}

          <nav aria-label="Stages">
            <ol className="bf-steps">
              {steps.map((s) => (
                <li key={s.id}>
                  <button className={`secondary ${s.state}`} aria-current={s.state === "current" ? "step" : undefined} title={s.hint ?? undefined} onClick={() => move(s.id)}>
                    <span className="bf-g" aria-hidden="true">{s.glyph}</span><span className="bf-lbl">{s.index} {s.label}</span><span className="sr">, {s.word}{s.hint ? `: ${s.hint}` : ""}</span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        </div>

        <div className="bf-body">
          <section className="bf-col" aria-label={`${STAGES[at].label} stage`}>
            <h3>{STAGES[at].label}</h3>
            {api && <FeatureWorkbench key={ws.requestId} ws={ws} repositoryId={api.repositoryId} call={api.call} refresh={refreshRemote} notify={setNote} />}
            {gate.disabledReason && ws.stage !== "DESCRIBE" && ws.stage !== "CLARIFY" && <p className="muted small">Not ready for its main action: {gate.disabledReason}</p>}

            {ws.review && remote && ws.stage === "CLARIFY" && <ClarifyReview review={ws.review} version={ws.contractVersion} requestId={remote.requestId} call={remote.call} refresh={refreshRemote} notify={setNote} />}
            {ws.review && remote && ws.stage === "PLAN" && <PlanReview review={ws.review} />}
            {ws.review && remote && ws.stage === "CHANGES" && <ChangeReview review={ws.review} requestId={remote.requestId} candidateHash={ws.candidate?.hash} call={remote.call} />}
            {ws.stage === "DESCRIBE" && (
              <div className="bf-stack">
                {requestId && <p className="muted">This is the saved feature request. Use New feature to describe a different change.</p>}
                <label className="bf-field">What feature is missing?
                  <textarea disabled={!!requestId} placeholder="Describe who needs the feature, what they should be able to do, and an example of the expected result." className="bf-textarea" rows={Math.min(8, Math.max(3, ws.prompt.split("\n").length + Math.ceil(ws.prompt.length / 90)))} value={ws.prompt} onChange={(e) => commit({ ...ws, prompt: e.target.value, workspaceVersion: ws.workspaceVersion + 1 })} />
                </label>
                <label className="bf-field">Outcome
                  <select disabled={!!requestId} className="bf-select" value={ws.outcomeMode} onChange={(e) => commit({ ...ws, outcomeMode: e.target.value, workspaceVersion: ws.workspaceVersion + 1 })}>
                    {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                  <p className="bf-help">{MODES.find((m) => m.value === ws.outcomeMode)?.explain}</p>
                </label>
              </div>
            )}

            {ws.stage === "CLARIFY" && !(ws.review && remote) && (
              <div className="bf-stack">
                {oq.map((q, i) => (
                  <div key={q.id} className="bf-item" role="group" aria-label={`Question ${q.id}`}>
                    <span className="chip warn">{q.id} · question {i + 1} of {oq.length} · needs your answer</span>
                    <strong>{q.text}</strong>
                    <span className="muted small">{q.context}</span>
                    {q.blockedTasks.length > 0 && <span className="small">Unblocks: {q.blockedTasks.join("; ")}</span>}
                    <input ref={(el) => { inputs.current.set(q.id, el); }} className="bf-input" aria-label={`Answer to ${q.id}: ${q.text}`} placeholder="Type your answer" value={draftAnswer[q.id] ?? ""}
                      onChange={(e) => setDraftAnswer((x) => ({ ...x, [q.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter" && (draftAnswer[q.id] ?? "").trim()) answer(q.id, `${q.id}: ${q.text}`, "CLARIFY"); }} />
                    <div className="bf-btns"><button className="secondary small" disabled={!(draftAnswer[q.id] ?? "").trim()} onClick={() => answer(q.id, `${q.id}: ${q.text}`, "CLARIFY")}>Submit answer</button></div>
                  </div>
                ))}
                {oq.length === 0 && ws.decisions.length === 0 && <p className="muted">No questions yet. They appear here once the request has been analysed.</p>}
                {ws.decisions.length > 0 && <h4 style={{ margin: "4px 0 0", fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" }}>Answered</h4>}
                <ul className="bf-list">
                  {ws.decisions.map((d, i) => {
                    const latest = latestByQuestion.get(d.questionId) === i;
                    return (
                      <li key={d.id} className={`bf-item ${latest ? "" : "superseded"}`}>
                        <span>{d.question}</span>
                        <span><strong>{d.answer}</strong> <span className="chip muted">{d.actor}</span>{!latest && <span className="chip warn">replaced by {ws.decisions[latestByQuestion.get(d.questionId)!]?.id}</span>}</span>
                        {latest && (
                          <details>
                            <summary className="muted small" style={{ cursor: "pointer" }}>Change this answer (creates a new contract version)</summary>
                            <div className="bf-btns" style={{ marginTop: 6 }}>
                              <input className="bf-input" aria-label={`Change answer to ${d.question}`} placeholder="New answer" value={draftAnswer[d.questionId] ?? ""} onChange={(e) => setDraftAnswer((x) => ({ ...x, [d.questionId]: e.target.value }))} />
                              <button className="secondary small" disabled={!(draftAnswer[d.questionId] ?? "").trim()} onClick={() => answer(d.questionId, d.question, "CLARIFY")}>Record new version</button>
                            </div>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {ws.stage === "PLAN" && !(ws.review && remote) && (
              <div className="bf-stack">
                <p className="muted">Acceptance criteria and planned work. Passing counts describe progress, not proof.</p>
                <ul className="bf-list">
                  {ws.criteria.map((c) => (
                    <li key={c.id} className="bf-item"><span><Ref id={c.id} /> <span className="chip">{c.validation.replaceAll("_", " ").toLowerCase()}</span> <span className="chip muted">{c.implemented ? "implemented" : "not implemented"}</span>{!c.mandatory && <span className="chip muted">advisory</span>}</span><span>{c.text}</span></li>
                  ))}
                </ul>
              </div>
            )}

            {ws.stage === "CHANGES" && !(ws.review && remote) && (
              <div className="bf-stack">
                {ws.candidate
                  ? <p>The current candidate is <strong>{STATUS_WORDS[ws.candidate.status]}</strong>. The file list, change graph and code view arrive with task 2.N; looking at them will never approve anything.</p>
                  : <p className="muted">No candidate yet.</p>}
              </div>
            )}

            {ws.review?.dashboard && remote && ws.stage === "VALIDATE" && <ValidateReview review={ws.review} candidateHash={ws.candidate?.hash} call={remote.call} refresh={refreshRemote} notify={setNote} />}
            {ws.review?.deliver && remote && ws.stage === "DELIVER" && <DeliverReview review={ws.review} call={remote.call} refresh={refreshRemote} notify={setNote} />}
            {ws.stage === "VALIDATE" && !(ws.review?.dashboard && remote) && (
              <div className="bf-stack">
                <p className="muted">Per-criterion results for the current candidate. “Not run” and “incomplete” stay visible; they are never shown as passes.</p>
                <ul className="bf-list">{ws.criteria.map((c) => <li key={c.id} className="bf-item"><span><Ref id={c.id} /> <span className="chip">{c.validation.replaceAll("_", " ").toLowerCase()}</span></span><span>{c.text}</span></li>)}</ul>
                {ws.evidence.some((e) => e.status === "STALE") && <p className="bf-banner warn">Some evidence is stale against contract v{ws.contractVersion}; validation must be rerun before export.</p>}
              </div>
            )}

            {ws.stage === "DELIVER" && !(ws.review?.deliver && remote) && (
              <div className="bf-stack">
                <p className="muted">Whether this can be published is decided by the publication check (task 2.J), which is not connected yet, so nothing here is called verified.</p>
                <p><span className="chip warn">Review only — validation incomplete</span></p>
              </div>
            )}
          </section>

          <details className="bf-col bf-progress" aria-label="Progress">
            <summary>Detailed task progress</summary>
            {sections.map((sec) => (
              <div key={sec.key} className="bf-sect">
                <h4>{sec.label} {sec.cards.length > 0 ? `(${sec.cards.length})` : ""}</h4>
                {sec.cards.length === 0 ? <p className="bf-none">None</p> : <ul className="bf-list">{sec.cards.map((c) => <Card key={c.task.id} c={c} />)}</ul>}
                {sec.key === "blocked" && digest.needsAnswer > 0 && <p className="bf-none">{digest.needsAnswer} of these need your decision; the question is pinned at the top.</p>}
              </div>
            ))}
          </details>
        </div>

    </Modal>
  );
}
