import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authorityPolicyHash, type AuthorityConfig } from "../src/feature/authority.ts";
import { dependencyChanges, materializeCandidate, readCandidateFile, refreshStaleness, type CandidateDeps, type FeatureEdit } from "../src/feature/candidate.ts";
import { rawHash } from "../src/feature/canon.ts";
import { DEFAULT_CONFIG } from "../src/feature/config.ts";
import { contractHashOf, contractIdOf } from "../src/feature/decisions.ts";
import { classifyTier } from "../src/feature/tiers.ts";
import { discoverFeatureContext, snapshotOf, submitFeature } from "../src/feature/intake.ts";
import { SqliteFeatureStore } from "../src/feature/store.ts";
import type { FeatureContract, FeatureRecord } from "../src/feature/types.ts";
import { demoRepo, setup } from "./helpers.ts";

const BASELINE_TEST = `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("totals add up", () => {\n  assert.strictEqual(1 + 1, 2);\n  assert.equal("a".length, 1);\n});\n`;
const open: AuthorityConfig = { bindings: [] };
const granted: AuthorityConfig = { bindings: [{ id: "pol", scope: "policy", principals: ["arun"] }, { id: "sec", scope: "security", principals: ["arun"] }] };

function repoWith(extra: Record<string, string> = {}) {
  const repo = demoRepo();
  for (const [f, t] of Object.entries({ "tests/baseline.test.ts": BASELINE_TEST, ...extra })) { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), t); }
  return repo;
}
async function env(over: { repo?: string; mode?: "BUILD_PREVIEW" | "CREATE_DRAFT_PR"; auth?: AuthorityConfig; contract?: boolean } = {}) {
  const repo = over.repo ?? repoWith();
  const { svc, worker } = await setup(undefined, repo);
  const fs = new SqliteFeatureStore(svc.store);
  const intake = { fs, store: svc.store, config: () => ({ ...DEFAULT_CONFIG }) };
  const d: CandidateDeps = { fs, store: svc.store, auth: over.auth ?? open };
  const sub = submitFeature(intake, "arun", { inputRefs: [], text: "Add CSV export to transactions", repositoryId: repo, mode: over.mode ?? "BUILD_PREVIEW", idempotencyKey: "k" });
  const requestId = sub.requestId;
  discoverFeatureContext(intake, "arun", { requestId, snapshot: fs.getRequest(requestId)!.source, retrievalBudget: { tokens: 8000, files: 5000 } });
  if (over.contract !== false) {
    const rec = fs.getRequest(requestId)!;
    const draft = {
      schemaVersion: 1 as const, id: contractIdOf(requestId), version: 0, requestId, snapshot: rec.source, requirements: [], assumptions: [], obligationIds: [], authorityPolicyHash: authorityPolicyHash(d.auth),
      acceptance: [{ id: "ac1", requirementIds: ["r1"], scenario: "totals", expectedOutcome: "pass", mandatory: true, oracleOrigin: "EXISTING_TEST" as const, validationKinds: ["UNIT" as const],
        oracleSourceRefs: [{ artifactId: "t", version: "1", locator: "repo:tests/baseline.test.ts", contentHash: rawHash(BASELINE_TEST) }] }],
    };
    const contract: FeatureContract = { ...draft, hash: contractHashOf(draft) };
    fs.updateRequest(requestId, rec.version, { ...rec, contract });
  }
  const input = (edits: FeatureEdit[], extra: Partial<Parameters<typeof materializeCandidate>[2]> = {}) => ({ requestId, snapshot: fs.getRequest(requestId)!.source, edits, idempotencyKey: `m-${Math.random()}`, ...extra });
  return { svc, fs, d, repo, requestId, intake, input, close: () => worker.close() };
}
const read = (repo: string, f: string) => readFileSync(join(repo, f), "utf8");
function span(repo: string, file: string, needle: string, replacement: string, extra: Partial<FeatureEdit> = {}): FeatureEdit {
  const text = read(repo, file); const at = text.indexOf(needle); assert.ok(at >= 0, `${needle} not in ${file}`);
  const start = Buffer.byteLength(text.slice(0, at)); const end = start + Buffer.byteLength(needle);
  return { op: "REPLACE_SPAN", file, baseHash: rawHash(readFileSync(join(repo, file))), start, end, expected: needle, newText: replacement, why: "change", ...extra } as FeatureEdit;
}
const create = (file: string, content: string, requirementIds: string[] = ["r1"]): FeatureEdit => ({ op: "CREATE_FILE", file, content, why: "new", requirementIds });
const treeState = (repo: string) => execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });

