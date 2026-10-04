/**
 * F02 — engine-level flow tests (acceptance A1–A6, D3, D4, D7, D8, D9).
 * Real git fixtures + the real worker (parser) through the service's own `indexRevision` adapter + a fake GitHub
 * write transport, so no publication ever leaves the machine. Webhook intake runs through the service exactly as
 * production does (HMAC verify + delivery dedupe + job), and each analysis runs inside a real job.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PrAnalysis, isUnsafePath, type IndexCall } from "../src/pr-analysis.ts";
import { GitHubCheckPublisher, newGrant, type GitHubTransport } from "../src/pr-publish.ts";
import { setup, ctx } from "./helpers.ts";
import type { GatePolicyBody, PrAnalysisView } from "@cie/schema";

const RUNDIR = mkdtempSync(join(tmpdir(), "cie-pr-flow-"));
const ORIGIN = "git@github.com:acme/payments.git";
const MARKER = "<!-- cie-gate:pr-comment -->";
type Svc = Awaited<ReturnType<typeof setup>>["svc"];
const SHARED: { svc: Svc | null } = { svc: null };
const svcOf = (): Svc => { assert.ok(SHARED.svc, "the shared service must be up before the flow tests run"); return SHARED.svc!; };

// ---------------------------------------------------------------- git fixtures

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
function commitAll(root: string, msg: string): string {
  git(root, "add", "-A");
  git(root, "-c", "user.name=cie", "-c", "user.email=cie@test", "commit", "-q", "-m", msg);
  return git(root, "rev-parse", "HEAD").trim();
}
function readRel(root: string, rel: string): string {
  try { return readFileSync(join(root, rel), "utf8"); } catch { return ""; }
}
function appendFile(root: string, rel: string, text: string): string {
  writeFileSync(join(root, rel), `${readRel(root, rel)}${text}`);
  return commitAll(root, "nudge");
}

/**
 * The fixture repository. With `withBaseFinding`, `notifyUser` already logs a password on main, so a branch that
 * moves that file must NOT be judged "introduced" (A3); the branch then also plants a NEW secret log (chargeCard).
 */
