import { useEffect, useMemo, useRef, useState } from "react";
import type { DetectorFinding, JobView, ResolvedEvidence } from "@cie/schema";
import { call } from "./api.ts";
import { Loading } from "./Skeleton.tsx";
import { GLOSSARY, GROUP_H, KIND_INFO, KIND_LABEL, LEVEL_INFO, ROW, RULE_HINT, SEVERITIES, STATUS_INFO, type Row, type TriageStatus,
  filterFindings, flatten, groupByFile, groupByFile as groupsOf, locationOf, offsetOf, relative, rowLabel, sevClass, severityCounts, statusOf, truncateMiddle, windowOf } from "./defect-list.ts";

const cssEscape = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `_${c.charCodeAt(0)}_`).slice(0, 60);

function download(name: string, content: string, type: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const load = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } };
const persist = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage off: triage stays in-memory */ } };

/**
 * "Defects and performance" review panel. Read-only about the repository: the browser controls
 * analysis (a C26 job) and read-only evidence, and tracks its own triage decisions in localStorage
 * (no server-side state, so nothing here can silently write to the platform's claim or verdict history).
 */
export function DefectPanel({ revision, onClose }: { revision: string; onClose: () => void }) {
  // data
  const [findings, setFindings] = useState<DetectorFinding[]>([]);
  const [evidence, setEvidence] = useState<Map<string, ResolvedEvidence>>(new Map());
  const [detailEvidence, setDetailEvidence] = useState<ResolvedEvidence[]>([]);
  const [factLocations, setFactLocations] = useState<{ file: string; absPath?: string; startLine: number; endLine: number; state: string }[]>([]);
  const [job, setJob] = useState<JobView | null>(null);
  const [meta, setMeta] = useState<{ repoRoot: string; gitHead: string | null; createdAt: string; files: number; symbols: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzedAt, setAnalyzedAt] = useState<string | null>(() => load<string | null>(`defect-analyzed:${revision}`, null));
  const [elapsed, setElapsed] = useState(0);
  const [triage, setTriage] = useState<Map<string, TriageStatus>>(() => new Map(Object.entries(load<Record<string, TriageStatus>>(`defect-triage:${revision}`, {}))));
  const [toast, setToast] = useState<string | null>(null);

  // list machinery
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [severities, setSeverities] = useState<Set<typeof SEVERITIES[number]>>(new Set());
  const [kindFilter, setKindFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<TriageStatus | "ALL">("ALL");
  const [groupBy, setGroupBy] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [listH, setListH] = useState(600);
  const [width, setWidth] = useState(() => load<number>("defect-panel-width", 1100));
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 900px)").matches);

  const listRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2500); };

  // load findings, revision context, then one batched location read for the rows (UX-01/23)
  useEffect(() => {
    let live = true;
    setLoading(true); setFindings([]); setSelected(null); setError(null); setJob(null); setChecked(new Set()); setToast(null);
    void (async () => {
      const [r, info] = await Promise.all([
        call<DetectorFinding[]>("C26", "listFindings", { revision }),
        call<{ repoRoot: string; gitHead: string | null; createdAt: string; files: number; symbols: number }>("C13", "revisionStats", { revision }),
      ]);
      if (!live) return;
      if (!r.ok) { setError(r.error.message); setLoading(false); return; }
      if (info.ok) setMeta(info.value);
      const fs = r.value;
      setFindings(fs);
      void resolveRowEvidence(fs);
      setAnalyzedAt(load<string | null>(`defect-analyzed:${revision}`, null));
      setLoading(false);
    })();
    return () => { live = false; };
  }, [revision]);

  // One read op resolves the first evidence per finding, so every row can name its file:line.
  const resolveRowEvidence = async (fs: DetectorFinding[]) => {
    const ids = [...new Set(fs.flatMap((f) => f.evidenceIds.slice(0, 1)))].slice(0, 2000);
    if (!ids.length) return;
    const ev = await call<ResolvedEvidence[]>("C18", "evidenceBatch", { revision, evidenceIds: ids });
    if (ev.ok) setEvidence(new Map(ev.value.map((e) => [e.id, e])));
  };

  // keep the list's scroll offset stable when data refreshes behind the user (UX-28)
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = savedScroll.current; }, [loading]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const on = () => setNarrow(mq.matches);
    const measure = () => setListH(listRef.current?.clientHeight ?? 600);
    mq.addEventListener("change", on);
    window.addEventListener("resize", measure);
    measure();
    return () => { mq.removeEventListener("change", on); window.removeEventListener("resize", measure); };
  }, []);

  // lock page scroll behind the dialog (UX-13)
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // job polling (detect) with progress (UX-06/15)
  useEffect(() => {
    if (!job || !["QUEUED", "RUNNING"].includes(job.state)) return;
    let live = true;
    const tick = setInterval(() => setElapsed(Math.max(0, Math.round((Date.now() - new Date(job.startedAt ?? job.createdAt).getTime()) / 1000))), 500);
    const poll = async () => {
      const result = await call<JobView>("C07", "getJob", { jobId: job.id });
      if (!live || !result.ok) return;
      setJob(result.value);
      if (result.value.state === "SUCCEEDED") {
        setWarnings(result.value.result?.warnings ?? []);
        const fs = (result.value.result?.value as DetectorFinding[] | undefined) ?? [];
        setFindings(fs);
        void resolveRowEvidence(fs);
        const when = new Date().toISOString();
        setAnalyzedAt(when);
        persist(`defect-analyzed:${revision}`, when);
      } else if (result.value.state === "FAILED") setError(result.value.error?.message ?? "Detection failed");
    };
    const timer = setInterval(() => void poll(), 500);
    return () => { live = false; clearInterval(timer); clearInterval(tick); };
  }, [job?.id, job?.state, revision]);

  const finding = findings.find((f) => f.id === selected) ?? null;

  // detail reads: full evidence + recorded fact locations for the selected finding (UX-07)
  useEffect(() => {
    let live = true; setDetailEvidence([]); setFactLocations([]);
    if (!finding) return;
    void (async () => {
      const [ev, loc] = await Promise.all([
        finding.evidenceIds.length ? call<ResolvedEvidence[]>("C18", "evidenceBatch", { revision, evidenceIds: finding.evidenceIds }) : Promise.resolve(null),
        finding.spans.length ? call<{ file: string; absPath?: string; startLine: number; endLine: number; state: string }[]>("C26", "locateSpans", { revision, spans: finding.spans }) : Promise.resolve(null),
      ]);
      if (!live) return;
      if (ev?.ok) setDetailEvidence(ev.value);
      if (ev && !ev.ok) setError("Some source evidence is no longer available.");
      if (loc?.ok) setFactLocations(loc.value);
    })();
    return () => { live = false; };
  }, [finding?.id, finding?.version, revision]);

  const busy = !!job && ["QUEUED", "RUNNING"].includes(job.state);
  const detect = async () => {
    setError(null); setElapsed(0);
    const r = await call<JobView>("C26", "detect", { revision }, crypto.randomUUID());
    if (r.ok) setJob(r.value); else setError(r.error.message);
  };

  // triage (UX-04/05/21/24): statuses tracked in this browser
  const setStatus = (ids: string[], status: TriageStatus | null) => {
    const next = new Map(triage);
    for (const id of ids) { if (status === null) next.delete(id); else next.set(id, status); }
    setTriage(next);
    persist(`defect-triage:${revision}`, Object.fromEntries(next));
  };
  const dismiss = (ids: string[]) => {
    const reason = window.prompt(`Dismiss ${ids.length > 1 ? `${ids.length} findings` : "this finding"} (optional reason):`);
    if (reason === null) return; // cancel; an empty reason still dismisses
    setStatus(ids, "DISMISSED");
    setChecked(new Set());
    flash(ids.length > 1 ? `${ids.length} findings dismissed (in this browser)` : "Finding dismissed (in this browser)");
  };
  // obligation acknowledgements (UI-side): the server state stays authoritative below the local note
  const [ack, setAckRaw] = useState<Record<string, "DONE" | "NA">>(() => load<Record<string, "DONE" | "NA">>(`defect-obligations:${revision}`, {}));
  const setAck = (id: string, state: "DONE" | "NA" | null) => {
    const next = { ...ack }; if (state === null) delete next[id]; else next[id] = state;
    setAckRaw(next);
    persist(`defect-obligations:${revision}`, next);
  };

  // derived list (UX-02/03)
  const o = useMemo(() => ({ search, severities, kindFilter, statusFilter, groupByFile: groupBy }), [search, severities, kindFilter, statusFilter, groupBy]);
  const ordered = useMemo(() => filterFindings(findings, evidence, triage, o), [findings, evidence, triage, o]);
  const rows = useMemo(() => flatten(ordered, evidence, o, expanded), [ordered, evidence, o, expanded]);
  const sevCounts = useMemo(() => severityCounts(findings), [findings]);
  const kindCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of findings) m.set(f.kind, (m.get(f.kind) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [findings]);
  const counts = useMemo(() => {
    const c = { NEW: 0, REVIEWED: 0, DISMISSED: 0 };
    for (const f of findings) c[statusOf(f, triage)] += 1;
    return c;
  }, [findings, triage]);
  const findingIndex = ordered.findIndex((f) => f.id === selected);
  const groupCounts = useMemo(() => new Map(groupsOf(ordered, evidence).map((g) => [g.file, g.findings.length] as [string, number])), [ordered, evidence]);

  const [start, stop] = windowOf(rows.length, scrollTop, listH, ROW, 8);
  const shown = rows.slice(start, stop);

  const jump = (id: string | null) => {
    setSelected(id);
    if (!id) return;
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return;
    const top = offsetOf(rows, i);
    const list = listRef.current;
    if (list && (top < list.scrollTop || top + ROW > list.scrollTop + list.clientHeight)) list.scrollTop = Math.max(0, top - list.clientHeight / 2);
  };
  const step = (d: number) => {
    // With nothing selected, ArrowDown/j starts at the first finding; ArrowUp/k stays (standard listbox).
    const i = findingIndex < 0 ? (d > 0 ? -1 : -1 + ordered.length + 1) : findingIndex;
    const next = ordered[i + d];
    if (next) jump(next.id);
  };
  const selectRow = (f: DetectorFinding) => {
    if (narrow) { setSelected(f.id); return; } // drill-down: detail becomes its own screen
    const loc = locationOf(f, evidence);
    if (loc?.file && groupBy && !expanded.has(loc.file)) setExpanded(new Set([...expanded, loc.file]));
    jump(f.id);
  };
  const close = () => { if (busy && !window.confirm("Analysis is still running. Close the panel anyway?")) return; onClose(); };

  // export (UX-29)
  const exportAll = () => ordered.map((f) => {
    const loc = locationOf(f, evidence);
    return { kind: f.kind, label: KIND_LABEL(f.kind), severity: f.severity, file: loc?.file ?? null, line: loc?.startLine ?? null, rule: f.ruleId, ruleVersion: f.ruleVersion, evidenceLevel: f.evidenceLevel, status: statusOf(f, triage), coverageGaps: f.coverageGaps, obligations: f.safetyObligations.map((x) => ({ description: x.description, state: x.state })) };
  });
  const exportJSON = () => download(`${revision}-findings.json`, JSON.stringify(exportAll(), null, 2), "application/json");
  const exportCSV = () => {
    const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const head = "kind,severity,file,line,rule,ruleVersion,evidenceLevel,status,coverageGaps";
    const lines = exportAll().map((r) => [r.kind, r.severity, r.file ?? "", r.line ?? "", r.rule, r.ruleVersion, r.evidenceLevel, r.status, r.coverageGaps.join("; ")].map(esc).join(","));
    download(`${revision}-findings.csv`, [head, ...lines].join("\n"), "text/csv");
  };
  const copyMarkdown = (f: DetectorFinding) => {
    const loc = locationOf(f, evidence);
    const where = loc ? `${loc.file}:${loc.startLine}–${loc.endLine}` : "(no source evidence)";
    const text = [
      `## ${KIND_LABEL(f.kind)} · ${f.severity}`,
      `- Location: \`${where}\``,
      `- Rule: \`${f.ruleId}\` v${f.ruleVersion}`,
      `- Evidence level: ${f.evidenceLevel} (${LEVEL_INFO[f.evidenceLevel] ?? "unknown"})`,
      f.witness ? `- Witness: ${f.witness.detail}` : null,
      f.coverageGaps.length ? `- Coverage gaps: ${f.coverageGaps.join("; ")}` : null,
      f.safetyObligations.length ? `- Obligations: ${f.safetyObligations.map((x) => `${x.description} (${x.state})`).join("; ")}` : null,
    ].filter(Boolean).join("\n");
    void navigator.clipboard?.writeText(text).then(() => flash("Copied as markdown")).catch(() => flash("Copy failed"));
  };
  const copyText = (t: string) => { void navigator.clipboard?.writeText(t).then(() => flash("Copied")).catch(() => flash("Copy failed")); };

  // list pieces ----------------------------------------------------------
  const groupHeader = (r: Row) => {
    const isOpen = expanded.has(r.label);
    const n = groupCounts.get(r.label) ?? 0;
    const controlsId = `grp-${cssEscape(r.label)}`;
    return <div className="d-group" style={{ height: GROUP_H }} id={controlsId}>
      <button className="d-group-toggle" aria-expanded={isOpen} aria-controls={controlsId}
        onClick={() => { const next = new Set(expanded); if (isOpen) next.delete(r.label); else next.add(r.label); setExpanded(next); }}>
        <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span> <span title={r.label}>{truncateMiddle(r.label)}</span> <span className="d-count">{n}</span>
      </button>
      <button className="link d-select-file" aria-label={`Select all ${n} findings in ${truncateMiddle(r.label, 28)}`} title="Select all in this file"
        onClick={() => { const members = groupsOf(ordered, evidence).find((g) => g.file === r.label)?.findings.map((f) => f.id) ?? []; setChecked((c) => new Set([...c, ...members])); }}>select all</button>
    </div>;
  };
  const rowEl = (f: DetectorFinding, loc: ResolvedEvidence | null) => {
    const st = statusOf(f, triage);
    return <div role="option" aria-selected={selected === f.id} tabIndex={selected === f.id ? 0 : -1} key={f.id} data-finding={f.id}
      className={`d-row${selected === f.id ? " on" : ""}${st === "DISMISSED" ? " dim" : ""}`} style={{ height: ROW }}
      aria-label={rowLabel(f, loc)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectRow(f); }
        else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); e.stopPropagation(); step(1); }
        else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); e.stopPropagation(); step(-1); }
      }}
      onClick={() => selectRow(f)}>
      <input type="checkbox" checked={checked.has(f.id)} onChange={(e) => { const n = new Set(checked); if (e.target.checked) n.add(f.id); else n.delete(f.id); setChecked(n); }}
        onClick={(e) => e.stopPropagation()} aria-label={`Select ${rowLabel(f, loc)}`} />
      <span className="d-where mono" title={loc ? `${loc.file}:${loc.startLine}–${loc.endLine}` : "no source evidence"} aria-hidden="true">
        {loc ? `${truncateMiddle(loc.file.split("/").pop() ?? loc.file, 26)}:${loc.startLine}` : "—"}
      </span>
      <span className="d-kind" aria-hidden="true">{KIND_LABEL(f.kind)}</span>
      <span className={`d-sev ${sevClass(f.severity)}`} title={f.severity} aria-hidden="true">{f.severity === "MEDIUM" ? "MED" : f.severity}</span>
      {st !== "NEW" && <span className={`d-status s-${st.toLowerCase()}`} title={STATUS_INFO[st]} aria-hidden="true">{st === "DISMISSED" ? "dismissed" : "reviewed"}</span>}
    </div>;
  };

  const statusLine = busy
    ? `Analyzing… ${job?.done != null ? `${job.done}${job.total != null ? `/${job.total}` : ""} · ` : ""}${elapsed}s${job?.message ? ` · ${job.message}` : ""}`
    : `${findings.length.toLocaleString()} finding${findings.length === 1 ? "" : "s"} · ${counts.NEW} new · ${counts.REVIEWED} reviewed · ${counts.DISMISSED} dismissed (tracked in this browser)`;

  return (
    <div className="modal-backdrop">
      <section className={`modal defect dialog${narrow ? " narrow" : ""}`} role="dialog" aria-modal="true" aria-label="Defects and performance findings" tabIndex={-1}
        onKeyDown={(e) => { if (e.key === "Escape") close(); }}
        style={{ width: `min(${width}px, 96vw)`, height: "min(92vh, 940px)" }}>

        {/* fixed header */}
        <header className="d-header">
          <div className="d-title-row">
            <h2 className="d-title">Defects &amp; performance</h2>
            <button className="d-close" onClick={close} aria-label="Close the defect panel">Close ✕</button>
          </div>
          <div className="d-meta" role="status">
            <span title={meta?.repoRoot ?? revision}>{meta ? `${meta.repoRoot?.split("/").pop() ?? "?"} · ${(meta.gitHead ?? "").slice(0, 8) || "no git head"} · indexed ${relative(meta.createdAt)} · ${meta.files} files` : `revision ${truncateMiddle(revision, 26)}`}</span>
            <span aria-hidden="true">·</span>
            <span>{statusLine}</span>
            {analyzedAt && !busy && <span aria-hidden="true">· analyzed {relative(analyzedAt)}</span>}
          </div>
          <div className="d-cta-row">
            <button className="d-analyze" disabled={busy || loading} onClick={() => void detect()}>{busy ? "Analyzing…" : findings.length ? "Re-analyze" : "Analyze indexed code"}</button>
            {busy && <div className="d-progress" title={job?.message ?? "analyzing"}><div className="bar"><span className={job?.total ? undefined : "indeterminate"} style={job?.total ? { width: `${Math.round(((job.done ?? 0) / job.total) * 100)}%` } : undefined} /></div></div>}
          </div>
          {error && <p role="alert" className="d-error">{error}</p>}
        </header>

        {/* fixed toolbar (UX-02/03) */}
        <div className="d-toolbar">
          <input type="search" placeholder="Search path, symbol, rule or snippet…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search findings" />
          <div className="d-chips" role="group" aria-label="Filter by severity">
            {SEVERITIES.map((s) => <button key={s} className={`d-chip sev-${sevClass(s)}${severities.has(s) ? " on" : ""}`} aria-pressed={severities.has(s)}
              onClick={() => setSeverities((cur) => { const n = new Set(cur); if (n.has(s)) n.delete(s); else n.add(s); return n; })}>{s === "MEDIUM" ? "MED" : s} {sevCounts.get(s) ?? 0}</button>)}
          </div>
          <label className="d-field">kind <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} aria-label="Filter by kind">
            <option value="">all ({kindCounts.length})</option>
            {kindCounts.map(([kind, n]) => <option key={kind} value={kind}>{KIND_LABEL(kind)} ({n})</option>)}
          </select></label>
          <label className="d-field">status <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as TriageStatus | "ALL")} aria-label="Filter by triage status">
            <option value="ALL">all</option>{(["NEW", "REVIEWED", "DISMISSED"] as const).map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
          </select></label>
          <label className="d-field">group <select value={groupBy ? "file" : "none"} onChange={(e) => setGroupBy(e.target.value === "file")} aria-label="Group by file">
            <option value="file">by file</option><option value="none">none</option>
          </select></label>
        </div>

        {/* body: independently scrolling panes (§3) */}
        <div className="d-body">
          <div className={`d-list-wrap${narrow && finding ? " hidden" : ""}`}>
            <div className="d-list" ref={listRef} role="listbox" aria-multiselectable="true" aria-label="Findings list"
              tabIndex={0}
              onScroll={(e) => { setScrollTop((e.target as HTMLElement).scrollTop); savedScroll.current = (e.target as HTMLElement).scrollTop; }}
              onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); step(1); } if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); step(-1); } }}>
              <Loading pending={loading} label="Loading findings" rows={5} lines={1} />
              {!busy && !loading && !findings.length && <div className="d-empty">No candidates are recorded for this revision. This does not establish that the code is race-free, deadlock-free or optimal.</div>}
              {!loading && findings.length > 0 && !ordered.length && <div className="d-empty">No findings match the current search/filters. <button className="link" onClick={() => { setSearch(""); setSeverities(new Set()); setKindFilter(""); setStatusFilter("ALL"); }}>Reset filters</button></div>}
              {!loading && ordered.length > 0 && <div style={{ height: offsetOf(rows, rows.length), position: "relative" }}>
                {shown.map((r, i) => r.type === "group"
                  ? <div key={r.id} style={{ position: "absolute", top: offsetOf(rows, start + i), left: 0, right: 0 }}>{groupHeader(r)}</div>
                  : <div key={r.id} style={{ position: "absolute", top: offsetOf(rows, start + i), left: 0, right: 0 }}>{rowEl(r.finding!, r.location ?? null)}</div>)}
              </div>}
            </div>
            {checked.size > 0 && <div className="d-bulk" role="toolbar" aria-label="Bulk triage actions">
              <span>{checked.size} selected</span>
              <button onClick={() => dismiss([...checked])}>Dismiss…</button>
              <button onClick={() => { setStatus([...checked], "REVIEWED"); setChecked(new Set()); flash(`${checked.size} marked reviewed (in this browser)`); }}>Mark reviewed</button>
              <button onClick={() => { setStatus([...checked], null); setChecked(new Set()); }}>Reset</button>
              <button className="link" onClick={() => setChecked(new Set())}>Clear selection</button>
            </div>}
            {!narrow && <div className="d-more-fade" aria-hidden="true" />}
          </div>

          {/* detail pane */}
          {finding ? <article className="d-detail" aria-label={rowLabel(finding, locationOf(finding, evidence))}>
            <div className="d-detail-head">
              {narrow && <button className="d-back" onClick={() => setSelected(null)} aria-label="Back to the findings list">‹ Back</button>}
              <span className={`d-sev ${sevClass(finding.severity)}`}>{finding.severity === "MEDIUM" ? "MED" : finding.severity}</span>
              <h3>{KIND_LABEL(finding.kind)}</h3>
              <span className="d-nav-count">{findingIndex >= 0 ? `${findingIndex + 1} of ${ordered.length}` : ""}</span>
              <div className="d-nav">
                <button onClick={() => step(-1)} disabled={findingIndex <= 0} aria-label="Previous finding">‹</button>
                <button onClick={() => step(1)} disabled={findingIndex < 0 || findingIndex >= ordered.length - 1} aria-label="Next finding">›</button>
              </div>
            </div>
            <p className="d-ruleline muted"><code title={finding.ruleId}>{truncateMiddle(finding.ruleId, 36)}</code> v{finding.ruleVersion} · {finding.evidenceLevel.replaceAll("_", " ").toLowerCase()}</p>
            <dl className="d-facts">
              <div><dt title={LEVEL_INFO[finding.evidenceLevel] ?? ""}>Evidence level</dt><dd title={LEVEL_INFO[finding.evidenceLevel] ?? ""}>{finding.evidenceLevel.replaceAll("_", " ").toLowerCase()}</dd></div>
              <div><dt>Triage</dt><dd>
                <button className={`d-action${statusOf(finding, triage) === "DISMISSED" ? " on" : ""}`} onClick={() => dismiss([finding.id])}>Dismiss…</button>
                <button className={`d-action${statusOf(finding, triage) === "REVIEWED" ? " on" : ""}`} onClick={() => { setStatus([finding.id], "REVIEWED"); flash("Marked reviewed (in this browser)"); }}>Reviewed</button>
                {statusOf(finding, triage) !== "NEW" && <button className="link" onClick={() => { setStatus([finding.id], null); flash("Triage reset"); }}>reset</button>}
                <button className="link" onClick={() => copyMarkdown(finding)}>copy as markdown</button>
              </dd></div>
            </dl>
            {(RULE_HINT[finding.ruleId] || KIND_INFO[finding.kind]) ? <details><summary>About this rule &amp; how to fix</summary>
              {RULE_HINT[finding.ruleId] && <p>{RULE_HINT[finding.ruleId]}</p>}
              {KIND_INFO[finding.kind] && <><p><strong>What it means:</strong> {KIND_INFO[finding.kind].what}</p><p><strong>How to fix:</strong> {KIND_INFO[finding.kind].fix}</p></>}
            </details> : null}
            {finding.witness && <figure><figcaption>{finding.witness.kind === "LOCK_ORDER_CYCLE" ? "Potential lock acquisition paths" : "Source paths"}</figcaption>
              <ol>{finding.witness.paths.map((p, i) => <li key={i}><code className="mono">{p.join(" → ")}</code></li>)}</ol>
            </figure>}
            {factLocations.length > 0 && <section>
              <h4>Fact location <span className="muted">(recorded by the detector)</span></h4>
              <ul>{factLocations.map((l, i) => <li key={i}><code title={`${l.file}:${l.startLine}`}>{truncateMiddle(l.file, 42)}:{l.startLine}{l.startLine !== l.endLine ? `–${l.endLine}` : ""}</code> {l.state !== "CURRENT" && <span className="d-stale">{l.state.toLowerCase()}</span>}
                {l.absPath && <a className="open" href={`vscode://file${l.absPath}:${l.startLine || 1}`}>open in editor</a>} <button className="link" onClick={() => copyText(`${l.file}:${l.startLine}`)}>copy</button></li>)}</ul>
              <p className="hint muted">Fact location is where the detector recorded the problem; the evidence location below is where the cited evidence was re-read. The two can differ — each is labelled, and both open the same source view.</p>
            </section>}
            <section>
              <h4>Coverage gaps</h4><ul>{finding.coverageGaps.map((g) => <li key={g}>{g}</li>)}</ul>
            </section>
            <section>
              <h4>Correctness obligations <span className="muted">(each must hold for the evidence to mean what it says)</span></h4>
              <ul className="d-obligations">{finding.safetyObligations.map((x) => <li key={x.id} className={ack[x.id] ? (ack[x.id] === "DONE" ? " ack-done" : " ack-na") : ""}>
                <span>{x.description}{ack[x.id] && <span className="d-note"> ({ack[x.id] === "DONE" ? "done" : "n/a"}, in this browser)</span>}</span>
                <span>
                  <span className={`d-obligation-state s-${x.state.toLowerCase()}`} title="PENDING = not yet evidenced; this is a check someone must perform, not an optional footnote">{x.state.toLowerCase()}</span>
                  <button className="link" onClick={() => setAck(x.id, "DONE")} aria-label={`Mark obligation done: ${truncateMiddle(x.description, 40)}`}>done</button>
                  <button className="link" onClick={() => setAck(x.id, "NA")} aria-label={`Mark obligation not applicable: ${truncateMiddle(x.description, 40)}`}>n/a</button>
                  {ack[x.id] && <button className="link" onClick={() => setAck(x.id, null)} aria-label={`Reset obligation: ${truncateMiddle(x.description, 40)}`}>reset</button>}
                </span>
              </li>)}</ul>
            </section>
            <section>
              <h4>Evidence location <span className="muted">(re-resolved from the pinned revision)</span></h4>
              {detailEvidence.map((e) => <details key={e.id} open={detailEvidence.length === 1}>
                <summary><code title={e.file}>{truncateMiddle(e.file, 42)}:{e.startLine}</code> · {e.class.replaceAll("_", " ").toLowerCase()} {e.state !== "CURRENT" && <span className="d-stale">{e.state.toLowerCase()}</span>}</summary>
                <pre className="mono"><code>{e.snippet || "(snippet unavailable)"}</code></pre>
                {e.absPath && <a className="open" href={`vscode://file${e.absPath}:${e.startLine || 1}`} title="Open this location in VS Code">open in editor</a>}
              </details>)}
            </section>
          </article> : <div className="d-detail placeholder"><p>Select a finding to see its evidence, coverage gaps and obligations. <kbd>j</kbd>/<kbd>k</kbd> or the arrow keys move through the list.</p></div>}
        </div>

        {/* fixed footer */}
        <footer className="d-footer">
          <span title="Findings carry a display category describing their evidence, never a probability that they are true.">Evidence status: categories, not scores</span>
          <span aria-hidden="true">·</span>
          <span>{rows.length ? `showing ${start + 1}–${Math.min(stop, rows.length)} of ${rows.length}` : "0 findings"}</span>
          <details className="d-coverage"><summary title="What the analysis could and could not examine">{warnings.length ? `${warnings.length} coverage note${warnings.length === 1 ? "" : "s"}` : "no coverage notes"}</summary>
            {warnings.length ? <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul> : <p className="hint muted">The last analysis reported no coverage limitations.</p>}
          </details>
          <span className="spacer" />
          <details className="d-glossary"><summary>glossary</summary>
            <dl>{GLOSSARY.map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}</dl>
          </details>
          <button className="link" onClick={exportJSON}>JSON</button>
          <button className="link" onClick={exportCSV}>CSV</button>
        </footer>

        {/* resize handle (left edge, UX-13) */}
        {!narrow && <div className="d-resize" role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
          onPointerDown={(e) => {
            e.preventDefault();
            const move = (ev: PointerEvent) => { const w = Math.min(1200, Math.max(480, window.innerWidth - ev.clientX - 24)); setWidth(w); persist("defect-panel-width", w); };
            const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
            window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
          }} />}

        {toast && <div className="d-toast" role="status">{toast}</div>}
      </section>
    </div>
  );
}