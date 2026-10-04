// F10/WP-10 — sensitivity analysis and abstention.
// A conclusion that flips sign within a plausible assumption range is reported as fragile, not as a result.
import type { AssumptionStatus } from "@cie/schema";

export interface SensitivityAssumption { id: string; statement: string; range: [number, number] }
export interface SensitivitySample { id: string; value: number; effect: number }
export interface SensitivityResult {
  statuses: AssumptionStatus[];
  fragile: boolean;
  signReversals: { id: string; from: number; to: number }[];
  samples: SensitivitySample[];
  abstained: { id: string; reason: string }[];
}
export interface Abstention { id: string; reason: string }

/** Evaluate the predicted effect across each assumption range and report any sign reversal. */
export function analyzeSensitivity(
  assumptions: SensitivityAssumption[],
  predictAt: (id: string, value: number) => number,
  opts: { samples?: number; baselineEffect?: number; abstentions?: Abstention[] } = {},
): SensitivityResult {
  const n = Math.max(3, opts.samples ?? 5);
  const statuses: AssumptionStatus[] = [];
  const signReversals: { id: string; from: number; to: number }[] = [];
  const samples: SensitivitySample[] = [];
  for (const a of assumptions) {
    const [lo, hi] = a.range;
    const effects: number[] = [];
    for (let i = 0; i < n; i++) {
      const value = lo + ((hi - lo) * i) / (n - 1);
      const effect = predictAt(a.id, value);
      effects.push(effect);
      samples.push({ id: a.id, value, effect });
    }
    const hasPositive = effects.some((e) => e > 1e-9), hasNegative = effects.some((e) => e < -1e-9);
    const canReverseSign = hasPositive && hasNegative;
    if (canReverseSign) signReversals.push({ id: a.id, from: Math.min(...effects), to: Math.max(...effects) });
    statuses.push({ id: a.id, statement: a.statement, value: (lo + hi) / 2, checkedRange: [lo, hi], withinRange: true, canReverseSign });
  }
  const abstained = opts.abstentions ?? [];
  return { statuses, fragile: signReversals.length > 0, signReversals, samples, abstained };
}

/**
 * Where an unobserved dependency is material, the affected claim is abstained with the reason rather
 * than predicted (C27 §9).
 */
export function abstain(id: string, reason: string): Abstention { return { id, reason }; }

/** A partial report after budget exhaustion lists the cells that were not run; unrun is never "passed". */
export function partialReport<T extends { cells: { cellId: string; comparable: boolean }[] }>(result: T, unrunCells: string[]): T & { unrunCells: string[]; complete: boolean } {
  return { ...result, unrunCells, complete: unrunCells.length === 0 };
}
