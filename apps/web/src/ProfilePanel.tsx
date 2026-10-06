import { useEffect, useRef, useState } from "react";
import { call } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { FormField } from "./FormField.tsx";
import { InfoTip } from "./InfoTip.tsx";

/**
 * "Profiles" panel (F05). Import a profile (V8 .cpuprofile or folded stacks), watch the artifacts with their
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

  const canCorrelate = !!selected && !!traceSourceId;
  const canCompare = artifacts.length >= 2 && !!baseHash && !!candHash;

  return (
    <Modal title="Trace-linked profiles" onClose={onClose} className="wide tall">
      <section aria-label="Import a profile">
        <h3>Import a profile</h3>
        <div className="form-grid wide">
          <FormField
            label="Profile file path"
            htmlFor="prof-path"
            required
            helper="Absolute path to a V8 .cpuprofile, pprof or folded-stacks file. Aggregates persist; raw samples stay in the file."
          >
            <input
              id="prof-path"
              className="mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/home/you/isolate-001.cpuprofile"
            />
          </FormField>
        </div>

        <div className="form-grid three">
          <FormField label="Service hint" htmlFor="prof-service" helper="Service name, if the file does not include one.">
            <input id="prof-service" value={serviceHint} onChange={(e) => setServiceHint(e.target.value)} placeholder="orders-api" />
          </FormField>
          <FormField label="Revision hint" htmlFor="prof-revision" helper="Commit or build label.">
            <input id="prof-revision" value={revisionHint} onChange={(e) => setRevisionHint(e.target.value)} placeholder="abc1234" />
          </FormField>
        </div>

        <div className="row gap" style={{ marginTop: 4 }}>
          <button onClick={ingest} disabled={!path || busy}>Import</button>
          <button className="secondary" onClick={() => void list()} disabled={busy}>🔄 Refresh list</button>
        </div>
      </section>

      {error && <p className="status-warn" role="alert">{error}</p>}
      {notice && <p className="status-ok" role="status">{notice}</p>}
      {busy && <p className="muted small" role="status">Working…</p>}

      <section aria-label="Stored artifacts">
        <h3>Stored artifacts</h3>
        {artifacts.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state__icon" aria-hidden="true">📈</span>
            <p>Nothing imported yet. Collect a profile from the profiler your service already runs, then import it above.</p>
          </div>
        ) : (
          <>
            <ul className="dirs" aria-label="Profile artifacts" style={{ minHeight: 120 }}>
              {artifacts.map((a) => (
                <li key={a.artifactHash} style={{ cursor: "pointer" }} onClick={() => setSelected(a.artifactHash)} className={selected === a.artifactHash ? "active" : undefined}>
                  <span className="mono" title={a.artifactHash}>{a.artifactHash.slice(0, 16)}</span>{" "}
                  <span className={`badge ${a.ingestState === "LINKED" ? "fact" : ""}`}>{a.ingestState}</span>{" "}
                  <span className={kindChip(a.sampleKinds[0] ?? "OTHER")}>{a.sampleKinds.join(" + ")}</span>{" "}
                  <span className="muted small">{a.format}{a.service ? ` · ${a.service}` : ""} · {a.startNs ? new Date(a.startNs / 1e6).toISOString().slice(11, 19) : "no window"}{" → "}{a.endNs ? new Date(a.endNs / 1e6).toISOString().slice(11, 19) : ""}</span>
                  {a.dropped === "NOT_REPORTED" && <span className="chip muted" title="NULL means the profiler did not drop any samples">dropped: not reported</span>}
                  {a.coverage && a.coverage.collectionRatio < 1 && <span className="chip warn" title="The sampler reported fewer samples than its interval predicted; absolute values may underestimate">{pct(a.coverage.collectionRatio)} collected</span>}
                </li>
              ))}
            </ul>
            {sel && (
              <p className="muted small">
                kind:{" "}
                <select aria-label="Metric kind" value={kind} onChange={(e) => setKind(e.target.value)} style={{ maxWidth: "14rem" }}>
                  {(sel.sampleKinds.length ? sel.sampleKinds : ["CPU", "OTHER"]).map((k) => <option key={k} value={k}>{k}</option>)}
                </select>{" "}
                <InfoTip label="Why only one kind?">Sample kinds are never summed or plotted together.</InfoTip>
              </p>
            )}
          </>
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
          <p className="muted small">Coverage {pct(hot.coverage.collectionRatio)}; {hot.coverage.droppedSamples === "NOT_REPORTED" ? "dropped samples: not reported" : `${hot.coverage.droppedSamples} dropped`}{hot.coverage.truncatedStacks ? `; ${hot.coverage.truncatedStacks} stacks truncated` : ""}. Shares include unattributed frames; the table never sums kinds.</p>
        </section>
      )}

      <section aria-label="Correlate to a trace">
        <h3>Correlate to a trace</h3>
        <div className="form-grid two">
          <FormField label="Trace source" htmlFor="trace-source" helper="Service name the recorded trace belongs to, e.g. orders-api.">
            <input id="trace-source" className="mono" value={traceSourceId} onChange={(e) => setTraceSourceId(e.target.value)} placeholder="orders-api" />
          </FormField>
          <FormField label="Trace ID (optional)" htmlFor="trace-id" helper="A single trace identifier, if you want to narrow the match.">
            <input id="trace-id" className="mono" value={traceId} onChange={(e) => setTraceId(e.target.value)} placeholder="abc123" />
          </FormField>
        </div>

        <div className="row gap" style={{ marginTop: 4 }}>
          <button onClick={correlate} disabled={!canCorrelate || busy}>Correlate</button>
          <button className="secondary" onClick={runEndpoints} disabled={busy}>Endpoint stats</button>
        </div>
        <p className="muted small">
          We match a profile to a trace by time window and service name. The label applies to the whole service population, not one request.{" "}
          {sel?.service ? `Artifact service: ${sel.service}.` : "The artifact carries no service name; give the source and it is used as-is."}
        </p>

        {corr && (
          <>
            <p className="status-ok" role="status">
              {corr.links.length === 0
                ? "No trace match found for the selected window."
                : corr.links.map((l, i) => (
                  <span key={i}>
                    {i > 0 && "; "}
                    Matched {traceSourceId} · {l.grade} · {l.overlapMs ? `${l.overlapMs}ms overlap` : "no overlap"}
                  </span>
                ))}
            </p>
            <ul aria-label="Correlation links">
              {corr.links.map((l, i) => (
                <li key={i}><span className={`badge ${l.grade === "NONE" ? "warn" : "fact"}`}>{l.grade}</span> {l.traceId ? <span className="mono">{l.traceId}</span> : null} {l.overlapMs ? `overlap ${l.overlapMs}ms` : null} <span className="muted small">{l.reason}</span></li>
              ))}
              <li className="muted small">population {corr.populationHash.slice(0, 16)}; build resolved to {corr.build?.revision ?? "unknown"} ({corr.build?.state}); coverage {Math.round((corr.coverage?.collectionRatio ?? 0) * 100)}%</li>
            </ul>
          </>
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

      {artifacts.length >= 2 && (
        <section aria-label="Compare two profiles">
          <h3>Compare</h3>
          <div className="form-grid two">
            <FormField label="Baseline artifact" htmlFor="base-artifact" required helper="Older or reference profile.">
              <select id="base-artifact" value={baseHash} onChange={(e) => setBaseHash(e.target.value)}>
                <option value="">Choose baseline…</option>
                {artifacts.map((a) => <option key={a.artifactHash} value={a.artifactHash}>{a.artifactHash.slice(0, 12)} {a.sampleKinds[0]}</option>)}
              </select>
            </FormField>
            <FormField label="Candidate artifact" htmlFor="cand-artifact" required helper="Newer profile to compare against baseline.">
              <select id="cand-artifact" value={candHash} onChange={(e) => setCandHash(e.target.value)}>
                <option value="">Choose candidate…</option>
                {artifacts.map((a) => <option key={a.artifactHash} value={a.artifactHash}>{a.artifactHash.slice(0, 12)} {a.sampleKinds[0]}</option>)}
              </select>
            </FormField>
          </div>
          <button onClick={runCompare} disabled={!canCompare || busy}>Compare</button>
          {compare && (
            <div style={{ marginTop: 10 }}>
              <p><span className={`badge ${compare.verdict === "INVALID_COMPARISON" ? "warn" : compare.verdict === "NO_DIFFERENCE" ? "fact" : "warn"}`}>{compare.verdict}</span></p>
              {(compare.reasons?.length ?? 0) > 0 && <ul className="muted small">{compare.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              {(compare.limitations?.length ?? 0) > 0 && <ul className="muted small">{compare.limitations.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              <table className="matrix" aria-label="Comparison rows"><tbody>
                {compare.rows.map((r, i) => (
                  <tr key={i}><td>{r.name}</td><td style={{ textAlign: "right" }}>{pct(r.baseShare)}</td><td style={{ textAlign: "right" }}>{pct(r.candShare)}</td><td style={{ textAlign: "right" }}>{r.shareChange >= 0 ? "+" : ""}{pct(r.shareChange)}</td></tr>
                ))}
              </tbody></table>
              <p className="muted small">Shares per 100 samples of the same sample kind; a difference observed in one window is not a proven cause.{" "}
                <InfoTip label="About comparisons">Correlation shows association, not causation. Treat large share changes as signals to investigate.</InfoTip>
              </p>
            </div>
          )}
        </section>
      )}

      {selected && (
        <section aria-label="Metric presentation">
          <h3>Metric wording (templates)</h3>
          <button onClick={compile} disabled={busy}>Compile metric table</button>
          {compiled && (
            <div style={{ marginTop: 10 }}>
              <p className="muted small">
                {compiled.presentationManifest.manifestHash.slice(0, 20)} — every drawn item is bound to a registered wording template and verified.{" "}
                <InfoTip label="Verified items">Only items that pass the wording check are rendered; rejected items become explicit placeholders.</InfoTip>
              </p>
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

      <div className="modal-actions" style={{ borderTop: "1px solid var(--line)", marginTop: "auto" }}>
        <span className="muted small">
          Aggregates persist; raw samples stay in their file.{" "}
          <InfoTip label="Deleting a repository">Deleting a repository removes its profile links and derived populations. Source code is never written here.</InfoTip>
        </span>
      </div>
    </Modal>
  );
}

const rowKey = (r: HotspotRow) => `${r.rank}:${r.functionKey}`;
const rof = (file: string | null, line: number | null, attribution: string) => (attribution === "CODE_LOCATION_EXACT" && line ? `${file}:${line}` : file ?? "");
