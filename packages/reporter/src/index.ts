// Drop-in exception reporter: sends uncaught errors from a running app to the local Code Intelligence server,
// where they appear in the exceptions inbox and can be investigated in one click.
//   import { installReporter } from "@cie/reporter"; installReporter();
// Only the error name, (optionally) message and stack are sent, and only to a loopback address.
export interface ReporterOptions {
  /** Defaults to http://127.0.0.1:4317. Non-loopback URLs are refused. */
  url?: string;
  /** Messages can contain user data; set false to send only the class and stack. Default true. */
  includeMessage?: boolean;
  source?: string;
  /** Minimum ms between sends of the same error (loops are collapsed server-side too). Default 1000. */
  throttleMs?: number;
  fetch?: typeof fetch;
}

export function isLoopbackUrl(url: string): boolean {
  try { const u = new URL(url); return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && /^https?:$/.test(u.protocol); } catch { return false; }
}

export function createReporter(opts: ReporterOptions = {}) {
  const url = (opts.url ?? "http://127.0.0.1:4317").replace(/\/$/, "");
  if (!isLoopbackUrl(url)) throw new Error("reporter: the server must be on localhost");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const last = new Map<string, number>();
  const throttle = opts.throttleMs ?? 1000;
  return async function report(err: unknown): Promise<boolean> {
    const e = err instanceof Error ? err : new Error(String(err));
    const key = `${e.name}|${(e.stack ?? "").split("\n")[1] ?? ""}`;
    const now = Date.now();
    if (now - (last.get(key) ?? 0) < throttle) return false;
    last.set(key, now);
    try {
      const res = await doFetch(`${url}/api/v1/components/C24/reportException`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: { name: e.name, message: opts.includeMessage === false ? "" : e.message, stack: e.stack ?? "" }, source: opts.source ?? "reporter" }),
      });
      return res.ok;
    } catch { return false; } // reporting must never break the app
  };
}

export function installReporter(opts: ReporterOptions = {}) {
  const report = createReporter(opts);
  const proc = (globalThis as { process?: { on?: (ev: string, fn: (...a: unknown[]) => void) => void } }).process;
  if (proc?.on) {
    proc.on("uncaughtExceptionMonitor", (e) => { void report(e); });
    proc.on("unhandledRejection", (r) => { void report(r); });
  }
  const g = globalThis as { addEventListener?: (ev: string, fn: (e: any) => void) => void };
  if (!proc?.on && g.addEventListener) {
    g.addEventListener("error", (ev) => { void report(ev.error ?? ev.message); });
    g.addEventListener("unhandledrejection", (ev) => { void report(ev.reason); });
  }
  return report;
}
