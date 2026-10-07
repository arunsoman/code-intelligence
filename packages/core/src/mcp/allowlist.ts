// F12 §8/§10: the one file that decides which gateway operations an agent can reach. The adapter never imports
// Service; every call crosses this list. Two rules hold, and both are asserted at start-up (F12-A1), not hoped for:
//   1. every operation a tool is built on is non-mutating;
//   2. the only mutating operations on the list are the two freshness exceptions, and they touch derived data only
//      (an index refresh never writes to the repository, the forge, or any user-visible state).
import { randomUUID } from "node:crypto";

/** Mutating operations the freshness guard is allowed to call (§10.1: index refresh is the single exception). */
export const FRESHNESS_MUTATING: ReadonlySet<string> = new Set(["C13/changesSinceIndex", "C07/enqueueIndex"]);

/** Read-only operations the tool set is built from. Anything not in this set cannot be reached, by construction. */
export const TOOL_OPS: Readonly<string> = [
  // revision identity + freshness reads
  "C13/revisionStats",
  // evidence and why-explanations (§8)
  "C18/evidence",
  "C18/evidenceBatch",
  "C26/locateSpans",
  "C15/whyHidden",
  // graph answers backing the tools (read-only; added with this feature)
  "C23/dependents",
  "C23/findConnection",
  "C23/testsReaching",
];

/** The full allowlist: tool ops plus the two freshness exceptions. */
export const ALLOWED_OPS: ReadonlySet<string> = new Set([...TOOL_OPS, ...FRESHNESS_MUTATING]);

/**
 * Start-up assertion (F12-A1). `ops` is the gateway's real operation table (server.ts `opsFor`). Fails loudly when:
 * an allowlisted operation does not exist; a tool operation is marked mutating; a freshness exception is missing from
 * the table; or a tool claims an operation that is not on the allowlist. Refusing to start beats answering without
 * the boundary.
 */
export function assertAllowlist(ops: Record<string, { mutating: boolean }>, toolOps: ReadonlyArray<ReadonlySet<string> | readonly string[]>): void {
  const problems: string[] = [];
  for (const op of ALLOWED_OPS) {
    if (!ops[op]) problems.push(`allowlisted operation ${op} is not in the gateway operation table`);
    else if (!FRESHNESS_MUTATING.has(op) && ops[op].mutating) problems.push(`tool operation ${op} is marked mutating; tools must be read-only (F12-A1)`);
  }
  for (const op of FRESHNESS_MUTATING) {
    if (ops[op] && !ops[op].mutating) problems.push(`freshness exception ${op} is not marked mutating in the operation table; the table and the allowlist disagree`);
  }
  const declared = new Set(toolOps.flatMap((l) => [...l]));
  for (const op of declared) if (!TOOL_OPS.includes(op)) problems.push(`tool declares underlying operation ${op}, which is not on the MCP allowlist`);
  if (problems.length) throw new Error(`MCP allowlist assertion failed:\n  ${problems.join("\n  ")}`);
}

/** One idempotency key per freshness call: these are the only mutating calls the adapter ever makes. */
export const freshnessIdempotencyKey = (): string => randomUUID();
