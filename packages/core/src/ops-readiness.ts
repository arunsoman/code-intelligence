// Operational-readiness presence check: does a runbook exist, is there a health-check-shaped route, is structured
// logging present anywhere in the indexed functions? Each is a plain "found" signal, never a verdict — this module
// never says "ready" or "not ready"; that synthesis belongs to a later aggregator (the release-readiness ledger),
// not here. Absence of a signal is reported honestly rather than guessed into either direction.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Artifact } from "./artifacts.ts";
import type { Fn } from "./defect/functions.ts";

const HEALTH_ROUTE = /\/(health|healthz|ready)\b/i;

// security.ts's own LOGGER_RECEIVERS/LOG_METHODS/logCallRegex are not exported (private to that module), so this is
// a small self-contained equivalent rather than a reuse — same convention the codebase already follows elsewhere
// (canonical()/sha256() are duplicated per-module rather than shared). If broader reuse matters later, exporting
// logCallRegex from security.ts would let this call it directly instead.
const LOGGER_RECEIVERS = ["console", "logger", "log", "LOG", "LOGGER", "logging", "slog", "zap", "glog", "klog"];
const LOG_METHODS = ["log", "info", "warn", "warning", "error", "debug", "trace", "fatal", "critical", "exception"];
const LOG_CALL = new RegExp(
  `\\b(?:${LOGGER_RECEIVERS.join("|")}|System\\s*\\.\\s*(?:out|err))\\s*\\.\\s*(?:${LOG_METHODS.join("|")})\\s*\\(` +
  `|\\bfmt\\s*\\.\\s*(?:Printf|Println|Print|Fprintf|Fprintln|Fprint)\\s*\\(` +
  `|\\blogging\\s*\\.\\s*getLogger\\s*\\(`,
);

export interface OpsReadiness {
  runbookFound: boolean;
  healthRouteFound: boolean;
  loggingFound: boolean;
}

/** Plain presence signals only. `routes`/`functions` are whatever C06 (artifacts.ts) and the function loader
 * (defect/functions.ts) already produce for a revision — this never re-parses source on its own. */
export function opsReadiness(repoRoot: string, routes: Pick<Artifact, "kind" | "name">[], functions: Pick<Fn, "src">[]): OpsReadiness {
  return {
    runbookFound: existsSync(join(repoRoot, "RUNBOOK.md")),
    healthRouteFound: routes.some((r) => r.kind === "route" && HEALTH_ROUTE.test(r.name)),
    loggingFound: functions.some((f) => LOG_CALL.test(f.src)),
  };
}
