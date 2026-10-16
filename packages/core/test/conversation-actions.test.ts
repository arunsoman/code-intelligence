import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { ConversationActions, ConversationConflict, TURN_FINALIZATION_GRACE_MS } from "../src/conversation-actions.ts";
import { ChatSessionManager } from "../src/chat-session.ts";
import { ctx } from "./helpers.ts";
import type { AnswerInvestigation } from "@cie/schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("tool progress survives reopening SQLite and expired owners cannot overwrite a replacement", () => {
 const dir=mkdtempSync(join(tmpdir(),"cie-recovery-")), path=join(dir,"store.db");
 let store=new Store(path);
 try {
  const actions=new ConversationActions(store), owner=ctx("recover-tool"), payload={text:"inspect charge"};
  actions.begin(owner,"chat",payload);
  const progress:AnswerInvestigation={id:owner.requestId,question:"inspect charge",revision:"r",nextAction:"continue",missingEvidence:["provider unread"],inspectedIds:["method:debit"],sourceReads:{},sourceHashes:{},observations:[{name:"ir_of",arguments:{id:"method:debit"},content:"debit implementation"}]};
  assert.equal(actions.checkpoint(owner,"chat",progress),true);
  store.db.close();store=new Store(path);
  store.db.prepare("update conversation_actions set lease_until=0").run();
  const restored=new ConversationActions(store), retry=ctx("recover-tool");
  const acquired=restored.begin(retry,"chat",payload);
  assert.deepEqual(acquired.progress,progress);
  assert.equal(restored.checkpoint(owner,"chat",{...progress,question:"late overwrite"}),false);
  const other=ctx("recover-tool");other.actor.principalId="other";
  assert.equal(restored.checkpoint(other,"chat",progress),false);
  assert.equal(restored.checkpoint(retry,"chat",progress),true);
  restored.finish(retry,"chat",acquired.actionId,{answer:"done"},()=>{});
  assert.deepEqual(restored.begin(ctx("recover-tool"),"chat",payload).replay,{answer:"done"});
 } finally { store.db.close();rmSync(dir,{recursive:true,force:true}); }
});

test("completed turn replays exactly once and rejects action-key reuse", () => {
 const store=new Store(":memory:"), actions=new ConversationActions(store), owner=ctx("action");
 const first=actions.begin(owner,"chat",{text:"hello"});let commits=0;
 actions.finish(owner,"chat",first.actionId,{answer:"saved"},()=>commits++);
 assert.deepEqual(actions.begin(ctx("action"),"chat",{text:"hello"}).replay,{answer:"saved"});
 assert.equal(commits,1);
 assert.throws(()=>actions.begin(ctx("action"),"chat",{text:"other"}),ConversationConflict);
 assert.throws(()=>actions.finish(owner,"chat",first.actionId,{},()=>commits++),ConversationConflict);
 assert.equal(commits,1);
});
test("expired lease restores the checkpoint and prevents late owners from mutating the recovered transcript",()=>{
 const store=new Store(":memory:"), manager=new ChatSessionManager(store), actions=new ConversationActions(store);
 const seed=ctx();manager.getSession(seed,"chat").appendTurn("assistant","original");
 const owner=ctx("interrupted"), action=actions.begin(owner,"chat",{text:"pending"});
 manager.bindTurn(owner);manager.forget(owner,"chat");const session=manager.getSession(owner,"chat");session.appendTurn("user","unfinished",undefined,"pending");
 assert.throws(()=>actions.begin(ctx("overlap"),"chat",{}),ConversationConflict);
 store.db.prepare("update conversation_actions set lease_until=0").run();
 const retry=ctx("interrupted");actions.begin(retry,"chat",{text:"pending"});
 const recovered=new ChatSessionManager(store).getSession(ctx(),"chat");assert.deepEqual(recovered.turns.map(t=>t.text),["original"]);
 assert.throws(()=>session.appendTurn("assistant","late"));
 assert.throws(()=>actions.finish(owner,"chat",action.actionId,{},()=>{}),ConversationConflict);
 actions.abort(owner,"chat",action.actionId);assert.ok(actions.owns(retry,"chat",action.actionId));
 actions.abort(retry,"chat",action.actionId);
});
test("turn ownership and response receipts are isolated by principal and tenant",()=>{
 const actions=new ConversationActions(new Store(":memory:"));const owner=ctx("shared");
 actions.begin(owner,"chat",{});
 const other={...ctx("shared"),actor:{...owner.actor,principalId:"other"}};
 assert.doesNotThrow(()=>actions.begin(other,"chat",{}));
 assert.equal(actions.owns(other,"chat","shared"),true);
 assert.equal(actions.owns({...other,requestId:owner.requestId},"chat","shared"),false);
});


test("a deadline-exhausted turn can save its unresolved result during finalization grace", () => {
 const store = new Store(":memory:"), actions = new ConversationActions(store), owner = ctx("deadline");
 const originalNow = Date.now; const start = originalNow(); owner.deadlineMs = start + 100;
 try {
  Date.now = () => start;
  const action = actions.begin(owner, "chat", {});
  Date.now = () => start + 101;
  assert.throws(() => actions.begin(ctx("overlap"), "chat", {}), ConversationConflict, "another turn must not take over during finalization");
  actions.finish(owner, "chat", action.actionId, { status: "UNRESOLVED" }, () => {});
  assert.deepEqual(actions.begin(owner, "chat", {}).replay, { status: "UNRESOLVED" });
 } finally { Date.now = originalNow; store.db.close(); }
});

test("long request deadlines are not cut short by a fixed two-minute lease", () => {
 const store = new Store(":memory:"), actions = new ConversationActions(store), owner = ctx("long");
 owner.deadlineMs = Date.now() + 180000;
 actions.begin(owner, "chat", {});
 const row = store.db.prepare("select lease_until from conversation_actions").get() as { lease_until: number };
 assert.equal(row.lease_until, owner.deadlineMs + TURN_FINALIZATION_GRACE_MS);
 store.db.close();
});
