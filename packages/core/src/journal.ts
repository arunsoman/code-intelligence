// C02 slice: sequenced command journal with idempotency + optimistic version checks (contracts §1, §3).
import { createHash, randomUUID } from "node:crypto";
import type { ApiError, CallContext } from "@cie/schema";
import { failpoint } from "./failpoint.ts";
import type { Store } from "./store.ts";

export interface Command { id: string; type: "UPDATE_WORKSPACE"; subjectId: string; expectedVersion: number; payload: { name: string; revision?: string; state: unknown } }
export interface CommitReceipt { commandId: string; transactionId: string; committedSequence: number; resourceVersion: number }
export type SubmitResult = { ok: true; receipt: CommitReceipt; replayed: boolean } | { ok: false; error: ApiError };

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export class Journal {
  private store: Store;
  constructor(store: Store) { this.store = store; }

  submit(ctx: CallContext, cmd: Command): SubmitResult {
    if (!ctx.idempotencyKey) return { ok: false, error: { code: "INVALID_SCHEMA", message: "idempotency key required for mutating commands", retryable: false } };
    // The command id is per-request; a retry with the same idempotency key must hash identically.
    const payloadHash = hash({ ...cmd, id: undefined });
    const db = this.store.db;
    try {
      const result = this.store.tx<SubmitResult>(() => {
        const prior = db.prepare("select payload_hash, receipt from idempotency where key = ?").get(ctx.idempotencyKey) as any;
        if (prior) {
          // Same key with different bytes is a conflict, never a fresh execution.
          if (prior.payload_hash !== payloadHash) return { ok: false, error: { code: "VERSION_CONFLICT", message: "idempotency key reused with a different payload", retryable: false } };
          return { ok: true, receipt: JSON.parse(prior.receipt), replayed: true };
        }
        const cur = db.prepare("select version from workspaces where id = ?").get(cmd.subjectId) as any;
        const currentVersion: number = cur?.version ?? 0;
        if (cmd.expectedVersion !== currentVersion) {
          return { ok: false, error: { code: "VERSION_CONFLICT", message: `expected version ${cmd.expectedVersion}, current ${currentVersion}`, retryable: false, currentVersion } };
        }
        const now = new Date().toISOString();
        const version = currentVersion + 1;
        db.prepare("insert into workspaces(id,name,version,revision,updated_at,json) values (?,?,?,?,?,?) on conflict(id) do update set name=excluded.name, version=excluded.version, revision=excluded.revision, updated_at=excluded.updated_at, json=excluded.json")
          .run(cmd.subjectId, cmd.payload.name, version, cmd.payload.revision ?? null, now, JSON.stringify(cmd.payload.state));
        const r = db.prepare("insert into journal(resource_id,command_id,type,payload,actor,ts) values (?,?,?,?,?,?)")
          .run(cmd.subjectId, cmd.id, cmd.type, JSON.stringify({ name: cmd.payload.name, version }), ctx.actor.principalId, now);
        const receipt: CommitReceipt = { commandId: cmd.id, transactionId: randomUUID(), committedSequence: Number(r.lastInsertRowid), resourceVersion: version };
        // The event is written in this same transaction: a committed change always has its event, and a rolled-back one never does.
        db.prepare("insert into outbox(event_id, topic, payload, created_at) values (?,?,?,?)").run(receipt.transactionId, "workspace.updated", JSON.stringify({ resourceId: cmd.subjectId, version, sequence: receipt.committedSequence, revision: cmd.payload.revision ?? null }), now);
        db.prepare("insert into idempotency values (?,?,?)").run(ctx.idempotencyKey, payloadHash, JSON.stringify(receipt));
        return { ok: true, receipt, replayed: false };
      });
      failpoint("after-commit");
      return result;
    } catch (e) {
      return { ok: false, error: { code: "STORAGE_FAILURE", message: (e as Error).message, retryable: true } };
    }
  }

  replay(resourceId: string, afterSequence: number, limit = 100) {
    return this.store.db.prepare("select seq, command_id, type, payload, ts from journal where resource_id = ? and seq > ? order by seq limit ?").all(resourceId, afterSequence, limit);
  }
}
