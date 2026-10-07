import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthorityConfig } from "../src/feature/authority.ts";
import { ConfigError } from "../src/feature/config.ts";
import { FeatureError } from "../src/feature/errors.ts";
import { DEFAULT_ANALYSIS_POLICY, PERF_CASES, PERF_PROFILE, PERF_RISK_TRIGGERS, analysisPolicyHashOf, assessPerformanceRisk, bootstrapCi, compareRuns, defaultAnalysisPolicyHash, evaluateExperiment, evaluatePerformance, loadPerfRegistry, mulberry32, percentileOf, populationCheck,
  runPairedBenchmark, type PerfRunDeps, type PerfWorkload, type PerfMeasurementPlan, type RunPairedBenchmarkInput } from "../src/feature/perf.ts";
import { memoryBaselineCache, memoryLease, perfRunCheck } from "../src/feature/perf-handlers.ts";
import type { PairedExperiment, PerfCaseRun, PerformanceBudget, RunRequest, RunResult, Runner } from "../src/feature/types.ts";
import { validationFixture } from "./feature-validation-fixtures.ts";

const auth: AuthorityConfig = { bindings: [{ id: "perf-owner", scope: "performance", principals: ["owner"] }] };
const WL = "workload-1", MP = "plan-1", ENV = "env-1";
const workload: PerfWorkload = { entry: "bench.js", files: { "bench.js": "// scripted" }, cases: { P0: {}, P1: {}, P2: { env: { LOAD: "2x" } }, P3: { argv: ["--large"] } } };
const mplan = (over: Partial<PerfMeasurementPlan> = {}): PerfMeasurementPlan => ({ repetitions: 10, cases: ["P0", "P1"], baselineCases: ["P0"], ...over });

/** A runner that answers each repetition from a function of (side, case, rep). No candidate code is executed. */
class PerfRunner implements Runner {
  readonly isolation = "CONTAINER" as const; readonly omissions: string[] = []; calls: RunRequest[] = [];
  sample: (side: string, c: string, rep: number) => { outcome?: string; latency?: number } | string | RunResult;
  constructor(sample: (side: string, c: string, rep: number) => { outcome?: string; latency?: number } | string | RunResult = () => ({})) { this.sample = sample; }
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push(req); const side = req.env!.PF_SIDE!, c = req.env!.PF_CASE!, rep = this.calls.filter((r) => r.env!.PF_SIDE === side && r.env!.PF_CASE === c).length - 1;
    const s = this.sample(side, c, rep);
    const base = { exitCode: 0, stderr: "", truncated: false, isolation: this.isolation, omissions: [], usage: { wallMs: 1 } };
    if (typeof s === "string") return { status: "PASSED", stdout: s, ...base };
    if ("status" in s) return s as RunResult;
    return { status: "PASSED", stdout: `noise\nPF_PERF ${JSON.stringify({ outcome: s.outcome ?? "SUCCESS", metrics: { latencyMs: s.latency ?? (side === "BASELINE" ? 100 : 100) + (rep % 3) } })}\n`, ...base };
  }
}
const input = (f: ReturnType<typeof validationFixture>, over: Partial<RunPairedBenchmarkInput> = {}): RunPairedBenchmarkInput => ({ baselineSnapshot: { repositoryId: f.root, commitHash: f.candidate.binding.baseCommitHash, contentRootHash: f.candidate.binding.baseContentHash, indexGeneration: 1, toolchainHash: "tc" },
  patchBindingHash: f.candidate.bindingHash, workloadHash: WL, environmentHash: ENV, measurementPlanHash: MP, budget: { wallMs: 60_000 }, budgetIds: ["b1"], promotedBy: [], ...over });
const deps = (f: ReturnType<typeof validationFixture>, runner: Runner, over: Partial<PerfRunDeps> = {}): PerfRunDeps => ({ fs: f.fs, runner, workload: (h) => (h === WL ? workload : null), measurementPlan: (h) => (h === MP ? mplan() : null), environment: () => ({ representative: true }), ...over });
const budget = (over: Partial<PerformanceBudget> = {}): PerformanceBudget => ({ id: "b1", metric: "latencyMs", units: "ms", aggregation: "p50", workloadDomainHash: WL, allowedDelta: 5, errorConstraints: [], measurementPlanHash: MP, authorityBindingId: "perf-owner", ...over });
const evalOpts = (b: PerformanceBudget | null = budget(), a = auth) => ({ budgetIds: ["b1"], budgets: (id: string) => (id === "b1" ? b : null), authority: a, policy: DEFAULT_ANALYSIS_POLICY });