function makeRepo(withBaseFinding: boolean): { root: string } {
  const root = join(RUNDIR, `repo-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", ORIGIN);
  const mail = withBaseFinding
    ? "type User = { email: string | null; password?: string };\n\nexport function notifyUser(u: User): void {\n  log.info(\"welcome password\", u.password);\n}\n"
    : "type User = { email: string | null; password?: string };\n\nexport function notifyUser(u: User): void {\n  log.info(\"welcome note\", u.email);\n}\n";
  writeFileSync(join(root, "src", "refunds.ts"), "export function computeRefund(cents: number): number {\n  return Math.round(cents * 0.98);\n}\n");
  writeFileSync(join(root, "src", "mail.ts"), mail);
  const seeded = commitAll(root, "seed");
  git(root, "update-ref", "refs/remotes/origin/main", seeded);
  return { root };
}

/** The standard PR: move mail.ts→notify.ts (same content), rename the refund function, plant a NEW high finding. */
function prMoveAndPlant(root: string, branch: string): string {
  git(root, "checkout", "-q", "-b", branch, "main");
  git(root, "mv", "src/mail.ts", "src/notify.ts");
  writeFileSync(join(root, "src", "refunds.ts"), "export function computeRefundAmount(cents: number): number {\n  return Math.round(cents * 0.97);\n}\n");
  writeFileSync(join(root, "src", "notify.ts"), `${readRel(root, "src/notify.ts")}\nexport function chargeCard(u: User, cents: number): number {\n  log.info("card charge", u.password);\n  return cents;\n}\n`);
  return commitAll(root, branch);
}

/** A PR whose only new finding lives under a path others cannot see (D9). */
function prPlantDenied(root: string, branch: string): string {
  git(root, "checkout", "-q", "-b", branch, "main");
  mkdirSync(join(root, "src", "generated"), { recursive: true });
  writeFileSync(join(root, "src", "generated", "secret.ts"), "export function debugDump(u: { password?: string }): void {\n  log.info(\"dump password\", u.password);\n}\n");
  return commitAll(root, branch);
}

/** A PR carrying a policy document in the tree (D3: it must be ignored as data). */
function prWithPolicyDoc(root: string, branch: string): string {
  git(root, "checkout", "-q", "-b", branch, "main");
  git(root, "mv", "src/mail.ts", "src/notify.ts");
  writeFileSync(join(root, "src", "notify.ts"), `${readRel(root, "src/notify.ts")}\nexport function chargeCard(u: User, cents: number): number {\n  log.info("card charge", u.password);\n  return cents;\n}\n`);
  mkdirSync(join(root, "gate-policies"), { recursive: true });
  writeFileSync(join(root, "gate-policies", "quality.json"), JSON.stringify({ policyId: "p-carried", version: 99, conditions: [] }));
  return commitAll(root, branch);
}

/** A PR adding executable lines to src/refunds.ts and nothing else (D4 coverage evidence, no new findings). */
function prCoverageLines(root: string, branch: string): string {
  git(root, "checkout", "-q", "-b", branch, "main");
  writeFileSync(join(root, "src", "refunds.ts"), `${readRel(root, "src/refunds.ts")}\nexport function surcharge(cents: number): number {\n  const adjusted = cents + 5;\n  const capped = Math.min(adjusted, 10000);\n  return capped;\n}\n`);
  return commitAll(root, branch);
}

function policyOf(id: string, conds: Record<string, unknown>[]): GatePolicyBody {
  return { policyId: id, version: 1, conditions: conds } as unknown as GatePolicyBody;
}
const NEW_FINDINGS = { id: "no-new-password", type: "NEW_FINDINGS", severity: ["high"] };
const REQUIRED = { id: "analyzers", type: "REQUIRED_ANALYZERS", analyzers: ["security-rules@1", "defect-detectors@1", "test-artifacts@1"] };
const TESTS = { id: "tests-preserved", type: "TESTS_NOT_LOST" };
const COVERAGE = { id: "coverage", type: "COVERAGE_ON_CHANGED_LINES", minimumPercent: 80, minimumExecutableLines: 5, blocking: false };
const JUNIT = `<testsuites><testsuite name="src"><testcase name="refunds works"/><testcase name="notify renders"/></testsuite></testsuites>`;
const LCOV_COVERED = "TN:\nSF:src/refunds.ts\nDA:1,1\nDA:2,1\nDA:3,1\nDA:4,1\nDA:5,1\nDA:6,1\nDA:7,1\nDA:8,1\nLF:8\nLH:8\nend_of_record\n";

// ---------------------------------------------------------------- fake GitHub (hermetic)

function fakeForge() {
  const state = { heads: new Map<number, string | undefined>(), vis: "private" as "public" | "private" };
  const statuses = new Map<string, { state: string; description: string; context: string }[]>();
  const comments = new Map<number, { id: string; body: string }[]>();
  const t: GitHubTransport = {
    resolvePrHead: async (prNumber) => state.heads.get(prNumber) ?? null,
    visibility: async () => state.vis,
    publishStatus: async (sha, s) => {
      const list = statuses.get(sha) ?? [];
      list.push({ state: s.state, description: s.description, context: s.context });
      statuses.set(sha, list);
      return { id: `st-${sha.slice(0, 6)}-${list.length}`, url: `http://statuses/${list.length}` };
    },
    findStatus: async (sha, context) => {
      for (const s of [...(statuses.get(sha) ?? [])].reverse()) if (s.context === context) return { id: "prior", state: s.state, description: s.description };
      return null;
    },
    findComment: async (prNumber, marker) => (comments.get(prNumber) ?? []).find((c) => c.body.includes(marker)) ?? null,
    postComment: async (prNumber, body) => {
      const list = comments.get(prNumber) ?? [];
      const id = `c-${prNumber}-${list.length + 1}`;
      list.push({ id, body });
      comments.set(prNumber, list);
      return { id };
    },
    updateComment: async (commentId, body) => {
      for (const list of comments.values()) { const hit = list.find((c) => c.id === commentId); if (hit) hit.body = body; }
      return { id: commentId };
    },
  };
  return { t, state, statuses, comments };
}

// ---------------------------------------------------------------- helpers over the engine and store

/** Hermetic pending publications: the service's own publisher never reaches real GitHub in these tests. */
function attachFakePending(svc: Svc, forge: ReturnType<typeof fakeForge>): void {
  const pub = svc.prPublisher as unknown as { transportFor: (root: string) => GitHubTransport };
  Object.defineProperty(pub, "transportFor", { value: () => forge.t, configurable: true });
}
/** The service's real worker, wrapped as the engine's indexer — the same adapter production wiring uses. */
const serviceAdapter = (svc: Svc): IndexCall => async (repoPath, control) => {
  const r = await svc.ingestRepository(ctx(), { repoPath }, control);
  if (!r.ok) throw new Error(r.error.message);
  return { id: r.value.id, repoRoot: r.value.repoRoot };
};
const publisherFor = (svc: Svc, forge: ReturnType<typeof fakeForge>, context = "cie/gate") =>
  new GitHubCheckPublisher(svc.store, svc.pr, { transportFor: () => forge.t, context });
