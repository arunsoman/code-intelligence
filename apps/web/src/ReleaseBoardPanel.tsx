import { useEffect, useRef, useState } from "react";
import { call } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { InfoTip } from "./InfoTip.tsx";

type Release = { releaseId: string; name: string; tag: string };
type BoardItem = { requestId: string; stage: string; createdBy: string; issueRef?: string; candidateStatus?: string; secondApproved: boolean };
type Lens = "dev" | "qa";

const STAGE_LABEL: Record<string, string> = { DESCRIBE: "Describing", CLARIFY: "Clarifying", PLAN: "Planning", CHANGES: "Building", VALIDATE: "Validating", DELIVER: "Delivered" };

/**
 * "Release Board" (Phase 6): every feature request scoped to a release, in one place for dev and QA. A dev lens
 * shows everything; the QA lens filters to requests at VALIDATE/DELIVER and surfaces the approve action — the
 * real second-approver sign-off (C30/approveFeatureDecision), not a mockup. QA approving here is a genuinely
 * different principal acting on someone else's request; it never requires owning it (release-board.ts, deliberately
 * not gated by owned()).
 */
export function ReleaseBoardPanel({ onClose, actor, onOpenRequest, onOpenNew }: {
  onClose: () => void;
  /** Who's viewing (for the self-approval check client-side; the server enforces it regardless). */
  actor?: string;
  onOpenRequest: (requestId: string) => void;
  onOpenNew: (releaseId: string) => void;
}) {
  const [releases, setReleases] = useState<Release[]>([]);
  const [releaseId, setReleaseId] = useState<string | null>(null);
  const [items, setItems] = useState<BoardItem[]>([]);
  const [lens, setLens] = useState<Lens>("dev");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const live = useRef(true);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const loadReleases = async () => {
    const r = await call<Release[]>("C32", "listReleases", {});
    if (!live.current) return;
    if (r.ok) { setReleases(r.value); if (!releaseId && r.value.length) setReleaseId(r.value[0]!.releaseId); } else setError(r.error.message);
  };
  useEffect(() => { void loadReleases(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadItems = async (id = releaseId) => {
    if (!id) return;
    const r = await call<BoardItem[]>("C02", "listFeatureRequestsByRelease", { releaseId: id });
    if (!live.current) return;
    if (r.ok) setItems(r.value); else setError(r.error.message);
  };
  useEffect(() => { void loadItems(); }, [releaseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async (requestId: string) => {
    setBusy(requestId); setError(null); setNotice(null);
    const r = await call("C30", "approveFeatureDecision", { requestId, explanation: "reviewed on the Release Board" }, crypto.randomUUID());
    if (!live.current) return;
    setBusy(null);
    if (!r.ok) { setError(r.error.message); return; }
    setNotice(`Approved ${requestId}.`);
    await loadItems();
  };

  const visible = lens === "qa" ? items.filter((i) => i.stage === "VALIDATE" || i.stage === "DELIVER") : items;

  return (
    <Modal title="Release Board" onClose={onClose} className="wide tall" initialFocusRef={firstFieldRef}>
      <p className="muted small">
        Every feature request building toward a release, in one place.{" "}
        <InfoTip label="What is this board?">
          Dev sees everything; QA sees requests ready for review and can approve them directly here — a genuinely
          different person acting on someone else's work, not a self-approval.
        </InfoTip>
      </p>

      {error && <p className="status-warn" role="alert">{error}</p>}
      {notice && <p className="status-ok" role="status">{notice}</p>}

      <div className="form-grid" style={{ alignItems: "end" }}>
        <label className="form-field">
          <span className="form-label">Release</span>
          <select ref={firstFieldRef} value={releaseId ?? ""} onChange={(e) => setReleaseId(e.target.value || null)}>
            {releases.length === 0 && <option value="">No releases yet</option>}
            {releases.map((r) => <option key={r.releaseId} value={r.releaseId}>{r.name} ({r.tag})</option>)}
          </select>
        </label>
        <div className="chip-tabs" role="tablist" aria-label="Lens">
          <button className={lens === "dev" ? "secondary small active" : "secondary small"} aria-pressed={lens === "dev"} onClick={() => setLens("dev")}>Dev</button>
          <button className={lens === "qa" ? "secondary small active" : "secondary small"} aria-pressed={lens === "qa"} onClick={() => setLens("qa")}>QA</button>
        </div>
        <button className="secondary small" disabled={!releaseId} onClick={() => releaseId && onOpenNew(releaseId)} title="Build a new feature tagged to this release">+ Build for this release</button>
      </div>

      {visible.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state__icon" aria-hidden="true">🗂️</span>
          <p>{lens === "qa" ? "Nothing ready for QA review yet." : "No features built for this release yet."}</p>
        </div>
      ) : (
        <ul className="dirs" aria-label="Release Board items" style={{ minHeight: 120 }}>
          {visible.map((it) => (
            <li key={it.requestId}>
              <strong>{it.issueRef ?? it.requestId}</strong>{" "}
              <span className="chip">{STAGE_LABEL[it.stage] ?? it.stage}</span>{" "}
              <span className="muted small">by {it.createdBy}</span>{" "}
              {it.candidateStatus && <span className="chip muted">{it.candidateStatus.toLowerCase()}</span>}{" "}
              {it.secondApproved && <span className="chip pass">approved</span>}
              <div className="bf-btns" style={{ marginTop: 4 }}>
                <button className="secondary small" onClick={() => onOpenRequest(it.requestId)}>Open</button>
                {lens === "qa" && !it.secondApproved && actor !== it.createdBy && (
                  <button className="primary small" disabled={busy === it.requestId} aria-busy={busy === it.requestId} onClick={() => void approve(it.requestId)}>
                    {busy === it.requestId && <span className="spinner" aria-hidden="true" />}Approve
                  </button>
                )}
                {lens === "qa" && !it.secondApproved && actor === it.createdBy && (
                  <span className="muted small" title="A request's own author cannot be its second approver">can't self-approve</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
