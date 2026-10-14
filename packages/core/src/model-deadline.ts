import type { AgentMessage, AgentReply, AgentToolSpec, RouterModel } from "./llm-router.ts";

export class ModelDeadlineError extends Error { constructor() { super("Model call deadline reached"); } }

/** Below this, a call cannot realistically produce a reply; retrying would only burn the remaining budget on a doomed attempt. */
export const MIN_CALL_BUDGET_MS = 3000;

export type ResilientFailure = { ok: false; reason: "deadline" | "transport"; message: string };

/** Abort is cooperative; the race also fences adapters that do not honor the signal. */
export async function converseWithin(model: RouterModel, messages: AgentMessage[], tools: AgentToolSpec[], timeoutMs: number): Promise<AgentReply | null> {
  if (!model.converse) return null;
  if (timeoutMs <= 0) throw new ModelDeadlineError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new ModelDeadlineError();
      controller.abort(error);
      reject(error);
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([Promise.resolve().then(() => model.converse!(messages, tools, controller.signal)), timeout]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * One model call, resilient to its own process failures instead of treating the first one as a dead end: a clean
 * transport failure (the adapter's own `converse` never throws for this — a connection refused, an aborted call or
 * a non-OK response all fold into a `null` reply) typically fails fast and gets another attempt within the same
 * `deadlineMs`, as long as there is still enough of it left for one to plausibly succeed.
 *
 * A timeout (`ModelDeadlineError`) or any other thrown error is deliberately NOT retried here: by definition it
 * already consumed this call's entire time slice (or failed outside this function's control), so retrying it would
 * spend a second full slice chasing the same hang rather than one — exactly the budget a caller like chat-agent.ts
 * reserves for a final answer/review. Its own forceAnswer step already *is* the right-sized retry for a timeout:
 * one more attempt with a smaller, deliberately reserved budget, not an unbounded second attempt at the same size.
 * Callers that need to react differently to a timeout than to an outage read `reason` off the failure.
 */
export async function converseResilient(model: RouterModel, messages: AgentMessage[], tools: AgentToolSpec[], deadlineMs: number, retries = 2): Promise<{ ok: true; reply: AgentReply } | ResilientFailure> {
  let message = "The model's connection failed or the server errored partway through the request.";
  for (let attempt = 0; attempt < retries; attempt++) {
    const left = deadlineMs - Date.now();
    // The first attempt always goes through with whatever time remains, even if slim — same as a bare converseWithin
    // call. Only a *retry* (attempt > 0) is skipped when there isn't enough budget left for it to plausibly help.
    if (left <= 0) return { ok: false, reason: "deadline", message: "No time remained for a model call." };
    if (attempt > 0 && left < MIN_CALL_BUDGET_MS) return { ok: false, reason: "deadline", message };
    try {
      const reply = await converseWithin(model, messages, tools, left);
      if (reply) return { ok: true, reply };
    } catch (error) {
      if (error instanceof ModelDeadlineError) return { ok: false, reason: "deadline", message: "The model did not respond within the available time budget." };
      return { ok: false, reason: "transport", message: `The model call failed: ${(error as Error).message}` };
    }
  }
  return { ok: false, reason: "transport", message };
}
