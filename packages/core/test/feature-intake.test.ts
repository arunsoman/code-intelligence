import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rawHash } from "../src/feature/canon.ts";
import { DEFAULT_CONFIG } from "../src/feature/config.ts";
import { discover, detectStacks, readPackage } from "../src/feature/discovery.ts";
import { classifyPlan, discoverFeatureContext, resolveOutcomeMode, snapshotOf, submitFeature, type IntakeDeps } from "../src/feature/intake.ts";
import { redactText, redactedPreview } from "../src/feature/redact.ts";
import { SqliteFeatureStore } from "../src/feature/store.ts";
import { demoRepo, setup } from "./helpers.ts";

async function env(repo = demoRepo()) {
  const { svc, worker } = await setup(undefined, repo);
  const deps: IntakeDeps = { fs: new SqliteFeatureStore(svc.store), store: svc.store, config: () => ({ ...DEFAULT_CONFIG }) };
  return { svc, worker, repo, deps, close: () => worker.close() };
}
const base = (repo: string, over: Record<string, unknown> = {}) => ({ inputRefs: [], text: "Add CSV export to transactions", repositoryId: repo, mode: "PLAN" as const, idempotencyKey: "k1", ...over });

test("PF-001 submit records a request bound to the repository snapshot, with the prompt kept and a redacted preview", async () => {
  const { deps, repo, close } = await env();
  try {
    const r = submitFeature(deps, "arun", base(repo, { text: "Add CSV export. Use token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 and mail bob@example.com" }));
    assert.equal(r.state, "RECEIVED"); assert.equal(r.replayed, false); assert.equal(r.mode, "PLAN");
    const rec = deps.fs.getRequest(r.requestId)!;
    assert.match(rec.source.contentRootHash, /^pf-canon-v1\/pf\.contentRoot@1:[0-9a-f]{64}$/);
    assert.match(rec.source.commitHash, /^[0-9a-f]{40}$/); assert.equal(rec.source.repositoryId, repo);
    assert.ok(rec.promptRef.text!.includes("ghp_"), "the owner's copy is complete");
    assert.ok(!/ghp_|bob@example/.test(rec.promptRef.redactedPreview), rec.promptRef.redactedPreview);
    assert.equal(deps.fs.listEvents(r.requestId)[0]!.type, "FeatureSubmitted");
    assert.ok(!JSON.stringify(deps.fs.listEvents(r.requestId)).includes("ghp_"), "events never carry the prompt");
  } finally { close(); }
});

test("PF-002 idempotent: same key and prompt replays; same key with a different prompt or repository is a conflict", async () => {
  const { deps, repo, close } = await env();
  try {
    const a = submitFeature(deps, "arun", base(repo)), b = submitFeature(deps, "arun", base(repo));
    assert.equal(a.requestId, b.requestId); assert.equal(b.replayed, true);
    assert.throws(() => submitFeature(deps, "arun", base(repo, { text: "something else" })), (e: any) => e.code === "IDEMPOTENCY_CONFLICT");
    assert.notEqual(submitFeature(deps, "someone-else", base(repo)).requestId, a.requestId, "keys are per requester");
    assert.equal(deps.fs.listRequests(repo).length, 2);
  } finally { close(); }
});

