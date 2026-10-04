// Supervisor/client for the Rust worker (contracts §10): length-prefixed JSON over stdio.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnalysisBatch, ApiError, BaseRevision } from "@cie/schema";

export interface ProfileDiagnosticsRpc { code: string; message: string }
export interface ProfileMappingRpc { mappingId: number; buildId?: string | null; file?: string | null; hasFunctions: boolean; hasFilenames: boolean; hasLineNumbers: boolean; hasInlineFrames: boolean; revision?: string | null; revisionState: string }
export interface ProfileIngestResultRpc {
  artifactHash: string; format: string;
  sampleTypes: { ordinal: number; kind: string; unit: string; rawType: string; rawUnit: string }[];
  periodNs: number | null;
  mappings: ProfileMappingRpc[];
  diagnostics: ProfileDiagnosticsRpc[];
  droppedSamples: number | "NOT_REPORTED";
  service?: string | null; instance?: string | null; runtime?: string | null;
  profiler?: string | null; profilerVersion?: string | null;
  startNs?: number; endNs?: number; samplingRateHz?: number | null; truncated?: number;
}

export interface ProfileHotspotRowRpc { rank: number; functionKey?: string; function_key?: string; name: string; file: string; line: number; selfValue?: number; self_value?: number; totalValue?: number; total_value?: number; selfShare?: number; self_share?: number; totalShare?: number; total_share?: number; sampleCount?: number; sample_count?: number; uncertaintyLow?: number | null; uncertainty_low?: number | null; uncertaintyHigh?: number | null; uncertainty_high?: number | null; entityId?: string | null; entity_id?: string | null; attributionMethod?: string; attribution_method?: string }
export interface ProfileHotspotResultRpc { rows: ProfileHotspotRowRpc[]; unit: string; sampleCount?: number; sample_count?: number; populationValue?: number; population_value?: number; coverage: { collectionRatio?: number | null; collection_ratio?: number | null; droppedSamples?: number | null; dropped_samples?: string | number | null; truncatedStacks?: number | null; truncated_stacks?: number | null; unattributedShare?: number | null; unattributed_share?: number | null; prunedShare?: number | null; pruned_share?: number | null }; uncertainty: { method: string; minSamplesForRanking: number; tooFewSamples: boolean }; basis: string; grade: string; populationHash?: string; population_hash?: string }
export interface ProfileFlameNodeRpc { functionKey?: string; function_key?: string; name: string; file: string; line: number; selfValue?: number; self_value?: number; totalValue?: number; total_value?: number; children: ProfileFlameNodeRpc[]; otherValue?: number; other_value?: number }
export interface ProfileFlamegraphResultRpc { tree: ProfileFlameNodeRpc; nodeCount?: number; node_count?: number; prunedValue?: number; pruned_value?: number; prunedShare?: number | null; pruned_share?: number | null; unit: string; populationValue?: number; population_value?: number }
export interface ProfileCorrelationRpc { correlationId?: string; correlation_id?: string; links: { traceId?: string | null; trace_id?: string | null; spanId?: string | null; span_id?: string | null; grade: string; overlapMs?: number | null; overlap_ms?: number | null; reason: string }[]; build: { buildId?: string | null; build_id?: string | null; revision?: string | null; state: string; evidenceIds?: string[]; evidence_ids?: string[] }; populationHash?: string; population_hash?: string }
export interface ProfileCompareResultRpc { verdict: string; reasons: string[]; rows: ProfileDeltaRowRpc[]; populations: { baseline: ProfilePopulationRpc; candidate: ProfilePopulationRpc }; limitations: string[] }
export interface ProfileDeltaRowRpc { functionKey?: string; function_key?: string; name: string; file: string; line: number; baselineValue?: number; baseline_value?: number; candidateValue?: number; candidate_value?: number; deltaPerRequest?: number | null; delta_per_request?: number | null; baselineShare?: number | null; baseline_share?: number | null; candidateShare?: number | null; candidate_share?: number | null; shareChange?: number | null; share_change?: number | null }
export interface ProfilePopulationRpc { populationHash?: string; population_hash?: string; service: string; windowFromNs?: number; window_from_ns?: number; windowToNs?: number; window_to_ns?: number; revision?: string | null; sampleTypeKind?: string; sample_type_kind?: string; chunkIds?: string[]; chunk_ids?: string[]; sampleCount?: number; sample_count?: number; expectedSamples?: number | null; expected_samples?: number | null; collectionRatio?: number | null; collection_ratio?: number | null; requestCount?: number | null; request_count?: number | null; errorCount?: number | null; error_count?: number | null }

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

  async index(repoPath: string, timeoutMs = 120_000, changes?: { revision: string; files: Record<string, string> }, base?: BaseRevision): Promise<AnalysisBatch> {
    const watch = setInterval(() => { const mb = this.rssMb(); if (mb !== null && mb > this.rssLimitMb) { clearInterval(watch); this.killForMemory(mb); } }, 40);
    let msg: any;
    try { msg = await this.callRetry("index", { repoPath, changes, base }, timeoutMs); } finally { clearInterval(watch); }
    if (!msg.ok) throw new WorkerError(msg.error);
    if (msg.handle) {
      try { return JSON.parse(readFileSync(msg.handle, "utf8")); } finally { try { unlinkSync(msg.handle); } catch {} }
    }
    return msg.result;
  }

  /**
   * Low-level RPC. Returns the full worker response object including ok/result/error.
   */
  async request(payload: { op: string; id?: number | string; params?: unknown }, timeoutMs = 30_000): Promise<{ ok: boolean; result?: any; error?: ApiError }> {
    const msg = await this.callRetry(payload.op, payload.params ?? {}, timeoutMs);
    return msg;
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

  /**
   * F01 regex verification (decision D1): runs in the worker with the linear-time `regex` crate, under a
   * deadline and match caps, so a hostile pattern cannot make a search request spin. `files` are the
   * candidates the trigram prefilter produced; files that are gone are counted, not errors.
   * A rejected construct (backreference, look-around) throws a WorkerError with code INVALID_SCHEMA.
   */
  async regexFind(root: string, files: string[], pattern: string, opts: { caseSensitive?: boolean; deadlineMs?: number; maxMatchesPerFile?: number; maxTotalMatches?: number } = {}): Promise<{ matches: { path: string; startByte: number; endByte: number; line: number; endLine: number }[]; filesScanned: number; filesMissing: number; filesTooLarge: number; truncated: boolean; elapsedMs: number }> {
    const msg = await this.callRetry("regexFind", { root, files, pattern, caseSensitive: opts.caseSensitive ?? false, deadlineMs: opts.deadlineMs, maxMatchesPerFile: opts.maxMatchesPerFile, maxTotalMatches: opts.maxTotalMatches }, Math.min(20_000, (opts.deadlineMs ?? 5_000) + 10_000));
    if (!msg.ok) throw new WorkerError(msg.error);
    return msg.result;
  }

  /**
   * F05: parse and aggregate a profile file in the worker (pprof / V8 .cpuprofile / folded stacks; sniffed by magic).
   * The path is read inside the worker, so only parsed aggregates cross the RPC; oversized or corrupt files return
   * typed diagnostics (RESOURCE_LIMIT / INVALID_SCHEMA).
   */
  async ingestProfileFile(path: string, serviceHint?: string, timeoutMs = 60_000): Promise<ProfileIngestResultRpc> {
    const msg = await this.callRetry("ingestProfile", { path, serviceHint }, timeoutMs);
    if (!msg.ok) throw new WorkerError(msg.error);
    return msg.result;
  }

  /** F05: hotspots for one sample type of the profile at `path`, ranked by self (default) or cumulative value. */
  async profileHotspots(path: string, opts: { serviceHint?: string; ordinal?: number; order?: "SELF" | "TOTAL"; limit?: number; timeoutMs?: number } = {}): Promise<ProfileHotspotResultRpc> {
    const msg = await this.callRetry("queryHotspots", { path, serviceHint: opts.serviceHint, ordinal: opts.ordinal ?? 0, order: opts.order ?? "SELF", limit: opts.limit ?? 2000 }, opts.timeoutMs ?? 60_000);
    if (!msg.ok) throw new WorkerError(msg.error);
    return msg.result;
  }

  /**
   * F06 / WP-05: code-health metrics for the given files of `root`, parsed in the worker
   * (bounded: ≤ 400 files per call, ≤ 2 MiB each). Only the per-function signals cross the RPC.
   */
  async metrics(root: string, files: string[], timeoutMs = 30_000): Promise<{ files: { path: string; language?: string; lines?: number; symbols?: number; hadErrors?: boolean; functions?: { name: string; startLine: number; endLine: number; length: number; complexity: number; nesting: number; params: number }[]; error?: string; metricsVersion?: number }[]; metricsVersion: number }> {
    const msg = await this.callRetry("metrics", { root, files }, timeoutMs);
    if (!msg.ok) throw new WorkerError(msg.error);
    return msg.result;
  }

  /** F05: the pruned, bounded call tree used to draw the flamegraph (a view of the hotspot table, not a separate truth). */
  async profileFlamegraph(path: string, opts: { serviceHint?: string; ordinal?: number; timeoutMs?: number } = {}): Promise<ProfileFlamegraphResultRpc> {
    const msg = await this.callRetry("buildFlamegraph", { path, serviceHint: opts.serviceHint, ordinal: opts.ordinal ?? 0 }, opts.timeoutMs ?? 60_000);
    if (!msg.ok) throw new WorkerError(msg.error);
    return msg.result;
  }

  /** F05: worker-side correlation of one profile file against one trace window (grades windows/span labels). */
  async correlateProfileFile(path: string, params: { serviceHint?: string; trace: { service: string; instance?: string; fromNs: number; toNs: number; revision?: string; traceId?: string; spanId?: string; endpoint?: string }; buildId?: string; revision?: string; timeoutMs?: number }): Promise<ProfileCorrelationRpc> {
    const msg = await this.callRetry("correlateProfile", { path, serviceHint: params.serviceHint, trace: params.trace, buildId: params.buildId, revision: params.revision }, params.timeoutMs ?? 60_000);
    if (!msg.ok) throw new WorkerError(msg.error);
    return msg.result;
  }

  /** F05: compare two profile files under population equivalence rules (the caller still gates on error populations). */
  async compareProfileFiles(params: { baselinePath: string; candidatePath: string; serviceHint?: string; baseline?: { ordinal?: number; service: string; windowFromNs: number; windowToNs: number; revision?: string }; candidate?: { ordinal?: number; service: string; windowFromNs: number; windowToNs: number; revision?: string }; baselineTrace?: { service: string; fromNs: number; toNs: number }; candidateTrace?: { service: string; fromNs: number; toNs: number }; normalise?: "PER_REQUEST"; declareEquivalent?: { reason: string }; timeoutMs?: number }): Promise<ProfileCompareResultRpc> {
    const msg = await this.callRetry("compareProfiles", params, params.timeoutMs ?? 60_000);
    if (!msg.ok) throw new WorkerError(msg.error);
    return msg.result;
  }

  /** The process id of the parser, for operators and for tests that kill it. */
  get pid() { return this.child.pid; }

  close() { this.closed = true; this.child.kill(); }
}
