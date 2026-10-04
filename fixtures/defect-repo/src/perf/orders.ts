interface Db { query(sql: string, ...args: unknown[]): Promise<unknown>; update(row: unknown): Promise<void> }
interface Pool { acquire(): Promise<{ release(): void }> }
interface Lock { runExclusive<T>(fn: () => Promise<T>): Promise<T> }

// DP10: the N+1 shape, one query per id.
export async function loadOrders(db: Db, ids: string[]) {
  const out: unknown[] = [];
  for (const id of ids) { out.push(await db.query("select * from orders where id = ?", id)); }
  return out;
}
// DP10 control: one query for all ids.
export async function loadOrdersBatched(db: Db, ids: string[]) { return db.query("select * from orders where id in (?)", ids); }

// DP10: CPU-bound work in a loop, no I/O.
export function heavy(n: number) { let x = n; for (let i = 0; i < 2000; i++) x = (x * 31 + i) % 1000003; return x; }
export function summarize(rows: number[]) { let total = 0; for (let i = 0; i < rows.length; i++) total += heavy(rows[i]); return total; }

// DP10: waiting for a pooled connection.
export async function withConnection(pool: Pool, fn: () => Promise<void>) { const c = await pool.acquire(); try { await fn(); } finally { c.release(); } }

// DP09: a lock taken on every iteration, with I/O inside it.
export async function lockedWrites(lock: Lock, db: Db, items: unknown[]) {
  for (const it of items) { await lock.runExclusive(async () => { await db.update(it); }); }
}
// DP09 control: the lock covers only the decision; the I/O happens outside it.
export async function lockedDecision(lock: Lock, db: Db, items: unknown[]) {
  const chosen = await lock.runExclusive(async () => items.slice());
  for (const it of chosen) await db.update(it);
}

// DP08: a loop condition that calls something on a caller-supplied object each time. It might be a getter, it might change.
export function invariantLooking(cfg: { items(): unknown[] }) { const out: number[] = []; for (let i = 0; i < cfg.items().length; i++) out.push(i); return out; }
// DP08: the condition depends on state the body changes.
export function mutatingLoop(list: number[]) { for (let i = 0; i < list.length; i++) { if (i % 2 === 0) list.push(i); } return list.length; }
// DP08: a condition that really is invariant: a pure builtin of a plain number.
export function pureBound(limit: number) { let n = 0; for (let i = 0; i < Math.sqrt(limit * limit); i++) n += i; return n; }

// Two independent awaits, one after the other.
export async function serial(api: { get(): Promise<number> }, client: { get(): Promise<number> }) { const x = await api.get(); const y = await client.get(); return [x, y]; }

// DP09: coarsening gone wrong. One lock around the whole loop: fewer acquisitions, but the lock is now held across every I/O call.
export async function coarsenedWrites(lock: Lock, db: Db, items: unknown[]) {
  await lock.runExclusive(async () => { for (const it of items) { await db.update(it); } });
}