test("S11 statistics: percentiles, a seeded bootstrap that is reproducible and brackets the true difference, and a population check that rejects dropped errors", () => {
  assert.deepEqual([50, 95, 99].map((p) => Number(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], p).toFixed(2))), [5.5, 9.55, 9.91], "linear interpolation between ranks"); assert.equal(percentileOf([42], 99), 42);
  const a = mulberry32(7), b = mulberry32(7), c = mulberry32(8); const sa = [a(), a(), a()], sb = [b(), b(), b()];
  assert.deepEqual(sa, sb); assert.notDeepEqual(sa, [c(), c(), c()]); assert.ok(sa.every((x) => x >= 0 && x < 1));
  const diffs = [4, 5, 6, 5, 4, 6, 5, 5, 4, 6]; const ci1 = bootstrapCi(diffs, 2000, 1), ci2 = bootstrapCi(diffs, 2000, 1);
  assert.deepEqual(ci1, ci2); assert.ok(ci1.low >= 4 && ci1.high <= 6 && ci1.low <= 5 && ci1.high >= 5, JSON.stringify(ci1)); assert.ok(bootstrapCi(diffs, 2000, 2).low >= 4);
  const pop = (s: number, e = 0, t = 0, ca = 0) => ({ SUCCESS: s, ERROR: e, TIMEOUT: t, CANCELLED: ca });
  assert.ok(populationCheck(pop(10), pop(10)).ok); assert.ok(populationCheck(pop(8, 2), pop(8, 2)).ok);
  assert.match(populationCheck(pop(10), pop(9)).reason!, /dropped samples reject the comparison/); assert.match(populationCheck(pop(8, 2), pop(10)).reason!, /drops errors is rejected \(AT-18\)/);
  assert.equal(analysisPolicyHashOf(DEFAULT_ANALYSIS_POLICY), defaultAnalysisPolicyHash()); assert.notEqual(analysisPolicyHashOf({ ...DEFAULT_ANALYSIS_POLICY, seed: 2 }), defaultAnalysisPolicyHash());
  assert.equal(analysisPolicyHashOf({ ...DEFAULT_ANALYSIS_POLICY, percentiles: [99, 95, 50] }), defaultAnalysisPolicyHash(), "percentile order is not identity");
  assert.deepEqual(PERF_CASES, ["P0", "P1", "P2", "P3"]); assert.equal(PERF_PROFILE, "pf-perf-core-v1");
});

test("PF-027/044 risk predicate: applicability is read from the lines the diff ADDED, triggers are recorded, and an unrelated change is not applicable", () => {
  const f = validationFixture();
  try {
    let n = 0;
    const risk = (contents: Record<string, string | null>, baseContents: Record<string, string | null> = {}) => {
      const cand = { ...f.candidate, id: `cand-risk-${++n}`, ordinal: 100 + n, bindingHash: `binding-risk-${n}`, contents, baseContents }; f.fs.putCandidate(cand);
      return assessPerformanceRisk({ fs: f.fs }, { contractHash: "contract-hash", patchBindingHash: `binding-risk-${n}`, runtimeEvidenceIds: ["ev-missing"] });
    };
    const none = risk({ "src/a.ts": "export const title = 'hello';\n" }); assert.equal(none.value!.applicable, false); assert.deepEqual(none.value!.triggers, []); assert.match(none.value!.rationale![0]!, /touches no request path/);
    assert.match(none.diagnostics[0]!, /runtime evidence ev-missing is not on record/);
    const hot = risk({ "src/h.ts": "router.get('/x', async (req, res) => {\n  const rows = await db.query('select * from t');\n  for (const r of rows) { await pool.acquire(); }\n  await retryWithTimeout(call);\n});\n" });
    assert.equal(hot.value!.applicable, true); assert.deepEqual(hot.value!.triggers.sort(), ["cancellation", "long-held-db-connections", "resource-sharing-concurrency", "retries-external-degradation"].sort().filter((t) => hot.value!.triggers.includes(t)));
    assert.ok(hot.value!.rationale!.some((r) => /touches request path: src\/h\.ts/.test(r)) && hot.value!.rationale!.some((r) => /touches query/.test(r)) && hot.value!.rationale!.some((r) => /§30\.3 trigger/.test(r)));
    const unchanged = risk({ "src/h.ts": "router.get('/x', handler);\n" }, { "src/h.ts": "router.get('/x', handler);\n" }); assert.equal(unchanged.value!.applicable, false, "a line already in the base is not something this change added");
    assert.equal(risk({ "src/gone.ts": null }).value!.applicable, false);
    assert.ok(PERF_RISK_TRIGGERS.includes("migration-scale") && PERF_RISK_TRIGGERS.length === 7);
    assert.throws(() => assessPerformanceRisk({ fs: f.fs }, { contractHash: "", patchBindingHash: "x", runtimeEvidenceIds: [] }), (e: any) => e.code === "INVALID_SCHEMA");
    assert.throws(() => assessPerformanceRisk({ fs: f.fs }, { contractHash: "c", patchBindingHash: "nope", runtimeEvidenceIds: [] }), (e: any) => e.code === "NOT_FOUND");
  } finally { f.close(); }
});

