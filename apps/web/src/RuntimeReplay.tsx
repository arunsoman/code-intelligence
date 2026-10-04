import { useEffect, useState } from "react";
import { call } from "./api.ts";

export interface ReplayFrame {
  cursorMs: number; window: { from: number; to: number }; envelopes: string[];
  entities: { entityId: string; spans: number; errors: number }[];
  fogSpans: number; warnings: string[];
}
const localTime = (ms: number) => {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
};

export function RuntimeReplay({ revision, onFrame }: { revision: string; onFrame: (frame: ReplayFrame | null) => void }) {
  const [end] = useState(() => Date.now());
  const [from, setFrom] = useState(() => localTime(end - 86_400_000));
  const [to, setTo] = useState(() => localTime(end));
  const [window, setWindow] = useState<{ from: number; to: number } | null>(null);
  const [cursor, setCursor] = useState(end);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState<ReplayFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!window) return;
    let live = true;
    setBusy(true); setFrame(null); onFrame(null); setError(null);
    // Debounce keyboard scrubbing and discard replies for superseded cursors.
    const timer = setTimeout(async () => {
      const r = await call<ReplayFrame>("C24", "replay", { revision, window, cursor });
      if (!live) return;
      setBusy(false);
      if (r.ok) { setFrame(r.value); onFrame(r.value); }
      else { setError(r.error.message); setPlaying(false); }
    }, 100);
    return () => { live = false; clearTimeout(timer); };
  }, [revision, window, cursor, refresh, onFrame]);

  useEffect(() => {
    if (!playing || !window || busy || !frame) return;
    if (cursor >= window.to) { setPlaying(false); return; }
    const timer = setTimeout(() => setCursor((c) => Math.min(window.to, c + Math.max(1, Math.ceil((window.to - window.from) / 100)))), 350);
    return () => clearTimeout(timer);
  }, [playing, window, cursor, busy, frame]);
  useEffect(() => () => onFrame(null), [onFrame]);

  function load() {
    const start = Date.parse(from), stop = Date.parse(to);
    setPlaying(false);
    if (!Number.isFinite(start) || !Number.isFinite(stop) || start < 0 || stop <= start) {
      setError("Choose an end time after the start time."); return;
    }
    setWindow({ from: start, to: stop }); setCursor(start); setRefresh((n) => n + 1);
  }

  return <section className="runtime-replay" aria-label="Recorded runtime replay">
    <details><summary>Replay recorded runtime</summary>
      <p className="muted small">Cumulative recorded spans by start time. Blue halos mark observations; red halos mark recorded errors. The list includes code outside this map too. This is not live telemetry or currently executing spans. Times use your local timezone.</p>
      <div className="replay-controls">
        <label>From<input aria-label="Replay from" type="datetime-local" step="1" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input aria-label="Replay to" type="datetime-local" step="1" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="secondary small" onClick={load}>Load replay</button>
        {window && <button className="secondary small" onClick={() => { setPlaying(false); setWindow(null); setFrame(null); onFrame(null); setError(null); setBusy(false); }}>Clear replay</button>}
      </div>
      {window && <>
        <label htmlFor="replay-cursor">Replay cursor: {new Date(cursor).toLocaleString()}</label>
        <input id="replay-cursor" type="range" min={window.from} max={window.to} step="1" value={cursor} aria-valuetext={new Date(cursor).toLocaleString()} onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value)); }} />
        <button className="secondary small" disabled={!playing && (busy || !frame || !frame.envelopes.length)} onClick={() => { if (!playing && cursor >= window.to) setCursor(window.from); setPlaying(!playing); }}>{playing ? "Pause replay" : "Play replay"}</button>
      </>}
      {busy && <p role="status">Loading replay…</p>}
      {error && <p role="alert">{error}</p>}
      {frame && <div className="replay-result" aria-live={playing ? "off" : "polite"}>
        {!frame.envelopes.length ? <p>No ingested runtime data in this window. Ingest a runtime envelope in Insights → Runtime, or choose another time window.</p> : <>
          <p>{frame.entities.reduce((n, e) => n + e.spans, 0)} attributed span(s) · {frame.entities.reduce((n, e) => n + e.errors, 0)} error(s) · {frame.fogSpans} unattributed span(s).</p>
          <ul>{frame.entities.map((e) => <li key={e.entityId}>{e.entityId}: {e.spans} span(s), {e.errors} error(s)</li>)}</ul>
          {frame.warnings?.length > 0 && <p className="warn-text">{frame.warnings.join("; ")}</p>}
        </>}
      </div>}
    </details>
  </section>;
}
