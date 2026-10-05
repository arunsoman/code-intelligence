import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GenerationRequest, GenerationResponse, GenerationRouter } from "../src/llm-router.ts";
import { builderSuiteHash, CASES, conflictDetectorReport, driftImpact, evaluateBuilderVersion, runBuilderSuite, unevaluatedModels, type LabelledCase } from "../src/feature/builder-eval.ts";
import { rawHash } from "../src/feature/canon.ts";
import { modelIdentityHash } from "../src/feature/model.ts";
import { computeEligibility, defaultValidationPlan } from "../src/feature/validation.ts";
import { fresh } from "./feature-fixtures.ts";
import { boot, createEdit } from "./feature-boot.ts";
import type { ModelInvocation } from "../src/feature/types.ts";

/** A model stand-in that follows the prompt faithfully; variants break exactly one property each. */
class Fake implements GenerationRouter {
  provider = "local"; model = "m1"; endpoint = "http://127.0.0.1:11434"; hosted = false; version = "v1";
  mode: "good" | "merge" | "truncate" | "env" | "test-edit" | "too-long" = "good"; ids: string[] = []; calls = 0;
  async generate(req: GenerationRequest): Promise<GenerationResponse> {
    this.calls++;
    const base = { resolvedVersion: this.version, inputTokens: 10, outputTokens: 10 };
    if (this.mode === "too-long" && req.system.startsWith("Return") && !/Draft acceptance|Propose exact/.test(req.system) && Buffer.byteLength(req.user) > 5000) return { ...base, text: "not json" };
    if (/Propose exact edits/.test(req.system)) {
      const edits = this.mode === "env" ? [{ kind: "CREATE_FILE", path: ".env", baseHash: "", expected: "", replacement: "X=1\n", requirementIds: [this.ids[0]] }]
        : this.mode === "test-edit" && req.user.includes("tests/export.test.ts") ? [{ kind: "DELETE_FILE", path: "tests/export.test.ts", baseHash: rawHash("import test from 'node:test';\ntest('exports', () => {});\n"), expected: "import test from 'node:test';\ntest('exports', () => {});\n", replacement: "", requirementIds: [this.ids[0]] }]
        : [];
      return { ...base, text: JSON.stringify({ edits }) };
    }
    if (/Draft acceptance/.test(req.system)) return { ...base, text: JSON.stringify({ acceptance: this.ids.map((id) => ({ id: `AC-${id}`, requirementIds: [id], scenario: `scenario ${id}`, expectedOutcome: `outcome ${id}`, mandatory: true })), assumptions: [] }) };
    const sources = (JSON.parse(req.user) as { sources: { text: string }[] }).sources; let text = sources[0]!.text;
    if (this.mode === "truncate") text = text.slice(0, 400);
    let parts = text.split(/(?<=\.)\s+|\n/).map((x) => x.trim()).filter(Boolean);
    if (this.mode === "merge") parts = [parts.join(" ")];
    const items = parts.map((t, k) => ({ id: `R${k + 1}`, text: t, type: /only|may/i.test(t) ? "ACCESS" : "FUNCTIONAL", sourceIndex: 0, actorIds: /finance/i.test(t) ? ["finance manager"] : [], conditions: [], dependsOn: [] }));
    this.ids = items.map((x) => x.id);
    return { ...base, text: JSON.stringify({ requirements: items.slice(0, 100) }) };
  }
}
const wall = 60_000;

test("PF-052/AT-41 the suite passes a faithful builder and names exactly the property each broken builder loses", async () => {
  const f = new Fake(); const ok = await runBuilderSuite({ route: f, egress: "LOCAL_ONLY", wallMs: wall });
  assert.deepEqual(ok.cases.map((c) => [c.id, c.state]), CASES.map((c) => [c.id, "PASS"]), JSON.stringify(ok.cases)); assert.equal(ok.identities.length, 1);
  const lose = async (mode: Fake["mode"], ids: string[]) => { const g = new Fake(); g.mode = mode; const r = await runBuilderSuite({ route: g, egress: "LOCAL_ONLY", wallMs: wall }); return r.cases.filter((c) => c.state !== "PASS").map((c) => c.id).sort(); };
  assert.deepEqual(await lose("merge", []), ["CONFLICT"]);
  assert.deepEqual(await lose("truncate", []), ["LONG_INPUT"]);
  assert.deepEqual(await lose("env", []), ["TOOL_MISUSE"]);
  assert.deepEqual(await lose("test-edit", []), ["ORACLE_PRESERVATION"]);
});