test("AT-17/18/19/20/21 benchmark and evaluation: within budget, regression, inconclusive and every UNVALIDATED reason", async () => {
  const f = validationFixture();
  try {
    const run = async (sample: PerfRunner["sample"], over: Partial<RunPairedBenchmarkInput> = {}, plan = mplan(), d: Partial<PerfRunDeps> = {}) => runPairedBenchmark(deps(f, new PerfRunner(sample), { measurementPlan: (h) => (h === MP ? plan : null), ...d }), "u", input(f, over));
    // candidate (P1) is ~1 ms slower than the baseline (P0); the allowed delta is 5 ms
    const slightly = (side: string, c: string, rep: number) => ({ latency: 100 + (rep % 3) + (side === "CANDIDATE" ? 1 : 0) });
    const within = await run(slightly); assert.equal(within.state, "UNVALIDATED", "the experiment itself never claims a verdict"); assert.equal(within.profile, "pf-perf-core-v1");
    const a1 = evaluateExperiment(within, evalOpts()); assert.equal(a1.state, "WITHIN_BUDGET"); assert.equal(a1.verdicts![0]!.comparison, "P1-vs-P0"); assert.ok(a1.verdicts![0]!.deltaP50 <= 5);
    const slow = await run((side, c, rep) => ({ latency: 100 + (rep % 3) + (side === "CANDIDATE" ? 20 : 0) })); const a2 = evaluateExperiment(slow, evalOpts());
    assert.equal(a2.state, "REGRESSION"); assert.match(a2.verdicts![0]!.reasons[0]!, /lies entirely above the budget limit 5.*AT-17/);
    const noisy = await run((side, c, rep) => ({ latency: 100 + (side === "CANDIDATE" ? (rep % 2 ? 40 : -30) : 0) })); const a3 = evaluateExperiment(noisy, evalOpts(budget({ allowedDelta: 2 })));
    assert.equal(a3.state, "INCONCLUSIVE"); assert.match(a3.verdicts![0]!.reasons[0]!, /crosses the budget limit.*AT-20/);
    const reasons = (e: PairedExperiment, o = evalOpts()) => evaluateExperiment(e, o).verdicts!.flatMap((v) => v.reasons).join(" | ");
    assert.match(reasons(within, evalOpts(null)), /the budget is not on record; a missing budget can never pass/);
    assert.match(reasons(within, evalOpts(budget({ authorityBindingId: undefined }))), /no authority binding on record \(S11\)/); assert.match(reasons(within, evalOpts(budget(), { bindings: [] })), /no authority binding on record/);
    assert.match(reasons({ ...within, environmentRepresentative: false }), /no representative environment .*AT-19/);
    assert.match(reasons(within, evalOpts(budget({ measurementPlanHash: "other" }))), /measurement plan changed after the experiment.*AT-21/); assert.match(reasons(within, evalOpts(budget({ workloadDomainHash: "other" }))), /different workload domain.*AT-21/);
    assert.match(reasons(within, evalOpts(budget({ allowedDelta: undefined }))), /sets no absolute limit or allowed delta/);
    const few = await run(slightly, {}, mplan({ repetitions: 4 })); assert.match(reasons(few), /only 4 paired repetitions.*requires at least 10/);
    const dropped = await run((side, c, rep) => (side === "BASELINE" && rep < 2 ? { outcome: "ERROR" } : { latency: 100 })); assert.match(reasons(dropped), /drops errors is rejected \(AT-18\)/);
    const noP1 = await run(slightly, {}, mplan({ cases: ["P0"] })); assert.match(reasons(noP1), /P0 baseline or P1 candidate measurements are missing/);
    assert.equal(evaluateExperiment({ ...within, cases: [] }, evalOpts()).state, "NOT_APPLICABLE");
    assert.equal(evaluateExperiment(within, { ...evalOpts(), budgetIds: [] }).state, "WITHIN_BUDGET", "an empty list falls back to the experiment's own budgets");
    assert.equal(evaluateExperiment({ ...within, budgetIds: [] }, { ...evalOpts(), budgetIds: [] }).state, "UNVALIDATED"); assert.match(evaluateExperiment({ ...within, budgetIds: [] }, { ...evalOpts(), budgetIds: [] }).reasons.join(" "), /no budgets were evaluated/);
    // P2/P3 interference: the ordinary path regresses while the feature runs under load
    const inter = await run((side, c, rep) => ({ latency: 100 + (rep % 3) + (c === "P2" && side === "CANDIDATE" ? 30 : 0) }), {}, mplan({ cases: ["P0", "P1", "P2"] })); const a4 = evaluateExperiment(inter, evalOpts());
    assert.equal(a4.state, "REGRESSION"); assert.deepEqual(a4.verdicts!.map((v) => [v.comparison, v.state]), [["P1-vs-P0", "WITHIN_BUDGET"], ["P2-vs-P0", "REGRESSION"]]); assert.match(a4.verdicts![1]!.reasons.join(" "), /ordinary-path interference.*the feature path may be fine/);
    const withIncomplete = { ...within, incompleteReasons: ["P3: the workload declares no such case"] }; const a5 = evaluateExperiment(withIncomplete, evalOpts());
    assert.equal(a5.state, "UNVALIDATED", "an incomplete case floors the claim"); assert.deepEqual(a5.reasons, ["P3: the workload declares no such case"]);
    assert.equal(compareRuns(within.measurements!.P0!.baseline!, within.measurements!.P1!.candidate!, "nope", DEFAULT_ANALYSIS_POLICY).hasOwnProperty("error"), true);
  } finally { f.close(); }
});

