import { useEffect, useRef, useState } from "react";
import type { JobView, PrAnalysisView, PublicationReceipt } from "@cie/schema";
import { call } from "./api.ts";
import { Modal } from "./Modal.tsx";

/**
 * "Pull requests" panel (F02, §12). The browser never trusts the gate: it shows the decision with its binding hash,
 * every condition with the evidence ids it rests on, the findings with their fingerprints, the analyzers' coverage
 * labels and the analysis's own disclosure of what it cannot tell you. Publishing to GitHub goes through the same
 * ops as everything else; a FAIL is rendered as a FAILURE status, an INCOMPLETE as pending.
 */
export function PrPanel({ repoPath, onClose }: { repoPath: string; onClose: () => void }) {
  type HistoryRow = { analysisId: string; headHash: string; state: string; createdAt: string; supersededBy?: string };
  const [prNumberText, setPrNumberText] = useState("");
  const [view, setView] = useState<PrAnalysisView | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  type PanelJob = NonNullable<PrAnalysisView["job"]>;
  const [job, setJob] = useState<PanelJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiverFor, setWaiverFor] = useState<string | null>(null);
  const [waiverRationale, setWaiverRationale] = useState("");
  const [waiverExpiry, setWaiverExpiry] = useState(() => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const prNumber = Number(prNumberText);

  const refresh = async (n = prNumber) => {
    if (!n) return;
    const r = await call<{ analysis: PrAnalysisView; history: { analysisId: string; headHash: string; state: string; createdAt: string; supersededBy?: string }[] }>("C23", "getPrAnalysis", { repoPath, prNumber: n });
    if (!live.current) return;
    if (r.ok) {
      setView(r.value.analysis);
      setHistory((r.value.history ?? []) as never as HistoryRow[]);
      setError(null);
      setJob(r.value.analysis.job ?? null);
      return r.value.analysis;
    }
    setError(r.error.message);
    return null;
  };

  const pollTick = useRef(0);
  useEffect(() => {
    if (!job || !["QUEUED", "RUNNING"].includes(job.state)) return;
    const t = setInterval(() => { pollTick.current++; void refresh(); }, 2000);
    return () => clearInterval(t);
  }, [job?.state, pollTick.current]); // eslint-disable-line react-hooks/exhaustive-deps

  const analyze = async () => {
    if (!prNumber) { setError("give a pull-request number"); return; }
    setBusy(true); setError(null); setNotice(null);
    const r = await call<JobView & { params?: { analysisId?: string } }>("C23", "analyzePullRequest", { repoPath, prNumber, forge: "github" });
    if (!live.current) return;
    setBusy(false);
    if (!r.ok) { setError(r.error.message); return; }
    const j = r.value;
    setJob({ id: j.id, kind: "pr-analysis", state: j.state, phase: j.phase, message: j.message });
    setNotice("analysing in the background; this panel updates while it runs");
    void refresh(prNumber);
  };

  const publish = async (kind: "STATUS" | "COMMENT") => {
    const v = view as PrAnalysisView | null;
    if (!v) return;
    setBusy(true);
    const r = await call<PublicationReceipt>("C30", "publishCheck", { repositoryId: v.pr.repositoryId, prNumber: v.pr.prNumber, decisionId: v.decision?.decisionId, analysisId: v.analysisId, kind, alsoComment: kind === "COMMENT" });
    if (!live.current) return;
    setBusy(false);
    if (!r.ok) setError(r.error.message);
    else setNotice(r.value.state === "PUBLISHED"
      ? (r.value.lastError ? `GitHub reported a problem: ${r.value.lastError}` : `published to GitHub (${r.value.kind})`)
      : `publication did not succeed: ${r.value.lastError ?? r.value.state}`);
  };

  const dispose = async (findingId: string, disposition: "WAIVED" | "DISMISSED_FALSE_POSITIVE") => {
    const v = view!;
    setBusy(true);
    const r = await call<{ finding: unknown; decisionId: string | null }>("C18", "recordDisposition", {
      analysisId: v.analysisId, findingId, disposition, rationale: waiverRationale,
      ...(disposition === "WAIVED" ? { waiver: { scopeKind: "FINDING_FINGERPRINT", expiresAt: new Date(`${waiverExpiry}T00:00:00Z`).toISOString(), } } : {}),
    });
    if (!live.current) return;
    setBusy(false);
    setWaiverFor(null); setWaiverRationale("");
    if (!r.ok) setError(r.error.message);
    else { setNotice(`disposition recorded; the gate was re-evaluated${r.value.decisionId ? "" : " (no decision to re-evaluate)"}`); void refresh(); }
  };

  const d = view?.decision;
  const statusChip = d ? (d.status === "PASS" ? "chip pass" : d.status === "FAIL" ? "chip fail" : "chip incomplete") : "chip";

  return (
    <Modal title="Pull request review" onClose={onClose} className="pr-panel">

        <section className="pr-controls" aria-label="Open a pull request">
          <label htmlFor="pr-num">Pull-request number</label>
          <span className="row">
            <input id="pr-num" inputMode="numeric" value={prNumberText} onChange={(e) => setPrNumberText(e.target.value.replace(/[^0-9]/g, ""))} placeholder="e.g. 42" />
            <button onClick={() => void analyze()} disabled={!prNumber || busy} title="Index the merge base and head, analyse the changed code, evaluate the gate">Analyze</button>
            <button className="secondary" onClick={() => void refresh()} disabled={!prNumber}>Refresh</button>
          </span>
          {repoPath && <p className="muted small mono" style={{ margin: 0 }}>{repoPath}</p>}
        </section>

        {error && <pre className="error" role="alert">{error}</pre>}
        {notice && <p className="muted small" role="status">{notice}</p>}

        {view && (
          <>
            <section className="pr-summary" aria-label="Analysis summary">
              <p className="pr-row">
                <span className={statusChip}>{view.state}</span>
                <span className="chip mono">PR #{view.pr.prNumber} · {view.pr.forge}</span>
                <span className="chip mono" title={`${view.baseHash} → ${view.headHash}`}>head {view.headHash.slice(0, 7)}</span>
                {view.job && ["QUEUED", "RUNNING"].includes(view.job.state) && <span className="chip busy">{view.job.phase}: {view.job.message}</span>}
              </p>
              {d && (
                <p className="pr-row">
                  <strong>{d.status === "PASS" ? "✓ PASS" : d.status === "FAIL" ? "✗ FAIL" : "◔ INCOMPLETE"}</strong>
                  <span className="chip mono" title={`binding hash ${d.bindingHash}`}>{d.policy.policyId} v{d.policy.version}</span>
                  {d.validUntil && <span className="chip">binding valid until {new Date(d.validUntil).toLocaleString()}</span>}
                </p>
              )}
            </section>

            {d && (
              <section aria-label="Gate conditions">
                <h3>Gate conditions</h3>
                <table className="pr-table">
                  <thead><tr><th scope="col">Condition</th><th scope="col">Outcome</th><th scope="col">Blocking</th><th scope="col">Evidence</th><th scope="col">Why</th></tr></thead>
                  <tbody>
                    {d.conditions.map((c) => (
                      <tr key={c.id} className={c.outcome === "FAILED" && c.blocking ? "pr-bad" : c.outcome === "PASSED" ? "pr-good" : ""}>
                        <td>{c.id}</td>
                        <td>{c.outcome}</td>
                        <td>{c.blocking ? "yes" : "no"}</td>
                        <td className="mono small" title={c.evidenceIds.join("\n")}>{c.evidenceIds.length || "—"}</td>
                        <td>{c.waiverId ? `${c.reason} (waiver ${c.waiverId.slice(0, 8)})` : c.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            <section aria-label="Findings">
              <h3>Findings ({view.findings.introduced.length} introduced · {view.findings.existing.length} existing · {view.findings.resolvedByChange.length} resolved by this change)</h3>
              {[["Introduced by this PR", view.findings.introduced], ["Already present at the base", view.findings.existing], ["Resolved by this change", view.findings.resolvedByChange]].map(([label, rows]) => (
                (rows as PrAnalysisView["findings"]["introduced"]).length > 0 && (
                  <div key={String(label)}>
                    <h4 className="muted">{String(label)}</h4>
                    <table className="pr-table">
                      <thead><tr><th scope="col">Rule</th><th scope="col">Sev</th><th scope="col">Where</th><th scope="col">State</th><th scope="col">Actions</th></tr></thead>
                      <tbody>
                        {(rows as PrAnalysisView["findings"]["introduced"]).map((f) => (
                          <tr key={f.findingId}>
                            <td className="mono small" title={f.ruleId}>{f.ruleId.replace(/^R-/, "")}</td>
                            <td><span className={`sev-${f.severity}`}>{f.severity}</span></td>
                            <td className="mono small" title={`${f.path}${f.line ? ":" + f.line : ""} — ${f.counterArgument.slice(0, 160)}`}>{f.path.split("/").pop()} · {f.summary.slice(0, 80)}</td>
                            <td>{f.disposition}</td>
                            <td>
                              <span className="row">
                                <button className="link" onClick={() => { setWaiverFor(f.findingId); setWaiverRationale(""); }} aria-label={`Record a disposition for the ${f.ruleId} finding in ${f.path}`}>respond…</button>
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ))}
              {view.findings.introduced.length === 0 && view.findings.existing.length === 0 && <p className="muted">No rule findings in the analysed scope.</p>}
              {(view.findings.detectorCandidates?.length ?? 0) > 0 && (
                <div>
                  <h4 className="muted">Detector and oracle candidates — limited detectors, a person answers, never a verdict</h4>
                  <table className="pr-table">
                    <thead><tr><th scope="col">Detector</th><th scope="col">Sev</th><th scope="col">Where</th><th scope="col">State</th><th scope="col">Actions</th></tr></thead>
                    <tbody>
                      {(view.findings.detectorCandidates ?? []).map((f) => (
                        <tr key={f.findingId}>
                          <td className="mono small" title={f.ruleId}>{f.kind}: {f.summary.slice(0, 70)}</td>
                          <td><span className={`sev-${f.severity}`}>{f.severity}</span></td>
                          <td className="mono small" title={f.path}>{f.path.split("/").pop()}{f.line ? `:${f.line}` : ""}</td>
                          <td>{f.disposition === "OPEN" ? "not answered" : f.disposition}</td>
                          <td><button className="link" onClick={() => { setWaiverFor(f.findingId); setWaiverRationale(""); }}>answer…</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section aria-label="Analyzers">
              <h3>Analyzers and their coverage</h3>
              <table className="pr-table">
                <thead><tr><th scope="col">Analyzer</th><th scope="col">State</th><th scope="col">Coverage</th><th scope="col">Why not everything</th></tr></thead>
                <tbody>
                  {view.analyzers.map((a) => (
                    <tr key={`${a.id}@${a.version}`}>
                      <td className="mono small">{a.id}@{a.version}</td>
                      <td>{a.state}</td>
                      <td>{a.coverage.analyzedFiles} files</td>
                      <td className="small muted">{a.coverage.skippedFiles ? `+${a.coverage.skippedFiles} skipped: ${a.coverage.reason ?? ""}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">Baseline {view.baseline.mode === "REUSED" ? "reused the cached merge-base analysis" : "was re-analysed at the merge base"}.</p>
            </section>

            <section aria-label="What this does not tell you">
              <h3>What this does not tell you</h3>
              <ul className="pr-disclosure">
                {view.disclosure.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            </section>

            <section aria-label="Waivers">
              <h3>Waivers ({view.waivers.length})</h3>
              {view.waivers.length > 0 && (
                <table className="pr-table">
                  <thead><tr><th scope="col">Scope</th><th scope="col">Until</th><th scope="col">By</th></tr></thead>
                  <tbody>
                    {view.waivers.map((w) => (
                      <tr key={w.id}>
                        <td className="mono small">{w.scopeKind}: {w.scope.fingerprint ? `finding ${w.scope.fingerprint.slice(0, 12)}` : `${w.scope.ruleId ?? "?"} in ${w.scope.path ?? "?"}`}</td>
                        <td>{new Date(w.expiresAt).toLocaleDateString()}{w.revokedAt ? " (revoked)" : ""}</td>
                        <td>{w.approver ?? w.actor}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {waiverFor && (
              <section className="pr-waiver" aria-label="Respond to a finding">
                <h3>Respond to the finding</h3>
                <label className="row">Rationale (required): <input value={waiverRationale} onChange={(e) => setWaiverRationale(e.target.value)} style={{ width: "100%" }} /></label>
                <label className="row">Waiver valid until: <input type="date" value={waiverExpiry} onChange={(e) => setWaiverExpiry(e.target.value)} /></label>
                <span className="row">
                  <button disabled={busy || waiverRationale.trim().length < 3 || !waiverExpiry} onClick={() => void dispose(waiverFor, "WAIVED")} title="Record a time-bounded waiver; the gate is re-evaluated with it">Waive until date</button>
                  <button disabled={busy || waiverRationale.trim().length < 3} onClick={() => void dispose(waiverFor, "DISMISSED_FALSE_POSITIVE")}>Dismiss as false positive</button>
                  <button className="secondary" onClick={() => { setWaiverFor(null); setWaiverRationale(""); }}>Cancel</button>
                </span>
                <p className="muted small">A waiver is stored with its scope (this finding's fingerprint), its approver and its expiry; the decision that relied on it dies at the same time.</p>
              </section>
            )}

            <div className="row push" style={{ paddingBottom: 12 }}>
              <button disabled={busy || !view} onClick={() => void publish("STATUS")}>Publish status to GitHub</button>
              <button disabled={busy || !view} onClick={() => void publish("COMMENT")}>Publish/update comment</button>
            </div>
          </>
        )}

        {history.length > 1 && (
          <section aria-label="Analysis history">
            <h3>History</h3>
            <ul className="small muted">
              {history.slice(0, 10).map((hRow) => (
                <li key={`${hRow.analysisId}-${hRow.headHash}`} className="mono">{(hRow.headHash ?? "").slice(0, 7)} · {hRow.state}{hRow.supersededBy ? ` → superseded by ${hRow.supersededBy.slice(0, 8)}` : ""} · {new Date(hRow.createdAt).toLocaleString()}</li>
              ))}
            </ul>
          </section>
        )}
    </Modal>
  );
}