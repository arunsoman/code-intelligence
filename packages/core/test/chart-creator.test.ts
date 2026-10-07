import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import type { ChartOutput } from "@cie/schema";

const plan: ChartOutput = { chartType: "causal flow", layout: "flow", caption: "A deterministic code path", nodes: [], edges: [] };

test("generated chart plans persist across Store instances and reject malformed saved data", () => {
  const store = new Store(":memory:");
  store.saveGeneratedChartPlan("key", "bundle", "question", plan);
  assert.deepEqual(store.generatedChartPlan("key", "bundle", "question"), plan);
  assert.equal(store.generatedChartPlan("key", "other-bundle", "question"), null);
  assert.equal(store.generatedChartPlan("key", "bundle", "other question"), null);
  store.db.prepare("update generated_chart_plans set plan_json = ? where cache_key = ?").run("{}", "key");
  assert.equal(store.generatedChartPlan("key", "bundle", "question"), null);
  store.db.close();
});