test("PF-028/029 the benchmark records one manifest per run, the full outcome population, the declared cases and why each was promoted", async () => {
  const f = validationFixture();
  try {
    const runner = new PerfRunner((side, c, rep) => (side === "CANDIDATE" && rep === 0 ? { outcome: "ERROR" } : side === "CANDIDATE" && rep === 1 ? "no PF_PERF line at all" : { latency: 100 + rep }));
    const exp = await runPairedBenchmark(deps(f, runner, { measurementPlan: () => mplan({ cases: ["P0", "P1", "P2", "P3"], baselineCases: ["P0"] }) }), "u", input(f, { promotedBy: ["resource-sharing-concurrency"] }));
    assert.equal(runner.calls.length, 10 + 10 * 4, "baseline only for P0; candidate for every one of the four cases"); assert.deepEqual(exp.cases, ["P0", "P1", "P2", "P3"]); assert.deepEqual(exp.promotedBy, ["resource-sharing-concurrency"]);
    assert.deepEqual(exp.measurements!.P1!.candidate!.population, { SUCCESS: 8, ERROR: 2, TIMEOUT: 0, CANCELLED: 0 }, "an error and a line-less run are both ERROR, never dropped");
    assert.equal(exp.measurements!.P1!.baseline, undefined); assert.ok(exp.measurements!.P0!.baseline);
    assert.deepEqual(exp.caseStates, { P0: "COMPLETE", P1: "COMPLETE", P2: "COMPLETE", P3: "COMPLETE" }); assert.equal(exp.contended, false);
    const r1 = runner.calls.find((r) => r.env!.PF_CASE === "P2")!; assert.equal(r1.env!.LOAD, "2x", "per-case environment is passed"); assert.ok(runner.calls.find((r) => r.env!.PF_CASE === "P3")!.argv.includes("--large"));
    assert.ok(r1.capabilities.network === "DENY" && r1.capabilities.commands[0]![0] === "node", "workloads run with the network denied");
    assert.notEqual(new Set(runner.calls.filter((r) => r.env!.PF_CASE === "P1").map((r) => r.env!.PF_SEED)).size, 1, "each repetition has its own seed");
    assert.equal(runner.calls.filter((r) => r.env!.PF_CASE === "P1").map((r) => r.env!.PF_SEED).join(), runner.calls.filter((r) => r.env!.PF_CASE === "P1").map((r) => r.env!.PF_SEED).join(), "seeds are deterministic");
    const ev = f.fs.listEvidence(f.candidate.id).find((e) => e.performance?.id === exp.id)!;
    assert.equal(ev.kind, "PERFORMANCE"); assert.equal(ev.bindingHash, f.candidate.bindingHash); assert.equal(ev.results.length, 4); assert.ok(ev.results.every((r) => r.status === "PASS"));
    assert.equal(exp.candidateManifestIds.length, 40, "one manifest per candidate run (P0..P3 = 40 runs)"); assert.equal(exp.baselineManifestIds.length, 10);
    assert.match(exp.populationHash, /^pf-canon-v1\/pf\.PerfPopulation@1:/); assert.equal(exp.analysisPolicyHash, defaultAnalysisPolicyHash());
  } finally { f.close(); }
});

test("AT-18/P5/budget: infrastructure failures, undeclared cases and an exhausted budget make a case INCOMPLETE with the reason; contention is labelled; nothing running is an error", async () => {
  const f = validationFixture();
  try {
    const run = (runner: Runner, over: Partial<RunPairedBenchmarkInput> = {}, d: Partial<PerfRunDeps> = {}, plan = mplan({ cases: ["P0", "P1", "P2"] })) => runPairedBenchmark(deps(f, runner, { measurementPlan: () => plan, ...d }), "u", input(f, over));
    const undeclared = await run(new PerfRunner(), {}, { workload: () => ({ ...workload, cases: { P0: {}, P1: {} } }) }); assert.equal(undeclared.caseStates!.P2, "INCOMPLETE"); assert.match(undeclared.incompleteReasons![0]!, /P2: the workload declares no such case; the case cannot support a claim/);
    const infra = await run(new PerfRunner((side, c) => (c === "P1" && side === "CANDIDATE" ? ({ status: "INFRA_ERROR", exitCode: null, stdout: "", stderr: "", truncated: false, isolation: "CONTAINER", omissions: [], usage: { wallMs: 1 }, reason: "container died" } as RunResult) : {})));
    assert.equal(infra.caseStates!.P1, "INCOMPLETE"); assert.match(infra.incompleteReasons!.join(" "), /P1 CANDIDATE: infrastructure failure \(INFRA_ERROR: container died\)/);
    let t = 0; const tick = () => (t += 600); const budgeted = await run(new PerfRunner(), { budget: { wallMs: 2_000 } }, { now: tick });
    assert.ok(Object.values(budgeted.caseStates!).includes("INCOMPLETE")); assert.match(budgeted.incompleteReasons!.join(" "), /budget exhausted.*cost limits constrain execution, not truth/);
    const lease = memoryLease(); assert.ok(lease.tryAcquire()); const contended = await run(new PerfRunner(), {}, { lease }); assert.equal(contended.contended, true, "a run that could not take the lease says so"); lease.release();
    const solo = await run(new PerfRunner(), {}, { lease }); assert.equal(solo.contended, false); assert.ok(lease.tryAcquire(), "the lease is released after a run");
    await assert.rejects(run(new PerfRunner(() => ({ status: "REFUSED", exitCode: null, stdout: "", stderr: "", truncated: false, isolation: "CONTAINER", omissions: [], usage: { wallMs: 1 }, reason: "no" } as RunResult)), {}, {}, mplan({ cases: ["P0"] })), (e: any) => e.code === "RESOURCE_LIMIT");
    const timeouts = await run(new PerfRunner(() => ({ status: "TIMEOUT", exitCode: null, stdout: "", stderr: "", truncated: false, isolation: "CONTAINER", omissions: [], usage: { wallMs: 1 } } as RunResult)), {}, {}, mplan({ cases: ["P0", "P1"] }));
    assert.deepEqual(timeouts.measurements!.P0!.baseline!.population, { SUCCESS: 0, ERROR: 0, TIMEOUT: 10, CANCELLED: 0 }, "timeouts are kept in the population");
  } finally { f.close(); }
});

