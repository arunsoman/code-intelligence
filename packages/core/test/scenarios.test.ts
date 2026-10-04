// C27: counterfactual scenarios. Level-locked comparison, tracked assumptions, invalid scenarios refused, measured-versus-inferred capacity.
// (The sandbox escape and timeout half of C27 is proved with real processes in defect-adapters.test.ts.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareScenarios, evaluateScenario, ScenarioError, type CapacityData, type Scenario } from "../src/scenarios.ts";
import { demoRepo, setup } from "./helpers.ts";

const CHARGE = "function:src/payments/payment-service.ts#charge", FRAUD = "function:src/payments/fraud.ts#checkFraud", CREATE = "function:src/api/payments-controller.ts#createPayment";
const sc = (over: Partial<Scenario> & { ops: Scenario["ops"] }): Scenario => ({ id: "s1", name: "test", level: "SYMBOL", assumptions: [], ...over });
async function world() { const { svc, worker, revision } = await setup(undefined, demoRepo()); return { svc, worker, revision, rev: svc.store.revision(revision)! }; }

test("C27: invalid scenarios are refused with every reason, and nothing is evaluated", async () => {
  const { svc, worker, rev } = await world();
  const bad = (s: Scenario, re: RegExp) => assert.throws(() => evaluateScenario(svc.store, rev, s), (e: unknown) => e instanceof ScenarioError && re.test(e.message));
  bad(sc({ ops: [] }), /at least one operation/);
  bad(sc({ name: " ", ops: [{ type: "REMOVE", target: "checkFraud" }] }), /needs a name/);
  bad(sc({ level: "GALAXY" as any, ops: [{ type: "REMOVE", target: "checkFraud" }] }), /level must be/);
  bad(sc({ ops: [{ type: "REMOVE", target: "noSuchThing" }] }), /not code in this revision/);
  bad(sc({ ops: [{ type: "MAKE_ASYNC", callee: "function:src/nowhere.ts#x" }] }), /not an entity/);
  bad(sc({ ops: [{ type: "SCALE", path: CREATE, factor: -2 }] }), /positive number/);
  bad(sc({ ops: [{ type: "SCALE", path: CREATE, factor: 100000 }] }), /up to 1000/);
  bad(sc({ ops: [{ type: "SCALE", path: CREATE, factor: NaN }] }), /positive number/);
  bad(sc({ ops: [{ type: "REMOVE", target: "checkFraud" }, { type: "SCALE", path: FRAUD, factor: 2 }] }), /both removed and scaled/);
  bad(sc({ ops: [{ type: "REMOVE", target: "checkFraud" }, { type: "MAKE_ASYNC", callee: FRAUD }] }), /both removed and made asynchronous/);
  bad(sc({ ops: [{ type: "REWRITE" as any, target: "x" } as any] }), /unknown operation "REWRITE"/);
  bad(sc({ ops: [{ type: "REMOVE", target: "checkFraud" }], assumptions: [{ id: "a", statement: "x" }, { id: "a", statement: "y" }] }), /used twice/);
  bad(sc({ ops: Array.from({ length: 21 }, () => ({ type: "REMOVE" as const, target: "checkFraud" })) }), /limited to 20/);
  // Several problems are reported together, not one at a time.
  try { evaluateScenario(svc.store, rev, sc({ name: "", ops: [{ type: "REMOVE", target: "zzz" }, { type: "SCALE", path: "nope", factor: 0 }] })); assert.fail("accepted"); }
  catch (e) { assert.ok(e instanceof ScenarioError && e.problems.length >= 4, `${(e as ScenarioError).problems}`); }
  // An assumption cannot be called supported without evidence that exists.
  assert.throws(() => evaluateScenario(svc.store, rev, sc({ ops: [{ type: "MAKE_ASYNC", callee: CHARGE }] }), { assumptions: [{ id: "a:callers-ignore-result", state: "SUPPORTED", evidenceIds: [] }] }), /without evidence/);
  assert.throws(() => evaluateScenario(svc.store, rev, sc({ ops: [{ type: "MAKE_ASYNC", callee: CHARGE }] }), { assumptions: [{ id: "a:callers-ignore-result", state: "SUPPORTED", evidenceIds: ["ev:invented"] }] }), /without evidence/);
  worker.close();
});

