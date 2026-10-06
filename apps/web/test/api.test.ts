import assert from "node:assert/strict";
import { test } from "node:test";
import { call } from "../src/api.ts";

test("PR actions send generated idempotency keys without user input", async (t) => {
  const keys: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const key = new Headers(init.headers).get("idempotency-key");
    assert.ok(key, "the gateway requires an idempotency key");
    keys.push(key);
    return Response.json({ ok: true, value: {} });
  });
  for (const [component, op] of [["C23", "analyzePullRequest"], ["C30", "publishCheck"], ["C18", "recordDisposition"]]) {
    assert.equal((await call(component!, op!, {})).ok, true);
  }
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 3, "separate actions must not share a key");
});

test("explicit keys survive retries after a lost response", async (t) => {
  const keys: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    keys.push(new Headers(init.headers).get("idempotency-key"));
    if (keys.length === 1) throw new Error("response lost");
    return Response.json({ ok: true, value: { id: "job-1" } });
  });
  const body = { repoPath: "/repo", prNumber: 15 };
  const first = await call("C23", "analyzePullRequest", body, "analysis-action-1");
  assert.equal(first.ok, false);
  const retry = await call("C23", "analyzePullRequest", body, "analysis-action-1");
  assert.equal(retry.ok, true);
  assert.deepEqual(keys, ["analysis-action-1", "analysis-action-1"]);
});
