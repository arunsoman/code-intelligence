import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvidenceBundle, ModelProvider, ModelRequest } from "@cie/schema";
import { BudgetController, StubProvider, runModel } from "../src/index.ts";

const bundle = (tokens: number): EvidenceBundle => ({ id: "b", revision: "r", evidence: [], entities: [], relationships: [], facts: [], coverage: [], unresolved: [], tokenEstimate: tokens });
const req = (tokens = 10): ModelRequest => ({ purpose: "EXPLAIN", schemaId: "explanation.v1", question: "q", bundle: bundle(tokens), selected: [] });
const provider = (gen: (r: ModelRequest) => Promise<unknown>, hosted = true): ModelProvider => ({ name: "t", model: "t", hosted, generate: gen });

test("provider failure: a throwing provider is a retryable PROVIDER_UNAVAILABLE and a slow one a DEADLINE_EXCEEDED; neither yields a value", async () => {
  const down = await runModel(provider(async () => { throw new Error("ECONNREFUSED"); }), req());
  assert.ok(!down.ok && down.error.code === "PROVIDER_UNAVAILABLE" && down.error.retryable);
  const slow = await runModel(provider(() => new Promise(() => {})), req(), { deadlineMs: 30 });
  assert.ok(!slow.ok && slow.error.code === "DEADLINE_EXCEEDED" && slow.error.retryable);
});

test("invalid JSON: output that does not match the registered schema is rejected, never passed through", async () => {
  for (const bad of ["not json", null, 42, { summary: 1 }, { summary: "s", claims: [{ claim: "x" }] }, []]) {
    const out = await runModel(provider(async () => bad), req());
    assert.ok(!out.ok && out.error.code === "INVALID_SCHEMA", JSON.stringify(bad));
  }
  assert.ok((await runModel(provider(async () => ({ summary: "s", claims: [] })), req())).ok);
});

test("token caps: an evidence bundle over the cap is refused before the provider is called", async () => {
  let called = 0;
  const p = provider(async () => { called++; return { summary: "s", claims: [] }; });
  const out = await runModel(p, req(300_000));
  assert.ok(!out.ok && out.error.code === "BUDGET_EXCEEDED");
  const custom = await runModel(p, req(1_001), { deadlineMs: 1000, maxTokens: 1_000 });
  assert.ok(!custom.ok && custom.error.code === "BUDGET_EXCEEDED");
  assert.equal(called, 0);
  assert.ok((await runModel(p, req(1_000), { deadlineMs: 1000, maxTokens: 1_000 })).ok);
});

test("budget exhaustion and opt-in enforcement: the allowance is a hard stop; overage needs opt-in and has its own ceiling", async () => {
  let t = 0;
  const b = new BudgetController({ tokens: 100, calls: 5, overageTokens: 50, windowMs: 1000 }, () => t);
  assert.ok(b.charge("repo", 60).ok);
  const refused = b.charge("repo", 60);
  assert.ok(!refused.ok && refused.error.code === "BUDGET_EXCEEDED" && /opt in/.test(refused.error.message));
  assert.equal(b.status("repo").tokens, 60, "a refused charge costs nothing");
  assert.ok(b.charge("other", 60).ok, "scopes are independent");
  b.optIn("repo");
  const over = b.charge("repo", 60); // 20 over
  assert.ok(over.ok && over.overage);
  const ceiling = b.charge("repo", 60); // 60 more over: 20+60 > 50
  assert.ok(!ceiling.ok && /ceiling/.test(ceiling.error.message));
  b.optIn("repo", false);
  assert.ok(!b.charge("repo", 1).ok);
  t = 1001; // new window
  assert.ok(b.charge("repo", 100).ok);
  const calls = new BudgetController({ tokens: 1e9, calls: 2 });
  assert.ok(calls.charge("s", 1).ok && calls.charge("s", 1).ok);
  assert.ok(!calls.charge("s", 1).ok);
});

test("gateway charges the budget, refunds a failed provider call, and stops once exhausted without calling the provider", async () => {
  const b = new BudgetController({ tokens: 25 });
  let called = 0;
  const ok = provider(async () => { called++; return { summary: "s", claims: [] }; });
  const opts = { deadlineMs: 1000, budget: { controller: b, scope: "r" } };
  assert.ok((await runModel(ok, req(10), opts)).ok);
  assert.ok((await runModel(ok, req(10), opts)).ok);
  const stopped = await runModel(ok, req(10), opts);
  assert.ok(!stopped.ok && stopped.error.code === "BUDGET_EXCEEDED");
  assert.equal(called, 2);
  const b2 = new BudgetController({ tokens: 25 });
  const down = provider(async () => { throw new Error("down"); });
  await runModel(down, req(10), { deadlineMs: 1000, budget: { controller: b2, scope: "r" } });
  assert.equal(b2.status("r").tokens, 0, "a call that never reached the provider is not billed");
  void StubProvider;
});
