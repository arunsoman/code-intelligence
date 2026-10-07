import { useEffect, useId, useRef, useState } from "react";
import type { SearchResponse, SearchHit, SearchModes, ReferenceHit } from "@cie/schema";
import { call } from "./api.ts";

/**
 * Cross-repository search panel (F01, §12). One dialog, three honest surfaces:
 *  — the answer (hits with exact positions, tier labels, and what kind of match each is),
 *  — the coverage strip (per repository text/symbol state, what stopped, what was skipped, which
 *    packages could not be resolved — counted when invisible, never named),
 *  — navigation (jump to the definition under the caret, follow references across repositories).
 * The list is a real listbox (arrow keys, aria-activedescendant); a live region announces result
 * counts for the screen reader; Escape closes and hands focus back to the opener.
 */

type ModeChoice = "AUTO" | "LITERAL" | "REGEX" | "SYMBOL";

export function SearchPanel({ repoPath, revision, onClose, onLocate }: {
  repoPath: string;
  revision?: string;
  onClose: () => void;
  onLocate?: (loc: { path: string; line: number; column: number }) => void;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ModeChoice>("AUTO");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refs, setRefs] = useState<{ references: ReferenceHit[]; gaps: string[]; unresolvedCallSites: { repositoryId: string; count: number; sampleHitIds: string[] }[]; reExportTruncated: boolean } | null>(null);
  const [refsBusy, setRefsBusy] = useState(false);
  const [refsForName, setRefsForName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const listboxId = useId();
  const liveId = useId();
  const abortRef = useRef<AbortController | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && e.target === (e.currentTarget as Document | null)?.body) onClose(); };
    return () => { openerRef.current?.focus?.(); void onKey; };
  }, []);

  const run = async (q: string = query, m: ModeChoice = mode, cursor?: string) => {
    if (!q.trim()) { setError("type something to search"); return; }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true); setError(null);
    const r = await call<SearchResponse>("C10", "search", { query: q, mode: m, revision, caseInsensitive: !caseSensitive, ...(cursor ? { cursor } : {}) }, undefined, "v1", ac.signal);
    if (!live.current || ac.signal.aborted) return;
    setBusy(false);
    if (!r.ok) { setError(r.error.message); if (r.error.code === "STALE_REVISION") void reRun; return; }
    setResponse(r.value);
    setSelected(0);
    setRefs(null); setRefsForName(null);
  };
  const reRun = async () => { await run(); };
  void reRun;

  const hit = response?.hits[selected];
  const repositoryNames = new Map<string, string>((response?.coverageByRepository ?? []).map((c) => [c.repositoryId, c.repositoryName]));

  const followRefs = async (h: SearchHit | undefined) => {
    if (!h) return;
    setRefsBusy(true);
    const r = await call<{ references: ReferenceHit[]; groups: unknown[]; coverageByRepository: unknown[]; unresolvedCallSites: { repositoryId: string; count: number; sampleHitIds: string[] }[]; reExportTruncated: boolean; gaps: string[] }>("C09", "findReferences", { repositoryId: h.repositoryId, revision: h.revision, symbolId: h.symbol?.symbolId ?? null });
    if (!live.current) return;
    setRefsBusy(false);
    if (!r.ok) { setError(r.error.message); return; }
    setRefs({ references: r.value.references, gaps: r.value.gaps, unresolvedCallSites: r.value.unresolvedCallSites, reExportTruncated: r.value.reExportTruncated });
    setRefsForName(h.symbol?.name ?? hitName(h));
  };

  const resolveHere = async (h: SearchHit) => {
    const r = await call<{ locations: { path: string; name: string; display: { line: number; column: number } }[]; gaps: string[] }>("C05", "resolveDefinition", {
      repositoryId: h.repositoryId, revision: h.revision, path: h.path,
      position: { line: h.display.line, column: h.display.column },
    });
    if (!r.ok) { setError(r.error.message); return; }
    setResults(r.value as never);
  };
  const [resolveResults, setResults] = useState<{ path: string; name: string }[] | null>(null);

  const absPath = (path: string) => `${repoPath}/${path}`;
  const hitName = (h: SearchHit) => h.symbol?.name ?? (h.matchKinds.includes("TEXT_LITERAL") ? "text" : "match");

  const move = (delta: number) => {
    if (!response || response.hits.length === 0) return;
    setSelected((i) => Math.min(response.hits.length - 1, Math.max(0, i + delta)));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  };

  const tierBadge = (t: string) => t === "PRECISE" ? "fact" : t === "RESOLVED" ? "good" : t === "HEURISTIC" ? "warn" : "bad";
  const total = response?.totals as { shown: number; matched: number | null; matchedAtLeast: number | null } | undefined;
  const matchedLabel = !total ? "" : total.matched != null ? String(total.matched) : total.matchedAtLeast != null ? `at least ${total.matchedAtLeast}` : "…";

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal search-dialog" role="dialog" aria-modal="true" aria-label="Cross-repository search" tabIndex={-1} onKeyDown={onKeyDown}>
        <h2>Search <span className="muted small" title="One answer across every visible repository, on the indexed revision of each">across repositories</span></h2>
        <div className="row">
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-describedby={liveId}
            value={query}
            placeholder={mode === "REGEX" ? "regular expression (linear engine: no lookaround, no backrefs)" : mode === "SYMBOL" ? "symbol name" : mode === "AUTO" ? "identifier, text, or a question naming code" : "text to find"}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
          />
          <select aria-label="Search mode" value={mode} onChange={(e) => setMode(e.target.value as ModeChoice)}>
            <option value="AUTO">AUTO</option>
            <option value="LITERAL">text</option>
            <option value="SYMBOL">symbol</option>
            <option value="REGEX">regex</option>
          </select>
          <button onClick={() => void run()} disabled={busy}>Search</button>
          <label className="muted small"><input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> case-sensitive</label>
        </div>
        <p className="sr" id={liveId} role="status" aria-live="polite">
          {response ? `${matchedLabel} match(es), showing ${response.hits.length}` : busy ? "searching…" : "type a query"}
        </p>
        {error && <p className="error" role="alert">{error}{revision === "" ? " — the revision is not indexed yet" : ""}</p>}
        {!response && !busy && <p className="muted">Identifiers search their symbols first, and code names inside a question (or spelt nearly right) are read as those symbols; text finds every occurrence; regex runs in the linear-time engine and names what it cannot support.</p>}

        {response?.readAs?.length ? (
          <p className="muted small" role="note">
            Read as {response.readAs.map((r, i) => <span key={i}>{i ? ", " : ""}<span className="mono">{r.name}</span>{r.how === "fuzzy" ? <> (you typed “{r.text}”)</> : null}</span>)}
          </p>
        ) : null}
        {response && (
          <div className="search-body">
            <div className="search-hits">
              <ul id={listboxId} role="listbox" aria-label="Search results" className="search-list" style={{ listStyle: "none" }}>
                {response.hits.map((h, i) => (
                  <li key={h.hitId}
                    id={`${listboxId}-o${i}`}
                    role="option" aria-selected={i === selected}
                    className={`hit ${i === selected ? "sel" : ""}`}
                    onMouseMove={() => setSelected(i)}
                    onClick={() => setSelected(i)}
                    onDoubleClick={() => h.symbol && void followRefs(h)}>
                    <span className={`badge ${tierBadge(h.tier)}`}>{h.tier}</span>
                    <span className="mono hit-where">{shortestName(repositoryNames.get(h.repositoryId) ?? h.repositoryName)}/{h.path}</span>
                    <span className="muted small">:{h.display.line}</span>
                    <span className="hit-kinds small muted">{h.matchKinds.join(" · ")}{h.inString ? " · inside string" : ""}</span>
                  </li>
                ))}
                {response.hits.length === 0 && <li className="muted">no matches in what is indexed — see coverage</li>}
              </ul>
              {response.nextCursor && <button className="secondary small" onClick={() => { void run(query, mode, response.nextCursor); }} disabled={busy}>more ({matchedLabel} so far)</button>}
              <div className="covstrip" role="group" aria-label="What this answer covered">
                <h3 className="small">coverage</h3>
                {response.coverageByRepository.map((c) => (
                  <div key={c.repositoryId} className="cov-row">
                    <span className="mono">{shortestName(c.repositoryName)}</span>
                    <span className={`badge ${c.textState === "COMPLETE" ? "good" : c.textState === "PARTIAL" ? "warn" : c.textState === "NONE" ? "muted" : "bad"}`}>{c.textState}</span>
                    <span className={`badge ${c.symbolState === "COMPLETE" ? "good" : c.symbolState === "PARTIAL" ? "warn" : "muted"}`}>{c.symbolState === "NONE" ? "no symbols" : c.symbolState}</span>
                    <span className="muted small">{c.files.indexed}/{c.files.total} files</span>
                    {c.stoppedBy && c.stoppedBy !== "NONE" && <span className="badge warn">stopped: {c.stoppedBy}</span>}
                    {(c.unresolvedPackageEdges as unknown as { length: number }).length > 0 && <span className="badge warn">{(c.unresolvedPackageEdges as unknown as unknown[]).length} unresolved package(s)</span>}
                    {c.files.skipped && <span className="muted small">{skipsLabel(c.files.skipped)}</span>}
                  </div>
                ))}
                {response.notIndexed.length > 0 && (
                  <div className="cov-row warn-row" role="list">
                    <span className="badge bad">{response.notIndexed.length} repository/repositories were not searched</span>
                    <span className="muted small">{response.notIndexed[0].reason}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="search-detail" aria-label="Selected result">
              {hit && refs === null && (
                <>
                  <h3 className="small">{hitName(hit)} <span className={`badge ${tierBadge(hit.tier)}`}>{hit.tier}</span></h3>
                  <div className={"hit-words"}>
                    {hit.symbol && <span className="mono">{hit.symbol.symbolId}</span>}
                    <span className="muted small">{hit.matchKinds.join(", ")}</span>
                    <ul className="muted small" style={{ paddingLeft: 14 }}>{hit.rationale.map((r2, i) => <li key={i}>{r2}</li>)}</ul>
                  </div>
                  <pre className="hit-line mono">{(hit.display.snippet ?? []).join("\n")}</pre>
                  <div className="row">
                    <a className="open" href={`vscode://file${absPath(hit.path)}:${hit.display.line}:${hit.display.column}`}>Open in VS Code</a>
                    <button className="link" onClick={() => onLocate?.({ path: absPath(hit.path), line: hit.display.line, column: hit.display.column })}>Show on map</button>
                    {hit.symbol && <button className="secondary small" onClick={() => void followRefs(hit)} disabled={refsBusy}>Find references</button>}
                  </div>
                  {query && hit.matchKinds.includes("TEXT_LITERAL") === false && (
                    <button className="link small" onClick={() => void resolveHere(hit)}>resolve definition at this position</button>
                  )}
                  {resolveResults && resolveResults.length > 1 && (
                    <p className="muted small" role="note">ambiguous: all candidates are listed — none is picked silently</p>
                  )}
                </>
              )}
              {refs !== null && (
                <>
                  <h3 className="small">references of “{refsForName}” <span className="muted small">{refs.references.length} direct row(s)</span></h3>
                  <ul className="hit-words refs-list" aria-label="References">
                    {refs.references.slice(0, 200).map((r2, i) => (
                      <li key={i} className="mono">
                        <a className="open" href={`vscode://file${((r2 as unknown as { absPath?: string }).absPath ?? absPath(r2.path))}:${r2.span ? 1 : 1}`}>{shortestName(repositoryNames.get(r2.repositoryId ?? "") ?? "")}/{r2.path}</a>
                        {r2.viaPackage && <span className="badge good">{r2.viaPackage}</span>}
                      </li>
                    ))}
                  </ul>
                  {refs.unresolvedCallSites.map((u, i) => <p key={i} className="muted small" role="note">{u.count} unresolved call site(s) in {shortestName(u.repositoryId || "")} are counted, not followed — bind them through package identity or a compiler index</p>)}
                  {refs.reExportTruncated && <p className="muted small" role="note">{refs.gaps.join(" ")}</p>}
                  <button className="secondary small" onClick={() => setRefs(null)}>back to hits</button>
                </>
              )}
            </div>
          </div>
        )}
        <div className="modal-actions"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

const shortestName = (s: string) => (s.includes("/") ? s.split("/").filter(Boolean).pop()! : s);
const skipsLabel = (sk: unknown) => {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(sk as Record<string, number>)) if (v > 0) parts.push(`${v} ${k}`);
  return parts.length ? parts.join(", ") : "";
};
declare global { interface Window { } }