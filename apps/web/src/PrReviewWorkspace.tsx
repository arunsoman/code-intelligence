import { useEffect, useRef, useState } from "react";
import type { ImpactReport, PrAnalysisView } from "@cie/schema";
import { call } from "./api.ts";

export type ReviewTab = "overview" | "findings" | "conversation" | "fixes" | "history";
export const REVIEW_TABS: { id: ReviewTab; label: string }[] = [
  { id: "overview", label: "Overview" }, { id: "findings", label: "Findings & impact" },
  { id: "conversation", label: "Conversation" }, { id: "fixes", label: "Validated fixes" }, { id: "history", label: "History & coverage" },
];
interface Suggestion {
  id: string; findingId: string; headHash: string; path: string; startLine: number; endLine: number;
  expected: string; replacement: string; state: string; checks: { name: string; outcome: string; detail: string }[];
}
interface Reply { kind: string; headHash: string; claims: { class: string; text: string; evidence: { id: string; path?: string; startLine?: number }[] }[]; gaps: string[]; refusedReason?: string }
interface Feedback { labels: { total: number; useful: number; noise: number }; mutes: { active: { id: string; kind: string }[] } }

/** All review surfaces are scoped to the same immutable analysis/head. Remount when that context changes. */
export function PrReviewWorkspace({ view, tab, onNavigate }: { view: PrAnalysisView; tab: ReviewTab; onNavigate: (tab: ReviewTab) => void }) {
  const [report, setReport] = useState<ImpactReport | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState("/cie help");
  const [replies, setReplies] = useState<{ command: string; reply: Reply }[]>([]);
  const [publishId, setPublishId] = useState<string | null>(null);
  const live = useRef(true);
  const request = useRef(0);
  const repositoryId = view.pr.repositoryId; // shared by report ranking and the PR-thread watcher
  const current = view.state === "DECIDED" || view.state === "PUBLISHED";
  useEffect(() => { live.current = true; return () => { live.current = false; request.current++; }; }, []);
  const refresh = async () => {
    const epoch = ++request.current;
    setLoading(true);
    const results = await Promise.all([
      call<ImpactReport>("C23", "getImpactReport", { analysisId: view.analysisId }),
      call<{ suggestions: Suggestion[] }>("C23", "getSuggestions", { analysisId: view.analysisId }),
      call<Feedback>("C17", "getFeedbackState", { repositoryId }),
    ]);
    if (!live.current || epoch !== request.current) return;
    const [impact, fixes, labels] = results;
    setReport(impact.ok ? impact.value : null);
    setSuggestions(fixes.ok ? fixes.value.suggestions : []);
    setFeedback(labels.ok ? labels.value : null);
    setError(results.filter(r => !r.ok).map(r => !r.ok ? r.error.message : "").join(" · ") || null);
    setLoading(false);
  };
  useEffect(() => { void refresh(); }, [view.state]); // remounted by analysis/head key in parent
  const act = async (component: string, op: string, payload: object) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await call(component, op, payload);
      if (!live.current) return;
      if (!result.ok) setError(result.error.message);
      else { setPublishId(null); await refresh(); }
    } catch (e) { if (live.current) setError(String(e)); }
    finally { if (live.current) setBusy(false); }
  };
  const ask = async () => {
    const text = command.trim();
    if (!text || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await call<Reply>("C15", "runPrCommand", { analysisId: view.analysisId, text, visibility: "private" });
      if (!live.current) return;
      if (!result.ok) setError(result.error.message);
      else if (result.value.headHash !== view.headHash) setError("The answer belongs to another head. Refresh the analysis.");
      else setReplies(rows => [...rows.slice(-19), { command: text, reply: result.value }]);
    } catch (e) { if (live.current) setError(String(e)); }
    finally { if (live.current) setBusy(false); }
  };
  const summary = report?.summary;
  return <div className="pr-review-workspace" aria-busy={busy || loading}>
    {loading && <p role="status">Loading review evidence…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {tab === "overview" && <section aria-label="Change walkthrough">
      <h3>Change walkthrough</h3>
      {summary ? <>
        <div className="pr-metrics">{[["Files", summary.counts.files], ["Added", summary.counts.added], ["Modified", summary.counts.modified], ["Removed", summary.counts.deleted], ["Test files", summary.counts.testFiles]].map(([label, count]) => <div key={label}><strong>{count}</strong><span>{label}</span></div>)}</div>
        {summary.highImpact.map(area => <p key={`${area.area}-${area.patternId}`}><strong>{area.area}</strong>: {area.reason} ({area.files} files)</p>)}
        <h4>Suggested reading order · inference</h4>
        {summary.readingOrder.length ? <ol>{summary.readingOrder.map(row => <li key={row.path}><code>{row.path}</code> — {row.note}<details><summary>Why this order?</summary>{row.why.map(f => <p key={f.name}>{f.name}: {f.value}</p>)}</details></li>)}</ol> : <p>No reading order is available for this evidence.</p>}
        {summary.description && <details><summary>Description compared with changed code · name matching</summary><blockquote>{summary.description.authorText}</blockquote><p>{summary.description.changedNotMentioned.length} changed paths were not mentioned; {summary.description.unresolved.length} phrases had no code match.</p></details>}
        {summary.budget.truncated && <p className="muted">Walkthrough shortened; {summary.budget.omitted} entries omitted.</p>}
      </> : !loading && <p>No walkthrough is stored for this analysis. Reanalyze to generate it.</p>}
    </section>}
    {tab === "findings" && <section aria-label="Ranked impact">
      <h3>Ranked impact</h3>
      <p className="muted">Usefulness feedback changes ranking. Finding dispositions and the gate remain separate.</p>
      <div className="pr-fix-grid">{report?.surfaced.map((item, index) => <article className="pr-impact-card" key={item.id}>
        <span className="chip">{index + 1} · {item.claimClass}</span><p>{item.text}</p>
        <details><summary>Evidence and ranking</summary><ul>{item.citations.map((c, i) => <li key={i}><code>{c.path}:{c.startLine}–{c.endLine}</code></li>)}</ul><p>Score {item.rank.score} · {item.calibration}</p>{item.rank.factors.map(f => <p key={f.name}>{f.name}: {f.value} × {f.weight}</p>)}</details>
        <div className="row"><button disabled={busy || !current} onClick={() => void act("C17", "recordUsefulness", { repositoryId, analysisId: view.analysisId, itemId: item.id, itemKind: item.kindDetail ?? item.kind, label: "USEFUL" })}>Useful</button><button className="secondary" disabled={busy || !current} onClick={() => void act("C17", "recordUsefulness", { repositoryId, analysisId: view.analysisId, itemId: item.id, itemKind: item.kindDetail ?? item.kind, label: "NOISE" })}>Noise</button><button className="secondary" onClick={() => { setCommand(`/cie why ${index + 1}`); onNavigate("conversation"); }}>Ask why</button><button className="secondary" disabled={busy || !current} onClick={() => void act("C29", "setMute", { repositoryId, kind: item.kindDetail ?? item.kind, scope: { type: "REPOSITORY" }, reason: "Muted from the review workspace" })}>Mute kind</button></div>
      </article>)}</div>
      {!loading && !report?.surfaced.length && <p>No impact items surfaced under the current ranking policy.</p>}
      {feedback && <details><summary>Review feedback · {feedback.labels.total} labels</summary><p>{feedback.labels.useful} useful · {feedback.labels.noise} noise</p>{feedback.mutes.active.map(m => <p key={m.id}>{m.kind} muted <button disabled={busy} onClick={() => void act("C29", "clearMute", { repositoryId, id: m.id })}>Unmute</button></p>)}<button disabled={busy || !current} onClick={() => void act("C17", "recomputeWeights", { repositoryId })}>Recompute ranking weights</button><p className="muted">New weights apply when the analysis is run again.</p></details>}
      {!!report?.fog.length && <details><summary>Evidence gaps ({report.fog.length})</summary>{report.fog.map(item => <p key={item.id}>{item.text}</p>)}</details>}
    </section>}
    {tab === "conversation" && <section aria-label="PR conversation">
      <h3>Ask about this change</h3><p className="muted">Answers use this PR’s indexed head. These commands stay in the app; posting thread replies uses the CLI watcher. Free-form answering is not enabled in this build.</p>
      <div className="row">{["help", "impact", "tests", "callers"].map(verb => <button className="secondary" key={verb} onClick={() => setCommand(`/cie ${verb}${verb === "help" ? "" : " this"}`)}>{verb}</button>)}</div>
      <div className="pr-thread" aria-live="polite">{replies.map((entry, i) => <article key={i}><p><strong>You</strong> <code>{entry.command}</code></p>{entry.reply.claims.map((claim, n) => <div key={n}><span className="chip">{claim.class}</span><p>{claim.text}</p>{claim.evidence.map(ev => <code key={ev.id}>{ev.path ?? ev.id}{ev.startLine ? `:${ev.startLine}` : ""} </code>)}</div>)}{entry.reply.refusedReason && <p>{entry.reply.refusedReason}</p>}{entry.reply.gaps.map((gap, n) => <p className="muted" key={n}>{gap}</p>)}</article>)}</div>
      <form className="row" onSubmit={e => { e.preventDefault(); void ask(); }}><label htmlFor="pr-command">Command</label><input id="pr-command" value={command} maxLength={8000} onChange={e => setCommand(e.target.value)} /><button disabled={busy || !current || !command.trim()}>Ask</button></form>
    </section>}
    {tab === "fixes" && <section aria-label="Validated fix suggestions">
      <h3>Validated fix suggestions</h3><p className="muted">Prepare a candidate, inspect its edit and checks, then publish it explicitly. Missing candidates and checks remain visible.</p>
      <div className="pr-fix-grid">{view.findings.introduced.map(f => <article className="pr-impact-card" key={f.findingId}><strong>{f.summary}</strong><p><code>{f.path}{f.line ? `:${f.line}` : ""}</code></p><button disabled={busy || !current} onClick={() => void act("C28", "prepareSuggestion", { analysisId: view.analysisId, findingId: f.findingId })}>Prepare fix</button></article>)}</div>
      {!loading && !suggestions.length && <p>No validated suggestions are stored. Preparation requires a configured candidate provider or a supplied validated candidate.</p>}
      {suggestions.map(s => <article className="pr-impact-card" key={s.id}><h4>{s.path}:{s.startLine}–{s.endLine} <span className="chip">{s.state}</span></h4><div className="pr-diff-grid"><div><h5>Before</h5><pre>{s.expected}</pre></div><div><h5>Proposed</h5><pre>{s.replacement}</pre></div></div><ul>{s.checks.map(c => <li key={c.name}><strong>{c.name}: {c.outcome}</strong> — {c.detail}</li>)}</ul>
        {publishId === s.id ? <div className="row"><p>Publish this exact suggestion to GitHub at head {s.headHash.slice(0, 7)}?</p><button disabled={busy || !current || s.headHash !== view.headHash} onClick={() => void act("C30", "publishSuggestion", { suggestionId: s.id })}>Confirm publication</button><button className="secondary" onClick={() => setPublishId(null)}>Cancel</button></div> : <button disabled={busy || !current || s.state !== "PREPARED" || s.headHash !== view.headHash} onClick={() => setPublishId(s.id)}>Review publication…</button>}
      </article>)}
    </section>}
  </div>;
}