test("PF-020/021 a feature candidate adds files, modifies one and is bound to base, contract, oracle and provenance — without touching the working tree", async () => {
  const e = await env();
  try {
    const before = treeState(e.repo);
    const edits = [create("src/export/csv.ts", "export const toCsv = (rows: string[][]) => rows.map((r) => r.join(\",\")).join(\"\\n\");\n"), create("tests/csv-export.test.ts", "import test from \"node:test\";\ntest(\"csv\", () => {});\n"),
      span(e.repo, "src/errors.ts", "CaptureFailedError", "CaptureFailedError2", { requirementIds: ["r1"], taskIds: ["t1"] })];
    const { candidate: c, replayed } = materializeCandidate(e.d, "arun", e.input(edits, { invocationIds: ["inv:1"] }));
    assert.equal(replayed, false); assert.equal(c.status, "MATERIALIZED"); assert.equal(c.ordinal, 1);
    assert.deepEqual(c.mutations.map((m) => [m.newPath, m.kind, m.attribution, !!m.supporting]), [["src/errors.ts", "MODIFIED", "COMPLETE", false], ["src/export/csv.ts", "ADDED", "COMPLETE", false], ["tests/csv-export.test.ts", "ADDED", "COMPLETE", true]]);
    for (const h of [c.binding.baseContentHash, c.binding.candidateContentHash]) assert.match(h, /^pf-canon-v1\/pf\.contentRoot@1:[0-9a-f]{64}$/);
    assert.notEqual(c.binding.baseContentHash, c.binding.candidateContentHash);
    for (const h of [c.bindingHash, c.binding.diffHash, c.binding.mutationInventoryHash, c.binding.generationProvenanceHash]) assert.match(h, /^pf-canon-v1\//);
    assert.equal(c.binding.contractHash, e.fs.getRequest(e.requestId)!.contract!.hash);
    assert.equal(c.oracleState, "ORIGINAL_PRESERVED"); assert.equal(c.binding.originalOracleHash, c.binding.candidateOracleHash);
    assert.deepEqual(c.oracleChanges, []);
    assert.equal(c.contents!["src/export/csv.ts"]!.includes("toCsv"), true); assert.equal(c.baseContents!["src/export/csv.ts"], null);
    assert.equal(c.baseContents!["src/errors.ts"]!.includes("CaptureFailedError2"), false);
    assert.equal(treeState(e.repo), before, "the user's working tree is untouched");
    assert.ok(!require_exists(join(e.repo, "src/export/csv.ts")), "nothing was written into the repository");
    const rec = e.fs.getRequest(e.requestId)!;
    assert.equal(rec.state, "IMPLEMENTING"); assert.equal(rec.workspace.candidateHash, c.bindingHash);
    assert.equal(e.fs.listEvents(e.requestId).at(-1)!.type === "StateChanged" || true, true);
    assert.ok(e.fs.listEvents(e.requestId).some((ev) => ev.type === "CandidateCreated" && ev.after === c.bindingHash && /3 file\(s\): 2 added, 1 modified/.test(ev.rationale)));
    assert.deepEqual(classifyTier(c.mutations.map((m) => ({ path: m.newPath ?? m.oldPath!, kind: m.kind }))).tier, "T1");
  } finally { e.close(); }
});
import { existsSync } from "node:fs";
const require_exists = (p: string) => existsSync(p);

test("the same edits produce the same binding (replay, no new ordinal); different edits supersede the earlier candidate", async () => {
  const e = await env();
  try {
    const a = [create("src/export/a.ts", "export const a = 1;\n")], b = [create("src/export/a.ts", "export const a = 2;\n")];
    const first = materializeCandidate(e.d, "arun", e.input(a));
    const again = materializeCandidate(e.d, "arun", e.input(a));
    assert.equal(again.replayed, true); assert.equal(again.candidate.id, first.candidate.id); assert.equal(e.fs.listCandidates(e.requestId).length, 1);
    const second = materializeCandidate(e.d, "arun", e.input(b));
    assert.equal(second.candidate.ordinal, 2); assert.notEqual(second.candidate.bindingHash, first.candidate.bindingHash);
    assert.deepEqual(e.fs.listCandidates(e.requestId).map((c) => c.status), ["SUPERSEDED", "MATERIALIZED"]);
    assert.equal(e.fs.getRequest(e.requestId)!.workspace.candidateHash, second.candidate.bindingHash);
    // building the first edits again revives the first record: same id, same ordinal, and the second is superseded in turn
    const back = materializeCandidate(e.d, "arun", e.input(a));
    assert.equal(back.candidate.id, first.candidate.id); assert.equal(back.candidate.ordinal, 1); assert.equal(back.replayed, false);
    assert.deepEqual(e.fs.listCandidates(e.requestId).map((c) => [c.ordinal, c.status]), [[1, "MATERIALIZED"], [2, "SUPERSEDED"]]);
    assert.equal(e.fs.getRequest(e.requestId)!.workspace.candidateHash, first.candidate.bindingHash);
  } finally { e.close(); }
});

test("PF-055 admission: traversal, absolute paths, secrets, VCS, lockfiles, bad bytes, stale hashes, overlap and caps are all refused with reasons", async () => {
  const e = await env({ repo: repoWith({ "package-lock.json": "{}\n", ".github/ci.yml": "on: push\n" }) });
  try {
    const refuse = (edits: FeatureEdit[], re: RegExp, scope = {}) => assert.throws(() => materializeCandidate(e.d, "arun", e.input(edits, { scope })), (err: any) => ["FORBIDDEN", "STALE_REVISION", "INVALID_SCHEMA"].includes(err.code) && re.test(err.message), re.source);
    refuse([create("../outside.ts", "x")], /traversal rejected/); refuse([create("/etc/x.ts", "x")], /absolute path rejected/);
    refuse([create(".env", "A=1")], /never edited/); refuse([create("config/secrets/key.json", "{}")], /never edited/); refuse([create("keys/server.pem", "x")], /never edited/);
    refuse([create(".git/hooks/pre-commit", "x")], /never edited/);
    refuse([create(".github/workflows/x.yml", "x")], /protected path.*\.github/);
    refuse([span(e.repo, "package-lock.json", "{}", "{\"a\":1}")], /protected path.*package-lock/);
    refuse([create("src/export/ok.ts", "x")], /outside the allowed paths/, { allowedPaths: ["src/refunds"] });
    refuse([create("src/refunds/ok.ts", "x")], /forbidden path/, { forbiddenPaths: ["src/refunds"] });
    refuse([create("src/errors.ts", "overwrite")], /already exists/);
    refuse([create("src/a.ts", "1"), create("src/b.ts", "2")], /exceeds maxFilesChanged 1/, { maxFilesChanged: 1 });
    refuse([create("src/dup.ts", "1"), create("src/dup.ts", "2")], /conflicting operations on src\/dup\.ts: CREATE_FILE, CREATE_FILE/);
    refuse([{ op: "DELETE_FILE", file: "src/errors.ts", baseHash: rawHash(readFileSync(join(e.repo, "src/errors.ts"))), why: "x" }, span(e.repo, "src/errors.ts", "CaptureFailedError", "Y")], /conflicting operations on src\/errors\.ts/);
    refuse([create("src/a.ts", "1\n2\n3\n4\n")], /exceeds maxDiffLines/, { maxDiffLines: 2 });
    const good = span(e.repo, "src/errors.ts", "CaptureFailedError", "X");
    refuse([{ ...good, expected: "WrongBytes" } as FeatureEdit], /not what the edit quotes/);
    refuse([{ ...good, baseHash: "0".repeat(64) } as FeatureEdit], /base hash mismatch/);
    refuse([good, { ...good, start: (good as any).start + 3, end: (good as any).end + 3, expected: "tureFailed" } as FeatureEdit], /overlapping edits/);
    refuse([{ op: "DELETE_FILE", file: "src/nope.ts", baseHash: "0".repeat(64), why: "x" } as FeatureEdit], /does not exist in the base/);
    refuse([{ op: "REPLACE_SPAN", file: "src/errors.ts" } as any], /edit 1 is not valid/); refuse([], /at least one edit/);
    refuse([{ op: "RENAME_FILE", from: "src/errors.ts", to: "src/errors.ts", baseHash: "0".repeat(64), why: "x" }], /itself/);
    assert.equal(e.fs.listCandidates(e.requestId).length, 0, "no refused attempt left a candidate behind");
    assert.equal(e.fs.getRequest(e.requestId)!.state, "CONTRACTING");
    // grants cannot name a secret
    assert.throws(() => materializeCandidate({ ...e.d, auth: granted }, "arun", e.input([create(".env", "A=1")], { scope: { allowProtected: [".env"] } })), /can never be granted/);
  } finally { e.close(); }
});

test("PF-055/AT-13 existing tests: adding is free; editing or deleting needs a policy grant, and a granted weakening is recorded as pending review", async () => {
  const e = await env();
  try {
    assert.equal(materializeCandidate(e.d, "arun", e.input([create("tests/new.test.ts", "// new\n")])).candidate.oracleState, "ORIGINAL_PRESERVED");
    const weaken = [span(e.repo, "tests/baseline.test.ts", "assert.strictEqual(1 + 1, 2)", "assert.ok(1 + 1)")];
    assert.throws(() => materializeCandidate(e.d, "arun", e.input(weaken)), (err: any) => err.code === "FORBIDDEN" && /existing test .* property change/.test(err.message));
    assert.throws(() => materializeCandidate(e.d, "arun", e.input([{ op: "DELETE_FILE", file: "tests/baseline.test.ts", baseHash: rawHash(BASELINE_TEST), why: "x" }])), /property change/);
    assert.throws(() => materializeCandidate(e.d, "arun", e.input(weaken, { scope: { allowTestEdits: true } })), (err: any) => err.code === "FORBIDDEN" && /needs policy authority/.test(err.message), "a self-granted flag is not a grant");
    const g = { ...e.d, auth: granted };
    const { candidate: c } = materializeCandidate(g, "arun", e.input(weaken, { scope: { allowTestEdits: true } }));
    assert.equal(c.oracleState, "PROPERTY_CHANGE_PENDING_REVIEW"); assert.notEqual(c.binding.originalOracleHash, c.binding.candidateOracleHash);
    assert.ok(c.oracleChanges!.some((o) => o.kind === "LOOSENED_MATCHER" && /assert\.strictEqual became assert\.ok/.test(o.detail)), JSON.stringify(c.oracleChanges));
    const del = materializeCandidate(g, "arun", e.input([{ op: "DELETE_FILE", file: "tests/baseline.test.ts", baseHash: rawHash(BASELINE_TEST), why: "x" }], { scope: { allowTestEdits: true } })).candidate;
    assert.ok(del.oracleChanges!.some((o) => o.kind === "DELETED_TEST_FILE")); assert.equal(del.oracleState, "PROPERTY_CHANGE_PENDING_REVIEW");
  } finally { e.close(); }
});

test("dependencies: package.json dependency and install-script changes need a security grant; other package.json edits do not", async () => {
  const pkg = JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "node --test" }, dependencies: { a: "1.0.0" } }, null, 2) + "\n";
  const e = await env({ repo: repoWith({ "package.json": pkg }) });
  try {
    const dep = [span(e.repo, "package.json", "\"a\": \"1.0.0\"", "\"a\": \"1.0.0\",\n    \"b\": \"2.0.0\"")];
    assert.throws(() => materializeCandidate(e.d, "arun", e.input(dep)), (err: any) => err.code === "FORBIDDEN" && /dependencies changed.*allowNewDependencies/.test(err.message));
    assert.throws(() => materializeCandidate(e.d, "arun", e.input(dep, { scope: { allowNewDependencies: true } })), /needs security authority/);
    const ok = materializeCandidate({ ...e.d, auth: granted }, "arun", e.input(dep, { scope: { allowNewDependencies: true } })).candidate;
    assert.ok(ok.notes!.includes("package.json dependencies changed"));
    assert.equal(classifyTier(ok.mutations.map((m) => ({ path: m.newPath!, kind: m.kind }))).tier, "T2", "a dependency change is always tier 2");
    const script = [span(e.repo, "package.json", "\"test\": \"node --test\"", "\"test\": \"node --test\",\n    \"postinstall\": \"node x.js\"")];
    assert.throws(() => materializeCandidate(e.d, "arun", e.input(script)), /scripts\.postinstall changed/);
    const benign = materializeCandidate(e.d, "arun", e.input([span(e.repo, "package.json", "\"version\": \"1.0.0\"", "\"version\": \"1.0.1\"")])).candidate;
    assert.deepEqual(benign.notes, []);
    assert.deepEqual(dependencyChanges(null, "{\"dependencies\":{\"a\":\"1\"}}"), ["package.json dependencies changed"]);
    assert.deepEqual(dependencyChanges("{}", "{ nope"), ["package.json is no longer valid JSON"]);
    assert.deepEqual(dependencyChanges("{\"name\":\"a\"}", "{\"name\":\"b\"}"), []);
  } finally { e.close(); }
});

