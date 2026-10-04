import assert from "node:assert/strict";
import { test } from "node:test";
import { ctx, demoRepo, setup } from "./helpers.ts";

test("concept extraction loads the repository's entities once, not once per chunk it sends to the model", async () => {
  process.env.CIE_CHUNK_TOKEN_BUDGET = "400";           // small requests, so the fixture is split into many chunks
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  let loads = 0; const original = svc.store.entities.bind(svc.store);
  svc.store.entities = (rev: string) => { loads++; return original(rev); };
  let requests = 0; const gen = svc["model"].generate.bind(svc["model"]);
  svc["model"].generate = async (req: any) => { if (req.purpose === "EXTRACT") requests++; return gen(req); };
  try { const r = await svc.extractConcepts(ctx(), { revision }); assert.ok(r.ok); } finally { delete process.env.CIE_CHUNK_TOKEN_BUDGET; }
  assert.ok(requests >= 4, `the fixture was split into ${requests} requests`);
  assert.ok(loads <= 3, `${loads} full loads of every entity for ${requests} model requests; each load parses every entity's JSON (14 s of a 37 s extraction on a 10,000-entity repository)`);
  worker.close();
});
