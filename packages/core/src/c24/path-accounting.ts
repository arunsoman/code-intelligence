// C24 phase-0 algorithm evidence: overlap-aware duration accounting (design §9: "Nested/overlapping durations are not
// summed"; uncovered intervals "remain unexplained rather than assigned to a known service"). The critical-path report's
// coveredDurationMs/unresolvedDurationMs must be a union over intervals on the observation axis, so re-segmenting the same
// evidence never changes the totals.
export interface AccountedInterval { fromMs: number; toMs: number; covered: boolean }
export interface AccountingResult { coveredMs: number; unresolvedMs: number; /** Discarded inputs, each with the reason it was not counted (impossible timestamps never enter statistics; cf. flagsOf). */ discarded: { interval: AccountedInterval; reason: string }[] }

/** Union length of `covered` intervals within the observation window, minus the window → uncovered. Overlapping or
 *  duplicated segments therefore cannot double-count. Non-finite or inverted intervals are discarded with a reason, never
 *  silently counted (an impossible timestamp is counted, not repaired). */
export function accountDurations(segments: AccountedInterval[], observation: { fromMs: number; toMs: number }): AccountingResult {
  const discarded: { interval: AccountedInterval; reason: string }[] = [];
  const clean = segments.filter((s) => {
    const finite = Number.isFinite(s.fromMs) && Number.isFinite(s.toMs) && s.fromMs >= 0 && s.toMs >= 0;
    if (!finite || s.toMs < s.fromMs) { discarded.push({ interval: s, reason: "non-finite or inverted interval; kept out of every statistic" }); return false; }
    return true;
  });
  const clipped: { from: number; to: number }[] = [];
  for (const s of clean) if (!s.covered) continue;
    else {
      const from = Math.max(s.fromMs, observation.fromMs), to = Math.min(s.toMs, observation.toMs);
      if (to <= from) { discarded.push({ interval: s, reason: "no overlap with the observation window after clipping" }); continue; }
      clipped.push({ from, to });
    }
  // Merge overlaps on a canonically sorted copy — the union is what is counted, not the segments.
  clipped.sort((a, b) => a.from - b.from || a.to - b.to);
  let union = 0; let cursor: { from: number; to: number } | null = null;
  for (const iv of clipped) {
    if (cursor && iv.from <= cursor.to) cursor.to = Math.max(cursor.to, iv.to);
    else { if (cursor) union += cursor.to - cursor.from; cursor = { ...iv }; }
  }
  if (cursor) union += cursor.to - cursor.from;
  const windowLen = Math.max(0, observation.toMs - observation.fromMs);
  return { coveredMs: union, unresolvedMs: windowLen - union, discarded };
}