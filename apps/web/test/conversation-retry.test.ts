import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationRequest, canRetryConversation } from "../src/conversation-retry.ts";
import type { ApiResult } from "@cie/schema";
import { buildSync } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("chat exposes retry only when available and disables it while busy", async () => {
  const dir = mkdtempSync(join(import.meta.dirname, "retry-render-"));
  try {
    const compiled = buildSync({ entryPoints: [join(import.meta.dirname, "../src/ChatPanel.tsx")], bundle: true, platform: "node", format: "esm", jsx: "automatic", packages: "external", write: false });
    const path = join(dir, "panel.mjs"); writeFileSync(path, compiled.outputFiles[0].text);
    const { ChatPanel } = await import(pathToFileURL(path).href);
    const props = { messages: [], referents: [], busy: false, canAsk: true, examples: [], onSend: () => {}, onDropReferent: () => {}, onNewContext: () => {}, onRetry: () => {} };
    const render = (extra: object) => renderToStaticMarkup(createElement(ChatPanel, { ...props, ...extra }));
    assert.doesNotMatch(render({}), /Retry investigation/);
    assert.match(render({ retryAvailable: true }), /aria-label="Interrupted investigation recovery"/);
    assert.match(render({ retryAvailable: true }), /<button class="secondary small">Retry investigation<\/button>/);
    assert.match(render({ retryAvailable: true, busy: true }), /<button class="secondary small" disabled="">Retry investigation<\/button>/);
    assert.match(render({ retryAvailable: true, canAsk: false }), /<button class="secondary small" disabled="">Retry investigation<\/button>/);
    const recoverable={id:"inv",revision:"r",readyAt:0};
    assert.match(render({recoverable}),/<button class="secondary small">Resume interrupted investigation<\/button>/);
    assert.match(render({recoverable:{...recoverable,readyAt:Date.now()+60000}}),/<button class="secondary small" disabled="">Resume interrupted investigation<\/button>/);
    assert.doesNotMatch(render({recoverable,retryAvailable:true}),/Resume interrupted investigation/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("manual retry preserves key and original payload after both automatic attempts lose their response", async t => {
  const keys: string[] = [], bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_: unknown, init: RequestInit) => {
    keys.push(new Headers(init.headers).get("idempotency-key")!); bodies.push(String(init.body));
    if (keys.length <= 2) throw new Error("lost response");
    return Response.json({ ok: true, value: { kind: "message", message: "recovered" }, metadata: {} });
  });
  const body = { text: "charge without topup?", sessionId: "s", selection: ["debit"], revision: "r" };
  const action = new ConversationRequest(body, "repo:s:r", "stable-action");
  body.selection.push("different-current-selection"); body.text = "another question";
  const first = await action.run("repo:s:r");
  assert.ok(first && canRetryConversation(first));
  assert.equal((await action.run("repo:s:r"))?.ok, true);
  assert.deepEqual(keys, ["stable-action", "stable-action", "stable-action"]);
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(JSON.parse(bodies[0]).selection, ["debit"]);
  assert.equal(action.text, "charge without topup?");
});

test("scope changes refuse replay and simultaneous retries share one network request", async t => {
  let resolve!: (r: Response) => void, calls = 0;
  t.mock.method(globalThis, "fetch", () => { calls++; return new Promise<Response>(done => { resolve = done; }); });
  const action = new ConversationRequest({ text: "inspect" }, "repo:s:r");
  for (const scope of ["other:s:r", "repo:other:r", "repo:s:new-revision"]) assert.equal(action.run(scope), null);
  assert.equal(calls, 0);
  const a = action.run("repo:s:r"), b = action.run("repo:s:r");
  assert.equal(a, b); assert.equal(calls, 1);
  resolve(Response.json({ ok: true, value: { kind: "message", message: "ok" }, metadata: {} }));
  assert.equal((await a)?.ok, true);
});

test("only retryable interruption errors offer the same-action recovery control", () => {
  const error = (code: string, retryable: boolean) => ({ ok: false, error: { code, message: "failure", retryable }, metadata: {} }) as ApiResult<unknown>;
  for (const code of ["PROVIDER_UNAVAILABLE", "DEADLINE_EXCEEDED", "VERSION_CONFLICT"]) {
    assert.equal(canRetryConversation(error(code, true)), true);
    assert.equal(canRetryConversation(error(code, false)), false);
  }
  for (const code of ["FORBIDDEN", "STALE_REVISION", "CANCELLED", "INVALID_SCHEMA"]) assert.equal(canRetryConversation(error(code, true)), false);
});
