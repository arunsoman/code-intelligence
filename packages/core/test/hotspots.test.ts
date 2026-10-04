// F06 engine tests: rename-aware lineage (A1), the ranking effect of exclusions (A2), coupling support
// and hidden coupling (A3), machine-independence of the stored rows (A4), explainability (A5),
// authorization of contributor names (A6), shallow boundaries (D4), stability (D10), rewritten history
// and the honest failure modes of the operations. Acceptance ids live in the test names, matching
// docs/ledger.json entries.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StubProvider } from "@cie/model";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { WorkerClient } from "../src/worker.ts";
import type { HotspotReportView } from "@cie/schema";
import { DEFAULT_POLICY, HistoryEngine, historyFactors, inspectHead, normalizePolicy, policyHash } from "../src/hotspots.ts";
import { ctx } from "./helpers.ts";
import { commitCount, forcePushTo, head, isShallow, scriptedRepo, shallowCopyOf, type Step } from "./f06-fixtures.ts";

const engineFor = () => {
  const store = new Store(":memory:");
  const worker = new WorkerClient();
  return { store, worker, engine: new HistoryEngine(store, worker) };
};

/** Wide window and low coupling floors so small fixtures still show their edges. */
const policyFor = (patch: Record<string, unknown> = {}) => normalizePolicy({
  window: { months: 120 },
  coupling: { minSupport: 1, minConfidence: 0.1, maxFilesPerChange: 30, ubiquitousShare: 1 },
  ...patch,
});

const analyze = async (repoPath: string, policy = policyFor()) => {
  const { store, worker, engine } = engineFor();
  const r = await engine.runAnalysis(ctx(), { checkpoint() { /* no-op */ }, progress() { /* no-op */ } }, repoPath, policy, 60_000);
  return { store, worker, engine, r, policy };
};

const report = (engine: HistoryEngine, runId: string, req: Record<string, unknown> = {}): HotspotReportView => {
  const r = engine.getReport(ctx(), { runId, ...req });
  assert.ok(!("ok" in r) || (r as { ok?: boolean }).ok !== false, `report failed: ${JSON.stringify(r)}`);
  return (r as { report: HotspotReportView }).report;
};
const row = (rep: HotspotReportView, path: string) => {
  const found = rep.rows.find((x) => x.path === path);
  assert.ok(found, `no row for ${path}; rows: ${rep.rows.map((x) => x.path).join(", ")}`);
  return found;
};

// A repository whose a.ts is renamed to c.ts mid-history: the two names must be one lineage (F06-A1).
const RENAME_STEPS: Step[] = [
  { subject: "init a", date: "2026-08-01T10:00:00Z", files: { "src/a.ts": "export const a = 1;\n" } },
  { subject: "edit a", date: "2026-08-05T10:00:00Z", files: { "src/a.ts": "export const a = 2;\n" } },
  { subject: "add b", date: "2026-08-06T10:00:00Z", files: { "src/b.ts": "export const b = 1;\n" } },
  { subject: "rename a to c", date: "2026-08-10T10:00:00Z", rename: [{ from: "src/a.ts", to: "src/c.ts" }] },
  { subject: "edit c", date: "2026-08-15T10:00:00Z", files: { "src/c.ts": "export const a = 3;\n" } },
  { subject: "edit c and b", date: "2026-08-20T10:00:00Z", files: { "src/c.ts": "export const a = 4;\n", "src/b.ts": "export const b = 2;\n" } },
];

test("F06-A1 a rename does not reset a file's history (one lineage, aggregated counts)", async () => {
  const repo = scriptedRepo("f06-rename", RENAME_STEPS);
  const { engine, r } = await analyze(repo);
  const rep = report(engine, r.runId);
  const c = row(rep, "src/c.ts");
  assert.deepEqual(c.renamedFrom, ["src/a.ts"], "the current path knows its former name");
  assert.equal(rep.rows.some((x) => x.path === "src/a.ts"), false, "the old path is not a separate row");
  // counted (non-excluded) commits touching either name: init, edit a, edit c, edit c&b = 4
  assert.equal(c.change.raw, 4, `history aggregates across the rename, got ${c.change.raw}`);
  const renameExclusion = rep.exclusions.byRule.find((b) => b.rule === "rename-only");
  assert.equal(renameExclusion?.count, 1, "the pure rename is counted for lineage but excluded from frequency");
  assert.equal(c.rank, 1, "the most-changed lineage is ranked first");
});

