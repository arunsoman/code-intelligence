import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FeatureModelAdapter, generationRouteAllowed, interruptedModelInvocations, modelInvocationHash } from "../src/feature/model.ts";
import { OllamaGenerationRouter, type GenerationRequest, type GenerationResponse, type GenerationRouter } from "../src/llm-router.ts";
import { rawHash } from "../src/feature/canon.ts";
import { fresh } from "./feature-fixtures.ts";

const prompt = "Private request: add CSV export, restricted to the current tenant.";
const reqs = { requirements: [{ id: "R1", text: "Export only the current tenant's transactions", type: "ACCESS", sourceIndex: 0, actorIds: ["member"], conditions: ["current tenant"], dependsOn: [] }] };
const contract = { acceptance: [{ id: "AC1", requirementIds: ["R1"], scenario: "Member exports transactions", expectedOutcome: "CSV contains only current tenant rows", mandatory: true }], assumptions: [] };
const edits = { edits: [{ kind: "CREATE_FILE", path: "src/export.ts", baseHash: "", expected: "", replacement: "export const format = 'csv';\n", requirementIds: ["R1"] }] };
const responses = [reqs, contract, edits];
class Scripted implements GenerationRouter {
  provider = "scripted"; model = "local-model"; endpoint = "http://127.0.0.1:11434"; hosted = false;
  calls: GenerationRequest[] = [];
  onCall?: (req: GenerationRequest, index: number) => void;
  responder: (index: number) => Promise<GenerationResponse> = async (i) => ({ text: JSON.stringify(responses[i % 3]), resolvedVersion: "weights-v1" });
  async generate(req: GenerationRequest) { const index = this.calls.length; this.calls.push(req); this.onCall?.(req, index); return this.responder(index); }
}
function setup(options: ConstructorParameters<typeof FeatureModelAdapter>[2] = {}) {
  const { store, fs, make } = fresh();
  const record = make({ promptRef: { artifactId: "prompt:1", contentHash: rawHash(prompt), redactedPreview: "[private]" } });
  const route = new Scripted();
  const adapter = new FeatureModelAdapter(fs, record.requestId, { routes: [route], ...options });
  const input = { prompt, authorityPolicyHash: "policy:1", actor: "u" };
  return { store, fs, record, route, adapter, input };
}

test("PF-005/006 structured stages produce a versioned, attributed draft and exact edit plan without approval or mutation", async () => {
  const { fs, record, route, adapter, input } = setup();
  route.onCall = (_, index) => {
    const log = fs.getRequest(record.requestId)!.modelInvocations!;
    assert.equal(log.length, index * 2 + 1, "intent committed before provider sees data");
    assert.equal(log.at(-1)!.status, "STARTED"); assert.equal(log.at(-1)!.interrupted, true);
    assert.equal(interruptedModelInvocations(fs.getRequest(record.requestId)!).length, 1);
  };
  const result = await adapter.generate(input);
  assert.equal(result.status, "COMPLETE", JSON.stringify(result));
  const value = result.value!;
  assert.equal(value.draft.contract.version, 1);
  assert.equal(value.draft.contract.requirements[0].source.contentHash, rawHash(prompt));
  assert.equal(value.draft.contract.requirements[0].status, "PROPOSED");
  assert.equal(value.draft.contract.acceptance[0].oracleOrigin, "GENERATED_UNREVIEWED");
  assert.deepEqual(JSON.parse(JSON.stringify(value.edits)), edits.edits);
  assert.equal(value.invocationIds.length, 3);
  assert.match(value.generationProvenanceHash, /^pf-canon-v1\/pf.GenerationProvenance@1:[0-9a-f]{64}$/);
  const current = fs.getRequest(record.requestId)!;
  assert.equal(current.contractVersion, 0); assert.equal(current.contract, undefined);
  assert.equal(current.state, "RECEIVED"); assert.deepEqual(fs.listCandidates(record.requestId), []);
  const saved = current.modelInvocations!;
  assert.equal(saved.length, 6);
  for (const i of saved) assert.equal(i.identityHash, modelInvocationHash(i));
  assert.equal(saved[1].supersedesId, saved[0].id);
  assert.deepEqual(interruptedModelInvocations(current), []);
  assert.notEqual(saved[1].promptTemplateHash, saved[3].promptTemplateHash);
  assert.equal(saved[1].outputHash, rawHash(JSON.stringify(reqs)));
  assert.ok(saved[3].inputRefs.includes(saved[1].outputHash));
  assert.ok(!JSON.stringify(saved).includes(prompt), "raw prompts are not put in invocation records");
  assert.ok(!JSON.stringify(saved).includes(edits.edits[0].replacement));
});

