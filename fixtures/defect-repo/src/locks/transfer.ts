import { Mutex, ReentrantLock } from "./mutex";

export const accountA = new Mutex("A");
export const accountB = new Mutex("B");
export const ledgerA = new Mutex("ledgerA");
export const ledgerB = new Mutex("ledgerB");
export const ledgerGuard = new Mutex("guard");
export const trayA = new Mutex("trayA");
export const trayB = new Mutex("trayB");
export const pool = new ReentrantLock("pool");

// DP01: a realizable two-lock inversion. Nothing serializes these two entry points.
export async function transferAtoB(amount: number) {
  const a = await accountA.acquire();
  const b = await accountB.acquire();
  try { return amount; } finally { b.release(); a.release(); }
}
export async function transferBtoA(amount: number) {
  const b = await accountB.acquire();
  const a = await accountA.acquire();
  try { return amount; } finally { a.release(); b.release(); }
}

// DP01 control: the same two orders, but both always taken while holding one global guard, so they can never overlap.
export async function guardedAtoB(amount: number) {
  const g = await ledgerGuard.acquire();
  const a = await ledgerA.acquire();
  const b = await ledgerB.acquire();
  try { return amount; } finally { b.release(); a.release(); g.release(); }
}
export async function guardedBtoA(amount: number) {
  const g = await ledgerGuard.acquire();
  const b = await ledgerB.acquire();
  const a = await ledgerA.acquire();
  try { return amount; } finally { a.release(); b.release(); g.release(); }
}

// DP02: a reentrant lock taken twice by the same flow is not a deadlock.
export async function reentrantInner() { const p = await pool.acquire(); p.release(); }
export async function reentrantOuter() { const p = await pool.acquire(); try { await reentrantInner(); } finally { p.release(); } }

// DP02: a try-lock with a recovery path. The inverted order never blocks.
export async function tryFirst() {
  const a = await trayA.acquire();
  const b = trayB.tryAcquire();
  if (!b) { a.release(); return "retry later"; }
  b.release(); a.release(); return "ok";
}
export async function blockingSecond() {
  const b = await trayB.acquire();
  const a = await trayA.acquire();
  a.release(); b.release();
}
