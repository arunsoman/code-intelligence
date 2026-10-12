// The "Reverse engineering" panel: what the source index could not resolve (the fog), what reverse
// analysis of the artifacts behind that fog has established (evidence records with their claim
// class), the residual unknowns that record what analysis could not answer, and the bundle envelope
// that moves all of it in and out. Every number here says how it is known — the same contract as the
// rest of the app. Nothing in this panel invents data: empty sections say so, the fog-to-evidence
// linkage is labelled as the path-name heuristic it is, and the bundle tab explains the exact
// authentication an import performs before anything is stored.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { call } from "./api.ts";
import { Loading } from "./Skeleton.tsx";
import { Modal } from "./Modal.tsx";

interface FogRow { module: string; references: number; subjects: string[]; hasEvidence: boolean }
interface FogInventory { rows: FogRow[]; note: string }
interface EvidenceRow {
  id: string; revision: string; state: string; observedAt: string; claimClass: string;
  subject: { path: string; sha256: string; format: string };
  provider: { id: string; name: string; version: string };
  predicate: string; confidence: string; authority: string; limitations: string[];
  locations: Array<{ kind: string; value: string; endValue?: string }>;
}
interface UnknownRow { id: string; revision: string; question: string; status: string; reason?: string; createdAt: string; updatedAt: string }
interface ListResult { records: EvidenceRow[]; unknowns: UnknownRow[] }
interface ExportResult { bundleDigest: string; serialized: string }
interface ImportResult { importedRecords: number; importedUnknowns: number; bundleDigest: string }
interface ArtifactRow { path: string; sizeBytes: number }
interface ListArtifactsResult { rows: ArtifactRow[]; root: string; note: string }
interface AnalyzeResult {
  path: string; format: string; formatDetail: string; sizeBytes: number; sha256: string;
  bundleDigest: string;
  claims: Array<{ id: string; predicate: string; confidence: string; claimClass: string }>;
  questions: Array<{ id: string; question: string }>;
  notes: string[];
}

interface Props { revision: string; onClose: () => void }

type TabId = "fog" | "evidence" | "unknowns" | "bundle";
type ClaimClass = "FACT" | "INFERENCE" | "HYPOTHESIS";
type Confidence = "observed" | "derived" | "inferred";

const CLAIM_LABEL: Record<ClaimClass, string> = { FACT: "Fact", INFERENCE: "Inference", HYPOTHESIS: "Hypothesis" };
const CONFIDENCES: Confidence[] = ["observed", "derived", "inferred"];
const CLASSES: ClaimClass[] = ["FACT", "INFERENCE", "HYPOTHESIS"];
/** The confidence triad, with the one-line epistemic reading each level carries. */
const CONF_META: Record<Confidence, string> = {
  observed: "a tool directly observed this in the artifact",
  derived: "computed from observations, not seen directly",
  inferred: "looks likely from indirect signals",
};
const STATUS_META: Record<string, { label: string; chip: string; hint: string }> = {
  open: { label: "Open", chip: "re-chip-open", hint: "not yet answered" },
  resolved: { label: "Resolved", chip: "re-chip-resolved", hint: "answered by later evidence" },
  retired: { label: "Retired", chip: "re-chip-retired", hint: "no longer worth pursuing" },
  retracted: { label: "Retracted", chip: "re-chip-retracted", hint: "withdrawn as malformed or mistaken" },
};

// --- Icons: minimal 16px strokes, currentColor, decorative (labels carry the meaning). ---
const icon = (d: string, extra: ReactNode = null) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />{extra}
  </svg>
);
const FogIcon = () => icon("M2.6 9.8a3.3 3.3 0 0 1 .7-6.5 4.4 4.4 0 0 1 8.5 1.2 2.9 2.9 0 0 1-.4 5.3Z M3.5 12h9 M5 14.3h6");
const LedgerIcon = () => icon("M4 1.8h6.6L13.8 5v9.2H4Z M10.4 1.8V5h3.4 M6 8h6 M6 10.8h6");
const QuestionIcon = () => icon("M8 1.9a6.1 6.1 0 1 1 0 12.2A6.1 6.1 0 0 1 8 1.9Z M6.2 6.1a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.4 M8 11.6h.01");
const BundleIcon = () => icon("M8 1.7 14 4.6v6.8L8 14.3 2 11.4V4.6Z M2 4.6 8 7.5l6-2.9 M8 7.5v6.8");
const CopyIcon = () => icon("M5.5 5.5h7v7h-7Z M3 10.5V3.5h7");
const CheckIcon = () => icon("M3 8.6 6.4 12 13 4.6");
const SearchIcon = () => icon("M7 2.4a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2Z M10.4 10.4 13.8 13.8");
const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s ease", flex: "none" }}>
    <path d="m5.5 3 5 5-5 5" />
  </svg>
);

