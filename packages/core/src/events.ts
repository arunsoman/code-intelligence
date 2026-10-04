// C02: the transactional outbox and event bus. A command's event is written in the same transaction as the command
// itself (journal.ts), so there is never a committed change without its event or an event without its change.
// Delivery is at-least-once; each subscriber's effect and its "done" marker commit together, so an event delivered
// twice (a crash between delivery and bookkeeping, a replay) has its effect once.
import type { Store } from "./store.ts";
import { failpoint } from "./failpoint.ts";

export interface OutboxEvent { seq: number; eventId: string; topic: string; payload: any; createdAt: string }
export type Handler = (ev: OutboxEvent, store: Store) => void;

export class EventBus {
  private store: Store;
  private subs = new Map<string, Handler>();
  constructor(store: Store) { this.store = store; }

  subscribe(name: string, handler: Handler) { this.subs.set(name, handler); }

  pending(): number { return (this.store.db.prepare("select count(*) n from outbox where delivered_at is null").get() as { n: number }).n; }

  /** Deliver undelivered events in order. A handler that throws leaves that event pending for that subscriber, and later events wait behind it. */
  dispatchPending(limit = 200): { delivered: number; failed: { eventId: string; subscriber: string; error: string }[] } {
    const db = this.store.db;
    const rows = db.prepare("select seq, event_id, topic, payload, created_at from outbox where delivered_at is null order by seq limit ?").all(limit) as any[];
    const failed: { eventId: string; subscriber: string; error: string }[] = [];
    const blocked = new Set<string>();
    let delivered = 0;
    if (this.subs.size === 0) return { delivered, failed };
    for (const r of rows) {
      const ev: OutboxEvent = { seq: r.seq, eventId: r.event_id, topic: r.topic, payload: JSON.parse(r.payload), createdAt: r.created_at };
      let all = true;
      for (const [name, handler] of this.subs) {
        if (blocked.has(name)) { all = false; continue; }
        try {
          this.store.tx(() => {
            if (db.prepare("select 1 from subscriber_progress where subscriber = ? and event_id = ?").get(name, ev.eventId)) return; // already applied: a duplicate delivery
            handler(ev, this.store);
            db.prepare("insert into subscriber_progress values (?,?,?)").run(name, ev.eventId, new Date().toISOString());
          });
          failpoint("after-subscriber-commit");
        } catch (e) {
          all = false; blocked.add(name);
          db.prepare("update outbox set attempts = attempts + 1 where event_id = ?").run(ev.eventId);
          failed.push({ eventId: ev.eventId, subscriber: name, error: (e as Error).message });
        }
      }
      if (all) { db.prepare("update outbox set delivered_at = ? where event_id = ?").run(new Date().toISOString(), ev.eventId); delivered++; }
    }
    return { delivered, failed };
  }

  /** Events after `afterSeq`, for a client that lost its connection. `gap` means the oldest wanted event is gone: resync from a snapshot. */
  eventsAfter(afterSeq: number, limit = 500): { events: OutboxEvent[]; gap: boolean; latest: number } {
    const db = this.store.db;
    const rows = db.prepare("select seq, event_id, topic, payload, created_at from outbox where seq > ? order by seq limit ?").all(afterSeq, limit) as any[];
    const events = rows.map((r) => ({ seq: r.seq, eventId: r.event_id, topic: r.topic, payload: JSON.parse(r.payload), createdAt: r.created_at }));
    const latest = (db.prepare("select coalesce(max(seq), 0) m from outbox").get() as { m: number }).m;
    const oldest = (db.prepare("select coalesce(min(seq), 0) m from outbox").get() as { m: number }).m;
    // The client's next event should be afterSeq+1. If the log now starts later than that, events were pruned.
    const gap = latest > afterSeq && oldest > afterSeq + 1;
    // A hole inside the returned run is also a gap (it should never happen; it is checked rather than assumed).
    const holes = events.some((e, i) => i > 0 && e.seq !== events[i - 1].seq + 1);
    return { events, gap: gap || holes, latest };
  }

  /** Delivered events older than the retention are removed; the log stays bounded. Undelivered events are never pruned. */
  prune(keepLatest = 10_000): number {
    return Number(this.store.db.prepare("delete from outbox where delivered_at is not null and seq <= (select coalesce(max(seq), 0) - ? from outbox)").run(keepLatest).changes);
  }
}