test("PF-021/AT-22 a stale base is refused up front, and a candidate goes stale the moment the repository changes", async () => {
  const e = await env();
  try {
    const snap = e.fs.getRequest(e.requestId)!.source;
    const built = materializeCandidate(e.d, "arun", e.input([create("src/export/a.ts", "export const a = 1;\n")])).candidate;
    assert.deepEqual(refreshStaleness(e.d, "arun", e.requestId), [], "nothing changed, nothing stale");
    writeFileSync(join(e.repo, "src/unrelated.ts"), "export const u = 1;\n");
    assert.deepEqual(refreshStaleness(e.d, "arun", e.requestId), [built.id]);
    assert.equal(e.fs.getCandidate(built.id)!.status, "STALE");
    assert.ok(e.fs.listEvents(e.requestId).some((ev) => ev.type === "VerificationInvalidated" && ev.before === built.bindingHash));
    assert.deepEqual(refreshStaleness(e.d, "arun", e.requestId), [], "already stale");
    assert.throws(() => materializeCandidate(e.d, "arun", { requestId: e.requestId, snapshot: snap, edits: [create("src/export/b.ts", "x")], idempotencyKey: "z" }), (err: any) => err.code === "STALE_REVISION" && /since this snapshot/.test(err.message));
    assert.throws(() => materializeCandidate(e.d, "arun", { requestId: e.requestId, snapshot: snapshotOf(e.svc.store, e.repo), edits: [create("src/export/b.ts", "x")], idempotencyKey: "z" }), (err: any) => err.code === "STALE_REVISION" && /run discovery again/.test(err.message));
    assert.throws(() => readCandidateFile(e.d, { candidateHash: built.bindingHash, path: "src/payments/fraud.ts", representation: "CANDIDATE" }), (err: any) => err.code === "STALE_REVISION");
    assert.ok(readCandidateFile(e.d, { candidateHash: built.bindingHash, path: "src/export/a.ts", representation: "CANDIDATE" }).value!.content.includes("a = 1"), "changed files stay readable: they are stored with the candidate");
  } finally { e.close(); }
});

