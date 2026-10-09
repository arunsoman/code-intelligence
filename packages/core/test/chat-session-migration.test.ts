import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ChatSessionManager } from "../src/chat-session.ts";
import { currentVersion, migrate, MIGRATIONS } from "../src/migrations.ts";
import { Store } from "../src/store.ts";
import { ctx } from "./helpers.ts";

test("conversation schema upgrades an existing version-42 database without changing its history", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  currentVersion(db);
  for (const [version, name] of [[40, "pr-impact-reports"], [41, "pr-chat-replies"], [42, "reviewer-feedback"]] as const) {
    db.prepare("insert into schema_version values (?,?,?)").run(version, name, "existing");
  }
  assert.deepEqual(migrate(db), [43]);
  assert.equal(currentVersion(db), 43);
  assert.equal((db.prepare("select name from schema_version where version=40").get() as { name: string }).name, "pr-impact-reports");
  assert.ok(db.prepare("select name from sqlite_master where name='chat_sessions'").get());
  assert.deepEqual(migrate(db), []);
});

test("the correction preserves sessions created with the earlier version-40 migration", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.db.close());
  const owner = ctx();
  new ChatSessionManager(store).getSession(owner, "existing-session").appendTurn("user", "keep this transcript");
  store.db.prepare("update schema_version set version=40 where name='conversation-sessions'").run();
  assert.deepEqual(migrate(store.db), [43]);
  assert.equal(new ChatSessionManager(store).getSession(owner, "existing-session").turns[0]?.text, "keep this transcript");
  assert.equal(new Set(MIGRATIONS.map((m) => m.version)).size, MIGRATIONS.length);
});
