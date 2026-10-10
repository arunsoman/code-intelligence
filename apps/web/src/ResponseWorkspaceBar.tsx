import { useState } from "react";
import type { ResponseWorkspace, WorkspaceTab } from "./response-workspace.ts";

export function ResponseWorkspaceBar(p: {
  workspace: ResponseWorkspace; pending: boolean; canBack: boolean;
  onSelect: (id: string) => void; onClose: (id: string) => void; onBack: () => void;
  onGenerate: () => void; onCancel: () => void; onExport: () => void;
  onRelate: (tab: WorkspaceTab) => void;
}) {
  const [more, setMore] = useState(false);
  const [all, setAll] = useState(false);
  const tabs = p.workspace.tabs.filter((t) => t.open);
  const active = p.workspace.tabs.find((t) => t.id === p.workspace.activeId);
  const candidates = p.workspace.tabs.filter((t) => (all || t.relevant) && !t.open);
  const groups = [...new Set(candidates.map((t) => t.concern))];
  const navigate = (event: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    let index = tabs.findIndex((t) => t.id === id);
    if (event.key === "ArrowRight") index = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = tabs.length - 1;
    else return;
    event.preventDefault(); p.onSelect(tabs[index]!.id);
    requestAnimationFrame(() => document.getElementById(`tab-${tabs[index]!.id}`)?.focus());
  };
  return <section className="response-workspace-bar" aria-label="Response views">
    <div className="response-scope"><button className="secondary small" disabled={!p.canBack} onClick={p.onBack}>Back</button>
      <strong>{p.workspace.manifest.question}</strong><span className="muted small">Revision {p.workspace.manifest.revision.slice(0, 12)}</span>
    </div>
    {p.workspace.manifest.plan && <p className="response-view-purpose"><strong>Perspective:</strong> {p.workspace.manifest.plan.concerns.join(" · ")} <span className="muted small">{p.workspace.manifest.plan.scope === "subject" ? `Subject: ${p.workspace.manifest.plan.subject ?? "selected sources"}` : "Repository"} · {p.workspace.manifest.plan.evidenceStatus === "checked" ? "Indexed-source preflight checked" : "Evidence preflight pending"}</span></p>}
    <div className="response-tabs" role="tablist" aria-label="Charts for this response">
      {tabs.map((tab) => <div className="response-tab" key={tab.id}>
        <button id={`tab-${tab.id}`} type="button" role="tab" aria-selected={tab.id === p.workspace.activeId}
          aria-controls="response-view-panel" tabIndex={tab.id === p.workspace.activeId ? 0 : -1}
          data-status={tab.status} onKeyDown={(e) => navigate(e, tab.id)} onClick={() => p.onSelect(tab.id)} title={tab.reason}>
          {tab.label}<span className="tab-status">{tab.status === "ready" ? "" : tab.status === "available" ? "On demand" : tab.status}</span>
        </button>
        <button className="tab-close" aria-label={`Close ${tab.label}`} disabled={tabs.length === 1} onClick={() => { p.onClose(tab.id); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.response-tabs [aria-selected="true"]')?.focus()); }}>×</button>
      </div>)}
    </div>
    <div className="response-view-tools">
      <button className="secondary small" aria-expanded={more} onClick={() => { setAll(false); setMore(!more); }}>More views ({candidates.length})</button>
      <button className="secondary small" onClick={() => { setAll(true); setMore(true); }}>All views</button>
      <button className="secondary small" disabled={p.pending} onClick={p.onGenerate}>Generate supporting views</button>
      {p.pending && <button className="secondary small" onClick={p.onCancel}>Cancel generation</button>}
      <button className="secondary small" onClick={p.onExport}>Export response</button>
      {active?.view && <button className="secondary small" onClick={() => p.onRelate(active)}>Highlight response evidence</button>}
    </div>
    {more && <div className="response-more" aria-label="Related chart choices">
      {groups.map((group) => <div key={group}><strong>{group}</strong>{candidates.filter((t) => t.concern === group).map((tab) =>
        <button key={tab.id} disabled={tab.status === "unavailable"} title={tab.reason} onClick={() => { p.onSelect(tab.id); setMore(false); }}>
          {tab.label}<span>{tab.status === "unavailable" ? tab.reason : tab.reason ?? `Another perspective on ${p.workspace.manifest.question}`}</span>
        </button>)}</div>)}
      {!candidates.length && <p>All relevant choices are already in the tab strip.</p>}
    </div>}
    {active && <p className="response-view-purpose"><strong>This view explains:</strong> {active.questionAnswered}</p>}
  </section>;
}
