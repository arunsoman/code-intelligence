import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { JobView, ResolvedEvidence, ViewSpec } from "@cie/schema";
import { call } from "./api.ts";
import { buttonFeedback } from "./button.ts";
import { Loading } from "./Skeleton.tsx";
import "./team.css";
import { cumulative, plural, relative, truncateMiddle, windowByOffsets, windowOf } from "./defect-list.ts";

type Tab = "security" | "config" | "identity" | "changes" | "runtime" | "sources" | "team" | "evaluation";
const TABS: { id: Tab; label: string }[] = [
  { id: "security", label: "Security" }, { id: "config", label: "Configuration" }, { id: "identity", label: "Identity" }, { id: "changes", label: "Changes" },
  { id: "runtime", label: "Runtime" }, { id: "sources", label: "Sources" }, { id: "team", label: "Team" }, { id: "evaluation", label: "Evaluation" },
];
const key = () => crypto.randomUUID();
const pct = (x: { value: number | null; lower: number; upper: number; n: number }) => (x.value === null ? "n/a" : `${Math.round(x.value * 100)}% (${Math.round(x.lower * 100)}–${Math.round(x.upper * 100)}%, n=${x.n})`);

function useCall<T>() {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const run = useCallback(async (component: string, op: string, body: unknown = {}, mutating = false): Promise<T | null> => {
    setBusy(true); setError(null);
    const r = await call<T>(component, op, body, mutating ? key() : undefined);
    setBusy(false);
    if (!r.ok) { setError(r.error.message); return null; }
    setData(r.value); setWarnings(r.metadata.warnings ?? []);
    return r.value;
  }, []);
  return { data, setData, error, setError, busy, warnings, run };
}
const Status = ({ error, busy, warnings }: { error: string | null; busy: boolean; warnings?: string[] }) => (
  <div aria-live="polite">
    <Loading pending={busy} label="Loading this tab" rows={3} lines={2} />
    {error && <p role="alert" className="warn-text">{error}</p>}
    {(warnings ?? []).map((w, i) => <p key={i} className="muted small">{w}</p>)}
  </div>
);
const Badge = ({ children, kind = "inference" }: { children: ReactNode; kind?: "fact" | "inference" | "warn" | "hyp" }) => <span className={`badge ${kind}`}>{children}</span>;
/** The one truncation rule for list rows: identity stays readable, the full text lives in the detail pane. */
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
/** Windowed fixed-height rows: the virtualization contract the defect panel uses, reused for every list that can reach the hundreds. */
function WindowedRows<T>({ rows, rowH, render, label }: { rows: T[]; rowH: number; render: (t: T, i: number) => ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [off, setOff] = useState(0);
  const [h, setH] = useState(0);
  useEffect(() => {
    const m = () => setH(ref.current?.clientHeight ?? 0);
    m(); window.addEventListener("resize", m);
    return () => window.removeEventListener("resize", m);
  }, []);
  const [s, e] = windowOf(rows.length, off, h || 400, rowH);
  return <div ref={ref} className="i-window" role="listbox" aria-label={label} tabIndex={0} onScroll={(ev) => setOff(ev.currentTarget.scrollTop)}>
    <div style={{ height: rows.length * rowH, position: "relative" }}>
      {rows.slice(s, e).map((t, i) => <div key={s + i} style={{ position: "absolute", top: (s + i) * rowH, left: 0, right: 0 }}>{render(t, s + i)}</div>)}
    </div>
    <p className="muted small i-shown">showing {Math.min(e, rows.length) - s} of {rows.length}</p>
  </div>;
}
 /** Keyboard activation for a list row happens only when the row itself has focus; keys on interactive children (buttons, links, inputs) must reach them. */
const rowKey = (act: () => void) => (e: React.KeyboardEvent<HTMLElement>) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  if ((e.target as HTMLElement).closest("button, a, input, select, textarea, details")) return;
  e.preventDefault(); act();
};
const statusText = (s: string) => s.replaceAll("_", " ").toLowerCase();
const TAB_TIPS: Record<Tab, string> = {
  security: "Candidates from static analysis, the alarm gate, and your triage (marks stay in this browser)",
  config: "What the code declares — routes, tables, queues, flags. Not what is deployed or enabled anywhere.",
  identity: "Rename, split and merge proposals between revisions, and every name the code reuses",
  changes: "What changed between indexed revisions, and what it affects",
  runtime: "Runtime traces joined to code at a stated exactness",
  sources: "External sources such as forge pulls. Credentials never enter the browser.",
  team: "Sharing, people and their access",
  evaluation: "How the model's own claims have held up when judged",
};
const statusKind = (s: string): "fact" | "inference" | "warn" | "hyp" => (["RESOLVED", "HEALTHY", "EVALUATED", "ALARM", "CONFIRMED", "SUPPORTED"].includes(s) ? "fact" : ["ABSENT", "CONFLICTING", "EXPIRED", "REVERSED", "UNMEASURED_MODEL", "NEVER_EVALUATED", "UNREACHABLE"].includes(s) ? "warn" : ["AMBIGUOUS", "PARTIAL", "RATE_LIMITED", "PROPOSED", "DISPUTED", "CANDIDATE"].includes(s) ? "hyp" : "inference");

