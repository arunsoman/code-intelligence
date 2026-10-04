// Loading states. A skeleton is a promise that work is happening; drawing one for a 40 ms answer is a flash, and
// tearing it down the instant data lands is a flicker. These pure rules decide when a skeleton is visible and what
// the canvas says while a question is being answered, so the timing and the copy are unit-tested without a browser.
export interface SkeletonPolicy { delayMs: number; minMs: number }

/** Wait out a fast reply before drawing anything; hold the skeleton briefly once drawn. */
export const DEFAULT_SKELETON: SkeletonPolicy = { delayMs: 150, minMs: 400 };

/**
 * `since` is when the region became pending (or null when it never was). A skeleton is not drawn for the first
 * `delayMs`, so a quick answer never flashes one; once drawn it stays until `delayMs + minMs`, so a reply that lands
 * mid-way cannot make it flicker.
 */
export function skeletonVisible(pending: boolean, since: number | null, now: number, policy: SkeletonPolicy = DEFAULT_SKELETON): boolean {
  if (since === null) return false;
  const elapsed = now - since;
  if (elapsed < policy.delayMs) return false;
  if (pending) return true;
  return elapsed < policy.delayMs + policy.minMs;
}

export type CanvasPhase = "view" | "composing" | "empty";

/** The canvas must never tell a user the map is empty while it is composing one. */
export function canvasPhase(o: { hasView: boolean; pending: boolean }): CanvasPhase {
  return o.hasView ? "view" : o.pending ? "composing" : "empty";
}

export const COMPOSING_CAPTION = "Composing a map for your question…";
export const EMPTY_NO_INDEX = "This map is empty on purpose. Index a repository, then tell me what you're trying to understand.";
export const EMPTY_NO_QUESTION = "Ask a question to compose a map.";
export const EMPTY_NOTHING = "Index a repository to begin.";

/** The short line the empty stage shows in the two genuinely empty cases. */
export function emptyStageCopy(indexed: boolean): string {
  return indexed ? EMPTY_NO_QUESTION : EMPTY_NOTHING;
}

/** Phase text for a long job, shown where the user is looking (the job bar and the canvas). */
export function jobPhaseText(job: { kind: string; state: string }): string {
  const what = job.kind === "index" ? "Indexing the repository" : job.kind === "concepts" ? "Reading the code with the model" : job.kind;
  return job.state === "QUEUED" ? `${what} — waiting to start…` : `${what}…`;
}