test("F06-A2 a bulk commit cannot dominate the ranking without disclosure, and the ranking effect is shown", async () => {
  const bulkFiles: Record<string, string> = {};
  for (let i = 0; i < 50; i++) bulkFiles[`src/gen/f${i}.ts`] = `export const v${i} = ${i};\n`;
  const repo = scriptedRepo("f06-bulk", [
    { subject: "init hot", date: "2026-08-01T10:00:00Z", files: { "src/hot.ts": "export const hot = 1;\n" } },
    { subject: "init quiet", date: "2026-08-02T10:00:00Z", files: { "src/quiet.ts": "export const q = 1;\n" } },
    { subject: "bulk reformat", date: "2026-08-03T10:00:00Z", files: { ...bulkFiles, "src/hot.ts": "export const hot = 1;\n\n" } },
    { subject: "real edit", date: "2026-08-04T10:00:00Z", files: { "src/hot.ts": "export const hot = 2;\n" } },
  ]);
  const { engine, r } = await analyze(repo);
  const rep = report(engine, r.runId);
  const bulk = rep.exclusions.byRule.find((b) => b.rule === "bulk");
  assert.ok(bulk && bulk.count >= 1, "the bulk commit is listed in the exclusion ledger, never silently dropped");
  const sample = rep.exclusions.samples.find((s) => s.rule === "bulk");
  assert.ok(sample && sample.classReason.includes("files"), "the ledger says why it was excluded");
  // hot.ts is touched only twice for real; the bulk commit does not inflate it
  const hot = row(rep, "src/hot.ts");
  assert.equal(hot.change.raw, 2, `bulk churn excluded from the count, got ${hot.change.raw}`);
  // the ranking effect is visible: counting every excluded commit back in can move the row
  const ex = engine.explainHotspot(ctx(), { runId: r.runId, lineageId: hot.lineageId });
  assert.ok(!("ok" in ex) || (ex as { ok?: boolean }).ok !== false, "explainHotspot succeeds");
  const explain = (ex as { explain: { factors: { contribution: number }[]; score: number; sensitivity: { baseline: number; withClass: { rule: string; rank: number }[] }; excluded: { rule: string }[] } }).explain;
  assert.ok(explain.excluded.some((e) => e.rule === "bulk"), "the excluded commit is shown beside the counted ones");
  assert.ok(explain.sensitivity.withClass.length >= 1, "the ranking effect of the exclusion classes is computed");
  assert.equal(explain.sensitivity.baseline, hot.rank);
});

