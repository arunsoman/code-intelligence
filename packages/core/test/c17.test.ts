import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { StubProvider } from "@cie/model";
import { DegradedProvider, Evaluator, MIN_BIN, MIN_EXPERTS, MIN_PARTICIPANTS, PLANTED_SECURITY, SEEDED_CONCEPTS, mcnemar, metricsOf } from "../src/evaluation.ts";
import { Store } from "../src/store.ts";
import { demoRepo, setup } from "./helpers.ts";

const SEC = resolve(import.meta.dirname, "../../../fixtures/security-repo");
const ev = () => new Evaluator(new Store(":memory:"), "test");

test("planted failures: every planted leak and authorisation gap is found and every safe look-alike is left alone, with intervals; a blind spot in the detector shows up as a miss", async () => {
  const { svc, worker } = await setup(undefined, SEC);
  const e = new Evaluator(svc.store, "test");
  const run = await e.runSuite(svc, PLANTED_SECURITY, svc.activeModel);
  assert.equal(run.items.length, 11);
  assert.deepEqual([run.metrics.tp, run.metrics.fp, run.metrics.fn, run.metrics.tn], [4, 0, 0, 7]);
  assert.equal(run.metrics.recall.value, 1); assert.equal(run.metrics.precision.value, 1);
  // Eleven items cannot support certainty: the interval says how much is left open.
  assert.ok(run.metrics.recall.lower < 0.6 && run.metrics.recall.upper === 1, `recall interval ${run.metrics.recall.lower}..${run.metrics.recall.upper}`);
  assert.ok(run.metrics.accuracy.lower > 0.65 && run.metrics.accuracy.lower < 0.85);
  assert.equal(e.runs("planted-security").length, 1, "the run is in the registry");
  worker.close();
  // The same leak, written so the detector cannot see it (the logger comes from an opaque factory, not a name it can resolve): a planted failure that is missed is reported as missed.
  const dir = mkdtempSync(join(tmpdir(), "cie-evade-"));
  cpSync(SEC, dir, { recursive: true });
  const f = join(dir, "src/api/handlers.ts");
  writeFileSync(f, readFileSync(f, "utf8").replace('console.log("new user", req.body.email, req.body.password);', 'const out = getLogger(); out.log("new user", req.body.email, req.body.password);'));
  const t2 = await setup(undefined, dir);
  const run2 = await new Evaluator(t2.svc.store, "test").runSuite(t2.svc, PLANTED_SECURITY, { name: "rules", model: "v1" });
  assert.equal(run2.metrics.fn, 1, "the aliased logger evades the rule");
  assert.ok(run2.items.find((i) => i.id === "R-PII-LOG:registerUser")!.expected && !run2.items.find((i) => i.id === "R-PII-LOG:registerUser")!.predicted);
  assert.ok(run2.metrics.recall.value! < 1 && run2.metrics.precision.value === 1);
  t2.worker.close();
});

