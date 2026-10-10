import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { ConversationActions, ConversationConflict } from "../src/conversation-actions.ts";
import { ChatSessionManager } from "../src/chat-session.ts";
import { ctx } from "./helpers.ts";

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
