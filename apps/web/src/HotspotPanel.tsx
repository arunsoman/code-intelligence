import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CouplingEdgeView, ExplainCouplingView, ExplainHotspotView, HotspotReportView, HotspotScoreRow, RankStabilityView } from "@cie/schema";
import { call } from "./api.ts";
import { Modal } from "./Modal.tsx";

/**
 * Historical hotspots and change coupling (F06, §15). One dialog, honest at every level:
 *  — a header strip with the analysed boundary, the merge policy, the shallow warning and the
 *    exclusion ledger (every excluded commit is listed with its rule, never silently dropped),
 *  — a sortable table (aria-sort, keyboard-operable headers) whose every row opens into its factors,
 *    counted changes and excluded commits (F06-A5),
 *  — a coupling tab that always shows the support count and marks hidden coupling (F06-A3),
 *  — a stability strip (top-K under ±% weight perturbation, F06-D10).
 * Missing data is hatched and labelled "no data"; a shallow clone says its scores are lower bounds.
 */

type SortKey = "SCORE" | "CHANGES" | "HEALTH" | "IMPACT";

export function HotspotPanel({ repoPath, revision, onClose, onPickFile }: {
  repoPath: string;
  revision?: string;
  onClose: () => void;
  onPickFile?: (path: string) => void;
}) {
  const [report, setReport] = useState<HotspotReportView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<SortKey>("SCORE");
  const [tab, setTab] = useState<"HOTSPOTS" | "COUPLING">("HOTSPOTS");
  const [explain, setExplain] = useState<ExplainHotspotView | null>(null);
  const [edges, setEdges] = useState<CouplingEdgeView[]>([]);
  const [edgeExplain, setEdgeExplain] = useState<ExplainCouplingView | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const liveId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (explain) setExplain(null); else if (edgeExplain) setEdgeExplain(null); else onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); openerRef.current?.focus?.(); };
  }, [onClose, explain, edgeExplain]);

  const load = useCallback(async (runId: string, ord: SortKey) => {
    setBusy("loading the report");
    const r = await call<{ report: HotspotReportView }>("C26", "getHotspotReport", { runId, order: ord });
    setBusy(null);
    if (!r.ok) { setError(r.error.message); return; }
    setReport(r.value.report);
  }, []);

  const analyze = async () => {
    setBusy("reading history"); setError(null);
    const r = await call<{ runId?: string }>("C26", "analyzeHistory", { repoPath, policy: { window: { months: 12 } } }, `history-ui:${repoPath}:${Date.now()}`);
    if (!r.ok) { setBusy(null); setError(r.error.message); return; }
    const runId = r.value.runId ?? (r.value as unknown as { value?: { runId?: string } }).value?.runId;
    if (!runId) { setBusy(null); setError("the analysis finished without a run id"); return; }
    setBusy(null);
    await load(runId, order);
  };

  const openCoupling = async () => {
    setTab("COUPLING");
    if (!report) return;
    setBusy("loading co-change edges");
    const r = await call<{ edges: CouplingEdgeView[]; total: number; belowFloorCount: number | null }>("C26", "listCoupling", { runId: report.runId, limit: 50 });
    setBusy(null);
    if (!r.ok) { setError(r.error.message); return; }
    setEdges(r.value.edges);
  };

  const openExplain = async (row: HotspotScoreRow) => {
    setBusy("explaining the rank");
    const r = await call<{ explain: ExplainHotspotView }>("C23", "explainHotspot", { runId: row.runId, lineageId: row.lineageId });
    setBusy(null);
    if (!r.ok) { setError(r.error.message); return; }
    setExplain(r.value.explain);
  };
  const openEdgeExplain = async (e: CouplingEdgeView) => {
    setBusy("explaining the edge");
    const r = await call<{ explain: ExplainCouplingView }>("C23", "explainCoupling", { edgeId: e.edgeId });
    setBusy(null);
    if (!r.ok) { setError(r.error.message); return; }
    setEdgeExplain(r.value.explain);
  };

  const sorted = useMemo(() => report?.rows ?? [], [report]);
  const changeSort = (k: SortKey) => {
    setOrder(k);
    if (report) void load(report.runId, k);
  };
  const ariaSort = (k: SortKey) => (order === k ? "ascending" : "none");

  return (
    <Modal title="Hotspots" onClose={onClose} className="hotspot-modal"
      actions={<><span className="muted small">The score is a prioritisation heuristic; co-change is not a dependency; contributor identity is keyed and names appear only with a policy and a grant (F06-A6).</span><button onClick={onClose}>Done</button></>}>
      {report && <p className="muted small">history {report.boundary.since?.slice(0, 10) ?? "start"} → {report.boundary.until.slice(0, 10)} · {report.boundary.commitCount} commits{report.mergePolicyUsed ? ` · ${report.mergePolicyUsed}` : ""}{report.state === "PARTIAL" ? " · partial" : ""}</p>}
        <p className="muted small" role="status" aria-live="polite" id={liveId}>
          {busy ?? (report ? `${sorted.length} ranked file(s); ${report.exclusions.total} excluded commit(s) listed with reasons` : "No analysis yet. A score is a prioritisation heuristic, never a defect probability.")}
        </p>
        {report?.warnings.length ? <ul className="dirs small" aria-label="Warnings">{report.warnings.map((w) => <li key={w} className="mono">{w}</li>)}</ul> : null}
        {report?.coverage.shallow && <p className="badge warn">this clone is shallow: every score here is a lower bound</p>}

        <div className="hotspot-toolbar" role="tablist" aria-label="Hotspot views">
          <button role="tab" aria-selected={tab === "HOTSPOTS"} className="secondary small" onClick={() => setTab("HOTSPOTS")}>Ranked files</button>
          <button role="tab" aria-selected={tab === "COUPLING"} className="secondary small" onClick={() => void openCoupling()}>Change coupling</button>
          <button className="secondary small" onClick={() => void analyze()} disabled={busy !== null}>{report ? "Re-analyse" : "Analyse history"}</button>
          {report && <span className="muted small" title="Policy hash: the same policy and boundary give the same rows">policy {report.policyHash.slice(0, 8)}</span>}
        </div>

        {tab === "HOTSPOTS" && report && (
          <table className="hotspot-table">
            <caption className="small muted">A score is a composite of the listed factors; click a row for the commits behind it.</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">File</th>
                <th scope="col" aria-sort={ariaSort("SCORE") as "ascending" | "none"}><button className="link" onClick={() => changeSort("SCORE")}>Score</button></th>
                <th scope="col" aria-sort={ariaSort("CHANGES") as "ascending" | "none"}><button className="link" onClick={() => changeSort("CHANGES")}>Changes</button></th>
                <th scope="col" aria-sort={ariaSort("HEALTH") as "ascending" | "none"}><button className="link" onClick={() => changeSort("HEALTH")}>Health</button></th>
                <th scope="col" aria-sort={ariaSort("IMPACT") as "ascending" | "none"}><button className="link" onClick={() => changeSort("IMPACT")}>Impact</button></th>
                <th scope="col">Knowledge</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={row.lineageId} tabIndex={0} role="button" aria-label={`${row.path}, score ${row.score.toFixed(2)}, rank ${row.rank}`}
                  onKeyDown={(ev) => { if (ev.key === "Enter") void openExplain(row); }} onClick={() => void openExplain(row)}>
                  <td>{row.rank}{row.rankRaw !== row.rank ? <span className="badge warn" title={`counting every excluded commit back in would rank it ${row.rankRaw}`}> {row.rankRaw}</span> : null}</td>
                  <td className="mono" title={row.path}>
                    {row.path}{row.renamedFrom.length ? <span className="muted small"> ← {row.renamedFrom.join(" ← ")}</span> : null}
                    {onPickFile && <button className="link small" onClick={(ev) => { ev.stopPropagation(); onPickFile(row.path); }}>show</button>}
                  </td>
                  <td>{row.score.toFixed(2)}</td>
                  <td>{row.change.raw}{row.change.logical !== row.change.raw ? <span className="muted small"> ({row.change.logical} logical)</span> : null}</td>
                  <td>{row.health.signals.some((s) => s.status === "ABOVE") ? `${row.health.signals.filter((s) => s.status === "ABOVE").length} over threshold` : row.missing.includes("health") ? <span className="hatch">no data</span> : "ok"}</td>
                  <td>{row.impact.dependents} dependents · {row.impact.incidents === "NOT_AVAILABLE" ? <span className="hatch">incidents n/a</span> : `${row.impact.incidents} incidents`} · {row.impact.coveragePercent === "NOT_AVAILABLE" ? <span className="hatch">coverage n/a</span> : `${row.impact.coveragePercent}%`}</td>
                  <td>{row.knowledge.contributors === "HIDDEN" ? "hidden" : `${row.knowledge.contributors} author(s)`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === "COUPLING" && (
          <div>
            <p className="muted small">Statistical co-change, kept out of the static call graph on purpose. A relation always shows its support count; “NO static dependency” marks hidden coupling.</p>
            {edges.length === 0 ? <p className="muted">No co-change edge is above the reporting floor for this run.</p> : (
              <ul className="dirs" aria-label="Change coupling edges">
                {edges.map((e) => (
                  <li key={e.edgeId} className="mono">
                    <button className="link" onClick={() => void openEdgeExplain(e)}>{e.aPath} ↔ {e.bPath}</button>
                    <span className="muted small"> changed together in {e.support} of {e.countA}/{e.countB} changes · lift {e.lift.toFixed(2)} · {e.staticDependency === "NONE" ? "NO static dependency" : e.staticDependency === "UNKNOWN" ? "static relation unknown (nothing indexed)" : `static ${e.staticDependency}`}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {report?.stability && (
          <p className="muted small" aria-label="Rank stability">
            Ranking stability ({report.stability.trials} re-rankings, weights varied ±{report.stability.perturbationPercent}%, seed {report.stability.seedHex}):
            the top {report.stability.topK} are the same in {Math.round(report.stability.stableFraction * 100)}% of them.
          </p>
        )}

        {report && (
          <details>
            <summary>Excluded from the counts ({report.exclusions.total})</summary>
            <ul className="dirs small" aria-label="Excluded commits">
              {report.exclusions.byRule.map((b) => <li key={b.rule}>{b.rule}: {b.count}</li>)}
              {report.exclusions.ubiquitousFiles.length > 0 && <li className="muted small">{report.exclusions.ubiquitousFiles.length} ubiquitous file(s) left out of the co-change population (changed in more than the policy share of logical changes)</li>}
              {report.exclusions.samples.map((s) => <li key={s.commitHash} className="mono">{s.commitHash.slice(0, 10)} {s.subject} — {s.classReason || s.rule}</li>)}
            </ul>
          </details>
        )}
        {report && <ul className="dirs small muted" aria-label="What this does not tell you">{report.coverage.gaps.map((g) => <li key={g}>{g}</li>)}</ul>}
        {error && <p className="badge warn" role="alert">{error}</p>}

        {explain && (
          <Modal title={`${explain.path} — rank ${explain.rank}`} onClose={() => setExplain(null)} className="hotspot-explain">
            <p className="muted small">score {explain.score.toFixed(2)}</p>
            <table className="hotspot-table">
              <thead><tr><th scope="col">Factor</th><th scope="col">Raw</th><th scope="col">Weight</th><th scope="col">Contribution</th></tr></thead>
              <tbody>
                {explain.factors.map((f) => <tr key={f.id}><td>{f.label}{f.missing ? <span className="badge warn" title="Missing data counted as a neutral 0.5"> no data</span> : null}</td><td>{f.raw}</td><td>{f.weight.toFixed(2)}</td><td>{f.contribution.toFixed(4)}</td></tr>)}
              </tbody>
            </table>
            <p className="muted small">The contributions sum to the score. Rank with each exclusion class counted back in: {explain.sensitivity.withClass.map((w) => `${w.rule} → ${w.rank}`).join(", ") || "no excluded class touches it"}. Remove one factor: {explain.sensitivity.withoutFactor.map((w) => `${w.label} → ${w.rank}`).join(", ")}.</p>
            <h4>Counted changes ({explain.changes.length})</h4>
            <ul className="dirs small" aria-label="Counted commits">{explain.changes.map((c) => <li key={c.commitHash} className="mono">{c.committedAt.slice(0, 10)} {c.commitHash.slice(0, 8)} {c.subject}{c.prNumber ? ` (#${c.prNumber})` : ""}</li>)}</ul>
            <h4>Excluded commits touching this file ({explain.excluded.length})</h4>
            <ul className="dirs small" aria-label="Excluded commits touching this file">{explain.excluded.length ? explain.excluded.map((c) => <li key={c.commitHash} className="mono">{c.committedAt.slice(0, 10)} {c.subject} — {c.rule}{c.classReason ? `: ${c.classReason}` : ""}</li>) : <li className="muted">none</li>}</ul>
            {explain.contributors && <><h4>Contributors (names shown because the policy allows them and you hold a grant)</h4><ul className="dirs small">{explain.contributors.map((c) => <li key={c.displayName}>{c.displayName} — {c.commits} commit(s)</li>)}</ul></>}
            <h4>Trend</h4>
            <p className="mono small">{explain.trend.map((t) => `${t.month}:${t.raw}`).join("  ") || "no counted changes"}</p>
            <ul className="dirs small muted">{explain.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
          </Modal>
        )}

        {edgeExplain && (
          <Modal title={`${edgeExplain.aPath} ↔ ${edgeExplain.bPath}`} onClose={() => setEdgeExplain(null)} className="hotspot-explain">
            <p className="muted small">Support {edgeExplain.support} of {edgeExplain.total} eligible logical changes · countA {edgeExplain.countA} · countB {edgeExplain.countB} · confidence {edgeExplain.confidenceAToB.toFixed(2)} / {edgeExplain.confidenceBToA.toFixed(2)} · lift {edgeExplain.lift.toFixed(2)} · {edgeExplain.staticDependency === "NONE" ? "NO static dependency (hidden coupling)" : edgeExplain.staticDependency === "UNKNOWN" ? "static relation unknown (nothing indexed)" : `static ${edgeExplain.staticDependency}`}</p>
            <ul className="dirs small" aria-label="Commits where both changed">{edgeExplain.commits.map((c) => <li key={c.commitHash} className="mono">{c.committedAt.slice(0, 10)} {c.subject}</li>)}</ul>
            <ul className="dirs small muted">{edgeExplain.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
          </Modal>
        )}
    </Modal>
  );
}
