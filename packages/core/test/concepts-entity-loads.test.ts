import assert from "node:assert/strict";
import { test } from "node:test";
import { StubProvider } from "@cie/model";
import { ctx, demoRepo, setup } from "./helpers.ts";

test("hierarchy generation computes concepts structurally; the model only suggests names", async (t) => {
  const purposes: string[] = [];
  const inner = new StubProvider();
  const { svc, worker, revision } = await setup({ name: "spy", model: "test", hosted: false,
    generate(req) { purposes.push(req.purpose); return inner.generate(req); } }, demoRepo());
  t.after(() => { worker.close(); svc.store.db.close(); });
  const result = await svc.buildConceptHierarchy(ctx(), { revision });
  assert.ok(result.ok && result.value.concepts.length > 0);
  assert.ok(purposes.length > 0);
  assert.ok(purposes.every((p) => p === "NAME_CONCEPT" || p === "NAME_ARCH"));
  assert.ok(result.value.concepts.every((c) => c.source !== "MODEL"));
});
