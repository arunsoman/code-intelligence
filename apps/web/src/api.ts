import type { ApiResult } from "@cie/schema";

export async function call<T>(component: string, op: string, body: unknown = {}, idempotencyKey?: string, version: "v1" | "v2" = "v1", signal?: AbortSignal): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  try {
    // Each new call gets an action ID; callers retrying an action can reuse its key.
    headers["idempotency-key"] = idempotencyKey || crypto.randomUUID();
    const res = await fetch(`/api/${version}/components/${component}/${op}`, { method: "POST", headers, body: JSON.stringify(body), signal });
    return (await res.json()) as ApiResult<T>;
  } catch (e) {
    return { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: `cannot reach server: ${(e as Error).message}`, retryable: true }, metadata: { requestId: "", completeness: "UNKNOWN", warnings: [] } };
  }
}
