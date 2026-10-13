import { useEffect, useState } from "react";
import type { JobView } from "@cie/schema";
import { buttonFeedback } from "./button.ts";

const LABEL: Record<JobView["kind"], string> = {
  index: "Indexing", concepts: "Extracting concepts", investigate: "Investigating",
  "defect-detect": "Detecting defects", "defect-experiment": "Running defect experiment",
  "pr-analysis": "Analysing pull request", "search-index": "Building search index",
  "concept-hierarchy": "Building concept hierarchy", "dependency-scan": "Scanning dependencies",
  "history-analysis": "Analysing history", "campaign-advance": "Advancing campaign",
  "campaign-joint-check": "Checking campaign", "feature-build": "Building feature",
  "feature-validate": "Validating feature", "feature-apply": "Applying feature",
  "runtime-introspect": "Inspecting runtime",
};

/** The running (or waiting) background job: what it is doing, how far along, and a Cancel that says what it will keep.
 * `cancelling` is the instant the Cancel button was clicked, not the server-confirmed `j.cancelRequested` — that
 * field only flips once the cancel call round-trips (or the next poll), so without it a fast second click re-fires. */
export function JobBar({ jobs, onCancel, cancelling }: { jobs: JobView[]; onCancel: (j: JobView) => void; cancelling?: (id: string) => boolean }) {
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
        const isCancelling = cancelling?.(j.id) ?? false;
        const stopping = j.cancelRequested || isCancelling;
        const fb = buttonFeedback({ className: "secondary small", busy: isCancelling, skeleton: isCancelling });
        return (
          <div key={j.id} className="job">
            <div className="jobline">
              <strong>{LABEL[j.kind]}</strong>
              <span role="status" className="muted small">{j.state === "QUEUED" ? "Waiting for the running job to finish" : stopping ? "Stopping…" : j.message}{j.state === "RUNNING" ? ` · ${secs}s` : ""}</span>
              <button className={fb.className} aria-busy={fb["aria-busy"]} onClick={() => onCancel(j)} disabled={j.committing || stopping}
                title={j.committing ? "It is saving its result and will finish; stopping now would leave half of it" : "Stop now. Nothing from this run is saved."}>
                {fb.spinner && <span className="spinner" aria-hidden="true" />}
                {j.committing ? "Saving…" : stopping ? "Stopping…" : "Cancel"}
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
