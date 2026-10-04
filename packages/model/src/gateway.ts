// Model gateway (C15/C16 slice): schema-validates provider output, enforces budget/deadline.
// Provider output is untrusted: the result is a validated value only, never executable.
import { randomUUID } from "node:crypto";
import type { BudgetController } from "./budget.ts";
import { OUTPUT_SCHEMAS, type ApiError, type ModelProvider, type ModelRequest, type ModelRunRef } from "@cie/schema";

export interface GatewayResult<T> { ok: true; value: T; run: ModelRunRef }
export interface GatewayFailure { ok: false; error: ApiError }

export async function runModel<T>(
  provider: ModelProvider,
  req: ModelRequest,
  opts: { deadlineMs: number; maxTokens?: number; budget?: { controller: BudgetController; scope: string } } = { deadlineMs: 30_000 },
): Promise<GatewayResult<T> | GatewayFailure> {
  const maxTokens = opts.maxTokens ?? 200_000;
  if (req.bundle.tokenEstimate > maxTokens) {
    return { ok: false, error: { code: "BUDGET_EXCEEDED", message: `evidence bundle ~${req.bundle.tokenEstimate} tokens exceeds ${maxTokens}`, retryable: false } };
  }
  const charged = opts.budget ? opts.budget.controller.charge(opts.budget.scope, req.bundle.tokenEstimate) : null;
  if (charged && !charged.ok) return charged;
  let raw: unknown;
  try {
    raw = await Promise.race([
      provider.generate(req),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("deadline")), opts.deadlineMs).unref()),
    ]);
  } catch (e) {
    if (opts.budget) opts.budget.controller.refund(opts.budget.scope, req.bundle.tokenEstimate);
    const deadline = (e as Error).message === "deadline";
    return { ok: false, error: { code: deadline ? "DEADLINE_EXCEEDED" : "PROVIDER_UNAVAILABLE", message: (e as Error).message, retryable: true } };
  }
  const parsed = OUTPUT_SCHEMAS[req.schemaId].safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: { code: "INVALID_SCHEMA", message: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), retryable: false } };
  }
  return {
    ok: true,
    value: parsed.data as T,
    run: { runId: randomUUID(), provider: provider.name, model: provider.model, promptTemplateVersion: `${req.purpose}.v1` },
  };
}
