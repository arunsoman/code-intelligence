import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConceptHierarchyView, JobView, StructuralConceptsView } from "@cie/schema";
import { call } from "./api.ts";
import { Loading } from "./Skeleton.tsx";
import { Modal } from "./Modal.tsx";
import { ConceptTreeGraph } from "./ConceptTreeGraph.tsx";
import {
  HIERARCHY_HELP, SOUNDNESS, archRows, conceptTitle, groupConcepts, hierarchyBuilds, hierarchySummary, isEmptyHierarchy, mechanicalNamesNotice, memberNames, namingBadge, namingProvenance, sortInvariants, statsNotes,
} from "./concept-hierarchy-view.ts";

interface Props {
  revision?: string;
  jobs?: JobView[];
  onShowJobs?: () => void;
  onClose: () => void;
  /** Hand a concept's code elements to the conversation, as the concept-card dialog does. */
  onAsk: (pin: { title: string; ids: string[] }) => void;
  /** Structural clusters need no "Build concept hierarchy" step, so the tabbed view must still open even when the
   * built hierarchy itself is empty — the parent already knows this (it is why the Browse button is showing). */
  hasStructuralConcepts?: boolean;
}

type Tab = "tree" | "concepts" | "structural" | "invariants" | "architecture" | "packages" | "build";
const TABS: { id: Tab; label: string }[] = [
  { id: "tree", label: "Tree" }, { id: "concepts", label: "Concepts" }, { id: "structural", label: "Duplicates & roles" }, { id: "invariants", label: "Invariants" }, { id: "architecture", label: "Architecture" },
  { id: "packages", label: "Across packages" }, { id: "build", label: "About this build" },
];
const PAGE = 100;

