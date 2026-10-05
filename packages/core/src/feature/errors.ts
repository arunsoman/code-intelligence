// One error type for every Prompt-to-feature module, mapped to the gateway's ApiError codes in one place.
import type { ApiError, ApiResult, CallContext, ErrorCode } from "@cie/schema";

export type FeatureErrorCode = "VERSION_CONFLICT" | "NOT_FOUND" | "INVALID_SCHEMA" | "FORBIDDEN" | "IDEMPOTENCY_CONFLICT" | "ILLEGAL_TRANSITION" | "BLOCKED" | "BUDGET_EXCEEDED" | "STALE_REVISION" | "PROVIDER_UNAVAILABLE" | "RESOURCE_LIMIT";

export class FeatureError extends Error {
  readonly code: FeatureErrorCode;
  readonly currentVersion?: number;
  constructor(code: FeatureErrorCode, message: string, currentVersion?: number) { super(message); this.name = "FeatureError"; this.code = code; this.currentVersion = currentVersion; }
}

const API_CODE: Record<FeatureErrorCode, ErrorCode> = {
  VERSION_CONFLICT: "VERSION_CONFLICT", NOT_FOUND: "NOT_FOUND", INVALID_SCHEMA: "INVALID_SCHEMA", FORBIDDEN: "FORBIDDEN", IDEMPOTENCY_CONFLICT: "VERSION_CONFLICT",
  ILLEGAL_TRANSITION: "VERSION_CONFLICT", BLOCKED: "FORBIDDEN", BUDGET_EXCEEDED: "BUDGET_EXCEEDED", STALE_REVISION: "STALE_REVISION",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE", RESOURCE_LIMIT: "RESOURCE_LIMIT",
};

export function toApiError(e: FeatureError): ApiError { return { code: API_CODE[e.code], message: e.message, retryable: e.code === "VERSION_CONFLICT" || e.code === "PROVIDER_UNAVAILABLE", currentVersion: e.currentVersion }; }

/** Run a handler body and turn a FeatureError into a typed failure; anything else is a bug and propagates. */
export function guarded<T>(ctx: CallContext, fn: () => T, warnings: string[] = []): ApiResult<T> {
  try { return { ok: true, value: fn(), metadata: { requestId: ctx.requestId, completeness: "COMPLETE", warnings } }; }
  catch (e) {
    if (e instanceof FeatureError) return { ok: false, error: toApiError(e), metadata: { requestId: ctx.requestId, completeness: "COMPLETE", warnings } };
    throw e;
  }
}
export async function guardedAsync<T>(ctx: CallContext, fn: () => Promise<T>, warnings: string[] = []): Promise<ApiResult<T>> {
  try { return { ok: true, value: await fn(), metadata: { requestId: ctx.requestId, completeness: "COMPLETE", warnings } }; }
  catch (e) {
    if (e instanceof FeatureError) return { ok: false, error: toApiError(e), metadata: { requestId: ctx.requestId, completeness: "COMPLETE", warnings } };
    throw e;
  }
}
