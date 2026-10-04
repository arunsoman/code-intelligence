// Which operations block the server's event loop, and where? While one request runs synchronous code, every other request (the page, health checks, other
// users) waits, so the number that matters is the longest single stretch without yielding, not the total time.
// For each operation on a repository: wall time, the longest event-loop stall, and the code that was running (CPU profile self time, own code only).
//   node scripts/profile-eventloop.ts <repo> [--db <file>]        uses a temporary database unless --db is given; the repository is only read
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StubProvider } from "@cie/model";
import type { CallContext } from "@cie/schema";
import { Service } from "../packages/core/src/service.ts";
import { Store } from "../packages/core/src/store.ts";
import { WorkerClient } from "../packages/core/src/worker.ts";

const args = process.argv.slice(2);
const repo = resolve(args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--db") ?? "");
const dbFlag = args.indexOf("--db");
const tmp = mkdtempSync(join(tmpdir(), "cie-prof-"));
const dbFile = dbFlag >= 0 ? args[dbFlag + 1] : join(tmp, "p.db");
const ctx = (): CallContext => ({ requestId: randomUUID(), idempotencyKey: randomUUID(), actor: { principalId: "p", tenantId: "t", sessionId: "p" }, deadlineMs: Date.now() + 3_600_000, traceId: "p" });

const worker = new WorkerClient();
const svc = new Service(new Store(dbFile), worker, new StubProvider());
const session = new Session(); session.connect(); await session.post("Profiler.enable");

interface Row { op: string; wallMs: number; maxStallMs: number; stalls100: number; ok: boolean; hot: string[] }
const rows: Row[] = [];

/** Longest gap between two timer ticks while `fn` runs: a tick scheduled every 2 ms that is late by N ms means the loop was blocked for about N ms. */
async function measure(op: string, fn: () => unknown | Promise<unknown>) {
  let last = performance.now(), max = 0, over = 0;
  const tick = setInterval(() => { const now = performance.now(), gap = now - last - 2; if (gap > max) max = gap; if (gap > 100) over++; last = now; }, 2);
  await session.post("Profiler.start");
  const t0 = performance.now(); let ok = true;
  try { const r: any = await fn(); if (r && typeof r === "object" && "ok" in r && r.ok === false) ok = false; } catch { ok = false; }
  const wall = performance.now() - t0;
  // If the loop was blocked right up to the end, no tick has run since: count that last stretch too.
  { const gap = performance.now() - last - 2; if (gap > max) max = gap; if (gap > 100) over++; }
  const { profile } = await session.post("Profiler.stop") as { profile: { nodes: any[]; samples: number[]; timeDeltas: number[] } };
  clearInterval(tick);
  const byId = new Map(profile.nodes.map((n) => [n.id, n])), self = new Map<string, number>();
  profile.samples.forEach((s, i) => { const f = byId.get(s).callFrame; if (!f.url.includes("/cie/")) return; const k = `${f.functionName || "(anon)"} ${f.url.replace(/^.*\/cie\//, "")}:${f.lineNumber + 1}`; self.set(k, (self.get(k) ?? 0) + profile.timeDeltas[i] / 1000); });
  const hot = [...self].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, ms]) => `${Math.round(ms)}ms ${k}`);
  rows.push({ op, wallMs: Math.round(wall), maxStallMs: Math.round(max), stalls100: over, ok, hot });
  console.log(`${op.padEnd(34)} wall ${String(Math.round(wall)).padStart(7)} ms   longest stall ${String(Math.round(max)).padStart(6)} ms   ${ok ? "" : "(failed) "}${hot[0] ?? ""}`);
}

let revision = "";
await measure("index repository", async () => { const r = await svc.ingestRepository(ctx(), { repoPath: repo }); if (r.ok) revision = r.value.id; return r; });
if (!revision) { console.error("indexing failed"); process.exit(1); }
const ents = svc.store.entities(revision);
console.log(`  ${ents.length} entities, ${svc.store.relationshipsAmong(revision, "calls").length} calls`);
await measure("extract concepts (offline model)", () => svc.extractConcepts(ctx(), { revision }));
await measure("list visuals", () => svc.visuals(ctx(), { revision }));
for (const form of ["SemanticMap", "CausalGraph", "TransactionJourney", "DataLineage", "SemanticDiff", "Archaeology", "TrustBoundary", "RuntimeOverlay", "RaceWindow", "Counterfactual", "TestConfidence", "Ownership", "ConceptAtlas", "PolicyMap", "ChangeRisk"])
  await measure(`ask: ${form}`, () => svc.ask(ctx(), { question: "how does the application handle users and orders", revision, form }));
await measure("ask: free text (retrieval)", () => svc.ask(ctx(), { question: "how does login work", revision, form: "SemanticMap" }));
await measure("converse: project overview", () => svc.converse(ctx(), { text: "overview", revision }));
await measure("security analysis", () => (svc.securityOps as any)["C25/analyze"](ctx(), { revision }));
await measure("defect detection (indexed)", () => svc.detectDefects(ctx(), { revision } as any));
await measure("revision stats", () => svc.revisionStats(ctx(), { revision } as any));
await measure("changes since index", () => svc.changesSinceIndex(ctx(), { revision } as any));
const first = ents.find((e) => e.kind === "function" || e.kind === "method");
if (first) await measure("explain one element", () => svc.explain(ctx(), { revision, entityIds: [first.entityId], question: "what is this" } as any));
await measure("re-index (unchanged)", () => svc.ingestRepository(ctx(), { repoPath: repo }));

console.log("\nstalls over 250 ms:");
for (const r of rows.filter((r) => r.maxStallMs > 250).sort((a, b) => b.maxStallMs - a.maxStallMs)) console.log(`  ${r.maxStallMs} ms  ${r.op}\n      ${r.hot.join("\n      ")}`);
writeFileSync(join(import.meta.dirname, "../docs/eventloop-profile.json"), JSON.stringify({ repo, entities: ents.length, at: new Date().toISOString(), rows }, null, 1));
worker.close(); if (!dbFlag) rmSync(tmp, { recursive: true, force: true });
process.exit(0);
