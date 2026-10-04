import fs from "node:fs";

interface Pool { connect(): Promise<{ query(sql: string): Promise<unknown>; release(): void }> }
interface Tx { begin(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>; run(sql: string): Promise<void> }

// A timer that runs forever, and whose handle goes nowhere.
export function startPolling(poll: () => void) {
  const timer = setInterval(poll, 1000);
  poll();
}
// Control: the same timer, cleared by the function that ends the work.
export function pollOnce(poll: () => void) {
  const timer = setInterval(poll, 1000);
  try { poll(); } finally { clearInterval(timer); }
}
// Control: the handle is returned, so whoever receives it owns clearing it.
export function startOwnedPolling(poll: () => void) {
  const timer = setInterval(poll, 1000);
  return timer;
}

// A file handle opened and never closed.
export function readFirstLine(path: string) {
  const fd = fs.openSync(path, "r");
  const buf = Buffer.alloc(64);
  fs.readSync(fd, buf, 0, 64, 0);
  return buf.toString();
}
// Control: closed in a finally, so the error path closes it too.
export function readFirstLineSafely(path: string) {
  const fd = fs.openSync(path, "r");
  try { const buf = Buffer.alloc(64); fs.readSync(fd, buf, 0, 64, 0); return buf.toString(); } finally { fs.closeSync(fd); }
}
// Closed on the normal path only: if the read throws, the handle stays open.
export function readThenClose(path: string) {
  const fd = fs.openSync(path, "r");
  const buf = Buffer.alloc(64);
  fs.readSync(fd, buf, 0, 64, 0);
  fs.closeSync(fd);
  return buf.toString();
}

// A pooled connection that is never given back.
export async function leakyQuery(pool: Pool, sql: string) {
  const conn = await pool.connect();
  return conn.query(sql);
}
// Control.
export async function tidyQuery(pool: Pool, sql: string) {
  const conn = await pool.connect();
  try { return await conn.query(sql); } finally { conn.release(); }
}

// A transaction that begins and may never end.
export async function openTransaction(tx: Tx) { await tx.begin(); await tx.run("update accounts set x = 1"); }
// Control.
export async function closedTransaction(tx: Tx) { await tx.begin(); try { await tx.run("update accounts set x = 1"); await tx.commit(); } catch (e) { await tx.rollback(); throw e; } }

// A listener added with no way to remove it, in a function that can be called many times.
export function watch(target: { addEventListener(n: string, h: () => void): void }, onChange: () => void) {
  target.addEventListener("change", onChange);
}
// Control: it comes with its own removal.
export function watchWithStop(target: { addEventListener(n: string, h: () => void): void; removeEventListener(n: string, h: () => void): void }, onChange: () => void) {
  target.addEventListener("change", onChange);
  return () => target.removeEventListener("change", onChange);
}
