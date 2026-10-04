import { useSkeleton } from "./use-skeleton.ts";

/** A named busy region: screen readers hear what is loading, and reduced motion still shows the bars. */
export function Skeleton({ label, rows = 3, lines = 2 }: { label: string; rows?: number; lines?: number }) {
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel-row">
          {Array.from({ length: lines }, (_, j) => <span key={j} className="skel-bar" aria-hidden="true" />)}
        </div>
      ))}
    </div>
  );
}

/** A region that fetches on open: the skeleton appears only after the wait is real and stays a moment once shown. */
export function Loading({ pending, label, rows, lines }: { pending: boolean; label: string; rows?: number; lines?: number }) {
  return useSkeleton(pending) ? <Skeleton label={label} rows={rows} lines={lines} /> : null;
}

/** The canvas while a question is being composed: a map-shaped placeholder, not the empty-state copy. */
export function CanvasSkeleton({ label }: { label: string }) {
  return (
    <div className="canvas-skeleton" role="status" aria-busy="true" aria-label={label}>
      <div className="skel-row"><span className="skel-bar" aria-hidden="true" /><span className="skel-bar" aria-hidden="true" /></div>
      <div className="skel-row"><span className="skel-bar" aria-hidden="true" /><span className="skel-bar" aria-hidden="true" /><span className="skel-bar" aria-hidden="true" /></div>
      <div className="skel-row"><span className="skel-bar" aria-hidden="true" /></div>
    </div>
  );
}
