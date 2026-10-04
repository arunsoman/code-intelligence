import { useEffect, useRef, useState } from "react";
import type { ResolvedEvidence } from "@cie/schema";
import type { InvestigationDetails, InvestigationSnapshot } from "../../../packages/core/src/c22/types.ts";
import { call } from "./api.ts";
import { comparison, discriminates } from "./investigation.ts";

const read = <T,>(op: string, body: unknown) => call<T>("C22", op, body, undefined, "v2");
const write = <T,>(op: string, body: unknown) => call<T>("C22", op, body, crypto.randomUUID(), "v2");
const words = (s: string) => s.toLowerCase().replaceAll("_", " ");

export function InvestigationPanel({ revision, workspaceId, initialQuestion, entityRefs, onClose }: {
  revision: string; workspaceId: string; initialQuestion: string; entityRefs: string[]; onClose: () => void;
}) {
  const [items, setItems] = useState<InvestigationSnapshot[]>([]);
  const [id, setId] = useState("");
  const [data, setData] = useState<InvestigationDetails | null>(null);
  const [question, setQuestion] = useState(initialQuestion.slice(0, 500));
  const [trace, setTrace] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState("");
  const [evidence, setEvidence] = useState<ResolvedEvidence | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const evidenceRequest = useRef(0);
  const command = useRef(false);
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { alive.current = false; previous?.focus(); };
  }, []);

  useEffect(() => {
    let live = true;
    void read<{ items: InvestigationSnapshot[] }>("list", { workspaceId, limit: 100 }).then((r) => {
      if (!live) return;
      if (r.ok) setItems(r.value.items); else setError(r.error.message);
    });
    return () => { live = false; };
  }, [workspaceId, refresh]);

  useEffect(() => {
    if (!id) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const r = await read<InvestigationDetails>("getDetails", { investigationId: id });
      if (!live) return;
      if (r.ok) {
        setPollError(null);
        setData((prior) => prior && prior.snapshot.id === id && prior.snapshot.version > r.value.snapshot.version ? prior : r.value);
      } else {
        setData(null); setEvidence(null); setEvidenceError(null); setEvidenceLoading(false); evidenceRequest.current++;
        setPollError(r.error.message);
      }
      timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [id, refresh]);

  function open(next: string) {
    setId(next); setData(null); setSelected(""); setEvidence(null); setEvidenceError(null); setEvidenceLoading(false);
    evidenceRequest.current++; setError(null); setPollError(null); setNotice(null);
  }

  async function mutate(op: string, body: unknown) {
    if (command.current) return;
    command.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const r = await write<InvestigationSnapshot>(op, body);
      if (!alive.current) return;
      if (r.ok) {
        if (op === "create") open(r.value.id);
        setNotice(op === "advanceV2" ? "A bounded wave of up to 8 read-only steps was queued. Progress updates automatically." : "Saved.");
      } else setError(`${r.error.code}: ${r.error.message}${r.error.code === "VERSION_CONFLICT" ? " The board is refreshing; review it before trying again." : ""}`);
      setRefresh((n) => n + 1);
    } finally { command.current = false; if (alive.current) setBusy(false); }
  }
  const snapshot = data?.snapshot;
  const act = (op: string) => snapshot && void mutate(op, { investigationId: snapshot.id, expectedVersion: snapshot.version, maximumStepsThisWave: 8, reason: "Paused from investigation board" });
  const hypotheses = data?.hypotheses ?? [];
  const chosen = hypotheses.find((h) => h.id === selected);
  const completed = data?.steps.filter((s) => ["SUCCEEDED", "FAILED", "CANCELLED", "SUPERSEDED"].includes(s.state)).length ?? 0;
  async function inspectEvidence(evidenceId: string) {
    if (!snapshot) return;
    const request = ++evidenceRequest.current;
    setEvidence(null); setEvidenceError(null); setEvidenceLoading(true);
    const r = await call<ResolvedEvidence>("C18", "evidence", { revision: snapshot.scope.revision, evidenceId });
    if (!alive.current || request !== evidenceRequest.current) return;
    setEvidenceLoading(false);
    if (r.ok) setEvidence(r.value); else setEvidenceError(r.error.message);
  }
  const evidenceLinks = (ids: string[]) => ids.length ? ids.map((eid) => <button key={eid} className="link small" onClick={() => void inspectEvidence(eid)}>{eid}</button>) : <span className="muted">No source citation</span>;

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    if (e.key !== "Tab") return;
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter((x) => x.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }

  return <div className="modal-backdrop"><section ref={dialog} className="modal investigation-panel" role="dialog" aria-modal="true" aria-label="Investigations" onKeyDown={onKey}>
    <div className="defect-heading"><h2>Investigations</h2><button onClick={onClose}>Close investigations</button></div>
    <p className="muted small">Saved investigations in this workspace. Each stays pinned to its original revision. Priority is an order for investigation, not a probability.</p>
    <label htmlFor="investigation-select">Open investigation</label>
    <select id="investigation-select" disabled={busy} value={id} onChange={(e) => open(e.target.value)}>
      <option value="">Choose an investigation</option>
      {items.map((item) => <option key={item.id} value={item.id}>{item.goal.question} — {words(item.execution)}</option>)}
    </select>
    <button className="secondary small" disabled={busy} onClick={() => { setError(null); setRefresh((n) => n + 1); }}>Refresh investigations</button>
    {items.length === 100 && <p className="muted small">Showing the 100 most recent investigations in this workspace.</p>}
    <details open={!id}><summary>New investigation</summary>
      <form onSubmit={(e) => { e.preventDefault(); void mutate("create", { workspaceId, revision, goal: { question, entityRefs, ...(trace.trim() ? { trace } : {}) } }); }}>
        <label htmlFor="investigation-question">Question</label><input id="investigation-question" required maxLength={500} value={question} onChange={(e) => setQuestion(e.target.value)} />
        <label htmlFor="investigation-trace">Stack trace (optional)</label><textarea id="investigation-trace" rows={3} value={trace} onChange={(e) => setTrace(e.target.value)} />
        <p className="muted small">Starts with {entityRefs.length} selected code reference(s). A trace can identify additional starting points.</p>
        <button disabled={busy || !question.trim()}>Create investigation</button>
      </form>
    </details>
    {busy && <p role="status">Saving…</p>}
    {error && <p role="alert">{error}</p>}
    {pollError && <p role="alert">{pollError}</p>}
    {notice && <p role="status">{notice}</p>}
    {id && !data && !error && !pollError && <p role="status">Loading investigation…</p>}
    {snapshot && data && <>
      <h3>{snapshot.goal.question}</h3>
      <p className="investigation-status" role="status">{words(snapshot.execution)} · {words(snapshot.disposition)} · {snapshot.closure === "FINALIZED" ? "finalized" : "open"} · version {snapshot.version}</p>
      <p className="small muted">Revision {snapshot.scope.revision}{snapshot.scope.revision !== revision ? " — different from the current map" : ""}. Steps completed: {completed}/{data.steps.length}. Read budget used: {snapshot.budget.consumed.toolSteps}/{snapshot.budget.limit.toolSteps}.</p>
      <div className="row">
        <button disabled={busy || snapshot.closure !== "OPEN" || !["READY", "WAITING"].includes(snapshot.execution)} onClick={() => act("advanceV2")}>Run next checks</button>
        <button className="secondary" disabled={busy || snapshot.closure !== "OPEN" || !["READY", "RUNNING", "WAITING"].includes(snapshot.execution)} onClick={() => act("pause")}>Pause investigation</button>
        <button className="secondary" disabled={busy || snapshot.closure !== "OPEN" || snapshot.execution !== "PAUSED"} onClick={() => act("resume")}>Resume investigation</button>
      </div>
      {snapshot.stopReason && <p>Stopped: {words(snapshot.stopReason)}.</p>}
      {snapshot.waitingFor && <p>Waiting for {snapshot.waitingFor.what}.</p>}
      <h3>Competing hypotheses</h3>
      {!hypotheses.length && <p>No hypotheses yet. Run the next checks to seed candidates from the indexed code.</p>}
      <ul className="cards investigation-hypotheses">{hypotheses.map((h) => <li key={h.id} className="card">
        <button className="link" aria-pressed={selected === h.id} onClick={() => setSelected(h.id)}>{h.statement}</button>
        <p><strong>{words(h.evaluation.state)}</strong> · {words(h.evaluation.freshness)}{h.evaluation.disputed ? " · disputed" : ""} · Priority {h.evaluation.rank.investigationPriority.toFixed(2)}</p>
        <p className="small">{h.evaluation.independentSupportGroups} independent supporting group(s), {h.evaluation.independentContradictionGroups} contradicting group(s).</p>
      </li>)}</ul>
      {chosen && <section aria-label="Hypothesis details" className="card">
        <h3>{chosen.statement}</h3>
        <p>{chosen.evaluation.rank.reasons.join(" · ")}</p>
        <p>{chosen.evaluation.reasonCodes.map(words).join(" · ")}</p>
        <p>{chosen.evaluation.calibration.kind === "Uncalibrated" ? `Probability not estimated: ${chosen.evaluation.calibration.reason}` : `Calibrated probability: ${Math.round(chosen.evaluation.calibration.probability * 100)}%`}</p>
        <h3>Predictions</h3><ul>{chosen.predictions.map((p) => <li key={p.id}>{p.description}{p.essentialForHypothesis ? " (essential)" : ""}</li>)}</ul>
        <h3>Assumptions</h3><ul>{chosen.assumptions.map((a) => <li key={a.id}>{a.statement} — {words(a.verification)}</li>)}</ul>
        <h3>Basis evidence</h3>{evidenceLinks(chosen.basisEvidenceIds)}
      </section>}
      <h3>Evidence comparison</h3>
      <p className="muted small">Discriminating rows support one hypothesis and contradict another. Repeated observations from one source share a correlation group; empty cells do not refute a hypothesis.</p>
      <div className="investigation-table" tabIndex={0} role="region" aria-label="Hypotheses compared against observations">
        <table className="gates"><caption>Observations × hypotheses</caption><thead><tr><th scope="col">Observation</th>{hypotheses.map((h, i) => <th scope="col" key={h.id}><button className="link" onClick={() => setSelected(h.id)}>H{i + 1}: {h.statement}</button></th>)}</tr></thead>
          <tbody>{data.observations.map((o) => <tr key={o.id} className={discriminates(hypotheses, o, data.assessments) ? "discriminating" : ""}>
            <th scope="row">{o.description}{o.retracted && " (retracted)"}{discriminates(hypotheses, o, data.assessments) && <strong> · Discriminating</strong>}
              <div className="small muted">{words(o.kind)} · {words(o.quality.completeness)} coverage · {words(o.quality.sampling)} sampling · group {o.correlationGroupId}</div>{evidenceLinks(o.evidenceIds)}</th>
            {hypotheses.map((h) => { const cell = comparison(h, o, data.assessments); return <td key={h.id}>{cell.label}{cell.reasons.length > 0 && <details><summary>Assessment reasons</summary>{cell.reasons.map(words).join(" · ")}</details>}</td>; })}
          </tr>)}</tbody></table>
      </div>
      {!data.observations.length && <p>No observations have been collected yet.</p>}
      <details><summary>Check progress ({completed}/{data.steps.length})</summary><ul>{data.steps.map((s) => <li key={s.id}>{data.checks.find((c) => c.id === s.checkId)?.description ?? (s.toolId === "internal.seed" ? "Seed competing hypotheses" : s.toolId === "internal.assess" ? "Assess evidence" : s.toolId)} — {words(s.state)}{s.unavailableReason ? `: ${s.unavailableReason}` : ""}</li>)}</ul></details>
      <details><summary>Coverage and gaps ({snapshot.coverage.missing.length})</summary><p>{words(snapshot.coverage.completeness)} coverage. A supported candidate does not prove there are no other causes.</p><ul>{snapshot.coverage.missing.map((g) => <li key={g.id}>{g.description} — {words(g.reason)}</li>)}</ul></details>
    </>}
    {evidenceLoading && <p role="status">Loading evidence…</p>}
    {evidenceError && <p role="alert">{evidenceError}</p>}
    {evidence && <section className="evidence" aria-label="Investigation evidence"><h3>{evidence.file}:{evidence.startLine}</h3><p>{evidence.class} · {evidence.state}</p><pre tabIndex={0}>{evidence.snippet || "Source text unavailable."}</pre></section>}
  </section></div>;
}
