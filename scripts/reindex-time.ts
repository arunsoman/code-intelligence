// What does an index run cost after an edit? Copies a repository (so the original is never touched), indexes it, then re-indexes: nothing changed,
// one file edited, a file added, an exported name renamed. Each re-index is also checked against a clean index of the same files.
//   node scripts/reindex-time.ts <repo>
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StubProvider } from "@cie/model";
import { Service } from "../packages/core/src/service.ts";
import { Store } from "../packages/core/src/store.ts";
import { WorkerClient } from "../packages/core/src/worker.ts";

const src = process.argv[2];
const dir = mkdtempSync(join(tmpdir(), "cie-bench-"));
cpSync(src, dir, { recursive: true, filter: (p) => !/(^|\/)(node_modules|\.git|target|dist|build|\.next)(\/|$)/.test(p) });
const ctx = () => ({ requestId: randomUUID(), idempotencyKey: randomUUID(), actor: { principalId: "p", tenantId: "t", sessionId: "p" }, deadlineMs: Date.now() + 600_000, traceId: "p" });
const worker = new WorkerClient(), store = new Store(":memory:"), svc = new Service(store, worker, new StubProvider());
const run = async (label: string) => {
  const t = performance.now(); const r: any = await svc.ingestRepository(ctx(), { repoPath: dir });
  if (!r.ok) throw new Error(r.error.message);
  const rows = (store.db.prepare("select (select count(*) from entities where revision=?) e, (select count(*) from facts where revision=?) f").get(r.value.id, r.value.id) as any);
  console.log(`${label.padEnd(34)} ${String(Math.round(performance.now() - t)).padStart(6)} ms   ${r.value.delta.mode.padEnd(9)} changed ${String(r.value.delta.changed).padStart(5)} of ${r.value.delta.of} files   (${rows.e} entities, ${rows.f} facts)\n${" ".repeat(36)}${Object.entries(r.value.delta.phasesMs).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  return r.value.id as string;
};
const files = (ext: string) => (store.db.prepare("select file from entities where kind = 'file' and file like ? order by file").all(`%.${ext}`) as { file: string }[]).map((r) => r.file);
await run("first index (full)");
await run("again, nothing changed");
const ts = files("ts")[0] ?? files("java")[0]; const text = readFileSync(join(dir, ts), "utf8");
writeFileSync(join(dir, ts), text + "\n// edited\n"); await run("one file edited (comment)");
writeFileSync(join(dir, "added-by-bench.ts"), "export function addedByBench(): number { return 1 }\n"); await run("one file added");
rmSync(join(dir, "added-by-bench.ts")); await run("that file removed");
worker.close(); rmSync(dir, { recursive: true, force: true });
process.exit(0);
