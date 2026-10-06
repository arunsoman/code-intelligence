import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { setup, ctx } from "./helpers.ts";
import { guards } from "../src/forms/analysis.ts";
import { flowGraph } from "../src/forms/common.ts";
import { buildRouteMap } from "../src/forms/routemap.ts";
import { CHAT_TOOLS } from "../src/chat-tools.ts";

const NESTJS_REPO = resolve(import.meta.dirname, "../../../fixtures/nestjs-repo");

const toolRun = (name: string) => {
  const t = CHAT_TOOLS.find((x) => x.name === name);
  if (!t || !t.run) throw new Error(`tool ${name} not found`);
  return t.run;
};

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
    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "tsconfig.json:compilerOptions:strict" && (f.object as any).value.redacted === true));
    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "env:.env:DATABASE_URL"));
  } finally {
    worker.close();
  }
});

test("NestJS fixture: RouteMap form exposes routes and guards", async () => {
  const { svc, worker, revision } = await setup(undefined, NESTJS_REPO);
  try {
    const rev = svc.store.revision(revision)!;
    const built = buildRouteMap(svc.store, rev, "What endpoints does this service expose?");
    assert.ok(built.view.nodes.some((n) => n.role === "route" && n.label.includes("GET /users")));
    assert.ok(built.view.nodes.some((n) => n.role === "guard" && n.label.includes("AuthGuard")));
    assert.ok(built.view.matrix, "RouteMap should produce a matrix");
    assert.ok(built.view.matrix!.cells.some((c) => c.state === "guarded"));
  } finally {
    worker.close();
  }
});

test("NestJS fixture: chat tools expose framework metadata", async () => {
  const { svc, worker, revision } = await setup(undefined, NESTJS_REPO);
  try {
    const rev = svc.store.revision(revision)!;
    const access = { denied: () => false } as any;
    const env = { svc, ctx: ctx(), rev, access, seen: new Map(), results: [], warnings: [], pins: undefined, currentSubject: undefined };

    const routes = await toolRun("get_routes")(env, {});
    assert.match(routes, /GET \/users/);
    const filtered = await toolRun("get_routes")(env, { method: "POST" });
    assert.doesNotMatch(filtered, /GET \/users/);

    const guards = await toolRun("get_guards")(env, {});
    assert.match(guards, /AuthGuard/);

    const graph = await toolRun("get_module_graph")(env, { module: "AppModule" });
    assert.match(graph, /AppModule/);

    const config = await toolRun("get_config")(env, { key: "DATABASE_URL" });
    assert.match(config, /DATABASE_URL/);
  } finally {
    worker.close();
  }
});
