// Registers every Prompt-to-feature operation with the gateway. Until an owning task replaces a stub, the operation
// answers NOT_FOUND with the task that owns it, so callers and tests can tell "not built yet" from "bad request".
import type { ApiResult, CallContext } from "@cie/schema";
import { OPS, type OpSpec } from "./api.ts";

export type GatewayOp = { mutating: boolean; run: (ctx: CallContext, body: any) => Promise<ApiResult<unknown>> | ApiResult<unknown> };
export type Handlers = Partial<Record<string, GatewayOp["run"]>>;

const stub = (spec: OpSpec): GatewayOp["run"] => (ctx) => ({
  ok: false,
  error: { code: "NOT_FOUND", message: `${spec.key} is not implemented yet (owned by task ${spec.owner})`, retryable: false },
  metadata: { requestId: ctx.requestId, completeness: "UNKNOWN", warnings: ["prompt-to-feature scaffold"] },
});

/** Handlers registered by implementing tasks replace stubs by key. Existing gateway keys are never overwritten. */
export function featureOps(handlers: Handlers = {}, existing: Record<string, unknown> = {}): Record<string, GatewayOp> {
  const out: Record<string, GatewayOp> = {};
  for (const spec of OPS) {
    if (spec.key in existing) throw new Error(`feature operation ${spec.key} collides with an existing gateway operation`);
    out[spec.key] = { mutating: spec.mutating, run: handlers[spec.key] ?? stub(spec) };
  }
  for (const k of Object.keys(handlers)) if (!OPS.some((o) => o.key === k)) throw new Error(`handler for unknown feature operation ${k}`);
  return out;
}
