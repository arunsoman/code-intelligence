// Canonical form and hashing (plan §1). A concept's identity across revisions is its canonical motif
// hash: a hash over the sorted motif set and the sorted feature histogram, deliberately ignoring which
// function it lives in and any identifier names. Two functions that compute different things in the
// same shape share the hash — that is the point: names are attached per anchored concept, and the
// anchored members decide which business meaning the name refers to.
import { createHash } from "node:crypto";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface CanonicalForm {
  motifs: string[];
  features: Record<string, number>;
  compositionRule: string | null;
}

/** The canonical JSON: keys sorted, arrays sorted, no whitespace. */
export function canonicalJson(form: CanonicalForm): string {
  const features = Object.fromEntries(Object.entries(form.features).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ compositionRule: form.compositionRule, features, motifs: [...form.motifs].sort() });
}

/** Stable 16-hex identity of a concept's shape. */
export function canonicalMotifHash(form: CanonicalForm): string {
  return sha(canonicalJson(form)).slice(0, 16);
}

/** L1 distance between two histograms, normalised by total mass: the anchoring shift measure. */
export function histogramShift(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let delta = 0, total = 0;
  for (const k of keys) { delta += Math.abs((a[k] ?? 0) - (b[k] ?? 0)); total += (a[k] ?? 0) + (b[k] ?? 0); }
  return total === 0 ? 0 : delta / total;
}
