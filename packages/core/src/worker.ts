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
  private child: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private dead: Error | null = null;

  constructor(path = defaultWorkerPath()) {
    this.child = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] });
    // The worker must never keep the host process alive on its own (tests, crashes, shutdown).
    this.child.unref();
    for (const s of [this.child.stdin, this.child.stdout, this.child.stderr] as unknown as { unref?: () => void }[]) s.unref?.();
    this.child.stdout.on("data", (d: Buffer) => this.onData(d));
    this.child.stderr.on("data", () => {}); // never log worker output verbatim (may contain source)
    const fail = (e: Error) => {
      this.dead = e;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
      this.pending.clear();
    };
    this.child.on("exit", (code) => fail(new Error(`worker exited (${code})`)));
    this.child.on("error", fail);
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

  private call(op: string, params: unknown, timeoutMs: number): Promise<any> {
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

  async index(repoPath: string, timeoutMs = 120_000): Promise<AnalysisBatch> {
    const msg = await this.call("index", { repoPath }, timeoutMs);
    if (!msg.ok) throw new WorkerError(msg.error);
    if (msg.handle) {
      try { return JSON.parse(readFileSync(msg.handle, "utf8")); } finally { try { unlinkSync(msg.handle); } catch {} }
    }
    return msg.result;
  }

  async ping() {
    const msg = await this.call("ping", {}, 5_000);
    if (!msg.ok) throw new WorkerError(msg.error);
    return msg.result;
  }

  close() { this.child.kill(); }
}
