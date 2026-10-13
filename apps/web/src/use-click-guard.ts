import { useCallback, useRef, useState } from "react";
import { skeletonVisible } from "./loading.ts";

const MIN_MS = 400;

/**
 * Wrap an async action so a click is debounced — ignored while one is already running, regardless of what the
 * action itself does internally — and `pending`/`skeleton` flip the instant the click registers, not after the
 * network round-trip resolves. Several real buttons in this app derive their busy state from server-confirmed
 * data (set only once a response lands, sometimes only via a background poll), so without this a rapid
 * double-click fires the request twice.
 *
 * `skeleton` reuses `skeletonVisible`'s pure delay/min-duration rule (the same one `useSkeleton`/`Skeleton.tsx`
 * use for content placeholders), but with the delay at zero and `since` set synchronously inside `run()` -
 * not via a `pending`-triggered `useEffect` like `useSkeleton` does, which would cost one extra render before
 * the shimmer appears. A clicked button has to show feedback on the very first render after the click, not the
 * one after that; it still holds briefly once the action finishes, so a sub-100ms action doesn't flash it.
 */
export function useClickGuard<Args extends unknown[]>(action: (...args: Args) => Promise<unknown>) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const since = useRef<number | null>(null);
  const [, bump] = useState(0);
  const run = useCallback((...args: Args) => {
    if (inFlight.current) return;
    inFlight.current = true;
    since.current = Date.now();
    setPending(true);
    void action(...args).finally(() => {
      inFlight.current = false;
      setPending(false);
      const elapsed = Date.now() - since.current!;
      setTimeout(() => { since.current = null; bump((n) => n + 1); }, Math.max(0, MIN_MS - elapsed));
    });
  }, [action]);
  const skeleton = skeletonVisible(pending, since.current, Date.now(), { delayMs: 0, minMs: MIN_MS });
  return { run, pending, skeleton };
}
