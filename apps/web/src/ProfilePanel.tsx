import { useEffect, useRef, useState } from "react";
import { call } from "./api.ts";

/**
 * "Profiles" panel (F05, §12.4). Import a profile (V8 .cpuprofile or folded stacks), watch the artifacts with their
 * windows and sample kinds, read hotspots per kind (never mixed — A3), correlate the artifact to a recorded trace
 * window (window-overlap wording, D8), compare two artifacts under the error-population gate (A6), and render the
 * compiled metric table where only verified items are drawn and a rejected one becomes an explicit placeholder (A5).
 */
type ArtifactView = {
  artifactHash: string; format: string; service: string | null; instance: string | null;
  startNs: number; endNs: number; ingestState: string; sampleCount: number;
  sampleKinds: string[]; unit: string | null; dropped: number | "NOT_REPORTED" | null;
  coverage: { collectionRatio: number } | null; diagnostics: { code: string; message: string }[];
};
type HotspotRow = {
  rank: number; functionKey: string; name: string; file: string | null; line: number | null;
  selfValue: number; totalValue: number; selfShare: number; totalShare: number; sampleCount: number;
  uncertaintyLow: number | null; uncertaintyHigh: number | null; entityId: string | null; attribution: string;
};
type HotspotAnswer = {
  rows: HotspotRow[]; unit: string; sampleCount: number; populationHash: string; grade: string; nextCursor?: string;
  coverage: { collectionRatio: number; droppedSamples: number | "NOT_REPORTED"; truncatedStacks: number; unattributedShare: number; prunedShare: number };
  uncertainty: { method?: string; tooFewSamples?: string };
};
type Link = { traceId: string | null; spanId: string | null; grade: string; overlapMs: number; reason: string };
type Correlation = { links: Link[]; build: { revision?: string | null; state: string }; populationHash: string; coverage: { collectionRatio: number; droppedSamples: number | "NOT_REPORTED" } };
type EndpointRow = { traceSourceId: string; service: string | null; windowFromMs: number; windowToMs: number; requests: number; errors: number; p50Ms: number | null; p95Ms: number | null; disclosure: string };
type CompareAnswer = { verdict: string; reasons: string[]; limitations: string[]; rows: { name: string; baseValue: number; candValue: number; baseShare: number; candShare: number; shareChange: number }[] };
type MetricItem = { itemId: string; locator: string; templateId: string; value: number; unit: string; artifactHash: string | null; caveatIds?: string[] };
type Manifest = { manifestHash: string; items: MetricItem[]; checks: { itemId: string; verdict: string; reasons: string[] }[] };
type Compiled = { viewSpec: { kind: string; title: string; captions: string[]; rows?: HotspotRow[]; populationHash?: string }; presentationManifest: Manifest };

const pct = (x: number | null | undefined) => x == null ? "?" : `${(x * 100).toFixed(1)}%`;
const fin = (n: never[] | number | null | undefined): number => (typeof n === "number" && Number.isFinite(n)) ? n : 0;
const kindChip = (k: string) => (/CPU|WALL/.test(k) ? "chip" : k === "OTHER" ? "chip muted" : "chip fact");

