import type { ApiResult, ConverseResult } from "@cie/schema";
import { call } from "./api.ts";

export function canRetryConversation(result: ApiResult<unknown>): boolean {
  return !result.ok && result.error.retryable && ["PROVIDER_UNAVAILABLE", "DEADLINE_EXCEEDED", "VERSION_CONFLICT"].includes(result.error.code);
}

/** In-memory only: retries preserve the original payload/key, never the current map selection. */
export class ConversationRequest {
  readonly key: string;
  readonly scope: string;
  private readonly body: string;
  private inFlight?: Promise<ApiResult<ConverseResult>>;
  constructor(body: unknown, scope: string, key: string = crypto.randomUUID()) {
    this.body = JSON.stringify(body);
    this.key = key;
    this.scope = scope;
  }
  matches(scope: string): boolean { return this.scope === scope; }
  get text(): string { return String(JSON.parse(this.body).text ?? ""); }
  run(scope: string): Promise<ApiResult<ConverseResult>> | null {
    if (!this.matches(scope)) return null;
    if (this.inFlight) return this.inFlight;
    const request = call<ConverseResult>("C15", "converse", JSON.parse(this.body), this.key);
    this.inFlight = request;
    const finished = () => { if (this.inFlight === request) this.inFlight = undefined; };
    void request.then(finished, finished);
    return request;
  }
}