async function publishSafe(pub: GitHubCheckPublisher, req: Parameters<GitHubCheckPublisher["publish"]>[1]) {
  const grant = newGrant(svcOf().store, { repositoryId: req.repositoryId, headHash: req.headHash ?? "", principalId: "test" });
  return pub.publish(grant.id, req);
}
/** Run an analysis directly against the engine, with the service's real worker as the revision indexer. */
async function runAnalysis(pr: PrAnalysis, svc: Svc, repoRoot: string, prNumber: number, opts: { branch: string; policyId?: string; adapter?: IndexCall }): Promise<PrAnalysisView> {
  const adapter: IndexCall = opts.adapter ?? (async (repoPath, control) => {
    const r = await svc.ingestRepository(ctx(), { repoPath }, control);
    if (!r.ok) throw new Error(r.error.message);
    return { id: r.value.id, repoRoot: r.value.repoRoot };
  });
  return pr.run({ actor: "test" }, undefined, {
    repoRoot, forge: "github", prNumber, headRef: opts.branch, baseRef: "main",
    ...(opts.policyId ? { policyId: opts.policyId } : {}),
  });
}
const decisionJson = (pr: PrAnalysis, analysisId: string): any => {
  const row = pr.lastDecisionRow(analysisId);
  assert.ok(row, `analysis ${analysisId} holds no decision`);
  return JSON.parse(row.json);
};
const pubRow = (svc: Svc) => svc.store.db.prepare("select * from check_publications order by rowid desc limit 1").get() as any;

// ---------------------------------------------------------------- the setup test

test("F02 setup: the worker binary exists, the shared service boots, pending publications stay hermetic", async () => {
  assert.ok(existsSync(join(process.cwd(), "..", "..", "target", "release", "worker"))
    || existsSync(join(process.cwd(), "target", "release", "worker"))
    || process.env.CIE_WORKER_BIN, "build the worker first: cargo build --release (worker binary not found)");
  const s = await setup();
  SHARED.svc = s.svc;
  attachFakePending(s.svc, fakeForge());
  assert.ok(s.svc.pr, "the service carries the F02 PR engine");
});

// ---------------------------------------------------------------- A5 + boundary + identity stability

test("F02 (A5 + boundary): one PR run produces all four conditions with evidence; a repeat resolves to the same identity", async () => {
  const svc = svcOf();
  const pr = svc.pr;
  const P = policyOf("p-a5", [NEW_FINDINGS, REQUIRED, TESTS, COVERAGE]);
  assert.ok(pr.putPolicy(P, "test").ok);
  const repo = makeRepo(true);
  git(repo.root, "update-ref", "refs/pull/1/head", prMoveAndPlant(repo.root, "pr1"));
  pr.setRepositoryPolicy(repo.root, "p-a5");
  const job = await svc.prOps["C23/analyzePullRequest"](ctx(), { repoPath: repo.root, prNumber: 1, forge: "github" });
  assert.ok(job.ok, "the op accepts the request");
  const settled = await svc.jobs.settled(((job as { value: { id: string } }).value).id);
  assert.equal(settled.state, "SUCCEEDED", `the analysis job must succeed: ${settled.message ?? ""} ${settled.error ?? ""}`);
  const analysisId = pr.latestForPr(repo.root, 1).id;
  const view = pr.compileReviewView(analysisId);
  assert.equal(view.state, "DECIDED");
  const d = view.decision!;
  assert.equal(d.policy.policyId, "p-a5", "the STORED policy decides, not anything inside the PR");
  assert.equal(d.status, "FAIL", "the newly planted high finding fails the gate");
  const byId = new Map(d.conditions.map((c) => [c.id, c]));
  assert.equal(byId.get("no-new-password")!.outcome, "FAILED");
  assert.equal(byId.get("analyzers")!.outcome, "PASSED");
  assert.equal(byId.get("tests-preserved")!.outcome, "PASSED");
  assert.equal(byId.get("coverage")!.outcome, "INCOMPLETE", "no CI artifact was given: the condition is honestly incomplete");
  assert.equal(byId.get("coverage")!.blocking, false, "coverage is non-blocking in this policy, as the first delivery intends");
  // A5: a shown outcome never rests on nothing
  for (const c of d.conditions) if (c.outcome === "FAILED" || c.outcome === "INCOMPLETE") assert.ok(c.evidenceIds.length > 0, `${c.id} is ${c.outcome} without evidence ids`);
  // the FAILED condition's evidence is exactly the planted fingerprints
  const introduced = view.findings.introduced.filter((f) => f.ruleId === "R-PII-LOG");
  assert.equal(introduced.length, 1, `exactly the planted chargeCard finding is new (${introduced.length})`);
  assert.deepEqual(introduced.map((f) => f.fingerprint).sort(), [...new Set(byId.get("no-new-password")!.evidenceIds)].sort());
  // A3: the moved file's finding is NOT new; the baseline threads through
  const moved = view.findings.existing.find((f) => f.ruleId === "R-PII-LOG" && f.path === "src/notify.ts");
  assert.ok(moved, "the moved notifyUser finding is known, not introduced");
  assert.ok((moved!.baselineFindingId ?? "").startsWith("fnd:"), "it matched the base finding by fingerprint");
  assert.equal(introduced[0].path, "src/notify.ts", "the planted finding is the card-charge log");
  // unchanged non-test code: renamed function, same behaviour — no oracle noise from the rename alone
  assert.equal(view.findings.detectorCandidates?.filter((f) => f.path === "src/refunds.ts" && f.introduced).length ?? 0, 0,
    "a pure function rename is not an oracle candidate by itself");
  // repeat run of the same identity: no second analysis row
  const before = pr.allForPr(repo.root, 1).length;
  const view2 = await runAnalysis(pr, svc, repo.root, 1, { branch: "pr1", policyId: "p-a5" });
  assert.equal(view2.analysisId, view.analysisId, "the identity is stable across identical runs (§6.1)");
  assert.equal(pr.allForPr(repo.root, 1).length, before, "no second analysis row for the same identity");
});

