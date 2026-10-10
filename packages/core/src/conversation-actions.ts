import { createHash } from "node:crypto";
import type { CallContext } from "@cie/schema";
import type { Store } from "./store.ts";

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
type Action = { action_id: string; owner: string; state: string; payload_hash: string; lease_until: number; checkpoint_json: string | null; response_json: string | null };
export class ConversationConflict extends Error { readonly retryable: boolean; constructor(message: string, retryable = false) { super(message); this.retryable = retryable; } }
/** SQLite serializes acquisition; a lease bounds recovery without aborting another live server. */
export class ConversationActions {
  private store: Store;
  constructor(store: Store) { this.store = store; }
  begin(ctx: CallContext, sessionId: string, payload: unknown): { replay?: unknown; owner: string; actionId: string } {
    const scope = [ctx.actor.tenantId, ctx.actor.principalId, sessionId];
    const actionId = ctx.idempotencyKey || ctx.requestId;
    const hash = createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
    return this.store.tx(() => {
      const prior = this.store.db.prepare("select * from conversation_actions where tenant_id=? and principal_id=? and session_id=? and action_id=?").get(...scope, actionId) as Action | undefined;
      if (prior && prior.payload_hash !== hash) throw new ConversationConflict("This action key was already used for a different conversation request.");
      if (prior?.state === "complete") return { replay: JSON.parse(prior.response_json!), owner: prior.owner, actionId };
      const pending = this.store.db.prepare("select * from conversation_actions where tenant_id=? and principal_id=? and session_id=? and state='pending'").get(...scope) as Action | undefined;
      if (pending && pending.lease_until > Date.now()) throw new ConversationConflict("A turn is still running in this conversation. Retry after it finishes or its recovery lease expires.", true);
      if (pending) this.restore(scope, pending);
      const checkpoint = this.store.db.prepare("select * from chat_sessions where tenant_id=? and actor_principal=? and session_id=?").get(...scope);
      const owner = ctx.requestId;
      this.store.db.prepare(`insert into conversation_actions values(?,?,?,?,?,?,'pending',?,1,?,null)
        on conflict(tenant_id,principal_id,session_id,action_id) do update set owner=excluded.owner,state='pending',lease_until=excluded.lease_until,attempt=conversation_actions.attempt+1,checkpoint_json=excluded.checkpoint_json,response_json=null`)
        .run(...scope, actionId, hash, owner, Math.min(ctx.deadlineMs, Date.now() + 120_000), checkpoint ? JSON.stringify(checkpoint) : null);
      return { owner, actionId };
    });
  }
  private restore(scope: string[], action: Action) {
    this.store.db.prepare("delete from chat_sessions where tenant_id=? and actor_principal=? and session_id=?").run(...scope);
    if (action.checkpoint_json) {
      const r = JSON.parse(action.checkpoint_json);
      this.store.db.prepare("insert into chat_sessions(session_id,actor_principal,tenant_id,state,seq,created_at,last_active_at,context_json,turns_json) values(?,?,?,?,?,?,?,?,?)")
        .run(r.session_id,r.actor_principal,r.tenant_id,r.state,r.seq,r.created_at,r.last_active_at,r.context_json,r.turns_json);
    }
    this.store.db.prepare("update conversation_actions set state='failed' where tenant_id=? and principal_id=? and session_id=? and action_id=?").run(...scope, action.action_id);
  }
  owns(ctx: CallContext, sessionId: string, actionId: string): boolean {
    return !!this.store.db.prepare("select 1 from conversation_actions where tenant_id=? and principal_id=? and session_id=? and action_id=? and owner=? and state='pending' and lease_until>?")
      .get(ctx.actor.tenantId,ctx.actor.principalId,sessionId,actionId,ctx.requestId,Date.now());
  }
  finish(ctx: CallContext, sessionId: string, actionId: string, result: unknown, commit: () => void) {
    this.store.tx(() => {
      if (!this.owns(ctx, sessionId, actionId)) throw new ConversationConflict("This turn's lease ended; its late result was discarded.", true);
      commit();
      this.store.db.prepare("update conversation_actions set state='complete',response_json=?,checkpoint_json=null where tenant_id=? and principal_id=? and session_id=? and action_id=?")
        .run(JSON.stringify(result),ctx.actor.tenantId,ctx.actor.principalId,sessionId,actionId);
    });
  }
  abort(ctx: CallContext, sessionId: string, actionId: string) {
    this.store.tx(() => {
      const scope = [ctx.actor.tenantId,ctx.actor.principalId,sessionId];
      const action = this.store.db.prepare("select * from conversation_actions where tenant_id=? and principal_id=? and session_id=? and action_id=? and owner=? and state='pending'").get(...scope,actionId,ctx.requestId) as Action | undefined;
      if (action) this.restore(scope, action);
    });
  }
}
