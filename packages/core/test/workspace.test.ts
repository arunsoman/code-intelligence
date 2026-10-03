import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { copyFixture, ctx, setup } from "./helpers.ts";
import type { SavedState } from "@cie/schema";

const emptyState = (q = ""): SavedState => ({ question: q, view: null, claims: [], selection: [], explanation: null, events: [] });

test("idempotent replay returns the same receipt; different payload with same key conflicts", async () => {
  const { svc, worker, revision } = await setup();
  const key = "idem-1";
  const a = svc.saveWorkspace(ctx(key), { workspaceId: "ws:1", name: "A", expectedVersion: 0, revision, state: emptyState() });
  assert.ok(a.ok && !a.value.replayed && a.value.receipt.resourceVersion === 1);
  const again = svc.saveWorkspace(ctx(key), { workspaceId: "ws:1", name: "A", expectedVersion: 0, revision, state: emptyState() });
  assert.ok(again.ok && again.value.replayed);
  assert.equal(again.value.receipt.transactionId, a.value.receipt.transactionId);
  const clash = svc.saveWorkspace(ctx(key), { workspaceId: "ws:1", name: "B", expectedVersion: 0, revision, state: emptyState() });
  assert.ok(!clash.ok && clash.error.code === "VERSION_CONFLICT");
  assert.equal(svc.journal.replay("ws:1", 0).length, 1, "replay did not re-execute");
  worker.close();
});

test("stale expectedVersion is rejected with currentVersion", async () => {
  const { svc, worker, revision } = await setup();
  assert.ok(svc.saveWorkspace(ctx(), { workspaceId: "ws:2", name: "A", expectedVersion: 0, revision, state: emptyState() }).ok);
  const stale = svc.saveWorkspace(ctx(), { workspaceId: "ws:2", name: "A2", expectedVersion: 0, revision, state: emptyState() });
  assert.ok(!stale.ok && stale.error.code === "VERSION_CONFLICT" && stale.error.currentVersion === 1);
  const good = svc.saveWorkspace(ctx(), { workspaceId: "ws:2", name: "A2", expectedVersion: 1, revision, state: emptyState() });
  assert.ok(good.ok && good.value.receipt.resourceVersion === 2);
  worker.close();
});

test("missing idempotency key is rejected", async () => {
  const { svc, worker } = await setup();
  const r = svc.saveWorkspace(ctx(""), { name: "A", expectedVersion: 0, state: emptyState() });
  assert.ok(!r.ok && r.error.code === "INVALID_SCHEMA");
  worker.close();
});

test("save → reopen restores state; changed source marks evidence stale", async () => {
  const repo = copyFixture();
  const { svc, worker, revision } = await setup(undefined, repo);
  const asked = await svc.ask(ctx(), { question: "authentication", revision });
  assert.ok(asked.ok);
  const sel = asked.value.view.nodes.slice(0, 2).map((n) => n.entityRefs[0]);
  const ex = await svc.explain(ctx(), { revision, entityIds: sel });
  assert.ok(ex.ok);
  const saved = svc.saveWorkspace(ctx(), { name: "Auth Understanding", expectedVersion: 0, revision, state: { question: "authentication", view: asked.value.view, claims: asked.value.claims, selection: sel, explanation: ex.value, events: [] } });
  assert.ok(saved.ok);

  const fresh = svc.openWorkspace(ctx(), { workspaceId: saved.value.workspaceId });
  assert.ok(fresh.ok);
  assert.equal(fresh.value.name, "Auth Understanding");
  assert.equal(fresh.value.state.view?.id, asked.value.view.id);
  assert.deepEqual(fresh.value.staleEvidence, []);

  appendFileSync(join(repo, "src/auth/token.ts"), "\n// edited after save\n");
  const after = svc.openWorkspace(ctx(), { workspaceId: saved.value.workspaceId });
  assert.ok(after.ok);
  assert.ok(after.value.staleEvidence.length > 0);
  assert.deepEqual(after.value.staleFiles, ["src/auth/token.ts"]);
  assert.ok(after.metadata.warnings.length > 0);
  worker.close();
});

test("re-indexing changed source yields a new revision; old revision stays readable", async () => {
  const repo = copyFixture();
  const { svc, worker, revision } = await setup(undefined, repo);
  appendFileSync(join(repo, "src/db/users.ts"), "\nexport function extra() { return getUser('x'); }\n");
  const r2 = await svc.ingestRepository(ctx(), { repoPath: repo });
  assert.ok(r2.ok && r2.value.id !== revision);
  assert.ok(svc.status(ctx(), { revision }).ok);
  worker.close();
});

test("identical content at two paths yields separate revisions that resolve evidence from their own root", async () => {
  const a = copyFixture(), b = copyFixture();
  const { svc, worker, revision: ra } = await setup(undefined, a);
  const rb = await svc.ingestRepository(ctx(), { repoPath: b });
  assert.ok(rb.ok && rb.value.id !== ra);
  appendFileSync(join(a, "src/auth/token.ts"), "\n// only in a\n");
  const ev = (rev: string) => {
    const asked = svc.store.db.prepare("select id from evidence where revision = ? and id in (select id from evidence where json like '%auth/token.ts%') limit 1").get(rev) as any;
    return svc.evidenceFor(ctx(), { revision: rev, evidenceId: asked.id });
  };
  const ea = ev(ra), eb = ev(rb.value.id);
  assert.ok(ea.ok && eb.ok);
  assert.equal(ea.value.state, "STALE");
  assert.equal(eb.value.state, "CURRENT");
  worker.close();
});
