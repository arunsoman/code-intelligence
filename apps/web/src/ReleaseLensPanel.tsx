import { useEffect, useRef, useState } from "react";
import { call } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { InfoTip } from "./InfoTip.tsx";

type RowStatus = "pass" | "warn" | "blocked" | "unknown";
type ReadinessRow = { id: string; title: string; domain: string[]; status: RowStatus; kind?: "fact" | "inference"; measure: string; detail: string; source: string };
type ReleaseReadiness = { releaseId: string; releaseName: string; tag: string; overall: { tone: "ready" | "conditional" | "blocked" | "unknown"; text: string }; rows: ReadinessRow[] };
type Release = { releaseId: string; name: string; tag: string };

const LENSES: { id: string; label: string; sub: string }[] = [
  { id: "all", label: "All", sub: "Every row that feeds the go/no-go decision, worst first." },
  { id: "pm", label: "PM", sub: "What's left before the backlog for this release closes." },
  { id: "dev", label: "Dev", sub: "What a developer should confirm before handoff to QA." },
  { id: "arch", label: "Architecture", sub: "Whether what shipped matches the approved design." },
  { id: "qa", label: "QA", sub: "Test evidence for the call — not just green, but what's unasserted." },
  { id: "sec", label: "Security", sub: "Findings that could block the release, by severity." },
  { id: "ops", label: "SRE / Ops", sub: "Whether production is ready to receive this release." },
  { id: "relmgmt", label: "Release Mgmt", sub: "Certification, licensing and backlog status in one place." },
];
const STATUS_WORD: Record<RowStatus, string> = { pass: "PASS", warn: "ATTENTION", blocked: "BLOCKED", unknown: "NOT DETERMINED" };
const SEVERITY: Record<RowStatus, number> = { blocked: 0, warn: 1, unknown: 2, pass: 3 };
const LENS_LABEL: Record<string, string> = Object.fromEntries(LENSES.map((l) => [l.id, l.label]));
const TONE_CLASS: Record<ReleaseReadiness["overall"]["tone"], string> = { blocked: "status-warn", conditional: "status-warn", ready: "status-ok", unknown: "muted" };

/**
 * "Release Lens" (Phase 6, C32/getReleaseReadiness): one evidence ledger, viewed through a stakeholder lens.
 * Switching the lens only reorders which rows come forward; the underlying rows and the overall tone never change
 * per lens — the same rule the published mockup demonstrated. A row this system cannot determine reads "not
 * determined", never a guessed pass.
 */
