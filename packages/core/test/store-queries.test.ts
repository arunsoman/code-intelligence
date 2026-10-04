import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "./helpers.ts";

test("relationshipsFor uses an index per side, and returns each relationship once (a self-reference included)", async () => {
  const { svc, worker, revision } = await setup();
  const db = (svc.store as any).db;
  // The version with `from_id = ? or to_id = ?` was planned as a scan of the whole revision, once per entity: minutes of blocked event loop on a 10,000-entity repository.
  const plan = db.prepare("explain query plan select json from relationships where revision = ? and from_id = ? union all select json from relationships where revision = ? and to_id = ? and from_id <> ?").all("r", "a", "r", "a", "a").map((p: any) => p.detail).join("\n");
  assert.match(plan, /rel_from \(revision=\? AND from_id=\?\)/);
  assert.match(plan, /rel_to \(revision=\? AND to_id=\?\)/);
  let checked = 0;
  for (const e of svc.store.entities(revision).slice(0, 60)) {
    const got = svc.store.relationshipsFor(revision, e.entityId).map((r) => r.id);
    const want = (db.prepare("select id from relationships where revision = ? and (from_id = ? or to_id = ?)").all(revision, e.entityId, e.entityId) as any[]).map((r) => r.id);
    assert.deepEqual([...got].sort(), [...want].sort(), e.entityId);
    assert.equal(new Set(got).size, got.length, "no relationship twice");
    checked += got.length;
  }
  assert.ok(checked > 0);
  worker.close();
});
