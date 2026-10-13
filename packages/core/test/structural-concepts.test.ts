// The Service/API surface for structural concept clusters (store.ts's concepts/concept_members/concept_revisions
// tables, populated from the worker's zero-LLM shape/framework-role clustering). Runs hermetically: entities and
// conceptClusters are injected directly via putBatch; the worker is never called.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalysisBatch } from "@cie/schema";
import { setupService } from "./concept-hierarchy-helpers.ts";
import { ctx as testCtx } from "./helpers.ts";

test("structuralConcepts resolves a worker-found cluster's members by id, and is empty with no revision", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cie-structural-"));
  const { svc, store, worker } = setupService(repo);
  try {
    const batch: AnalysisBatch = {
      revision: "rev-a", gitHead: null, repoRoot: repo, analyzerVersion: "concept-test", manifest: {},
      entities: [
        { entityId: "enum:a.ts#UserTypeEnum", kind: "enum", name: "UserTypeEnum", file: "a.ts", spans: [] },
        { entityId: "enum:b.ts#AccountTypeEnum", kind: "enum", name: "AccountTypeEnum", file: "b.ts", spans: [] },
      ],
      facts: [], relationships: [], diagnostics: [],
      conceptClusters: [{ clusterId: "concept:abc", kind: "exact-shape", memberEntityIds: ["enum:a.ts#UserTypeEnum", "enum:b.ts#AccountTypeEnum"], heuristicName: "UserTypeEnum" }],
    };
    store.putBatch(batch);
    const ctx = testCtx();
    const r = await svc.structuralConcepts(ctx, { revision: "rev-a" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.clusters.length, 1);
    const c = r.value.clusters[0];
    assert.equal(c.kind, "exact-shape");
    assert.equal(c.name, "UserTypeEnum");
    assert.deepEqual(c.members.map((m) => m.name).sort(), ["AccountTypeEnum", "UserTypeEnum"]);
    assert.ok(c.members.every((m) => m.kind === "enum" && m.file));

    const none = await svc.structuralConcepts(ctx, { revision: "no-such-revision-and-no-latest" });
    assert.ok(!none.ok);
  } finally { worker.close(); store.db.close(); }
});
