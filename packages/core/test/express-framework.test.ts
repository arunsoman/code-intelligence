import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { setup } from "./helpers.ts";

const EXPRESS_REPO = resolve(import.meta.dirname, "../../../fixtures/express-repo");

test("Express fixture: routes and middleware are extracted", async () => {
  const { svc, worker, revision } = await setup(undefined, EXPRESS_REPO);
  try {
    const facts = svc.store.allFacts(revision);
    const entities = svc.store.entities(revision);

    assert.ok(facts.some((f) => f.predicate === "route" && (f.object as any).value.path === "/health" && (f.object as any).value.method === "GET"));
    assert.ok(facts.some((f) => f.predicate === "route" && (f.object as any).value.path === "/login" && (f.object as any).value.method === "POST"));
    assert.ok(facts.some((f) => f.predicate === "route" && (f.object as any).value.path === "/" && (f.object as any).value.method === "GET"));
    assert.ok(facts.some((f) => f.predicate === "route" && (f.object as any).value.path === "/:id" && (f.object as any).value.method === "GET"));

    assert.ok(entities.some((e) => e.kind === "express_route" && e.name === "GET /health"));
    assert.ok(entities.some((e) => e.kind === "express_middleware" && e.name === "requireAuth"));
  } finally {
    worker.close();
  }
});

test("Express fixture: package.json config values are extracted", async () => {
  const { svc, worker, revision } = await setup(undefined, EXPRESS_REPO);
  try {
    const facts = svc.store.allFacts(revision);
    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "package.json:scripts:start"));
    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "package.json:dependencies:express"));
    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "package.json:name" && (f.object as any).value.value === "express-repo"));
  } finally {
    worker.close();
  }
});
