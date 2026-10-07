import { useEffect, useState } from "react";
import type { FeatureReview } from "../../../../packages/core/src/feature/presentation.ts";
import type { TestAssociation } from "../../../../packages/core/src/feature/types.ts";
import type { RemoteCall } from "./remote.ts";
import { pageOf } from "./review-view.ts";
import { BASIS_TEXT, RELEASE_TEXT, declarationText, declarationTone, publishAuthorityText, ORIGIN_TEXT, actionState, bannerTone, countByStatus, exportFileName, filterTests, reasonList, statusText, statusTone, targetLine, validDestination } from "./deliver-view.ts";

type Result<T> = { status: string; value?: T; diagnostics: string[] };
const uid = () => crypto.randomUUID();
const Chip = ({ status }: { status: string }) => <span className={`chip ${statusTone(status) === "ok" ? "" : "warn"}`}>{statusText(status)}</span>;

/** Validate (spec §43, task 3.P): what ran, against what, and what did not. Nothing here approves anything. */
export function ValidateReview({ review, candidateHash, call, refresh, notify }: { review: FeatureReview; candidateHash?: string; call: RemoteCall; refresh: () => Promise<void>; notify: (t: string) => void }) {
  const d = review.dashboard; const [status, setStatus] = useState(""); const [origin, setOrigin] = useState(""); const [text, setText] = useState(""); const [page, setPage] = useState(0); const [busy, setBusy] = useState(false);
  const [related, setRelated] = useState<{ associations: TestAssociation[]; gaps: string[] }>(); const [relatedNote, setRelatedNote] = useState("");
  useEffect(() => {
    if (!candidateHash) return; let live = true; setRelated(undefined);
    void call<Result<{ associations: TestAssociation[]; gaps: string[] }>>("C23", "queryRelatedTests", { candidateHash }).then((r) => { if (!live) return; if (!r.ok) setRelatedNote(r.error.message); else { setRelated(r.value.value); setRelatedNote(""); } }).catch(() => { if (live) setRelatedNote("Related tests are unavailable right now."); });
    return () => { live = false; };
  }, [candidateHash, call, review.results.length]);
  if (!d) return <p className="muted">No candidate yet, so nothing has been validated.</p>;
  const rows = filterTests(d.tests, { status, origin, text }); const shown = pageOf(rows, page);
  const run = async () => {
    if (!candidateHash || !review.validationPlanHash) return; setBusy(true);
    try { const r = await call("C27", "runValidation", { patchBindingHash: candidateHash, validationPlanHash: review.validationPlanHash, budget: { wallMs: 600_000 } }, uid()); notify(r.ok ? "Validation started. Results appear here as each check finishes." : r.error.message); await refresh(); }
    catch { notify("Could not start validation. Check the connection and try again."); } finally { setBusy(false); }
  };
  return <div className="bf-stack">
    <p className={`bf-banner ${bannerTone(d.banner.eligibility) === "ok" ? "" : bannerTone(d.banner.eligibility) === "bad" ? "error" : "warn"}`} role="status">{d.banner.text}</p>
    {d.stale.stale && <p className="bf-banner warn" role="alert">Stale: {d.stale.reasons.slice(0, 3).join("; ")}. Results below are not current; run validation again before exporting.</p>}
    <div className="row"><button onClick={() => void run()} disabled={busy || !candidateHash || !review.validationPlanHash}>Run validation</button><span className="muted">Starts the required checks for this candidate. Reading results never runs anything.</span></div>
    <section aria-label="Declarations"><h4>What this result rests on</h4><p className="muted">Each claim shows who made it. A claim nobody recorded, or whose declarer lost the authority, keeps the result from being verified.</p>
      <ul className="bf-list">{d.declarations.map((x) => <li key={x.id} className="bf-item"><span>{x.claim} <span className={`chip ${declarationTone(x.state) === "ok" ? "" : "warn"}`}>{declarationText(x.state)}</span></span><span className="muted">{x.detail}</span></li>)}</ul></section>
    <h4>Builds: baseline beside candidate</h4>
    <ul aria-label="Build targets" className="bf-list">{d.targets.map((t) => <li key={t.target} className="bf-item"><span>{targetLine(t)}</span><Chip status={t.candidate} /></li>)}{!d.targets.length && <li className="muted">No build target is declared in the plan.</li>}</ul>
    <h4>Checks</h4><ul aria-label="Checks by kind" className="bf-list">{d.gates.map((g) => <li key={g.kind} className="bf-item"><span>{g.kind.toLowerCase()}{g.gaps.length ? ` — ${g.gaps[0]}` : ""}</span><Chip status={g.status} /></li>)}</ul>
    {d.diagnostics.length > 0 && <section aria-label="Diagnostics"><h4>What needs attention</h4>{d.diagnostics.map((x) => <div key={x.checkId} className="bf-item"><span><strong>{x.checkId}</strong> <Chip status={x.status} /> {x.reason}</span><span className="muted">{x.guidance}</span></div>)}</section>}
    <section aria-label="Repair rules"><h4>Repairing a failed check</h4><p className="muted">Allowed: {d.repair.allowed.join("; ")}.</p><p className="muted">Not allowed: {d.repair.forbidden.join("; ")}.</p>
      {d.repair.weakened.length > 0 && <p className="bf-banner error" role="alert">A test was weakened: {d.repair.weakened.slice(0, 3).map((w) => `${w.file} (${w.detail})`).join("; ")}. This is a property change and blocks verification until a person reviews it.</p>}</section>
    <h4>Tests</h4><p>{countByStatus(d.tests)}{d.testsTruncated ? ` · ${d.testsTruncated} more not listed` : ""}</p>
    <div className="row" style={{ flexWrap: "wrap" }}><label>Search tests<input aria-label="Search tests" className="input" value={text} onChange={(e) => { setText(e.target.value); setPage(0); }} /></label>
      <label>Status<select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}><option value="">All</option>{[...new Set(d.tests.map((t) => t.status))].sort().map((s) => <option key={s} value={s}>{statusText(s)}</option>)}</select></label>
      <label>Origin<select className="input" value={origin} onChange={(e) => { setOrigin(e.target.value); setPage(0); }}><option value="">All</option>{Object.entries(ORIGIN_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label></div>
    <ul aria-label="Test outcomes" className="bf-list">{shown.items.map((t, n) => <li key={`${t.checkId}:${t.name}:${n}`} className="bf-item"><span>{t.name} <span className="muted">· {t.target} · {ORIGIN_TEXT[t.origin]}</span></span><Chip status={t.status} /></li>)}{!rows.length && <li className="muted">No tests match.</li>}</ul>
    {shown.paged && <div className="row"><button className="secondary" disabled={!shown.hasPrev} onClick={() => setPage(page - 1)}>Previous tests</button><span>{shown.from}–{shown.to} of {shown.total}</span><button className="secondary" disabled={!shown.hasNext} onClick={() => setPage(page + 1)}>More tests</button></div>}
    <section aria-label="Related tests"><h4>Tests linked to criteria and files</h4>{relatedNote && <p role="alert">{relatedNote}</p>}
      <ul className="bf-list">{(related?.associations ?? []).map((a) => <li key={a.testId} className="bf-item"><span>{a.testId} <span className="muted">· {a.sourceStatus.toLowerCase()}</span></span><span className="muted">{BASIS_TEXT[a.basis] ?? a.basis}. Criteria: {a.acceptanceIds.join(", ") || "none"} · Files: {a.fileIds.join(", ") || "none"}</span></li>)}</ul>
      {related && !related.associations.length && <p className="muted">No related test was found by explicit link or import.</p>}{(related?.gaps ?? []).map((g) => <p key={g} className="muted">{g}</p>)}</section>
  </div>;
}

/** Deliver: export, check a destination, create a draft PR. Each is its own button, enabled only when its own preconditions hold. */
export function DeliverReview({ review, call, refresh, notify }: { review: FeatureReview; call: RemoteCall; refresh: () => Promise<void>; notify: (t: string) => void }) {
  const v = review.deliver; const [format, setFormat] = useState("GIT_PATCH"); const [dest, setDest] = useState(""); const [repo, setRepo] = useState(""); const [busy, setBusy] = useState(""); const [assessment, setAssessment] = useState<{ id: string; applies: boolean; baseExact?: boolean; conflicts: string[]; blocked?: string[]; destinationRoot?: string }>(); const [exportId, setExportId] = useState("");
  if (!v) return <p className="muted">Nothing to deliver yet.</p>;
  const reasons = reasonList(v.reasons); const guard = async (name: string, fn: () => Promise<void>) => { setBusy(name); try { await fn(); } catch { notify("The request failed. Nothing was changed; check the connection and try again."); } finally { setBusy(""); } };
  const doExport = () => guard("export", async () => {
    const r = await call<Result<{ id: string; format: string; patch?: string; label?: string }>>("C28", "exportFeaturePatch", { candidateHash: v.candidateHash, decisionId: v.decisionIds.export, format, exportPolicyHash: v.exportPolicyHash }, uid());
    if (!r.ok) { notify(r.error.message); await refresh(); return; }
    const e = r.value.value!; setExportId(e.id); notify(`${e.label ?? "Exported"} · ${e.format}`);
    const url = URL.createObjectURL(new Blob([e.patch ?? ""], { type: "text/plain" })); const a = document.createElement("a"); a.href = url; a.download = exportFileName(e); a.click(); URL.revokeObjectURL(url); await refresh();
  });
  const doCheck = () => guard("check", async () => {
    const id = exportId || v.exports.at(-1)?.id; if (!id) { notify("Export a patch first."); return; }
    const r = await call<Result<NonNullable<typeof assessment>>>("C28", "checkPatchDestination", { exportId: id, destinationSnapshot: { repositoryId: repo }, dirtyState: [] });
    if (!r.ok) { notify(r.error.message); return; } setAssessment(r.value.value); if (!r.value.value) notify(r.value.diagnostics.join(" "));
  });
  const doApply = () => guard("apply", async () => {
    const id = exportId || v.exports.at(-1)?.id; if (!id || !assessment) return;
    const r = await call<{ jobId: string }>("C28", "applyPatchCandidate", { exportId: id, destinationSnapshot: { repositoryId: repo, contentRootHash: assessment.destinationRoot }, assessmentId: assessment.id, capabilities: ["APPLY_TO_ISOLATED_WORKTREE"] }, uid());
    notify(r.ok ? "Applying to a separate copy. Your files are not changed." : r.error.message);
  });
  const doPr = () => guard("pr", async () => {
    const r = await call<{ prNumber?: number; remoteRef?: string }>("C30", "publishFeaturePR", { proposalId: v.candidateHash, decisionId: v.decisionIds.publish, expectedHeadHash: v.headHash, destination: dest }, uid());
    notify(r.ok ? `Draft PR ${r.value.remoteRef ?? ""} created. It is a draft and is not approved for merge.` : r.error.message); await refresh();
  });
  const ex = actionState(v, "Export patch"), chk = actionState(v, "Check destination"), pr = actionState(v, "Create draft PR");
  return <div className="bf-stack">
    <p className={`bf-banner ${bannerTone(v.eligibility) === "ok" ? "" : bannerTone(v.eligibility) === "bad" ? "error" : "warn"}`} role="status">{v.label}</p>
    {reasons.shown.length > 0 && <ul aria-label="Why not verified">{reasons.shown.map((r) => <li key={r}>{r}</li>)}{reasons.more > 0 && <li>…and {reasons.more} more</li>}</ul>}
    <section aria-label="Operational note and publication"><h4>Operational note and publication</h4><p>{RELEASE_TEXT[v.release.state]}{v.release.draftedBy ? ` Drafted by ${v.release.draftedBy}.` : ""}{v.release.confirmedBy ? ` Confirmed by ${v.release.confirmedBy}.` : ""}</p><p>{publishAuthorityText(v.publishAuthority)}</p></section>
    <section aria-label="Export patch"><h4>Export patch</h4><p className="muted">Writes the candidate out as text someone else applies. It does not change your files.</p>
      <div className="row"><label>Format<select className="input" value={format} onChange={(e) => setFormat(e.target.value)}>{v.formats.map((f) => <option key={f}>{f}</option>)}</select></label>
        <button disabled={!ex.enabled || !!busy} aria-describedby="why-export" onClick={() => void doExport()}>Export patch</button></div><p id="why-export" className="muted">{ex.reason}</p>
      <ul>{v.exports.map((e) => <li key={e.id}>{e.format} · {e.label ?? e.eligibility} · <code>{e.patchArtifactHash.slice(-12)}</code></li>)}</ul></section>
    <section aria-label="Check destination"><h4>Check a destination</h4><p className="muted">A dry run: it reports conflicts and writes nothing. Applying goes to a separate copy, never to your working files.</p>
      <label>Destination repository path<input aria-label="Destination repository path" className="input" value={repo} onChange={(e) => { setRepo(e.target.value); setAssessment(undefined); }} /></label>
      <div className="row"><button className="secondary" disabled={!chk.enabled || !repo || !!busy} aria-describedby="why-check" onClick={() => void doCheck()}>Check destination</button>
        <button className="secondary" disabled={!assessment?.applies || !assessment.baseExact || !!busy} onClick={() => void doApply()}>Apply to a separate copy</button></div><p id="why-check" className="muted">{chk.reason}</p>
      {assessment && <div role="status"><p>{assessment.applies ? "The patch applies cleanly." : "The patch does not apply."}{assessment.baseExact ? "" : " The destination is not the exact base, so applying is not offered."}</p>{[...assessment.conflicts, ...(assessment.blocked ?? [])].map((c) => <p key={c} className="muted">{c}</p>)}</div>}</section>
    <section aria-label="Create draft PR"><h4>Create draft PR</h4><p className="muted">Pushes a branch from CIE's own clone and opens a draft. It never merges or approves.</p>
      <label>Destination (owner/name:branch)<input aria-label="Destination owner/name:branch" className="input" value={dest} onChange={(e) => setDest(e.target.value)} /></label>
      <div className="row"><button disabled={!pr.enabled || !validDestination(dest) || !!busy} aria-describedby="why-pr" onClick={() => void doPr()}>Create draft PR</button></div><p id="why-pr" className="muted">{pr.enabled && !validDestination(dest) ? "Enter the destination as owner/name:branch." : pr.reason}</p>
      {v.publication && <p>Draft PR #{v.publication.prNumber} · {v.publication.eligibility === "VERIFIED_WITHIN_SCOPE" ? "verified within scope" : "review only"}{v.publication.updated ? " · updated" : ""} {v.publication.url}</p>}</section>
  </div>;
}
