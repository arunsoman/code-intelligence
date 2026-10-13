import { useEffect, useState } from "react";

/**
 * App-wide toast: a `window` custom event (same convention as `cie-feature-job` in build/FeatureWorkbench.tsx)
 * so any component can call `toast(...)` without prop-drilling or a Context provider. `<ToastHost/>` is mounted
 * once at the app root and renders whatever is currently visible, each auto-dismissing on its own timer.
 */
export type ToastKind = "error" | "info";
interface ToastEventDetail { message: string; kind: ToastKind }
const EVENT = "cie-toast";
const DISMISS_MS = 4000;

export function toast(message: string, kind: ToastKind = "info") {
  window.dispatchEvent(new CustomEvent<ToastEventDetail>(EVENT, { detail: { message, kind } }));
}

interface Shown extends ToastEventDetail { id: number }
let nextId = 1;

export function ToastHost() {
  const [items, setItems] = useState<Shown[]>([]);
  useEffect(() => {
    const onToast = (e: Event) => {
      const { message, kind } = (e as CustomEvent<ToastEventDetail>).detail;
      const id = nextId++;
      setItems((xs) => [...xs, { id, message, kind }]);
      window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), DISMISS_MS);
    };
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, []);
  if (!items.length) return null;
  return (
    <div className="toast-host" aria-live="polite">
      {items.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`} role="status">{x.message}</div>
      ))}
    </div>
  );
}
