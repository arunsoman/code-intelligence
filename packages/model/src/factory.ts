import type { ModelProvider } from "@cie/schema";
import { OllamaProvider } from "./ollama.ts";
import { StubProvider } from "./stub.ts";

export interface ProviderChoice { provider: ModelProvider; note?: string }

/**
 * `which`: "ollama" (default) | "stub". `model` is the exact Ollama model to run — resolved by the caller (see
 * `resolveModel`), never defaulted here. With `which: "ollama"` and no model, or a model that is unavailable,
 * this returns the offline stub and says why; it never fails the caller for a model problem.
 */
export async function createProvider(opts: { which?: string; model?: string | null; baseUrl?: string; think?: "low" | "medium" | "high" | "off" } = {}): Promise<ProviderChoice> {
  const which = opts.which ?? "ollama";
  if (which === "stub") return { provider: new StubProvider() };
  if (which !== "ollama") throw new Error(`unknown provider "${which}" (use "ollama" or "stub")`);
  if (!opts.model) return { provider: new StubProvider(), note: "no Ollama model selected; using the offline stub. Pick one from the model menu once Ollama has one installed." };
  const ollama = new OllamaProvider({ baseUrl: opts.baseUrl, model: opts.model, think: opts.think });
  const a = await ollama.available();
  if (a.ok) return { provider: ollama };
  // Never silently pretend: the status chip shows "stub" and the server logs why.
  return { provider: new StubProvider(), note: `Ollama unavailable (${a.reason}); using the offline stub` };
}