test("C27: assumptions are tracked: consequences rest on named assumptions, stay conditional until each is supported with evidence, and a contradicted one says the consequence does not hold", async () => {
  const { svc, worker, rev } = await world();
  const s = sc({ ops: [{ type: "MAKE_ASYNC", callee: CHARGE }] });
  const r0 = evaluateScenario(svc.store, rev, s);
  const cons = r0.consequences.filter((c) => c.assumptionIds.length);
  assert.ok(cons.length >= 2 && cons.every((c) => c.conditional), "nothing is unconditional while its assumptions are unchecked");
  assert.ok(r0.assumptions.every((a) => a.state === "UNCHECKED") && r0.assumptions.length >= 2);
  const callerText = r0.consequences.find((c) => /createPayment would continue without waiting/.test(c.text));
  assert.ok(callerText && callerText.basis === "STRUCTURAL" && callerText.evidenceIds.length > 0 && callerText.assumptionIds.includes("a:callers-ignore-result"), "the consequence names the assumption it rests on and cites the call");
  // Support it with real evidence (the call's own span): that consequence stops being conditional; the other one still is.
  const ev = callerText!.evidenceIds[0];
  const r1 = evaluateScenario(svc.store, rev, s, { assumptions: [{ id: "a:callers-ignore-result", state: "SUPPORTED", evidenceIds: [ev] }] });
  assert.equal(r1.consequences.find((c) => c.id === callerText!.id)!.conditional, false);
  assert.equal(r1.consequences.find((c) => /running twice/.test(c.text))!.conditional, true, "the retry consequence still rests on an unchecked assumption");
  assert.equal(r1.assumptions.find((a) => a.id === "a:callers-ignore-result")!.state, "SUPPORTED");
  assert.notEqual(r0.scenarioHash, r1.scenarioHash, "an assumption's state is part of what was evaluated");
  const r2 = evaluateScenario(svc.store, rev, s, { assumptions: [{ id: "a:callers-ignore-result", state: "CONTRADICTED", evidenceIds: [ev] }] });
  assert.match(r2.consequences.find((c) => c.id === callerText!.id)!.text, /^Does not hold, because an assumption it rests on was contradicted/);
  // A caller's own assumptions are tracked the same way.
  const own = evaluateScenario(svc.store, rev, sc({ ops: [{ type: "MAKE_ASYNC", callee: CHARGE }], assumptions: [{ id: "mine", statement: "payments are retried by the gateway" }] }));
  assert.ok(own.assumptions.some((a) => a.id === "mine" && a.state === "UNCHECKED"));
  // Deterministic: the same scenario evaluates to the same result.
  assert.deepEqual(evaluateScenario(svc.store, rev, s), r0);
  worker.close();
});

test("C27: comparison is level-locked: the same scenario at two levels is not comparable, different baselines are not, and units are counted at the chosen level", async () => {
  const { svc, worker, rev } = await world();
  const remove = (level: Scenario["level"], target: string) => evaluateScenario(svc.store, rev, sc({ level, ops: [{ type: "REMOVE", target }] }));
  const symA = remove("SYMBOL", "ledger"), symB = remove("SYMBOL", "fraud");
  const fileA = remove("FILE", "ledger");
  assert.ok(symA.comparison.every((c) => !c.unit.includes("/")), "at symbol level the units are symbols");
  assert.ok(fileA.comparison.some((c) => /^src\/ledger\/ledger\.ts$/.test(c.unit)), "at file level they are files");
  assert.ok(fileA.comparison.length < symA.comparison.length || fileA.comparison.length >= 1);
  assert.throws(() => compareScenarios(symA, fileA), /different levels \(SYMBOL and FILE\)/);
  const c = compareScenarios(symA, symB);
  assert.equal(c.level, "SYMBOL");
  assert.ok(c.onlyInA.length > 0 && c.onlyInB.length > 0, "each removal affects things the other does not");
  assert.ok(c.onlyInA.includes("adjustBalance") || c.onlyInA.includes("reserve"));
  assert.deepEqual(compareScenarios(symA, symA).onlyInA, []);
  // Another baseline is not comparable.
  assert.throws(() => compareScenarios(symA, { ...symB, baselineRevision: "some-other-revision" }), /different revisions/);
  // Removal reuses the structural analysis, and an empty answer is not read as "safe".
  assert.ok(symB.consequences.some((x) => x.basis === "STRUCTURAL" && /would no longer exist|no check in between|never receive/.test(x.text)));
  const lonely = evaluateScenario(svc.store, rev, sc({ ops: [{ type: "REMOVE", target: "DuplicateRequestError" }] }));
  assert.ok(lonely.consequences.length >= 1);
  assert.ok(lonely.limits.some((l) => /Dynamic calls, configuration, external callers/.test(l)));
  worker.close();
});

