import type { ApiResult } from "@cie/schema";

export async function call<T>(component: string, op: string, body: unknown = {}, idempotencyKey?: string, version: "v1" | "v2" = "v1", signal?: AbortSignal): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const actionId=idempotencyKey||crypto.randomUUID();
  const attempts=component==="C15"&&op==="converse"?2:1;
  for(let attempt=0;attempt<attempts;attempt++) {
  try {
    headers["idempotency-key"] = actionId;
    const res = await fetch(`/api/${version}/components/${component}/${op}`, { method: "POST", headers, body: JSON.stringify(body), signal });
    return (await res.json()) as ApiResult<T>;
  } catch (e) {
    if(attempt+1<attempts && !signal?.aborted)continue;
    return { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: `cannot reach server: ${(e as Error).message}`, retryable: true }, metadata: { requestId: "", completeness: "UNKNOWN", warnings: [] } };
  }
  }
  throw new Error("No request attempt completed");
}