export function ProfilePanel({ revision, onClose }: { revision: string | null; onClose: () => void }) {
  const [path, setPath] = useState("");
  const [serviceHint, setServiceHint] = useState("");
  const [revisionHint, setRevisionHint] = useState("");
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState("CPU");
  const [hot, setHot] = useState<HotspotAnswer | null>(null);
  const [traceSourceId, setTraceSourceId] = useState("");
  const [traceId, setTraceId] = useState("");
  const [corr, setCorr] = useState<Correlation | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointRow[] | null>(null);
  const [baseHash, setBaseHash] = useState(""); const [candHash, setCandHash] = useState("");
  const [compare, setCompare] = useState<CompareAnswer | null>(null);
  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = ""; }; }, []);

  const list = async () => {
    const r = await call<{ artifacts: ArtifactView[] }>("C04", "listProfileArtifacts", {});
    if (live.current && r.ok) { const a = (r.value).artifacts; setArtifacts(a); if (!selected && a.length) setSelected(a[0].artifactHash); }
  };
  useEffect(() => { void list(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const wrap = async (fn: () => Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>, next?: (v: unknown) => void) => {
    setBusy(true); setError(null); setNotice(null);
    const r = await fn();
    setBusy(false);
    if (!live.current) return;
    if (!r.ok) { setError(r.error?.message ?? "failed"); return; }
    next?.(r.value);
  };

  const ingest = async () => {
    if (!path) return;
    await wrap(async () => call<unknown>("C04", "ingestProfile", { path, ...(serviceHint ? { serviceHint } : {}), ...(revisionHint ? { revisionHint } : {}) }), async () => {
      setNotice(`imported ${path.split(/[\\/]/).pop() ?? "profile"}; aggregates persisted, raw samples stay in the file`);
      setPath("");
      await list();
    });
  };
  const loadHotspots = (hash = selected, k = kind) => {
    if (!hash) return;
    return wrap(async () => call<HotspotAnswer>("C26", "queryHotspots", { artifactHash: hash, ordinal: undefined, limit: 50 }), (v) => setHot(v as HotspotAnswer));
  };
  useEffect(() => { if (selected) void loadHotspots(selected, kind); }, [selected, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const correlate = () => {
    if (!selected) return;
    const a = artifacts.find((x) => x.artifactHash === selected)!;
    const from = Math.round(a.startNs / 1e6), to = Math.round(a.endNs / 1e6);
    return wrap(async () => call<Correlation>("C24", "correlateProfile", { artifactHash: selected, traceSourceId, traceId: traceId || undefined, timeWindowMs: { from, to } }), (v) => setCorr(v as Correlation));
  };

  const runEndpoints = () => wrap(async () => call<{ endpoints: EndpointRow[]; sampledTraces: number; disclosure: string }>("C26", "profileEndpoints", traceSourceId ? { traceSourceId, window: {} } : { window: {} }), (v) => setEndpoints((v as { endpoints: EndpointRow[] }).endpoints));

  const runCompare = () => wrap(async () => call<CompareAnswer>("C26", "compareProfiles", { baselineArtifactHash: baseHash, candidateArtifactHash: candHash, baseline: { artifactHash: baseHash }, candidate: { artifactHash: candHash } }), (v) => setCompare(v as CompareAnswer));

  const compile = () => {
    if (!selected) return;
    return wrap(async () => call<Compiled>("C19", "compileProfileView", { artifactHash: selected, kind: "METRIC_TABLE", params: { ordinal: undefined, viewRevision: revision ?? undefined } }), (v) => setCompiled(v as Compiled));
  };

  const sel = artifacts.find((a) => a.artifactHash === selected) ?? null;
  const stateChip = (s: string) => s === "LINKED" ? "chip pass" : s === "AGGREGATED" ? "chip fact" : s === "PARTIAL" ? "chip incomplete" : s === "MISMATCH" ? "chip fail" : "chip muted";

  return (
    <div className="modal-backdrop" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="modal pr-panel" role="dialog" aria-modal="true" aria-label="Trace-linked profiles">
        <div className="modal-head">
          <h2>Trace-linked profiles</h2>
          <button className="link push" onClick={onClose} aria-label="Close the profiles panel">Close ✕</button>
        </div>

        <section aria-label="Import a profile">
          <label htmlFor="prof-path">Profile file (absolute path; V8 .cpuprofile, pprof or folded stacks)</label>
          <span className="row">
            <input id="prof-path" className="mono" style={{ flex: "1 1 24rem" }} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/isolate-001.cpuprofile" />
            <input aria-label="Service hint" style={{ width: "9rem" }} value={serviceHint} onChange={(e) => setServiceHint(e.target.value)} placeholder="service hint" />
            <input aria-label="Revision hint" style={{ width: "9rem" }} value={revisionHint} onChange={(e) => setRevisionHint(e.target.value)} placeholder="revision hint" />
            <button onClick={ingest} disabled={!path || busy}>Import</button>
            <button className="secondary" onClick={() => void list()} disabled={busy}>Refresh</button>
          </span>
        </section>

        {error && <pre className="error" role="alert">{error}</pre>}
        {notice && <p className="notice" role="status">{notice}</p>}

        <section aria-label="Stored artifacts">
          <h3>Stored artifacts</h3>
          {artifacts.length === 0 && <p className="muted small">Nothing imported yet. Import a profile collected with the profiler the project already runs (§15, step 3).</p>}
          <ul className="dirs" aria-label="Profile artifacts">
            {artifacts.map((a) => (
              <li key={a.artifactHash} style={{ cursor: "pointer" }} onClick={() => setSelected(a.artifactHash)} className={selected === a.artifactHash ? "active" : undefined}>
                <span className="mono" title={a.artifactHash}>{a.artifactHash.slice(0, 16)}</span>{" "}
                <span className={`badge ${a.ingestState === "LINKED" ? "fact" : ""}`}>{a.ingestState}</span>{" "}
                <span className={kindChip(a.sampleKinds[0] ?? "OTHER")}>{a.sampleKinds.join(" + ")}</span>{" "}
                <span className="muted small">{a.format}{a.service ? ` · ${a.service}` : ""} · {a.startNs ? new Date(a.startNs / 1e6).toISOString().slice(11, 19) : "no window"}{" → "}{a.endNs ? new Date(a.endNs / 1e6).toISOString().slice(11, 19) : ""}</span>
                {a.dropped === "NOT_REPORTED" && <span className="chip muted" title="NULL means the profiler did not drop any samples (F05-A4)">dropped: not reported</span>}
                {a.coverage && a.coverage.collectionRatio < 1 && <span className="chip warn" title="The sampler reported fewer samples than its interval predicted; absolute values may underestimate">{pct(a.coverage.collectionRatio)} collected</span>}
              </li>
            ))}
          </ul>
          {sel && (
            <p className="muted small">
              kind:{" "}
              <select aria-label="Metric kind" value={kind} onChange={(e) => setKind(e.target.value)} style={{ maxWidth: "14rem" }}>
                {(sel.sampleKinds.length ? sel.sampleKinds : ["CPU", "OTHER"]).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <em className="muted small" style={{ marginLeft: 8 }}>kinds are never summed or plotted together (F05-A3).</em>
            </p>
          )}
        </section>

        {hot && (
          <section aria-label="Hotspots">
            <h3>Hotspots <span className="chip">{hot.unit}</span> <span className="chip">{hot.grade}</span> {hot.coverage.collectionRatio < 0.9 && <span className="chip warn">coverage {pct(hot.coverage.collectionRatio)}</span>}</h3>
            {hot.uncertainty.tooFewSamples && <p className="muted small">{hot.uncertainty.tooFewSamples}</p>}
            {hot.nextCursor && <p className="muted small">older pages exist; ask the next cursor {hot.nextCursor.slice(0, 12)}… (keyset, by self value)</p>}
            <table className="matrix" aria-label="Hotspot rows"><tbody>
              {hot.rows.map((r) => (
                <tr key={rowKey(r)} style={{ background: r.functionKey === "__withheld__" ? "var(--fog)" : undefined }}>
                  <td className="mono">{r.rank}</td>
                  <td>{r.functionKey === "__withheld__" ? "(withheld)" : r.functionKey === "__unattributed__" ? "(unattributed frames)" : r.name || r.functionKey}</td>
                  <td className="mono muted small">{r.file && rof(r.file, r.line, r.attribution)}{!r.file && r.attribution === "CODE_LOCATION_OTHER_REVISION" ? "other revision" : ""}</td>
                  <td style={{ textAlign: "right" }}>{pct(r.selfShare)}</td>
                  <td style={{ textAlign: "right" }}>{pct(r.totalShare)}</td>
                  <td className="mono muted small">{r.sampleCount}</td>
                  <td className="muted small">{r.attribution === "CODE_LOCATION_EXACT" ? "line linked" : r.attribution === "FUNCTION_NAME" ? "name only" : r.attribution}</td>
                  <td className="muted small">{r.uncertaintyLow != null ? `${pct(r.uncertaintyLow)}–${pct(r.uncertaintyHigh)}` : ""}</td>
                </tr>
              ))}
            </tbody></table>
            <p className="muted small">Coverage {pct(hot.coverage.collectionRatio)}; {hot.coverage.droppedSamples === "NOT_REPORTED" ? "dropped samples: not reported" : `${hot.coverage.droppedSamples} dropped`}{hot.coverage.truncatedStacks ? `; ${hot.coverage.truncatedStacks} stacks truncated` : ""}. Shares include unattributed frames; the table never sums kinds (F05-A3).</p>
          </section>
        )}

        <section aria-label="Correlate to a trace">
          <h3>Correlate to a trace</h3>
          <span className="row">
            <input aria-label="Trace source id" className="mono" style={{ width: "14rem" }} value={traceSourceId} onChange={(e) => setTraceSourceId(e.target.value)} placeholder="source id (e.g. orders-api)" />
            <input aria-label="Trace id" className="mono" style={{ width: "12rem" }} value={traceId} onChange={(e) => setTraceId(e.target.value)} placeholder="trace id (optional)" />
            <button onClick={correlate} disabled={!selected || !traceSourceId || busy}>Correlate</button>
            <button className="secondary" onClick={runEndpoints} disabled={busy}>Endpoint stats</button>
          </span>
          <p className="muted small">A match is declared on window overlap and service identity — the label belongs to the population, not to any single request (F05-D8). {sel?.service ? `Artifact service: ${sel.service}.` : "The artifact carries no service name; give the source and it is used as-is."}</p>
          {corr && (
            <ul aria-label="Correlation links">
              {corr.links.map((l, i) => (
                <li key={i}><span className={`badge ${l.grade === "NONE" ? "warn" : "fact"}`}>{l.grade}</span> {l.traceId ? <span className="mono">{l.traceId}</span> : null} {l.overlapMs ? `overlap ${l.overlapMs}ms` : null} <span className="muted small">{l.reason}</span></li>
              ))}
              <li className="muted small">population {corr.populationHash.slice(0, 16)}; build resolved to {corr.build?.revision ?? "unknown"} ({corr.build?.state}); coverage {Math.round((corr.coverage?.collectionRatio ?? 0) * 100)}%</li>
            </ul>
          )}
          {endpoints && endpoints.length > 0 && (
            <table className="matrix" aria-label="Endpoint statistics"><tbody>
              {endpoints.map((e) => (
                <tr key={e.traceSourceId}>
                  <td className="mono">{e.service ?? e.traceSourceId}</td>
                  <td>{e.requests} requests{e.errors ? `, ${e.errors} errored` : ""}</td>
                  <td className="mono muted small">p50 {e.p50Ms ?? "?"}ms · p95 {e.p95Ms ?? "?"}ms</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </section>

        <section aria-label="Compare two profiles">
          <h3>Compare</h3>
          <span className="row">
            <select aria-label="Baseline artifact" value={baseHash} onChange={(e) => setBaseHash(e.target.value)}><option value="">baseline…</option>{artifacts.map((a) => <option key={a.artifactHash} value={a.artifactHash}>{a.artifactHash.slice(0, 12)} {a.sampleKinds[0]}</option>)}</select>
            <select aria-label="Candidate artifact" value={candHash} onChange={(e) => setCandHash(e.target.value)}><option value="">candidate…</option>{artifacts.map((a) => <option key={a.artifactHash} value={a.artifactHash}>{a.artifactHash.slice(0, 12)} {a.sampleKinds[0]}</option>)}</select>
            <button onClick={runCompare} disabled={!baseHash || !candHash || busy}>Compare</button>
          </span>
          {compare && (
            <div>
              <p><span className={`badge ${compare.verdict === "INVALID_COMPARISON" ? "warn" : compare.verdict === "NO_DIFFERENCE" ? "fact" : "warn"}`}>{compare.verdict}</span></p>
              {(compare.reasons?.length ?? 0) > 0 && <ul className="muted small">{compare.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              {(compare.limitations?.length ?? 0) > 0 && <ul className="muted small">{compare.limitations.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              <table className="matrix" aria-label="Comparison rows"><tbody>
                {compare.rows.map((r, i) => (
                  <tr key={i}><td>{r.name}</td><td style={{ textAlign: "right" }}>{pct(r.baseShare)}</td><td style={{ textAlign: "right" }}>{pct(r.candShare)}</td><td style={{ textAlign: "right" }}>{r.shareChange >= 0 ? "+" : ""}{pct(r.shareChange)}</td></tr>
                ))}
              </tbody></table>
              <p className="muted small">Shares per 100 samples of the same sample kind; a difference observed in one window is not a proven cause (F05-D8).</p>
            </div>
          )}
        </section>

        {selected && (
          <section aria-label="Metric presentation">
            <h3>Metric wording (templates)</h3>
            <button onClick={compile} disabled={busy}>Compile metric table</button>
            {compiled && (
              <div>
                <p className="muted small">{compiled.presentationManifest.manifestHash.slice(0, 20)} — every drawn item is bound to a registered wording template and verified (F05-A5).</p>
                <ul className="dirs" aria-label="Metric items">
                  {compiled.presentationManifest.items.map((it, i) => {
                    const c = compiled.presentationManifest.checks.find((x) => x.itemId === it.itemId);
                    if (c?.verdict !== "VERIFIED") return <li key={i} className="muted">unverified {it.templateId} — {c?.reasons.join("; ") ?? "not computed"} <em>(not drawn)</em></li>;
                    return <li key={i} className="fact">{it.locator} <span className="chip">{it.unit}</span>{(it.caveatIds ?? []).map((cv) => <span key={cv} className="chip muted mono">{cv.slice(0, 24)}</span>)}</li>;
                  })}
                </ul>
              </div>
            )}
          </section>
        )}

        <div className="modal-actions">
          <span className="muted small">Aggregates persist; raw samples stay in their file. A deleted repository takes its profile links (and thus its population anchors) with it — like every other derived view. Source code is never written here.</span>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

const rowKey = (r: HotspotRow) => `${r.rank}:${r.functionKey}`;
const rof = (file: string | null, line: number | null, attribution: string) => (attribution === "CODE_LOCATION_EXACT" && line ? `${file}:${line}` : file ?? "");