test("C27: capacity is measured, interpolated or extrapolated, and each is labelled as what it is; a measurement for another revision is not used", async () => {
  const { svc, worker, rev } = await world();
  const cap: CapacityData = { workloadHash: "ab".repeat(32), revision: rev.id, points: [
    { concurrency: 10, throughputPerSec: 100, p95Ms: 40, errorRate: 0, runId: "run:10" },
    { concurrency: 20, throughputPerSec: 190, p95Ms: 55, errorRate: 0, runId: "run:20" },
    { concurrency: 40, throughputPerSec: 260, p95Ms: 140, errorRate: 0.01, runId: "run:40" },
    { concurrency: 80, throughputPerSec: 262, p95Ms: 600, errorRate: 0.12, runId: "run:80" },
  ] };
  const at = (factor: number, c: CapacityData | null = cap) => evaluateScenario(svc.store, rev, sc({ ops: [{ type: "SCALE", path: CREATE, factor }] }), { capacity: c }).consequences.find((x) => /createPayment at/.test(x.text))!;
  const measured = at(2);   // concurrency 20: a measured point
  assert.equal(measured.basis, "MEASURED");
  assert.match(measured.text, /was measured: p95 55 ms, 190\/s, error rate 0\.0%.*workload abababab/);
  assert.deepEqual(measured.evidenceIds, ["run:20"]);
  const interp = at(3);     // concurrency 30: between 20 and 40
  assert.equal(interp.basis, "INTERPOLATED");
  assert.match(interp.text, /interpolated between 55 and 140 ms, not measured at 30/);
  assert.deepEqual(interp.evidenceIds.sort(), ["run:20", "run:40"]);
  const beyond = at(20);    // concurrency 200: beyond the highest measured
  assert.equal(beyond.basis, "EXTRAPOLATED");
  assert.match(beyond.text, /beyond the highest measured \(80\).*extrapolation, not a measurement/s);
  assert.match(beyond.text, /throughput had stopped rising by 80, so it may saturate before 200/, "a plateau in the measurements is said out loud");
  assert.ok(beyond.conditional, "and it stays conditional on the load behaving like the measurement");
  const none = at(2, null);
  assert.equal(none.basis, "INFERRED");
  assert.match(none.text, /no capacity was measured.*Nothing here is a prediction/);
  const other = evaluateScenario(svc.store, rev, sc({ ops: [{ type: "SCALE", path: CREATE, factor: 2 }] }), { capacity: { ...cap, revision: "elsewhere" } });
  assert.equal(other.consequences.find((x) => /createPayment at/.test(x.text))!.basis, "INFERRED", "a measurement of other code says nothing about this code");
  assert.ok(other.limits.some((l) => /another revision and was not used/.test(l)));
  assert.ok([measured, interp, beyond].every((c) => c.assumptionIds.includes("a:load-is-like-the-measurement")));
  worker.close();
});

test("C27: through the service, an invalid scenario is a typed failure listing the reasons, a valid one is an audited read, and mismatched levels are a typed refusal", async () => {
  const { svc, worker, revision } = await world();
  const { ctx } = await import("./helpers.ts");
  const bad = svc.evaluateScenario(ctx(), { revision, scenario: sc({ ops: [{ type: "REMOVE", target: "nothing-here" }] }) });
  assert.ok(!bad.ok && bad.error.code === "INVALID_SCHEMA" && /not code in this revision/.test(bad.error.message));
  const a = svc.evaluateScenario(ctx(), { revision, scenario: sc({ ops: [{ type: "REMOVE", target: "ledger" }] }) });
  const b = svc.evaluateScenario(ctx(), { revision, scenario: sc({ level: "FILE", ops: [{ type: "REMOVE", target: "ledger" }] }) });
  assert.ok(a.ok && b.ok);
  const cmp = svc.compareScenarios(ctx(), { a: a.value, b: b.value });
  assert.ok(!cmp.ok && /different levels/.test(cmp.error.message));
  assert.ok(svc.store.auditEvents(20).some((e: any) => e.action === "scenario.evaluate"));
  assert.ok(!svc.evaluateScenario(ctx(), { revision: "no-such", scenario: sc({ ops: [{ type: "REMOVE", target: "ledger" }] }) }).ok);
  worker.close();
});
