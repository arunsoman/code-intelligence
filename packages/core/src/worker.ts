// Supervisor/client for the Rust worker (contracts §10): length-prefixed JSON over stdio.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnalysisBatch, ApiError } from "@cie/schema";

const MAX_FRAME = 8 * 1024 * 1024;

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class WorkerError extends Error {
  readonly api: ApiError;
  constructor(api: ApiError) { super(api.message); this.api = api; }
}

export function defaultWorkerPath(): string {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  for (const profile of ["release", "debug"]) {
    const p = `${root}target/${profile}/worker`;
    if (existsSync(p)) return p;
  }
  throw new Error("worker binary not found; run `cargo build --release`");
}

export class WorkerClient {
  private child!: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private dead: Error | null = null;
  private path: string;
  /** Which child process the handlers belong to, so a killed child's late "exit" cannot mark its replacement dead. */
  private generation = 0;
  private closed = false;
  /** How many times the parser process was replaced after dying on its own. */
  restarts = 0;
  /** Largest resident size the parser may reach while indexing. Parser memory grows with the repository (roughly 0.2 MB per file), so this is an enforced ceiling: an index that would pass it fails cleanly instead of taking the machine down. */
  rssLimitMb = Number(process.env.CIE_WORKER_RSS_MB) || 2048;

  constructor(path = defaultWorkerPath()) {
    this.path = path;
    this.start();
  }

  private start() {
    const gen = ++this.generation;
    this.buf = Buffer.alloc(0);
    this.dead = null;
    this.child = spawn(this.path, [], { stdio: ["pipe", "pipe", "pipe"] });
    // The worker must never keep the host process alive on its own (tests, crashes, shutdown).
    this.child.unref();
    for (const s of [this.child.stdin, this.child.stdout, this.child.stderr] as unknown as { unref?: () => void }[]) s.unref?.();
    this.child.stdout.on("data", (d: Buffer) => { if (gen === this.generation) this.onData(d); });
    this.child.stderr.on("data", () => {}); // never log worker output verbatim (may contain source)
    const fail = (e: Error) => {
      if (gen !== this.generation) return;
      this.dead = e;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
      this.pending.clear();
    };
    // Writing to a process that just died raises on the pipe, not on the call: treat it as the worker having exited.
    this.child.stdin.on("error", (e) => fail(new Error(`worker exited (${(e as Error).message})`)));
    this.child.on("exit", (code) => fail(new Error(`worker exited (${code})`)));
    this.child.on("error", fail);
  }

  /**
   * Stop whatever the worker is doing, now. The parser is one blocking call, so the only way to interrupt it is to
   * end the process; a fresh one takes its place. Its in-memory parse cache goes with it, so the next index is a full parse.
   */
  abort() {
    const e = new WorkerError({ code: "CANCELLED", message: "worker call cancelled", retryable: true });
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
    this.generation++;
    this.child.kill("SIGKILL");
    this.start();
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME) { this.child.kill(); return; }
      if (this.buf.length < 4 + len) return;
      const msg = JSON.parse(this.buf.subarray(4, 4 + len).toString("utf8"));
      this.buf = this.buf.subarray(4 + len);
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  /**
   * A parser that died (crash, out-of-memory, killed) is replaced, and a read-only request that was caught by it is
   * tried once more on the new process; a second failure is reported. The caller sees a slow answer, not an outage.
   */
  private async callRetry(op: string, params: unknown, timeoutMs: number): Promise<any> {
    try { return await this.call(op, params, timeoutMs); }
    catch (e) {
      if (this.closed || !/worker exited|EPIPE|write after end|ERR_STREAM/.test((e as Error).message)) throw e;
      this.revive();
      return await this.call(op, params, timeoutMs);
    }
  }

  private revive() { this.generation++; try { this.child.kill("SIGKILL"); } catch { /* already gone */ } this.restarts++; this.start(); }

  private call(op: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.dead && !this.closed) this.revive();
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, op, params }), "utf8");
    if (payload.length > MAX_FRAME) return Promise.reject(new Error("request exceeds frame limit"));
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32BE(payload.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WorkerError({ code: "DEADLINE_EXCEEDED", message: `worker op ${op} timed out`, retryable: true }));
      }, timeoutMs);
      // Not unref'd: an in-flight request must keep the process alive. It is cleared as soon as the reply arrives.
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(Buffer.concat([hdr, payload]));
    });
  }

  private rssMb(): number | null {
    try { const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${this.child.pid}/status`, "utf8")); return m ? Number(m[1]) / 1024 : null; } catch { return null; }
  }
  /** End the parser because it passed its memory ceiling; whoever is waiting is told why, and a fresh parser takes its place. */
  private killForMemory(mb: number) {
    const e = new WorkerError({ code: "RESOURCE_LIMIT", message: `indexing reached ${Math.round(mb)} MB, over the ${this.rssLimitMb} MB budget; nothing was saved. Exclude large directories, or raise CIE_WORKER_RSS_MB.`, retryable: false });
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
    this.generation++;
    this.child.kill("SIGKILL");
    this.start();
  }

  async index(repoPath: string, timeoutMs = 120_000, changes?: { revision: string; files: Record<string, string> }): Promise<AnalysisBatch> {
    const watch = setInterval(() => { const mb = this.rssMb(); if (mb !== null && mb > this.rssLimitMb) { clearInterval(watch); this.killForMemory(mb); } }, 40);
    let msg: any;
    try { msg = await this.callRetry("index", { repoPath, changes }, timeoutMs); } finally { clearInterval(watch); }
    if (!msg.ok) throw new WorkerError(msg.error);
    if (msg.handle) {
      try { return JSON.parse(readFileSync(msg.handle, "utf8")); } finally { try { unlinkSync(msg.handle); } catch {} }
    }
    return msg.result;
  }

  async ping() {
    const msg = await this.callRetry("ping", {}, 5_000);
    if (!msg.ok) throw new WorkerError(msg.error);
    return msg.result;
  }

  /** Which languages the parser reads and what it can say about each (parsed only, or resolved too). */
  async languageCapabilities(): Promise<Record<string, string[]>> {
    const msg = await this.callRetry("languageCapabilities", {}, 5_000);
    if (!msg.ok) throw new WorkerError(msg.error);
    return msg.result.languages;
  }

  /** The process id of the parser, for operators and for tests that kill it. */
  get pid() { return this.child.pid; }

  close() { this.closed = true; this.child.kill(); }
}
