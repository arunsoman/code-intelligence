import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyFixture, ctx, setup } from "./helpers.ts";
import { overviewSeeds } from "../src/overview.ts";
import { ScriptRouter } from "../src/llm-router.ts";
import { render, basePositions } from "../../../apps/web/src/graph.ts";

test("project overview keeps Java visible beside a highly connected frontend, through both chat routes and zoom", async () => {
  const repo = copyFixture();
  mkdirSync(join(repo, "frontend"));
  writeFileSync(join(repo, "frontend/app.ts"), Array.from({ length: 45 }, (_, i) => `export function page${i}() { ${Array.from({ length: 45 }, (_, j) => `page${j}();`).join(" ")} }`).join("\n"));
  for (const module of ["accounts", "orders"]) {
    const dir = join(repo, module, "src/main/java/demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Controller.java"), `package demo; public class Controller { public String handle() { return "ok"; } }`);
  }
  const { svc, worker, revision } = await setup(undefined, repo);
  const oldBudget = process.env.CIE_CHUNK_TOKEN_BUDGET;
  process.env.CIE_CHUNK_TOKEN_BUDGET = "1000";
  try {
    const seeds = overviewSeeds(svc.store, revision);
    const entities = svc.store.entitiesById(revision, seeds);
    for (const module of ["accounts", "orders", "frontend"]) assert.ok(entities.some((e) => e.file.startsWith(module + "/")), module);
    const check = (view: Parameters<typeof render>[0]) => {
      for (const module of ["accounts", "orders"]) {
        assert.ok(view.nodes.some((n) => n.file.startsWith(module + "/") && n.file.endsWith(".java")), module);
        for (const level of [3, 4, 5]) {
          const rendered = render(view, level, basePositions(view));
          assert.ok(rendered.nodes.some((n) => n.members.some((id) => view.nodes.some((v) => v.id === id && v.file.startsWith(module + "/")))), `${module} at zoom ${level}`);
        }
      }
    };
    const direct = await svc.ask(ctx(), { question: "Explain this project", revision, overview: true, form: "SemanticMap", level: 1 });
    assert.ok(direct.ok); check(direct.value.view);
    const refreshed = await svc.refreshView(ctx(), { view: direct.value.view });
    assert.ok(refreshed.ok); check(refreshed.value.view);
    const single = await svc.converse(ctx(), { text: "Give me an overview of the whole project", revision });
    assert.ok(single.ok && single.value.kind === "view"); check(single.value.view);
    svc.router = new ScriptRouter({ "explain this project": { steps: [{ tool: "overview", question: "Explain this project" }] } });
    const planned = await svc.converse(ctx(), { text: "explain this project", revision });
    assert.ok(planned.ok && planned.value.kind === "analysis");
    check(planned.value.results[0].view!);
    svc.store.denyPath(repo, "accounts");
    assert.ok(!svc.store.entitiesById(revision, overviewSeeds(svc.store, revision)).some((e) => e.file.startsWith("accounts/")));
  } finally {
    if (oldBudget === undefined) delete process.env.CIE_CHUNK_TOKEN_BUDGET;
    else process.env.CIE_CHUNK_TOKEN_BUDGET = oldBudget;
    worker.close(); svc.store.db.close();
  }
});