test("PF-030 P4: a baseline cached under the full identity is reused and its manifests describe the BASELINE only", async () => {
  const f = validationFixture();
  try {
    const cache = memoryBaselineCache(); const r1 = new PerfRunner(); const first = await runPairedBenchmark(deps(f, r1, { baselineCache: cache }), "u", input(f));
    assert.equal(r1.calls.length, 30, "P0 on both sides plus P1 on the candidate"); const r2 = new PerfRunner(); const second = await runPairedBenchmark(deps(f, r2, { baselineCache: cache }), "u", input(f));
    assert.equal(r2.calls.length, 20, "the P0 baseline was not measured again"); assert.deepEqual(second.measurements!.P0!.baseline!.population, first.measurements!.P0!.baseline!.population);
    assert.deepEqual(second.baselineManifestIds.slice().sort(), first.baselineManifestIds.slice().sort(), "a reused baseline names the manifests it reused (issue #84)"); assert.equal(second.candidateManifestIds.length, 20);
    const cached = [...cache.get(`${f.candidate.binding.baseCommitHash}|${WL}|${ENV}|tc`)!.manifestIds]; assert.equal(cached.length, 10, "only the baseline run manifests are cached");
    assert.deepEqual(cached.sort(), first.baselineManifestIds.slice().sort(), "the cached manifests are exactly the baseline manifests");
    const other = await runPairedBenchmark(deps(f, new PerfRunner(), { baselineCache: cache }), "u", input(f, { environmentHash: "env-2" })); assert.ok(other.measurements!.P0!.baseline, "a different environment is a different identity");
    const r3 = new PerfRunner(); await runPairedBenchmark(deps(f, r3, { baselineCache: cache, measurementPlan: () => mplan({ repetitions: 20 }) }), "u", input(f)); assert.equal(r3.calls.length, 20 + 20 + 20, "a cached run with fewer repetitions than now required is not reused");
  } finally { f.close(); }
});

test("benchmark input validation: ownership, snapshots, declared workload and plan, repetitions and budget", async () => {
  const f = validationFixture();
  try {
    const go = (over: Partial<RunPairedBenchmarkInput> = {}, d: Partial<PerfRunDeps> = {}, actor = "u") => runPairedBenchmark(deps(f, new PerfRunner(), d), actor, input(f, over));
    await assert.rejects(go({}, {}, "mallory"), (e: any) => e instanceof FeatureError && e.code === "FORBIDDEN");
    await assert.rejects(go({ patchBindingHash: "nope" }), (e: any) => e.code === "NOT_FOUND");
    await assert.rejects(go({ baselineSnapshot: { ...input(f).baselineSnapshot, commitHash: "other" } }), (e: any) => e.code === "STALE_REVISION" && /base commit/.test(e.message));
    await assert.rejects(go({ baselineSnapshot: { ...input(f).baselineSnapshot, contentRootHash: "other" } }), (e: any) => e.code === "STALE_REVISION" && /content root/.test(e.message));
    await assert.rejects(go({ workloadHash: "undeclared" }), (e: any) => e.code === "NOT_FOUND" && /workload undeclared is not declared/.test(e.message)); await assert.rejects(go({ measurementPlanHash: "undeclared" }), (e: any) => e.code === "NOT_FOUND");
    await assert.rejects(go({ budget: { wallMs: 0 } }), (e: any) => e.code === "INVALID_SCHEMA"); await assert.rejects(go({}, { measurementPlan: () => mplan({ repetitions: 0 }) }), (e: any) => e.code === "INVALID_SCHEMA");
    await assert.rejects(go({}, { measurementPlan: () => mplan({ repetitions: 99_999 }) }), (e: any) => e.code === "INVALID_SCHEMA");
  } finally { f.close(); }
});

