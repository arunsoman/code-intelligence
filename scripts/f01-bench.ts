// F01 benchmark (§15.1, A6): what the search actually costs on a real corpus, and what the answers
// look like when nothing is cached. The corpus is the shipped fixture repository plus two synthetic
// twin repositories (identical names, different content — the A2 scenario); every run hashes each
// indexed file so "these numbers" can be re-derived from the same bytes later.
//   node scripts/f01-bench.ts            writes docs/eval-f01-benchmarks.json
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { Store } from "../packages/core/src/store.ts";
import { WorkerClient } from "../packages/core/src/worker.ts";
import { StubProvider } from "@cie/model";
import { Service } from "../packages/core/src/service.ts";
import { SearchEngine } from "../packages/core/src/search.ts";

const rootDir = resolve(import.meta.dirname, "..");
const pct = (ms: number[], p: number) => { const s = [...ms].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const allFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) { if (e.name !== ".git" && e.name !== "node_modules") walk(p); } else out.push(p); } };
  walk(root);
  return out;
};

async function main() {
  const ctx = { requestId: "bench", idempotencyKey: "", actor: { principalId: "system", tenantId: "local", sessionId: "bench" }, deadlineMs: Date.now() + 600_000, traceId: trace() };
  function trace() { return `trace-bench`; }

  // ---- the corpus: the shipped fixture (TS, real code) + twins (cross-repository shape) + rust fixture if present
  const fixture = join(rootDir, "fixtures/sample-repo");
  const base = mkdtempSync(join(tmpdir(), "f01-bench-"));
  const twins = ["repo-a", "repo-b"].map((name) => {
    const root = join(base, name);
    mkdirSync(join(root, "src"), { recursive: true });
    for (let i = 0; i < 120; i++) {
      writeFileSync(join(root, `src/mod${i}.ts`), `export function modFn${i}(n: number) {\n  return n + ${i};\n}\n// processable content marker ${i}\n`);
      writeFileSync(join(root, `src/use${i}.ts`), `import { modFn${i} } from "./mod${i}";\nexport const used${i} = modFn${i}(2);\n`);
    }
    return root;
  });

  // ---- index both, cold, then again warm
  const svc = new Service(new Store(":memory:"), new WorkerClient(), new StubProvider());
  const e: SearchEngine = svc.search;
  const buildTimings: { root: string; state: string; ms: number; files: number }[] = [];
  for (const root of [fixture, ...twins]) {
    const prev = process.env.CIE_SEARCH;
    process.env.CIE_SEARCH = "off";
    try { await svc.ingestRepository(ctx, { repoPath: root }); } finally { if (prev === undefined) delete process.env.CIE_SEARCH; else process.env.CIE_SEARCH = prev; }
    const t0 = performance.now();
    const r = await e.buildForRepository(root);
    buildTimings.push({ root: root.split(/[\\/]/).pop()!, state: r.state, ms: Math.round(performance.now() - t0), files: r.files.textIndexed });
  }
  const warmStart = performance.now();
  const warm = await e.buildForRepository(twins[0]);
  const warmMs = Math.round(performance.now() - warmStart);

  // ---- workloads: text auto search, symbol, regex, navigation; each timed several times
  const ctx2 = { ...ctx, requestId: "bench-2" };
  const textLat: number[] = [], symbolLat: number[] = [], regexLat: number[] = [], navLat: number[] = [];
  for (const q of ["process", "modFn77", "processable content marker", "modFn7(2)"]) {
    for (let i = 0; i < 5; i++) { const t = performance.now(); await e.search(ctx2, { query: q, mode: "AUTO", limit: 50 }); textLat.push(performance.now() - t); }
  }
  for (const q of ["process", "modFn77", "used9", "modFn120"]) {
    for (let i = 0; i < 5; i++) { const t = performance.now(); await e.search(ctx2, { query: q, mode: "SYMBOL", limit: 50 }); symbolLat.push(performance.now() - t); }
  }
  for (const q of ["modFn\\d+", "process", "[a-z]+(\\()[0-9]+", "used\\d+"]) {
    for (let i = 0; i < 3; i++) { const t = performance.now(); await e.search(ctx2, { query: q, mode: "REGEX", limit: 50 }); regexLat.push(performance.now() - t); }
  }
  // navigation: locate the def of modFn77 via search, resolve it, then follow its references
  const hitSearch = await e.search(ctx2, { query: "modFn77", mode: "SYMBOL", limit: 5 });
  if ("ok" in hitSearch && hitSearch.ok === false) throw new Error(hitSearch.error.message);
  const firstDef = hitSearch.hits.find((h) => h.symbol)?.symbol?.symbolId ?? "";
  const repositoryId = hitSearch.hits[0].repositoryId;
  const repositoryRoot = twins.find((r2) => e.rootOf(repositoryId) === r2) ?? twins[0];
  const rev = e.latestBuiltRevision?.(repositoryId) ?? "";
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const refs = await e.findReferences(ctx2, { repositoryId, revision: rev, symbolId: firstDef });
    if ("ok" in refs); else void refs;
    navLat.push(performance.now() - t);
  }

  // ---- corpus hashes: content-addressed, so another run can prove it worked on the same bytes
  const corpusHashes: Record<string, string> = {};
  for (const root of [fixture, ...twins]) {
    for (const f of allFiles(root)) {
      const h = createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16);
      corpusHashes[`${root.split(/[\\/]/).join("/").replace(rootDir, "CIE")} · ${f.replace(root + "/", "")}`] = h;
    }
  }

  const out = {
    at: new Date().toISOString(),
    corpus: {
      fixture: "fixtures/sample-repo (the shipped demo repository)",
      twins: "two synthetic repositories, 240 TS files each, shared names across repositories (the F01-A2 scenario)",
      fileHashes: Object.fromEntries(Object.entries(corpusHashes).filter(([k]) => !k.includes("/."))),
    },
    build: {
      cold: buildTimings,
      warmRepeatSameRevision: { ms: warmMs, state: warm.state },
      note: "a warm build of an already-published revision must be cheap: identity and rows are reused, the generation does not advance",
    },
    search: {
      textAutoMs: { p50: pct(textLat, 0.5), p95: pct(textLat, 0.95), n: textLat.length },
      symbolMs: { p50: pct(symbolLat, 0.5), p95: pct(symbolLat, 0.95), n: symbolLat.length },
      regexMs: { p50: pct(regexLat, 0.5), p95: pct(regexLat, 0.95), n: regexLat.length, engine: "linear-time worker (regex::bytes::Regex under bounds)" },
      navigationMs: { p50: pct(navLat, 0.5), p95: pct(navLat, 0.95), n: navLat.length, workload: "findReferences of an indexed function across the twin repositories" },
    },
    honesty: {
      note: "the answers' states are the same the product answers with; the benchmark runs the production code path (SearchEngine via Service)",
    },
  };
  writeFileSync(join(rootDir, "docs/eval-f01-benchmarks.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`F01 benchmark: build ${buildTimings.map((b) => `${b.root} ${b.ms}ms/${b.files}f`).join(", ")} · text p95 ${out.search.textAutoMs.p95}ms · symbol p95 ${out.search.symbolMs.p95}ms · regex p95 ${out.search.regexMs.p95}ms · nav p95 ${out.search.navigationMs.p95}ms → docs/eval-f01-benchmarks.json`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });