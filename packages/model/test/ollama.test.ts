import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { EvidenceBundle, ModelRequest } from "@cie/schema";
import { OllamaProvider, createProvider, hasModel, listInstalledModels, resolveModel, runModel } from "../src/index.ts";

const bundle: EvidenceBundle = {
  id: "b", revision: "r", evidence: [], entities: [{ entityId: "f:a", kind: "function", name: "a", file: "a.ts", spans: [] }],
  relationships: [], facts: [], coverage: [], unresolved: [], tokenEstimate: 10,
};
const req: ModelRequest = { purpose: "EXPLAIN", schemaId: "explanation.v1", question: "q", bundle, selected: ["f:a"] };

const readJson = (r: IncomingMessage) => new Promise<any>((res) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(JSON.parse(b || "{}"))); });

async function fake(replies: string[], models = ["m:cloud"]) {
  const seen: any[] = [];
  const srv = createServer(async (rq, rs) => {
    if (rq.url === "/api/tags") { rs.end(JSON.stringify({ models: models.map((name) => ({ name })) })); return; }
    const body = await readJson(rq); seen.push(body);
    rs.end(JSON.stringify({ message: { content: replies[Math.min(seen.length - 1, replies.length - 1)] } }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, close: () => srv.close() };
}

test("sends the registry schema as format and in the prompt; accepts a valid reply", async () => {
  const f = await fake([JSON.stringify({ summary: "s", claims: [] })]);
  const out = await runModel(new OllamaProvider({ baseUrl: f.url, model: "m:cloud" }), req);
  assert.ok(out.ok);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].model, "m:cloud");
  assert.equal(f.seen[0].stream, false);
  assert.ok(f.seen[0].format.properties.summary, "JSON schema passed as format");
  assert.match(f.seen[0].messages[1].content, /"assertion"/, "schema repeated in prompt");
  f.close();
});

test("one repair retry feeds validation errors back, then succeeds", async () => {
  const f = await fake([JSON.stringify({ summary: "s", claims: [{ claim: "x", claimClass: "c", evidenceIds: [] }] }), JSON.stringify({ summary: "s", claims: [] })]);
  const out = await runModel(new OllamaProvider({ baseUrl: f.url, model: "m:cloud" }), req);
  assert.ok(out.ok);
  assert.equal(f.seen.length, 2);
  assert.match(f.seen[1].messages.at(-1).content, /did not match the schema.*assertion/);
  f.close();
});

test("persistently invalid output fails as PROVIDER_UNAVAILABLE, never passes through", async () => {
  const f = await fake(["not json at all"]);
  const out = await runModel(new OllamaProvider({ baseUrl: f.url, model: "m:cloud" }), req);
  assert.ok(!out.ok && out.error.code === "PROVIDER_UNAVAILABLE");
  assert.equal(f.seen.length, 2);
  f.close();
});

test("factory: uses ollama when the model is installed, otherwise falls back to the stub with a note", async () => {
  const f = await fake([], ["m:cloud"]);
  const ok = await createProvider({ baseUrl: f.url, model: "m:cloud" });
  assert.equal(ok.provider.name, "ollama"); assert.equal(ok.note, undefined);
  const missing = await createProvider({ baseUrl: f.url, model: "other:cloud" });
  assert.equal(missing.provider.name, "stub"); assert.match(missing.note ?? "", /not installed/);
  const down = await createProvider({ baseUrl: "http://127.0.0.1:1", model: "m:cloud" });
  assert.equal(down.provider.name, "stub"); assert.match(down.note ?? "", /unreachable/);
  const none = await createProvider({ baseUrl: f.url });
  assert.equal(none.provider.name, "stub"); assert.match(none.note ?? "", /no Ollama model selected/);
  assert.equal((await createProvider({ which: "stub" })).provider.name, "stub");
  await assert.rejects(createProvider({ which: "bogus" }));
  f.close();
});

test("listInstalledModels reports what ollama list has, or null when it cannot be reached", async () => {
  const f = await fake([], ["a:cloud", "b"]);
  assert.deepEqual(await listInstalledModels(f.url), ["a:cloud", "b"]);
  assert.equal(await listInstalledModels("http://127.0.0.1:1"), null);
  assert.ok(hasModel(["b"], "b") && hasModel(["b:latest"], "b") && !hasModel(["b"], "c"));
  f.close();
});

test("resolveModel keeps the persisted model while it is installed, otherwise picks the first installed one and says so; nothing installed means no model at all", async () => {
  const f = await fake([], ["a:cloud", "b"]);
  assert.deepEqual(await resolveModel("b", f.url), { model: "b", installed: ["a:cloud", "b"], picked: false });
  const gone = await resolveModel("c", f.url);
  assert.deepEqual(gone, { model: "a:cloud", installed: ["a:cloud", "b"], picked: true, note: gone.note });
  assert.match(gone.note!, /"c" is no longer installed.*using a:cloud/);
  const fresh = await resolveModel(null, f.url);
  assert.equal(fresh.model, "a:cloud"); assert.equal(fresh.picked, true); assert.match(fresh.note!, /no model has been selected yet/);
  // The daemon cannot be asked, so a persisted choice is trusted rather than discarded.
  const unreachable = await resolveModel("b", "http://127.0.0.1:1");
  assert.deepEqual(unreachable, { model: "b", installed: null, picked: false });
  const empty = await fake([], []);
  const none = await resolveModel(null, empty.url);
  assert.equal(none.model, null); assert.match(none.note!, /no Ollama model is installed/);
  empty.close(); f.close();
});