test("AT-41 hidden revision remains UNKNOWN and queues model identity evaluation", async () => {
  const { adapter, input, route, fs, record } = setup();
  route.responder = async (i) => ({ text: JSON.stringify(responses[i]) });
  const result = await adapter.generate(input);
  assert.equal(result.status, "COMPLETE");
  const completed = fs.getRequest(record.requestId)!.modelInvocations!.filter((i) => i.status === "COMPLETE");
  assert.ok(completed.every((i) => i.resolvedVersion === "UNKNOWN"));
  assert.ok(result.diagnostics.some((d) => d.includes("UNKNOWN")));
  assert.equal(fs.listEvents(record.requestId).filter((e) => e.type === "ModelIdentityChanged").length, 3);
  assert.equal(fs.getRequest(record.requestId)!.state, "RECEIVED");
});

test("AT-41 resolved provider revision change emits an identity event without rewriting deterministic state", async () => {
  const { adapter, input, route, fs, record } = setup();
  route.responder = async (i) => ({ text: JSON.stringify(responses[i % 3]), resolvedVersion: i < 3 ? "v1" : "v2", weightDigest: i < 3 ? "digest-1" : "digest-2" });
  assert.equal((await adapter.generate(input)).status, "COMPLETE");
  assert.equal((await adapter.generate(input)).status, "COMPLETE");
  const events = fs.listEvents(record.requestId).filter((e) => e.type === "ModelIdentityChanged");
  assert.equal(events.length, 1); assert.notEqual(events[0].before, events[0].after);
  assert.equal(fs.getRequest(record.requestId)!.state, "RECEIVED");
});

test("AT-42 local failure persists interruption and never calls cloud fallback; deterministic work stays ready", async () => {
  const local = new Scripted(), cloud = new Scripted(); cloud.hosted = true; cloud.model = "model:cloud";
  local.responder = async () => { throw new Error(`provider leaked secret: ${prompt}`); };
  const { adapter, input, fs, record } = setup({ routes: [local, cloud] });
  const result = await adapter.generate(input);
  assert.equal(result.status, "FAILED"); assert.equal(cloud.calls.length, 0);
  const current = fs.getRequest(record.requestId)!;
  assert.equal(current.state, "RECEIVED"); assert.deepEqual(current.blockers, []);
  assert.equal(current.modelInvocations!.length, 2);
  assert.equal(current.modelInvocations![1].status, "FAILED"); assert.equal(current.modelInvocations![1].interrupted, true);
  assert.ok(!JSON.stringify(result).includes(prompt));
  assert.ok(!JSON.stringify(current.modelInvocations).includes(prompt));
});

test("egress checks actual destination and hosted model alias before every attempt", async () => {
  for (const [endpoint, hosted, model] of [
    ["https://cloud.example", false, "local"], ["http://127.0.0.1", false, "model:cloud"],
    ["http://127.0.0.1", true, "local"], ["http://localhost", false, "local"],
    ["file:///tmp/model", false, "local"], ["http://user:pass@127.0.0.1", false, "local"],
  ] as const) {
    const route = new Scripted(); Object.assign(route, { endpoint, hosted, model });
    assert.equal(generationRouteAllowed(route, "LOCAL_ONLY"), false);
    const s = setup({ routes: [route] });
    assert.equal((await s.adapter.generate(s.input)).status, "FAILED"); assert.equal(route.calls.length, 0);
    assert.equal(s.fs.getRequest(s.record.requestId)!.modelInvocations, undefined);
  }
  const ipv6 = new Scripted(); ipv6.endpoint = "http://[::1]:11434";
  assert.equal(generationRouteAllowed(ipv6, "LOCAL_ONLY"), true);
});