test("F06-A3 co-change always shows its support, and hidden coupling is distinguished from static dependency", async () => {
  // f1/f2 change together six times and never import each other (hidden coupling); a.ts imports b.ts and
  // changes with it (a static dependency). Solo commits on f3 keep the marginals from saturating, so lift
  // is above chance. The repository is indexed first so the static graph exists to check against.
  const steps: Step[] = [];
  for (let i = 0; i < 6; i++) steps.push({ subject: `pair ${i}`, date: `2026-08-0${i + 1}T10:00:00Z`, files: { "src/f1.ts": `export const f1 = ${i};\n`, "src/f2.ts": `export const f2 = ${i};\n` } });
  steps.push({ subject: "solo f1", date: "2026-08-09T10:00:00Z", files: { "src/f1.ts": "export const f1 = 99;\n" } });
  for (let i = 0; i < 6; i++) steps.push({ subject: `solo f3 ${i}`, date: `2026-08-1${i}T10:00:00Z`, files: { "src/f3.ts": `export const f3 = ${i};\n` } });
  for (let i = 0; i < 4; i++) steps.push({ subject: `static ${i}`, date: `2026-08-2${i}T10:00:00Z`, files: { "src/a.ts": `import { b } from "./b";\nexport const a = b(${i});\n`, "src/b.ts": `export function b(n: number) { return n + ${i}; }\n` } });
  const repo = scriptedRepo("f06-coupling", steps);
  const { store, worker, engine } = engineFor();
  const svc = new Service(store, worker, new StubProvider());
  const indexed = await svc.ingestRepository(ctx(), { repoPath: repo });
  assert.equal(indexed.ok, true, "the fixture is indexed so the static graph exists");
  const r = await engine.runAnalysis(ctx(), { checkpoint() { /* no-op */ }, progress() { /* no-op */ } }, repo, policyFor(), 60_000);
  const rep = report(engine, r.runId);
  const list = engine.listCoupling(ctx(), { runId: r.runId, limit: 100 }) as unknown as { edges: { edgeId: string; aPath: string; bPath: string; support: number; countA: number; countB: number; confidenceAToB: number; lift: number; staticDependency: string }[] };
  const edge = list.edges.find((e) => [e.aPath, e.bPath].sort().join("|") === "src/f1.ts|src/f2.ts");
  assert.ok(edge, `expected an f1/f2 co-change edge; got ${JSON.stringify(list.edges.map((e) => [e.aPath, e.bPath]))}`);
  assert.equal(edge.support, 6, "the support count is on display, not a bare ratio");
  assert.equal(edge.countA, 7, "the denominator is the number of eligible changes for f1");
  assert.ok(Math.abs(edge.confidenceAToB - 6 / 7) < 1e-9, "confidence is support / eligible changes");
  assert.ok(edge.lift > 1.2, `lift is reported and above chance, got ${edge.lift}`);
  assert.equal(edge.staticDependency, "NONE", "no static call graph edge exists: this is hidden coupling");
  const staticEdge = list.edges.find((e) => [e.aPath, e.bPath].sort().join("|") === "src/a.ts|src/b.ts");
  assert.ok(staticEdge, "the statically coupled pair also co-changes");
  assert.ok(["A_TO_B", "B_TO_A", "BOTH"].includes(staticEdge!.staticDependency), `a.ts imports b.ts, so the static relation is known: ${staticEdge!.staticDependency}`);
  const ex = engine.explainCoupling(ctx(), { edgeId: edge.edgeId }) as unknown as { explain: { support: number; commits: unknown[]; gaps: string[]; staticDependency: string } };
  assert.equal(ex.explain.support, 6);
  assert.equal(ex.explain.commits.length >= 6, true, "the commits behind the edge are listed");
  assert.ok(ex.explain.gaps.some((g) => /hidden coupling/.test(g)), "the surface says hidden coupling, not proof of a defect");
  assert.ok(rep.rows.length >= 4);
});

test("F06-A3b pairs below the reporting floor are counted but not reported", async () => {
  const repo = scriptedRepo("f06-coupling-floor", [
    { subject: "pair 1", date: "2026-08-01T10:00:00Z", files: { "src/f1.ts": "export const f1 = 1;\n", "src/f2.ts": "export const f2 = 1;\n" } },
    { subject: "pair 2", date: "2026-08-02T10:00:00Z", files: { "src/f1.ts": "export const f1 = 2;\n", "src/f2.ts": "export const f2 = 2;\n" } },
    { subject: "solo", date: "2026-08-03T10:00:00Z", files: { "src/f3.ts": "export const f3 = 1;\n" } },
  ]);
  const { engine, r } = await analyze(repo, policyFor({ coupling: { minSupport: 5, minConfidence: 0.3, maxFilesPerChange: 30, ubiquitousShare: 1 } }));
  const rep = report(engine, r.runId);
  assert.equal(rep.coverage.gaps.some((g) => /fell below the reporting floor/.test(g)), true, "the count is disclosed in the gaps");
  const list = engine.listCoupling(ctx(), { runId: r.runId }) as unknown as { edges: unknown[]; belowFloorCount: number | null };
  assert.equal(list.edges.length, 0, "no edge is reported below the floor");
  assert.ok((list.belowFloorCount ?? 0) >= 1, "but the pair is counted");
});