test("evaluatePerformance records the assessment as an event, refuses a stale analysis method and an unknown experiment", async () => {
  const f = validationFixture();
  try {
    const exp = await runPairedBenchmark(deps(f, new PerfRunner((side, c, rep) => ({ latency: 100 + (rep % 3) }))), "u", input(f));
    const ev = (over = {}) => evaluatePerformance({ fs: f.fs, budgets: (id) => (id === "b1" ? budget() : null), authority: auth }, "u", { pairedExperimentId: exp.id, budgetIds: ["b1"], analysisPolicyHash: defaultAnalysisPolicyHash(), ...over });
    const ok = ev(); assert.equal(ok.value!.state, "WITHIN_BUDGET"); assert.equal(ok.value!.evidenceIds![0], `ev:${exp.id}`);
    const event = f.fs.listEvents(f.request.requestId).at(-1)!; assert.equal(event.type, "PerformanceAssessed"); assert.equal(event.result, "OK"); assert.match(event.rationale, /pf-perf-core-v1 WITHIN_BUDGET over 1 verdict/);
    const stale = ev({ analysisPolicyHash: "pf-canon-v1/other" }); assert.equal(stale.value!.state, "UNVALIDATED"); assert.match(stale.diagnostics[0]!, /analysis method hash differs.*AT-21/);
    assert.throws(() => ev({ pairedExperimentId: "pexp:none" }), (e: any) => e.code === "NOT_FOUND"); assert.throws(() => ev({ pairedExperimentId: "" }), (e: any) => e.code === "INVALID_SCHEMA");
    const regress = evaluatePerformance({ fs: f.fs, budgets: () => budget({ allowedDelta: -50 }), authority: auth }, "u", { pairedExperimentId: exp.id, budgetIds: ["b1"], analysisPolicyHash: defaultAnalysisPolicyHash() });
    assert.equal(regress.value!.state, "REGRESSION"); assert.equal(f.fs.listEvents(f.request.requestId).at(-1)!.result, "FAILED");
  } finally { f.close(); }
});

test("2.M inside 2.J: the PERFORMANCE check reads the stored experiment — no experiment, UNVALIDATED and REGRESSION are never a pass; only WITHIN_BUDGET is", async () => {
  const f = validationFixture(); const repo = f.root; mkdirSync(join(repo, ".cie"), { recursive: true });
  writeFileSync(join(repo, ".cie", "authority.json"), JSON.stringify(auth));
  const reg = (b = budget()) => writeFileSync(join(repo, ".cie", "perf.json"), JSON.stringify({ workloads: { [WL]: workload }, measurementPlans: { [MP]: mplan() }, budgets: { b1: b } }));
  try {
    const check = { id: "performance", kind: "PERFORMANCE" as const, phase: "PERFORMANCE" as const, target: ".", acceptanceIds: [], mandatory: true, expectedTests: [], report: "EXIT" as const, applicability: "APPLICABLE" as const, baseline: false }; const drive = () => perfRunCheck(f.fs, f.candidate, { ...f.request, repositoryId: repo })(check, repo);
    assert.equal(await perfRunCheck(f.fs, f.candidate, f.request)({ ...check, kind: "UNIT" }, repo), undefined, "other kinds are not owned");
    assert.match((await drive())!.reason!, /no paired benchmark has been run for this candidate/);
    await runPairedBenchmark(deps(f, new PerfRunner((side, c, rep) => ({ latency: 100 + (rep % 3) + (side === "CANDIDATE" ? 20 : 0) }))), "u", input(f));
    reg(); const slow = (await drive())!; assert.deepEqual([slow.status, slow.exitCode], ["FAILED", 1]); assert.match(slow.reason!, /entirely above the budget limit/);
    f.fs.putCandidate({ ...f.candidate, status: "MATERIALIZED" });
    await runPairedBenchmark(deps(f, new PerfRunner((side, c, rep) => ({ latency: 100 + (rep % 3) }))), "u", input(f));
    const ok = (await drive())!; assert.deepEqual([ok.status, ok.exitCode], ["PASSED", 0]); assert.equal(JSON.parse(ok.stdout).assessment.state, "WITHIN_BUDGET");
    reg(budget({ authorityBindingId: undefined })); const noAuth = (await drive())!; assert.equal(noAuth.status, "INFRA_ERROR"); assert.match(noAuth.reason!, /PERFORMANCE UNVALIDATED: .*no authority binding/);
    writeFileSync(join(repo, ".cie", "perf.json"), "{ nope"); assert.match((await drive())!.reason!, /\.cie\/perf\.json is invalid/);
  } finally { f.close(); }
});

