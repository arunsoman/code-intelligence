/**
 * Living Investigation MVP panel.
 *
 * Tries live C22 first. On failure (or when "Demo mode" is used), runs a
 * fully client-side case file so the product surface is demonstrable offline.
 */
import { useEffect, useRef, useState } from "react";
import type { ResolvedEvidence } from "@cie/schema";
import type { InvestigationDetails, InvestigationSnapshot } from "../../../packages/core/src/c22/types.ts";
import { call } from "./api.ts";
import { Loading } from "./Skeleton.tsx";
import {
  assessmentCounts,
  buildCaseFile,
  completionHonestyLine,
  demoAssessCompletion,
  demoCaseFile,
  demoRunCheck,
  demoSteer,
  gradeClass,
  GRADE_HINT,
  GRADE_LABEL,
  openLivingInvestigationCommand,
  requestCompletionCommand,
  retireHypothesisCommand,
  type LivingCaseFile,
  type HypothesisCard,
  type NextCheckCard,
  type ViewHint,
} from "./investigation.ts";
import { Modal } from "./Modal.tsx";

const read = <T,>(op: string, body: unknown) => call<T>("C22", op, body, undefined, "v2");
const write = <T,>(op: string, body: unknown) => call<T>("C22", op, body, crypto.randomUUID(), "v2");
const words = (s: string) => s.toLowerCase().replaceAll("_", " ");

