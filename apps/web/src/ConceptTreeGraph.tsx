import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ConceptHierarchyView, EntityCode } from "@cie/schema";
import { call } from "./api.ts";
import { SOUNDNESS } from "./concept-hierarchy-view.ts";
import {
  DEFAULT_LAYOUT, PAGE, ZOOMS, buildDomainTree, buildMeaningTree, buildStructureTree, clip, conceptsOfEntity, defaultExpanded, layoutTree, matchesFor, visibleTree, zoomToFit, type PNode, type TreeKind, type TreeNode,
} from "./concept-tree.ts";

type Lens = "domain" | "structure" | "meaning";
const LENS: Record<Lens, { label: string; help: string; depth: number }> = {
  domain: { label: "Domain view", help: "Functions grouped by the words their names and paths share (merchant, ledger, fraud, ...): the broadest meaningful word first, then finer words inside big groups. This reads the code's vocabulary, not its meaning, so it can only find domains the code names. Plumbing words (service, handler, get, ...) are ignored.", depth: 1 },
  structure: { label: "Where it lives", help: "The code's own containment: repository, package, module, class, function. Concepts are counted at each level; the function is the piece of code.", depth: 2 },
  meaning: { label: "What it does", help: "Shape families, the shapes composed from them, the concepts, then the functions that show them. Concepts are not related to each other beyond this.", depth: 1 },
};
/** What each kind of node is called in the legend and in its own text, so colour is never the only cue. */
const KIND_WORD: Record<TreeKind, string> = { domain: "domain", root: "all", repo: "repository", package: "package", module: "module", class: "class", function: "code", family: "shape family", variant: "composed shape", concept: "concept", more: "more" };
const LEGEND: TreeKind[] = ["domain", "repo", "package", "module", "class", "family", "variant", "concept", "function"];
interface Props { revision: string; view: ConceptHierarchyView; onAsk: (pin: { title: string; ids: string[] }) => void }

