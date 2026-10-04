import { useEffect, useState } from "react";
import type { DetectorFinding, JobView, ResolvedEvidence } from "@cie/schema";
import { call } from "./api.ts";

/** Read-only evidence view. Experiment authority and forge credentials do not enter the browser. */
export function DefectPanel({ revision, onClose }: { revision: string; onClose: () => void }) {
  const [findings, setFindings] = useState<DetectorFinding[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<ResolvedEvidence[]>([]);
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setFindings([]); setSelected(null); setEvidence([]); setError(null); setJob(null); setLoading(true);
    void call<DetectorFinding[]>("C26", "listFindings", { revision }).then((r) => {
      if (!live) return;
      if (r.ok) setFindings(r.value); else setError(r.error.message);
      setLoading(false);
    });
    return () => { live = false; };
  }, [revision]);
  useEffect(() => {
    if (!job || !["QUEUED", "RUNNING"].includes(job.state)) return;
    let live = true;
    const poll = async () => {
      const result = await call<JobView>("C07", "getJob", { jobId: job.id });
      if (!live) return;
      if (!result.ok) { setError(result.error.message); return; }
      setJob(result.value);
      if (result.value.state === "SUCCEEDED") {
        setWarnings(result.value.result?.warnings ?? []);
        setFindings(result.value.result?.value as DetectorFinding[] ?? []);
      } else if (result.value.state === "FAILED") setError(result.value.error?.message ?? "Detection failed");
    };
    const timer = setInterval(() => void poll(), 500);
    return () => { live = false; clearInterval(timer); };
  }, [job?.id, job?.state]);
  const finding = findings.find((f) => f.id === selected);
  useEffect(() => {
    let live = true; setEvidence([]);
    if (finding) void Promise.all(finding.evidenceIds.map((evidenceId) => call<ResolvedEvidence>("C18", "evidence", { revision, evidenceId }))).then((results) => {
      if (!live) return;
      setEvidence(results.flatMap((r) => r.ok ? [r.value] : []));
      if (results.some((r) => !r.ok)) setError("Some source evidence is no longer available.");
    });
    return () => { live = false; };
  }, [finding?.id, revision]);
  const busy = !!job && ["QUEUED", "RUNNING"].includes(job.state);
  const detect = async () => {
    setError(null);
    const r = await call<JobView>("C26", "detect", { revision }, crypto.randomUUID());
    if (r.ok) setJob(r.value); else setError(r.error.message);
  };
  return <div className="modal-backdrop">
    <section className="modal defect-panel" role="dialog" aria-modal="true" aria-label="Defect and performance findings" tabIndex={-1} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="defect-heading"><h2>Defects and performance</h2><button autoFocus onClick={onClose}>Close</button></div>
      <p>Revision <code>{revision}</code></p>
      <button disabled={busy || loading} onClick={() => void detect()}>{busy ? "Analyzing…" : "Analyze indexed code"}</button>
      <p role="status">{busy ? job?.message : `${findings.length} recorded candidate${findings.length === 1 ? "" : "s"}`}</p>
      {error && <p role="alert">{error}</p>}
      {warnings.length > 0 && <details><summary>Analysis coverage</summary><ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>}
      {!busy && !findings.length && <p>No candidates are recorded for this revision. This does not establish that the code is race-free, deadlock-free or optimal.</p>}
      <div className="defect-columns">
        <nav aria-label="Findings"><ul>{findings.map((f) => <li key={f.id}><button aria-pressed={selected === f.id} onClick={() => setSelected(f.id)}>{f.kind.replaceAll("_", " ")} · {f.severity}</button></li>)}</ul></nav>
        {finding && <article>
          <h3>{finding.kind.replaceAll("_", " ")}</h3>
          <p>{finding.evidenceLevel.replaceAll("_", " ")} · Rule {finding.ruleId} v{finding.ruleVersion}</p>
          <p>{finding.witness?.detail}</p>
          {finding.witness && <figure><figcaption>{finding.witness.kind === "LOCK_ORDER_CYCLE" ? "Potential lock acquisition paths" : "Source paths"}</figcaption>
            <ol>{finding.witness.paths.map((path, i) => <li key={i}><code>{path.join(" → ")}</code></li>)}</ol>
          </figure>}
          <h4>Coverage gaps</h4><ul>{finding.coverageGaps.map((g) => <li key={g}>{g}</li>)}</ul>
          <h4>Correctness obligations</h4><ul>{finding.safetyObligations.map((o) => <li key={o.id}>{o.description} ({o.state})</li>)}</ul>
          <h4>Source evidence</h4>{evidence.map((e) => <details key={e.id}><summary>{e.file}:{e.startLine} · {e.class}</summary><pre><code>{e.snippet}</code></pre></details>)}
        </article>}
      </div>
    </section>
  </div>;
}
