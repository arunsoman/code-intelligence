// A plain, unredacted record of LLM wire traffic: the exact text sent to a model server, and the exact text
// it sent back, nothing else. diagnostics.jsonl deliberately redacts and truncates ("messages"/"body" fields,
// 8000-character strings); this file does the opposite on purpose, so it is not a replacement for it, and the
// directory it writes to must be treated as sensitive (it will contain full source excerpts).
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** `agent` names which call site this is (e.g. "router.converse", "model.REPRESENT"); `direction` is "request" (what was sent) or "response" (what came back), logged verbatim. */
export function logLlmTraffic(agent: string, direction: "request" | "response", text: string): void {
  try {
    const file = resolve(process.env.CIE_LLM_LOG_FILE || ".cie/logs/llm.log");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, agent, direction, text }) + "\n";
    appendFileSync(file, line, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // A logging failure must never change an LLM call's outcome.
  }
}