test("explicit cloud permission allows bounded fallback and records the actual provider", async () => {
  const local = new Scripted(), cloud = new Scripted(); cloud.hosted = true; cloud.provider = "cloud"; cloud.model = "model:cloud";
  local.responder = async () => { throw new Error("offline"); };
  const { adapter, input, fs, record } = setup({ routes: [local, cloud], egress: "CLOUD_ALLOWED" });
  assert.equal((await adapter.generate(input)).status, "COMPLETE");
  assert.equal(local.calls.length, 3); assert.equal(cloud.calls.length, 3);
  assert.equal(fs.getRequest(record.requestId)!.modelInvocations!.filter((i) => i.status === "COMPLETE" && i.provider === "cloud").length, 3);
  assert.ok(fs.listEvents(record.requestId).some((e) => e.type === "ModelIdentityChanged"), "fallback queues dependent quality reassessment");
});

test("local fallback stays local and token reservations are shared across stage attempts", async () => {
  const first = new Scripted(), second = new Scripted(); second.model = "fallback-local";
  first.responder = async () => { throw new Error("offline"); };
  const s = setup({ routes: [first, second] });
  assert.equal((await s.adapter.generate(s.input)).status, "COMPLETE");
  assert.equal(first.calls[0].maxOutputTokens + second.calls[0].maxOutputTokens, 8192);
  assert.ok(s.fs.listEvents(s.record.requestId).some((e) => e.type === "ModelIdentityChanged"));
});

test("frozen C14 invocation API persists identity, input refs, parameters and UNKNOWN revision", () => {
  const s = setup();
  const ctx = { requestId: "call-trace", idempotencyKey: "key", actor: { principalId: "u", tenantId: "t", sessionId: "s" }, deadlineMs: Date.now() + 1000, traceId: "trace" };
  const input: Parameters<typeof s.adapter.recordModelInvocation>[1] = {
    modelIdentity: { provider: "scripted", model: "named-model", requestedVersion: "alias", resolvedVersion: "UNKNOWN", parameters: {}, inputRefs: [], toolSchemaVersions: ["schema@1"], promptTemplateHash: "template", startedAt: "2026-10-05T00:00:00Z", egress: "LOCAL_ONLY" },
    parameters: { temperature: 0.25, seed: 7 }, inputRefs: ["input-hash"], outputHash: "output-hash",
  };
  const invocation = s.adapter.recordModelInvocation(ctx, input);
  assert.equal(invocation.resolvedVersion, "UNKNOWN"); assert.equal(invocation.parameters.temperature, 0.25);
  assert.equal(invocation.identityHash, modelInvocationHash(invocation));
  assert.deepEqual(s.fs.getRequest(s.record.requestId)!.modelInvocations![0], invocation);
  assert.deepEqual(s.adapter.recordModelInvocation(ctx, input), invocation);
  assert.equal(s.fs.getRequest(s.record.requestId)!.modelInvocations!.length, 1);
  assert.throws(() => s.adapter.recordModelInvocation(ctx, { ...input, outputHash: "other" }), /INVOCATION_CONFLICT/);
});

test("input, output, attempt and wall-clock budgets stop generation", async () => {
  const s = setup({ budgets: { REQUIREMENTS: { inputTokens: 1 } } });
  assert.equal((await s.adapter.generate(s.input)).diagnostics[0], "INPUT_BUDGET_EXCEEDED"); assert.equal(s.route.calls.length, 0);
  const badUsage = setup(); badUsage.route.responder = async () => ({ text: JSON.stringify(reqs), outputTokens: 999999 });
  assert.equal((await badUsage.adapter.generate(badUsage.input)).diagnostics[0], "TOKEN_BUDGET_EXCEEDED");
  const first = new Scripted(), second = new Scripted(); first.responder = async () => { throw new Error("offline"); };
  const limited = setup({ routes: [first, second], budgets: { REQUIREMENTS: { attempts: 1 } } });
  assert.equal((await limited.adapter.generate(limited.input)).status, "FAILED"); assert.equal(second.calls.length, 0);
  const stuck = new Scripted(); stuck.responder = async () => new Promise(() => {});
  const timeout = setup({ routes: [stuck], budgets: { REQUIREMENTS: { timeoutMs: 10 } } });
  // Keep the test process alive; production has its HTTP server. AbortSignal.timeout is unref'd.
  const keepAlive = setTimeout(() => {}, 1000);
  try { assert.equal((await timeout.adapter.generate(timeout.input)).diagnostics[0], "PROVIDER_TIMEOUT"); }
  finally { clearTimeout(keepAlive); }
  assert.equal(timeout.fs.getRequest(timeout.record.requestId)!.modelInvocations!.at(-1)!.status, "FAILED");
});

