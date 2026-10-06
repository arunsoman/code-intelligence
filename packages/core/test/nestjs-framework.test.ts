import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { setup } from "./helpers.ts";
import { guards } from "../src/forms/analysis.ts";
import { flowGraph } from "../src/forms/common.ts";

const NESTJS_REPO = resolve(import.meta.dirname, "../../../fixtures/nestjs-repo");

test("NestJS fixture: framework metadata becomes facts and relationships", async () => {
  const { svc, worker, revision } = await setup(undefined, NESTJS_REPO);
  try {
    const facts = svc.store.allFacts(revision);
    const rels = svc.store.allRelationships(revision);
    const entities = svc.store.entities(revision);

    // Framework roles annotate existing class entities.
    assert.ok(facts.some((f) => f.predicate === "framework_role" && (f.object as any).value.role === "module" && f.subject.includes("AppModule")));
    assert.ok(facts.some((f) => f.predicate === "framework_role" && (f.object as any).value.role === "controller" && f.subject.includes("UsersController")));
    assert.ok(facts.some((f) => f.predicate === "framework_role" && (f.object as any).value.role === "provider" && f.subject.includes("UsersService")));
    // Guard class implementing CanActivate.
    assert.ok(facts.some((f) => f.predicate === "framework_role" && (f.object as any).value.role === "guard" && f.subject.includes("AuthGuard")));

    // Route facts include controller prefix.
    assert.ok(facts.some((f) => f.predicate === "route" && (f.object as any).value.path === "/users" && (f.object as any).value.method === "GET"));
    assert.ok(facts.some((f) => f.predicate === "route" && (f.object as any).value.path === "/users/:id" && (f.object as any).value.method === "GET"));
    assert.ok(entities.some((e) => e.kind === "nestjs_route" && e.name.includes("GET")));

    // Constructor injection resolved to concrete classes.
    assert.ok(rels.some((r) => r.kind === "injects" && r.from.includes("UsersController") && r.to.includes("UsersService")));
    assert.ok(rels.some((r) => r.kind === "injects" && r.from.includes("AuthGuard") && r.to.includes("ConfigService")));

    // Controller exposes route.
    assert.ok(rels.some((r) => r.kind === "exposes_route" && r.from.includes("UsersController") && r.label?.includes("/users")));

    // Module contains controllers/providers across files.
    assert.ok(rels.some((r) => r.kind === "contains" && r.from.includes("UsersModule") && r.to.includes("UsersController")));
    assert.ok(rels.some((r) => r.kind === "contains" && r.from.includes("UsersModule") && r.to.includes("UsersService")));
    assert.ok(rels.some((r) => r.kind === "contains" && r.from.includes("AppModule") && r.to.includes("UsersModule")));
  } finally {
    worker.close();
  }
});

test("NestJS fixture: guards() recognises @UseGuards and CanActivate guards", async () => {
  const { svc, worker, revision } = await setup(undefined, NESTJS_REPO);
  try {
    const flow = flowGraph(svc.store, revision);
    const g = guards(svc.store, revision, flow);
    const guardIds = [...g.keys()];
    assert.ok(guardIds.some((id) => id.includes("AuthGuard")), `guards: ${guardIds.join(", ")}`);
    const fwGuard = guardIds.find((id) => id.includes("AuthGuard"))!;
    assert.equal(g.get(fwGuard)!.frameworkGuard, true);
  } finally {
    worker.close();
  }
});

test("NestJS fixture: config values and env are extracted", async () => {
  const { svc, worker, revision } = await setup(undefined, NESTJS_REPO);
  try {
    const facts = svc.store.allFacts(revision);

    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "package.json:scripts:start"));
    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "package.json:dependencies:@nestjs/common"));
    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "tsconfig.json:compilerOptions:strict" && (f.object as any).value.value === true));
    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "env:.env:DATABASE_URL"));
  } finally {
    worker.close();
  }
});
