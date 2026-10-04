import { useEffect, useState } from "react";
import { DEFAULT_SKELETON, skeletonVisible, type SkeletonPolicy } from "./loading.ts";

/**
 * React binding for `skeletonVisible`: it remembers when a region became pending and wakes at the delay and the
 * minimum-duration boundary, but the pure rule is what actually decides whether the skeleton is shown.
 */
export function useSkeleton(pending: boolean, policy: SkeletonPolicy = DEFAULT_SKELETON): boolean {
  const [since, setSince] = useState<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { if (pending && since === null) setSince(Date.now()); }, [pending, since]);
  useEffect(() => {
    if (since === null) return;
    const wake = pending ? since + policy.delayMs : since + policy.delayMs + policy.minMs;
    const t = setTimeout(() => { if (pending) tick((n) => n + 1); else setSince(null); }, Math.max(0, wake - Date.now()));
    return () => clearTimeout(t);
  }, [pending, since, policy.delayMs, policy.minMs]);
  return skeletonVisible(pending, since, Date.now(), policy);
}