test(".cie/perf.json registry is strict: unknown keys, malformed workloads and plans are rejected, absence is empty", () => {
  const repo = mkdtempSync(join(tmpdir(), "pf-perf-")); assert.deepEqual(loadPerfRegistry(repo), { workloads: {}, measurementPlans: {}, budgets: {} });
  const w = (o: unknown) => { mkdirSync(join(repo, ".cie"), { recursive: true }); writeFileSync(join(repo, ".cie", "perf.json"), typeof o === "string" ? o : JSON.stringify(o)); };
  w({ workloads: { a: workload }, measurementPlans: { p: mplan() }, budgets: { b1: budget() } }); const r = loadPerfRegistry(repo); assert.deepEqual(Object.keys(r.workloads), ["a"]); assert.equal(r.budgets.b1!.metric, "latencyMs");
  for (const bad of ["{", [], { extra: 1 }, { workloads: { a: { entry: "" , files: {}, cases: {} } } }, { workloads: { a: { entry: "x" } } }, { measurementPlans: { p: { repetitions: "10" } } }]) { w(bad); assert.throws(() => loadPerfRegistry(repo), ConfigError, JSON.stringify(bad)); }
});

// ---- the operations over the gateway handlers
import { boot, createEdit } from "./feature-boot.ts";

const writeCie = (repo: string, files: Record<string, unknown>) => { mkdirSync(join(repo, ".cie"), { recursive: true }); for (const [n, v] of Object.entries(files)) writeFileSync(join(repo, ".cie", n), JSON.stringify(v)); };
const perfRepo = (over: { budget?: Partial<PerformanceBudget>; workload?: PerfWorkload } = {}) => (repo: string) => writeCie(repo, { "authority.json": auth, "perf.json": { workloads: { [WL]: over.workload ?? workload }, measurementPlans: { [MP]: mplan({ cases: ["P0", "P1"] }) }, budgets: { b1: budget(over.budget) } } });
const bench = (b: Awaited<ReturnType<typeof boot>>, who = "arun", idem = "b1", over: Record<string, unknown> = {}) => b.h["C27/runPairedBenchmark"]!(b.as(who, idem), { patchBindingHash: b.cand.bindingHash, baselineSnapshot: { repositoryId: b.repo, commitHash: b.cand.binding.baseCommitHash, contentRootHash: b.cand.binding.baseContentHash, indexGeneration: 1, toolchainHash: "tc" }, workloadHash: WL, environmentHash: ENV, measurementPlanHash: MP, budget: { wallMs: 60_000 }, budgetIds: ["b1"], promotedBy: ["resource-sharing-concurrency"], ...over });

test("C26/assessPerformanceRisk, C27/runPairedBenchmark and C26/evaluatePerformance: owner-only, declared inputs only, a benchmark job whose experiment is evaluated with S11", async () => {
  const runner = new PerfRunner((side, c, rep) => ({ latency: 100 + (rep % 3) }));
  const b = await boot({ prepare: perfRepo(), edits: () => [createEdit("src/export/handler.ts", "export const route = (req: unknown) => req;\n")], handlers: { perf: { runner: () => runner, environment: () => ({ representative: true }) } } });
  try {
    const risk = await b.h["C26/assessPerformanceRisk"]!(b.as("arun"), { contractHash: b.fs.getRequest(b.rid)!.contract!.hash, patchBindingHash: b.cand.bindingHash, runtimeEvidenceIds: [] });
    assert.ok(risk.ok, JSON.stringify(risk)); assert.equal(risk.value.value.applicable, true);
    const started = await bench(b); assert.ok(started.ok, JSON.stringify(started)); const job = await b.svc.jobs.settled(started.value.jobId);
    assert.equal(job.state, "SUCCEEDED", job.message); const exp = (job.result!.value as any).value ?? job.result!.value;
    assert.equal(exp.profile, "pf-perf-core-v1"); assert.deepEqual(exp.promotedBy, ["resource-sharing-concurrency"]); assert.equal(exp.environmentRepresentative, true); assert.equal(runner.calls.length, 30);
    const ev = await b.h["C26/evaluatePerformance"]!(b.as("arun"), { pairedExperimentId: exp.id, budgetIds: ["b1"], analysisPolicyHash: defaultAnalysisPolicyHash() });
    assert.ok(ev.ok, JSON.stringify(ev)); assert.equal(ev.value.value.state, "WITHIN_BUDGET"); assert.ok(b.fs.listEvents(b.rid).some((e) => e.type === "PerformanceAssessed"));
    for (const [key, body] of [["C26/assessPerformanceRisk", { contractHash: "c", patchBindingHash: b.cand.bindingHash }], ["C27/runPairedBenchmark", { patchBindingHash: b.cand.bindingHash, workloadHash: WL, measurementPlanHash: MP, budget: { wallMs: 5000 } }], ["C26/evaluatePerformance", { pairedExperimentId: exp.id, budgetIds: [], analysisPolicyHash: "x" }]] as const) {
      const r = await b.h[key]!(b.as("mallory", `m-${key}`), body); assert.ok(!r.ok && r.error.code === "NOT_FOUND", key);
    }
    const bad = async (over: Record<string, unknown>, code: string, re?: RegExp) => { const r = await bench(b, "arun", `x-${Math.random()}`, over); assert.ok(!r.ok && r.error.code === code && (!re || re.test(r.error.message)), JSON.stringify(over) + JSON.stringify(r)); };
    await bad({ workloadHash: "undeclared" }, "NOT_FOUND", /not declared in \.cie\/perf\.json/); await bad({ measurementPlanHash: "undeclared" }, "NOT_FOUND"); await bad({ budget: { wallMs: 0 } }, "INVALID_SCHEMA"); await bad({ patchBindingHash: "pf-canon-v1/none" }, "NOT_FOUND");
    const stale = await bench(b, "arun", "stale", { baselineSnapshot: { repositoryId: b.repo, commitHash: "other", contentRootHash: "x", indexGeneration: 1, toolchainHash: "tc" } }); const sj = await b.svc.jobs.settled(stale.value.jobId);
    assert.equal(sj.state, "FAILED"); assert.equal(sj.error!.code, "STALE_REVISION", "a stale baseline fails the job with a typed error");
    const unknown = await b.h["C26/evaluatePerformance"]!(b.as("arun"), { pairedExperimentId: "pexp:none", budgetIds: [], analysisPolicyHash: "x" }); assert.ok(!unknown.ok && unknown.error.code === "NOT_FOUND");
  } finally { b.close(); }
});