// ---------------------------------------------------------------- A1: stale head

test("F02 (A1): a moved head — the old decision is superseded, the publication says STALE_REVISION and nothing leaves", async () => {
  const svc = svcOf(); const pr = svc.pr;
  const P = policyOf("p-a1", [NEW_FINDINGS, REQUIRED, TESTS, COVERAGE]);
  assert.ok(pr.putPolicy(P, "test").ok);
  const repo = makeRepo(true);
  const head1 = prMoveAndPlant(repo.root, "pr1a");
  const v1 = await runAnalysis(pr, svc, repo.root, 11, { branch: "pr1a", policyId: "p-a1" });
  assert.equal(v1.state, "DECIDED");
  const d1 = v1.decision!;
  assert.ok(d1.decisionId.startsWith("dec:"));
  // the head moves; the (fake) PR says the new head is current now; a new analysis resolves on the new head
  const head2 = appendFile(repo.root, "src/notify.ts", "\n// review comment: masked upstream, see SEC-42\n");
  const v2ofHead2 = await runAnalysis(pr, svc, repo.root, 11, { branch: "pr1a", policyId: "p-a1" });
  assert.notEqual(v2ofHead2.analysisId, v1.analysisId, "a new analysis identity for the new head");
  assert.equal(v2ofHead2.state, "DECIDED");
  const forge = fakeForge();
  forge.state.heads.set(11, head2);
  const pub = publisherFor(svc, forge);
  const receipt = await publishSafe(pub, { repositoryId: repo.root, prNumber: 11, analysisId: v1.analysisId, headHash: v1.headHash, decisionId: d1.decisionId, principalId: "test" });
  assert.equal(receipt.state, "FAILED");
  assert.match(receipt.lastError ?? "", /STALE_REVISION/);
  assert.equal(forge.statuses.size, 0, "nothing left the machine for the stale head");
  const row = pubRow(svc);
  assert.equal(row.state, "FAILED");
  assert.match(row.last_error ?? "", /head moved/);
  // the stale decision was superseded
  const vb = pr.verifyBinding(d1.decisionId);
  assert.equal(vb.valid, false);
  assert.match(vb.reasons.join(" "), /supersed|head/i);
  // the new head got its own analysis and decision; the old analysis is superseded
  const newest = pr.latestForPr(repo.root, 11);
  assert.notEqual(newest.id, v1.analysisId);
  const v2 = pr.compileReviewView(newest.id);
  assert.equal(v2.headHash, head2);
  assert.equal(v2.state, "DECIDED");
  const oldRow = pr.row(v1.analysisId);
  assert.ok(oldRow.superseded_by === newest.id || oldRow.state === "SUPERSEDED", "the old head's analysis points at its successor");
  // the CURRENT decision publishes cleanly for the moved head
  const forge2 = fakeForge();
  forge2.state.heads.set(11, head2);
  const pub2 = publisherFor(svc, forge2);
  const receipt2 = await publishSafe(pub2, { repositoryId: repo.root, prNumber: 11, analysisId: newest.id, headHash: head2, principalId: "test" });
  assert.equal(receipt2.state, "PUBLISHED");
  const posted = forge2.statuses.get(head2) ?? [];
  assert.equal(posted.length, 1, "find-before-create: one status, not an accumulation");
  assert.equal(posted[0].state, "failure", "PASS→success, FAIL→failure, INCOMPLETE→pending");
  assert.ok(posted[0].description.length <= 140);
  assert.match(posted[0].description, /p-a1 v1/);
  // the comment variant: marker-first so it is updatable in place (WP-09)
  const receipt3 = await publishSafe(pub2, { repositoryId: repo.root, prNumber: 11, analysisId: newest.id, headHash: head2, principalId: "test", kind: "COMMENT" });
  assert.equal(receipt3.state, "PUBLISHED");
  const comment = (forge2.comments.get(11) ?? [])[0];
  assert.ok(comment && comment.body.startsWith(MARKER));
  assert.match(comment.body, /What this does not tell you/);
  const again = await publishSafe(pub2, { repositoryId: repo.root, prNumber: 11, analysisId: newest.id, headHash: head2, principalId: "test", kind: "COMMENT" });
  assert.equal(again.state, "PUBLISHED");
  assert.equal((forge2.comments.get(11) ?? []).length, 1, "the comment is updated in place, never stacked");
});

