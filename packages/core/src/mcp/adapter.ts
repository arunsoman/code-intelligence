// F12 §7.5/§9: the adapter every tool call passes through. Enforces, in order: the session call budget (a looping
// agent cannot saturate the local service), the freshness guard (staleness is stated in the result, never silent),
// per-call bounds (claim count and claim-text bytes, overflow counted in gaps), the §7.4 shaping gate (a result that
// cannot say how it is known is not produced), and the §7.3.4 downgrade (claims about changed files drop one class
// when no refresh succeeded).
import { McpGatewayError, type McpGateway } from "./client.ts";
import { FreshnessGuard, claimTouchesChangedFile, type FreshnessOptions } from "./freshness.ts";
import { checkMcpResult, downgradeClass, type McpToolResult } from "./result.ts";
import { assertAllowlist } from "./allowlist.ts";
import { checkToolArgs, MCP_TOOLS, toolByName, type ToolRunEnv } from "./tools.ts";

export const TOOL_SCHEMA_VERSION = "f12.s1.v1";

/** §7.5 per-call bounds. */
export const MCP_BUDGETS = {
  maxClaimsPerCall: 20,
  maxClaimTextBytes: 8 * 1024,
  defaultSessionCallsPerHour: 200,
} as const;

export interface McpAdapterOptions extends FreshnessOptions {
  /** §7.5 session budget: calls per sliding hour. Default 200. */
  sessionBudgetPerHour?: number;
  /** Injectable clock (ms) for the budget window and tests. */
  now?: () => number;
}

export interface McpToolListing { tools: { name: string; description: string; parameters: unknown }[]; toolSchemaVersion: string }

export class McpAdapter {
  private readonly guard: FreshnessGuard;
  private readonly budgetPerHour: number;
  private readonly now: () => number;
  private readonly callTimes: number[] = [];
  private lastShown: { entityId: string; name: string; file: string }[] = [];

  readonly gateway: McpGateway;
  constructor(gateway: McpGateway, opts: McpAdapterOptions = {}) {
    this.gateway = gateway;
    this.guard = new FreshnessGuard(gateway, opts);
    this.budgetPerHour = opts.sessionBudgetPerHour ?? MCP_BUDGETS.defaultSessionCallsPerHour;
    this.now = opts.now ?? Date.now;
    // F12-A1: where the operation table is reachable (in-process), assert the allowlist and the tool registry
    // against it at start-up. Over HTTP the boundary is enforced by the same list inside DirectGateway on the
    // serving side; the CLI documents that it cannot self-check without the table.
    const table = (gateway as { operationTable?: () => Record<string, { mutating: boolean }> }).operationTable?.();
    if (table) assertAllowlist(table, MCP_TOOLS.map((t) => t.ops));
  }

  /** §13: the host pays for the tool schema on every session; keep it under 6 KB and version it (F12-A9). */
  listTools(): McpToolListing {
    const listing: McpToolListing = {
      tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      toolSchemaVersion: TOOL_SCHEMA_VERSION,
    };
    const bytes = Buffer.byteLength(JSON.stringify(listing), "utf8");
    if (bytes > 6 * 1024) throw new McpGatewayError("STORAGE_FAILURE", `MCP tool schema is ${bytes} bytes, over the 6 KB host budget (F12-A9)`, false);
    return listing;
  }