test("confidence-bin intervals: stated confidence is checked against outcomes bin by bin with a Wilson interval; overconfidence is named, small bins abstain, and the held-out half is separate", () => {
  const e = ev();
  // 60 claims stated at ~0.9 that were right 90% of the time; 40 stated at ~0.7 that were right 40% of the time; 6 stated at 0.1.
  let i = 0;
  const add = (n: number, conf: number, rate: number) => { for (let k = 0; k < n; k++) e.addLabel({ subject: `s${i++}`, claimClass: "structural-path", predictedConfidence: conf + (k % 5) * 0.01, outcome: k < Math.round(n * rate), labeler: `person-${k % 3}`, synthetic: true }); };
  add(60, 0.9, 0.9); add(40, 0.7, 0.4); add(6, 0.1, 0.5);
  const c = e.calibration({ bins: 5 });
  assert.equal(c.labels, 106);
  const bin = (lo: number) => c.bins.find((b) => b.range[0] === lo)!;
  const good = bin(0.8), bad = bin(0.6), tiny = bin(0);
  assert.equal(good.n, 60); assert.ok(good.lower < 0.9 && good.upper > 0.9, "the interval contains the true rate");
  assert.equal(good.verdict, "CONSISTENT");
  assert.equal(bad.n, 40); assert.ok(bad.upper < 0.7, `stated ~0.7 but observed ${bad.observed}, upper bound ${bad.upper}`);
  assert.equal(bad.verdict, "OVERCONFIDENT");
  assert.equal(tiny.n, 6); assert.equal(tiny.verdict, "TOO_FEW"); assert.ok(tiny.upper - tiny.lower > 0.4, "a six-item bin has a wide interval");
  assert.ok(c.ece !== null && c.ece > 0.05 && c.ece < 0.4);
  // Interval width shrinks with n; a bin of ten is the least we call a bin.
  assert.equal(MIN_BIN, 10);
  const w = (k: number, n: number) => { const m = metricsOf(Array.from({ length: n }, (_, j) => ({ id: String(j), expected: true, predicted: j < k }))); return m.recall.upper - m.recall.lower; };
  assert.ok(w(9, 10) > w(90, 100) && w(90, 100) > w(900, 1000));
  // Held-out labels are a fixed 30% by rule, and calibrating on one half does not see the other.
  const all = e.labels(), held = e.labels({ heldOut: true }), train = e.labels({ heldOut: false });
  assert.equal(held.length + train.length, all.length);
  assert.ok(held.length > 15 && held.length < 50, `${held.length} held out of ${all.length}`);
  assert.ok(held.every((l) => l.heldOut) && train.every((l) => !l.heldOut));
  assert.deepEqual(e.labels({ heldOut: true }).map((l) => l.subject), held.map((l) => l.subject), "the same items are held out every time");
  assert.notDeepEqual(e.calibration({ heldOut: true }).bins.map((b) => b.n), e.calibration({ heldOut: false }).bins.map((b) => b.n));
  // With almost no labels, no calibration is claimed at all.
  const none = ev(); none.addLabel({ subject: "x", claimClass: "c", predictedConfidence: 0.9, outcome: true, labeler: "a" });
  assert.match(none.calibration().note, /no bin has 10 labels yet, so no calibration is claimed/);
  assert.equal(none.calibration().ece, null);
});

test("changed-model regression: a model that finds fewer seeded concepts is caught with a paired test; an unmeasured model is not trusted; a small difference is not called a regression", async () => {
  const a = await setup(new StubProvider(), demoRepo());
  const b = await setup(new DegradedProvider(), demoRepo());
  const e = new Evaluator(a.svc.store, "test");
  const runA = await e.runSuite(a.svc, SEEDED_CONCEPTS, a.svc.activeModel);
  const runB = await e.runSuite(b.svc, SEEDED_CONCEPTS, b.svc.activeModel);
  assert.equal(runA.items.length, 18);
  assert.equal(runA.metrics.recall.value, 1, `baseline finds every seeded concept: ${JSON.stringify(runA.items.filter((i) => i.expected && !i.predicted))}`);
  assert.equal(runA.metrics.fp, 0, "and invents none of the absent ones");
  assert.ok(runB.metrics.recall.value! < 0.6, `the degraded model's recall ${runB.metrics.recall.value}`);
  const cmp = e.compare(runA, runB);
  assert.ok(cmp.comparable && cmp.regression, JSON.stringify(cmp));
  assert.ok(cmp.comparable && cmp.worseOnly >= 6 && cmp.betterOnly === 0 && cmp.pValue < 0.05);
  assert.ok(cmp.comparable && cmp.changed.some((c) => /failure:/.test(c)));
  // The same model twice: no regression, p = 1.
  const again = await e.runSuite(a.svc, SEEDED_CONCEPTS, a.svc.activeModel);
  const same = e.compare(runA, again);
  assert.ok(same.comparable && !same.regression && same.pValue === 1);
  // A difference of one item is not enough to say anything.
  const oneOff = { ...runA, items: runA.items.map((i, k) => (k === 0 ? { ...i, predicted: !i.predicted } : i)) };
  const small = e.compare(runA, { ...oneOff, metrics: metricsOf(oneOff.items) });
  assert.ok(small.comparable && !small.regression && small.possibleRegression && /too small to tell/.test(small.note));
  assert.ok(Math.abs(mcnemar(1, 0) - 1) < 1e-9 && mcnemar(9, 0) < 0.01 && mcnemar(0, 0) === 1);
  // Different suites are not comparable.
  assert.equal(e.compare(runA, { ...runB, suite: "other" }).comparable, false);
  // Model status: the model in use has to have been measured, and results about another model do not transfer.
  assert.equal(e.modelStatus({ name: "stub", model: "deterministic-graph-v1" }, "seeded-concepts").status, "EVALUATED");
  const unmeasured = e.modelStatus({ name: "ollama", model: "new:cloud" }, "seeded-concepts");
  assert.equal(unmeasured.status, "UNMEASURED_MODEL"); assert.match(unmeasured.note, /has not been run against seeded-concepts; earlier results describe/);
  assert.equal(new Evaluator(new Store(":memory:")).modelStatus({ name: "x", model: "y" }, "seeded-concepts").status, "NEVER_EVALUATED");
  // The release gate uses the lower end of the interval, so a clean small sample does not pass a high bar.
  assert.equal(e.releaseGate({ name: "stub", model: "deterministic-graph-v1" }, "seeded-concepts", { minRecall: 0.5, minPrecision: 0.5 }).pass, true);
  const strict = e.releaseGate({ name: "stub", model: "deterministic-graph-v1" }, "seeded-concepts", { minRecall: 0.95, minPrecision: 0.95 });
  assert.equal(strict.pass, false); assert.match(strict.reason, /lower bounds/);
  assert.equal(e.releaseGate({ name: "degraded", model: "drops-cards" }, "seeded-concepts", { minRecall: 0.5, minPrecision: 0.5 }).pass, false, "the degraded model fails even a low bar");
  assert.equal(e.releaseGate({ name: "ollama", model: "new:cloud" }, "seeded-concepts", { minRecall: 0, minPrecision: 0 }).pass, false, "an unmeasured model cannot pass any bar");
  a.worker.close(); b.worker.close();
});

