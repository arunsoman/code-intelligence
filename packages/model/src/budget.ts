// Budget controller: per-scope token and call allowances over a rolling window. Exhaustion is a refusal, not a silent overage;
// going past the allowance needs an explicit opt-in for that scope, and the opt-in has its own ceiling.
import type { ApiError } from "@cie/schema";

export interface BudgetPolicy {
  /** Tokens per window for hosted calls. */
  tokens: number;
  /** Calls per window. */
  calls?: number;
  windowMs?: number;
  /** Extra tokens allowed once the allowance is gone, only when the scope has opted in. 0 means no overage even with opt-in. */
  overageTokens?: number;
}
export interface BudgetUsage { tokens: number; calls: number; overageTokens: number; windowStart: number }

export class BudgetController {
  private usage = new Map<string, BudgetUsage>();
  private optIns = new Set<string>();
  private policy: BudgetPolicy;
  private now: () => number;
  constructor(policy: BudgetPolicy, now: () => number = Date.now) { this.policy = policy; this.now = now; }

  optIn(scope: string, on = true) { on ? this.optIns.add(scope) : this.optIns.delete(scope); }
  isOptedIn(scope: string) { return this.optIns.has(scope); }

  private cur(scope: string): BudgetUsage {
    const win = this.policy.windowMs ?? 86_400_000;
    let u = this.usage.get(scope);
    if (!u || this.now() - u.windowStart >= win) { u = { tokens: 0, calls: 0, overageTokens: 0, windowStart: this.now() }; this.usage.set(scope, u); }
    return u;
  }
  status(scope: string) { const u = this.cur(scope); return { ...u, limit: this.policy.tokens, remaining: Math.max(0, this.policy.tokens - u.tokens), optedIn: this.isOptedIn(scope) }; }

  /** Charge an estimated cost before the call. Returns an error when the call must not be made. */
  charge(scope: string, tokens: number): { ok: true; overage: boolean } | { ok: false; error: ApiError } {
    const u = this.cur(scope);
    const err = (message: string): { ok: false; error: ApiError } => ({ ok: false, error: { code: "BUDGET_EXCEEDED", message, retryable: false } });
    if (this.policy.calls !== undefined && u.calls >= this.policy.calls) return err(`call allowance of ${this.policy.calls} is used up`);
    const over = Math.max(0, u.tokens + tokens - this.policy.tokens);
    if (over > 0) {
      if (!this.isOptedIn(scope)) return err(`token allowance of ${this.policy.tokens} would be exceeded; opt in to allow overage`);
      const cap = this.policy.overageTokens ?? 0;
      if (u.overageTokens + over > cap) return err(`overage ceiling of ${cap} tokens would be exceeded even with opt-in`);
      u.overageTokens += over;
    }
    u.tokens += tokens; u.calls += 1;
    return { ok: true, overage: over > 0 };
  }
  /** Return the unused part of a charge when a call failed before the provider answered. */
  refund(scope: string, tokens: number) { const u = this.cur(scope); u.tokens = Math.max(0, u.tokens - tokens); u.calls = Math.max(0, u.calls - 1); }
}
