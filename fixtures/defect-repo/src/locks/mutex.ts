// A tiny async mutex, enough for the fixtures. `acquire()` waits; `tryAcquire()` never waits; `runExclusive` holds for a callback.
export class Mutex {
  private waiters: (() => void)[] = []; private held = false;
  constructor(readonly name = "mutex") {}
  async acquire(opts?: { timeout?: number }): Promise<{ release(): void }> {
    if (this.held) await new Promise<void>((res) => this.waiters.push(res));
    this.held = true;
    return { release: () => this.release() };
  }
  tryAcquire(): { release(): void } | null { if (this.held) return null; this.held = true; return { release: () => this.release() }; }
  release() { this.held = false; this.waiters.shift()?.(); }
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> { const g = await this.acquire(); try { return await fn(); } finally { g.release(); } }
}
export class ReentrantLock extends Mutex {}
