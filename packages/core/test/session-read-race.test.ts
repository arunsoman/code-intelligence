import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { ChatSessionManager } from "../src/chat-session.ts";
import { ctx } from "./helpers.ts";

test("a cached reader must not overwrite another manager's completed turns", () => {
 const store = new Store(":memory:");
 try {
  const reader = new ChatSessionManager(store), writer = new ChatSessionManager(store);
  reader.getSession(ctx(), "shared").appendTurn("assistant", "original");
  writer.getSession(ctx(), "shared").appendTurn("assistant", "newly completed answer");
  const refreshed = reader.getSession(ctx(), "shared");
  assert.deepEqual(refreshed.turns.map(t => t.text), ["original", "newly completed answer"]);
  assert.deepEqual(new ChatSessionManager(store).getSession(ctx(), "shared").turns.map(t => t.text), ["original", "newly completed answer"]);
 } finally { store.db.close(); }
});
