// What the concept-cards dialog must say about provenance and background work, kept pure so it can be
// tested without rendering React. The dialog itself only lays these strings out.
import type { ConceptStore, JobView } from "@cie/schema";

/** A provider that names no model: the offline stub, or a deterministic/heuristic graph pass. */
const DETERMINISTIC = /(?:^|[^a-z])(stub|deterministic|offline|heuristic)(?![a-z])/i;

export interface ProviderInfo {
  provider: string;
  /** True when the version was produced without a model reading the code. */
  deterministic: boolean;
  /** Short badge: "deterministic, not model-read", else "model-read". */
  badge: string;
}
export function providerInfo(provider: string): ProviderInfo {
  const deterministic = DETERMINISTIC.test(provider);
  return { provider, deterministic, badge: deterministic ? "deterministic, not model-read" : "model-read" };
}

export interface VersionInfo extends ProviderInfo { version: number; cards: number; createdAt: string; current: boolean }
/** One entry per stored version, each carrying its provider's provenance, newest first. */
export function versionInfos(store: ConceptStore | null): VersionInfo[] {
  if (!store) return [];
  const latest = store.versions[0]?.version;
  return store.versions.map((v) => ({ ...providerInfo(v.provider), version: v.version, cards: v.cards, createdAt: v.createdAt, current: v.version === latest }));
}

export interface ExtractionStatus {
  id: string;
  state: JobView["state"];
  /** "part 326 of about 362", or the job's own words. */
  progress: string;
  /** "Extracting concepts: part 326 of about 362". */
  detail: string;
  /** The run ended because the server stopped; nothing from it was saved. */
  interrupted: boolean;
  failed: boolean;
}
function progressOf(j: JobView): string {
  const m = /part\s+(\d+)\s+of about\s+(\d+)/i.exec(j.message ?? "");
  if (m) return `part ${m[1]} of about ${m[2]}`;
  if (j.total && j.done !== undefined) return `part ${Math.min(j.done + 1, j.total)} of about ${j.total}`;
  if (j.state === "QUEUED") return "waiting to start";
  return (j.message ?? "").trim() || j.state.toLowerCase();
}
/** The concept-extraction jobs that belong to `revision`, queued, running, done or failed alike. */
export function conceptExtractions(jobs: JobView[], revision?: string): ExtractionStatus[] {
  return jobs
    .filter((j) => j.kind === "concepts" && (!revision || !j.params.revision || j.params.revision === revision))
    .map((j) => {
      const interrupted = j.state === "FAILED" && /interrupted by a restart/i.test(j.message ?? "");
      return { id: j.id, state: j.state, progress: progressOf(j), detail: `Extracting concepts: ${progressOf(j)}`, interrupted, failed: j.state === "FAILED" };
    });
}

/** The versioning note is help text, never the dialog's only footer. */
export const VERSIONING_HELP = "Cards are versioned: each extraction keeps the previous set. Pick a version to read the cards it produced.";
