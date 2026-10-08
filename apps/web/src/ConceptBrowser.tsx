import { useCallback, useEffect, useMemo, useState } from "react";
import type { Claim, ConceptCard, ConceptStore, JobView, VerdictKind } from "@cie/schema";
import { call } from "./api.ts";
import { ClaimCard } from "./ClaimCard.tsx";
import { Loading } from "./Skeleton.tsx";
import { Modal } from "./Modal.tsx";
import { VERSIONING_HELP, conceptExtractions, versionInfos } from "./concept-status.ts";

interface Props { revision?: string; jobs?: JobView[]; onShowJobs?: () => void; onClose: () => void; onAsk: (card: ConceptCard) => void; onVerdict: (claim: Claim, v: VerdictKind, text: string) => Promise<string | null> }

export function ConceptBrowser({ revision, jobs = [], onShowJobs, onClose, onAsk, onVerdict }: Props) {
  const [store, setStore] = useState<ConceptStore | null>(null);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [kind, setKind] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (v?: number) => {
    const r = await call<ConceptStore>("C11", "conceptStore", { revision, version: v });
    if (r.ok) { setStore(r.value); setError(null); } else setError(r.error.message);
  }, [revision]);
  useEffect(() => { void load(version); }, [load, version]);

  const kinds = useMemo(() => ["all", ...new Set((store?.cards ?? []).map((c) => c.kind))], [store]);
  const cards = (store?.cards ?? []).filter((c) => kind === "all" || c.kind === kind);
  const versions = useMemo(() => versionInfos(store), [store]);
  const selected = versions.find((v) => v.version === store?.version);
  const extractions = conceptExtractions(jobs, revision);
  const active = extractions.filter((j) => j.state === "QUEUED" || j.state === "RUNNING");
  const failed = extractions.filter((j) => j.failed);
  const latest = store?.versions[0]?.version;
  const verdict = async (c: Claim, v: VerdictKind, t: string) => { const e = await onVerdict(c, v, t); if (!e) await load(version); return e; };

  return (
    <Modal title="Concept cards" onClose={onClose} className="wide"
      actions={<><span className="muted small">{selected ? `This version: ${selected.provider} — ${selected.badge}.` : ""}</span><button onClick={onClose}>Done</button></>}>
        {store && <p className="muted small" style={{margin: "0 0 6px"}}>version {store.version}{store.version === latest ? " (current)" : ""} {selected && <span className={`chip ${selected.deterministic ? "warn" : ""}`} title={selected.provider}>{selected.badge}</span>}</p>}
        {error && <div className="banner error" role="alert">{error}</div>}
        {(active.length > 0 || failed.length > 0) && (
          <div className="banner" role="status" aria-label="Concept extraction status">
            {active.map((j) => <p key={j.id} className="small">{j.detail}{j.state === "QUEUED" ? " (waiting for the running job)" : ""}</p>)}
            {failed.map((j) => <p key={j.id} className="small">{j.interrupted ? "Extraction interrupted by a restart; nothing from that run was saved." : `Extraction failed: ${j.progress}.`}</p>)}
            {onShowJobs && <button className="link small" onClick={onShowJobs}>See background work</button>}
          </div>
        )}
        {store && store.versions.length === 0 && <p className="muted">No cards yet. Use “Extract concepts” first.</p>}
        <Loading pending={store === null && !error} label="Loading concept cards" rows={4} lines={2} />
        {store && store.versions.length > 0 && (
          <>
            <div className="row wrap">
              <label>Version <select value={store.version} onChange={(e) => setVersion(Number(e.target.value))}>{versions.map((v) => <option key={v.version} value={v.version}>v{v.version} · {v.cards} cards · {v.createdAt.slice(0, 16).replace("T", " ")} · {v.provider}{v.deterministic ? " (not model-read)" : ""}</option>)}</select></label>
              <label>Kind <select value={kind} onChange={(e) => setKind(e.target.value)}>{kinds.map((k) => <option key={k}>{k}</option>)}</select></label>
            </div>
            {store.diff && <p className="diff small">Since v{store.diff.against}: <strong>{store.diff.added.length}</strong> added{store.diff.added.length ? ` (${store.diff.added.slice(0, 3).join("; ")})` : ""}, <strong>{store.diff.removed.length}</strong> removed, <strong>{store.diff.changed.length}</strong> changed.</p>}
            <details className="calib"><summary>Does the model's stated confidence mean anything?</summary>
              <table className="gates"><tbody>{store.statedConfidence.filter((r) => r.cards > 0).map((r) => <tr key={r.level}><th scope="row">stated “{r.level}”</th><td>{r.cards} card(s)</td><td>{r.band ? `${Math.round(r.band.lower * 100)}–${Math.round(r.band.upper * 100)}% confirmed (n=${r.band.n})` : r.note}</td></tr>)}</tbody></table>
              <p className="muted small">Judge cards below; until enough are judged, the model's own confidence is shown as uncalibrated.</p>
            </details>
            <ul className="cardlist" tabIndex={0} aria-label="Concept cards">
              {cards.map((c) => {
                const claim = store.claims[c.claimId];
                return (
                  <li key={c.id} className={claim?.state === "REFUTED" ? "refuted" : ""}>
                    <div className="between"><span><span className="chip">{c.kind}</span> <strong>{c.title}</strong></span><span className="muted small">stated: {c.statedConfidence} (uncalibrated)</span></div>
                    <p>{c.summary}</p>
                    <div className="row wrap small">
                      <button className="link" onClick={() => onAsk(c)}>Ask about its {c.members.length} element(s)</button>
                      {claim && <button className="link" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>{open === c.id ? "hide checks & verdict" : "checks & verdict"}</button>}
                      {claim?.state === "REFUTED" && <span className="badge warn">Refuted — excluded from ranking</span>}
                      {claim?.state === "CONFIRMED" && <span className="badge fact">Confirmed by you</span>}
                    </div>
                    {open === c.id && claim && <ClaimCard claim={claim} onVerdict={verdict} />}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p className="muted small help">{VERSIONING_HELP}</p>
    </Modal>
  );
}