test("F06-A4 the same history and policy give byte-identical stored rows on a different machine path", async () => {
  const a = scriptedRepo("f06-a4", RENAME_STEPS);
  const b = join(mkdtempSync(join(tmpdir(), "cie-f06-copy-")), "elsewhere");
  cpSync(a, b, { recursive: true });
  assert.notEqual(a, b, "the two checkouts live at different paths");
  assert.equal(head(a), head(b), "same history, same head");
  const first = await analyze(a);
  const second = await analyze(b);
  const canonical = (engine: HistoryEngine, runId: string) =>
    report(engine, runId).rows
      .map((x) => JSON.stringify([x.path, x.rank, x.rankRaw, x.score, x.change.raw, x.change.decayed, x.renamedFrom]))
      .sort();
  const ra = first.engine.getReport(ctx(), { runId: first.r.runId }) as unknown as { report: { policyHash: string } };
  const rb = second.engine.getReport(ctx(), { runId: second.r.runId }) as unknown as { report: { policyHash: string } };
  assert.equal(ra.report.policyHash, rb.report.policyHash, "the policy hash has no machine state in it");
  assert.deepEqual(canonical(first.engine, first.r.runId), canonical(second.engine, second.r.runId), "the canonical rows are identical");
  // and the same boundary is deduped instead of recomputed
  const again = await first.engine.runAnalysis(ctx(), { checkpoint() { /* no-op */ }, progress() { /* no-op */ } }, a, first.policy, 60_000);
  assert.equal(again.deduped, true, "the same boundary and policy reuses the stored run (idempotent)");
  assert.equal(again.runId, first.r.runId);
});

test("F06-A4b policy hash is stable across key order and differs when a rule changes", () => {
  const a = normalizePolicy({ window: { months: 12 }, decay: { halfLifeDays: 180 }, contributors: "COUNTS_ONLY" });
  const b = normalizePolicy({ contributors: "COUNTS_ONLY", decay: { halfLifeDays: 180 }, window: { months: 12 } });
  assert.equal(policyHash(a), policyHash(b), "canonical JSON ignores key order");
  const c = normalizePolicy({ window: { months: 12 }, decay: { halfLifeDays: 90 }, contributors: "COUNTS_ONLY" });
  assert.notEqual(policyHash(a), policyHash(c), "a changed decay half-life is a different analysis");
  assert.equal(policyHash(DEFAULT_POLICY).length, 64);
});

test("F06 §17 terrain integration: historyFactors reads churn/knowledge from the run only when the flag is on", async () => {
  const repo = scriptedRepo("f06-terrain", RENAME_STEPS);
  const { store, engine } = await analyze(repo);
  const rev = { repoRoot: repo } as never;
  assert.equal(historyFactors(store, rev), null, "off by default: the terrain behaves exactly as before");
  engine.setTerrainV2(true);
  const h = historyFactors(store, rev);
  assert.ok(h, "with the flag on and a usable run, the factors resolve");
  const c = h!.factors.get("src/c.ts");
  assert.ok(c, `the renamed lineage's newest path has factors: ${JSON.stringify([...h!.factors.keys()])}`);
  assert.equal(typeof c!.churn, "number");
  assert.ok(c!.churn >= 0 && c!.churn <= 1, "churn is normalised 0..1");
  assert.match(h!.raw.get("src/c.ts")!.churn, /change\(s\) in the analysed window/);
  engine.setTerrainV2(false);
  assert.equal(historyFactors(store, rev), null, "turning it off restores the old terrain inputs");
});