test("input validation: empty, oversized, bad mode, missing key, unindexed repository, bad references", async () => {
  const { deps, repo, close } = await env();
  try {
    const bad = (over: Record<string, unknown>, code: string, re: RegExp) => assert.throws(() => submitFeature(deps, "u", base(repo, { idempotencyKey: `k-${Math.random()}`, ...over })), (e: any) => e.code === code && re.test(e.message), JSON.stringify(over).slice(0, 60));
    bad({ text: "   \u0007  " }, "INVALID_SCHEMA", /describe/); bad({ text: "x".repeat(50_001) }, "INVALID_SCHEMA", /longer than/);
    bad({ mode: "DEPLOY" }, "INVALID_SCHEMA", /mode must/); bad({ idempotencyKey: "" }, "INVALID_SCHEMA", /idempotency/);
    bad({ repositoryId: "/nowhere" }, "NOT_FOUND", /not indexed/); bad({ budget: { modelTokens: 0, wallMs: 5 } }, "INVALID_SCHEMA", /budgets/);
    const h = rawHash("x");
    bad({ inputRefs: [{ artifactId: "a", version: "1", locator: "repo:src/errors.ts", contentHash: "short" }] }, "INVALID_SCHEMA", /64-hex/);
    bad({ inputRefs: [{ artifactId: "a", version: "1", locator: "repo:../../etc/passwd", contentHash: h }] }, "INVALID_SCHEMA", /unsafe/);
    bad({ inputRefs: [{ artifactId: "a", version: "1", locator: "repo:/etc/passwd", contentHash: h }] }, "INVALID_SCHEMA", /unsafe/);
    bad({ inputRefs: [{ artifactId: "a", version: "1", locator: "repo:src/missing.ts", contentHash: h }] }, "NOT_FOUND", /does not exist/);
    bad({ inputRefs: [{ artifactId: "a", version: "1", locator: "repo:src/errors.ts", contentHash: h }] }, "STALE_REVISION", /changed since/);
    const ok = { artifactId: "a", version: "1", locator: "repo:src/errors.ts", contentHash: rawHash(execFileSync("cat", [join(repo, "src/errors.ts")])) };
    bad({ inputRefs: [ok, ok] }, "INVALID_SCHEMA", /duplicate/);
    const r = submitFeature(deps, "u", base(repo, { idempotencyKey: "good", inputRefs: [ok, { artifactId: "ext", version: "1", locator: "https://example.com/spec", contentHash: h }] }));
    assert.equal(r.warnings!.length, 1); assert.match(r.warnings![0]!, /cannot be verified/);
    assert.equal(deps.fs.listRequests(repo).length, 1, "nothing was stored for the rejected submissions");
  } finally { close(); }
});

test("S13/PF-043 tracking and mode: draft PR needs a git remote else it is lowered with the reason; mandatory tracking blocks mutation, not reading", async () => {
  const { deps, repo, close } = await env();
  try {
    assert.deepEqual(resolveOutcomeMode(repo, "PLAN"), { mode: "PLAN" });
    const lowered = resolveOutcomeMode(repo, "CREATE_DRAFT_PR");
    assert.equal(lowered.mode, "BUILD_PREVIEW"); assert.match(lowered.downgradedBecause!, /no git remote/);
    const r = submitFeature(deps, "u", base(repo, { mode: "CREATE_DRAFT_PR", idempotencyKey: "pr" }));
    assert.equal(r.mode, "BUILD_PREVIEW"); assert.ok(r.warnings!.some((w) => /no git remote/.test(w)));
    assert.match(deps.fs.listEvents(r.requestId)[0]!.rationale, /lowered from CREATE_DRAFT_PR/);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://example.com/x.git"]);
    const pr = submitFeature(deps, "u", base(repo, { mode: "CREATE_DRAFT_PR", idempotencyKey: "pr2" }));
    assert.equal(pr.mode, "CREATE_DRAFT_PR");
    assert.equal(deps.fs.getRequest(pr.requestId)!.issue.syncState, "TRACKING_BLOCKED");
    assert.equal(deps.fs.getRequest(pr.requestId)!.blockers.length, 0, "planning and reading are not blocked by tracking");
    assert.equal(deps.fs.getRequest(r.requestId)!.issue.syncState, "UNBOUND");
    const off = submitFeature({ ...deps, config: () => ({ ...DEFAULT_CONFIG, tracking: { BUILD_PREVIEW: "OFFLINE_UNSYNCED" } }) }, "u", base(repo, { mode: "BUILD_PREVIEW", idempotencyKey: "off" }));
    assert.equal(deps.fs.getRequest(off.requestId)!.issue.syncState, "UNSYNCED");
    assert.throws(() => submitFeature({ ...deps, config: () => { throw new Error("egress must be LOCAL_ONLY or CLOUD_ALLOWED"); } }, "u", base(repo, { idempotencyKey: "cfg" })), /configuration is invalid/);
  } finally { close(); }
});

