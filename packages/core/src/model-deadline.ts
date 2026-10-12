import type { AgentMessage, AgentReply, AgentToolSpec, RouterModel } from "./llm-router.ts";

export class ModelDeadlineError extends Error { constructor() { super("Model call deadline reached"); } }

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
