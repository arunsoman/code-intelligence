import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatSessionManager } from "../src/chat-session.ts";
import { Store } from "../src/store.ts";
import { ctx, setup } from "./helpers.ts";

test("an explicitly requested empty ER chart remains selected through converse", async (t) => {
  const { svc, worker, revision } = await setup();
  assert.ok((await svc.buildConceptHierarchy(ctx(), { revision })).ok);
  t.after(() => { worker.close(); svc.store.db.close(); });
  const result = await svc.converse(ctx(), {
    text: "show me the ER diagram", sessionId: "empty-er", revision,
  });
  assert.ok(result.ok);
  assert.equal(result.value.kind, "view");
  if (result.value.kind !== "view") return;
  assert.equal(result.value.view.formId, "GeneratedChart");
  assert.equal(result.value.view.params?.chartId, "S9");
  assert.equal(result.value.view.nodes.length, 0);
  assert.ok(result.value.view.gaps.some((gap) => /no tables/i.test(gap)));
});

test("session persistence retains the full transcript beyond the model window after a restart", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cie-chat-retention-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "chat.db");
  const owner = ctx();
  const store = new Store(path);
  const session = new ChatSessionManager(store).getSession(owner, "retained-chat");
  for (let i = 0; i < 205; i++) session.appendTurn("user", `turn-${i}`);
  const fullAnswer = "answer ".repeat(1100);
  session.appendTurn("assistant", fullAnswer);
  store.db.close();

  const reopenedStore = new Store(path);
  t.after(() => reopenedStore.db.close());
  const restored = new ChatSessionManager(reopenedStore).getSession(owner, "retained-chat");
  assert.equal(restored.turns.length, 206);
  assert.equal(restored.turns[0]?.text, "turn-0");
  assert.equal(restored.turns.at(-1)?.text, fullAnswer);
  assert.equal(restored.session.seq, 206);
});

test("the same session label never exposes another principal or tenant's transcript", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.db.close());
  const manager = new ChatSessionManager(store);
  const owner = ctx();
  manager.getSession(owner, "shared-label").appendTurn("user", "owner-only question");
  for (const actor of [
    { ...owner.actor, principalId: "other-user" },
    { ...owner.actor, tenantId: "other-tenant" },
  ]) {
    assert.deepEqual(manager.getSession({ ...owner, actor }, "shared-label").turns, []);
  }
  assert.equal(manager.getSession(owner, "shared-label").turns[0]?.text, "owner-only question");
});
