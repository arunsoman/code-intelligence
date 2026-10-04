// F06 benchmark (§15/§17): what a real analysis of this repository's own history costs and what it
// finds, with every honesty surface visible in the output (boundary, exclusions by rule, hidden vs
// statically coupled edges, rank stability, and a second-run determinism check).
//   node scripts/f06-bench.ts            writes docs/eval-f06-report.json
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../packages/core/src/store.ts";
import { WorkerClient } from "../packages/core/src/worker.ts";
import { Service } from "../packages/core/src/service.ts";
import { StubProvider } from "@cie/model";
import { HistoryEngine, normalizePolicy, policyHash, type HotspotReportView } from "../packages/core/src/hotspots.ts";

const rootDir = resolve(import.meta.dirname, "..");
const ctx = { requestId: "f06-bench", idempotencyKey: "f06-bench", actor: { principalId: "system", tenantId: "local", sessionId: "bench" }, deadlineMs: Date.now() + 600_000, traceId: "bench-f06" };

async function main() {
  const policy = normalizePolicy({ window: { months: 12 }, coupling: { minSupport: 2, minConfidence: 0.2, maxFilesPerChange: 30, ubiquitousShare: 0.25 } });
  const store = new Store(":memory:");
  const worker = new WorkerClient();
  const engine = new HistoryEngine(store, worker);
  const control = { checkpoint() { /* no deadline pressure in the bench */ }, progress() { /* quiet */ } };

  // Index the head revision first so the co-change edges can be checked against the static call/import
  // graph (otherwise their static relation is honestly UNKNOWN). Search indexing is off for the bench.
  const prevSearch = process.env.CIE_SEARCH;
  process.env.CIE_SEARCH = "off";
  const tIndex = performance.now();
  let indexed: { ok: boolean; files?: number; error?: string } = { ok: false };
  try {
    const svc = new Service(store, worker, new StubProvider());
    const r = await svc.ingestRepository(ctx, { repoPath: rootDir });
    indexed = r.ok ? { ok: true, files: (r.value as unknown as { fileCount?: number }).fileCount } : { ok: false, error: r.error.message };
  } catch (e) { indexed = { ok: false, error: (e as Error).message }; }
  finally { if (prevSearch === undefined) delete process.env.CIE_SEARCH; else process.env.CIE_SEARCH = prevSearch; }
  const indexMs = Math.round(performance.now() - tIndex);

  const t0 = performance.now();
  const run = await engine.runAnalysis(ctx, control, rootDir, policy, 300_000);
  const analysisMs = Math.round(performance.now() - t0);

  const t1 = performance.now();
  const got = engine.getReport(ctx, { runId: run.runId, limit: 200 }) as { report: HotspotReportView };
  const report = got.report;
  const reportMs = Math.round(performance.now() - t1);

  const list = engine.listCoupling(ctx, { runId: run.runId, limit: 200 }) as { edges: { aPath: string; bPath: string; support: number; countA: number; countB: number; confidenceAToB: number; lift: number; staticDependency: string }[] };
  const hidden = list.edges.filter((e) => e.staticDependency === "NONE");
  const unknown = list.edges.filter((e) => e.staticDependency === "UNKNOWN");

  const stability = engine.rankStability(ctx, { runId: run.runId, trials: 50, topK: 5 }) as { stableFraction: number; seedHex: string; topK: number; trials: number };

  // determinism (F06-A4): the same boundary and policy reuse the stored run and the same canonical rows
  const again = await engine.runAnalysis(ctx, control, rootDir, policy, 300_000);
  const againReport = (engine.getReport(ctx, { runId: again.runId, limit: 200 }) as { report: HotspotReportView }).report;
  const rowsKey = (r: HotspotReportView) => createHash("sha256").update(r.rows.map((x) => JSON.stringify([x.path, x.rank, x.rankRaw, x.score, x.change.raw, x.renamedFrom])).sort().join("\n")).digest("hex").slice(0, 16);

  const explainTop = report.rows[0] ? engine.explainHotspot(ctx, { runId: run.runId, lineageId: report.rows[0].lineageId }) as { explain: { factors: { id: string; contribution: number }[]; score: number } } : null;

  const out = {
    at: new Date().toISOString(),
    corpus: { repository: rootDir, analysedBy: "scripts/f06-bench.ts", note: "the repository's own git history; the head revision is indexed (search indexing off) so static dependency checks are real, and the working tree is read for code-health metrics only", indexed },
    policy: { hash: policyHash(policy), window: policy.window, mergePolicy: policy.mergePolicy, decay: policy.decay, coupling: policy.coupling, contributors: policy.contributors },
    boundary: report.boundary,
    coverage: report.coverage,
    timings: { indexMs, analysisMs, reportMs },
    commits: { read: run.commitCount, dedupedSecondRun: again.deduped, sameRunId: again.runId === run.runId },
    exclusions: { total: report.exclusions.total, byRule: report.exclusions.byRule, ubiquitousFiles: report.exclusions.ubiquitousFiles.length, samples: report.exclusions.samples.slice(0, 10).map((s) => ({ hash: s.commitHash.slice(0, 10), subject: s.subject, rule: s.rule, classReason: s.classReason })) },
    ranking: {
      rows: report.rows.length,
      top: report.rows.slice(0, 10).map((r) => ({ rank: r.rank, rankRaw: r.rankRaw, path: r.path, score: Number(r.score.toFixed(4)), changes: r.change.raw, logical: r.change.logical, decayed: Number(r.change.decayed.toFixed(2)), renamedFrom: r.renamedFrom, missing: r.missing, contributors: r.knowledge.contributors })),
      factorsSumEqualsScore: explainTop ? Math.abs(explainTop.explain.factors.reduce((s, f) => s + f.contribution, 0) - explainTop.explain.score) < 1e-9 : null,
    },
    coupling: {
      total: list.edges.length,
      hidden: hidden.length,
      staticRelationUnknown: unknown.length,
      staticallyCoupled: list.edges.length - hidden.length - unknown.length,
      top: list.edges.slice(0, 10).map((e) => ({ a: e.aPath, b: e.bPath, support: e.support, countA: e.countA, countB: e.countB, confidence: Number(e.confidenceAToB.toFixed(3)), lift: Number(e.lift.toFixed(2)), staticDependency: e.staticDependency })),
      hiddenSamples: hidden.slice(0, 5).map((e) => ({ a: e.aPath, b: e.bPath, support: e.support, lift: Number(e.lift.toFixed(2)) })),
    },
    stability: { topK: stability.topK, trials: stability.trials, stableFraction: stability.stableFraction, seedHex: stability.seedHex },
    determinism: { canonicalRowsHash: rowsKey(report), secondRunRowsHash: rowsKey(againReport), secondRunSameRows: rowsKey(report) === rowsKey(againReport) },
    honesty: {
      shallow: report.coverage.shallow,
      gaps: report.coverage.gaps,
      warnings: report.warnings,
      note: "a score is a prioritisation heuristic, not a defect probability; co-change is statistical, not a dependency; contributor identity is keyed and names appear only with a policy and a grant",
    },
  };
  writeFileSync(resolve(rootDir, "docs/eval-f06-report.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ analysisMs, commits: run.commitCount, rows: report.rows.length, edges: list.edges.length, hidden: hidden.length, stableFraction: stability.stableFraction }, null, 0));
  worker.kill?.();
}

void main();