test("AT-19/AT-24 a host that does not declare a representative environment gets UNVALIDATED; a second benchmark of the same request fences out the first", async () => {
  const inner = new PerfRunner((side, c, rep) => ({ latency: 100 + (rep % 3) })); const slow: Runner = { isolation: inner.isolation, omissions: inner.omissions, run: async (r: RunRequest) => { await new Promise((x) => setTimeout(x, 15)); return inner.run(r); } };
  const b = await boot({ prepare: perfRepo(), edits: () => [createEdit("src/export/handler.ts", "export const route = 1;\n")], handlers: { perf: { runner: () => slow } } });
  try {
    const a = await bench(b, "arun", "o1"); await new Promise((x) => setTimeout(x, 40)); const c = await bench(b, "arun", "o2", { promotedBy: [] });
    const [ja, jc] = await Promise.all([b.svc.jobs.settled(a.value.jobId), b.svc.jobs.settled(c.value.jobId)]);
    assert.equal(ja.state, "CANCELLED"); assert.match(ja.message, /Replaced by a newer run of the same work/); assert.equal(jc.state, "SUCCEEDED", jc.message);
    assert.equal(b.fs.listCandidates(b.rid).flatMap((cd) => b.fs.listEvidence(cd.id)).filter((e) => e.performance).length, 1, "the fenced-out run saved nothing");
    const exp = (jc.result!.value as any).value ?? jc.result!.value; assert.equal(exp.environmentRepresentative, false);
    const ev = await b.h["C26/evaluatePerformance"]!(b.as("arun"), { pairedExperimentId: exp.id, budgetIds: ["b1"], analysisPolicyHash: defaultAnalysisPolicyHash() });
    assert.equal(ev.value.value.state, "UNVALIDATED"); assert.match(ev.value.value.verdicts[0].reasons[0], /no representative environment .*AT-19/);
  } finally { b.close(); }
});

test("PF-029 a real run through the local runner: node executes the declared workload files and the S11 evaluation reads what they printed", { timeout: 120_000 }, async () => {
  const real: PerfWorkload = { entry: "bench.js", files: { "bench.js": "const t = Date.now(); let s = 0; for (let i = 0; i < 2000; i++) s += i; console.log('PF_PERF ' + JSON.stringify({ outcome: 'SUCCESS', metrics: { latencyMs: 1 + (Date.now() - t) } }));" }, cases: { P0: {}, P1: {} } };
  const b = await boot({ prepare: perfRepo({ workload: real, budget: { allowedDelta: 500 } }), edits: () => [createEdit("src/export/handler.ts", "export const route = 1;\n")], handlers: { perf: { environment: () => ({ representative: true }) } } });
  try {
    const started = await bench(b, "arun", "real", { budgetIds: ["b1"] }); const job = await b.svc.jobs.settled(started.value.jobId);
    assert.equal(job.state, "SUCCEEDED", job.message); const exp = (job.result!.value as any).value ?? job.result!.value;
    assert.deepEqual(exp.measurements.P1.candidate.population, { SUCCESS: 10, ERROR: 0, TIMEOUT: 0, CANCELLED: 0 }); assert.equal(exp.measurements.P0.baseline.metrics.latencyMs.samples.length, 10);
    const ev = await b.h["C26/evaluatePerformance"]!(b.as("arun"), { pairedExperimentId: exp.id, budgetIds: ["b1"], analysisPolicyHash: defaultAnalysisPolicyHash() }); assert.equal(ev.value.value.state, "WITHIN_BUDGET");
  } finally { b.close(); }
});

test("an invalid .cie/perf.json is a typed error, not a crash", async () => {
  const b = await boot({ prepare: (repo) => { mkdirSync(join(repo, ".cie"), { recursive: true }); writeFileSync(join(repo, ".cie", "perf.json"), "{ nope"); }, edits: () => [createEdit("src/export/handler.ts", "export const route = 1;\n")] });
  try { const r = await bench(b); assert.ok(!r.ok && r.error.code === "INVALID_SCHEMA" && /perf\.json is invalid/.test(r.error.message)); } finally { b.close(); }
});
