import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFailureNotice } from "../src/model-failure.ts";

test("model failure notices distinguish quota, throttling, sign-in, timeout and malformed answers", () => {
  const provider = { name: "ollama", model: "m:cloud", hosted: true };
  const notice = (message: string) => modelFailureNotice({ code: "PROVIDER_UNAVAILABLE", message, retryable: true }, provider);
  assert.match(notice("you have reached your session usage limit"), /cloud usage limit reached/);
  assert.match(notice("ollama 429: too many requests"), /limiting requests/);
  assert.match(notice("ollama 401: unauthorized"), /Ollama sign-in/);
  assert.match(notice("operation timed out"), /timed out/);
  assert.match(notice("output failed schema validation after repair"), /did not return a usable answer/);
  assert.doesNotMatch(notice("internal error: secret-prompt-token"), /secret-prompt-token/);
});
