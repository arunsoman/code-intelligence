import type { ApiResult, ErrorCode } from "@cie/schema";

const transportError = <T>(code: ErrorCode, message: string, retryable: boolean): ApiResult<T> =>
  ({ ok: false, error: { code, message, retryable }, metadata: { requestId: "", completeness: "UNKNOWN", warnings: [] } });

export async function call<T>(component: string, op: string, body: unknown = {}, idempotencyKey?: string, version: "v1" | "v2" = "v1", signal?: AbortSignal): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const actionId=idempotencyKey||crypto.randomUUID();
  const attempts=component==="C15"&&op==="converse"?2:1;
  for(let attempt=0;attempt<attempts;attempt++) {
  let res: Response;
  try {
    headers["idempotency-key"] = actionId;
    res = await fetch(`/api/${version}/components/${component}/${op}`, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (e) {
    // Distinguish what actually failed, rather than collapsing every transport failure into one code: a user/caller
    // cancellation, a client-side timeout (AbortSignal.timeout), and the server genuinely being unreachable are different
    // situations and used to be indistinguishable to the caller.
    if (signal?.aborted) return transportError("CANCELLED", "the request was cancelled", false);
    if ((e as Error).name === "TimeoutError") return transportError("DEADLINE_EXCEEDED", `request timed out: ${(e as Error).message}`, true);
    if (attempt + 1 < attempts) continue;
    return transportError("PROVIDER_UNAVAILABLE", `cannot reach server: ${(e as Error).message}`, true);
  }
  try {
    return (await res.json()) as ApiResult<T>;
  } catch (e) {
    // The server responded but not with a usable envelope (e.g. a proxy error page) — distinct from being unreachable.
    if (attempt + 1 < attempts) continue;
    return transportError("PROVIDER_UNAVAILABLE", `server responded with status ${res.status} but no usable result: ${(e as Error).message}`, res.status >= 500);
  }
  }
  throw new Error("No request attempt completed");
}
