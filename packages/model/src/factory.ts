import type { ModelProvider } from "@cie/schema";
import { OllamaProvider } from "./ollama.ts";
import { StubProvider } from "./stub.ts";

export interface ProviderChoice { provider: ModelProvider; note?: string }

/** CIE_PROVIDER=ollama (default) | stub.  CIE_OLLAMA_MODEL, CIE_OLLAMA_URL override the model/daemon. */
export async function createProvider(env: Record<string, string | undefined> = process.env): Promise<ProviderChoice> {
  const which = env.CIE_PROVIDER ?? "ollama";
  if (which === "stub") return { provider: new StubProvider() };
  if (which !== "ollama") throw new Error(`unknown CIE_PROVIDER "${which}" (use "ollama" or "stub")`);
  const think = (["low", "medium", "high", "off"] as const).find((x) => x === env.CIE_OLLAMA_THINK);
  const ollama = new OllamaProvider({ baseUrl: env.CIE_OLLAMA_URL, model: env.CIE_OLLAMA_MODEL, think });
  const a = await ollama.available();
  if (a.ok) return { provider: ollama };
  // Never silently pretend: the status chip shows "stub" and the server logs why.
  return { provider: new StubProvider(), note: `Ollama unavailable (${a.reason}); using the offline stub` };
}
