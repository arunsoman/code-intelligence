import { useEffect, useState } from "react";
import type { JobView } from "@cie/schema";

const LABEL: Record<JobView["kind"], string> = { index: "Indexing", concepts: "Extracting concepts", investigate: "Investigating", "defect-detect": "Detecting defects", "defect-experiment": "Running defect experiment", "pr-analysis": "Analysing pull request", "search-index": "Building search index", "concept-hierarchy": "Building concept hierarchy" };

/** The running (or waiting) background job: what it is doing, how far along, and a Cancel that says what it will keep. */
export function JobBar({ jobs, onCancel }: { jobs: JobView[]; onCancel: (j: JobView) => void }) {
  const active = jobs.filter((j) => j.state === "QUEUED" || j.state === "RUNNING");
  const [tick, setTick] = useState(0);
  useEffect(() => { if (!active.length) return; const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, [active.length]);
  if (!active.length) return null;
  void tick;
  return (
    <div className="jobbar" role="region" aria-label="Background work">
      {active.map((j) => {
        const secs = j.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(j.startedAt)) / 1000)) : 0;
        const pct = j.total ? Math.round(((j.done ?? 0) / j.total) * 100) : null;
        return (
          <div key={j.id} className="job">
            <div className="jobline">
              <strong>{LABEL[j.kind]}</strong>
              <span role="status" className="muted small">{j.state === "QUEUED" ? "Waiting for the running job to finish" : j.cancelRequested ? "Stopping…" : j.message}{j.state === "RUNNING" ? ` · ${secs}s` : ""}</span>
              <button className="secondary small" onClick={() => onCancel(j)} disabled={j.committing || j.cancelRequested}
                title={j.committing ? "It is saving its result and will finish; stopping now would leave half of it" : "Stop now. Nothing from this run is saved."}>
                {j.committing ? "Saving…" : j.cancelRequested ? "Stopping…" : "Cancel"}
              </button>
            </div>
            <div className={`bar ${pct === null && j.state === "RUNNING" ? "indeterminate" : ""}`} role="progressbar" aria-label={`${LABEL[j.kind]} progress`}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-valuetext={pct === null ? j.message : `${pct} percent, ${j.message}`}>
              <span style={pct !== null ? { width: `${pct}%` } : undefined} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