test("held-out expert labels: labels made by a script are marked synthetic and never counted as expert labels; the held-out set is not called validated until enough different people have labelled", () => {
  const e = ev();
  for (let i = 0; i < 40; i++) e.addLabel({ subject: `c${i}`, claimClass: "k", predictedConfidence: 0.8, outcome: i % 5 !== 0, labeler: "script", synthetic: true });
  let cov = e.expertCoverage();
  assert.deepEqual([cov.realLabels, cov.syntheticLabels, cov.experts, cov.expertValidated], [0, 40, 0, false]);
  assert.match(cov.note, new RegExp(`0 of the ${MIN_EXPERTS} labelers`));
  for (let p = 0; p < MIN_EXPERTS - 1; p++) for (let i = 0; i < 12; i++) e.addLabel({ subject: `r${i}`, claimClass: "k", predictedConfidence: 0.8, outcome: i % 4 !== 0, labeler: `expert-${p}` });
  cov = e.expertCoverage();
  assert.equal(cov.experts, MIN_EXPERTS - 1); assert.equal(cov.expertValidated, false);
  assert.match(cov.note, /7 of the 8 labelers the protocol requires/);
  e.addLabel({ subject: "r0", claimClass: "k", predictedConfidence: 0.8, outcome: true, labeler: `expert-${MIN_EXPERTS - 1}` });
  assert.equal(e.expertCoverage().expertValidated, true, "the eighth different person makes the difference, not the count of labels");
  // The same person labelling a thousand times is still one labeler.
  const solo = ev(); for (let i = 0; i < 100; i++) solo.addLabel({ subject: `s${i}`, claimClass: "k", predictedConfidence: 0.5, outcome: true, labeler: "one-person" });
  assert.equal(solo.expertCoverage().experts, 1);
});

test("measurable task-completion study: completion and time are computed with an interval, and records that were generated or too few are not reported as a study", () => {
  const e = ev();
  const mk = (n: number, done: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, task: "find-the-bug", completed: i < done, seconds: 120 + i * 10 }));
  const synthetic = e.studyReport(e.recordStudy({ name: "pilot", protocol: "P-1", participants: mk(30, 24), synthetic: true }))!;
  assert.equal(synthetic.status, "SYNTHETIC_DATA"); assert.match(synthetic.note, /not a study/);
  const small = e.studyReport(e.recordStudy({ name: "pilot-real", protocol: "P-1", participants: mk(6, 5) }))!;
  assert.equal(small.status, "TOO_FEW_PARTICIPANTS"); assert.match(small.note, new RegExp(`needs ${MIN_PARTICIPANTS}`));
  const real = e.studyReport(e.recordStudy({ name: "study-1", protocol: "P-1", participants: mk(MIN_PARTICIPANTS + 5, 20) }))!;
  assert.equal(real.status, "VALID_STUDY");
  assert.equal(real.completion.value, 0.8);
  assert.ok(real.completion.lower < 0.8 && real.completion.upper > 0.8 && real.completion.upper - real.completion.lower > 0.2);
  assert.equal(real.medianSeconds, 120 + 10 * 10);
  assert.equal(e.studyReport("study:none"), null);
});