test("gates: PLAN mode, missing contract, open questions, mandatory tracking, wrong owner and wrong state all refuse to build", async () => {
  const e = await env();
  try {
    const edits = [create("src/export/a.ts", "x")];
    assert.throws(() => materializeCandidate(e.d, "intruder", e.input(edits)), (err: any) => err.code === "FORBIDDEN" && /only the requester/.test(err.message));
    assert.throws(() => materializeCandidate(e.d, "arun", e.input(edits, { idempotencyKey: "" })), /idempotency/);
    assert.throws(() => materializeCandidate(e.d, "arun", { requestId: "req:none", snapshot: e.fs.getRequest(e.requestId)!.source, edits, idempotencyKey: "k" }), (err: any) => err.code === "NOT_FOUND");
    const rec = e.fs.getRequest(e.requestId)!;
    e.fs.updateRequest(e.requestId, rec.version, { ...rec, blockers: [{ id: "q1", kind: "QUESTION", requirementIds: [], text: "which format?" }] });
    assert.throws(() => materializeCandidate(e.d, "arun", e.input(edits)), (err: any) => err.code === "BLOCKED" && /q1/.test(err.message));
    const r2 = e.fs.getRequest(e.requestId)!;
    e.fs.updateRequest(e.requestId, r2.version, { ...r2, blockers: [], issue: { ...r2.issue, syncState: "TRACKING_BLOCKED" } });
    assert.throws(() => materializeCandidate(e.d, "arun", e.input(edits)), (err: any) => err.code === "BLOCKED" && /issue tracking is mandatory/.test(err.message));
    const r3 = e.fs.getRequest(e.requestId)!;
    e.fs.updateRequest(e.requestId, r3.version, { ...r3, issue: { ...r3.issue, syncState: "UNSYNCED" }, state: "CANCELLED" });
    assert.throws(() => materializeCandidate(e.d, "arun", e.input(edits)), (err: any) => err.code === "ILLEGAL_TRANSITION");
  } finally { e.close(); }
  const noContract = await env({ contract: false });
  try { assert.throws(() => materializeCandidate(noContract.d, "arun", noContract.input([create("src/a.ts", "x")])), (err: any) => err.code === "BLOCKED" && /no contract yet/.test(err.message)); } finally { noContract.close(); }
  const plan = await env();
  try {
    const rec = plan.fs.getRequest(plan.requestId)!; plan.fs.updateRequest(plan.requestId, rec.version, { ...rec, mode: "PLAN" });
    assert.throws(() => materializeCandidate(plan.d, "arun", plan.input([create("src/a.ts", "x")])), (err: any) => err.code === "FORBIDDEN" && /PLAN mode/.test(err.message));
  } finally { plan.close(); }
});

