import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { setup } from "./helpers.ts";

const NEXTJS_REPO = resolve(import.meta.dirname, "../../../fixtures/nextjs-repo");

test("Next.js fixture: app/pages routes and server actions are extracted", async () => {
  const { svc, worker, revision } = await setup(undefined, NEXTJS_REPO);
  try {
    const facts = svc.store.allFacts(revision);
    const entities = svc.store.entities(revision);

    assert.ok(facts.some((f) => f.predicate === "route" && (f.object as any).value.path === "/" && (f.object as any).value.method === "GET"));
    assert.ok(facts.some((f) => f.predicate === "route" && (f.object as any).value.path === "/users/:id" && (f.object as any).value.method === "GET"));
    assert.ok(facts.some((f) => f.predicate === "route" && (f.object as any).value.path === "/api/users" && (f.object as any).value.method === "GET"));
    assert.ok(facts.some((f) => f.predicate === "route" && (f.object as any).value.path === "/api/users" && (f.object as any).value.method === "POST"));
    assert.ok(facts.some((f) => f.predicate === "route" && (f.object as any).value.path === "/blog/:slug" && (f.object as any).value.method === "GET"));

    assert.ok(entities.some((e) => e.kind === "nextjs_route" && e.name.includes("/users/:id")));
    assert.ok(facts.some((f) => f.predicate === "route" && (f.object as any).value.kind === "server_action"));
  } finally {
    worker.close();
  }
});

test("Next.js fixture: tsconfig.json and env config values are extracted", async () => {
  const { svc, worker, revision } = await setup(undefined, NEXTJS_REPO);
  try {
    const facts = svc.store.allFacts(revision);
    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "tsconfig.json:compilerOptions:strict" && (f.object as any).value.redacted === true));
    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "env:.env.local:DATABASE_URL"));
    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "package.json:dependencies:next"));
  } finally {
    worker.close();
  }
});