test("AT-01/PF-004 discovery produces a coverage record for every domain and moves the request on", async () => {
  const { deps, repo, close } = await env();
  try {
    const r = submitFeature(deps, "u", base(repo));
    const rec = deps.fs.getRequest(r.requestId)!;
    const out = discoverFeatureContext(deps, "u", { requestId: r.requestId, snapshot: rec.source, retrievalBudget: { tokens: 8000, files: 5000 } });
    assert.ok(out.status === "COMPLETE" || out.status === "PARTIAL"); const a = out.value!;
    assert.deepEqual(a.coverage.map((c) => c.domain).sort(), ["API_CONVENTIONS", "BUILD", "DATA_ACCESS", "INTEGRATIONS", "LANGUAGES", "MIGRATIONS", "OBSERVABILITY", "PERMISSIONS", "STARTUP", "TENANCY", "TESTS", "UI", "WORKERS"]);
    for (const c of a.coverage) { assert.ok(c.searchedRoots.length && c.tools.length && c.excluded.length, c.domain); assert.ok(c.found === "FOUND" || c.found === "NOT_FOUND_WITHIN_SEARCHED_SCOPE"); if (c.found === "FOUND") assert.ok(c.artifacts.length, c.domain); }
    const lang = a.coverage.find((c) => c.domain === "LANGUAGES")!; assert.ok(lang.artifacts.some((x) => x.startsWith("ts:")));
    assert.ok(a.coverage.find((c) => c.domain === "TESTS")!.artifacts.some((x) => /payment-service\.test\.ts/.test(x)));
    assert.ok(a.relatedEntities!.length > 0 && a.relatedEntities!.every((e) => e.id && e.file), "indexed entities matching the request words are listed");
    const after = deps.fs.getRequest(r.requestId)!;
    assert.equal(after.state, "CONTRACTING"); assert.equal(after.assessment!.id, a.id);
    assert.ok(deps.fs.listEvents(r.requestId).some((e) => /discovery (finished|finished with gaps)/.test(e.rationale)));
    // the same snapshot discovers to the same identity
    const again = discoverFeatureContext(deps, "u", { requestId: r.requestId, snapshot: after.source, retrievalBudget: { tokens: 8000, files: 5000 } });
    assert.equal(again.value!.id, a.id);
    assert.equal(deps.fs.getRequest(r.requestId)!.state, "CONTRACTING");
  } finally { close(); }
});

test("the demo repo (no package.json) is a supported TypeScript/Node stack that tests with node --test, and the plan's npm-test assumption is recorded", async () => {
  const { deps, repo, close } = await env();
  try {
    const r = submitFeature(deps, "u", base(repo, { mode: "BUILD_PREVIEW" }));
    const out = discoverFeatureContext(deps, "u", { requestId: r.requestId, snapshot: deps.fs.getRequest(r.requestId)!.source, retrievalBudget: { tokens: 8000, files: 5000 } });
    const s = out.value!.supportMatrix.find((x) => x.stack === "typescript-node-npm")!;
    assert.ok(s.supported, JSON.stringify(out.value!.supportMatrix));
    assert.ok(out.value!.conventions.some((c) => /node --test/.test(c)));
    assert.equal(deps.fs.getRequest(r.requestId)!.blockers.length, 0);
  } finally { close(); }
});

test("AT-33 unsupported stacks are reported with a concrete reason: a build mode is blocked with it, a plan is not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pf-rust-")); mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "Cargo.toml"), '[package]\nname="x"\n'); writeFileSync(join(dir, "src", "main.rs"), "fn main(){}\n");
  const { deps, repo, close } = await env(dir);
  try {
    const build = submitFeature(deps, "u", base(repo, { mode: "BUILD_PREVIEW", idempotencyKey: "b" }));
    const o = discoverFeatureContext(deps, "u", { requestId: build.requestId, snapshot: deps.fs.getRequest(build.requestId)!.source, retrievalBudget: { tokens: 1000, files: 1000 } });
    assert.deepEqual(o.value!.supportMatrix.map((s) => [s.stack, s.supported]), [["rust-cargo", false]]);
    assert.match(o.value!.supportMatrix[0]!.reason!, /outside slice 1/);
    assert.equal(o.value!.coverage.find((c) => c.domain === "TESTS")!.state, "UNSUPPORTED");
    assert.match(deps.fs.getRequest(build.requestId)!.blockers[0]!.text, /Building is not supported.*rust-cargo/);
    const plan = submitFeature(deps, "u", base(repo, { mode: "PLAN", idempotencyKey: "p" }));
    discoverFeatureContext(deps, "u", { requestId: plan.requestId, snapshot: deps.fs.getRequest(plan.requestId)!.source, retrievalBudget: { tokens: 1000, files: 1000 } });
    assert.equal(deps.fs.getRequest(plan.requestId)!.blockers.length, 0, "a plan does not need a buildable stack");
  } finally { close(); }
});