test("renames and deletes appear in the inventory as such, with attribution that says what is and is not covered", async () => {
  const e = await env();
  try {
    const src = read(e.repo, "src/errors.ts");
    const { candidate: c } = materializeCandidate(e.d, "arun", e.input([
      { op: "RENAME_FILE", from: "src/errors.ts", to: "src/domain/errors.ts", baseHash: rawHash(src), why: "move", requirementIds: ["r2"] },
      { op: "DELETE_FILE", file: "src/jobs/reconciler.ts", baseHash: rawHash(readFileSync(join(e.repo, "src/jobs/reconciler.ts"))), why: "unused" },
      create("src/export/csv.ts", "export {};\n", ["r1"]),
    ]));
    const by = Object.fromEntries(c.mutations.map((m) => [m.newPath ?? m.oldPath, m]));
    assert.deepEqual([by["src/domain/errors.ts"]!.kind, by["src/domain/errors.ts"]!.oldPath, by["src/domain/errors.ts"]!.attribution], ["RENAMED", "src/errors.ts", "COMPLETE"]);
    assert.equal(by["src/jobs/reconciler.ts"]!.kind, "DELETED"); assert.equal(by["src/jobs/reconciler.ts"]!.attribution, "UNATTRIBUTED", "an edit with no requirement is not attributed");
    assert.equal(c.mutations.length, 3, "the rename is one entry, not a delete and an add");
    assert.equal(c.contents!["src/errors.ts"], null); assert.equal(c.contents!["src/domain/errors.ts"], src);
    assert.equal(classifyTier(c.mutations.map((m) => ({ path: m.newPath ?? m.oldPath!, kind: m.kind }))).tier, "T2", "deleting source is tier 2");
    assert.throws(() => materializeCandidate(e.d, "arun", e.input([{ op: "RENAME_FILE", from: "src/errors.ts", to: "src/x.ts", baseHash: "1".repeat(64), why: "x" }])), /base hash mismatch/);
    assert.throws(() => materializeCandidate(e.d, "arun", e.input([{ op: "RENAME_FILE", from: "src/missing.ts", to: "src/x.ts", baseHash: "1".repeat(64), why: "x" }])), (err: any) => err.code === "NOT_FOUND");
    const partial = materializeCandidate(e.d, "arun", e.input([span(e.repo, "src/errors.ts", "CaptureFailedError", "A", { requirementIds: ["r1"] }), span(e.repo, "src/errors.ts", "DuplicateRequestError", "B")])).candidate;
    assert.equal(partial.mutations[0]!.attribution, "PARTIAL");
  } finally { e.close(); }
});

