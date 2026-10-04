import type { ApiResult } from "@cie/schema";

export async function call<T>(component: string, op: string, body: unknown = {}, idempotencyKey?: string, version: "v1" | "v2" = "v1"): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  try {
    const res = await fetch(`/api/${version}/components/${component}/${op}`, { method: "POST", headers, body: JSON.stringify(body) });
    return (await res.json()) as ApiResult<T>;
  } catch (e) {
    return { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: `cannot reach server: ${(e as Error).message}`, retryable: true }, metadata: { requestId: "", completeness: "UNKNOWN", warnings: [] } };
  }
}
