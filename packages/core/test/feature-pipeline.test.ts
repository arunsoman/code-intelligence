import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationRequest, GenerationResponse, GenerationRouter } from "../src/llm-router.ts";
import { rawHash } from "../src/feature/canon.ts";
import { DockerRunner, dockerAvailable } from "../src/feature/docker-runner.ts";
import { FeatureModelAdapter } from "../src/feature/model.ts";
import { runFeaturePipeline, type PipelineDeps } from "../src/feature/pipeline.ts";
import { gateDriverFor } from "../src/feature/security-handlers.ts";
import { SqliteFeatureStore } from "../src/feature/store.ts";
import type { FeatureEdit } from "../src/feature/candidate.ts";
import type { RunRequest, RunResult, Runner } from "../src/feature/types.ts";
import { setup } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../../..");
function demo(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "cie-tx-")), "transactions-app");
  execFileSync("bash", [join(ROOT, "scripts_make_demo_repo.sh"), dir, "transactions-app"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/transactions.git"]);
  return dir;
}

/** A stand-in model that reads the prompt and returns what a careful builder would: it is a script, and the test says so. */
class Script implements GenerationRouter {
  provider = "local"; model = "scripted"; endpoint = "http://127.0.0.1:11434"; hosted = false; calls = 0;
  async generate(req: GenerationRequest): Promise<GenerationResponse> {
    this.calls++; const base = { resolvedVersion: "script-v1", inputTokens: 10, outputTokens: 10 };
    if (/Draft acceptance/.test(req.system)) return { ...base, text: JSON.stringify({ acceptance: [
      { id: "A1", requirementIds: ["R1"], scenario: "A member exports their tenant's transactions", expectedOutcome: "The CSV has a header row and one row per transaction of that tenant only", mandatory: true },
      { id: "A2", requirementIds: ["R2"], scenario: "A support user tries to export", expectedOutcome: "The export is refused with status 403", mandatory: true }], assumptions: [] }) };
    if (/Propose exact edits/.test(req.system)) return { ...base, text: JSON.stringify({ edits: [] }) };
    const text = (JSON.parse(req.user) as { sources: { text: string }[] }).sources[0]!.text;
    return { ...base, text: JSON.stringify({ requirements: [
      { id: "R1", text: "Members can export their own tenant's transactions as CSV.", type: "FUNCTIONAL", sourceIndex: 0, actorIds: ["member"], conditions: [], dependsOn: [] },
      { id: "R2", text: "Support staff must not be able to export transactions.", type: "ACCESS", sourceIndex: 0, actorIds: ["support"], conditions: [], dependsOn: [] }].slice(0, /support/i.test(text) ? 2 : 1) }) };
  }
}
const PROMPT = "Add CSV export of transactions so members can export their own tenant's transactions as CSV. Support staff must not be able to export transactions.";

/** The edits the "model" proposes, computed from the real file text so the quoted spans are exact. */
const exportEdits = (repo: string): FeatureEdit[] => {
  const api = readFileSync(join(repo, "src/api.ts"), "utf8"); const anchor = "export type Response<T>";
  return [
    { op: "CREATE_FILE", file: "src/export.ts", why: "csv", requirementIds: ["R1", "R2"], content: `import type { Transaction } from "./transactions.ts";\n\nconst cell = (v: string | number): string => { const s = String(v); return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };\n\nexport function toCsv(rows: Transaction[]): string {\n  const head = "id,amountCents,currency,createdAt";\n  return [head, ...rows.map((t) => [t.id, t.amountCents, t.currency, t.createdAt].map(cell).join(","))].join("\\n") + "\\n";\n}\n` },
    { op: "REPLACE_SPAN", file: "src/api.ts", baseHash: rawHash(api), start: Buffer.byteLength(api.slice(0, api.indexOf(anchor))), end: Buffer.byteLength(api.slice(0, api.indexOf(anchor))) + anchor.length, expected: anchor, why: "route", requirementIds: ["R1", "R2"],
      newText: `import { toCsv } from "./export.ts";\n\nexport function exportTransactions(user: User, db: Db): { status: 200 | 403; body: string } {\n  if (!canReadTransactions(user)) return { status: 403, body: "not allowed" };\n  return { status: 200, body: toCsv(listTransactions(db, user.tenantId)) };\n}\n\n${anchor}` },
    { op: "CREATE_FILE", file: "tests/export.test.ts", why: "tests", requirementIds: ["R1", "R2"], content: `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { exportTransactions } from "../src/api.ts";\n\nconst db = { transactions: [\n  { id: "t1", tenantId: "acme", amountCents: 1250, currency: "USD", createdAt: "2026-10-01T10:00:00Z" },\n  { id: "t3", tenantId: "globex", amountCents: 500, currency: "EUR", createdAt: "2026-10-03T10:00:00Z" },\n] };\n\ntest("a member exports a header row and only their tenant's rows", () => {\n  const r = exportTransactions({ id: "u1", tenantId: "acme", role: "member" }, db);\n  assert.equal(r.status, 200); assert.equal(r.body, "id,amountCents,currency,createdAt\\nt1,1250,USD,2026-10-01T10:00:00Z\\n");\n});\n\ntest("support staff cannot export", () => {\n  assert.equal(exportTransactions({ id: "u2", tenantId: "acme", role: "support" }, db).status, 403);\n});\n` },
  ];
};

class FakeRunner implements Runner {
  readonly isolation = "CONTAINER" as const; readonly omissions: string[] = []; calls: RunRequest[] = [];
  async run(req: RunRequest): Promise<RunResult> { this.calls.push(req); const test = req.argv.includes("test");
    return { status: "PASSED", exitCode: 0, stdout: test ? "TAP version 13\nok 1 - a member exports a header row and only their tenant's rows\nok 2 - support staff cannot export\n# tests 2\n# pass 2\n# fail 0\n" : "ok api.ts\n", stderr: "", truncated: false, isolation: "CONTAINER", omissions: [], usage: { wallMs: 1 } }; }
}

async function world(runner: Runner = new FakeRunner(), over: Partial<PipelineDeps> = {}) {
  const repo = demo(); const { svc, worker } = await setup(undefined, repo); const fs = new SqliteFeatureStore(svc.store); const router = new Script();
  const deps: PipelineDeps = { fs, store: svc.store, auth: { bindings: [] }, runner, adapter: (rid) => new FeatureModelAdapter(fs, rid, { routes: [router], egress: "LOCAL_ONLY" }),
    generateEdits: async () => ({ edits: exportEdits(repo), invocationIds: [] }), runCheck: gateDriverFor({}, fs), ...over };
  return { repo, svc, fs, router, deps, close: () => worker.close() };
}
const input = (repo: string, over: Record<string, unknown> = {}) => ({ repositoryId: repo, text: PROMPT, mode: "BUILD_PREVIEW" as const, idempotencyKey: "k1", ...over });

test("4.1 the driver runs the whole slice on the transactions demo and reports review-only: with everything else satisfied, the only open gap is performance, which nobody measured", async () => {
  const w = await world();
  try {
    const r = await runFeaturePipeline(w.deps, "arun", input(w.repo, { confirm: { criteria: "ALL", rationale: "these are the outcomes I want" }, releasePlan: { applicability: "APPLICABLE", revertRunbook: "revert the draft PR" }, validation: { fidelity: "REPRESENTATIVE", dependencies: "AVAILABLE", environmentLabel: "test-double", testData: { kind: "SYNTHETIC" } } }));
    assert.deepEqual(r.steps.map((s) => s.step), ["SUBMIT", "DISCOVER", "NORMALISE", "CONSTRAINTS", "CLARIFY", "CONFIRM", "OVERLAP", "PLAN", "GENERATE", "CANDIDATE", "VALIDATE", "DECIDE", "EXPORT", "PUBLISH"], JSON.stringify(r.steps));
    assert.equal(r.stop, "COMPLETE", JSON.stringify(r)); assert.equal(r.decision!.eligibility, "REVIEW_ONLY_INCOMPLETE"); assert.match(r.reason, /^review only/);
    assert.ok(r.decision!.reasons.every((x) => /^performance:/.test(x)), r.decision!.reasons.join("; "));
    assert.ok(r.exportId); assert.equal(r.candidate!.mutations.length, 3);
    assert.equal(w.fs.getRequest(r.requestId)!.state, "VALIDATING");
  } finally { w.close(); }
});

const FULL = { confirm: { criteria: "ALL" as const, rationale: "these are the outcomes I want" }, releasePlan: { applicability: "APPLICABLE" as const, revertRunbook: "revert the draft PR" },
  validation: { fidelity: "REPRESENTATIVE" as const, dependencies: "AVAILABLE" as const, environmentLabel: "test-double", testData: { kind: "SYNTHETIC" as const }, performanceApplicable: false } };

test("4.1 when every declared gate is satisfied the same driver reports VERIFIED_WITHIN_SCOPE, and the report says what it does not claim", async () => {
  const w = await world();
  try {
    const r = await runFeaturePipeline(w.deps, "arun", input(w.repo, FULL));
    assert.equal(r.stop, "COMPLETE", JSON.stringify(r.steps)); assert.equal(r.decision!.eligibility, "VERIFIED_WITHIN_SCOPE", r.decision!.reasons.join("; ")); assert.match(r.reason, /^verified within the scope/);
    const exp = w.fs.getCandidate(r.candidate!.id)!.exports![0]!; assert.match(exp.label!, /VERIFIED WITHIN THE SCOPE/); assert.doesNotMatch(exp.label!, /bug-free/i);
    const perf = w.fs.listEvidence(r.candidate!.id).flatMap((e) => e.results).find((x) => x.kind === "PERFORMANCE")!; assert.equal(perf.status, "NOT_APPLICABLE"); assert.match(perf.notApplicableRationale ?? "", /not measured/);
  } finally { w.close(); }
});

test("4.1 without a person's confirmation the generated oracle caps the result at review-only, even when every check passes", async () => {
  const w = await world();
  try {
    const r = await runFeaturePipeline(w.deps, "arun", input(w.repo, { ...FULL, confirm: undefined }));
    assert.equal(r.stop, "COMPLETE"); assert.equal(r.decision!.eligibility, "REVIEW_ONLY_INCOMPLETE"); assert.ok(r.decision!.reasons.every((x) => /unreviewed|UNREVIEWED_ORACLE/.test(x)), r.decision!.reasons.join("; "));
    assert.match(r.steps.find((s) => s.step === "CONFIRM")!.detail, /stay unreviewed/);
  } finally { w.close(); }
});

test("4.1 PLAN mode stops after the plan; a repeated run with the same key reuses the request and builds no second candidate", async () => {
  const w = await world();
  try {
    const plan = await runFeaturePipeline(w.deps, "arun", input(w.repo, { mode: "PLAN", idempotencyKey: "plan-1" })); assert.equal(plan.stop, "PLAN_ONLY"); assert.equal(plan.candidate, undefined); assert.equal(w.fs.listCandidates(plan.requestId).length, 0);
    const a = await runFeaturePipeline(w.deps, "arun", input(w.repo, { ...FULL, idempotencyKey: "same" })), calls = w.router.calls;
    const b = await runFeaturePipeline(w.deps, "arun", input(w.repo, { ...FULL, idempotencyKey: "same" }));
    assert.equal(b.requestId, a.requestId); assert.equal(w.fs.listCandidates(a.requestId).length, 1); assert.equal(w.router.calls, calls, "a second run makes no new model calls"); assert.match(b.steps[0]!.detail, /replayed/);
  } finally { w.close(); }
});

test("4.1 the driver never answers for a person: a contradiction stops it with the question, and the caller's answer lets it continue", async () => {
  const w = await world(); w.router.generate = async (req: GenerationRequest) => {
    const base = { resolvedVersion: "script-v1", inputTokens: 10, outputTokens: 10 };
    if (/Draft acceptance/.test(req.system)) return { ...base, text: JSON.stringify({ acceptance: [{ id: "A1", requirementIds: ["R1"], scenario: "s1", expectedOutcome: "e1", mandatory: true }, { id: "A2", requirementIds: ["R2"], scenario: "s2", expectedOutcome: "e2", mandatory: true }], assumptions: [] }) };
    if (/Propose exact edits/.test(req.system)) return { ...base, text: JSON.stringify({ edits: [] }) };
    return { ...base, text: JSON.stringify({ requirements: [
      { id: "R1", text: "Admins must export all transactions.", type: "FUNCTIONAL", sourceIndex: 0, actorIds: ["admin"], conditions: [], dependsOn: [] },
      { id: "R2", text: "Admins must never export transactions.", type: "FUNCTIONAL", sourceIndex: 0, actorIds: ["admin"], conditions: [], dependsOn: [] }] }) };
  };
  try {
    const text = "Admins must export all transactions. Admins must never export transactions.";
    const stopped = await runFeaturePipeline(w.deps, "arun", input(w.repo, { text, idempotencyKey: "c1" }));
    assert.equal(stopped.stop, "NEEDS_ANSWER", JSON.stringify(stopped.steps)); assert.ok(stopped.questions!.length >= 1); assert.equal(stopped.candidate, undefined); assert.equal(w.fs.listCandidates(stopped.requestId).length, 0);
    assert.ok(!stopped.steps.some((s) => s.step === "GENERATE"), "nothing was generated while a question was open");
    const q = stopped.questions![0]!;
    const next = await runFeaturePipeline(w.deps, "arun", input(w.repo, { text, idempotencyKey: "c1", answers: { [q.id]: q.choices[0] ?? "Admins may export their own tenant's transactions", nope: "x" } }));
    assert.ok(next.steps.some((s) => s.step === "CLARIFY" && s.status === "DONE" && /recorded 1 answer/.test(s.detail)), JSON.stringify(next.steps)); assert.deepEqual(next.unusedAnswers, ["nope"]);
    assert.equal(w.fs.listDecisions(stopped.requestId).filter((d) => d.questionId === q.id).length, 1);
  } finally { w.close(); }
});

test("4.1 a failing check blocks: the candidate is not exported and the reason is the failing check", async () => {
  const bad = new FakeRunner(); bad.run = async (req) => ({ status: "FAILED", exitCode: 1, stdout: req.argv.includes("test") ? "TAP version 13\nnot ok 1 - support staff cannot export\n# tests 1\n# pass 0\n# fail 1\n" : "", stderr: "", truncated: false, isolation: "CONTAINER", omissions: [], usage: { wallMs: 1 } });
  const w = await world(bad);
  try {
    const r = await runFeaturePipeline(w.deps, "arun", input(w.repo, FULL));
    assert.equal(r.stop, "BLOCKED"); assert.match(r.reason, /FAIL|build/); assert.equal(r.exportId, undefined); assert.equal(w.fs.getCandidate(r.candidate!.id)!.exports, undefined); assert.equal(r.steps.find((s) => s.step === "EXPORT")!.status, "SKIPPED");
  } finally { w.close(); }
});

test("4.1 the draft-PR step needs a bound issue and a forge; with both, one draft PR results", async () => {
  const { Forge } = await import("./feature-pipeline-forge.ts");
  const clones = mkdtempSync(join(tmpdir(), "pf-clones-"));
  const w0 = await world(); let forge!: InstanceType<typeof Forge>;
  try {
    forge = new Forge(w0.repo); const deps: PipelineDeps = { ...w0.deps, publish: { forge, cloneRoot: clones } };
    const blocked = await runFeaturePipeline(deps, "arun", input(w0.repo, { ...FULL, mode: "CREATE_DRAFT_PR", publishTo: "acme/transactions:main", idempotencyKey: "pr-1" }));
    assert.equal(blocked.stop, "BLOCKED"); assert.match(blocked.reason, /issue tracking is mandatory/); assert.equal(forge.creates, 0);
    const rid = blocked.requestId; const rec = w0.fs.getRequest(rid)!; w0.fs.updateRequest(rid, rec.version, { ...rec, issue: { ...rec.issue, syncState: "UNSYNCED" } });
    const ok = await runFeaturePipeline(deps, "arun", input(w0.repo, { ...FULL, mode: "CREATE_DRAFT_PR", publishTo: "acme/transactions:main", idempotencyKey: "pr-1" }));
    assert.equal(ok.stop, "COMPLETE", JSON.stringify(ok.steps)); assert.equal(ok.publication!.kind, "DRAFT_PR"); assert.equal(forge.creates, 1); assert.equal(ok.publication!.eligibility, "VERIFIED_WITHIN_SCOPE");
    assert.equal(w0.fs.getRequest(rid)!.state, "PUBLISHED");
  } finally { w0.close(); }
});

const realDocker = dockerAvailable();
test("4.1 REAL: build and tests run inside a container on the candidate's exact bytes, and the slice reaches VERIFIED_WITHIN_SCOPE", { skip: realDocker ? false : "docker or node:24-alpine is not available" }, async () => {
  const w = await world(new DockerRunner());
  try {
    const r = await runFeaturePipeline(w.deps, "arun", input(w.repo, { ...FULL, validation: { ...FULL.validation, environmentLabel: "docker node:24-alpine", wallMs: 300_000 } }));
    assert.equal(r.stop, "COMPLETE", JSON.stringify(r.steps)); assert.equal(r.decision!.eligibility, "VERIFIED_WITHIN_SCOPE", r.decision!.reasons.join("; "));
    const ev = w.fs.listEvidence(r.candidate!.id); const unit = ev.find((e) => e.validation?.checkId === "tests:.")!;
    assert.ok(unit.validation!.outcomes.some((o) => /a member exports a header row/.test(o.name) && o.state === "PASS")); assert.equal(unit.validation!.baselineHealth, "HEALTHY");
    assert.ok(ev.some((e) => e.validation?.roleRuns.length)); assert.equal(w.repo && !readFileSync(join(w.repo, "src/api.ts"), "utf8").includes("exportTransactions"), true, "the user's tree was not modified");
  } finally { w.close(); }
});