test("F06 incremental analysis reads only the commits after the previous head and keeps the window whole", async () => {
  const repo = scriptedRepo("f06-incremental", RENAME_STEPS);
  const { engine, r } = await analyze(repo);
  const before = report(engine, r.runId);
  const rowsBefore = before.rows.length;
  // a new commit on the same window
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  writeFileSync(join(repo, "src/later.ts"), "export const later = 1;\n");
  const { gitIn } = await import("./f06-fixtures.ts");
  gitIn(repo, ["add", "-A"]);
  gitIn(repo, ["commit", "-q", "-m", "later work"], { GIT_AUTHOR_DATE: "2026-09-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-09-01T10:00:00Z", GIT_AUTHOR_NAME: "Dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "Dana", GIT_COMMITTER_EMAIL: "dana@example.com" });
  const again = await engine.runAnalysis(ctx(), { checkpoint() { /* no-op */ }, progress() { /* no-op */ } }, repo, policyFor(), 60_000);
  assert.equal(again.deduped, false, "a new head means a new boundary");
  assert.equal(again.commitCount, r.commitCount + 1, "the window still covers every commit, old and new");
  const after = report(engine, again.runId);
  assert.equal(after.rows.length, rowsBefore + 1, "the new file is ranked and the old rows survive");
  assert.ok(after.rows.some((x) => x.path === "src/later.ts"), "the incrementally read commit is in the report");
  assert.ok(after.rows.some((x) => x.path === "src/c.ts" && x.renamedFrom.includes("src/a.ts")), "older lineage history is preserved from the store");
});

test("F06-A5 every ranking explains itself: factors sum to the score, counted and excluded commits are named", async () => {
  const repo = scriptedRepo("f06-explain", [
    { subject: "init", date: "2026-08-01T10:00:00Z", files: { "src/x.ts": "export const x = 1;\n", "src/y.ts": "export const y = 1;\n" } },
    { subject: "bump", date: "2026-08-02T10:00:00Z", author: { name: "renovate[bot]", email: "renovate@users.noreply.github.com" }, files: { "package-lock.json": "{}\n" } },
    { subject: "Revert \"init\"", date: "2026-08-03T10:00:00Z", files: { "src/x.ts": "", "src/y.ts": "" } },
    { subject: "edit x", date: "2026-08-04T10:00:00Z", files: { "src/x.ts": "export const x = 2;\n" } },
  ]);
  const { engine, r } = await analyze(repo);
  const rep = report(engine, r.runId);
  const x = row(rep, "src/x.ts");
  const ex = engine.explainHotspot(ctx(), { runId: r.runId, lineageId: x.lineageId }) as unknown as { explain: { factors: { id: string; label: string; contribution: number; weight: number; missing: boolean }[]; score: number; changes: unknown[]; trend: { month: string }[]; sensitivity: { baseline: number; withoutFactor: unknown[]; withClass: unknown[] } } };
  const sum = ex.explain.factors.reduce((s, f) => s + f.contribution, 0);
  assert.ok(Math.abs(sum - ex.explain.score) < 1e-9, `factor contributions sum to the score (${sum} vs ${ex.explain.score})`);
  assert.equal(ex.explain.factors.length, 5);
  assert.ok(ex.explain.factors.every((f) => f.weight > 0), "each factor states its weight");
  assert.ok(ex.explain.changes.length >= 1, "the counted commits are listed; the score is not a black box");
  assert.equal(ex.explain.sensitivity.baseline, x.rank, "the baseline rank matches the report");
  assert.equal(ex.explain.sensitivity.withoutFactor.length, 5, "the effect of removing each factor is computed");
  assert.ok(ex.explain.trend.length >= 1, "the monthly trend is produced");
  // a revert pair is excluded together and shown
  assert.ok(rep.exclusions.byRule.some((b) => b.rule === "revert-pair"), "the revert pair is in the ledger");
  const revRow = engine.explainHotspot(ctx(), { runId: r.runId, lineageId: x.lineageId }) as unknown as { explain: { excluded: { rule: string }[] } };
  assert.ok(revRow.explain.excluded.some((e) => e.rule === "revert-pair"), "the excluded revert is shown with the counted commits");
});

test("F06-A6 contributor identity respects the policy and a grant; HIDDEN leaks nothing", async () => {
  const repo = scriptedRepo("f06-names", RENAME_STEPS);
  const hidden = await analyze(repo, policyFor({ contributors: "HIDDEN" }));
  const hiddenRep = report(hidden.engine, hidden.r.runId);
  assert.equal(hiddenRep.contributorsAvailable, false);
  assert.ok(hiddenRep.rows.every((x) => x.knowledge.contributors === "HIDDEN"), "counts are hidden, not just names");
  const hiddenEx = hidden.engine.explainHotspot(ctx(), { runId: hidden.r.runId, lineageId: hiddenRep.rows[0].lineageId }) as unknown as { explain: { contributors?: unknown[] } };
  assert.equal(hiddenEx.explain.contributors, undefined, "no per-person breakdown under HIDDEN");

  const counts = await analyze(repo, policyFor({ contributors: "COUNTS_ONLY" }));
  const countsRep = report(counts.engine, counts.r.runId);
  assert.ok(countsRep.rows.every((x) => typeof x.knowledge.contributors === "number" && x.knowledge.contributors >= 1));
  const countsEx = counts.engine.explainHotspot(ctx(), { runId: counts.r.runId, lineageId: countsRep.rows[0].lineageId }) as unknown as { explain: { contributors?: unknown[] } };
  assert.equal(countsEx.explain.contributors, undefined, "COUNTS_ONLY never reveals a name");

  const named = await analyze(repo, policyFor({ contributors: "NAMES_FOR_AUTHORISED" }));
  const namedRep = report(named.engine, named.r.runId);
  const principal = { ...ctx(), actor: { principalId: "lead", tenantId: "t", sessionId: "t" } };
  const before = named.engine.explainHotspot(principal, { runId: named.r.runId, lineageId: namedRep.rows[0].lineageId }) as unknown as { explain: { contributors?: { displayName: string; commits: number }[] } };
  assert.equal(before.explain.contributors, undefined, "the policy alone is not enough: a grant is required");
  named.engine.grantContributorNames("lead", true);
  const after = named.engine.explainHotspot(principal, { runId: named.r.runId, lineageId: namedRep.rows[0].lineageId }) as unknown as { explain: { contributors?: { displayName: string; commits: number }[] } };
  assert.ok(after.explain.contributors?.some((c) => c.displayName === "Dana"), "after the grant the author name is returned");
  named.engine.grantContributorNames("lead", false);
  const revoked = named.engine.explainHotspot(principal, { runId: named.r.runId, lineageId: namedRep.rows[0].lineageId }) as unknown as { explain: { contributors?: unknown[] } };
  assert.equal(revoked.explain.contributors, undefined, "revoking the grant removes the names again");
});

test("F06-D4 a shallow clone is flagged and every score is called a lower bound", async () => {
  const full = scriptedRepo("f06-shallow-src", RENAME_STEPS);
  const shallow = shallowCopyOf(full);
  assert.equal(isShallow(shallow), true, "the fixture really is shallow");
  assert.ok(commitCount(shallow) < commitCount(full), "it does not contain the full history");
  const { engine, r } = await analyze(shallow);
  assert.equal(r.state === "COMPLETE" || r.state === "PARTIAL", true);
  const rep = report(engine, r.runId);
  assert.equal(rep.coverage.shallow, true);
  assert.ok(rep.warnings.some((w) => /shallow/i.test(w) && /lower bound/i.test(w)), "the report says scores are lower bounds");
});

test("F06-D10 rank stability is deterministic for a policy and reports a stable fraction", async () => {
  const repo = scriptedRepo("f06-stability", RENAME_STEPS);
  const { engine, r } = await analyze(repo);
  const s1 = engine.rankStability(ctx(), { runId: r.runId, trials: 20, topK: 3 }) as unknown as { stableFraction: number; seedHex: string; trials: number; changes: unknown[] };
  const s2 = engine.rankStability(ctx(), { runId: r.runId, trials: 20, topK: 3 }) as unknown as { stableFraction: number; seedHex: string };
  assert.equal(s1.trials, 20);
  assert.equal(s1.seedHex, s2.seedHex, "the seed is derived from the policy hash");
  assert.equal(s1.stableFraction, s2.stableFraction, "the same trials give the same fraction");
  assert.ok(s1.stableFraction >= 0 && s1.stableFraction <= 1);
  const rep = report(engine, r.runId);
  assert.ok(rep.stability && rep.stability.trials >= 2, "the report carries the stability view");
});

test("F06 rewritten history invalidates a stored run instead of silently mixing it", async () => {
  const repo = scriptedRepo("f06-rewrite", RENAME_STEPS);
  const { engine, r } = await analyze(repo);
  const before = inspectHead(repo).head;
  forcePushTo(repo, 2, "rewrite: drop the last two commits");
  assert.notEqual(inspectHead(repo).head, before, "the fixture rewrote the head");
  const rep = report(engine, r.runId);
  assert.equal(rep.stale.rewritten, true, "a non-ancestor head is a rewrite");
  assert.equal(rep.state, "INVALIDATED", "the stored run is marked INVALIDATED, not left looking current");
  assert.ok(rep.warnings.some((w) => /rewritten|INVALIDATED/i.test(w)), "the surface says the boundary is invalidated");
});

test("F06 operations are honest about a non-git folder and run through the job runner", async () => {
  const worker = new WorkerClient();
  const svc = new Service(new Store(":memory:"), worker, new StubProvider());
  const notRepo = mkdtempSync(join(tmpdir(), "cie-f06-plain-"));
  const bad = await svc.hotspotOps["C26/analyzeHistory"](ctx(), { repoPath: notRepo }) as { ok: boolean; error?: { code: string } };
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.code, "INSUFFICIENT_EVIDENCE", "not a work tree is an evidence problem, not an internal error");

  const repo = scriptedRepo("f06-op", RENAME_STEPS);
  const job = await svc.hotspotOps["C26/analyzeHistory"](ctx(), { repoPath: repo, policy: { window: { months: 120 } } }) as { ok: boolean; value?: { state: string; runId: string } };
  assert.equal(job.ok, true, `analyzeHistory succeeded: ${JSON.stringify(job)}`);
  assert.equal(job.value?.state, "COMPLETE");
  const rep = await svc.hotspotOps["C26/getHotspotReport"](ctx(), { runId: job.value!.runId }) as { ok: boolean; value: { report: HotspotReportView } };
  assert.equal(rep.ok, true);
  assert.ok(rep.value.report.rows.length >= 2, "the op returns the report rows");
  const coupling = await svc.hotspotOps["C26/listCoupling"](ctx(), { runId: job.value!.runId }) as { ok: boolean; value: { total: number } };
  assert.equal(coupling.ok, true);
  const stability = await svc.hotspotOps["C26/rankStability"](ctx(), { runId: job.value!.runId, trials: 4, topK: 2 }) as { ok: boolean };
  assert.equal(stability.ok, true);
  // the same (repository, boundary, policy) dedupes to one job
  const again = await svc.hotspotOps["C26/analyzeHistory"](ctx(), { repoPath: repo, policy: { window: { months: 120 } } }) as { ok: boolean; value?: { runId: string; deduped?: boolean } };
  assert.equal(again.ok, true);
  assert.equal(again.value?.runId, job.value!.runId, "idempotent per boundary and policy");
});

test("F06 deny-listed paths are never named in a report, only counted", async () => {
  const repo = scriptedRepo("f06-denied", [
    { subject: "init secret", date: "2026-08-01T10:00:00Z", files: { "secrets/key.ts": "export const k = 1;\n" } },
    { subject: "init open", date: "2026-08-02T10:00:00Z", files: { "src/open.ts": "export const o = 1;\n" } },
    { subject: "edit open", date: "2026-08-03T10:00:00Z", files: { "src/open.ts": "export const o = 2;\n" } },
  ]);
  const { store, engine, r } = await analyze(repo);
  (store as unknown as { deniedPrefixes: (root: string) => string[] }).deniedPrefixes = () => ["secrets"]; // the auth hook the store consults; set after analysis, as a policy change would be
  const rep = report(engine, r.runId);
  assert.equal(rep.rows.some((x) => x.path.startsWith("secrets/")), false, "the denied file is not listed");
  assert.ok(rep.warnings.some((w) => /do not have access/.test(w)), "the omission is disclosed as a count");
  assert.equal(rep.warnings.join(" ").includes("secrets/key"), false, "the denied path is never named");
});