test("untrusted output cannot smuggle tools or authority, duplicate JSON keys, or forged references", async () => {
  for (const text of [
    '{"requirements":[],"requirements":[]}',
    JSON.stringify({ ...reqs, tools: ["shell"] }),
    JSON.stringify({ requirements: [{ ...reqs.requirements[0], sourceIndex: 99 }] }),
    JSON.stringify({ requirements: [{ ...reqs.requirements[0], dependsOn: ["invented"] }] }),
    JSON.stringify({ requirements: [reqs.requirements[0], reqs.requirements[0]] }),
  ]) {
    const s = setup(); s.route.responder = async () => ({ text });
    assert.equal((await s.adapter.generate(s.input)).status, "FAILED"); assert.equal(s.route.calls.length, 1);
  }
});

test("edit plan validates paths, attribution and quoted base bytes", async () => {
  for (const over of [{ path: "../escape" }, { path: ".git/config" }, { requirementIds: ["unknown"] }, { kind: "REPLACE_SPAN", baseHash: "invented", expected: "x" }]) {
    const s = setup(); s.route.responder = async (i) => ({ text: JSON.stringify(i === 2 ? { edits: [{ ...edits.edits[0], ...over }] } : responses[i]) });
    assert.equal((await s.adapter.generate(s.input)).status, "FAILED");
  }
  const source = "export const n = 1;\n";
  const s = setup(); s.route.responder = async (i) => ({ text: JSON.stringify(i === 2 ? { edits: [{ ...edits.edits[0], kind: "REPLACE_SPAN", path: "src/n.ts", baseHash: rawHash(source), expected: "n = 1", replacement: "n = 2" }] } : responses[i]) });
  const result = await s.adapter.generate({ ...s.input, context: [{ text: source, ref: { artifactId: "file:1", locator: "src/n.ts", version: "base", contentHash: rawHash(source) } }] });
  assert.equal(result.status, "COMPLETE", JSON.stringify(result));
});

test("cancelled and stale requests return no usable generation result", async () => {
  const s = setup(); const abort = new AbortController();
  s.route.onCall = () => abort.abort();
  assert.equal((await s.adapter.generate({ ...s.input, signal: abort.signal })).status, "CANCELLED");
  assert.equal(s.route.calls.length, 1);
  const stale = setup(); stale.route.onCall = (_, i) => { if (i !== 2) return; const r = stale.fs.getRequest(stale.record.requestId)!; stale.fs.updateRequest(r.requestId, r.version, { ...r, contractVersion: r.contractVersion + 1 }); };
  const result = await stale.adapter.generate(stale.input);
  assert.equal(result.status, "STALE"); assert.equal(result.value, undefined);
});

test("input hashes and request ownership are checked before any provider call", async () => {
  const s = setup();
  assert.equal((await s.adapter.generate({ ...s.input, prompt: "different" })).diagnostics[0], "INPUT_HASH_MISMATCH");
  await assert.rejects(s.adapter.generate({ ...s.input, actor: "stranger" }), /FORBIDDEN/);
  assert.equal(s.route.calls.length, 0);
});

test("Ollama generation transport sends schema/token limits and refuses redirects", async () => {
  const seen: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    seen.push(JSON.parse(body));
    if (seen.length === 2) { res.writeHead(302, { location: "/other" }); res.end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: { content: JSON.stringify(reqs) }, prompt_eval_count: 12, eval_count: 24 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const router = new OllamaGenerationRouter({ model: "test", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const request = { system: "system", user: "user", schema: { type: "object" }, maxInputTokens: 2048, maxOutputTokens: 99, maxOutputBytes: 4096, signal: AbortSignal.timeout(3000) };
    const response = await router.generate(request);
    assert.equal(response.resolvedVersion, undefined); assert.equal(response.outputTokens, 24);
    assert.equal(seen[0].options.num_predict, 99); assert.deepEqual(seen[0].format, request.schema);
    assert.equal(seen[0].options.num_ctx, 2147);
    await assert.rejects(router.generate(request)); assert.equal(seen.length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
});
