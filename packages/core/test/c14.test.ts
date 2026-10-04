import assert from "node:assert/strict";
import { test } from "node:test";
import { StubProvider } from "@cie/model";
import type { ModelProvider, ModelRequest } from "@cie/schema";
import { ctx, setup } from "./helpers.ts";

class Hosted implements ModelProvider {
  readonly name = "cloud"; readonly model = "x"; readonly hosted = true;
  seen: ModelRequest[] = []; private inner = new StubProvider();
  async generate(r: ModelRequest) { this.seen.push(r); return this.inner.generate(r); }
}
const FIXTURE = new URL("../../../fixtures/sample-repo", import.meta.url).pathname;

test("local-model feature degradation: when the hosted budget is exhausted the offline model answers, says why, and nothing is sent", async () => {
  process.env.CIE_HOSTED_TOKEN_BUDGET = "1";
  const hosted = new Hosted();
  let t: Awaited<ReturnType<typeof setup>>;
  try { t = await setup(hosted, FIXTURE); } finally { delete process.env.CIE_HOSTED_TOKEN_BUDGET; }
  const { svc, worker, revision } = t;
  const repoRoot = svc.store.revision(revision)!.repoRoot;
  svc.setEgress(ctx(), { repoRoot, allow: true });
  const r = await svc.ask(ctx(), { question: "show me how authentication works", revision });
  assert.ok(r.ok, "the question is still answered");
  assert.ok(r.metadata.warnings.some((w) => /budget .* used up/.test(w)), r.metadata.warnings.join("|"));
  assert.equal(hosted.seen.length, 0, "an over-budget request never reaches the hosted provider");
  assert.ok((svc.auditLog(ctx(), {}) as any).value.events.some((e: any) => e.action === "budget.exhausted"));
  // Opting in does not lift a zero overage ceiling.
  svc.budget.optIn(repoRoot);
  const again = await svc.ask(ctx(), { question: "show me how authentication works", revision });
  assert.ok(again.ok && again.metadata.warnings.some((w) => /ceiling|budget/.test(w)));
  assert.equal(hosted.seen.length, 0);
  worker.close();
});

test("with budget available the hosted provider is used and charged", async () => {
  const hosted = new Hosted();
  const { svc, worker, revision } = await setup(hosted, FIXTURE);
  const repoRoot = svc.store.revision(revision)!.repoRoot;
  svc.setEgress(ctx(), { repoRoot, allow: true });
  const r = await svc.ask(ctx(), { question: "show me how authentication works", revision });
  assert.ok(r.ok && hosted.seen.length > 0);
  assert.ok(svc.budget.status(repoRoot).calls > 0);
  worker.close();
});