export function ReleaseLensPanel({ onClose, releaseId: initialReleaseId, onOpenScope }: { onClose: () => void; releaseId?: string; onOpenScope?: () => void }) {
  const [releases, setReleases] = useState<Release[]>([]);
  const [releaseId, setReleaseId] = useState<string | null>(initialReleaseId ?? null);
  const [revisionId, setRevisionId] = useState("");
  const [data, setData] = useState<ReleaseReadiness | null>(null);
  const [lens, setLens] = useState("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = useRef(true);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  useEffect(() => {
    void (async () => {
      const r = await call<Release[]>("C32", "listReleases", {});
      if (!live.current) return;
      if (r.ok) { setReleases(r.value); if (!releaseId && r.value.length) setReleaseId(r.value[0]!.releaseId); } else setError(r.error.message);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    if (!releaseId) return;
    setBusy(true); setError(null);
    const r = await call<ReleaseReadiness>("C32", "getReleaseReadiness", { releaseId, revisionId: revisionId || undefined });
    if (!live.current) return;
    setBusy(false);
    if (r.ok) setData(r.value); else setError(r.error.message);
  };
  useEffect(() => { void refresh(); }, [releaseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const current = LENSES.find((l) => l.id === lens) ?? LENSES[0]!;
  const rows = data?.rows ?? [];
  const primary = (lens === "all" ? rows : rows.filter((r) => r.domain.includes(lens))).slice().sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]);
  const secondary = lens === "all" ? [] : rows.filter((r) => !r.domain.includes(lens));

  const counts = { blocked: 0, warn: 0, unknown: 0, pass: 0 };
  for (const r of primary) counts[r.status]++;

  const row = (r: ReadinessRow, secondaryRow: boolean) => (
    <li key={r.id} className={`rl-row${secondaryRow ? " secondary" : ""}${open.has(r.id) ? " open" : ""}`} data-kind={r.kind ?? "fact"} data-status={r.status}>
      <div className="bf-head rl-head">
        <div className="rl-title">
          <strong>{r.title}</strong>
          {(!secondaryRow || open.has(r.id)) && <span className="muted small mono">{r.measure}</span>}
        </div>
        <span className={`chip ${r.status === "pass" ? "pass" : r.status === "blocked" ? "fail" : r.status === "warn" ? "incomplete" : "muted"}`} style={r.status === "unknown" ? { borderStyle: "dotted" } : undefined}>{STATUS_WORD[r.status]}</span>
      </div>
      {!secondaryRow && (
        <div className="rl-tags">
          {r.domain.map((d) => <span key={d} className={`rl-tag${d === lens ? " is-lens" : ""}`}>{LENS_LABEL[d] ?? d}</span>)}
          {r.kind === "inference" && <span className="rl-tag">inference</span>}
        </div>
      )}
      <button className="bf-ghost" onClick={() => toggle(r.id)} aria-expanded={open.has(r.id)}>{open.has(r.id) ? "Hide evidence" : "Show evidence"}</button>
      {open.has(r.id) && (
        <div className="bf-pop" role="region" aria-label="Evidence">
          <p>{r.detail}</p>
          {secondaryRow && <div className="rl-tags">{r.domain.map((d) => <span key={d} className="rl-tag">{LENS_LABEL[d] ?? d}</span>)}</div>}
          <p className="muted small">via <code>{r.source}</code></p>
        </div>
      )}
    </li>
  );

  return (
    <Modal title="Release Lens" onClose={onClose} className="wide tall" initialFocusRef={firstFieldRef}>
      <p className="muted small">
        <strong>One evidence set, {rows.length || "twelve"} checks.</strong> Every lens reads the same ledger — nothing is duplicated or re-run per role.{" "}
        <InfoTip label="What is a lens?">Switching the lens only reorders which rows come forward — it never recomputes them differently per role.</InfoTip>
      </p>
      {error && <p className="status-warn" role="alert">{error}</p>}

      <div className="form-grid" style={{ alignItems: "end" }}>
        <label className="form-field">
          <span className="form-label">Release</span>
          <select ref={firstFieldRef} value={releaseId ?? ""} onChange={(e) => setReleaseId(e.target.value || null)}>
            {releases.length === 0 && <option value="">No releases yet</option>}
            {releases.map((r) => <option key={r.releaseId} value={r.releaseId}>{r.name} ({r.tag})</option>)}
          </select>
        </label>
        <label className="form-field">
          <span className="form-label">Indexed revision <span className="optional">(optional)</span></span>
          <input value={revisionId} onChange={(e) => setRevisionId(e.target.value)} onBlur={() => void refresh()} placeholder="unlocks security/license/ops rows" />
        </label>
      </div>

      {data && (
        <div className={`rl-topbar ${data.overall.tone}`} role="status">
          <div><span className="rl-eyebrow">cie · release sign-off</span><strong>{data.releaseName} ({data.tag}) — evidence ledger</strong></div>
          <div className="rl-topbar-right">
            {onOpenScope && <button className="secondary small" onClick={onOpenScope}>← Release scope</button>}
            <span className={`rl-overall ${data.overall.tone}`}><span className="rw-dot" aria-hidden="true" />{data.overall.text}</span>
          </div>
        </div>
      )}
      {busy && <p className="muted small" role="status">Loading…</p>}

      <div className="chip-tabs" role="tablist" aria-label="Stakeholder lens" style={{ flexWrap: "wrap" }}>
        {LENSES.map((l) => (
          <button key={l.id} role="tab" aria-selected={l.id === lens} className={l.id === lens ? "secondary small active" : "secondary small"} onClick={() => setLens(l.id)}>{l.label}</button>
        ))}
      </div>
      <h3 className="rl-lens-title">{lens === "all" ? "Every check" : `${current.label} view`}</h3>
      <p className="muted small">{current.sub}</p>
      <p className="rl-stats muted small mono">
        <span><b>{primary.length}</b> checks in this view</span>
        {counts.blocked > 0 && <span><b>{counts.blocked}</b> blocked</span>}
        {counts.warn > 0 && <span><b>{counts.warn}</b> need attention</span>}
        {counts.unknown > 0 && <span><b>{counts.unknown}</b> not determined</span>}
        <span><b>{counts.pass}</b> passed</span>
      </p>

      <ul className="dirs" aria-label="Evidence rows" style={{ minHeight: 120 }}>
        {primary.map((r) => row(r, false))}
      </ul>

      {secondary.length > 0 && (
        <details open>
          <summary className="muted small">Also in the ledger — not primary for this view ({secondary.length})</summary>
          <ul className="dirs" aria-label="Other evidence rows">
            {secondary.map((r) => row(r, true))}
          </ul>
        </details>
      )}
    </Modal>
  );
}
