import type { ApiError, ModelProvider } from "@cie/schema";

/** Explain known failures without copying raw provider responses (account names, URLs or prompt text) into the UI. */
export function modelFailureNotice(error: ApiError, provider: Pick<ModelProvider, "name" | "model" | "hosted">): string {
  const message = error.message;
  let reason: string;
  if (provider.name === "ollama" && provider.hosted && /(?:usage|session|daily|weekly|monthly) (?:usage )?limit|quota (?:exceeded|exhausted)/i.test(message)) {
    reason = `Ollama cloud usage limit reached for ${provider.model}. Wait for your account's limit to reset, or choose an installed local model from the model menu`;
  } else if (/\b429\b|rate limit|too many requests/i.test(message)) {
    reason = `The model provider is limiting requests for ${provider.model}. Wait before trying again, or choose another model from the model menu`;
  } else if (error.code === "DEADLINE_EXCEEDED" || /timeout|timed out/i.test(message)) {
    reason = `The model ${provider.model} timed out. Try again or choose another model from the model menu`;
  } else if (provider.name === "ollama" && /\b(?:401|403)\b|unauthorized|sign in/i.test(message)) {
    reason = `Ollama could not authorize ${provider.model}. Check the server's Ollama sign-in, or choose an installed local model from the model menu`;
  } else if (error.code === "INVALID_SCHEMA" || /schema validation|not valid JSON|no content/i.test(message)) {
    reason = `The model ${provider.model} did not return a usable answer. Try again or choose another model from the model menu`;
  } else {
    reason = `Model unavailable (${error.code}) for ${provider.model}. Check the model connection or choose another model from the model menu`;
  }
  return `${reason}; showing deterministic facts only.`;
}