test("PF-052 a budget stops the suite and says which cases did not run; cancellation does the same", async () => {
  let t = 0; const r = await runBuilderSuite({ route: new Fake(), egress: "LOCAL_ONLY", wallMs: 1000, now: () => (t += 600) });
  assert.ok(r.cases.some((c) => c.state === "NOT_RUN" && /budget/.test(c.detail)) && r.cases.some((c) => c.state === "PASS"));
  const ac = new AbortController(); ac.abort(); assert.ok((await runBuilderSuite({ route: new Fake(), egress: "LOCAL_ONLY", wallMs: wall, signal: ac.signal })).cases.every((c) => c.state === "NOT_RUN"));
});

const invocation = (version: string, over: Partial<ModelInvocation> = {}): ModelInvocation => ({ id: `invocation:${version}`, provider: "local", model: "m1", resolvedVersion: version, parameters: {}, toolSchemaVersions: [], promptTemplateHash: "p", inputRefs: [], outputHash: "o", egress: "LOCAL_ONLY", startedAt: "2026-10-05T00:00:00Z", status: "COMPLETE", ...over });

test("PF-052/AT-41 evaluation is per identity and per suite: it passes, persists, gates eligibility, and does not carry to a new version", async () => {
  const w = await boot({ edits: () => [createEdit("src/e.ts", "export {};\n")] });
  try {
    const inv = invocation("v1"); const rec = w.fs.getRequest(w.rid)!;
    w.fs.updateRequest(w.rid, rec.version, { ...rec, modelInvocations: [inv] });
    w.fs.putCandidate({ ...w.fs.getCandidate(w.cand.id)!, invocationIds: [inv.id] });
    const cand = () => w.fs.getCandidate(w.cand.id)!, req = () => w.fs.getRequest(w.rid)!;
    const plan = { ...defaultValidationPlan(req(), cand()), testData: { kind: "SYNTHETIC" as const, fixtureHash: "f", generatorHash: "g", seed: "1" } };
    const gaps = () => computeEligibility({ request: req(), candidate: cand(), plan, evidence: [], unevaluatedModels: unevaluatedModels(w.fs, req(), cand()) }).reasons.filter((x) => /builder not evaluated/.test(x));
    assert.match(gaps()[0]!, /no passing builder evaluation/);
    const id = modelIdentityHash(inv), route = new Fake();
    const ev = await evaluateBuilderVersion({ fs: w.fs, routes: [route], egress: "LOCAL_ONLY" }, "arun", { modelIdentityHash: id, suiteHash: builderSuiteHash(), budget: { wallMs: wall } });
    assert.equal(ev.passed, true, JSON.stringify(ev.reasons)); assert.deepEqual(ev.observedIdentityHashes, [id]); assert.deepEqual(gaps(), []);
    assert.equal(w.fs.getEvaluation(id, builderSuiteHash())!.passed, true);
    // a new version of the same model is a different identity: the old pass does not carry over
    const next = invocation("v2", { id: "invocation:v2" }); const r2 = req(); w.fs.updateRequest(w.rid, r2.version, { ...r2, modelInvocations: [...r2.modelInvocations!, next] });
    w.fs.putCandidate({ ...cand(), invocationIds: [next.id] }); assert.match(gaps()[0]!, /@v2/);
    // an unknown version cannot be evaluated at all
    const unk = invocation("UNKNOWN", { id: "invocation:u" }); const r3 = req(); w.fs.updateRequest(w.rid, r3.version, { ...r3, modelInvocations: [...r3.modelInvocations!, unk] }); w.fs.putCandidate({ ...cand(), invocationIds: [unk.id] });
    assert.match(gaps()[0]!, /version unknown/);
    // the route reporting another version than the one under evaluation is a failure, not a pass for either
    route.version = "v9"; const drifted = await evaluateBuilderVersion({ fs: w.fs, routes: [route], egress: "LOCAL_ONLY" }, "arun", { modelIdentityHash: id, suiteHash: builderSuiteHash(), budget: { wallMs: wall } });
    assert.equal(drifted.passed, false); assert.match(drifted.reasons!.join(), /different model identity/); assert.equal(w.fs.getEvaluation(id, builderSuiteHash())!.passed, false);
    // refusals
    const run = (o: Record<string, unknown> = {}, routes: GenerationRouter[] = [route], egress: "LOCAL_ONLY" | "CLOUD_ALLOWED" = "LOCAL_ONLY", who = "arun") => evaluateBuilderVersion({ fs: w.fs, routes, egress }, who, { modelIdentityHash: id, suiteHash: builderSuiteHash(), budget: { wallMs: wall }, ...o });
    await assert.rejects(() => run({ suiteHash: "old" }), /suite changed/); await assert.rejects(() => run({ budget: { wallMs: 0 } }), /bounded/);
    await assert.rejects(() => run({}, [], "LOCAL_ONLY"), /no configured route/); await assert.rejects(() => run({}, [route], "LOCAL_ONLY", "mallory"), /none of your requests/);
    const cloud = new Fake(); (cloud as { hosted: boolean }).hosted = true; await assert.rejects(() => run({}, [cloud]), /egress policy/);
    assert.deepEqual(driftImpact(w.fs, req()).changes, []);
  } finally { w.close(); }
});

