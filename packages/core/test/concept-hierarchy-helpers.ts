// Shared fixtures for the concept-hierarchy tests. Everything is hermetic: real TypeScript files in
// a temp directory, indexed once by the real worker (a sync one-frame spawn) so every entity carries
// its semantic-IR dump — which is exactly what the graph phase now folds. No model, no server.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubProvider } from "@cie/model";
import type { AnalysisBatch, Entity } from "@cie/schema";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { defaultWorkerPath, WorkerClient } from "../src/worker.ts";
import { localMotifBatch } from "../src/concept-hierarchy/motifs.ts";

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A temp directory holding the given files (paths relative to the root). */
export function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cie-ch-"));
  for (const [f, content] of Object.entries(files)) {
    const abs = join(root, f);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

/**
 * One entity per declared function, `function:<file>#<name>`, the id shape the real parser emits.
 * symbolHash is omitted: reuse goes through the graph's own bodyHash comparison, which does not
 * depend on the parser's symbol hashing.
 */
export function entitiesFor(files: Record<string, string>): Entity[] {
  const ents: Entity[] = [];
  for (const [file, src] of Object.entries(files)) {
    for (const m of src.matchAll(/(?:export )?(?:async )?function (\w+)/g)) {
      const name = m[1];
      ents.push({ entityId: `function:${file}#${name}`, kind: "function", name, file, spans: [] });
    }
    for (const m of src.matchAll(/class (\w+)/g)) {
      ents.push({ entityId: `class:${file}#${m[1]}`, kind: "class", name: m[1], file, spans: [] });
    }
  }
  return ents;
}

/** Store one revision of the given files, with the per-file digests the incremental path reads. */

/** One framed `index` round-trip against the built worker binary, synchronously (test bodies stay sync). */
function indexSync(repoRoot: string): AnalysisBatch {
  const frame = (req: object) => { const b = Buffer.from(JSON.stringify(req)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
  const r = spawnSync(defaultWorkerPath(), [], { input: frame({ id: "helpers", op: "index", params: { repoPath: repoRoot } }), encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, timeout: 120_000 });
  if (!r.stdout || r.stdout.length < 4) throw new Error(`worker index failed: ${String(r.stderr ?? "").slice(0, 300)}`);
  const len = r.stdout.readUInt32BE(0);
  const resp = JSON.parse(r.stdout.subarray(4, 4 + len).toString());
  if (!resp.ok) throw new Error(`worker index failed: ${JSON.stringify(resp.error)}`);
  try {
    return JSON.parse(readFileSync(resp.handle, "utf8"));
  } finally {
    try { rmSync(resp.handle, { force: true }); } catch { /* the temp dir cleans it anyway */ }
  }
}

export function putRevision(store: Store, rev: string, repoRoot: string, files: Record<string, string>): void {
  const batch = indexSync(repoRoot);
  // The fixture picks the revision id (tests address it by name); everything else is the real worker's.
  store.putBatch({ ...batch, revision: rev, gitHead: null });
}

let fakeWorker: string | null = null;
/** A worker binary that never answers: hierarchy builds never speak the frames protocol (the motif
 *  batch is injected as a local matcher to keep these tests hermetic); the Service still holds the
 *  client so an accidental call fails loudly instead of passing silently. */
export function fakeWorkerPath(): string {
  if (fakeWorker) return fakeWorker;
  fakeWorker = join(tmpdir(), `cie-fake-worker-${process.pid}`);
  writeFileSync(fakeWorker, "#!/bin/sh\nexec sleep 3600\n");
  chmodSync(fakeWorker, 0o755);
  return fakeWorker;
}

export function setupService(repoRoot: string, motifBatch?: import("../src/concept-hierarchy/motifs.ts").MotifBatchMatcher) {
  const store = new Store(":memory:");
  const worker = new WorkerClient(fakeWorkerPath());
  const svc = new Service(store, worker, new StubProvider(), undefined, motifBatch ?? localMotifBatch);
  return { svc, store, worker };
}

// ---- fixture sources: each exercises specific motifs; nothing names a business domain ----
export const LEDGER = `
export function withdraw(balance: number, amount: number): number {
  if (amount > 0 && amount <= balance) {
    balance = balance - amount;
  }
  return balance;
}
export function deposit(balance: number, amount: number): number {
  if (amount > 0) {
    balance = balance + amount;
  }
  return balance;
}
`;

export const RESOURCES = `
export function withSession() {
  const conn = connect();
  query(conn);
  close(conn);
}
export function leaking() {
  const conn = connect();
  query(conn);
}
function query(c: unknown) { return c; }
`;

export const RETRY = `
export function fetchWithRetry(url: string) {
  let attempts = 0;
  while (attempts < 3) {
    attempts = attempts + 1;
    const ok = send(url);
    if (ok) { break; }
  }
}
function send(u: string) { return true; }
`;

export const ACCUMULATE = `
export function total(xs: number[]) {
  let sum = 0;
  for (const x of xs) {
    sum = sum + x;
  }
  return sum;
}
`;

export const GUARDED_AWAIT = `
export async function guardedAwait(balance: number, amount: number) {
  if (amount > 0) {
    const rate = await fetchRate();
    balance = balance - amount * rate;
  }
  return balance;
}
function fetchRate() { return 1; }
`;

export const ASSERTED = `
export function assertedWithdraw(balance: number, amount: number) {
  if (amount > 0) {
    assert(amount <= balance);
    balance = balance - amount;
  }
  return balance;
}
`;

export const FLAG = `
export function checkFlag(items: string[]) {
  let hasError = false;
  for (const it of items) {
    if (it === "") { hasError = true; }
  }
  if (hasError) { return null; }
  return items;
}
`;

export const NULLFALLBACK = `
export function findUser(id: string) {
  const user = lookup(id);
  if (user === null) {
    const fallback = anonymous();
    return fallback;
  }
  return user;
}
function lookup(i: string) { return i; }
function anonymous() { return "anon"; }
`;

export const RETHROW = `
export function load(path: string) {
  try {
    return readFile(path);
  } catch (e) {
    throw new LoadError(e);
  }
}
class LoadError extends Error {}
function readFile(p: string) { return p; }
`;

export const DISPATCH = `
export function dispatch(kind: string) {
  if (kind === "a") { alpha(); }
  else if (kind === "b") { beta(); }
  else { gamma(); }
}
function alpha() { return 1; }
function beta() { return 2; }
function gamma() { return 3; }
`;

export const COLLECT = `
export function collectNames(users: string[]) {
  const out = [];
  for (const u of users) {
    out.push(u);
  }
  return out;
}
`;
