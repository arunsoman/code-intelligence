// F12 §4: the adapter's only door to the analysis. `McpGateway` is the transport boundary — the adapter never sees a
// Service. Two implementations: HttpGatewayClient (the real `cie mcp` process, loopback-only) and DirectGateway
// (in-process, used by tests and embedding; dispatches through the same exported operation table and enforces the
// same allowlist, so the boundary is real in both).
import { randomUUID } from "node:crypto";
import type { ApiResult, CallContext } from "@cie/schema";
import type { Service } from "../service.ts";
import { opsFor } from "../server.ts";
import { ALLOWED_OPS } from "./allowlist.ts";

/** A typed gateway failure. `code` uses the ApiError vocabulary so hosts can map it (§5). */
export class McpGatewayError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(code: string, message: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = "McpGatewayError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
  toApiError() { return { code: this.code, message: this.message, retryable: this.retryable }; }
}

/** The transport boundary every MCP tool call crosses. */
export interface McpGateway {
  /** POST one operation from the allowlist; throws McpGatewayError on transport/HTTP failure. */
  call(op: string, body: unknown): Promise<ApiResult<unknown>>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** §8: only loopback URLs, as the local gateway binds 127.0.0.1 only. A non-loopback --url is refused (F12-A6). */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
  } catch { return false; }
}

/**
 * The real adapter transport: newline-free HTTP POSTs to the loopback gateway. Every call carries an Idempotency-Key
 * (the two freshness mutating ops require one; read ops ignore it). A dead gateway is a typed error naming the cause —
 * the adapter never falls back to answering without the service (§14 "CIE is not running at <url>").
 */
export class HttpGatewayClient implements McpGateway {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  constructor(baseUrl: string, timeoutMs = 60_000) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    if (!isLoopbackUrl(baseUrl)) throw new McpGatewayError("FORBIDDEN", `refusing non-loopback gateway URL ${baseUrl}; the MCP adapter talks to the local gateway only (F12-A6)`, false);
  }

  async call(op: string, body: unknown): Promise<ApiResult<unknown>> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/api/v1/components/${op}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const cause = e instanceof Error ? (e.name === "TimeoutError" ? "timed out" : e.message) : String(e);
      throw new McpGatewayError("PROVIDER_UNAVAILABLE", `CIE is not running at ${this.baseUrl} (${cause})`, true);
    }
    let parsed: unknown;
    try { parsed = await res.json(); } catch { throw new McpGatewayError("STORAGE_FAILURE", `CIE answered at ${this.baseUrl} with a non-JSON response (HTTP ${res.status})`, true); }
    const r = parsed as ApiResult<unknown>;
    if (!r || typeof r !== "object" || typeof (r as { ok?: unknown }).ok !== "boolean") throw new McpGatewayError("STORAGE_FAILURE", `CIE answered at ${this.baseUrl} with an unrecognised body (HTTP ${res.status})`, true);
    return r;
  }
}

export interface DirectGatewayOptions {
  /** The principal the agent acts as (§10.2: agent:<host>), bound to the user's access policy. */
  principalId?: string;
}

/**
 * In-process gateway for tests and embedding: dispatches through `opsFor`, the exact table the HTTP gateway serves,
 * and refuses any operation outside the MCP allowlist. The allowlist assertion runs at construction (F12-A1).
 */
export class DirectGateway implements McpGateway {
  private readonly ops: ReturnType<typeof opsFor>;
  private readonly svc: Service;
  private readonly principalId: string;
  constructor(svc: Service, opts: DirectGatewayOptions = {}) {
    this.svc = svc;
    this.ops = opsFor(svc);
    this.principalId = opts.principalId ?? "agent:unknown";
  }

  /** The exact table the HTTP gateway serves; the adapter asserts the MCP allowlist against it at start-up (F12-A1). */
  operationTable(): Record<string, { mutating: boolean }> { return this.ops; }

  async call(op: string, body: unknown): Promise<ApiResult<unknown>> {
    if (!ALLOWED_OPS.has(op)) throw new McpGatewayError("FORBIDDEN", `operation ${op} is outside the MCP allowlist`, false);
    const entry = this.ops[op];
    if (!entry) throw new McpGatewayError("NOT_FOUND", `no such operation: ${op}`, false);
    const ctx: CallContext = {
      requestId: randomUUID(), idempotencyKey: randomUUID(), actor: { principalId: this.principalId, tenantId: "local", sessionId: "mcp" },
      deadlineMs: Date.now() + 60_000, traceId: randomUUID(),
    };
    return entry.run(ctx, body) as Promise<ApiResult<unknown>>;
  }
}