export function ConceptHierarchyBrowser({ revision, jobs = [], onShowJobs, onClose, onAsk, hasStructuralConcepts }: Props) {
  const [view, setView] = useState<ConceptHierarchyView | null>(null);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tree");
  const [tabDefaulted, setTabDefaulted] = useState(false);
  useEffect(() => {
    if (tabDefaulted || view === null) return;
    setTabDefaulted(true);
    if (isEmptyHierarchy(view) && hasStructuralConcepts) setTab("structural");
  }, [view, hasStructuralConcepts, tabDefaulted]);
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [structural, setStructural] = useState<StructuralConceptsView | null>(null);
  const [structuralError, setStructuralError] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== "structural" || structural) return;
    void call<StructuralConceptsView>("C11", "structuralConcepts", { revision }).then((r) => { if (r.ok) setStructural(r.value); else setStructuralError(r.error.message); });
  }, [tab, structural, revision]);
  const structuralGroups = useMemo(() => {
    const clusters = (structural?.clusters ?? []).filter((c) => !filter || (c.name ?? "").toLowerCase().includes(filter.toLowerCase()) || c.members.some((m) => m.name.toLowerCase().includes(filter.toLowerCase())));
    const byKind = new Map<string, typeof clusters>();
    for (const c of clusters) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c]);
    return [...byKind.entries()].map(([kind, list]) => ({ kind, clusters: list.sort((a, b) => b.members.length - a.members.length) }));
  }, [structural, filter]);

  const load = useCallback(async (v?: number) => {
    const r = await call<ConceptHierarchyView>("C11", "conceptHierarchy", { revision, version: v });
    if (r.ok) { setView(r.value); setError(null); } else setError(r.error.message);
  }, [revision]);
  useEffect(() => { void load(version); }, [load, version]);
  // A build that finishes while the dialog is open should appear without reopening it.
  const builds = hierarchyBuilds(jobs, revision);
  const active = builds.filter((b) => b.state === "QUEUED" || b.state === "RUNNING");
  const failed = builds.filter((b) => b.failed);
  const finished = jobs.filter((j) => j.kind === "concept-hierarchy" && j.state === "SUCCEEDED").map((j) => j.id).join(",");
  useEffect(() => { if (finished) void load(version); }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setShown(PAGE), [tab, filter, version]);

  const groups = useMemo(() => groupConcepts(view?.concepts ?? [], filter), [view, filter]);
  const invariants = useMemo(() => sortInvariants(view?.invariants ?? []), [view]);
  const rows = useMemo(() => archRows(view?.arch ?? []), [view]);
  const named = useMemo(() => new Map((view?.concepts ?? []).map((c) => [c.id, conceptTitle(c)])), [view]);
  const current = view?.versions[0]?.version;
  const selected = view?.versions.find((v) => v.version === view.version);
  const prov = selected ? namingProvenance(selected.provider) : null;
  const empty = isEmptyHierarchy(view) && !hasStructuralConcepts;

  return (
    <Modal title="Concept hierarchy" onClose={onClose} className="full"
      actions={<><span className="muted small">{selected && prov ? `This version: ${prov.known ? selected.provider : "provider not recorded"} — names: ${prov.badge}.` : ""}</span><button onClick={onClose}>Done</button></>}>
      {view && !empty && <p className="muted small" style={{margin: "0 0 6px"}}>version {view.version}{view.version === current ? " (current)" : ""} {prov && <span className={`chip ${prov.deterministic || !prov.known ? "warn" : ""}`}>names: {prov.badge}</span>}</p>}
        {error && <div className="banner error" role="alert">{error}</div>}
        {(active.length > 0 || failed.length > 0) && (
          <div className="banner" role="status" aria-label="Concept hierarchy build status">
            {active.map((b) => <p key={b.id} className="small">{b.detail}</p>)}
            {failed.map((b) => <p key={b.id} className="small">{b.interrupted ? "A build was interrupted by a restart; nothing from that run was saved." : "A build failed; nothing from that run was saved."}</p>)}
            {onShowJobs && <button className="link small" onClick={onShowJobs}>See background work</button>}
          </div>
        )}
        {view && !empty && mechanicalNamesNotice(view.stats) && <div className="banner" role="status" aria-label="How the names were made"><p className="small">{mechanicalNamesNotice(view.stats)}</p></div>}
        <Loading pending={view === null && !error} label="Loading concept hierarchy" rows={4} lines={2} />
        {view && empty && <p className="muted">Nothing built yet. Use “Build concept hierarchy” first.</p>}
        {view && !empty && (
          <>
            <p className="small">{hierarchySummary(view)}</p>
            <div className="row wrap">
              <label>Version <select value={view.version} onChange={(e) => setVersion(Number(e.target.value))}>{view.versions.map((v) => <option key={v.version} value={v.version}>v{v.version} · {v.concepts} concepts · {v.createdAt.slice(0, 16).replace("T", " ")}</option>)}</select></label>
              {(tab === "concepts" || tab === "structural") && <label>Filter <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="name, shape or function" /></label>}
            </div>
            <div className="tabs" role="tablist" aria-label="Hierarchy sections">
              {TABS.map((t) => <button key={t.id} role="tab" id={`ch-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="ch-panel" className={`tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>)}
            </div>
            <div id="ch-panel" role="tabpanel" aria-labelledby={`ch-tab-${tab}`} style={{ overflow: tab === "tree" ? "hidden" : "auto", flex: 1, minHeight: tab === "tree" ? 420 : 160, display: "flex", flexDirection: "column" }}>
              {tab === "tree" && <ConceptTreeGraph revision={view.revision} view={view} onAsk={onAsk} />}
              {tab === "concepts" && (groups.length === 0 ? <p className="muted">No concept matches “{filter}”.</p> : (
                <>
                  {groups.map((g) => (
                    <section key={g.kind} aria-label={g.kind}>
                      <h3 className="small"><span className="chip">{g.kind}</span> {g.concepts.length} concept(s)</h3>
                      <ul className="cardlist inline">
                        {g.concepts.slice(0, shown).map((c) => (
                          <li key={c.id}>
                            <div className="between"><strong>{conceptTitle(c)}</strong><span className="muted small">{namingBadge(c, prov ?? undefined)} · {c.members.length} function(s) · {SOUNDNESS[c.soundness.tier].label}</span></div>
                            <p className="small">{memberNames(c)}</p>
                            {c.compositionRule && <p className="muted small">Composed by rule: {c.compositionRule}.</p>}
                            <div className="row wrap small"><button className="link" onClick={() => onAsk({ title: conceptTitle(c), ids: c.members.slice(0, 8) })}>Ask about its {c.members.length} element(s)</button><span className="muted">{c.evidenceIds.length} evidence item(s)</span></div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                  {groups.some((g) => g.concepts.length > shown) && <button className="link small" onClick={() => setShown((n) => n + PAGE)}>Show more</button>}
                </>
              ))}
              {tab === "structural" && (
                structuralError ? <div className="banner error" role="alert">{structuralError}</div> :
                !structural ? <Loading pending rows={4} lines={2} label="Loading structural clusters" /> :
                structuralGroups.length === 0 ? <p className="muted">{filter ? `No cluster matches “${filter}”.` : "No cross-file duplicates or shared framework roles found."}</p> : (
                  <>
                    <p className="muted small">Found at index time, no model involved: the same declaration shape redeclared across files (usually generated-client duplication), and classes sharing a framework role (Spring/NestJS/Express controllers, services, guards) within one package.</p>
                    {structuralGroups.map(({ kind, clusters }) => (
                      <section key={kind} aria-label={kind}>
                        <h3 className="small"><span className="chip">{kind === "exact-shape" ? "same shape, redeclared" : "shared framework role"}</span> {clusters.length} cluster(s)</h3>
                        <ul className="cardlist inline">
                          {clusters.slice(0, shown).map((c) => (
                            <li key={c.id}>
                              <div className="between"><strong>{c.name ?? "(unnamed)"}</strong><span className="muted small">{c.members.length} element(s)</span></div>
                              <p className="small">{c.members.slice(0, 10).map((m) => m.name).join(", ")}{c.members.length > 10 ? `, and ${c.members.length - 10} more` : ""}</p>
                              <div className="row wrap small"><button className="link" onClick={() => onAsk({ title: c.name ?? "structural cluster", ids: c.members.slice(0, 8).map((m) => m.entityId) })}>Ask about its {c.members.length} element(s)</button></div>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                    {structuralGroups.some((g) => g.clusters.length > shown) && <button className="link small" onClick={() => setShown((n) => n + PAGE)}>Show more</button>}
                  </>
                )
              )}
              {tab === "invariants" && (invariants.length === 0 ? <p className="muted">No guarded values were found.</p> : (
                <ul className="cardlist inline">
                  {invariants.slice(0, shown).map((i) => (
                    <li key={i.id}>
                      <div className="between"><strong>{i.variable}</strong><span className={`chip ${i.tier === "speculative" ? "warn" : ""}`} title={SOUNDNESS[i.tier].help}>{SOUNDNESS[i.tier].label}</span></div>
                      <p className="small">{i.statement}</p>
                      <p className="muted small">In {i.subjectEntityId.replace(/^[a-z]+:/, "")} · {i.basis}{i.guardCondition ? ` · guarded by ${i.guardCondition}` : ""} · {i.evidenceIds.length} evidence item(s)</p>
                      <div className="row small"><button className="link" onClick={() => onAsk({ title: `${i.variable} in ${i.subjectEntityId.replace(/^[a-z]+:/, "")}`, ids: [i.subjectEntityId] })}>Ask about it</button></div>
                    </li>
                  ))}
                  {invariants.length > shown && <li><button className="link small" onClick={() => setShown((n) => n + PAGE)}>Show more</button></li>}
                </ul>
              ))}
              {tab === "architecture" && (rows.length === 0 ? <p className="muted">No tree was built.</p> : (
                <ul className="cardlist inline" aria-label="Containment tree">
                  {rows.slice(0, shown).map(({ node, depth }) => {
                    const linked = view.links.filter((l) => l.archNodeId === node.id).length;
                    return <li key={node.id} style={{ paddingLeft: depth * 16 }}><span className="chip">{node.kind}</span> <strong>{node.name}</strong> <span className="muted small">{node.path}{linked ? ` · ${linked} concept(s)` : ""}</span></li>;
                  })}
                  {rows.length > shown && <li><button className="link small" onClick={() => setShown((n) => n + PAGE)}>Show more</button></li>}
                </ul>
              ))}
              {tab === "packages" && (view.crossPackage.length === 0 ? <p className="muted">No concept spans more than one package.</p> : (
                <ul className="cardlist inline">
                  {view.crossPackage.map((x) => (
                    <li key={x.id}>
                      <strong>{x.label ?? "unnamed cross-package concept"}</strong>
                      <p className="small">Spans {x.packages.join(", ")}</p>
                      <p className="muted small">{x.memberConceptIds.map((id) => named.get(id) ?? id).slice(0, 5).join("; ")}{x.memberConceptIds.length > 5 ? ` and ${x.memberConceptIds.length - 5} more` : ""} · {x.evidenceIds.length} evidence item(s)</p>
                    </li>
                  ))}
                </ul>
              ))}
              {tab === "build" && (
                <>
                  <ul className="small">{statsNotes(view.stats).map((n, i) => <li key={i}>{n}</li>)}</ul>
                  {view.stats && <p className="muted small">Phases (ms): {Object.entries(view.stats.phasesMs).map(([k, v]) => `${k} ${Math.round(v)}`).join(" · ")}</p>}
                </>
              )}
            </div>
          </>
        )}
        <p className="muted small help">{HIERARCHY_HELP}</p>
    </Modal>
  );
}