test("discovery refuses a stale snapshot, a non-owner, bad budgets and a request in the wrong state", async () => {
  const { deps, repo, close } = await env();
  try {
    const r = submitFeature(deps, "u", base(repo));
    const snap = deps.fs.getRequest(r.requestId)!.source;
    const budget = { tokens: 1000, files: 1000 };
    assert.throws(() => discoverFeatureContext(deps, "intruder", { requestId: r.requestId, snapshot: snap, retrievalBudget: budget }), (e: any) => e.code === "FORBIDDEN");
    assert.throws(() => discoverFeatureContext(deps, "u", { requestId: r.requestId, snapshot: snap, retrievalBudget: { tokens: 0, files: 1 } }), /positive/);
    assert.throws(() => discoverFeatureContext(deps, "u", { requestId: r.requestId, snapshot: { ...snap, repositoryId: "/other" }, retrievalBudget: budget }), /different repository/);
    assert.throws(() => discoverFeatureContext(deps, "u", { requestId: "req:none", snapshot: snap, retrievalBudget: budget }), (e: any) => e.code === "NOT_FOUND");
    writeFileSync(join(repo, "src", "new-file.ts"), "export const x = 1;\n");
    const stale = discoverFeatureContext(deps, "u", { requestId: r.requestId, snapshot: snap, retrievalBudget: budget });
    assert.equal(stale.status, "STALE"); assert.match(stale.diagnostics[0]!, /changed since this snapshot/);
    assert.equal(deps.fs.getRequest(r.requestId)!.state, "RECEIVED", "a stale attempt changes nothing");
    deps.fs.updateRequest(r.requestId, 0, { ...deps.fs.getRequest(r.requestId)!, state: "CANCELLED" });
    assert.throws(() => discoverFeatureContext(deps, "u", { requestId: r.requestId, snapshot: snapshotOf(deps.store, repo), retrievalBudget: budget }), (e: any) => e.code === "ILLEGAL_TRANSITION");
  } finally { close(); }
});

test("PF-043 a truncated walk is PARTIAL with the unsearched remainder stated, never COMPLETE", async () => {
  const { deps, repo, close } = await env();
  try {
    const snapshot = snapshotOf(deps.store, repo);
    const a = discover({ store: deps.store, repoRoot: repo, snapshot, supportedStacks: ["typescript-node-npm"], requestText: "export", budget: { files: 3, tokens: 100 } });
    assert.ok(a.coverage.every((c) => c.state === "PARTIAL" || c.state === "UNSUPPORTED"), JSON.stringify(a.coverage.map((c) => c.state)));
    assert.ok(a.coverage.every((c) => c.unresolved.some((u) => /stopped after 3 files/.test(u))));
    assert.ok(a.uncovered.length >= 11);
    const missing = discover({ store: deps.store, repoRoot: join(repo, "does-not-exist"), snapshot, supportedStacks: [], requestText: "", budget: { files: 10, tokens: 10 } });
    assert.ok(missing.coverage.every((c) => c.state === "FAILED" && c.found === "NOT_FOUND_WITHIN_SEARCHED_SCOPE" && /could not be read/.test(c.unresolved[0]!)), "an unreadable root is a failure, not an empty repository");
  } finally { close(); }
});

test("access: denied paths are left out of coverage and entities, counted in the gap, and never named", async () => {
  const { svc, deps, repo, close } = await env();
  try {
    const run = () => discover({ store: deps.store, repoRoot: repo, snapshot: snapshotOf(deps.store, repo), supportedStacks: ["typescript-node-npm"], requestText: "payment ledger refund", budget: { files: 5000, tokens: 100 } });
    const open = run();
    assert.ok(open.coverage.find((c) => c.domain === "PERMISSIONS")!.artifacts.some((a) => a.startsWith("src/payments/")), "src/payments is visible before the restriction");
    assert.ok(open.relatedEntities!.some((e) => e.file.startsWith("src/refunds/")), "refund entities are visible before the restriction");
    assert.ok(!open.uncovered.length || !open.coverage.some((c) => c.unresolved.some((u) => /access policy/.test(u))));
    svc.store.db.prepare("insert into access_deny(repo_root, prefix) values (?, ?)").run(repo, "src/payments");
    svc.store.db.prepare("insert into access_deny(repo_root, prefix) values (?, ?)").run(repo, "src/refunds");
    const closed = run();
    const text = JSON.stringify(closed);
    assert.ok(!text.includes("src/payments") && !text.includes("src/refunds") && !/gateway-client|refund-worker/.test(text), "no artifact, entity or message names a denied path");
    assert.ok(closed.relatedEntities!.every((e) => !e.file.startsWith("src/refunds")));
    assert.ok(closed.coverage.every((c) => c.unresolved.some((u) => /\d+ path\(s\) were left out by access policy/.test(u))));
    assert.ok(closed.coverage.every((c) => c.state === "COMPLETE_WITHIN_SCOPE" || c.state === "UNSUPPORTED"));
  } finally { close(); }
});