// --- Small helpers. ---
const shortHash = (s: string) => (s.length <= 14 ? s : `${s.slice(0, 12)}…`);
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtTime = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Copy-to-clipboard with a "copied" affordance keyed by what was copied. Falls back to execCommand
 * because the panel runs in plain browsers and non-secure contexts alike. */
function useCopy(): [string | null, (text: string, key: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback((text: string, key: string) => {
    const done = () => { setCopied(key); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setCopied(null), 1500); };
    if (navigator.clipboard?.writeText) { void navigator.clipboard.writeText(text).then(done, done); return; }
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch { /* best effort: the value is also visible on screen */ }
    ta.remove(); done();
  }, []);
  return [copied, copy];
}

function CopyButton({ text, id, copied, onCopy, label }: { text: string; id: string; copied: string | null; onCopy: (t: string, k: string) => void; label: string }) {
  const isCopied = copied === id;
  return (
    <button type="button" className="re-copy" onClick={() => onCopy(text, id)}
      title={isCopied ? "Copied" : label} aria-label={isCopied ? `${label} — copied` : label}>
      {isCopied ? <CheckIcon /> : <CopyIcon />}
      <span aria-hidden="true">{isCopied ? "copied" : "copy"}</span>
    </button>
  );
}

// --- Overview strip. Four numbers, each with the reading that makes it meaningful. ---
function StatCard({ label, value, hint, tint, children }: { label: string; value: string; hint: string; tint?: string; children?: React.ReactNode }) {
  return (
    <div className={`re-stat${tint ? ` tint-${tint}` : ""}`}>
      <div className="re-stat-label">{label}</div>
      <div className="re-stat-value">{value}</div>
      {children}
      <div className="re-stat-hint" title={hint}>{hint}</div>
    </div>
  );
}

/** A single stacked bar for composition-at-a-glance: claim classes on the evidence card, coverage on the fog card. */
function SegmentedBar({ parts, empty }: { parts: Array<{ n: number; color: string; title: string }>; empty: string }) {
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (total === 0) return <div className="re-segbar" title={empty} />;
  return (
    <div className="re-segbar" role="img" aria-label={parts.map((p) => `${p.title}: ${p.n}`).join(", ")}>
      {parts.filter((p) => p.n > 0).map((p) => (
        <span key={p.title} style={{ width: `${(p.n / total) * 100}%`, background: p.color }} title={`${p.title}: ${p.n}`} />
      ))}
    </div>
  );
}

// --- The result of one probe: what the artifact's bytes supported, stated once, verbatim. ---
function ProbeResultCard({ result, copied, onCopy }: { result: AnalyzeResult; copied: string | null; onCopy: (t: string, k: string) => void }) {
  return (
    <div className="re-probe-result">
      <div className="re-evhead">
        <span className="chip pass" title={result.formatDetail}>{result.format}</span>
        <span className="muted small">{result.formatDetail} · {fmtBytes(result.sizeBytes)}</span>
        <span style={{ marginLeft: "auto" }}>
          <CopyButton text={result.sha256} id="probe-sha" copied={copied} onCopy={onCopy} label={`Copy the artifact sha256 (${result.sha256})`} />
        </span>
      </div>
      <div className="mono small muted" title={`sha256 ${result.sha256} · bundle ${result.bundleDigest}`}>
        sha256 {shortHash(result.sha256)} · stored in bundle {shortHash(result.bundleDigest)}
      </div>
      <ul className="re-probe-claims">
        {result.claims.slice(0, 6).map((c) => (
          <li key={c.id}>
            <span className={`chip re-chip-${c.confidence}`} title={c.claimClass}>{c.confidence}</span> {c.predicate}
          </li>
        ))}
        {result.claims.length > 6 && (
          <li className="muted small">+ {result.claims.length - 6} more — the Evidence tab holds them all, with limitations and locations.</li>
        )}
      </ul>
      {result.questions.length > 0 && (
        <p className="muted small" style={{ margin: 0 }}>
          {plural(result.questions.length, "question the bytes could not answer")} recorded as open residual unknowns — the Unknowns tab tracks {result.questions.length === 1 ? "it" : "them"}.
        </p>
      )}
      {result.notes.length > 0 && <p className="muted small" style={{ margin: 0 }}>{result.notes.join(" ")}</p>}
    </div>
  );
}