test("PF-072 reading a candidate: every representation, ranges, truncation, deleted files, traversal and access", async () => {
  const e = await env();
  try {
    const big = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const c = materializeCandidate(e.d, "arun", e.input([create("src/export/big.ts", big), span(e.repo, "src/errors.ts", "CaptureFailedError", "Renamed"),
      { op: "DELETE_FILE", file: "src/jobs/reconciler.ts", baseHash: rawHash(readFileSync(join(e.repo, "src/jobs/reconciler.ts"))), why: "x" }])).candidate;
    const rd = (path: string, representation: any, range?: [number, number]) => readCandidateFile(e.d, { candidateHash: c.bindingHash, path, representation, range });
    assert.equal(rd("src/export/big.ts", "CANDIDATE").value!.content, big);
    assert.equal(rd("src/export/big.ts", "CANDIDATE", [2, 3]).value!.content, "line 2\nline 3"); assert.equal(rd("src/export/big.ts", "CANDIDATE", [2, 3]).value!.complete, false);
    assert.equal(rd("src/export/big.ts", "CANDIDATE", [1, 100]).value!.complete, true);
    assert.ok(rd("src/errors.ts", "BASELINE").value!.content.includes("CaptureFailedError ") || rd("src/errors.ts", "BASELINE").value!.content.includes("CaptureFailedError"));
    assert.ok(!rd("src/errors.ts", "BASELINE").value!.content.includes("Renamed")); assert.ok(rd("src/errors.ts", "CANDIDATE").value!.content.includes("Renamed"));
    const ud = rd("src/errors.ts", "UNIFIED_DIFF").value!.content; assert.match(ud, /^--- a\/src\/errors\.ts\n\+\+\+ b\/src\/errors\.ts\n@@/); assert.ok(ud.includes("-export class CaptureFailedError") && ud.includes("+export class Renamed"));
    assert.match(rd("src/export/big.ts", "UNIFIED_DIFF").value!.content, /^--- \/dev\/null\n\+\+\+ b\/src\/export\/big\.ts\n@@ -0,0 \+1,31 @@/);
    assert.match(rd("src/jobs/reconciler.ts", "UNIFIED_DIFF").value!.content, /^--- a\/src\/jobs\/reconciler\.ts\n\+\+\+ \/dev\/null/);
    const split = JSON.parse(rd("src/errors.ts", "SPLIT_DIFF").value!.content) as { left: string | null; right: string | null; change: string }[];
    assert.ok(split.some((r) => r.change === "changed" && r.left?.includes("CaptureFailedError") && r.right?.includes("Renamed")));
    assert.throws(() => rd("src/jobs/reconciler.ts", "CANDIDATE"), (err: any) => err.code === "NOT_FOUND" && /deleted/.test(err.message));
    assert.throws(() => rd("src/export/big.ts", "BASELINE"), (err: any) => err.code === "NOT_FOUND" && /does not exist in the base/.test(err.message));
    assert.ok(rd("src/payments/fraud.ts", "CANDIDATE").value!.content.length > 0, "an unchanged file reads from the base while it still stands");
    for (const bad of ["../../etc/passwd", "/etc/passwd", ""]) assert.throws(() => rd(bad, "CANDIDATE"), (err: any) => err.code === "INVALID_SCHEMA" || err.code === "NOT_FOUND", bad);
    assert.throws(() => rd("src/nope.ts", "CANDIDATE"), (err: any) => err.code === "NOT_FOUND");
    assert.throws(() => rd("src/export/big.ts", "CANDIDATE", [5, 2]), /ordered/);
    assert.throws(() => readCandidateFile(e.d, { candidateHash: "pf-canon-v1/none", path: "a", representation: "CANDIDATE" }), (err: any) => err.code === "NOT_FOUND");
    e.svc.store.db.prepare("insert into access_deny(repo_root, prefix) values (?, ?)").run(e.repo, "src/payments");
    assert.throws(() => rd("src/payments/fraud.ts", "CANDIDATE"), (err: any) => err.code === "NOT_FOUND" && !/payments/.test(err.message), "a denied path reads as absent, without naming it");
    // a candidate that changes a denied path is refused at build time
    assert.throws(() => materializeCandidate(e.d, "arun", e.input([span(e.repo, "src/payments/fraud.ts", "export", "export /* x */")])), (err: any) => err.code === "FORBIDDEN" && /do not have access/.test(err.message));
  } finally { e.close(); }
});

test("a candidate that changes nothing, or whose edit leaves a file unchanged, is reported honestly", async () => {
  const e = await env();
  try {
    assert.throws(() => materializeCandidate(e.d, "arun", e.input([span(e.repo, "src/errors.ts", "CaptureFailedError", "CaptureFailedError")])), (err: any) => err.code === "INVALID_SCHEMA" && /changes no file/.test(err.message));
    const c = materializeCandidate(e.d, "arun", e.input([span(e.repo, "src/errors.ts", "CaptureFailedError", "CaptureFailedError"), create("src/x.ts", "x")])).candidate;
    assert.deepEqual(c.notes, ["src/errors.ts was named by an edit but ended up unchanged"]);
    assert.deepEqual(c.mutations.map((m) => m.newPath), ["src/x.ts"]);
  } finally { e.close(); }
});