export function ConceptTreeGraph({ revision, view, onAsk }: Props) {
  const [lens, setLens] = useState<Lens>("domain");
  const [onlyWith, setOnlyWith] = useState(true);
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(2);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [limits, setLimits] = useState<Map<string, number>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  // The node the user last acted on stays in view: a parent of many children sits far down the drawing, so opening it would otherwise lose it.
  const [focusId, setFocusId] = useState<string | null>(null);
  const [code, setCode] = useState<{ id: string; value?: EntityCode; error?: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const root = useMemo<TreeNode | null>(() => (lens === "domain" ? buildDomainTree(view, { onlyWithConcepts: onlyWith }) : lens === "structure" ? buildStructureTree(view, { onlyWithConcepts: onlyWith }) : buildMeaningTree(view)), [view, lens, onlyWith]);
  // A different tree starts at its top again; the user's own opening and closing is kept while they stay on one tree.
  useEffect(() => {
    const start = root ? defaultExpanded(root, LENS[lens].depth) : new Set<string>();
    setExpanded(start); setLimits(new Map()); setSelected(null); setCode(null); setFocusId(root?.id ?? null);
    // First picture: as large as still fits, so the top of the tree is seen whole.
    if (root && scroller.current) setZoom(zoomToFit(layoutTree(visibleTree(root, start)).width, scroller.current.clientWidth - 8));
  }, [root, lens]);
  const fit = () => { if (layout && scroller.current) setZoom(zoomToFit(layout.width, scroller.current.clientWidth - 8)); };
  const found = useMemo(() => (root ? matchesFor(root, query) : { open: new Set<string>(), matches: new Set<string>() }), [root, query]);
  const open = useMemo(() => new Set([...expanded, ...found.open]), [expanded, found]);
  const layout = useMemo(() => (root ? layoutTree(visibleTree(root, open, limits)) : null), [root, open, limits]);

  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pick = async (p: PNode) => {
    const n = p.v.node;
    setFocusId(p.v.moreFor ?? n.id);
    if (p.v.moreFor) { setLimits((m) => new Map(m).set(p.v.moreFor!, (m.get(p.v.moreFor!) ?? PAGE) + PAGE)); return; }
    if (p.v.expandable) toggle(n.id);
    setSelected(n.id);
    if (n.kind === "function" && n.entityId) {
      setCode({ id: n.id });
      const r = await call<EntityCode>("C11", "conceptCode", { revision, entityId: n.entityId });
      setCode((c) => (c && c.id === n.id ? (r.ok ? { id: n.id, value: r.value } : { id: n.id, error: r.error.message }) : c));
    }
  };
  const onKey = (e: KeyboardEvent, p: PNode) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void pick(p); } };
  const scale = ZOOMS[zoom];
  useEffect(() => {
    const el = scroller.current, p = focusId && layout?.nodes.find((x) => x.v.id === focusId);
    if (!el || !p) return;
    el.scrollTo({ top: Math.max(0, (p.y + DEFAULT_LAYOUT.nodeH / 2) * scale - el.clientHeight / 2), left: Math.max(0, p.x * scale - 40) });
  }, [focusId, layout, scale]);
  const selectedNode = layout?.nodes.find((p) => p.v.id === selected)?.v.node ?? null;
  const here = selectedNode?.entityId ? conceptsOfEntity(view, selectedNode.entityId) : [];

  return (
    <div className="tree-tab">
      <div className="row wrap tree-bar">
        <div className="segmented" role="radiogroup" aria-label="Which tree">
          {(Object.keys(LENS) as Lens[]).map((l) => <button key={l} type="button" role="radio" aria-checked={lens === l} className={lens === l ? "on" : ""} title={LENS[l].help} onClick={() => setLens(l)}>{LENS[l].label}</button>)}
        </div>
        <label>Find <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="name, shape or file" /></label>
        {lens !== "meaning" && <label className="inline"><input type="checkbox" checked={onlyWith} onChange={(e) => setOnlyWith(e.target.checked)} /> only code with concepts</label>}
        <span className="grow" />
        <button className="secondary" onClick={() => root && setExpanded(defaultExpanded(root, 1))}>Collapse</button>
        <button className="secondary" onClick={() => root && setExpanded(defaultExpanded(root, LENS[lens].depth + 1))}>Open one more level</button>
        <button className="secondary" onClick={fit} title="Zoom so the whole width of what is open fits">Fit</button>
        <button className="secondary" aria-label="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>−</button>
        <span className="muted small" aria-live="polite">{Math.round(scale * 100)}%</span>
        <button className="secondary" aria-label="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}>+</button>
      </div>
      <p className="muted small">{LENS[lens].help}{query && ` ${found.matches.size ? `${found.matches.size} match(es) opened.` : "No match."}`}</p>
      <div className="tree-split">
        <div className="tree-scroll" ref={scroller} tabIndex={0} aria-label="Concept tree, scrollable">
          {!layout && <p className="muted">{lens === "meaning" ? "No concepts to draw." : "No code with concepts to draw."}</p>}
          {layout && (
            <svg width={layout.width * scale} height={layout.height * scale} viewBox={`0 0 ${layout.width} ${layout.height}`} role="tree" aria-label={LENS[lens].label}>
              <g aria-hidden="true">{layout.links.map((l) => <path key={l.id} d={l.d} className="tlink" />)}</g>
              {layout.nodes.map((p) => {
                const n = p.v.node, isMore = n.kind === "more", leafCode = n.kind === "function";
                const cls = ["tnode", `k-${n.kind}`, selected === n.id ? "sel" : "", found.matches.has(n.id) ? "hit" : "", p.v.expandable ? "branch" : "leaf"].filter(Boolean).join(" ");
                return (
                  <g key={p.v.id} role="treeitem" aria-level={p.v.depth + 1} aria-expanded={p.v.expandable ? p.v.expanded : undefined} aria-selected={selected === n.id} tabIndex={0} className={cls} transform={`translate(${p.x},${p.y})`}
                    aria-label={isMore ? `${n.label}, press to show the next page` : `${KIND_WORD[n.kind]} ${n.label}, ${n.sub}${n.count && !leafCode ? `, ${n.count} concept(s)` : ""}`} onClick={() => void pick(p)} onKeyDown={(e) => onKey(e, p)}>
                    <title>{`${n.label} — ${n.sub}`}</title>
                    <rect width={DEFAULT_LAYOUT.nodeW} height={DEFAULT_LAYOUT.nodeH} rx={7} />
                    <text x={10} y={15} className="tl">{p.v.expandable ? (p.v.expanded ? "▾ " : "▸ ") : leafCode ? "{ } " : ""}{clip(n.label, 33)}</text>
                    <text x={10} y={29} className="ts">{clip(n.sub, 46)}</text>
                    {!isMore && !leafCode && n.count > 0 && <text x={DEFAULT_LAYOUT.nodeW - 8} y={15} textAnchor="end" className="tc">{n.count}</text>}
                  </g>
                );
              })}
            </svg>
          )}
        </div>
        <aside className="codepane" aria-label="Selected code" aria-live="polite">
          {!selectedNode && <p className="muted small">Select a node. Branches open; a function ({"{ }"}) shows its code here.</p>}
          {selectedNode && selectedNode.kind !== "function" && (
            <>
              <h3 className="small">{selectedNode.label}</h3>
              <p className="muted small">{KIND_WORD[selectedNode.kind]} · {selectedNode.sub}</p>
              {selectedNode.badges.length > 0 && <p className="small">{selectedNode.badges.slice(0, 8).map((b) => <span key={b.kind} className="chip">{b.kind} {b.count}</span>)}</p>}
            </>
          )}
          {selectedNode?.kind === "function" && (
            <>
              <h3 className="small">{selectedNode.label}</h3>
              {code?.id === selectedNode.id && !code.value && !code.error && <p className="muted small">Loading the code…</p>}
              {code?.error && <p className="banner error" role="alert">{code.error}</p>}
              {code?.value && <CodeBlock c={code.value} />}
              {here.length > 0 && <p className="small">Part of: {here.map((c) => <span key={c.id} className="chip" title={`${SOUNDNESS[c.soundness.tier].label}: ${SOUNDNESS[c.soundness.tier].help}`}>{c.kind}</span>)}</p>}
              {selectedNode.entityId && <div className="row small"><button className="link" onClick={() => onAsk({ title: selectedNode.label, ids: [selectedNode.entityId!] })}>Ask about this code</button></div>}
            </>
          )}
        </aside>
      </div>
      <p className="muted small tree-legend" aria-label="Legend">{LEGEND.map((k) => <span key={k} className={`tkey k-${k}`}>{KIND_WORD[k]}</span>)} <span className="muted">· the number on a node is how many concepts are at or below it</span></p>
    </div>
  );
}

function CodeBlock({ c }: { c: EntityCode }) {
  if (c.state === "WITHHELD") return <p className="muted small">This file is not shown to you.</p>;
  if (c.state === "UNAVAILABLE") return <p className="muted small">The source is not available on this machine.</p>;
  const lines = c.text.split("\n");
  return (
    <>
      <p className="muted small mono">{c.file}:{c.startLine}–{c.endLine}{c.state === "STALE" ? " · changed since it was indexed; lines may have moved" : ""}</p>
      <pre className="code" tabIndex={0} aria-label={`Source of ${c.name}`}>{lines.map((l, i) => <div key={i}><span className="ln">{c.startLine + i}</span>{l || " "}</div>)}</pre>
      {c.truncated && <p className="muted small">Cut at {lines.length} lines; the function is longer.</p>}
    </>
  );
}