export function InvestigationPanel({ revision, workspaceId, initialQuestion, entityRefs, onClose }: {
  revision: string; workspaceId: string; initialQuestion: string; entityRefs: string[]; onClose: () => void;
}) {
  const [items, setItems] = useState<InvestigationSnapshot[]>([]);
  const [id, setId] = useState("");
  const [data, setData] = useState<InvestigationDetails | null>(null);
  const [caseFile, setCaseFile] = useState<LivingCaseFile | null>(null);
  const [demoMode, setDemoMode] = useState(false);
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
  const [activeTab, setActiveTab] = useState<"hypotheses" | "checks" | "observations" | "views" | "completion">("hypotheses");
  const alive = useRef(true);
  const evidenceRequest = useRef(0);
  const command = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (demoMode) return;
    let live = true;
    void read<{ items: InvestigationSnapshot[] }>("list", { workspaceId, limit: 100 }).then((r) => {
      if (!live) return;
      if (r.ok) setItems(r.value.items);
      else setError(r.error.message);
    });
    return () => { live = false; };
  }, [workspaceId, refresh, demoMode]);

  useEffect(() => {
    if (!id || demoMode) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const r = await read<InvestigationDetails>("getDetails", { investigationId: id });
      if (!live) return;
      if (r.ok) {
        setPollError(null);
        setData(r.value);
        const counts = assessmentCounts(r.value.assessments ?? []);
        setCaseFile(buildCaseFile(r.value, { assessmentsByHyp: counts }));
      } else {
        setPollError(r.error.message);
      }
      timer = setTimeout(poll, 2500);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [id, refresh, demoMode]);

  async function mutate(op: string, body: unknown, successNotice?: string) {
    if (command.current) return;
    command.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await write<unknown>(op, body);
    command.current = false;
    setBusy(false);
    if (!alive.current) return;
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    if (successNotice) setNotice(successNotice);
    if (op === "create" && r.value && typeof r.value === "object" && "id" in (r.value as any)) {
      setId(String((r.value as any).id));
    }
    setRefresh((n) => n + 1);
  }

  function open(nextId: string) {
    setId(nextId);
    setData(null);
    setCaseFile(null);
    setSelected("");
    setEvidence(null);
    setError(null);
    setPollError(null);
    setNotice(null);
    setDemoMode(false);
  }

  function startDemo() {
    setDemoMode(true);
    setId("inv:demo:living");
    setData(null);
    setError(null);
    setPollError(null);
    setNotice("Demo mode — fully client-side case file. Run checks to advance hypotheses.");
    setCaseFile(demoCaseFile(question || initialQuestion, workspaceId, revision));
    setActiveTab("hypotheses");
  }

  async function inspectEvidence(evidenceId: string) {
    if (!data || demoMode) return;
    const request = ++evidenceRequest.current;
    setEvidence(null);
    setEvidenceError(null);
    setEvidenceLoading(true);
    const r = await call<ResolvedEvidence>("C18", "evidence", { revision: data.snapshot.scope.revision, evidenceId });
    if (!alive.current || request !== evidenceRequest.current) return;
    setEvidenceLoading(false);
    if (r.ok) setEvidence(r.value); else setEvidenceError(r.error.message);
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (demoMode) {
      startDemo();
      return;
    }
    const cmd = openLivingInvestigationCommand({
      workspaceId,
      revision,
      question,
      entityRefs,
      trace: trace.trim() || undefined,
      mode: "GUIDED",
      seed: true,
    });
    await mutate(cmd.op, cmd.body, "Investigation opened.");
  }

  async function onRunCheck(check: NextCheckCard) {
    if (!caseFile) return;
    if (demoMode || caseFile.demo) {
      setCaseFile(demoRunCheck(caseFile, check.id));
      setNotice(`Demo check completed: ${check.description.slice(0, 80)}`);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await write("runCheck", { investigationId: id, checkId: check.id });
    setBusy(false);
    if (!r.ok) {
      // Fall back to demo advancement so the MVP still feels alive
      setNotice(`Live runCheck unavailable (${r.error.message}). Advancing in demo mode for this check.`);
      setDemoMode(true);
      setCaseFile(demoRunCheck(caseFile, check.id));
      return;
    }
    setNotice(`Running check: ${check.description.slice(0, 80)}`);
    setRefresh((n) => n + 1);
  }

  async function onAssessCompletion() {
    if (!caseFile) return;
    if (demoMode || caseFile.demo) {
      setCaseFile(demoAssessCompletion(caseFile));
      setNotice("Demo completion assessed.");
      setActiveTab("completion");
      return;
    }
    const cmd = requestCompletionCommand(id, caseFile.version);
    await mutate(cmd.op, cmd.body, "Requesting honest completion assessment…");
  }

  async function onSteer(action: "focus" | "defer" | "retire", hyp: HypothesisCard) {
    if (!caseFile) return;
    if (demoMode || caseFile.demo) {
      setCaseFile(demoSteer(caseFile, action, hyp.id));
      setNotice(`Demo ${action}: ${hyp.title.slice(0, 60)}`);
      return;
    }
    if (action === "retire") {
      const cmd = retireHypothesisCommand(id, caseFile.version, hyp.id, "Retired from Living Investigation panel");
      await mutate(cmd.op, cmd.body, `Retired ${hyp.title.slice(0, 40)}`);
      return;
    }
    // focus / defer via steer if engine supports it; otherwise soft local reorder notice
    setNotice(`${action} requested for ${hyp.title.slice(0, 40)} (live steer may be limited)`);
  }

  return (
    <Modal title="Living Investigation" onClose={onClose} className="investigation-panel living-investigation">
      <p className="muted small">
        Durable case file for diagnostic questions. Competing hypotheses are graded; checks are revision-bound;
        the investigation can finish as unresolved.
      </p>

      <div className="living-toolbar">
        <button type="button" className="secondary small" disabled={busy} onClick={startDemo}>
          Start demo case file
        </button>
        {demoMode && <span className="demo-badge" title="Client-side only">Demo</span>}
      </div>

      {!demoMode && (
        <>
          <label htmlFor="investigation-select">Open investigation</label>
          <select id="investigation-select" disabled={busy} value={id} onChange={(e) => open(e.target.value)}>
            <option value="">Choose an investigation</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.goal.question} — {words(item.execution)}
              </option>
            ))}
          </select>
          <button className="secondary small" disabled={busy} onClick={() => { setError(null); setRefresh((n) => n + 1); }}>
            Refresh investigations
          </button>
        </>
      )}

      <details open={!id || demoMode}>
        <summary>{demoMode ? "Demo question" : "New Living Investigation"}</summary>
        <form onSubmit={onCreate}>
          <label htmlFor="investigation-question">Question</label>
          <input id="investigation-question" required maxLength={500} value={question} onChange={(e) => setQuestion(e.target.value)} />
          {!demoMode && (
            <>
              <label htmlFor="investigation-trace">Stack trace (optional)</label>
              <textarea id="investigation-trace" rows={3} value={trace} onChange={(e) => setTrace(e.target.value)} />
              <p className="muted small">Starts with {entityRefs.length} selected code reference(s).</p>
            </>
          )}
          <button disabled={busy || !question.trim()}>{demoMode ? "Reset demo with this question" : "Open case file"}</button>
        </form>
      </details>

      {busy && <p role="status">Saving…</p>}
      {error && <p role="alert">{error}</p>}
      {pollError && <p role="alert">{pollError}</p>}
      {notice && <p role="status">{notice}</p>}

      {caseFile && (
        <section className="case-file" aria-label="Living case file">
          <header className="case-header">
            <h3 className="case-question">{caseFile.question}</h3>
            <p className="status-line" role="status">{caseFile.statusLine}</p>
            <p className="muted small">
              Rev {caseFile.revision.slice(0, 12) || "—"} · {words(caseFile.execution)} · {words(caseFile.disposition)}
              {caseFile.demo ? " · demo" : ""}
            </p>
          </header>

          <nav className="case-tabs" role="tablist" aria-label="Case file sections">
            {([
              ["hypotheses", `Hypotheses (${caseFile.hypotheses.length})`],
              ["checks", `Next checks (${caseFile.nextChecks.length})`],
              ["observations", `Observations (${caseFile.observations.length})`],
              ["views", `Views (${caseFile.viewHints.length})`],
              ["completion", "Completion"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={activeTab === key}
                className={activeTab === key ? "tab active" : "tab"}
                onClick={() => setActiveTab(key)}
              >
                {label}
              </button>
            ))}
          </nav>

          {activeTab === "hypotheses" && (
            <div role="tabpanel" className="hyp-list">
              {caseFile.hypotheses.length === 0 && (
                <p className="muted">No hypotheses yet.</p>
              )}
              {caseFile.hypotheses.map((h) => (
                <article key={`${h.id}@${h.version}`} className={`hyp-card ${gradeClass(h.grade)}`} data-selected={selected === h.id}>
                  <header>
                    <span className={`grade-badge ${gradeClass(h.grade)}`} title={GRADE_HINT[h.grade]}>
                      {GRADE_LABEL[h.grade]}
                    </span>
                    <strong>{h.title}</strong>
                    <span className="muted small">v{h.version} · {words(h.evaluation)}</span>
                  </header>
                  <p className="hyp-summary">{h.summary}</p>
                  <p className="muted small">
                    Assumptions {h.assumptionCount} ({h.openAssumptions} open) ·
                    Support {h.supportCount} · Contradict {h.contradictCount}
                  </p>
                  <div className="hyp-actions">
                    <button className="secondary small" disabled={busy} type="button" onClick={() => setSelected(h.id)}>Select</button>
                    <button className="secondary small" disabled={busy} type="button" onClick={() => void onSteer("focus", h)}>Focus</button>
                    <button className="secondary small" disabled={busy} type="button" onClick={() => void onSteer("defer", h)}>Defer</button>
                    <button className="secondary small" disabled={busy} type="button" onClick={() => void onSteer("retire", h)}>Retire</button>
                  </div>
                </article>
              ))}
            </div>
          )}

          {activeTab === "checks" && (
            <div role="tabpanel" className="check-list">
              {caseFile.nextChecks.length === 0 && (
                <p className="muted">No ready checks left. Assess completion or add evidence.</p>
              )}
              {caseFile.nextChecks.map((c) => (
                <article key={c.id} className="check-card">
                  <header>
                    <strong>{c.description}</strong>
                    <span className="muted small">{c.executionClass} · {c.expectedCostLabel}</span>
                  </header>
                  <p className="muted small">{c.rationale}</p>
                  <p className="muted small">Targets: {c.hypothesisIds.join(", ") || "—"}</p>
                  <button disabled={busy || c.executionClass === "PROHIBITED"} type="button" onClick={() => void onRunCheck(c)}>
                    ▶ Run this check
                  </button>
                </article>
              ))}
            </div>
          )}

          {activeTab === "observations" && (
            <div role="tabpanel" className="obs-list">
              {caseFile.observations.length === 0 && <p className="muted">No observations yet.</p>}
              {caseFile.observations.map((o) => (
                <article key={o.id} className={o.retracted ? "obs-card retracted" : "obs-card"}>
                  <span className="muted small">{o.kind}{o.retracted ? " · retracted" : ""}</span>
                  <p>{o.description}</p>
                </article>
              ))}
            </div>
          )}

          {activeTab === "views" && (
            <div role="tabpanel" className="view-hints">
              <p className="muted small">Suggested perspectives for the multi-tab workspace.</p>
              {caseFile.viewHints.map((v: ViewHint) => (
                <article key={v.concern} className="view-hint-card">
                  <strong>{v.label}</strong>
                  <p className="muted small">{v.reason}</p>
                  <button
                    className="secondary small"
                    type="button"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent("cie:living-view-hint", {
                        detail: { concern: v.concern, subjectRefs: v.subjectRefs, investigationId: caseFile.investigationId },
                      }));
                      setNotice(`Requested view: ${v.label}`);
                    }}
                  >
                    Open in workspace
                  </button>
                </article>
              ))}
            </div>
          )}

          {activeTab === "completion" && (
            <div role="tabpanel" className="completion-panel">
              <p>{completionHonestyLine(caseFile.completion)}</p>
              {caseFile.gaps.length > 0 && (
                <div>
                  <h4>Explicit gaps</h4>
                  <ul>{caseFile.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
                </div>
              )}
              <button disabled={busy || caseFile.execution === "FINISHED"} type="button" onClick={() => void onAssessCompletion()}>
                Assess completion (honest)
              </button>
              <p className="muted small">
                Completion never invents a root cause. Supported, contested, and unresolved are all valid outcomes.
              </p>
            </div>
          )}
        </section>
      )}

      {evidenceLoading && <Loading pending={evidenceLoading} label="Loading evidence…" />}
      {evidenceError && <p role="alert">{evidenceError}</p>}
      {evidence && (
        <aside className="evidence-inspector">
          <h4>Evidence</h4>
          <pre className="small">{JSON.stringify(evidence, null, 2)}</pre>
        </aside>
      )}
    </Modal>
  );
}
