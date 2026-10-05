import { useEffect, useMemo, useState } from "react";
import type { ViewSpec } from "@cie/schema";
import { arrange } from "../arrange.ts";
import { basePositions, render } from "../graph.ts";
import type { FeatureReview, ReviewFile } from "../../../../packages/core/src/feature/presentation.ts";
import type { RemoteCall } from "./remote.ts";
import { REPRESENTATIONS, countsLine, criterionEvidence, defaultRepresentation, downloadName, filePosition, filterFiles, lineNotice, pageOf, parseSplitRows, representationDisabled, selectFromGraph, viewerPath } from "./review-view.ts";
export type FilePage = { sourceArtifactRef: string; content: string; complete: boolean; startLine?: number; nextLine?: number; totalLines?: number };
type Result<T> = { status: string; value?: T; diagnostics: string[] };
const uid = () => crypto.randomUUID();

export function ClarifyReview({ review, version, requestId, call, refresh, notify }: { review: FeatureReview; version: number; requestId: string; call: RemoteCall; refresh: () => Promise<void>; notify: (text: string) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}); const [busy, setBusy] = useState<string | null>(null);
  const current = review.decisions.filter((d) => !review.decisions.some((other) => other.supersedesId === d.id));
  const answer = async (id: string, supersedes?: string) => {
    setBusy(id);
    try {
      const r = await call<{ id: string }>("C02", "recordDecision", { contractId: `contract:${requestId}`, expectedVersion: version, questionId: id, answer: answers[id], ...(supersedes ? { supersedes } : {}) }, uid());
      if (!r.ok) { notify(r.error.message); await refresh(); return; }
      if (version > 0) {
        const revised = await call("C15", "reviseContract", { contractId: `contract:${requestId}`, expectedVersion: version, decisionIds: [r.value.id] }, uid());
        notify(revised.ok ? "Answer recorded. Contract version changed; affected candidate and evidence require revalidation." : `Answer recorded; contract revision needs attention: ${revised.error.message}`);
      } else notify("Answer recorded. No contract has been created yet.");
      await refresh(); setAnswers((a) => ({ ...a, [id]: "" }));
    } catch { notify("Could not save the answer. Reload to check its recorded state before retrying."); }
    finally { setBusy(null); }
  };
  return <div>
    <OverlapReview review={review} />
    <p>Answers retain their actor and version. Policy and access questions require the recorded authority.</p>
    {review.questions.map((q) => <fieldset key={q.id}><legend>{q.id}: {q.text}</legend><p>{q.whyNeeded}</p><p>Requirements: {q.requirementIds.join(", ") || "request scope"} · Authority: {q.scope}</p>
      {q.choices.map((choice) => <button className="secondary" key={choice} onClick={() => setAnswers((a) => ({ ...a, [q.id]: choice }))}>{choice}</button>)}
      <label>Answer {q.id}<input className="input" value={answers[q.id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} /></label>
      <button disabled={busy !== null || !answers[q.id]?.trim()} onClick={() => void answer(q.id)}>Record answer</button>
    </fieldset>)}
    {!review.questions.length && <p>No unanswered questions recorded.</p>}
    <h4>Recorded decisions</h4>{current.map((d) => <details key={d.id}><summary>{d.questionId ?? d.id}: {d.answer} — {d.actorId}</summary><p>Contract v{d.contractVersion} · {d.authorityBindingId ?? "requester business authority"}</p>
      <label>Revise {d.questionId ?? d.id}<input className="input" value={answers[d.questionId ?? d.id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [d.questionId ?? d.id]: e.target.value }))} /></label>
      <button disabled={busy !== null || !answers[d.questionId ?? d.id]?.trim()} onClick={() => void answer(d.questionId ?? d.id, d.id)}>Record new version</button>
    </details>)}
  </div>;
}
export function OverlapReview({ review }: { review: FeatureReview }) {
  const overlap = review.overlap;
  return <section aria-label="Existing support and overlap"><h4>Existing support</h4>{!overlap ? <p>Not assessed. Similarity or missing search results do not establish equivalence.</p> : <><p>{overlap.relationship} · Proposed strategy: {overlap.strategy}</p><ul>{overlap.mappings.map((m) => <li key={m.acceptanceId}>{m.acceptanceId}: {m.disposition} · {m.coverageState}<p>{m.differences.join("; ") || "No differences recorded within the assessed scope."}</p><span>Evidence: {m.evidenceIds.join(", ") || "missing"}</span></li>)}</ul><p>Alternatives: {overlap.alternatives.join("; ") || "none recorded"}</p>{overlap.unresolvedIds.length > 0 && <p>Unresolved: {overlap.unresolvedIds.join(", ")}</p>}</>}</section>;
}
export function PlanReview({ review }: { review: FeatureReview }) {
  return <div><OverlapReview review={review} /><h4>Requirements and acceptance criteria</h4>{review.requirements.map((r) => <details key={r.id} open><summary>{r.id}: {r.text} — {r.status}</summary><p>{r.type} · {r.origin} · Source: {r.source.locator}</p><p>Conditions: {r.conditions.join("; ") || "none recorded"}</p><ul>{review.criteria.filter((a) => a.requirementIds.includes(r.id)).map((a) => <li key={a.id}>{a.id}: {a.scenario} → {a.expectedOutcome}<p>{a.mandatory ? "Mandatory" : "Advisory"} · Oracle: {a.oracleOrigin} · Checks: {a.validationKinds.join(", ")}</p></li>)}</ul></details>)}
    <h4>Planned work</h4><ul>{review.tasks.map((t) => <li key={t.id}>{t.id}: {t.componentId} · {t.state} · Requirements {t.requirementIds.join(", ")}<p>Planned edits: {t.plannedEdits.join(", ") || "none recorded"} · Dependencies: {t.dependencyTaskIds.join(", ") || "none"}</p></li>)}</ul>{review.gaps.map((g) => <p key={g} className="warn">{g}</p>)}</div>;
}
export function ChangeReview({ review, requestId, candidateHash, call }: { review: FeatureReview; requestId: string; candidateHash?: string; call: RemoteCall }) {
  const [path, setPath] = useState<string>(); const [requirement, setRequirement] = useState(""); const [filter, setFilter] = useState(""); const [status, setStatus] = useState(""); const [page, setPage] = useState(0);
  const [graph, setGraph] = useState<ViewSpec>(); const [graphNote, setGraphNote] = useState("");
  const files = filterFiles(review.files, { requirement, status, filter }); const shown = pageOf(files, page);
  const selected = review.files.find((f) => f.path === path);
  useEffect(() => { setPath(undefined); setPage(0); }, [candidateHash]);
  useEffect(() => {
    let live = true; setGraph(undefined);
    void call<Result<{ viewSpec: ViewSpec }>>("C19", "compileChangeGraph", { requestId, candidateHash, filters: { requirementId: requirement, path: filter, status }, budget: { nodes: 90 } }).then((r) => {
      if (!live) return; if (!r.ok) { setGraphNote(r.error.message); return; }
      setGraph(r.value.value?.viewSpec); setGraphNote(r.value.diagnostics.join(" "));
    }).catch(() => { if (live) setGraphNote("Graph unavailable. The file list remains available."); });
    return () => { live = false; };
  }, [requestId, candidateHash, requirement, filter, status, call]);
  const laidOut = useMemo(() => graph ? arrange(render(graph, 5, basePositions(graph)), graph, 5) : undefined, [graph]);
  const selectNode = (id: string) => { const s = selectFromGraph(id); if (s.file) setPath(s.file); if (s.requirement) { setRequirement(s.requirement); setPage(0); } };
  const xs = laidOut?.nodes.map((n) => n.pos.x) ?? [0], ys = laidOut?.nodes.map((n) => n.pos.y) ?? [0];
  return <div>
    <p>Revision: {candidateHash ?? "planned work; no candidate"}</p><p>{countsLine(review.fileCounts)}</p>
    <div className="row" style={{ flexWrap: "wrap" }}><label>Search files<input className="input" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} /></label>
      <label>Requirement<select className="input" value={requirement} onChange={(e) => { setRequirement(e.target.value); setPage(0); }}><option value="">All</option>{review.requirements.map((r) => <option key={r.id} value={r.id}>{r.id}: {r.text}</option>)}</select></label>
      <label>File status<select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}><option value="">All</option>{Object.keys(review.fileCounts).map((s) => <option key={s}>{s}</option>)}</select></label></div>
    <details><summary>Change graph — equivalent actions are in the file list</summary>{laidOut && <svg role="group" aria-label="Requirement component file graph" viewBox={`${Math.min(...xs) - 140} ${Math.min(...ys) - 45} ${Math.max(...xs) - Math.min(...xs) + 280} ${Math.max(...ys) - Math.min(...ys) + 90}`} style={{ width: "100%", minHeight: 180, maxHeight: 380 }}>
      {laidOut.edges.map((e) => { const a = laidOut.nodes.find((n) => n.id === e.from)!, b = laidOut.nodes.find((n) => n.id === e.to)!; return <g key={e.id}><line x1={a.pos.x} y1={a.pos.y} x2={b.pos.x} y2={b.pos.y} stroke="currentColor" strokeDasharray={e.kind === "potential-impact" ? "5 4" : undefined} /><title>{e.kind}</title></g>; })}
      {laidOut.nodes.map((n) => <g key={n.id} role="button" tabIndex={0} aria-label={n.label} onClick={() => selectNode(n.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectNode(n.id); } }}><rect x={n.pos.x - 120} y={n.pos.y - 18} width={240} height={36} rx={5} fill="var(--bg, #fff)" stroke="currentColor" /><text x={n.pos.x} y={n.pos.y + 4} textAnchor="middle" fontSize={11} fill="currentColor">{n.label.length > 35 ? n.label.slice(0, 32) + "…" : n.label}</text><title>{n.label}</title></g>)}
    </svg>}<p>{graphNote}</p></details>
    <ul aria-label="Changed and planned files" className="dirs">{shown.items.map((f) => <li key={f.path}><button className="secondary" aria-pressed={path === f.path} onClick={() => setPath(f.path)}>{filePosition(f)}</button><span> {f.requirementIds.join(", ") || "attribution missing"}</span></li>)}</ul>
    {shown.paged && <div className="row"><button disabled={!shown.hasPrev} onClick={() => setPage(page - 1)}>Previous files</button><span>{shown.from}–{shown.to} of {shown.total}</span><button disabled={!shown.hasNext} onClick={() => setPage(page + 1)}>Next files</button></div>}
    {selected && <section aria-label="Selected file details"><h4>{selected.path}</h4><p>{selected.kind} · Attribution: {selected.attribution}</p><p>Components: {selected.componentIds.join(", ") || "unassigned"} · Tasks: {selected.taskIds.join(", ") || "unassigned"}</p>
      <ul>{selected.requirementIds.map((id) => <li key={id}><button className="secondary" onClick={() => setRequirement(id)}>{id}</button> {review.requirements.find((r) => r.id === id)?.text}</li>)}</ul>
      {selected.gaps.map((g) => <p className="muted" key={g}>{g}</p>)}
      <h5>Related criterion evidence</h5>{criterionEvidence(review, selected).map((a) => <p key={a.id}>{a.id}: {a.expectedOutcome} — {a.evidence}</p>)}
      {candidateHash && selected.kind !== "PLANNED" ? <FileViewer key={`${candidateHash}:${selected.path}`} file={selected} candidateHash={candidateHash} call={call} /> : <p>Planned file; candidate contents do not exist yet.</p>}
    </section>}
  </div>;
}
export function FileViewer({ file, candidateHash, call }: { file: ReviewFile; candidateHash: string; call: RemoteCall }) {
  const [representation, setRepresentation] = useState<string>(defaultRepresentation(file)); const [start, setStart] = useState(1); const [page, setPage] = useState<FilePage>(); const [error, setError] = useState(""); const [line, setLine] = useState<number>();
  const path = viewerPath(file, representation);
  useEffect(() => { let live = true; setPage(undefined); setError("");
    void call<Result<FilePage>>("C28", "readCandidateFile", { candidateHash, path, representation, range: [start, start + 199] }).then((r) => { if (!live) return; if (!r.ok) setError(r.error.message); else if (r.value.value) setPage(r.value.value); }).catch(() => { if (live) setError("File read failed. Retry this page."); });
    return () => { live = false; };
  }, [candidateHash, path, representation, start, call]);
  const download = async () => {
    try { const r = await call<Result<FilePage>>("C28", "readCandidateFile", { candidateHash, path, representation, download: true }); if (!r.ok) { setError(r.error.message); return; } if (!r.value.value?.complete) { setError("Full download unavailable; no partial file was downloaded."); return; }
      const url = URL.createObjectURL(new Blob([r.value.value.content], { type: "text/plain" })); const a = document.createElement("a"); a.href = url; a.download = downloadName(path, representation); a.click(); URL.revokeObjectURL(url);
    } catch { setError("Download failed; retry when the file is available."); }
  };
  let rows: { left: string | null; right: string | null }[] | undefined;
  if (representation === "SPLIT_DIFF" && page) { rows = parseSplitRows(page.content); /* undefined: an explicit error is shown, never malformed JSON as source */ }
  return <section aria-label="Candidate file viewer"><label>File representation<select className="input" value={representation} onChange={(e) => { setRepresentation(e.target.value); setStart(1); setLine(undefined); }}>
    {REPRESENTATIONS.map((r) => <option key={r} disabled={representationDisabled(file, r)}>{r}</option>)}</select></label>
    <p>{representation} · Candidate {candidateHash} · Reading code does not approve or validate it.</p>{error && <p role="alert">{error}</p>}
    {page && <><p>{page.complete ? "Full file" : "Partial file view — more content is available by paging or download"} · {page.totalLines ?? "unknown"} lines</p>
      <div style={{ overflow: "auto", maxHeight: 420, maxWidth: "100%" }} tabIndex={0} aria-label="Source code">
        {rows ? <table><thead><tr><th>Line</th><th>Baseline</th><th>Candidate</th></tr></thead><tbody>{rows.map((r, n) => <tr key={n}><th><button className="secondary small" onClick={() => setLine(start + n)}>{start + n}</button></th><td><pre>{r.left ?? "—"}</pre></td><td><pre>{r.right ?? "—"}</pre></td></tr>)}</tbody></table> : representation === "SPLIT_DIFF" ? <p role="alert">Split diff is incomplete; request a smaller page.</p> : <ol start={start} style={{ fontFamily: "monospace" }}>{page.content.split("\n").map((text, n) => <li key={n}><button className="secondary small" aria-label={`Inspect line ${start + n}`} onClick={() => setLine(start + n)}>{start + n}</button><code style={{ whiteSpace: "pre" }}>{text}</code></li>)}</ol>}
      </div><div className="row"><button className="secondary" disabled={start === 1} onClick={() => setStart(Math.max(1, start - 200))}>Previous lines</button><button className="secondary" disabled={!page.nextLine} onClick={() => setStart(page.nextLine!)}>Next lines</button><button className="secondary" onClick={() => void download()}>Download full file</button></div></>}
    {line && <p role="status">{lineNotice(file, line)}</p>}
  </section>;
}