export function ReverseEngineeringPanel({ revision, onClose }: Props) {
  const [tab, setTab] = useState<TabId>("fog");
  const [fog, setFog] = useState<FogInventory | null>(null);
  const [list, setList] = useState<ListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [exportInfo, setExportInfo] = useState<ExportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [copied, copy] = useCopy();

  // Fog tab controls.
  const [fogQuery, setFogQuery] = useState("");
  const [fogSort, setFogSort] = useState<"refs" | "name">("refs");
  const [openFog, setOpenFog] = useState<Set<string>>(new Set());

  // Evidence ledger controls.
  const [evQuery, setEvQuery] = useState("");
  const [classSel, setClassSel] = useState<Set<ClaimClass>>(new Set());
  const [confSel, setConfSel] = useState<Set<Confidence>>(new Set());
  const [evSort, setEvSort] = useState<"newest" | "oldest" | "subject">("newest");
  const [openEv, setOpenEv] = useState<Set<string>>(new Set());

  const fileInput = useRef<HTMLInputElement>(null);
  const probeInput = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Artifact probe state.
  const [artifacts, setArtifacts] = useState<ListArtifactsResult | null>(null);
  const [probePath, setProbePath] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<AnalyzeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeDrag, setProbeDrag] = useState(false);

  const refresh = useCallback(() => {
    const controller = new AbortController();
    setError(null);
    void call<FogInventory>("C33", "fogInventory", { revision }, undefined, "v1", controller.signal)
      .then((r) => { if (!controller.signal.aborted) r.ok ? setFog(r.value) : setError(r.error.message); });
    void call<ListResult>("C33", "listEvidence", { revision }, undefined, "v1", controller.signal)
      .then((r) => { if (!controller.signal.aborted) r.ok ? setList(r.value) : setError(r.error.message); });
    void call<ListArtifactsResult>("C33", "listArtifacts", { revision }, undefined, "v1", controller.signal)
      .then((r) => { if (!controller.signal.aborted) r.ok ? setArtifacts(r.value) : setArtifacts({ rows: [], root: "", note: r.error.message }); });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => refresh(), [refresh]);

  // ---- Derived overview numbers (all computed from what the two reads returned — nothing invented). ----
  const stats = useMemo(() => {
    const rows = fog?.rows ?? [];
    const records = list?.records ?? [];
    const unknowns = list?.unknowns ?? [];
    const fogRefs = rows.reduce((s, r) => s + r.references, 0);
    const fogMax = rows.reduce((m, r) => Math.max(m, r.references), 0);
    const fogWithEv = rows.filter((r) => r.hasEvidence).length;
    const byClass = Object.fromEntries(CLASSES.map((c) => [c, records.filter((r) => r.claimClass === c).length])) as Record<ClaimClass, number>;
    const byStatus = Object.fromEntries(Object.keys(STATUS_META).map((s) => [s, unknowns.filter((u) => u.status === s).length])) as Record<string, number>;
    const limitations = records.reduce((s, r) => s + r.limitations.length, 0);
    return { rows, records, unknowns, fogRefs, fogMax, fogWithEv, byClass, byStatus, limitations };
  }, [fog, list]);

  const toggle = (set: Set<string>, id: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    apply(next);
  };

  // ---- Fog tab: filter + sort + proportional bars. ----
  const fogRows = useMemo(() => {
    const q = fogQuery.trim().toLowerCase();
    const hit = (r: FogRow) => !q || r.module.toLowerCase().includes(q) || r.subjects.some((s) => s.toLowerCase().includes(q));
    const sorted = stats.rows.filter(hit).sort((a, b) =>
      fogSort === "name" ? a.module.localeCompare(b.module) : b.references - a.references || a.module.localeCompare(b.module));
    return sorted;
  }, [stats.rows, fogQuery, fogSort]);

  // ---- Evidence ledger: multi-facet filtering. Empty selection = show all. ----
  const evRows = useMemo(() => {
    const q = evQuery.trim().toLowerCase();
    const hit = (r: EvidenceRow) => {
      if (classSel.size > 0 && !classSel.has(r.claimClass as ClaimClass)) return false;
      if (confSel.size > 0 && !confSel.has(r.confidence as Confidence)) return false;
      if (!q) return true;
      return [r.id, r.predicate, r.subject.path, r.provider.name, r.authority, ...r.limitations]
        .some((s) => s.toLowerCase().includes(q));
    };
    const cmp = {
      newest: (a: EvidenceRow, b: EvidenceRow) => b.observedAt.localeCompare(a.observedAt),
      oldest: (a: EvidenceRow, b: EvidenceRow) => a.observedAt.localeCompare(b.observedAt),
      subject: (a: EvidenceRow, b: EvidenceRow) => a.subject.path.localeCompare(b.subject.path) || b.observedAt.localeCompare(a.observedAt),
    }[evSort];
    return stats.records.filter(hit).sort(cmp);
  }, [stats.records, evQuery, classSel, confSel, evSort]);

  const unknownsSorted = useMemo(() => {
    const rank: Record<string, number> = { open: 0, resolved: 1, retired: 2, retracted: 3 };
    return [...stats.unknowns].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.question.localeCompare(b.question));
  }, [stats.unknowns]);

  // ---- Actions. ----
  const runImport = (text: string) => {
    setStatus(null); setError(null); setExportInfo(null);
    void call<ImportResult>("C33", "importBundle", { revision, bundleText: text })
      .then((r) => {
        if (r.ok) {
          setStatus(`Imported ${plural(r.value.importedRecords, "evidence record")} and ${plural(r.value.importedUnknowns, "unknown")} from an authenticated bundle (digest ${r.value.bundleDigest}).`);
          setImportText("");
          refresh();
        } else {
          setError(`${r.error.code}: ${r.error.message}`);
        }
      });
  };

  const runExport = () => {
    setStatus(null); setError(null);
    void call<ExportResult>("C33", "exportBundle", { revision })
      .then((r) => {
        if (!r.ok) { setError(`${r.error.code}: ${r.error.message}`); return; }
        setExportInfo(r.value);
        const parsed = JSON.parse(r.value.serialized) as { records: unknown[]; unknowns: unknown[] };
        const blob = new Blob([r.value.serialized], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `re-evidence-${revision}.json`;
        a.click();
        URL.revokeObjectURL(url);
        setStatus(`Exported ${plural(parsed.records.length, "record")} and ${plural(parsed.unknowns.length, "unknown")} — every id in the file is a content digest, so the bundle can be verified by the machine that receives it.`);
      });
  };

  const takeFile = (file: File | undefined | null) => {
    if (!file) return;
    void file.text().then(runImport);
  };

  // ---- Artifact probe. A dropped file is matched by name against the workspace candidates: the
  // server reads files it can see, so a drop is a pointer, not an upload. ----
  const runProbe = (pathArg?: string) => {
    const target = (pathArg ?? probePath).trim();
    if (!target || probing) return;
    setProbing(true); setProbeError(null); setProbeResult(null); setStatus(null); setError(null);
    void call<AnalyzeResult>("C33", "analyzeArtifact", { revision, path: target })
      .then((r) => {
        setProbing(false);
        if (r.ok) {
          setProbeResult(r.value);
          setStatus(`Probed ${r.value.path}: ${plural(r.value.claims.length, "claim")} stored as authenticated evidence, ${plural(r.value.questions.length, "open question")} recorded as unknowns.`);
          refresh();
        } else {
          setProbeError(`${r.error.code}: ${r.error.message}`);
        }
      });
  };
  const probeByDrop = (file: File | undefined | null) => {
    if (!file) return;
    const rows = artifacts?.rows ?? [];
    const match = rows.filter((r) => r.path === file.name || r.path.endsWith(`/${file.name}`));
    if (match.length === 1) {
      setProbePath(match[0]!.path);
      runProbe(match[0]!.path);
    } else if (match.length === 0) {
      setProbeError(`${file.name} is not inside the indexed repository — the probe reads files the server can see, so copy the artifact under the repository root first.`);
    } else {
      setProbeError(`${file.name} matches ${match.length} files in the repository; type or pick the exact path below.`);
    }
  };

  // WAI-ARIA tabs: roving focus with arrow keys, Home/End, activation follows focus.
  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const ids = TABS.map((t) => t.id);
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -Infinity : e.key === "End" ? Infinity : 0;
    if (delta === 0) return;
    e.preventDefault();
    const idx = delta === -Infinity ? 0 : delta === Infinity ? ids.length - 1 : (i + delta + ids.length) % ids.length;
    setTab(ids[idx]);
    tabRefs.current[idx]?.focus();
  };

  const TABS: Array<{ id: TabId; label: string; icon: ReactNode; count?: number }> = [
    { id: "fog", label: "Dependency fog", icon: <FogIcon />, count: fog?.rows.length },
    { id: "evidence", label: "Evidence", icon: <LedgerIcon />, count: list?.records.length },
    { id: "unknowns", label: "Unknowns", icon: <QuestionIcon />, count: list?.unknowns.length },
    { id: "bundle", label: "Bundle", icon: <BundleIcon /> },
  ];

  const hasNothing = stats.records.length === 0 && stats.unknowns.length === 0;

  return (
    <Modal title="Reverse engineering" onClose={onClose} className="wide tall"
      actions={<><span className="muted small">Evidence about the parts of the system the source index cannot see.</span><button onClick={onClose}>Done</button></>}>

      <p className="muted small re-intro">
        The source index is honest about what it cannot resolve. This panel works the boundary: the fog it
        reports, the evidence reverse analysis of the artifacts behind it has produced, and the questions
        that remain open on purpose.
      </p>

      {/* Overview strip — composition at a glance, before any tab is opened. */}
      <div className="re-stats" aria-label="Overview">
        <StatCard label="Dependency fog" value={String(stats.rows.length)} tint="fog"
          hint={`${plural(stats.fogRefs, "external reference")} across ${plural(stats.rows.length, "module")}`}>
          <SegmentedBar parts={[{ n: stats.fogWithEv, color: "var(--ok)", title: "with evidence" }, { n: stats.rows.length - stats.fogWithEv, color: "var(--fog)", title: "without evidence" }]}
            empty="no unresolved modules" />
        </StatCard>
        <StatCard label="Evidence records" value={String(stats.records.length)} tint="fact"
          hint={stats.limitations > 0 ? `${plural(stats.limitations, "limitation")} declared` : "no limitations declared"}>
          <SegmentedBar
            parts={[{ n: stats.byClass.FACT, color: "var(--fact)", title: "Fact" }, { n: stats.byClass.INFERENCE, color: "var(--inference)", title: "Inference" }, { n: stats.byClass.HYPOTHESIS, color: "var(--hyp)", title: "Hypothesis" }]}
            empty="no evidence records yet" />
        </StatCard>
        <StatCard label="Open unknowns" value={String(stats.byStatus.open ?? 0)} tint={(stats.byStatus.open ?? 0) > 0 ? "warn" : "ok"}
          hint={`${plural(stats.unknowns.length, "unknown")} tracked; ${(stats.byStatus.open ?? 0) === 0 && stats.unknowns.length > 0 ? "none open" : (stats.byStatus.open ?? 0) === 0 ? "none recorded yet" : "open questions are listed under Unknowns"}`}>
          <SegmentedBar
            parts={Object.entries(STATUS_META).map(([s, m]) => ({ n: stats.byStatus[s] ?? 0, color: s === "open" ? "var(--accent)" : s === "resolved" ? "var(--ok)" : "var(--line)", title: m.label }))}
            empty="no residual unknowns yet" />
        </StatCard>
        <StatCard label="Portable" value={String(stats.records.length + stats.unknowns.length)} tint="ok"
          hint="records + unknowns that travel in one authenticated bundle">
          <div className="re-bar ok" aria-hidden="true"><span style={{ width: stats.records.length + stats.unknowns.length > 0 ? "100%" : "0%" }} /></div>
        </StatCard>
      </div>

      {/* Tabs. */}
      <div className="re-tabs" role="tablist" aria-label="Reverse engineering sections">
        {TABS.map((t, i) => (
          <button key={t.id} ref={(el) => { tabRefs.current[i] = el; }} role="tab" id={`re-tab-${t.id}`}
            aria-selected={tab === t.id} aria-controls={`re-panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)} onKeyDown={(e) => onTabKeyDown(e, i)}>
            {t.icon}<span>{t.label}</span>
            {typeof t.count === "number" && <span className="re-tabcount" aria-label={`${t.count}`}>{t.count}</span>}
          </button>
        ))}
      </div>

      {error && <div className="banner error" role="alert">{error}</div>}
      {status && <div className="banner ok" role="status">{status}</div>}

      {/* ---- Dependency fog ---- */}
      {tab === "fog" && (
        <div role="tabpanel" id="re-panel-fog" aria-labelledby="re-tab-fog" tabIndex={0} className="re-tabpanel">
          {/* Artifact probe: the bridge from "the fog" to "the evidence" — point at a binary and read it. */}
          <section className="re-probe" aria-label="Probe an artifact">
            <div className="re-probe-head">
              <strong>Probe an artifact</strong>
              <span className="muted small">
                Point at a .jar, .war, .so, .dylib, .dll, .exe or .node file under the indexed repository. The
                probe reads what the bytes honestly support — format, embedded metadata, linked libraries,
                exports, telling strings — and stores every finding as authenticated evidence. Unanswerable
                questions become residual unknowns instead of guesses.
              </span>
            </div>
            <div className="re-probe-row">
              <div className={`re-drop re-drop-inline${probeDrag ? " over" : ""}`} role="button" tabIndex={0}
                aria-label="Drop an artifact file here to match it by name, or press Enter to browse"
                onClick={() => probeInput.current?.click()}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); probeInput.current?.click(); } }}
                onDragOver={(e) => { e.preventDefault(); setProbeDrag(true); }}
                onDragLeave={() => setProbeDrag(false)}
                onDrop={(e) => { e.preventDefault(); setProbeDrag(false); probeByDrop(e.dataTransfer.files?.[0]); }}>
                <strong>Drop a file</strong> — matched by name
              </div>
              <input ref={probeInput} type="file" hidden aria-hidden="true"
                onChange={() => { probeByDrop(probeInput.current?.files?.[0]); if (probeInput.current) probeInput.current.value = ""; }} />
              <div className="re-search">
                <SearchIcon />
                <input list="re-artifact-paths" value={probePath} onChange={(e) => setProbePath(e.target.value)}
                  placeholder="vendor/libfoo.so — a path under the repository root" aria-label="Artifact path to probe" />
              </div>
              <datalist id="re-artifact-paths">
                {(artifacts?.rows ?? []).map((r) => <option key={r.path} value={r.path}>{fmtBytes(r.sizeBytes)}</option>)}
              </datalist>
              <button onClick={() => runProbe()} disabled={probing || !probePath.trim()}>{probing ? "Probing…" : "Analyze"}</button>
            </div>
            {artifacts && artifacts.rows.length === 0 && (
              <p className="muted small" style={{ margin: 0 }}>No binary artifacts were found under the repository root. Type a path anyway if you know one.</p>
            )}
            {artifacts && artifacts.rows.length > 0 && (
              <p className="muted small" style={{ margin: 0 }}>{plural(artifacts.rows.length, "candidate artifact")} found in the workspace, largest first.</p>
            )}
            {probeError && <div className="banner error" role="alert">{probeError}</div>}
            {probing && <div className="banner" role="status">Reading the artifact in the worker…</div>}
            {probeResult && <ProbeResultCard result={probeResult} copied={copied} onCopy={copy} />}
          </section>

          <p className="muted small">
            Modules the source index imports but cannot resolve. Reverse analysis of the artifacts behind
            them — the probe above — is what turns a row here into evidence; the Evidence tab holds what
            has been established so far. <strong>With evidence</strong> is a path-name heuristic, not proof
            that every question about the module is answered.
          </p>
          <div className="re-toolbar">
            <div className="re-search">
              <SearchIcon />
              <input type="search" value={fogQuery} onChange={(e) => setFogQuery(e.target.value)}
                placeholder="Filter modules or importing files…" aria-label="Filter fog modules" />
            </div>
            <select className="re-sort" value={fogSort} onChange={(e) => setFogSort(e.target.value as "refs" | "name")} aria-label="Sort fog modules">
              <option value="refs">Most references</option>
              <option value="name">Name A–Z</option>
            </select>
          </div>
          {!fog ? <Loading pending label="dependency fog" /> : fogRows.length === 0 ? (
            <div className="re-empty">
              {stats.rows.length === 0
                ? <>No unresolved external imports were recorded for this revision, or the repository has not been indexed yet.</>
                : <>No module matches “{fogQuery}”.</>}
            </div>
          ) : (
            <div className="re-list" aria-label="Fog modules">
              {fogRows.map((row) => {
                const open = openFog.has(row.module);
                return (
                  <div key={row.module} className="re-fogrow">
                    <div className="re-fogtop">
                      <button type="button" className="re-expand" aria-expanded={open}
                        aria-label={`${open ? "Hide" : "Show"} the ${row.subjects.length} importing file${row.subjects.length === 1 ? "" : "s"} of ${row.module}`}
                        onClick={() => toggle(openFog, row.module, setOpenFog)}>
                        <ChevronIcon open={open} />
                      </button>
                      <span className="re-fogmod" title={row.module}>{row.module}</span>
                      <span className="re-fogmeta">
                        <span className="muted small">{plural(row.references, "ref")} · {plural(row.subjects.length, "file")}</span>
                        <span className={`chip ${row.hasEvidence ? "pass" : ""}`} style={row.hasEvidence ? undefined : { borderStyle: "dashed" }}
                          title={row.hasEvidence ? "Some evidence record's subject path names this module (path-name heuristic)" : "No evidence record names this module yet"}>
                          {row.hasEvidence ? "evidence present" : "no evidence"}
                        </span>
                      </span>
                    </div>
                    <div className="re-bar" aria-hidden="true">
                      <span style={{ width: stats.fogMax > 0 ? `${Math.max(6, (row.references / stats.fogMax) * 100)}%` : "0%" }} />
                    </div>
                    {open && (
                      <ul className="re-fogfiles">
                        {row.subjects.map((s) => <li key={s} className="mono">{s}</li>)}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {fog && <p className="muted small" style={{ margin: "8px 0 0" }}>{fog.note}</p>}
        </div>
      )}

      {/* ---- Evidence ledger ---- */}
      {tab === "evidence" && (
        <div role="tabpanel" id="re-panel-evidence" aria-labelledby="re-tab-evidence" tabIndex={0} className="re-tabpanel">
          <p className="muted small">
            Every record says how it is known. <strong>observed</strong> maps to a fact, <strong>derived</strong>{" "}
            to an inference, <strong>inferred</strong> to a hypothesis — and a model-authored claim can never
            display as a fact. Ids are content digests: the same observation always carries the same id, and
            limitations are what the record deliberately does not establish.
          </p>
          <div className="re-toolbar">
            <div className="re-search">
              <SearchIcon />
              <input type="search" value={evQuery} onChange={(e) => setEvQuery(e.target.value)}
                placeholder="Filter by id, predicate, subject, provider, limitation…" aria-label="Filter evidence records" />
            </div>
            {CLASSES.map((c) => (
              <button key={c} type="button" className={`re-filter f-${c}`} aria-pressed={classSel.has(c)}
                title={`Show only ${CLAIM_LABEL[c]} records`}
                onClick={() => { const n = new Set(classSel); if (n.has(c)) n.delete(c); else n.add(c); setClassSel(n); }}>
                {CLAIM_LABEL[c]} {stats.byClass[c]}
              </button>
            ))}
            {CONFIDENCES.map((c) => (
              <button key={c} type="button" className={`re-filter f-${c}`} aria-pressed={confSel.has(c)} title={CONF_META[c]}
                onClick={() => { const n = new Set(confSel); if (n.has(c)) n.delete(c); else n.add(c); setConfSel(n); }}>
                {c}
              </button>
            ))}
            <select className="re-sort" value={evSort} onChange={(e) => setEvSort(e.target.value as typeof evSort)} aria-label="Sort evidence records">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="subject">Subject path A–Z</option>
            </select>
          </div>
          {!list ? <Loading pending label="evidence records" /> : evRows.length === 0 ? (
            <div className="re-empty">
              {stats.records.length === 0
                ? <>No reverse-engineering evidence for this revision yet. Reverse analysis tools contribute records here; you can also import an authenticated bundle in the Bundle tab.</>
                : <>No record matches the current filters.</>}
            </div>
          ) : (
            <div className="re-list" aria-label="Evidence records">
              {evRows.map((r) => {
                const open = openEv.has(r.id);
                const conf = (CONFIDENCES as string[]).includes(r.confidence) ? r.confidence : "inferred";
                return (
                  <article key={r.id} className={`re-evcard claim-${r.claimClass}`}>
                    <div className="re-evhead">
                      <span className="badge" style={{ color: r.claimClass === "FACT" ? "var(--fact)" : r.claimClass === "INFERENCE" ? "var(--inference)" : "var(--hyp)" }}>
                        {CLAIM_LABEL[r.claimClass as ClaimClass] ?? r.claimClass}
                      </span>
                      <span className={`chip re-chip-${conf}`} title={CONF_META[conf as Confidence]}>{r.confidence}</span>
                      <span className="chip">{r.state.toLowerCase()}</span>
                      <span style={{ marginLeft: "auto" }}>
                        <CopyButton text={r.id} id={`ev:${r.id}`} copied={copied} onCopy={copy} label={`Copy evidence id ${r.id}`} />
                      </span>
                    </div>
                    <div className="re-evpred">{r.predicate}</div>
                    <div className="muted small">
                      by {r.provider.name} v{r.provider.version} · {r.authority} · observed {fmtTime(r.observedAt)}
                    </div>
                    <div className="re-subject">
                      <span className="mono" title={r.subject.path}>{r.subject.path}</span>
                      <span className="mono muted" title={`sha256 ${r.subject.sha256}`}>{r.subject.format} · sha256 {shortHash(r.subject.sha256)}</span>
                    </div>
                    <button type="button" className="re-expand" aria-expanded={open} onClick={() => toggle(openEv, r.id, setOpenEv)}>
                      {open ? "Hide locations and limitations" : `Show ${plural(r.locations.length, "location")}${r.limitations.length > 0 ? ` and ${plural(r.limitations.length, "limitation")}` : ""}`}
                    </button>
                    {open && (
                      <div className="re-details">
                        <dl className="re-kv">
                          <dt>Provider</dt><dd className="mono">{r.provider.id} · {r.provider.name} v{r.provider.version}</dd>
                          <dt>Authority</dt><dd>{r.authority}</dd>
                          <dt>Observed</dt><dd>{fmtTime(r.observedAt)}</dd>
                          <dt>Record id</dt><dd className="mono" title={r.id}>{r.id}</dd>
                        </dl>
                        {r.locations.length > 0 && (
                          <div>
                            <div className="muted small" style={{ marginBottom: 4 }}>Where in the artifact ({r.locations.map((l) => l.kind).join(", ")}) :</div>
                            {r.locations.map((l, i) => (
                              <div key={`${l.kind}:${l.value}:${i}`} className="re-locrow">
                                <span className="re-lockind">{l.kind}</span>
                                <span className="mono">{l.value}{l.endValue ? ` – ${l.endValue}` : ""}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {r.limitations.length > 0 && (
                          <div>
                            <div className="muted small" style={{ marginBottom: 4 }}>Does not establish:</div>
                            {r.limitations.map((lim) => <span key={lim} className="re-tag" title="A stated limitation, carried in the record's identity">{lim}</span>)}
                          </div>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ---- Residual unknowns ---- */}
      {tab === "unknowns" && (
        <div role="tabpanel" id="re-panel-unknowns" aria-labelledby="re-tab-unknowns" tabIndex={0} className="re-tabpanel">
          <p className="muted small">
            What reverse analysis could not determine, kept as records with a lifecycle instead of being
            forgotten. An unknown's identity is its question: asking twice is one unknown, and closing one
            never changes its id. <code>retired</code> and <code>retracted</code> are terminal — history stays
            in the ledger.
          </p>
          <div className="re-pipe" aria-label="Lifecycle summary">
            {Object.entries(STATUS_META).map(([s, m], i) => (
              <Fragment key={s}>
                {i > 0 && <span className="sep" aria-hidden="true">·</span>}
                <span className={`chip ${m.chip}`} title={m.hint}>{m.label} {stats.byStatus[s] ?? 0}</span>
              </Fragment>
            ))}
          </div>
          {!list ? <Loading pending label="residual unknowns" /> : unknownsSorted.length === 0 ? (
            <div className="re-empty">No residual unknowns for this revision yet — nothing is being hidden; there is simply nothing recorded.</div>
          ) : (
            <div className="re-list" aria-label="Residual unknowns">
              {unknownsSorted.map((u) => {
                const m = STATUS_META[u.status] ?? STATUS_META.open;
                return (
                  <article key={u.id} className="re-ucard">
                    <div className="re-evhead">
                      <span className={`chip ${m.chip}`} title={m.hint}>{m.label}</span>
                      <span className="re-uq">{u.question}</span>
                      <span style={{ marginLeft: "auto" }}>
                        <CopyButton text={u.id} id={`ru:${u.id}`} copied={copied} onCopy={copy} label={`Copy unknown id ${u.id}`} />
                      </span>
                    </div>
                    {u.reason && <div className="muted small">Reason: {u.reason}</div>}
                    <div className="muted small mono">created {fmtTime(u.createdAt)} · updated {fmtTime(u.updatedAt)} · <span title={u.id}>{shortHash(u.id)}</span></div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ---- Bundle ---- */}
      {tab === "bundle" && (
        <div role="tabpanel" id="re-panel-bundle" aria-labelledby="re-tab-bundle" tabIndex={0} className="re-tabpanel">
          <div className="re-bundle-grid">
            <section className="re-bcard" aria-label="Export">
              <h3>Export</h3>
              <p className="muted small">
                Serialises every evidence record and residual unknown for this revision into one
                authenticated bundle. The digest is computed over the members' identities, so two machines
                holding the same evidence produce the same digest.
              </p>
              <div>
                <button onClick={runExport} disabled={hasNothing}>Export bundle</button>
              </div>
              {exportInfo && (
                <>
                  <div className="re-digest">
                    <span className="muted small">digest</span>
                    <span className="mono" title={exportInfo.bundleDigest}>{exportInfo.bundleDigest}</span>
                    <CopyButton text={exportInfo.bundleDigest} id="bundle-digest" copied={copied} onCopy={copy} label="Copy the bundle digest" />
                  </div>
                  <p className="muted small" style={{ margin: 0 }}>The download also starts automatically as <span className="mono">re-evidence-{revision}.json</span>.</p>
                </>
              )}
            </section>
            <section className="re-bcard" aria-label="Import">
              <h3>Import</h3>
              <div className={`re-drop${dragOver ? " over" : ""}`} role="button" tabIndex={0}
                aria-label="Drop a bundle file here, or press Enter to choose a file"
                onClick={() => fileInput.current?.click()}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.current?.click(); } }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); takeFile(e.dataTransfer.files?.[0]); }}>
                <strong>Drop a bundle file here</strong><br />
                <span className="small">or click to choose a file</span>
              </div>
              <input ref={fileInput} type="file" accept="application/json,.json" hidden aria-hidden="true"
                onChange={() => { takeFile(fileInput.current?.files?.[0]); if (fileInput.current) fileInput.current.value = ""; }} />
              <label htmlFor="re-import-text" className="small">Or paste a bundle:</label>
              <textarea id="re-import-text" className="mono" rows={5} value={importText} onChange={(e) => setImportText(e.target.value)}
                placeholder='{"version":"re-evidence-bundle.v1","revision":"…","records":[…],"unknowns":[…],"digest":"…"}' />
              <div>
                <button onClick={() => runImport(importText)} disabled={!importText.trim()}>Import pasted JSON</button>
              </div>
            </section>
          </div>
          <section aria-label="What an import verifies" style={{ marginTop: 12 }}>
            <h3 className="small" style={{ margin: "0 0 4px" }}>What an import verifies before anything is stored</h3>
            <ol className="re-steps">
              <li><strong>Every record id is recomputed</strong> from the record's content — a record edited after signing is refused with the offending id.</li>
              <li><strong>The bundle digest is recomputed</strong> over the members' identities and compared with the digest the exporter wrote.</li>
              <li><strong>Revision binding</strong> — the bundle names the revision it describes; a bundle for another revision is refused rather than re-attributed.</li>
              <li><strong>Idempotence</strong> — importing the same bundle twice stores the same rows; evidence ids are content addresses, so re-import is a no-op, not a duplicate.</li>
            </ol>
          </section>
        </div>
      )}
    </Modal>
  );
}