test("S17 stack detection: npm test script, bare node tests, invalid manifest, and unknown", () => {
  const sup = ["typescript-node-npm"];
  const pkg = (scripts: Record<string, string> = {}, present = true) => ({ present, scripts, deps: new Set<string>() });
  assert.equal(detectStacks("/x", ["src/a.ts"], pkg({ test: "node --test" }), sup)[0]!.testCommand, "npm test");
  assert.equal(detectStacks("/x", ["src/a.ts", "t/a.test.ts"], pkg({}, false), sup)[0]!.testCommand, "node --test (no package.json test script)");
  const none = detectStacks("/x", ["src/a.ts"], pkg(), sup)[0]!; assert.ok(!none.supported); assert.match(none.reason!, /nothing can validate/);
  assert.deepEqual(detectStacks("/x", ["README.md"], pkg({}, false), sup).map((s) => s.stack), ["unknown"]);
  assert.ok(!detectStacks("/x", ["a.ts", "a.test.ts"], pkg({}, false), []).at(0)!.supported, "disabled in configuration");
  const dir = mkdtempSync(join(tmpdir(), "pf-pkg-")); writeFileSync(join(dir, "package.json"), "{ not json");
  assert.match(readPackage(dir).invalid!, /./);
  assert.match(detectStacks(dir, ["a.ts", "a.test.ts"], readPackage(dir), sup)[0]!.reason!, /not valid JSON/);
});

test("classifyPlan records the tier once and never from prompt text", async () => {
  const { deps, repo, close } = await env();
  try {
    const r = submitFeature(deps, "u", base(repo, { text: "this touches auth and the database schema" }));
    assert.equal(deps.fs.getRequest(r.requestId)!.tier, undefined);
    assert.equal(classifyPlan(deps, "u", r.requestId, [{ path: "docs/guide.md", kind: "MODIFIED" }]).tier, "T0");
    assert.equal(deps.fs.getRequest(r.requestId)!.tier, "T0");
    assert.equal(classifyPlan(deps, "u", r.requestId, [{ path: "src/export/csv.ts", kind: "ADDED" }, { path: "package.json", kind: "MODIFIED" }]).tier, "T2");
    assert.equal(deps.fs.getRequest(r.requestId)!.tier, "T2");
    const n = deps.fs.listEvents(r.requestId).length; classifyPlan(deps, "u", r.requestId, [{ path: "package.json", kind: "MODIFIED" }]);
    assert.equal(deps.fs.listEvents(r.requestId).length, n, "an unchanged tier writes nothing");
  } finally { close(); }
});

test("AT-35/44 the private-prompt redaction masks secrets, personal data and opaque blobs before a preview can leave", () => {
  const dirty = "password: hunter2 AKIAABCDEFGHIJKLMNOP sk-live_abcdefghijklmnop1234 Bearer abcdefghijklmnop.qrstuv eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4 4111 1111 1111 1111 alice@corp.example " + "a".repeat(64) + " -----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
  const clean = redactText(dirty);
  for (const leak of ["hunter2", "AKIAABCD", "sk-live", "abcdefghijklmnop.qrstuv", "eyJhbGci", "4111", "alice@corp", "MIIabc"]) assert.ok(!clean.includes(leak), `${leak} leaked: ${clean}`);
  assert.ok(redactedPreview("x ".repeat(200)).length <= 120);
  assert.equal(redactedPreview("a‮b\nc"), "a b c");
  assert.equal(redactedPreview("Add CSV export to transactions"), "Add CSV export to transactions", "ordinary text is untouched");
});

test("the tool's own state directory never moves the content root, but source and configuration do", async () => {
  const { deps, repo, close } = await env();
  try {
    const a = snapshotOf(deps.store, repo).contentRootHash;
    mkdirSync(join(repo, ".cie"), { recursive: true }); writeFileSync(join(repo, ".cie", "cie.db"), "x".repeat(100));
    assert.equal(snapshotOf(deps.store, repo).contentRootHash, a, "a local database inside the repository must not make every snapshot stale");
    writeFileSync(join(repo, "tsconfig.json"), "{}\n");
    assert.notEqual(snapshotOf(deps.store, repo).contentRootHash, a, "configuration is part of the identity");
  } finally { close(); }
});
