import { useEffect, useRef, useState } from "react";
import type { FeatureTestReport, JobView } from "@cie/schema";
import type { WizardWorkspace } from "./wizard.ts";
import type { RemoteCall } from "./remote.ts";
import type { BuildRun, ImportedTestReport } from "../../../../packages/core/src/feature/workbench.ts";

export const buildJobKey = (id: string) => `cie.feature.job.${id}`;
export function rememberBuildJob(requestId: string, jobId: string) { try { localStorage.setItem(buildJobKey(requestId), jobId); } catch { /* Server retains progress. */ } window.dispatchEvent(new CustomEvent("cie-feature-job", { detail: { requestId, jobId } })); }
const uid = () => crypto.randomUUID();
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
type State = { reports: ImportedTestReport[]; runs: (BuildRun & { interrupted?: boolean; jobState?: string })[] };
export function FeatureWorkbench({ ws, repositoryId, call, refresh, notify }: { ws: WizardWorkspace; repositoryId: string; call: RemoteCall; refresh: () => Promise<void>; notify: (text: string) => void }) {
  const [setup, setSetup] = useState<{ ready: boolean; items: { id: string; state: string; detail: string; fix?: string }[] }>();
  const [state, setState] = useState<State>({ reports: [], runs: [] });
  const [job, setJob] = useState<JobView>(); const [jobId, setJobId] = useState<string>(); const [busy, setBusy] = useState(false);
  const [synthetic, setSynthetic] = useState(false);
  const [reportText, setReportText] = useState(""); const [reportId, setReportId] = useState("");
  const refs = useRef({ refresh, notify }); refs.current = { refresh, notify };
  const active = !!jobId && (!job || job.state === "QUEUED" || job.state === "RUNNING");
  const load = async () => {
    if (!ws.requestId) return;
    const r = await call<State>("C27", "getFeatureWorkbench", { requestId: ws.requestId });
    if (r.ok) { setState(r.value); const running = r.value.runs.findLast((v) => v.jobState === "RUNNING" || v.jobState === "QUEUED"); if (running) setJobId(running.jobId); }
    else refs.current.notify(r.error.message);
  };
  useEffect(() => { let live = true; void call<NonNullable<typeof setup>>("C02", "featureSetupCheck", { repositoryId }).then((r) => { if (live) { if (r.ok) setSetup(r.value); else refs.current.notify(r.error.message); } }).catch(() => { if (live) refs.current.notify("Environment check unavailable. Retry before building."); }); return () => { live = false; }; }, [repositoryId, call]);
  useEffect(() => {
    const update = (e: Event) => { const detail = (e as CustomEvent<{ requestId: string; jobId: string }>).detail; if (detail.requestId === ws.requestId) setJobId(detail.jobId); };
    window.addEventListener("cie-feature-job", update); return () => window.removeEventListener("cie-feature-job", update);
  }, [ws.requestId]);
  useEffect(() => {
    setJob(undefined); setReportId(""); setReportText("");
    try { setJobId(localStorage.getItem(buildJobKey(ws.requestId)) ?? undefined); } catch { setJobId(undefined); }
  }, [ws.requestId]);
  useEffect(() => {
    setReportId(""); setReportText("");
    void load().catch(() => refs.current.notify("Could not load build history."));
  }, [ws.requestId, ws.candidate?.hash]);
  useEffect(() => {
    if (!jobId) return; let live = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await call<JobView>("C07", "getJob", { jobId }); if (!live) return;
        if (!r.ok) { refs.current.notify(r.error.message); return; } setJob(r.value);
        if (r.value.state === "QUEUED" || r.value.state === "RUNNING") timer = setTimeout(() => void poll(), 1200);
        else { await refs.current.refresh(); await load(); if (!live) return; if (r.value.state === "FAILED") refs.current.notify(r.value.error?.message ?? "Build failed; inspect the last checkpoint."); }
      } catch { if (live) { refs.current.notify("Progress connection interrupted. Reconnecting to the saved job…"); timer = setTimeout(() => void poll(), 3000); } }
    };
    void poll(); return () => { live = false; clearTimeout(timer); };
  }, [jobId, call]);
  const start = async (operation: "prepareFeaturePlan" | "buildFeatureCandidate", selectedReport?: string) => {
    setBusy(true);
    try {
      const r = await call<{ jobId: string }>(operation === "prepareFeaturePlan" ? "C02" : "C28", operation, { requestId: ws.requestId, ...(operation === "buildFeatureCandidate" ? { candidateHash: ws.candidate?.hash, maxRepairs: 3, wallMs: 600000, syntheticTestData: synthetic, ...(selectedReport ? { reportId: selectedReport } : {}) } : {}) }, uid());
      if (!r.ok) { notify(r.error.message); return; } rememberBuildJob(ws.requestId, r.value.jobId); setJob(undefined); setJobId(r.value.jobId);
    } catch { notify("Could not start work. Reload to check saved progress before retrying."); } finally { setBusy(false); }
  };
  const cancel = async () => { if (!jobId) return; const r = await call<{ cancelled: boolean; reason?: string }>("C07", "cancelJob", { jobId }, uid()); notify(r.ok ? r.value.cancelled ? "Stopping at the next safe checkpoint…" : r.value.reason ?? "Already finished" : r.error.message); };
  const confirm = async () => {
    if (!ws.review) return; setBusy(true);
    try {
      const r = await call("C15", "confirmAcceptance", { contractId: `contract:${ws.requestId}`, expectedVersion: ws.contractVersion, criteria: ws.review.criteria.filter((c) => c.oracleOrigin === "GENERATED_UNREVIEWED").map((c) => ({ id: c.id })), rationale: "I reviewed these expected outcomes in the feature wizard" }, uid());
      notify(r.ok ? "Expected outcomes confirmed. Build uses this agreed contract." : r.error.message); await refresh();
    } catch { notify("Could not confirm outcomes. Reload to check their saved state."); } finally { setBusy(false); }
  };
  const importReport = async () => {
    setBusy(true);
    try {
      if (new TextEncoder().encode(reportText).length > 64000) { notify("Report must be at most 64 KB."); return; }
      const report: unknown = JSON.parse(reportText);
      const r = await call<ImportedTestReport>("C27", "importFeatureTestReport", { requestId: ws.requestId, report }, uid());
      if (!r.ok) { notify(r.error.message); return; } setReportId(r.value.id); setReportText(""); await load(); notify("Local report saved as external diagnostic input. It does not mark checks as passed.");
    } catch { notify("Could not import the report. Check that it is valid JSON and retry."); } finally { setBusy(false); }
  };
  const template = async () => {
    const r = await call<{ baseRevision: string }>("C27", "exportFeatureValidationReport", { requestId: ws.requestId, candidateHash: ws.candidate?.hash });
    if (!r.ok) { notify(r.error.message); return; }
    const value: FeatureTestReport = { format: "feature-test-report.v1", requestId: ws.requestId, candidateHash: ws.candidate!.hash, baseRevision: r.value.baseRevision, command: "npm test", environment: "Describe your OS, Node version and dependencies", exitCode: 1, failures: [{ name: "Failing test name", message: "Expected/actual values and stack trace" }], output: "Paste bounded failure output here" };
    download("feature-test-report.template.json", value);
  };
  const reportDownload = async () => {
    const r = await call("C27", "exportFeatureValidationReport", { requestId: ws.requestId, candidateHash: ws.candidate?.hash });
    if (r.ok) download("feature-validation-report.json", r.value); else notify(r.error.message);
  };
  const blocked = busy || active;
  const currentReports = state.reports.filter((r) => r.report.candidateHash === ws.candidate?.hash && r.report.exitCode !== 0);
  const latest = state.runs.at(-1);
  return <section className="bf-workbench" aria-label="Feature build and repair">
    {setup && <details className="bf-environment" open={!setup.ready && ws.stage === "DESCRIBE"}><summary>Environment · {setup.ready ? "ready for supported checks" : "needs attention"}</summary>
      <p>Automatic generation and checks currently target TypeScript/Node/npm. Mixed stacks need their own validation adapters.</p>
      <ul className="bf-list">{setup.items.filter((i) => i.id !== "GITHUB").map((i) => <li key={i.id}><strong>{i.id.toLowerCase()} · {i.state.toLowerCase()}</strong><p>{i.detail}{i.fix ? ` · ${i.fix}` : ""}</p></li>)}</ul>
    </details>}
    {job && <div role="status" aria-live="polite" className="bf-banner"><strong>{job.state.toLowerCase()} · {job.phase}</strong><p>{job.message}</p>{active && <button className="secondary" onClick={() => void cancel().catch(() => notify("Could not request cancellation."))}>Stop work</button>}</div>}
    {latest && <p className="muted">Last checkpoint: {latest.detail} · {latest.repairs}/{latest.maxRepairs} repairs{latest.interrupted ? " · interrupted; resume with the saved candidate" : ""}</p>}
    {(ws.stage === "PLAN" || ws.stage === "VALIDATE") && <label><input type="checkbox" checked={synthetic} onChange={(e) => setSynthetic(e.target.checked)} /> I confirm these checks use synthetic test fixtures. Without a recorded data declaration, execution stays blocked.</label>}
    {ws.requestId && (ws.stage === "CLARIFY" || ws.stage === "PLAN") && <div className="row">
      <button className="secondary" disabled={blocked} onClick={() => void start("prepareFeaturePlan")}>{ws.review?.requirements.length ? "Update plan after answers" : "Analyse requirements"}</button>
      {ws.stage === "PLAN" && !!ws.review?.criteria.some((c) => c.oracleOrigin === "GENERATED_UNREVIEWED") && <button disabled={blocked} onClick={() => void confirm()}>Confirm expected outcomes</button>}
      {ws.stage === "PLAN" && !!ws.review?.criteria.length && !ws.review.criteria.some((c) => c.oracleOrigin === "GENERATED_UNREVIEWED") && <button disabled={blocked || !!ws.blockers.length || ws.outcomeMode === "PLAN_ONLY"} onClick={() => void start("buildFeatureCandidate")}>Build and test feature</button>}
    </div>}
    {ws.stage === "VALIDATE" && ws.candidate && <>
      <p>Run checks in an isolated copy and repair candidate failures up to three times. Baseline and environment failures stop for review. Tests and expected outcomes stay protected.</p>
      <button disabled={blocked} onClick={() => void start("buildFeatureCandidate")}>Test and repair candidate</button>
      <details><summary>Tests failed on your machine?</summary><p>Download a JSON template, fill it with your local test results, and upload or paste it here. Reports must name this candidate and its original base.</p>
        <button className="secondary" onClick={() => void template().catch(() => notify("Template download failed."))}>Download report template</button>
        <label className="bf-field">Upload test report<input type="file" accept=".json,application/json" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 64000) { notify("Report must be at most 64 KB."); return; } void file.text().then(setReportText).catch(() => notify("Could not read report file.")); }} /></label>
        <label className="bf-field">Or paste report JSON<textarea className="bf-textarea" rows={5} value={reportText} onChange={(e) => setReportText(e.target.value)} /></label>
        <button className="secondary" disabled={blocked || !reportText.trim()} onClick={() => void importReport()}>Import local results</button>
        <label className="bf-field">Failure report<select className="bf-select" value={reportId} onChange={(e) => setReportId(e.target.value)}><option value="">Select a current report</option>{currentReports.map((r) => <option key={r.id} value={r.id}>{r.report.command} · exit {r.report.exitCode} · {r.importedAt}</option>)}</select></label>
        <button className="secondary" disabled={blocked || !reportId || !currentReports.some((r) => r.id === reportId)} onClick={() => void start("buildFeatureCandidate", reportId)}>Repair from local failures, then test</button>
      </details>
    </>}
    {(ws.stage === "VALIDATE" || ws.stage === "DELIVER") && ws.candidate && <button className="secondary" onClick={() => void reportDownload().catch(() => notify("Report download failed."))}>Download validation report</button>}
    {ws.stage === "DELIVER" && <p className="bf-banner">Corrected patches replace the previous patch against the original base. Use a clean branch at that base; do not apply successive replacement patches on top of one another.</p>}
  </section>;
}