export function InsightsPanel({ revision, view, onClose, onAsk }: { revision: string; view: ViewSpec | null; onClose: () => void; onAsk?: (question: string) => void }) {
  const [tab, setTab] = useState<Tab>("security");
  const [width, setWidth] = useState(() => loadWidth());
  const [maximized, setMaximized] = useState(false);
  const [meta, setMeta] = useState<{ repoRoot: string; gitHead: string | null; createdAt: string; files: number } | null>(null);
  const [secCount, setSecCount] = useState<number | null>(null);
  const [reindex, setReindex] = useState<{ phase: "idle" | "busy" | "done" | "failed"; jobId?: string; note?: string }>({ phase: "idle" });
  // Same fixed-pane drawer the defect panel uses: fixed header + tabs, only the tab content scrolls.
  // The width preference is shared with the defect drawer (one drawer, one width habit).
  const persistWidth = (w: number) => { setWidth(w); try { localStorage.setItem("defect-panel-width", JSON.stringify(w)); } catch { /* ok */ } };
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    let live = true;
    void call<{ repoRoot: string; gitHead: string | null; createdAt: string; files: number }>("C13", "revisionStats", { revision }).then((r) => { if (live && r.ok) setMeta(r.value); });
    return () => { live = false; document.body.style.overflow = prev; };
  }, [revision]);
  // Re-index the same repository without leaving the drawer; the drawer stays on its own revision until you reopen it.
  useEffect(() => {
    if (reindex.phase !== "busy" || !reindex.jobId) return;
    const poll = setInterval(async () => {
      const j = await call<JobView>("C07", "getJob", { jobId: reindex.jobId });
      if (!j.ok) return;
      if (j.value.state === "SUCCEEDED") setReindex({ phase: "done", note: "New index ready — close and reopen to view it." });
      else if (j.value.state === "FAILED") setReindex({ phase: "failed", note: `Re-index failed: ${j.value.error?.message ?? j.value.message}` });
    }, 700);
    return () => clearInterval(poll);
  }, [reindex.phase, reindex.jobId]);
  const startReindex = async () => {
    if (!meta || reindex.phase === "busy") return;
    const note = "Indexing… the drawer keeps the commit it was opened on until you reopen it.";
    setReindex({ phase: "busy", note });
    const r = await call<JobView>("C07", "enqueue", { kind: "index", repoPath: meta.repoRoot }, key());
    if (!r.ok) return setReindex({ phase: "failed", note: r.error.message });
    setReindex({ phase: "busy", jobId: r.value.id, note });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    // "/" (UX-60) focuses the active tab's search box, wherever the focus sits inside the drawer.
    if (e.key === "/" && !(e.target as HTMLElement).closest("input, select, textarea")) {
      const search = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[role=tabpanel] input[type=search]");
      if (search) { e.preventDefault(); search.focus(); return; }
    }
    if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && (e.target as HTMLElement).getAttribute("role") === "tab") {
      const i = TABS.findIndex((t) => t.id === tab), n = (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
      setTab(TABS[n].id); requestAnimationFrame(() => document.getElementById(`tab-${TABS[n].id}`)?.focus());
    }
  };
  const reindexFb = buttonFeedback({ className: "secondary small", busy: reindex.phase === "busy" });
  return (
    <div className="modal-backdrop">
      <section className="modal insights dialog" role="dialog" aria-modal="true" aria-label="Insights" tabIndex={-1} onKeyDown={onKey}
        style={maximized ? { width: "96vw", height: "96vh" } : { width: `min(${width}px, 96vw)`, height: "min(92vh, 940px)" }}>
        <header className="d-header">
          <div className="d-title-row">
            <h2 className="d-title">Insights</h2>
            <div className="d-title-actions">
              <button className="secondary small" aria-pressed={maximized} onClick={() => setMaximized((m) => !m)} title="Make the panel taller and wider, or return it to the saved size">{maximized ? "⤡ Restore" : "⤢ Maximize"}</button>
              <button autoFocus className="d-close" onClick={onClose} aria-label="Close the insights panel" title="Close (Esc also closes)">Close ✕</button>
            </div>
          </div>
          <div className="d-meta">
            <span className="i-fact" title={meta?.repoRoot ?? revision}>{meta ? meta.repoRoot.split("/").pop() : cut(revision, 16)}</span>
            <a className="i-fact mono" href={`vscode://file${meta?.repoRoot ?? ""}`} title="Open the repository in VS Code">{(meta?.gitHead ?? "").slice(0, 8) || "no git head"} ↗</a>
            <span className="i-fact" title={meta ? `indexed ${new Date(meta.createdAt).toLocaleString()}` : undefined}>indexed {meta ? relative(meta.createdAt) : "…"}</span>
            {meta && <span className="i-fact">{meta.files} files</span>}
            <button className={reindexFb.className} onClick={() => void startReindex()} disabled={!meta || reindex.phase === "busy"} aria-busy={reindexFb["aria-busy"]} title="Index the repository again. This drawer keeps showing the revision it was opened on.">{reindexFb.spinner && <span className="spinner" aria-hidden="true" />}Re-index</button>
            {reindex.note && <span role="status" className={reindex.phase === "failed" ? "warn-text" : "muted"}>{reindex.note}</span>}
          </div>
        </header>
        <div role="tablist" aria-label="Insight areas" className="tabs i-tabs">
          {TABS.map((t) => <button key={t.id} id={`tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} className={`tab ${tab === t.id ? "on" : ""}`} title={TAB_TIPS[t.id]} onClick={() => setTab(t.id)}>{t.label}{t.id === "security" && secCount !== null && <span className="i-count" aria-label={`${secCount} findings`}>{secCount}</span>}</button>)}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="i-content">
          {tab === "security" && <Security revision={revision} onAsk={onAsk} onCount={setSecCount} />}
          {tab === "config" && <Config revision={revision} />}
          {tab === "identity" && <Identity revision={revision} />}
          {tab === "changes" && <Changes revision={revision} view={view} />}
          {tab === "runtime" && <Runtime revision={revision} />}
          {tab === "sources" && <Sources revision={revision} />}
          {tab === "team" && <Team revision={revision} view={view} />}
          {tab === "evaluation" && <Evaluation />}
        </div>
        <div className="i-fade" aria-hidden="true" />
        <div className="d-resize" role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
          onPointerDown={(e) => {
            e.preventDefault();
            const move = (ev: PointerEvent) => persistWidth(Math.min(1200, Math.max(480, window.innerWidth - ev.clientX - 24)));
            const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
            window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
          }} />
      </section>
    </div>
  );
}
function loadWidth(): number {
  try { const v = localStorage.getItem("defect-panel-width"); const n = v ? JSON.parse(v) as number : NaN; if (Number.isFinite(n) && n >= 480 && n <= 1200) return n; } catch { /* fall through */ }
  return 1100;
}

// ---------------------------------------------------------------- C25
// Security tab, rebuilt per the second UX audit (UX-36…UX-63): findings grouped by rule so rule-level knowledge
// (counter-argument, assumptions, remediation pattern) is read once, findings as compact triage rows with file:line
// locations and keyboard access, Confirm/Dismiss triage stored in this browser only, and the confirmation control
// named for what it does. This screen never writes server-side claims; everything typed here is marked "in this
// browser", and it keeps the honesty wording the audits singled out.
interface Finding { id: string; ruleId: string; ruleVersion: number; ruleDigest: string; title: string; severity: string; state: string; summary: string; evidenceIds: string[]; assumptions: string[]; counterArgument: string; disclaimer: string; source: string }
/** Rule registry: plain names and a general remediation pattern. Marked as general guidance, not a verified fix. */
const RULE_INFO: Record<string, { name: string; fix?: string }> = {
  "R-PII-LOG": { name: "Sensitive data in logs", fix: "Keep the raw value out of the log call: log an identifier instead (a request or record id), or pass the value through a masking helper before it is serialised. A general pattern, not verified for this code." },
  "R-AUTHZ-GAP": { name: "State change without an authorisation check", fix: "Add an explicit authorisation check before the first write in the handler, failing closed when the check cannot decide, or record why the endpoint is intentionally open. A general pattern, not verified for this code." },
  "R-POLICY-MISSING": { name: "Control not declared", fix: "Declare the named control in the policy file the rule reads, or drop the policy if it does not apply here." },
};
const ruleName = (ruleId: string) => RULE_INFO[ruleId]?.name ?? ruleId.replace(/^R-/, "");
/** The gate's machine phrasing, reworded for people: evidence ids shortened, counts kept verbatim. */
const humanizeGate = (r: { ok: boolean; basis: string; reasons: string[] }): string => {
  const tidy = (s: string) => s
    .replace(/ev:[0-9a-f]{8,}/g, (m) => `evidence ${m.slice(3, 11)}…`)
    .replace(/authorised confirmation\(s\)/g, "authorised approvers")
    .replace(/\(s\)/g, "s");
  return r.ok ? `Alarm: ${r.basis.replaceAll("_", " ").toLowerCase()}.` : `Stays a candidate. ${r.reasons.map(tidy).join("; ")}`;
};
type Triage = { state: "CONFIRMED" | "DISMISSED"; reason?: string; at: number };
const DISMISS_REASONS = ["false positive", "accepted risk", "duplicated"] as const;
const SEV_RANK = ["critical", "high", "medium", "low"];
const RULE_HEAD_H = 44, RULE_BODY_H = 96, RULE_BODY_TALL_H = 118, FINDING_H = 48;
/** Visible item range for the current scroll position (a thin wrapper keeps JSX tidy). */
const windowVisible = (offs: number[], top: number, viewH: number): [number, number] => windowByOffsets(offs, top, viewH, 4);
const locLabel = (ev?: ResolvedEvidence): string | null => (!ev || ["ACCESS_REVOKED", "UNAVAILABLE"].includes(ev.state) || !ev.file ? null : `${ev.file}:${ev.startLine || 1}`);
function Security({ revision, onAsk, onCount }: { revision: string; onAsk?: (question: string) => void; onCount?: (n: number | null) => void }) {
  const f = useCall<Finding[]>(); const g = useCall<{ ok: boolean; basis: string; reasons: string[]; finding: Finding }>(); const n = useCall<{ markdown: string; missingControls: string[] }>();
  const [policies, setPolicies] = useState("POL-PII-1, POL-AUTHZ-1");
  const [shown, setShown] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sevs, setSevs] = useState<Set<string>>(new Set());
  const [triFilter, setTriFilter] = useState<"all" | "candidate" | "confirmed" | "dismissed">("all");
  const [sort, setSort] = useState<"sev" | "title">("sev");
  const [dismissOpen, setDismissOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const policyList = policies.split(",").map((x) => x.trim()).filter(Boolean);
  const analyze = useCallback(() => f.run("C25", "analyze", { revision, policyIds: policyList }, true), [revision, policies]); // eslint-disable-line react-hooks/exhaustive-deps
  const analyzeKeep = useCallback(async () => { const r = await call<Finding[]>("C25", "analyze", { revision, policyIds: policyList }, key()); if (r.ok) f.setData(r.value); }, [revision, policies]); // eslint-disable-line react-hooks/exhaustive-deps
  // Triage marks are a review aid, not a server-side claim: per finding, per revision, this browser only.
  const triKey = `security-triage:${revision}`;
  const readTri = (): Record<string, Triage> => { try { return JSON.parse(localStorage.getItem(triKey) ?? "{}"); } catch { return {}; } };
  const [tri, setTri] = useState<Record<string, Triage>>(readTri);
  const setTriage = (id: string, t: Triage | null) => setTri((cur) => { const next = { ...cur }; if (t) next[id] = t; else delete next[id]; try { localStorage.setItem(triKey, JSON.stringify(next)); } catch { /* ok */ } return next; });
  useEffect(() => { setTri(readTri()); }, [triKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const gate = async (id: string) => {
    const r = await g.run("C25", "gateSecurityAlarm", { findingId: id, proofEvidenceIds: f.data?.find((x) => x.id === id)?.evidenceIds ?? [] }, true);
    if (r) setShown((s) => ({ ...s, [id]: humanizeGate(r) }));
    await analyzeKeep();
  };
  // A selection survives a re-analysis; otherwise the first row opens, so the detail pane is never an empty surprise.
  useEffect(() => { if (f.data?.length && !f.data.some((x) => x.id === selected)) setSelected(f.data[0].id); }, [f.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // The Security tab badge reads the total; the count resets when this tab unmounts.
  useEffect(() => { onCount?.(f.data ? f.data.length : null); return () => onCount?.(null); }, [f.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // One batched read resolves the first span of every finding, so rows carry a real file:line (UX-38) without hundreds
  // of per-row reads. Evidence whose file changed since the index is marked stale on the row itself.
  const [rowEvs, setRowEvs] = useState<Record<string, ResolvedEvidence>>({});
  useEffect(() => {
    let live = true; setRowEvs({});
    const ids = (f.data ?? []).map((x) => x.evidenceIds[0]).filter(Boolean).slice(0, 2000);
    if (ids.length) void call<ResolvedEvidence[]>("C18", "evidenceBatch", { revision, evidenceIds: ids }).then((r) => {
      if (!live || !r.ok) return;
      const m: Record<string, ResolvedEvidence> = {};
      for (const x of f.data ?? []) { const first = x.evidenceIds[0]; const hit = r.value.find((ev) => ev.id === first); if (hit) m[x.id] = hit; }
      setRowEvs(m);
    });
    return () => { live = false; };
  }, [f.data, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const sevCounts = useMemo(() => { const c: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 }; for (const x of f.data ?? []) c[x.severity.toLowerCase()] = (c[x.severity.toLowerCase()] ?? 0) + 1; return c; }, [f.data]);
  const triCounts = useMemo(() => {
    const c = { candidate: 0, confirmed: 0, dismissed: 0 };
    for (const x of f.data ?? []) { const t = tri[x.id]; c[t?.state === "CONFIRMED" ? "confirmed" : t?.state === "DISMISSED" ? "dismissed" : "candidate"]++; }
    return c;
  }, [f.data, tri]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = (f.data ?? []).filter((x) => {
      if (sevs.size && !sevs.has(x.severity.toLowerCase())) return false;
      const t = tri[x.id];
      if (triFilter === "candidate" && t) return false; // a mark settles it out of "candidates"
      if (triFilter === "confirmed" && t?.state !== "CONFIRMED") return false;
      if (triFilter === "dismissed" && t?.state !== "DISMISSED") return false;
      if (q && !`${x.title} ${x.summary} ${x.ruleId} ${x.source} ${rowEvs[x.id]?.file ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return sort === "title"
      ? rows.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
      : rows.sort((a, b) => SEV_RANK.indexOf(a.severity.toLowerCase()) - SEV_RANK.indexOf(b.severity.toLowerCase()) || a.ruleId.localeCompare(b.ruleId) || a.title.localeCompare(b.title));
  }, [f.data, search, sevs, triFilter, tri, sort, rowEvs]);
  // §3 information architecture: each rule is a header (its knowledge read once) followed by its findings as rows.
  const byRule = useMemo(() => {
    const m = new Map<string, Finding[]>();
    for (const x of filtered) { const a = m.get(x.ruleId); a ? a.push(x) : m.set(x.ruleId, [x]); }
    return [...m.entries()];
  }, [filtered]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // First paint opens the first rule, so the rule-level content is never hidden behind a click.
  useEffect(() => { if (byRule.length && Object.keys(expanded).length === 0) setExpanded({ [byRule[0][0]]: true }); }, [byRule]); // eslint-disable-line react-hooks/exhaustive-deps
  type VItem = { key: string; h: number; kind: "rulehead" | "rulebody" | "row"; f?: Finding; rule?: string };
  const items: VItem[] = useMemo(() => {
    const out: VItem[] = [];
    for (const [ruleId, fs] of byRule) {
      out.push({ key: `rulehead:${ruleId}`, h: RULE_HEAD_H, kind: "rulehead", rule: ruleId });
      if (expanded[ruleId]) {
        const nAssumes = new Set(fs.flatMap((x) => x.assumptions)).size;
        out.push({ key: `rulebody:${ruleId}`, h: nAssumes > 2 ? RULE_BODY_TALL_H : RULE_BODY_H, kind: "rulebody", rule: ruleId, f: fs[0] });
      }
      for (const x of fs) out.push({ key: `row:${x.id}`, h: FINDING_H, kind: "row", f: x });
    }
    return out;
  }, [byRule, expanded]);
  const offs = useMemo(() => cumulative(items), [items]);
  // Keyboard model (UX-60): the list is focusable and ↑/↓ (or j/k) move the selection through the findings, scrolling a
  // cut row back into view. "/" focuses the search box.
  const winRef = useRef<HTMLDivElement>(null);
  const [winH, setWinH] = useState(0);
  const sevClassOf = (s: string) => (s.toLowerCase() === "critical" ? "high" : ["high", "critical"].includes(s) ? "high" : s === "medium" ? "medium" : "low");
  const moveSel = (i: number, rows: VItem[]) => {
    const it = rows[i]; if (!it) return;
    setSelected(it.f!.id);
    const idx = items.findIndex((x) => x.key === it.key);
    const el = winRef.current;
    if (el && idx >= 0) {
      const top = offs[idx], bottom = top + it.h;
      if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) el.scrollTop = top;
    }
    requestAnimationFrame(() => { const at = el?.querySelector('[role="option"][aria-selected="true"]'); if (at instanceof HTMLElement) at.focus(); });
  };
  useEffect(() => {
    const m = () => setWinH(winRef.current?.clientHeight ?? 0);
    m(); window.addEventListener("resize", m);
    return () => window.removeEventListener("resize", m);
  }, []);
  const listKeyDownWrap = (e: React.KeyboardEvent) => {
    const rows = items.filter((it) => it.kind === "row");
    if (!rows.length) return;
    const at = rows.findIndex((it) => it.f!.id === selected);
    if ((e.key === "ArrowDown" || e.key === "j") && at < rows.length - 1) { e.preventDefault(); moveSel(at + 1, rows); }
    if ((e.key === "ArrowUp" || e.key === "k") && at > 0) { e.preventDefault(); moveSel(at - 1, rows); }
  };
  const sel = f.data?.find((x) => x.id === selected) ?? null;
  const selLoc = locLabel(rowEvs[sel?.id ?? ""]);
  const [evs, setEvs] = useState<ResolvedEvidence[]>([]);
  useEffect(() => {
    let live = true; setEvs([]);
    if (sel?.evidenceIds.length) void call<ResolvedEvidence[]>("C18", "evidenceBatch", { revision, evidenceIds: sel.evidenceIds.slice(0, 12) }).then((r) => { if (live && r.ok) setEvs(r.value); });
    return () => { live = false; };
  }, [sel?.id, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const exportCSV = () => {
    const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const rows = filtered.map((x) => { const l = locLabel(rowEvs[x.id]); return [x.ruleId, x.severity, x.state, x.title, l?.split(":").slice(0, -1).join(":") ?? "", l?.split(":").pop() ?? "", tri[x.id]?.state ?? "candidate", x.summary].map(esc).join(","); });
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([["rule,severity,state,title,file,line,triage (this browser only),summary", ...rows].join("\n")], { type: "text/csv" })); a.download = `${revision}-security.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  // SARIF 2.1.0 (UX-48): severity maps error=high/critical, warning=medium, note=low; locations use the resolved span.
  const exportSARIF = () => {
    const rules = [...new Set(filtered.map((x) => x.ruleId))];
    const toLevel: Record<string, string> = { critical: "error", high: "error", medium: "warning", low: "note" };
    const sarif = {
      version: "2.1.0", $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      runs: [{ tool: { driver: { name: "cie security analysis", informationUri: "https://example.invalid/cie", rules: rules.map((r) => ({ id: r, name: RULE_INFO[r]?.name ?? r })) } },
        results: filtered.map((x) => { const l = locLabel(rowEvs[x.id]); return {
          ruleId: x.ruleId, level: toLevel[x.severity.toLowerCase()] ?? "note",
          message: { text: `${x.title}. ${x.summary}` },
          ...(l ? { locations: [{ physicalLocation: { artifactLocation: { uri: l.split(":").slice(0, -1).join(":"), uriBaseId: "%SRCROOT%" }, region: { startLine: Number(l.split(":").pop()) || 1 } } }] } : {}),
        }; }) }],
    };
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(sarif, null, 2)], { type: "application/sarif+json" })); a.download = `${revision}-security.sarif`; a.click(); URL.revokeObjectURL(a.href);
  };
  const copyFinding = (x: Finding) => {
    const l = locLabel(rowEvs[x.id]);
    void navigator.clipboard?.writeText([`# ${x.title}`, "", x.summary, "", `- Rule: ${x.ruleId} v${x.ruleVersion} (digest ${x.ruleDigest})`, `- Severity: ${x.severity}`, `- State: ${x.state === "ALARM" ? "alarm (gate satisfied)" : "candidate"}`, ...(l ? [`- Location: ${l}`] : []), `- Counter-argument: ${x.counterArgument}`, `- Assumes: ${x.assumptions.join("; ")}`, `- Evidence: ${x.evidenceIds.join(", ")}`, "", x.disclaimer, "", tri[x.id] ? `Triage (in this browser): ${tri[x.id].state.toLowerCase()}${tri[x.id].reason ? ` — ${tri[x.id].reason}` : ""}` : ""].join("\n"));
  };
  const rowStatus = (x: Finding): { word: string; kind: "fact" | "inference" | "warn" | "hyp" } => {
    const t = tri[x.id];
    if (t?.state === "CONFIRMED") return { word: "you confirmed (in this browser)", kind: "fact" };
    if (t?.state === "DISMISSED") return { word: `dismissed — ${t.reason ?? "by you"} (in this browser)`, kind: "inference" };
    return { word: x.state === "ALARM" ? "alarm (gate satisfied)" : "candidate", kind: statusKind(x.state) };
  };
  const downloadText = (name: string, mime: string, text: string) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; a.click(); URL.revokeObjectURL(a.href); };
  // The explainer is the only disclaimer this tab owns (UX-42); dismissing it leaves a one-line way back.
  const noteKey = `security-note-dismissed`;
  const [noteOn, setNoteOn] = useState(() => { try { return localStorage.getItem(noteKey) !== "yes"; } catch { return true; } });
  const [noteOpen, setNoteOpen] = useState(false);
  const HOW = "A candidate comes from the rules: a static reading of the code, not an execution. It becomes an alarm one of two ways: deterministic proof (the gate, when evidence class, state and location can be verified mechanically) or two authorised confirmations from two distinct people. Confirming or dismissing here (in this browser) marks your review but is neither of those.";
  const range = windowVisible(offs, winRef.current?.scrollTop ?? 0, winH || 400);
  return <>
    {noteOn ? (
      <div className="notice i-callout" role="note">
        <div className="i-callout-row">
          <p>A finding is a <strong>candidate</strong> from static analysis. <strong>No finding does not mean safe</strong>, and nothing here certifies compliance. A candidate becomes an alarm only with deterministic proof or two authorised confirmations.</p>
          <button className="link small" aria-expanded={noteOpen} onClick={() => setNoteOpen((o) => !o)}>How candidates become alarms</button>
          <button className="link small" onClick={() => { setNoteOn(false); try { localStorage.setItem(noteKey, "yes"); } catch { /* ok */ } }}>Dismiss this note</button>
        </div>
        {noteOpen && <p className="muted small">{HOW}</p>}
      </div>
    ) : <button className="link small" aria-expanded="false" onClick={() => setNoteOn(true)}>ⓘ About candidates and alarms</button>}
    <div className="i-toolbar">
      <label htmlFor="pols" className="strong">Policies</label>
      <input id="pols" value={policies} onChange={(e2) => setPolicies(e2.target.value)} placeholder="policy ids, comma separated" aria-describedby="pols-help" />
      {policyList.map((p) => <button key={p} className="d-chip" title={`Remove ${p} from the analytic scope`} onClick={() => setPolicies(policyList.filter((x) => x !== p).join(", "))}>{p} ✕</button>)}
      <button onClick={() => void analyze()} disabled={f.busy}>Analyze</button>
      <span id="pols-help" className="muted small i-help">Analyze re-runs the rules over the listed policies.</span>
      <input ref={searchRef} type="search" placeholder="Search findings…" value={search} onChange={(e2) => setSearch(e2.target.value)} aria-label="Search security findings (press / to focus)" onKeyDown={(e2) => { if (e2.key === "Escape") { setSearch(""); searchRef.current?.blur(); } }} />
      <kbd className="i-kbd" aria-hidden="true">/</kbd>
      {SEV_RANK.map((s) => <button key={s} className={`d-chip sev-${s}${sevs.has(s) ? " on" : ""}`} aria-pressed={sevs.has(s)} title={`Severity is set by the rule that produced the finding. It is the rule author's scale, not a measured risk score.`} onClick={() => setSevs((cur) => { const n = new Set(cur); if (n.has(s)) n.delete(s); else n.add(s); return n; })}>{s} {sevCounts[s] ?? 0}</button>)}
      <button className={`d-chip${triFilter === "all" ? " on" : ""}`} aria-pressed={triFilter === "all"} onClick={() => setTriFilter("all")}>all {sevCounts.critical + sevCounts.high + sevCounts.medium + sevCounts.low}</button>
      <button className={`d-chip${triFilter === "candidate" ? " on" : ""}`} aria-pressed={triFilter === "candidate"} onClick={() => setTriFilter("candidate")}>candidates {triCounts.candidate}</button>
      <button className={`d-chip${triFilter === "confirmed" ? " on" : ""}`} aria-pressed={triFilter === "confirmed"} onClick={() => setTriFilter("confirmed")}>you confirmed {triCounts.confirmed}</button>
      <button className={`d-chip${triFilter === "dismissed" ? " on" : ""}`} aria-pressed={triFilter === "dismissed"} onClick={() => setTriFilter("dismissed")}>dismissed {triCounts.dismissed}</button>
      <label className="sr" htmlFor="security-sort">Sort findings by</label>
      <select id="security-sort" value={sort} onChange={(e2) => setSort(e2.target.value as "sev" | "title")}>
        <option value="sev">Sort: severity, rule</option>
        <option value="title">Sort: title</option>
      </select>
      <button className="link" onClick={exportCSV} disabled={!filtered.length}>CSV</button>
      <button className="link" onClick={exportSARIF} disabled={!filtered.length}>SARIF</button>
      <span className="muted small">{filtered.length} of {(f.data ?? []).length} findings · {byRule.length} rule(s)</span>
    </div>
    <Status error={f.error ?? g.error ?? n.error} busy={f.busy || g.busy || n.busy} warnings={f.warnings.slice(0, 1)} />
    {(f.error) && <button className="link" onClick={() => void analyze()}>Retry analysis</button>}
    {f.busy && !f.data && <div className="i-split" aria-hidden="true"><div className="i-window">{[0, 1, 2].map((i) => <div key={i} className="i-skel" style={{ height: 48, top: i * 52, position: "relative", marginTop: i ? 4 : 0 }} />)}</div></div>}
    {f.data && f.data.length === 0 && <p className="muted">No candidates found by the current rules. That is not a statement that the code is safe.</p>}
    {(f.data ?? []).length > 0 && filtered.length === 0 && <p className="muted">No findings match the current search and filters.</p>}
    {(f.data ?? []).length > 0 && filtered.length > 0 && <div className="i-split">
      <div ref={winRef} className="i-window" role="listbox" aria-label="Security findings by rule" tabIndex={0}
        onKeyDown={listKeyDownWrap}
        style={{ maxHeight: "clamp(320px, 56vh, 660px)", paddingBottom: 26 }}>
        <div style={{ height: offs[offs.length - 1], position: "relative" }}>
          {(() => {
            const [s, e] = windowByOffsets(offs, winRef.current?.scrollTop ?? 0, winH || 400, 4);
            return items.slice(range[0], range[1]).map((it, i) => {
              const idx = range[0] + i, top = offs[idx];
              if (it.kind === "rulehead") {
                const fs = byRule.find(([r]) => r === it.rule)?.[1] ?? [];
                const open = !!expanded[it.rule!];
                return <div key={it.key} style={{ position: "absolute", top, left: 0, right: 0, height: it.h }}>
                  <button className="i-rule-head" aria-expanded={open} onClick={() => setExpanded((cur) => ({ ...cur, [it.rule!]: !cur[it.rule!] }))}
                    title={open ? "Collapse this rule's notes" : "Show this rule's notes once: why it might be wrong, what it assumes, how such findings are usually fixed"}>
                    <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                    <span className="i-rule-name">{ruleName(it.rule!)}</span>
                    <span className="badge inference">{it.rule}</span>
                    <span className="muted small">{fs.length} finding(s)</span>
                    <span className="badge" title={`rule v${fs[0].ruleVersion} · digest ${fs[0].ruleDigest}`}>v{fs[0].ruleVersion}</span>
                  </button>
                </div>;
              }
              if (it.kind === "rulebody") {
                const fs = byRule.find(([r]) => r === it.rule)?.[1] ?? [];
                const counter = fs[0].counterArgument;
                const assumes = [...new Set(fs.flatMap((x) => x.assumptions))];
                const fix = RULE_INFO[it.rule!]?.fix;
                return <div key={it.key} style={{ position: "absolute", top, left: 0, right: 0, height: it.h }} className="i-rule-body">
                  <p><strong>Counter-argument (this rule):</strong> {counter}</p>
                  <p className="muted small"><strong>Assumes:</strong> {assumes.join(" · ") || "nothing beyond what the code says"}</p>
                  {fix && <p className="muted small"><strong>How to fix (general):</strong> {fix}</p>}
                </div>;
              }
              const x = it.f!;
              const loc = locLabel(rowEvs[x.id]);
              const st = rowStatus(x);
              const sev = x.severity.toLowerCase();
              return <div key={it.key} style={{ position: "absolute", top, left: 0, right: 0, height: it.h }}>
                <div role="option" aria-selected={selected === x.id} className={`card i-row${selected === x.id ? " on" : ""}`} style={{ height: FINDING_H }}
                  aria-label={`${x.severity} — ${ruleName(x.ruleId)} — ${x.title}${loc ? `, ${loc}` : ""} — ${st.word}`}
                  onClick={() => setSelected(x.id)} onKeyDown={rowKey(() => setSelected(x.id))} tabIndex={selected === x.id ? 0 : -1}>
                  <div className="i-row-l1">
                    <span className={`d-sev ${sevClassOf(sev)}`}>{x.severity.toUpperCase()}</span>
                    <span className="i-row-title" title={x.summary}>{x.title}</span>
                    {loc ? <a className="i-loc mono" href={`vscode://file${rowEvs[x.id].absPath ?? ""}:${rowEvs[x.id].startLine || 1}`} title={`Open ${loc} in VS Code`} onClick={(e2) => e2.stopPropagation()}>{truncateMiddle(loc, 30)} ↗</a> : null}
                    {loc && <button className="link i-copy" aria-label={`Copy location ${loc}`} title={`Copy ${loc}`} onClick={(e2) => { e2.stopPropagation(); void navigator.clipboard?.writeText(loc); }}>⧉</button>}
                    {rowEvs[x.id]?.state === "STALE" && <span className="d-stale" title="The file changed after the index that produced this finding">stale</span>}
                    <span className="muted small i-status-word">{st.word}</span>
                    <span className="i-row-actions">
                      {tri[x.id]?.state === "CONFIRMED"
                        ? <button className="link small" title="Remove your confirmation (in this browser)" onClick={(e2) => { e2.stopPropagation(); setTriage(x.id, null); }}>you confirmed ✓ · undo</button>
                        : tri[x.id]?.state === "DISMISSED"
                          ? <button className="link small" title="Undismiss (in this browser)" onClick={(e2) => { e2.stopPropagation(); setTriage(x.id, null); }}>dismissed · undo</button>
                          : <button className="secondary small" title="You have read this finding and believe it is real. Marks stay in this browser; an alarm still needs proof or two approvers." onClick={(e2) => { e2.stopPropagation(); setSelected(x.id); setDismissOpen(false); setTriage(x.id, { state: "CONFIRMED", at: Date.now() }); }}>Confirm</button>}
                      {shown[x.id] ? <p role="status" className="i-gate-status">{shown[x.id]}</p> : <button className="secondary small" title="A candidate becomes an alarm only with deterministic proof or two authorised confirmations. This runs the gate for this finding." onClick={(e2) => { e2.stopPropagation(); void gate(x.id); }}>Start confirmation</button>}
                    </span>
                  </div>
                </div>
              </div>;
            });
          })()}
        </div>
        <p className="muted small i-shown">showing {range[1] - range[0]} of {items.length} lines (rule headers, notes and findings)</p>
      </div>
      {sel && <article className="i-detail" aria-label={`Details: ${sel.title}, ${sel.severity}`}>
        <div className="i-row-l1">
          <span className={`d-sev ${sevClassOf(sel.severity)}`}>{sel.severity.toUpperCase()}</span>
          <Badge kind={statusKind(sel.state)}>{sel.state === "ALARM" ? "alarm (gate satisfied)" : "candidate"}</Badge>
          <span className="badge">{ruleName(sel.ruleId)}</span>
          <span className="badge" title={`rule ${sel.ruleId} v${sel.ruleVersion} · digest ${sel.ruleDigest.slice(0, 12)}`}>rule v{sel.ruleVersion}</span>
          <span className="muted small">({rowStatus(sel).word})</span>
        </div>
        <p><strong>{sel.title}.</strong> {sel.summary}</p>
        <p className="counter"><strong>Counter-argument:</strong> {sel.counterArgument}</p>
        {shown[sel.id] && <p role="status" className="small i-gate-status">{shown[sel.id]}</p>}
        <div className="i-detail-actions">
          {tri[sel.id]?.state === "CONFIRMED"
            ? <button className="secondary small" onClick={() => setTriage(sel.id, null)}>Undo your confirmation</button>
            : <button className="secondary small" onClick={() => { setDismissOpen(false); setTriage(sel.id, { state: "CONFIRMED", at: Date.now() }); }}>Confirm</button>}
          {tri[sel.id]?.state === "DISMISSED"
            ? <button className="secondary small" onClick={() => setTriage(sel.id, null)}>Undismiss</button>
            : <button className="secondary small" aria-expanded={dismissOpen} onClick={() => setDismissOpen((o) => !o)}>{dismissOpen ? "Pick a reason…" : "Dismiss"}</button>}
          <button className="secondary small" title="A candidate becomes an alarm only with deterministic proof or two authorised confirmations." onClick={() => void gate(sel.id)}>Start confirmation</button>
          <button className="secondary small" onClick={() => copyFinding(sel)}>Copy</button>
          {onAsk && <button className="secondary small" title="Opens the conversation with this finding described" onClick={() => onAsk(`Explain the security finding “${sel.title}” (${sel.ruleId}${selLoc ? ` at ${selLoc}` : ""}): ${sel.summary} Why might it be wrong, and what would settle it?`)}>Ask about this finding</button>}
        </div>
        {dismissOpen && tri[sel.id]?.state !== "DISMISSED" && <div role="group" aria-label="Dismiss reason" className="i-dismiss-picker">
          <p className="muted small">Why is this a non-issue in your reading? (in this browser)</p>
          <div className="row">{DISMISS_REASONS.map((reason) => <button key={reason} className="secondary small" onClick={() => { setTriage(sel.id, { state: "DISMISSED", reason, at: Date.now() }); setDismissOpen(false); }}>{reason}</button>)}
            <button className="link small" onClick={() => setDismissOpen(false)}>Cancel</button></div>
        </div>}
        {tri[sel.id] && <p className="muted small">Triaged by you {relative(new Date(tri[sel.id].at).toISOString())} (in this browser — the server keeps no record of this).</p>}
        <details open={evs.length > 0}><summary>Source evidence <span className="muted small">({plural(sel.evidenceIds.length, "piece of evidence", "pieces of evidence")}{evs.length && evs.length < sel.evidenceIds.length ? `, first ${evs.length} shown` : ""})</span></summary>
          {selLoc && evs.length === 0 && <p className="muted small">first evidence at <code>{selLoc}</code></p>}
          {evs.map((ev) => <details key={ev.id} open={evs.length === 1}><summary><code title={ev.file}>{cut(truncateMiddle(ev.file, 40) + ":" + ev.startLine, 46)}</code> · {ev.class.replaceAll("_", " ").toLowerCase()} {ev.state !== "CURRENT" && <span className="d-stale">{ev.state.toLowerCase()}</span>}</summary>
            <pre className="mono"><code>{ev.snippet || "(snippet unavailable)"}</code></pre>
            {ev.absPath && <a className="open" href={`vscode://file${ev.absPath}:${ev.startLine || 1}`} title="Open this location in VS Code">open in editor</a>}
          </details>)}
        </details>
        <details><summary>Assumes</summary><ul>{sel.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></details>
        <details><summary>Rule details</summary><p className="muted small mono">rule {sel.ruleId} v{sel.ruleVersion} · digest {sel.ruleDigest} · source {statusText(sel.source)}</p>
          {RULE_INFO[sel.ruleId]?.fix && <p className="muted small"><strong>How to fix (general):</strong> {RULE_INFO[sel.ruleId].fix}</p>}</details>
        <p className="muted small">{sel.disclaimer}</p>
      </article>}
    </div>}
    <div className="i-narr-row">
      <button className="secondary small" disabled={!f.data?.length} onClick={() => void n.run("C25", "buildAuditNarrative", { revision, findingIds: filtered.map((x) => x.id) })} title="Builds the audit narrative for the findings that pass the current filters">Narrative · current filters ({filtered.length})</button>
      {n.data && <>
        <button className="link small" onClick={() => void navigator.clipboard?.writeText(n.data!.markdown)}>Copy narrative</button>
        <button className="link small" onClick={() => downloadText(`${revision}-audit-narrative.md`, "text/markdown", n.data!.markdown)}>Download</button>
      </>}
    </div>
    {n.data && <section aria-label="Audit narrative">{n.data.missingControls.length > 0 && <p className="muted small">Not declared: {n.data.missingControls.join(", ")}</p>}<pre tabIndex={0} aria-label="Audit narrative" className="narr">{n.data.markdown}</pre></section>}
  </>;
}

// ---------------------------------------------------------------- C06
// Configuration artifacts are a bounded table per kind, but a real repository carries hundreds of routes (471 on the
// current test revision), so the tables render as windowed fixed-height rows with a search and per-kind chips with
// counts. A master/detail split is deliberately not used: each row already carries the whole artifact.
interface Artifact { id: string; kind: string; name: string; status: string; detail: string; candidates: string[]; deployed: string }
function Config({ revision }: { revision: string }) {
  const a = useCall<{ artifacts: Artifact[]; diagnostics: { code: string; message: string }[]; notice: string }>();
  useEffect(() => { void a.run("C06", "extractArtifacts", { revision }); }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const [search, setSearch] = useState("");
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const kindLabels = { route: "Routes → handlers", table: "Tables ↔ migrations", queue: "Queues", flag: "Feature flags" } as Record<string, string>;
  const kindOrder = ["route", "table", "queue", "flag"];
  const kindCounts = useMemo(() => { const c: Record<string, number> = {}; for (const x of a.data?.artifacts ?? []) c[x.kind] = (c[x.kind] ?? 0) + 1; return c; }, [a.data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const kindsSet = kinds.size ? kinds : new Set(kindOrder.filter((k) => (kindCounts[k] ?? 0) > 0));
    return (a.data?.artifacts ?? []).filter((x) => kindsSet.has(x.kind) && (!q || `${x.name} ${x.detail} ${x.candidates.join(" ")}`.toLowerCase().includes(q)));
  }, [a.data, search, kinds]); // eslint-disable-line react-hooks/exhaustive-deps
  const statusBadge = (s: string) => <Badge kind={statusKind(s)}>{statusText(s)}</Badge>;
  return <>
    <Status error={a.error} busy={a.busy} />
    {a.data && <>
      <p className="notice">{a.data.notice}</p>
      <div className="i-toolbar">
        <input type="search" placeholder="Search routes, tables, queues, flags…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search configuration artifacts" />
        {kindOrder.map((k) => (kindCounts[k] ?? 0) > 0 ? <button key={k} className={`d-chip${kinds.has(k) ? " on" : ""}`} aria-pressed={kinds.has(k)} onClick={() => setKinds((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n; })}>{kindLabels[k]} {kindCounts[k]}</button> : null)}
        <span className="muted small">{filtered.length} of {(a.data.artifacts ?? []).length} artifacts · {(a.data.diagnostics ?? []).length} diagnostics</span>
      </div>
      {filtered.length === 0 && (a.data.artifacts ?? []).length > 0 && <p className="muted">No artifacts match the current search/filter.</p>}
      {kindOrder.map((k) => { const rows = filtered.filter((x) => x.kind === k); const total = kindCounts[k] ?? 0; return (
        <section key={k}><h3>{kindLabels[k]} <small className="muted">({total})</small></h3>
          {rows.length === 0 ? <p className="muted small">{total > 0 ? "None match the current search." : "None found."}</p> : (
          <WindowedRows rows={rows} rowH={44} label={`${kindLabels[k]} list`} render={(r: Artifact) => <div className="i-row2" style={{ height: 44 }}>
              <span className="mono" title={r.name}>{cut(r.name, 30)}</span>
              {statusBadge(r.status)}
              <span className="i-row-det" title={r.detail}>{r.detail}{r.candidates.length > 0 ? ` · candidates: ${r.candidates.join(", ")}` : ""}</span>
            </div>}>
          </WindowedRows>
        )}
        </section>); })}
      <h3>Diagnostics <small className="muted">({a.data.diagnostics.length})</small></h3>
      <ul>{a.data.diagnostics.map((d, i) => <li key={i}><code>{d.code}</code> {d.message}</li>)}</ul>
    </>}
  </>;
}

// ---------------------------------------------------------------- C08
interface Proposal { id: string; kind: string; state: string; version: number; oldIds: string[]; newIds: string[]; evidence: string[]; strength: string }
function Identity({ revision }: { revision: string }) {
  const p = useCall<Proposal[]>(); const d = useCall<{ name: string; canon: { entityId: string }[] }[]>(); const v = useCall<Proposal>();
  const load = useCallback(() => { void p.run("C08", "proposals", { revision }); void d.run("C08", "duplicateNames", { revision }); }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  const decide = async (x: Proposal, verdict: "CONFIRM" | "DISPUTE" | "REFUTE") => { await v.run("C08", "applyIdentityVerdict", { proposalId: x.id, verdict, expectedVersion: x.version }, true); load(); };
  const short = (id: string) => id.replace(/^[a-z]+:/, "");
  // The name-collision list reaches four-digit scale (1,149 on the current test revision): windowed rows with a
  // search and a detail pane holding the full canonical entity list. The proposal cards stay inline: they are few
  // and their confirm/dispute/reject buttons are the point.
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const collisions = useMemo(() => (d.data ?? []).filter((x) => !q || x.name.toLowerCase().includes(q.trim().toLowerCase())), [d.data, q]);
  const pickedRow = (d.data ?? []).find((x) => x.name === picked) ?? null;
  return <>
    <p className="notice">A name alone never merges two things. An identical body that appears once on each side is a supported rename; splits, merges and ambiguous matches stay proposals until you decide, and any decision can be reversed.</p>
    <Status error={p.error ?? v.error} busy={p.busy} />
    <h3>Identity proposals <small className="muted">({p.data?.length ?? 0})</small></h3>
    {p.data?.length === 0 && <p className="muted">No renames, splits or merges were detected between indexed revisions.</p>}
    <ul className="cards">{(p.data ?? []).map((x) => (
      <li key={x.id} className="card">
        <div><Badge>{x.kind.toLowerCase()}</Badge><Badge kind={statusKind(x.state)}>{x.state.toLowerCase()}</Badge><Badge kind="hyp">{x.strength.replace("_", " ").toLowerCase()}</Badge></div>
        <p><code>{x.oldIds.map(short).join(", ")}</code> → <code>{x.newIds.map(short).join(", ")}</code></p>
        <p className="muted small">{x.evidence.join("; ")}</p>
        <div className="row" role="group" aria-label={`Decide on this ${x.kind.toLowerCase()}`}>
          {x.state !== "CONFIRMED" && x.state !== "SUPPORTED" && x.state !== "REVERSED" && <button className="secondary small" onClick={() => void decide(x, "CONFIRM")}>Confirm</button>}
          {x.state === "PROPOSED" && <button className="secondary small" onClick={() => void decide(x, "DISPUTE")}>Dispute</button>}
          {x.state !== "REVERSED" && <button className="secondary small" onClick={() => void decide(x, "REFUTE")}>{x.state === "PROPOSED" ? "Reject" : "Reverse"}</button>}
        </div>
      </li>))}</ul>
    <h3>Same name, different things <small className="muted">({d.data?.length ?? 0})</small></h3>
    {(d.data ?? []).length === 0 ? null : <div className="i-toolbar">
      <input type="search" placeholder="Search names…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search name collisions" />
      <span className="muted small">{collisions.length} of {(d.data ?? []).length} names</span>
    </div>}
    {(d.data ?? []).length > 0 && <div className="i-split">
      <WindowedRows rows={collisions} rowH={40} label="Name collisions" render={(x: { name: string; canon: { entityId: string }[] }) => <div role="option" aria-selected={picked === x.name} className={`i-row i-row2${picked === x.name ? " on" : ""}`} style={{ height: 40 }}
          aria-label={`${x.name}, ${x.canon.length} entities`} tabIndex={picked === x.name ? 0 : -1} onClick={() => setPicked(x.name)}
          onKeyDown={rowKey(() => setPicked(x.name))}>
          <strong className="i-row-title">{x.name}</strong>
          <span className="muted small" style={{ flex: "none" }}>{x.canon.length} entities</span>
          <span className="i-row-det mono" title={x.canon.map((c) => short(c.entityId)).join(" · ")}>{cut(x.canon.map((c) => short(c.entityId)).join(" · "), 52)}</span>
        </div>}>
      </WindowedRows>
      {pickedRow && <article className="i-detail" aria-label={`Entities named ${pickedRow.name}`}>
        <div className="d-detail-head"><h3 className="i-detail-title">“{pickedRow.name}” — {pickedRow.canon.length} different entities</h3></div>
        <p className="muted small">The same name resolves to these {pickedRow.canon.length} entities in this revision; they are not merged or unified by that fact.</p>
        <ul className="i-canon">{pickedRow.canon.map((c) => <li key={c.entityId}><code className="mono">{short(c.entityId)}</code> <button className="link" onClick={() => { void navigator.clipboard?.writeText(short(c.entityId)); }}>copy</button></li>)}</ul>
      </article>}
    </div>}
  </>;
}

// ---------------------------------------------------------------- C23 / C07
interface ChangeSet { base: string; head: string; textDiff: { filesChanged: number; symbolsTouched: number }; consequences: { id: string; kind: string; text: string; displayMode: string }[]; blastRadius: { entityId: string; dependents: number; files: string[] }[]; testImpact: { entityId: string; lost: string[]; gained: string[] }[]; entities: { base: string | null; head: string | null; change: string }[] }
function Changes({ revision, view }: { revision: string; view: ViewSpec | null }) {
  const revs = useCall<{ id: string; createdAt: string; files: number }[]>(); const c = useCall<ChangeSet>(); const arch = useCall<any>();
  const [base, setBase] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState("");
  useEffect(() => { void (async () => { const st = await call<{ revision: { repoRoot: string } | null }>("C01", "status", { revision }); const r = await revs.run("C07", "listRevisions", { repoRoot: st.ok ? st.value.revision?.repoRoot : undefined }); const other = r?.find((x) => x.id !== revision); if (other) setBase(other.id); })(); }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const nodes = (view?.nodes ?? []).filter((n) => ["function", "method", "class"].includes(n.kind));
  return <>
    <p className="notice">A consequence says what is true in one revision and not the other. It never says what caused it; commit chronology is observed, the reasons stay inferences.</p>
    <div className="row"><label htmlFor="base">Compare against</label>
      <select id="base" value={base} onChange={(e) => setBase(e.target.value)}>{(revs.data ?? []).filter((r) => r.id !== revision).map((r) => <option key={r.id} value={r.id}>{r.id} · {r.createdAt.slice(0, 16).replace("T", " ")} · {r.files} files</option>)}</select>
      <button disabled={!base || c.busy} onClick={() => void c.run("C23", "compare", { base, head: revision })}>Compare</button></div>
    {revs.data && revs.data.length < 2 && <p className="muted">Only one revision is indexed. Change something and re-index to compare.</p>}
    <Status error={c.error ?? arch.error} busy={c.busy || arch.busy} />
    {c.data && <>
      <p>{c.data.textDiff.symbolsTouched} symbol(s) touched in {c.data.textDiff.filesChanged} file(s).</p>
      <h3>What is different <small className="muted">({c.data.consequences.length})</small></h3>
      <ul>{c.data.consequences.map((x) => <li key={x.id}><Badge kind={x.kind === "TRANSACTION_BYPASS" || x.kind === "TESTS_LOST" || x.kind === "NEW_CYCLE" ? "warn" : "inference"}>{x.kind.replace(/_/g, " ").toLowerCase()}</Badge> {x.text}</li>)}</ul>
      <h3>Blast radius</h3>
      <table className="gates"><tbody>{c.data.blastRadius.map((b) => <tr key={b.entityId}><th scope="row">{b.entityId.replace(/^.*#/, "")}</th><td>{b.dependents} dependent(s)</td><td>{b.files.join(", ") || "—"}</td></tr>)}</tbody></table>
      {c.data.testImpact.length > 0 && <><h3>Tests</h3><ul>{c.data.testImpact.map((t) => <li key={t.entityId}><strong>{t.entityId.replace(/^.*#/, "")}</strong>: {t.lost.length ? `no longer reached by ${t.lost.join(", ")}` : ""} {t.gained.length ? `now reached by ${t.gained.join(", ")}` : ""}</li>)}</ul></>}
    </>}
    <h3>Why is it this way? (archaeology)</h3>
    <div className="row"><label htmlFor="ent">Element</label><select id="ent" value={entity} onChange={(e) => setEntity(e.target.value)}><option value="">choose…</option>{nodes.map((n) => <option key={n.id} value={n.entityRefs[0]}>{n.label}</option>)}</select>
      <label htmlFor="since">Since</label><input id="since" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      <button disabled={!entity} onClick={() => void arch.run("C23", "archaeology", { revision, entityId: entity, window: from ? { from: `${from}T00:00:00Z` } : undefined })}>Show history</button></div>
    {nodes.length === 0 && <p className="muted small">Ask a question first so there are elements to choose from.</p>}
    {arch.data && <>
      <ul>{arch.data.chronology.map((x: any) => <li key={x.hash}><code>{x.hash}</code> {x.date.slice(0, 10)} · {x.author} — “{x.subject}”</li>)}</ul>
      {arch.data.fromForge?.map((x: any) => <p key={x.ref} className="small"><Badge kind="inference">untrusted text</Badge> {x.ref} “{x.title}” by {x.author} ({x.state})</p>)}
      {arch.data.gaps.map((g: any) => <p key={g.ref} className="warn-text small">{g.gap}</p>)}
      <p className="muted small">{arch.data.order}. Narrative claims below are inferences.</p>
      <ul>{arch.data.narrative.map((n: any) => <li key={n.draft.id}><Badge kind="inference">inference</Badge> {n.draft.assertion}</li>)}</ul>
    </>}
  </>;
}

// ---------------------------------------------------------------- C24
const SAMPLE = (rev: string) => JSON.stringify({ id: "env-1", sourceId: "api", deploymentId: "dep-1", codeRevision: rev, window: { from: Date.now() - 600000, to: Date.now() }, backendHandle: "tempo://tenant/api", signalKind: "trace", samplingRate: 1, spans: [{ traceId: "t1", spanId: "s1", name: "handler", startMs: Date.now() - 5000, endMs: Date.now() - 4980, file: "src/payments/fraud.ts", line: 5, fn: "checkFraud", error: false }] }, null, 2);
function Runtime({ revision }: { revision: string }) {
  const r = useCall<any>();
  const [text, setText] = useState(SAMPLE(revision));
  const [marker, setMarker] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setErr(null); let env: any; try { env = JSON.parse(text); } catch { setErr("That is not valid JSON."); return; }
    if (marker && env.deploymentId && env.codeRevision) await call("C24", "recordMarker", { sourceId: env.sourceId, deploymentId: env.deploymentId, revision: env.codeRevision, at: 0 }, key());
    const ing = await call<any>("C24", "ingest", { envelope: env }, key());
    if (!ing.ok) { setErr(ing.error.message + (ing.error.retryable ? " (you can retry later)" : "")); return; }
    await r.run("C24", "attribute", { envelopeId: env.id, revision });
  };
  const a = r.data;
  return <>
    <p className="notice">Runtime signals are joined to code with a stated exactness. A join is exact only when the revision, a deployment marker and a code location agree; anything else says why, and what cannot be tied to code is fog, not a guess. Raw volume stays in your telemetry backend.</p>
    <label htmlFor="env">Runtime envelope (JSON)</label>
    <textarea id="env" rows={9} className="mono" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
    <div className="row"><label><input type="checkbox" checked={marker} onChange={(e) => setMarker(e.target.checked)} /> Record the deployment marker (deployment → this revision)</label><button onClick={() => void go()} disabled={r.busy}>Ingest and attribute</button></div>
    <Status error={err ?? r.error} busy={r.busy} warnings={r.warnings} />
    {a && <>
      <p><Badge kind={a.exact ? "fact" : "hyp"}>{a.exact ? "exact" : "not exact"}</Badge><Badge>{a.method.replace(/_/g, " ").toLowerCase()}</Badge>{a.samplingRate && <Badge kind="hyp">sampled at {a.samplingRate}</Badge>}</p>
      {a.uncertaintyReason && <p className="counter"><strong>Why not exact:</strong> {a.uncertaintyReason}</p>}
      <table className="gates"><thead><tr><th scope="col">Code</th><th scope="col">Spans</th><th scope="col">Errors</th><th scope="col">p95 ms</th><th scope="col">Join</th></tr></thead><tbody>{a.perEntity.map((p: any) => <tr key={p.entityId}><th scope="row">{p.entityId.replace(/^.*#/, "")}</th><td>{p.spans}{p.estimatedSpans ? ` (≈${p.estimatedSpans})` : ""}</td><td>{p.errors}</td><td>{p.p95Ms ?? "—"}</td><td>{p.exact ? "exact" : p.method.replace(/_/g, " ").toLowerCase()}</td></tr>)}</tbody></table>
      <p><strong>Fog:</strong> {a.fog.spans} span(s) not tied to code{a.fog.reasons.length ? ` — ${a.fog.reasons.join("; ")}` : ""}.</p>
      <p className="muted small">Quality: {a.quality.length ? a.quality.join(", ") : "no issues noted"} · {a.counted.valid} valid, {a.counted.invalid} with impossible timestamps (excluded).</p>
    </>}
  </>;
}

// ---------------------------------------------------------------- C04
function Sources({ revision }: { revision: string }) {
  const s = useCall<{ sourceId: string; state: string; lastOk: string | null; lastError: string | null; resumeAt: string | null }[]>();
  const st = useCall<{ revision: { repoRoot: string } | null }>();
  const ingest = useCall<any>();
  const load = useCallback(async () => { await s.run("C04", "listSources", {}); await st.run("C01", "status", { revision }); }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load();
    // Sources can be registered automatically by indexing in the background;
    // refresh the list lightly while this panel is open.
    const t = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(t);
  }, [load]);
  const repoRoot = st.data?.revision?.repoRoot;
  const doIngest = async (sourceId: string) => {
    if (!repoRoot) return;
    await ingest.run("C04", "ingestGhSource", { repoRoot });
    await load();
  };
  return <>
    <p className="notice">External sources (a forge's pull requests, reviews) are read by the server. Credentials never enter the browser. Records that fail validation are set aside, so a source can be <em>partial</em>; an expired credential or a rate limit is shown as such, not retried in a loop. If the repository has a GitHub <code>origin</code> remote and the <code>gh</code> CLI is authenticated, a source is registered automatically when the repository is indexed; fetching pull requests from GitHub still requires clicking the button, because it consumes API quota.</p>
    <Status error={s.error ?? st.error ?? ingest.error} busy={s.busy || st.busy || ingest.busy} />
    {s.data?.length === 0 && <p className="muted">No external source is connected yet. If you index a GitHub repository while <code>gh</code> is authenticated, its source will appear here automatically.</p>}
    <ul className="cards">{(s.data ?? []).map((x) => <li key={x.sourceId} className="card"><strong>{x.sourceId}</strong> <Badge kind={statusKind(x.state)}>{x.state.replace(/_/g, " ").toLowerCase()}</Badge>
      <p className="muted small">{x.lastOk ? `Last good read ${x.lastOk.slice(0, 16).replace("T", " ")}.` : "Never read successfully."} {x.resumeAt ? `Resumes after ${x.resumeAt.slice(0, 16).replace("T", " ")}.` : ""}</p>
      {x.lastError && <p className="warn-text small">{x.lastError}</p>}
      {x.sourceId.startsWith("gh:") && repoRoot && <div className="row"><button className="secondary small" disabled={ingest.busy} onClick={() => void doIngest(x.sourceId)}>Fetch pull requests</button></div>}
    </li>)}</ul>
  </>;
}

// ---------------------------------------------------------------- C29
function Team({ revision, view }: { revision: string; view: ViewSpec | null }) {
  const me = useCall<{ principal: string; tenant: string }>(); const people = useCall<string[]>(); const ws = useCall<{ id: string; name: string; role: string }[]>();
  const shares = useCall<{ shares: { principal: string; role: string }[]; history: { kind: string; actor: string; detail: any }[] }>(); const read = useCall<any>(); const concepts = useCall<{ concepts: any[]; withheld: number }>();
  const [name, setName] = useState("new person"); const [sel, setSel] = useState(""); const [who, setWho] = useState(""); const [role, setRole] = useState("viewer");
  const [msg, setMsg] = useState<string | null>(null); const [deny, setDeny] = useState("");
  const refresh = useCallback(async () => { await me.run("C29", "whoami"); await people.run("C29", "people"); await ws.run("C29", "workspaces"); await concepts.run("C29", "conceptsFor", { revision }); }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, [refresh]);
  const enable = async () => { const m = await call<{ principal: string }>("C29", "whoami"); if (!m.ok) return; await call("C29", "addPrincipal", { principal: m.value.principal }, key()); await call("C29", "setAccess", { principal: m.value.principal, revision, allowed: true }, key()); setMsg("Team features are on for you."); await refresh(); };
  const addPerson = async () => { const r = await call("C29", "addPrincipal", { principal: name }, key()); setMsg(r.ok ? `${name} added. They have no access to any code until you grant it.` : r.error.message); await refresh(); };
  const grant = async (p: string, allowed: boolean, denied: string[] = []) => { const r = await call("C29", "setAccess", { principal: p, revision, allowed, deniedPrefixes: denied }, key()); setMsg(r.ok ? `${p}: ${allowed ? `can read this repository${denied.length ? ` except ${denied.join(", ")}` : ""}` : "no access"}` : r.error.message); };
  const makeShared = async () => { const c = await call<{ id: string }>("C29", "create", { name: view?.question?.slice(0, 80) || "Shared investigation", revision }, key()); if (!c.ok) { setMsg(c.error.message); return; } if (view) await call("C29", "applyOperation", { workspaceId: c.value.id, event: { kind: "SET_VIEW", view }, expectedVersion: 0 }, key()); setSel(c.value.id); await refresh(); };
  useEffect(() => { if (sel) void shares.run("C29", "shares", { workspaceId: sel }); }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const doShare = async () => { const r = await call("C29", "share", { workspaceId: sel, principalId: who, role }, key()); setMsg(r.ok ? `Shared with ${who} as ${role}.` : r.error.message); await shares.run("C29", "shares", { workspaceId: sel }); };
  const handover = async () => { const cur = await call<any>("C29", "read", { workspaceId: sel }); if (!cur.ok) { setMsg(cur.error.message); return; } const r = await call<any>("C29", "handover", { workspaceId: sel, principalId: who, expectedVersion: cur.value.workspace.version }, key()); setMsg(r.ok ? `Handed over to ${who}. ${r.value.recipient.gaps.items ? `${r.value.recipient.gaps.items} item(s) are about code they cannot read and were not shown to them.` : "They can read everything in it."}` : r.error.message); await refresh(); await shares.run("C29", "shares", { workspaceId: sel }); };
  const confirm = async (c: any, verdict: "CONFIRM" | "REFUTE") => { const r = await call<any>("C29", "confirmSharedConcept", { conceptId: c.id, verdict, explanation: verdict === "CONFIRM" ? "confirmed by the team" : "corrected by the team", expectedVersion: 0 }, key()); if (!r.ok && r.error.code === "VERSION_CONFLICT") { const cv = (r.error as any).currentVersion; const r2 = await call<any>("C29", "confirmSharedConcept", { conceptId: c.id, verdict, explanation: verdict === "CONFIRM" ? "confirmed by the team" : "corrected by the team", expectedVersion: cv }, key()); setMsg(r2.ok ? `Concept ${r2.value.state.toLowerCase()}.` : r2.error.message); } else setMsg(r.ok ? `Concept ${r.value.state.toLowerCase()}.` : r.error.message); await concepts.run("C29", "conceptsFor", { revision }); };
  const peopleOther = (people.data ?? []).filter((p) => p !== me.data?.principal);
  // "Team features are on for me" means my principal has been registered, not merely that I have a session.
  const teamOn = !!me.data?.principal && (people.data ?? []).includes(me.data.principal);
  return <div className="team-panel">
    <p className="notice">Sharing never grants access to code. Someone can be given an investigation only if they can already read what it is about, and they see it cut down to what they may read. You are <strong>{me.data?.principal ?? "…"}</strong>{me.data ? ` in ${me.data.tenant}` : ""}.</p>
    <Status error={me.error ?? people.error ?? ws.error ?? shares.error ?? read.error} busy={me.busy || people.busy} />
    {msg && <p role="status" className="small">{msg}</p>}
    <section><h3>People and access</h3>
      <div className="field">
        <button type="button" role="switch" aria-checked={teamOn} disabled={teamOn} className={`switch ${teamOn ? "on" : ""}`} onClick={() => void enable()}>{teamOn ? "Team features are on" : "Turn on team features for me"}</button>
      </div>
      <div className="field">
        <label htmlFor="pname">New person</label>
        <div className="inline">
          <input id="pname" value={name} onChange={(e) => setName(e.target.value)} />
          <button onClick={() => void addPerson()} className="secondary">Add person</button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="deny">Folders to hide, comma separated</label>
        <input id="deny" value={deny} onChange={(e) => setDeny(e.target.value)} placeholder="e.g. src/ledger" />
      </div>
      <ul>{(people.data ?? []).map((p) => <li key={p}>{p}{p !== me.data?.principal && <span className="row wrap"> <button className="secondary small" onClick={() => void grant(p, true)}>Can read this repository</button><button className="secondary small" onClick={() => void grant(p, true, deny.split(",").map((x) => x.trim()).filter(Boolean))} disabled={!deny.trim()}>Can read, except the folders above</button><button className="secondary small" onClick={() => void grant(p, false)}>No access</button></span>}</li>)}</ul>
    </section>
    <section><h3>Shared investigations</h3>
      <div className="field">
        <label htmlFor="wssel">Investigation to share</label>
        <select id="wssel" value={sel} onChange={(e) => setSel(e.target.value)}><option value="">choose…</option>{(ws.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name} ({w.role})</option>)}</select>
      </div>
      <div className="inline">
        <button onClick={() => void makeShared()} disabled={!view}>Share the current map as a new investigation</button>
      </div>
      {sel && <>
        <div className="row"><label htmlFor="who">With</label><select id="who" value={who} onChange={(e) => setWho(e.target.value)}><option value="">choose…</option>{peopleOther.map((p) => <option key={p}>{p}</option>)}</select>
          <label htmlFor="role">as</label><select id="role" value={role} onChange={(e) => setRole(e.target.value)}><option>viewer</option><option>editor</option></select>
          <button disabled={!who} onClick={() => void doShare()}>Share</button><button className="secondary" disabled={!who} onClick={() => void handover()}>Hand over ownership</button></div>
        <ul>{(shares.data?.shares ?? []).map((s) => <li key={s.principal}>{s.principal} — {s.role}</li>)}</ul>
        <details><summary>Operation history</summary><ul>{(shares.data?.history ?? []).map((h, i) => <li key={i}><code>{h.kind}</code> by {h.actor} {JSON.stringify(h.detail)}</li>)}</ul></details>
      </>}
    </section>
    <section><h3>Team concepts <small className="muted">({concepts.data?.concepts.length ?? 0} visible to you{concepts.data?.withheld ? `, ${concepts.data.withheld} withheld` : ""})</small></h3>
      <p className="muted small">Confirming or correcting a concept is attributed to you and reaches everyone who can see it. A confirmation is a judgment, never proof.</p>
      <ul className="cards">{(concepts.data?.concepts ?? []).slice(0, 12).map((c) => <li key={c.id} className="card"><strong>{c.title}</strong> <Badge>{c.kind}</Badge><Badge kind={statusKind(c.state)}>{c.state.toLowerCase()}</Badge>
        {(c.confirmedBy.length > 0 || c.refutedBy.length > 0) && <p className="muted small">{c.confirmedBy.length ? `Confirmed by ${c.confirmedBy.join(", ")}. ` : ""}{c.refutedBy.length ? `Corrected by ${c.refutedBy.join(", ")}.` : ""}</p>}
        <div className="row"><button className="secondary small" onClick={() => void confirm(c, "CONFIRM")}>Confirm</button><button className="secondary small" onClick={() => void confirm(c, "REFUTE")}>Correct</button></div></li>)}</ul>
    </section>
  </div>;
}

// ---------------------------------------------------------------- C17
function Evaluation() {
  const st = useCall<any>(); const runs = useCall<any[]>(); const run = useCall<any>();
  const load = useCallback(async () => { await st.run("C17", "status"); await runs.run("C17", "runs", {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  const go = async (suite: string) => { await run.run("C17", "runSuite", { suite }, true); await load(); };
  return <>
    <p className="notice">Measured against things whose answer is known, with an interval on every number. A model that has not been measured is not trusted, and labels made by a script are never counted as expert labels.</p>
    <Status error={st.error ?? run.error} busy={st.busy || run.busy} />
    {st.data && <>
      <h3>Model in use: <code>{st.data.model.name}/{st.data.model.model}</code></h3>
      <table className="gates"><tbody>{st.data.suites.map((s: any) => <tr key={s.suite}><th scope="row">{s.suite}</th><td><Badge kind={statusKind(s.status)}>{s.status.replace(/_/g, " ").toLowerCase()}</Badge></td><td>{s.note}</td><td><button className="secondary small" disabled={run.busy} onClick={() => void go(s.suite)}>Run now</button></td></tr>)}</tbody></table>
      <h3>Labels</h3>
      <p>{st.data.experts.realLabels} real label(s) from {st.data.experts.experts} labeler(s); {st.data.experts.syntheticLabels} synthetic. <Badge kind={st.data.experts.expertValidated ? "fact" : "warn"}>{st.data.experts.expertValidated ? "expert-validated" : "not expert-validated"}</Badge></p>
      {st.data.experts.note && <p className="muted small">{st.data.experts.note}</p>}
      <h3>Calibration</h3>
      {st.data.calibration.note ? <p className="muted">{st.data.calibration.note}</p> : <table className="gates"><thead><tr><th scope="col">Stated</th><th scope="col">n</th><th scope="col">Observed (interval)</th><th scope="col">Verdict</th></tr></thead><tbody>{st.data.calibration.bins.map((b: any) => <tr key={b.range[0]}><th scope="row">{Math.round(b.range[0] * 100)}–{Math.round(b.range[1] * 100)}%</th><td>{b.n}</td><td>{b.observed === null ? "—" : `${Math.round(b.observed * 100)}% (${Math.round(b.lower * 100)}–${Math.round(b.upper * 100)}%)`}</td><td>{b.verdict.replace(/_/g, " ").toLowerCase()}</td></tr>)}</tbody></table>}
    </>}
    <h3>Runs</h3>
    {(runs.data ?? []).length === 0 && <p className="muted">No suite has been run yet.</p>}
    <ul className="cards">{(runs.data ?? []).map((r) => <li key={r.id} className="card"><strong>{r.suite}</strong> v{r.suiteVersion} <code>{r.model}</code> <span className="muted small">{r.at.slice(0, 16).replace("T", " ")}</span>
      <p className="small">Precision {pct(r.metrics.precision)} · Recall {pct(r.metrics.recall)} · Accuracy {pct(r.metrics.accuracy)}</p>
      {r.misses.length > 0 && <p className="warn-text small">Wrong on: {r.misses.join(", ")}</p>}</li>)}</ul>
  </>;
}