  /** §7.5: a sliding-hour budget. Exhaustion is a typed error with a retry hint; the window recovers on its own (F12-A7). */
  private takeBudget(): void {
    const horizon = this.now() - 3_600_000;
    while (this.callTimes.length && this.callTimes[0] <= horizon) this.callTimes.shift();
    if (this.callTimes.length >= this.budgetPerHour) {
      const retryAfterMs = this.callTimes[0] + 3_600_000 - this.now() + 1;
      throw new McpGatewayError("BUDGET_EXCEEDED", `MCP session budget exhausted (${this.budgetPerHour} calls per hour); the window recovers in ${Math.ceil(retryAfterMs / 1000)}s`, true, retryAfterMs);
    }
    this.callTimes.push(this.now());
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    const tool = toolByName.get(name);
    if (!tool) throw new McpGatewayError("NOT_FOUND", `no such tool: ${name}`, false);
    const argProblem = checkToolArgs(tool, args);
    if (argProblem) throw new McpGatewayError("INVALID_SCHEMA", argProblem, false);
    this.takeBudget();

    const freshness = await this.guard.beforeCall();
    const stalenessGap = freshness.workingTreeChanged ? this.guard.stalenessGap(freshness) : null;
    const env: ToolRunEnv = { gw: this.gateway, freshness, stalenessGap, lastShown: this.lastShown };
    let result: McpToolResult;
    try {
      result = await tool.run(env, (args ?? {}) as Record<string, unknown>);
    } catch (e) {
      if (e instanceof McpGatewayError) throw e;
      const err = e as Error & { code?: string };
      // NOT_FOUND from a backing op (e.g. unknown symbol) is a Fog answer, not a transport failure: the tool layer
      // handles known cases; anything escaping here is surfaced with the op's own code vocabulary (§5).
      throw new McpGatewayError(err.code ?? "STORAGE_FAILURE", err.message ?? String(e), err.code === "NOT_FOUND" ? false : true);
    }

    // §7.3.4: claims touching files the working tree changed are downgraded one class unless a refresh succeeded.
    if (freshness.workingTreeChanged && !freshness.refreshed) {
      result.claims = result.claims.map((c) => {
        const paths = c.evidence.map((e) => e.path).filter((p) => p && p !== "." && !p.startsWith("cie://"));
        return claimTouchesChangedFile(paths, freshness) ? { ...c, class: downgradeClass(c.class) } : c;
      });
    }

    // §7.5 per-call bounds: claim count and claim-text bytes, overflow counted in gaps.
    if (result.claims.length > MCP_BUDGETS.maxClaimsPerCall) {
      const omitted = result.claims.length - MCP_BUDGETS.maxClaimsPerCall;
      result.gaps.push(`${omitted} claim(s) omitted to stay within the per-call claim budget (${MCP_BUDGETS.maxClaimsPerCall}).`);
      result.claims = result.claims.slice(0, MCP_BUDGETS.maxClaimsPerCall);
      result.completeness = "PARTIAL";
    }
    let textBytes = 0;
    const kept = result.claims.filter((c) => {
      const b = Buffer.byteLength(c.text, "utf8");
      if (textBytes + b > MCP_BUDGETS.maxClaimTextBytes) return false;
      textBytes += b;
      return true;
    });
    if (kept.length < result.claims.length) {
      result.gaps.push(`${result.claims.length - kept.length} claim(s) omitted to stay within the per-call text budget (${MCP_BUDGETS.maxClaimTextBytes} bytes).`);
      result.claims = kept;
      result.completeness = "PARTIAL";
    }

    const rejection = checkMcpResult(result);
    if (rejection) throw new McpGatewayError("STORAGE_FAILURE", `tool ${name} produced a result that failed the shaping gate: ${rejection}`, false);

    // Session memory for why_not_shown: what this answer showed, so the next call can explain absences.
    this.lastShown = result.claims.flatMap((c) => c.evidence.filter((e) => e.id.startsWith("entity:")).map((e) => ({ entityId: e.id.slice("entity:".length), name: c.text.split("`")[1] ?? e.id, file: e.path })));
    return result;
  }

  /** §8: `cie://evidence/{id}` returns the cited span. Denied paths are counted, never named (F12-A5). */
  async readResource(uri: string): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
    this.takeBudget();
    const m = uri.match(/^cie:\/\/evidence\/(.+)$/);
    if (!m) throw new McpGatewayError("INVALID_SCHEMA", `unsupported resource URI ${uri}; only cie://evidence/{id} exists`, false);
    const freshness = await this.guard.beforeCall();
    if (!freshness.revision) throw new McpGatewayError("NOT_FOUND", "no indexed revision; nothing to read", true);
    const r = await this.gateway.call("C18/evidence", { revision: freshness.revision, evidenceId: m[1] });
    if (!r.ok) {
      if (r.error.code === "FORBIDDEN") throw new McpGatewayError("FORBIDDEN", "that evidence is in a path your policy denies (counted, not named)", false);
      throw new McpGatewayError(r.error.code, r.error.message, r.error.retryable);
    }
    const ev = r.value as { id: string; file?: string; startLine?: number; endLine?: number; state?: string; class?: string };
    if (ev.state === "ACCESS_REVOKED") throw new McpGatewayError("FORBIDDEN", "that evidence is in a path your policy denies; it is counted, not named (F12-A5)", false);
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ id: ev.id, path: ev.file ?? null, startLine: ev.startLine ?? null, endLine: ev.endLine ?? null, class: ev.class ?? null, note: "cited span metadata only; the content hash is on the evidence record in the store", untrustedText: true }) }] };
  }
}