// ---------------------------------------------------------------- A6: waiver lifecycle

test("F02 (A6): a waiver makes the gate PASS with an expiry; after expiry it fails again and cannot be published", async () => {
  const svc = svcOf(); const pr = svc.pr;
  const P = policyOf("p-a6", [{ id: "nf", type: "NEW_FINDINGS", severity: ["high", "medium"] }]);
  assert.ok(pr.putPolicy(P, "test").ok);
  const repo = makeRepo(true);
  const head = prMoveAndPlant(repo.root, "pr6w");
  const v = await runAnalysis(pr, svc, repo.root, 61, { branch: "pr6w", policyId: "p-a6" });
  assert.equal(v.decision!.status, "FAIL");
  const target = v.findings.introduced.find((f) => f.ruleId === "R-PII-LOG")!;
  // a dismissal with no rationale is refused
  const bad = pr.recordDisposition({ analysisId: v.analysisId, findingId: target.findingId, disposition: "DISMISSED_FALSE_POSITIVE", rationale: "  ", actor: "dev" });
  assert.equal(bad.ok, false);
  assert.match(bad.ok === false ? bad.error : "", /rationale/i);
  const rec = pr.recordDisposition({
    analysisId: v.analysisId, findingId: target.findingId, disposition: "WAIVED", rationale: "masked in the shipping pipeline per SEC-42", actor: "dev",
    waiver: { scopeKind: "FINDING_FINGERPRINT", expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });
  assert.ok(rec.ok, `the waiver must record: ${rec.ok === false ? rec.error : ""}`);
  const v2 = pr.compileReviewView(v.analysisId);
  assert.equal(v2.decision!.status, "PASS", "the waived finding no longer fails the gate");
  const decRow = decisionJson(pr, v.analysisId);
  assert.equal((decRow.exceptionsUsed ?? []).length, 1, "the decision records the waiver it relied on");
  assert.ok(v2.decision!.validUntil && Date.parse(v2.decision!.validUntil) > Date.now(), "the decision is valid only until the waiver expires");
  assert.ok(v2.findings.introduced.some((f) => f.fingerprint === target.fingerprint && f.disposition === "WAIVED"), "the waived finding stays visible, never dropped");
  // expiry: the sweeper supersedes the PASS decision; publish refuses to carry it; a re-evaluation then fails again
  const later = new Date(Date.now() + 120_000).toISOString();
  pr.sweepExpired(new Date(later));
  const stalePassRow = pr.row(v.analysisId as string);
  assert.equal(stalePassRow.state, "EXPIRED_WAIVER", "the sweeper recorded that a waiver the decision relied on has expired");
  const forge = fakeForge();
  forge.state.heads.set(61, head);
  const pub = publisherFor(svc, forge);
  const receipt = await publishSafe(pub, { repositoryId: repo.root, prNumber: 61, analysisId: v.analysisId, headHash: head, principalId: "test" });
  assert.equal(receipt.state, "FAILED", "the expired-waiver decision is not published as PASS");
  assert.equal(forge.statuses.size, 0);
  // then someone re-evaluates: the finding fails the gate again, with no waiver relied on
  const re = pr.reEvaluate(v.analysisId, { now: later });
  assert.equal(re.view.decision!.status, "FAIL", "after the waiver expires, the finding fails the gate again");
  assert.equal(re.view.decision!.validUntil ?? undefined, undefined);
});

// ---------------------------------------------------------------- D3: policy source

test("F02 (D3): the policy always comes from the store; a policy document inside the PR head is data, not authority", async () => {
  const svc = svcOf(); const pr = svc.pr;
  const P = policyOf("p-d3", [NEW_FINDINGS]);
  const lax = policyOf("p-carried", [{ id: "no-new-password", type: "NEW_FINDINGS", severity: ["low"] }]);
  assert.ok(pr.putPolicy(P, "test").ok);
  assert.ok(pr.putPolicy(lax, "test").ok, "even the carried policy's id may exist in the store (with a legal but lax body)");
  const repo = makeRepo(true);
  git(repo.root, "update-ref", "refs/pull/13/head", prWithPolicyDoc(repo.root, "pr13"));
  pr.setRepositoryPolicy(repo.root, "p-d3");
  const v = await runAnalysis(pr, svc, repo.root, 13, { branch: "refs/pull/13/head", policyId: "p-d3" });
  assert.equal(v.policyId, "p-d3", "the run used the STORED assignment");
  assert.equal(v.decision!.status, "FAIL", "a lax policy carried inside the tree changes nothing");
  assert.notEqual(v.policyHash, pr.getPolicy("p-carried")!.policyHash, "the carried id's stored policy is not the one applied");
  assert.equal(v.decision!.policy.policyId, "p-d3");
});

// ---------------------------------------------------------------- D4: CI artifacts

test("F02 (D4): CI artifacts must name the head — a stale artifact is refused and disclosed; a matching one becomes evidence", async () => {
  const svc = svcOf();
  const store = svc.store;
  const base = policyOf("p-d4", [{ id: "coverage", type: "COVERAGE_ON_CHANGED_LINES", minimumPercent: 80, minimumExecutableLines: 1 }]);
  assert.ok(svc.pr.putPolicy(base, "test").ok);

  // ---- part A: an artifact produced for another commit is never applied, and the run still decides ----
  const repoA = makeRepo(false);
  git(repoA.root, "update-ref", "refs/pull/21/head", prMoveAndPlant(repoA.root, "pr21a"));
  const engineA = new PrAnalysis(store, {
    security: svc.security, registry: svc.registry, history: svc.history, indexRevision: serviceAdapter(svc),
  }, { ciArtifacts: () => ({ headCommit: "0000000000000000000000000000000000000000", runId: "run-wrong", junitXml: JUNIT, lcovText: LCOV_COVERED, artifactsHash: "hh-1" }) });
  const vA = await runAnalysis(engineA, svc, repoA.root, 21, { branch: "pr21a", policyId: "p-d4" });
  assert.equal(vA.state, "DECIDED");
  const covA = decisionJson(engineA, vA.analysisId).coverage;
  assert.equal(covA.ciRunId, undefined, "the stale artifact's run id is never claimed");
  assert.match(String(covA.disclosure), /refused/);
  assert.ok(vA.disclosure.some((x) => /refused/.test(x)));

  // ---- part B: an artifact that names this head becomes the evidence behind the coverage condition ----
  const repoB = makeRepo(false);
  const headB = prCoverageLines(repoB.root, "pr21b");
  const engineB = new PrAnalysis(store, {
    security: svc.security, registry: svc.registry, history: svc.history, indexRevision: serviceAdapter(svc),
  }, { ciArtifacts: (headHash) => headHash === headB ? { headCommit: headB, runId: "run-ok", junitXml: JUNIT, lcovText: LCOV_COVERED, artifactsHash: "hh-2" } : null });
  const vB = await runAnalysis(engineB, svc, repoB.root, 21, { branch: "pr21b", policyId: "p-d4" });
  assert.equal(vB.state, "DECIDED");
  const dj = decisionJson(engineB, vB.analysisId);
  assert.equal(dj.coverage.ciRunId, "run-ok");
  assert.equal(dj.coverage.source, "CI");
  assert.ok(dj.coverage.percent === null || dj.coverage.percent >= 80, `the changed lines are covered (${dj.coverage.percent})`);
  assert.equal(vB.decision!.status, "PASS", "the changed lines are covered and nothing was planted → the gate passes here");
  const cov = vB.decision!.conditions.find((c) => c.id === "coverage")!;
  assert.equal(cov.outcome, "PASSED");
  assert.ok(cov.evidenceIds.length > 0, "the coverage condition cites its evidence id");
});

// ---------------------------------------------------------------- D7: escape fences

test("F02 (D7): an unsafe path never resolves; a committed symlink pointing outside fails the run and is recorded", async () => {
  assert.ok(isUnsafePath("../evil.ts"));
  assert.ok(isUnsafePath("/absolute"));
  assert.ok(isUnsafePath("src//double"));
  assert.ok(!isUnsafePath("src/ok.ts"));
  const svc = svcOf(); const pr = svc.pr;
  assert.ok(pr.putPolicy(policyOf("p-d7", [NEW_FINDINGS]), "test").ok);
  const repo = makeRepo(false);
  git(repo.root, "checkout", "-q", "-b", "pr7", "main");
  writeFileSync(join(repo.root, "..", "esc-out.ts"), "export const stolen = () => 1;\n");
  execFileSync("ln", ["-s", "../../esc-out.ts", join(repo.root, "src", "escape.ts")]);
  commitAll(repo.root, "pr7");
  pr.setRepositoryPolicy(repo.root, "p-d7");
  await assert.rejects(
    () => runAnalysis(pr, svc, repo.root, 7, { branch: "pr7", policyId: "p-d7" }),
    (e: any) => e.name === "PrCheckError" && /symbolic|forbidden|escape/i.test(e.message),
  );
  const row = pr.latestForPr(repo.root, 7);
  assert.ok(row, "the analysis row exists (created before the attempt)");
  assert.equal(row.state, "FAILED", "the failed attempt is recorded, not silent");
});

// ---------------------------------------------------------------- D8 + D9: visibility and withheld findings

test("F02 (D8 + D9): a public repository cannot receive scoped findings — nothing publishes; privately, denied paths are counted and never named", async () => {
  const svc = svcOf(); const pr = svc.pr; const store = svc.store;
  const P = policyOf("p-d8", [NEW_FINDINGS]);
  assert.ok(pr.putPolicy(P, "test").ok);
  const repo = makeRepo(false);
  const head = prPlantDenied(repo.root, "pr8");
  git(repo.root, "update-ref", "refs/pull/8/head", head);
  store.denyPath(repo.root, "src/generated", true);
  pr.setRepositoryPolicy(repo.root, "p-d8");
  const v = await runAnalysis(pr, svc, repo.root, 8, { branch: "pr8", policyId: "p-d8" });
  assert.equal(v.state, "DECIDED");
  // D9 in the review: the denied finding is counted but named nowhere
  assert.ok(v.findings.introduced.every((f) => !f.path.startsWith("src/generated/")), "the denied path is not named in the review's findings");
  assert.ok(v.disclosure.some((d) => /not named/.test(d)), "the disclosure says findings were withheld");
  assert.equal(v.decision!.status, "FAIL", "the decision still counts the unseen finding: the gate refuses, only the wording is withheld");
  // D8: GitHub shows the repository publicly → the publisher refuses everything about a scoped run
  const forge = fakeForge();
  forge.state.vis = "public";
  forge.state.heads.set(8, head);
  const pub = publisherFor(svc, forge);
  const receipt = await publishSafe(pub, { repositoryId: repo.root, prNumber: 8, analysisId: v.analysisId, headHash: head, principalId: "test", alsoComment: true });
  assert.equal(receipt.state, "FAILED");
  assert.match(receipt.lastError ?? "", /FORBIDDEN/);
  assert.equal(forge.statuses.size, 0, "nothing reached GitHub");
  assert.equal(forge.comments.size, 0, "the comment did not go out either");
  assert.match(pubRow(svc).last_error ?? "", /publicly|narrower/);
  // the private forge may publish; the comment still must not name the withheld path or any code
  const forge2 = fakeForge();
  forge2.state.vis = "private";
  forge2.state.heads.set(8, head);
  const pub2 = publisherFor(svc, forge2);
  const receipt2 = await publishSafe(pub2, { repositoryId: repo.root, prNumber: 8, analysisId: v.analysisId, headHash: head, principalId: "test", kind: "COMMENT" });
  assert.equal(receipt2.state, "PUBLISHED");
  const comment = (forge2.comments.get(8) ?? [])[0];
  assert.ok(comment && comment.body.startsWith(MARKER));
  assert.ok(!comment.body.includes("src/generated"), "the denied path is not named in the comment");
  assert.ok(!comment.body.includes("debugDump"), "no code text leaks from the withheld finding");
});

// ---------------------------------------------------------------- A2: incompleteness

test("F02 (A2): a required analyzer that does not finish yields INCOMPLETE with its reason; nothing silent is claimed", async () => {
  const svc = svcOf(); const store = svc.store;
  const repo = makeRepo(false);
  git(repo.root, "update-ref", "refs/pull/31/head", prMoveAndPlant(repo.root, "pr31"));
  const engine = new PrAnalysis(store, {
    security: svc.security, registry: svc.registry, history: svc.history, indexRevision: serviceAdapter(svc),
  }, {
    analyzerOverrides: new Map([["security-rules", async () => ({ state: "TIMED_OUT" as const, reason: "timed out after 2 s", wallMs: 2000 })]]),
  });
  const P = policyOf("p-a2", [REQUIRED, NEW_FINDINGS]);
  assert.ok(engine.putPolicy(P, "test").ok);
  const v = await runAnalysis(engine, svc, repo.root, 31, { branch: "pr31", policyId: "p-a2" });
  assert.equal(v.state, "DECIDED");
  assert.equal(v.decision!.status, "INCOMPLETE", "nothing is decided when a required analyzer did not finish");
  const ra = v.decision!.conditions.find((c) => c.id === "analyzers")!;
  assert.equal(ra.outcome, "INCOMPLETE");
  assert.match(ra.reason, /timed out/);
  const rec = v.analyzers.find((a) => a.id === "security-rules")!;
  assert.equal(rec.state, "TIMED_OUT", "the analyzer's state is in the record, not hidden");
  assert.ok(v.disclosure.some((d) => d.includes("TIMED_OUT")), "the disclosure says what did not finish");
});

// ---------------------------------------------------------------- A4: webhook intake

test("F02 (A4): webhook intake — HMAC must verify, deliveries are replay-safe, and out-of-order same-head events make one analysis", async () => {
  const svc = svcOf(); const pr = svc.pr;
  const secret = "whsec-flow-test";
  const previous = process.env.CIE_WEBHOOK_SECRET;
  process.env.CIE_WEBHOOK_SECRET = secret;
  try {
    const P = policyOf("p-wb", [NEW_FINDINGS, REQUIRED, TESTS, COVERAGE]);
    assert.ok(pr.putPolicy(P, "test").ok);
    const repo = makeRepo(true);
    const webhookBody = (sha: string, action: "opened" | "synchronize" | "reopened") =>
      JSON.stringify({ action, number: 1, pull_request: { number: 1, head: { sha, repo: { full_name: "acme/payments" } } }, repository: { full_name: "acme/payments", private: true } });
    const deliver = async (deliveryId: string, action: "opened" | "synchronize" | "reopened", sha: string) =>
      svc.ingestWebhook({ headers: { "x-github-delivery": deliveryId, "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(webhookBody(sha, action)).digest("hex")}` }, rawBody: webhookBody(sha, action), repoOverride: repo.root, actor: "github" });
    pr.setRepositoryPolicy(repo.root, "p-wb"); // the job resolves the assigned policy at run time
    git(repo.root, "update-ref", "refs/pull/1/head", prMoveAndPlant(repo.root, "pr1wb"));
    const head1 = git(repo.root, "rev-parse", "refs/pull/1/head").trim();
    // out of order: the synchronize event arrives first, then the opened event for the same head
    const r1 = await deliver("delivery-1", "synchronize", head1);
    assert.ok(r1.ok && r1.applied, `the webhook schedules an analysis: ${r1.reason ?? ""}`);
    const job1 = await svc.jobs.settled(r1.job!.id);
    assert.equal(job1.state, "SUCCEEDED", `the webhook job must run: ${job1.message ?? ""} ${job1.error ?? ""}`);
    const id1 = pr.latestForPr(repo.root, 1).id;
    assert.equal(pr.compileReviewView(id1).state, "DECIDED");
    // the same delivery replayed: recorded once, scheduled once
    const r2 = await deliver("delivery-1", "synchronize", head1);
    assert.equal(r2.replayed, true);
    assert.equal(r2.applied, false);
    // the same head again under a new delivery id: one identity, no second row
    const r3 = await deliver("delivery-2", "opened", head1);
    assert.ok(r3.applied);
    await svc.jobs.settled(r3.job!.id);
    assert.equal(pr.latestForPr(repo.root, 1).id, id1, "the same head is the same analysis identity");
    assert.equal(pr.allForPr(repo.root, 1).length, 1);
    // a synchronize with a NEW head: a second identity, the first is superseded
    const head2 = appendFile(repo.root, "src/notify.ts", "\n// nudge\n");
    git(repo.root, "update-ref", "refs/pull/1/head", head2);
    const r4 = await deliver("delivery-3", "synchronize", head2);
    assert.ok(r4.applied);
    await svc.jobs.settled(r4.job!.id);
    const id2 = pr.latestForPr(repo.root, 1).id;
    assert.notEqual(id2, id1);
    assert.equal(pr.allForPr(repo.root, 1).length, 2);
    const old = pr.row(id1);
    assert.ok(old.superseded_by === id2 || old.state === "SUPERSEDED", "the older head's analysis is superseded, not merged");
    // verifications happen before anything is scheduled
    await assert.rejects(
      () => svc.ingestWebhook({ headers: { "x-github-delivery": "d-bad", "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${createHmac("sha256", "wrong-secret").update(webhookBody(head1, "opened")).digest("hex")}` }, rawBody: webhookBody(head1, "opened"), repoOverride: repo.root }),
      (e: any) => e.name === "PrCheckError" && /signature|unverified/i.test(e.message),
    );
    const unhandled = await deliver("delivery-4", "closed" as never, head2);
    assert.equal(unhandled.applied, false, "a closed event does not reschedule anything");
    assert.equal(pr.allForPr(repo.root, 1).length, 2, "a closed event makes no analysis row");
  } finally {
    if (previous === undefined) delete process.env.CIE_WEBHOOK_SECRET; else process.env.CIE_WEBHOOK_SECRET = previous;
  }
});