test("PF-052 the gateway operation validates, enqueues a job and reports the evaluation", async () => {
  const w = await boot({ edits: () => [createEdit("src/e.ts", "export {};\n")] });
  try {
    const inv = invocation("v1"); const rec = w.fs.getRequest(w.rid)!; w.fs.updateRequest(w.rid, rec.version, { ...rec, modelInvocations: [inv] });
    const h = (await import("../src/feature/handlers.ts")).featureHandlers(w.svc, { builder: { routes: [new Fake()] } }) as Record<string, (c: any, b: any) => any>;
    const body = { repositoryId: w.repo, modelIdentityHash: modelIdentityHash(inv), suiteHash: builderSuiteHash(), budget: { wallMs: wall } };
    assert.equal(h["C17/evaluateBuilderVersion"](w.as("arun"), { ...body, repositoryId: "" }).error.code, "INVALID_SCHEMA");
    const r = h["C17/evaluateBuilderVersion"](w.as("arun"), body); assert.equal(r.ok, true, JSON.stringify(r.error)); assert.ok(r.value.jobId);
    for (let k = 0; k < 100 && !w.svc.store.job(r.value.jobId)?.result; k++) await new Promise((x) => setTimeout(x, 100));
    const job = w.svc.store.job(r.value.jobId)!; assert.equal(job.state, "SUCCEEDED", JSON.stringify(job)); assert.equal((job.result as any).value.passed, true);
  } finally { w.close(); }
});

test("PF-052 ModelIdentityChanged events are listed with the candidates that depend on an unevaluated identity", () => {
  const { fs, make } = fresh(); const rec = make({ requestId: "req:drift" });
  const cand = { schemaVersion: 1 as const, id: "c1", requestId: rec.requestId, ordinal: 1, binding: {} as never, bindingHash: "b", mutations: [], invocationIds: ["invocation:v1"], status: "MATERIALIZED" as const, createdAt: "t" };
  fs.putCandidate(cand); const cur = fs.getRequest(rec.requestId)!; fs.updateRequest(rec.requestId, cur.version, { ...cur, modelInvocations: [invocation("v1")] },
    { schemaVersion: 1, eventId: "e-drift", requestId: rec.requestId, type: "ModelIdentityChanged", actor: "u", producer: "C14", requirementIds: [], decisionIds: [], before: "a", after: "b", result: "BLOCKED", rationale: "changed", at: "t" });
  const d = driftImpact(fs, fs.getRequest(rec.requestId)!); assert.deepEqual(d.changes, [{ eventId: "e-drift", before: "a", after: "b" }]); assert.equal(d.affectedCandidates[0]!.id, "c1");
});

test("PF-052 the conflict-detector report counts hits and misses on the labelled fixture and says it is an inventory", () => {
  const cases = JSON.parse(readFileSync(join(import.meta.dirname, "../../../fixtures/conflict-eval/cases.json"), "utf8")) as LabelledCase[];
  const r = conflictDetectorReport(cases);
  assert.equal(r.cases, 14); assert.equal(r.truePositives + r.falseNegatives, cases.reduce((n, c) => n + c.conflicts.length, 0));
  assert.ok(r.truePositives >= 5, JSON.stringify(r)); assert.equal(r.falsePositives, 0, JSON.stringify(r.falseAlarms));
  // semantic conflicts with no shared wording are missed, and the report says so rather than hiding them
  assert.ok(r.misses.some((m) => m.startsWith("semantic-not-lexical")) && r.misses.some((m) => m.startsWith("retry-times-unit-less")));
  assert.equal(r.precision, 1); assert.ok(r.recall! < 1 && r.recall! > 0.4); assert.match(r.note, /not an accuracy claim/);
  assert.deepEqual(conflictDetectorReport([]), { cases: 0, truePositives: 0, falsePositives: 0, falseNegatives: 0, precision: null, recall: null, misses: [], falseAlarms: [], note: r.note });
});
