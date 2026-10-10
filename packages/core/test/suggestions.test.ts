import { afterEach } from "node:test";
/**
 * F16 — validated inline fix suggestions (acceptance F16-A1..A15) plus the watcher integration of `/cie suggest`
 * and the service operations C28/prepareSuggestion, C30/publishSuggestion, C23/getSuggestions. The design point
 * (§5): a suggestion is a projection of an existing validated candidate — the candidate id and validation hash
 * travel with the posting; the rendered bytes are byte-identical to the validated replacement (A4); the only
 * writes are one review comment bundle, never the PR branch (§10.1).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StubProvider } from "@cie/model";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { WorkerClient, defaultWorkerPath } from "../src/worker.ts";
import { FeedbackStore } from "../src/feedback.ts";
import { buildImpactReport } from "../src/impact-report.ts";
import { newGrant } from "../src/pr-publish.ts";
import {
  SuggestionEngine, suggestionGate, renderSuggestionBody, checkSuggestionBody,
  fenceFor, assertCommentEvent, MANDATORY_CHECKS,
  type FixCandidate, type ReviewCommentTransport, type SuggestionRecord, type SuggestionValidation,
} from "../src/suggestions.ts";
import { PrChatWatcher, ReplyLedger, parseChat, type ChatTransport, type ChatSuggestions, type PrChatEvent, type PrScope } from "../src/pr-chat.ts";
import { ctx } from "./helpers.ts";

const REV = "rev-head";
const BASE = "b".repeat(40);
const HEAD = "h".repeat(40);
const HEAD2 = "g".repeat(40);
const REPO_ID = "acme/payments";
const ANALYSIS = "pna:one";
const LEDGER = "src/payments/ledger.ts";
const COMMIT = "src/payments/commit.ts";

const LEDGER_TEXT = "export function adjustBalance(amount: number, balance: number): number {\n  return balance - amount;\n}\n";
const COMMIT_TEXT = "export function begin(): void {}\nexport function commit(): void {\n  begin();\n}\n";
const OLD = "  return balance - amount;";
const NEW = "  if (amount > balance) {\n    throw new RangeError(\"insufficient funds\");\n  }\n  return balance - amount;";
const START = LEDGER_TEXT.indexOf(OLD), END = START + OLD.length;

const PASS_CHECKS = (extra: Partial<SuggestionValidation> = {}): SuggestionValidation => ({
  checks: [
    { name: "applied the edit (stale check)", outcome: "PASSED", detail: "the edit applied byte-exact in a scratch copy" },
    { name: "type-check", outcome: "PASSED", detail: "no new diagnostics against the head baseline" },
    { name: "tests", outcome: "PASSED", detail: "3 test(s) run, 3 passed" },
    { name: "finding re-analysis", outcome: "PASSED", detail: "finding no longer present on re-analysis; no new findings introduced" },
  ],
  ok: true, validationHash: "vh:pass", ...extra,
});

function seed() {
  const repoRoot = mkdtempSync(join(tmpdir(), "cie-suggest-"));
  for (const [file, text] of Object.entries({ [LEDGER]: LEDGER_TEXT, [COMMIT]: COMMIT_TEXT })) {
    mkdirSync(join(repoRoot, dirname(file)), { recursive: true });
    writeFileSync(join(repoRoot, file), text);
  }
  const workerPath = (() => { try { return defaultWorkerPath(); } catch { return "/bin/cat"; } })();
  const svc = new Service(new Store(":memory:"), trackedWorker(workerPath), new StubProvider());
  const now = "2026-10-07T10:00:00.000Z";
  svc.store.db.prepare("insert into pr_analyses values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    ANALYSIS, REPO_ID, "github", 7, repoRoot, BASE, HEAD, BASE, REPO_ID,
    "rev-base", REV, "pol", "polhash", "ash", "DECIDED", null, 1, null, now, now);
  const cs = {
    base: "rev-base", head: REV,
    entities: [], textDiff: { filesChanged: 1, symbolsTouched: 1 },
    consequences: [{ id: "csq:1", kind: "ERROR_PATH_ADDED", text: "adjustBalance can now overdraw the account.", evidenceIds: ["ev:1"], claimId: "clm:1", displayMode: "FACT" }],
    claims: [], blastRadius: [], testImpact: [], gaps: [],
  };
  svc.store.db.prepare("insert or replace into pr_change_sets values (?,?,?)").run(ANALYSIS, JSON.stringify(cs), now);
  const report = buildImpactReport({
    analysisId: ANALYSIS, baseHash: BASE, headHash: HEAD, cs: cs as never,
    coverage: { source: "REPOSITORY", executableChangedLines: 1, covered: 1, percent: 80, disclosure: "coverage artifact" },
    analyzers: [{ id: "defect-detectors", version: "1", state: "COMPLETE", coverage: { analyzedFiles: 2, skippedFiles: 0, reason: "scope" } }],
    unresolvedDynamicCalls: 0, incomplete: false, incompleteReasons: [], now,
  });
  svc.store.db.prepare("insert into impact_reports values (?,?,?,?,?,?)").run(ANALYSIS, JSON.stringify(report), "rephash", "CURRENT", now, now);
  const scope: PrScope = {
    analysisId: ANALYSIS, headHash: HEAD, baseHash: BASE, headRevision: REV, repoRoot,
    changedEntityIds: [], reportItems: report.surfaced.map((item, i) => ({ n: i + 1, id: item.id })),
  };
  return { svc, repoRoot, scope, report };
}

const candidate = (over: Partial<FixCandidate> = {}): FixCandidate => ({
  id: "cand:1", findingId: "item:1", baseHash: HEAD, validationHash: "vh:1", oraclePreserved: true,
  edits: [{ file: LEDGER, start: START, end: END, expected: OLD, newText: NEW }],
  recheck: ({ text }) => ({ findingGone: text.includes("amount > balance"), newFindings: [] }),
  ...over,
});

const mkGrant = (store: Store, principal = "amy") =>
  newGrant(store, { repositoryId: REPO_ID, headHash: HEAD, principalId: principal, operation: "PUBLISH_SUGGESTION", ttlMs: 60_000 });

function fakeReviewTransport(over: { head?: string | null } = {}) {
  const calls = { submitted: 0, updated: 0, found: 0, events: [] as string[], bodies: [] as string[], updatedBodies: [] as string[], heads: [] as number[] };
  const t: ReviewCommentTransport = {
    submitReview: async (pr, sha, comments, event) => {
      assertCommentEvent(event); // F16-A9: the transport itself refuses anything but COMMENT
      calls.heads.push(pr); calls.events.push(event); calls.submitted++;
      for (const c of comments) calls.bodies.push(c.body);
      return { id: `rc-${calls.submitted}` };
    },
    updateReviewComment: async (id, body) => { calls.updated++; calls.updatedBodies.push(body); return { id }; },
    findReviewComment: async () => { calls.found++; return null; },
    resolveHead: async () => over.head === undefined ? HEAD : over.head,
  };
  return { t, calls };
}

const prepareOk = async (engine: SuggestionEngine, repoRoot: string, over: Partial<FixCandidate> = {}) => {
  const r = await engine.prepare({ analysisId: ANALYSIS, findingId: over.findingId ?? "item:1", headHash: HEAD, repoRoot, principalId: "amy", introduced: true, candidate: candidate(over) });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  return (r as { ok: true; record: SuggestionRecord }).record;
};

// ---------------------------------------------------------------- F16-A1: wrong base

test("F16-A1: a candidate whose base is not the PR head is ineligible, rule named", async () => {
  const s = seed();
  const engine = new SuggestionEngine(s.svc.store, { validate: async () => PASS_CHECKS() });
  const r = await engine.prepare({ analysisId: ANALYSIS, findingId: "item:1", headHash: HEAD, repoRoot: s.repoRoot, principalId: "amy", introduced: true, candidate: candidate({ baseHash: BASE }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /base does not equal the PR head/);
});

// ---------------------------------------------------------------- F16-A2: structural ineligibility

test("F16-A2: multi-hunk, multi-file, file-creating, file-deleting and test-editing candidates are ineligible with a named reason", async () => {
  const s = seed();
  const c0Start = COMMIT_TEXT.indexOf("begin();"), c0End = c0Start + "begin();".length;
  const commitEdit = { file: COMMIT, start: c0Start, end: c0End, expected: "begin();", newText: "begin(); // sync" };
  const mk = (over: Partial<FixCandidate>) => suggestionGate(candidate(over), {
    headHash: HEAD, deniedPrefixes: [], readFile: (p) => p === LEDGER ? LEDGER_TEXT : p === COMMIT ? COMMIT_TEXT : null,
  });
  // multi-hunk (same file, two spans)
  const ledgerEdit2 = { file: LEDGER, start: 0, end: 0, expected: "", newText: "// header\n" };
  const multiHunk = mk({ edits: [{ file: LEDGER, start: START, end: END, expected: OLD, newText: NEW }, ledgerEdit2] });
  assert.equal(multiHunk.ok, false); assert.match((multiHunk as { reason: string }).reason, /one file and one contiguous replacement/);
  const multiFile = mk({ edits: [{ file: LEDGER, start: START, end: END, expected: OLD, newText: NEW }, commitEdit] });
  assert.equal(multiFile.ok, false); assert.match((multiFile as { reason: string }).reason, /2 file\(s\)/);
  const creating = mk({ creates: ["src/payments/new.ts"] });
  assert.equal(creating.ok, false); assert.match((creating as { reason: string }).reason, /creates a file/);
  const deleting = mk({ deletes: [COMMIT] });
  assert.equal(deleting.ok, false); assert.match((deleting as { reason: string }).reason, /deletes a file/);
  const testEdit = suggestionGate(candidate({ edits: [{ file: "tests/ledger.test.ts", start: 0, end: 0, expected: "", newText: "// x" }] }), {
    headHash: HEAD, deniedPrefixes: [], readFile: () => "anything",
  });
  assert.equal(testEdit.ok, false); assert.match((testEdit as { reason: string }).reason, /test files are ineligible/);
  // oracle not preserved → rule 5
  const weakened = mk({ oraclePreserved: false });
  assert.equal(weakened.ok, false); assert.match((weakened as { reason: string }).reason, /ORACLE_PRESERVED/);
});

// ---------------------------------------------------------------- F16-A3: high-impact paths

test("F16-A3: a T2 path (auth, dependency, workflow) is ineligible with the pattern named", async () => {
  const read = (p: string) => ({ "src/auth/session.ts": "export const x = 1;\n", "package.json": "{}\n", ".github/workflows/ci.yml": "on: push\n" })[p] ?? null;
  for (const path of ["src/auth/session.ts", "package.json", ".github/workflows/ci.yml"]) {
    const g = suggestionGate(candidate({ edits: [{ file: path, start: 0, end: 1, expected: path === "package.json" ? "{" : "e", newText: "z" }] }), {
      headHash: HEAD, deniedPrefixes: [], readFile: read,
    });
    assert.equal(g.ok, false, path);
    assert.match((g as { reason: string }).reason, /high-impact pattern/);
  }
});

// ---------------------------------------------------------------- F16-A4: byte-identical rendering

test("F16-A4: the posted text is byte-identical to the validated replacement; a mutated replacement is rejected before posting", async () => {
  const s = seed();
  const engine = new SuggestionEngine(s.svc.store, { validate: async () => PASS_CHECKS() });
  const rec = await prepareOk(engine, s.repoRoot);
  const body = renderSuggestionBody(rec);
  const fence = fenceFor(rec.replacement);
  assert.ok(body.includes(`${fence}suggestion\n${rec.replacement}\n${fence}`));
  assert.deepEqual(checkSuggestionBody(body, rec), { ok: true });
  // a mutated replacement (bytes differ from the hash the record carries) is refused, unaltered
  const mutated = checkSuggestionBody(body, { ...rec, replacement: rec.replacement + "\n// sneaky" });
  assert.equal(mutated.ok, false);
  if (!mutated.ok) assert.match(mutated.reason, /byte-identical|recorded hash/);
  assert.equal(rec.replacement, NEW); // the validated bytes were never altered
});

// ---------------------------------------------------------------- F16-A5: backtick fences

test("F16-A5: a replacement containing triple and quadruple backticks renders without breaking the fence", () => {
  const rec: SuggestionRecord = {
    id: "sgg:t", analysisId: ANALYSIS, findingId: "item:1", candidateId: "cand:1", validationHash: "vh",
    headHash: HEAD, path: LEDGER, startLine: 2, endLine: 2, expected: OLD,
    replacement: "const doc = ```md\n# hi\n```;\nconst more = ````quad````;\n",
    replacementHash: createHash("sha256").update("const doc = ```md\n# hi\n```;\nconst more = ````quad````;\n").digest("hex"),
    checks: PASS_CHECKS().checks, state: "PREPARED", idempotencyKey: "k", createdBy: "amy", createdAt: "t",
  };
  const fence = fenceFor(rec.replacement);
  assert.ok(fence.length > 4, "the fence out-runs the quadruple backtick run");
  const body = renderSuggestionBody(rec);
  assert.ok(body.includes(`${fence}suggestion\n${rec.replacement.replace(/\n$/, "")}\n${fence}`));
  assert.deepEqual(checkSuggestionBody(body, rec), { ok: true });
});

// ---------------------------------------------------------------- F16-A6: a failing check stops the suggestion

test("F16-A6: new type diagnostics or a failing test stop the suggestion", async () => {
  const s = seed();
  const withDiag: SuggestionValidation = {
    checks: [
      { name: "applied the edit (stale check)", outcome: "PASSED", detail: "applied" },
      { name: "type-check", outcome: "FAILED", detail: "1 new diagnostic(s): ledger.ts TS2304 Cannot find name 'InsufficientFunds'" },
      { name: "tests", outcome: "NOT_RUN", detail: "dependent checks did not run" },
      { name: "finding re-analysis", outcome: "NOT_RUN", detail: "dependent checks did not run" },
    ],
    ok: false, validationHash: "vh:diag",
  };
  const engine = new SuggestionEngine(s.svc.store, { validate: async () => withDiag });
  const r = await engine.prepare({ analysisId: ANALYSIS, findingId: "item:1", headHash: HEAD, repoRoot: s.repoRoot, principalId: "amy", introduced: true, candidate: candidate() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /type-check/);
  const failingTests: SuggestionValidation = {
    ...PASS_CHECKS(), ok: false,
    checks: PASS_CHECKS().checks.map((c) => c.name === "tests" ? { ...c, outcome: "FAILED" as const, detail: "3 run, 1 failed" } : c),
  };
  const engine2 = new SuggestionEngine(s.svc.store, { validate: async () => failingTests });
  // a different replacement is a different identity (§11) — this is a second candidate for the same finding
  const variant = candidate({ edits: [{ file: LEDGER, start: START, end: END, expected: OLD, newText: NEW + "\n// follow-up note" }] });
  const r2 = await engine2.prepare({ analysisId: ANALYSIS, findingId: "item:1", headHash: HEAD, repoRoot: s.repoRoot, principalId: "amy", introduced: true, candidate: variant });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /tests/);
});

// ---------------------------------------------------------------- F16-A7: the finding must be gone

test("F16-A7: a finding still present (or a new one introduced) on re-analysis stops the suggestion", async () => {
  const s = seed();
  const stillThere: SuggestionValidation = {
    ...PASS_CHECKS(), ok: false,
    checks: PASS_CHECKS().checks.map((c) => c.name === "finding re-analysis" ? { ...c, outcome: "FAILED" as const, detail: "the detector still reports the finding on the patched tree" } : c),
  };
  const engine = new SuggestionEngine(s.svc.store, { validate: async () => stillThere });
  const r = await engine.prepare({ analysisId: ANALYSIS, findingId: "item:1", headHash: HEAD, repoRoot: s.repoRoot, principalId: "amy", introduced: true, candidate: candidate() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /still reports the finding/);
});

// ---------------------------------------------------------------- F16-A8: NOT_RUN semantics

test("F16-A8: NOT_RUN checks appear under \"Not checked\"; mandatory checks not run block posting", async () => {
  const s = seed();
  const partial: SuggestionValidation = {
    checks: [
      { name: "applied the edit (stale check)", outcome: "PASSED", detail: "applied" },
      { name: "type-check", outcome: "NOT_RUN", detail: "the type-check could not run: no toolchain" },
      { name: "tests", outcome: "NOT_RUN", detail: "tests could not run: no runner" },
      { name: "finding re-analysis", outcome: "PASSED", detail: "finding no longer present" },
    ],
    ok: false, validationHash: "vh:partial",
  };
  const engine = new SuggestionEngine(s.svc.store, { validate: async () => partial });
  const r = await engine.prepare({ analysisId: ANALYSIS, findingId: "item:1", headHash: HEAD, repoRoot: s.repoRoot, principalId: "amy", introduced: true, candidate: candidate() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /mandatory checks did not all run/);
  assert.equal(MANDATORY_CHECKS.length, 2);
  const rec = engine.forAnalysis(ANALYSIS)[0]!;
  const body = renderSuggestionBody(rec);
  assert.match(body, /Not checked:/);
  assert.match(body, /no toolchain/); // the "Not checked" line carries the NOT_RUN detail after its name prefix
  // posting is blocked even if the caller tries
  const { t, calls } = fakeReviewTransport();
  const pub = await engine.publish({ suggestionId: rec.id, prNumber: 7, repositoryId: REPO_ID, principalId: "amy", grantId: mkGrant(s.svc.store).id, transport: t });
  assert.equal(pub.ok, false);
  if (!pub.ok) assert.match(pub.reason, /mandatory checks/);
  assert.equal(calls.submitted, 0);
  assert.equal(engine.record(rec.id)!.state, "FAILED");
});

// ---------------------------------------------------------------- F16-A9: the review event is always COMMENT

test("F16-A9: the review event is always COMMENT; the transport refuses approve/request-changes", async () => {
  assertCommentEvent("COMMENT");
  for (const bad of ["APPROVE", "REQUEST_CHANGES"]) {
    assert.throws(() => assertCommentEvent(bad as never), /never approves or requests changes/);
  }
  const s = seed();
  const engine = new SuggestionEngine(s.svc.store, { validate: async () => PASS_CHECKS() });
  const rec = await prepareOk(engine, s.repoRoot);
  const { t, calls } = fakeReviewTransport();
  const pub = await engine.publish({ suggestionId: rec.id, prNumber: 7, repositoryId: REPO_ID, principalId: "amy", grantId: mkGrant(s.svc.store).id, transport: t });
  assert.equal(pub.ok, true);
  assert.deepEqual(calls.events, ["COMMENT"]);
});

// ---------------------------------------------------------------- F16-A10: supersession on push

test("F16-A10: a push marks the suggestion superseded in place; a suggestion for a stale head is never posted", async () => {
  const s = seed();
  const engine = new SuggestionEngine(s.svc.store, { validate: async () => PASS_CHECKS() });
  const rec = await prepareOk(engine, s.repoRoot);
  const { t, calls } = fakeReviewTransport();
  const pub = await engine.publish({ suggestionId: rec.id, prNumber: 7, repositoryId: REPO_ID, principalId: "amy", grantId: mkGrant(s.svc.store).id, transport: t });
  assert.equal(pub.ok, true);
  // a second suggestion is prepared against the current head before the push
  const rec2 = await prepareOk(engine, s.repoRoot, { findingId: "item:2", id: "cand:2", edits: [{ file: LEDGER, start: START, end: END, expected: OLD, newText: NEW }] });
  // the head moves; the file changes some other way (the suggestion was not applied)
  writeFileSync(join(s.repoRoot, LEDGER), LEDGER_TEXT.replace("adjustBalance", "recalculate"));
  // a suggestion prepared against the old head cannot be posted now — the publisher's own head check fires first
  const stale = await engine.publish({ suggestionId: rec2.id, prNumber: 7, repositoryId: REPO_ID, principalId: "amy", grantId: mkGrant(s.svc.store).id, transport: fakeReviewTransport({ head: HEAD2 }).t });
  assert.equal(stale.ok, false);
  if (!stale.ok) { assert.equal(stale.code, "STALE"); assert.match(stale.reason, /superseded, not posted/); }
  assert.equal(engine.record(rec2.id)!.state, "SUPERSEDED");
  const observed = engine.observe({ analysisId: ANALYSIS, repoRoot: s.repoRoot, headHash: HEAD2 });
  const updated = observed.records.find((r) => r.id === rec.id)!;
  assert.equal(updated.state, "SUPERSEDED");
  assert.ok(updated.observedAt);
  assert.equal(observed.toUpdate.length, 1);
  assert.match(observed.toUpdate[0]!.body, /\*\*Superseded\*\*/);
  assert.match(observed.toUpdate[0]!.body, /moved to ggggggg/);
  // and the supersede body keeps the old text visible as history
  assert.ok(observed.toUpdate[0]!.body.includes(renderSuggestionBody(updated).split("\n").slice(0, 8).join("\n")));
  // rec2 was already superseded by the publish attempt; observation does not resurrect it
  assert.equal(observed.records.find((r) => r.id === rec2.id)!.state, "SUPERSEDED");
});

// ---------------------------------------------------------------- F16-A11: the egress guard refuses secrets

test("F16-A11: a secret-like string in the replacement makes the posting refuse, unaltered", async () => {
  const s = seed();
  const leaky = candidate({ edits: [{ file: LEDGER, start: START, end: END, expected: OLD, newText: NEW + "\nconst token = \"ghp_\" + \"vUiObsqWs5z680e8EgPNVFiCXGuT3D4VJr6f\";\n" }] });
  const engine = new SuggestionEngine(s.svc.store, { validate: async () => PASS_CHECKS() });
  const r = await engine.prepare({ analysisId: ANALYSIS, findingId: "item:1", headHash: HEAD, repoRoot: s.repoRoot, principalId: "amy", introduced: true, candidate: leaky });
  assert.equal(r.ok, true); // validation is local; the guard acts at the boundary
  const rec = (r as { ok: true; record: SuggestionRecord }).record;
  const { t, calls } = fakeReviewTransport();
  const pub = await engine.publish({ suggestionId: rec.id, prNumber: 7, repositoryId: REPO_ID, principalId: "amy", grantId: mkGrant(s.svc.store).id, transport: t });
  assert.equal(pub.ok, false);
  if (!pub.ok) { assert.equal(pub.code, "GUARD"); assert.match(pub.reason, /looks like a secret/); }
  assert.equal(calls.submitted, 0);
  assert.equal(engine.record(rec.id)!.state, "FAILED");
  assert.ok(engine.record(rec.id)!.replacement.includes("ghp_")); // refused, never altered
});

// ---------------------------------------------------------------- F16-A12: denied paths are counted, never suggested

test("F16-A12: a denied path is never suggested and is not named", async () => {
  const g = suggestionGate(candidate(), {
    headHash: HEAD, deniedPrefixes: ["src/payments"], readFile: () => LEDGER_TEXT,
  });
  assert.equal(g.ok, false);
  assert.match((g as { reason: string }).reason, /withheld by the access policy/);
  assert.doesNotMatch((g as { reason: string }).reason, /src\/payments/);
});

// ---------------------------------------------------------------- F16-A13: re-delivery creates no second comment

test("F16-A13: a crash after posting re-delivers from the stored record by marker — one comment, no duplicate", async () => {
  const s = seed();
  const engine = new SuggestionEngine(s.svc.store, { validate: async () => PASS_CHECKS() });
  const rec = await prepareOk(engine, s.repoRoot);
  const { t, calls } = fakeReviewTransport();
  const g = mkGrant(s.svc.store).id;
  const pub1 = await engine.publish({ suggestionId: rec.id, prNumber: 7, repositoryId: REPO_ID, principalId: "amy", grantId: g, transport: t });
  assert.equal(pub1.ok, true);
  // simulate a crash after the post but before the state landed: back to PREPARED, marker now findable
  s.svc.store.db.prepare("update suggestions set state = 'PREPARED', external_id = null where id = ?").run(rec.id);
  const t2: ReviewCommentTransport = {
    ...t,
    // after the crash the marker is findable: the replay adopts the landed comment instead of posting a second one
    findReviewComment: async () => ({ id: "rc-1", body: calls.bodies[0]! }),
  };
  const pub2 = await engine.publish({ suggestionId: rec.id, prNumber: 7, repositoryId: REPO_ID, principalId: "amy", grantId: g, transport: t2 });
  assert.equal(pub2.ok, true);
  if (pub2.ok) { assert.equal(pub2.idempotent, true); assert.equal(pub2.externalId, "rc-1"); }
  assert.equal(calls.submitted, 1); // find-before-create: no second inline comment
});

// ---------------------------------------------------------------- F16-A14: the per-PR cap

test("F16-A14: the per-PR cap of three holds; the rest are listed in one line", async () => {
  const s = seed();
  const engine = new SuggestionEngine(s.svc.store, { validate: async () => PASS_CHECKS(), perPrCap: 3 });
  const { t } = fakeReviewTransport();
  for (let i = 1; i <= 3; i++) {
    const rec = await prepareOk(engine, s.repoRoot, { findingId: `item:${i}`, id: `cand:${i}`, edits: [{ file: LEDGER, start: START, end: END, expected: OLD, newText: NEW + `\n// variant ${i}` }] });
    const pub = await engine.publish({ suggestionId: rec.id, prNumber: 7, repositoryId: REPO_ID, principalId: "amy", grantId: mkGrant(s.svc.store).id, transport: t });
    assert.equal(pub.ok, true, pub.ok ? "" : pub.reason);
  }
  const fourth = await prepareOk(engine, s.repoRoot, { findingId: "item:4", id: "cand:4", edits: [{ file: LEDGER, start: START, end: END, expected: OLD, newText: NEW + "\n// variant 4" }] });
  const pub4 = await engine.publish({ suggestionId: fourth.id, prNumber: 7, repositoryId: REPO_ID, principalId: "amy", grantId: mkGrant(s.svc.store).id, transport: t });
  assert.equal(pub4.ok, false);
  if (!pub4.ok) { assert.equal(pub4.code, "CAP"); assert.match(pub4.reason, /cap of 3/); assert.match(pub4.reason, /1 further candidate\(s\) stay unposted/); }
  assert.equal(engine.forAnalysis(ANALYSIS).filter((r) => r.state === "POSTED").length, 3);
});

// ---------------------------------------------------------------- F16-A15: application is observed, ranking untouched

test("F16-A15: an applied suggestion is observed on the next head and recorded APPLIED; it does not alter ranking", async () => {
  const s = seed();
  const engine = new SuggestionEngine(s.svc.store, { validate: async () => PASS_CHECKS() });
  const rec = await prepareOk(engine, s.repoRoot);
  const { t } = fakeReviewTransport();
  const pub = await engine.publish({ suggestionId: rec.id, prNumber: 7, repositoryId: REPO_ID, principalId: "amy", grantId: mkGrant(s.svc.store).id, transport: t });
  assert.equal(pub.ok, true);
  // the author applied the suggestion and pushed
  writeFileSync(join(s.repoRoot, LEDGER), LEDGER_TEXT.replace(OLD, NEW));
  const observed = engine.observe({ analysisId: ANALYSIS, repoRoot: s.repoRoot, headHash: HEAD2 });
  const updated = observed.records.find((r) => r.id === rec.id)!;
  assert.equal(updated.state, "APPLIED");
  assert.equal(observed.toUpdate.length, 0);
  // §7.6: observations never feed ranking (F15 §7.2 rule 5)
  const fb = new FeedbackStore(s.svc.store);
  assert.equal(fb.state(REPO_ID).labels.total, 0);
  assert.equal(fb.recomputeWeights(REPO_ID).weights.length, 0);
});

// ---------------------------------------------------------------- the default validator on a real fixture tree

test("the default validator runs type-check and finding re-analysis on a scratch copy of the head", async () => {
  const s = seed();
  const runTests = () => ({ ran: true, passed: 3, failed: 0, output: "" });
  const engine = new SuggestionEngine(s.svc.store, { runTests });
  const rec = await prepareOk(engine, s.repoRoot);
  const names = rec.checks.map((c) => `${c.name}:${c.outcome}`);
  assert.ok(names.includes("applied the edit (stale check):PASSED"));
  assert.ok(names.includes("type-check:PASSED"), names.join(","));
  assert.ok(names.some((n) => n === "tests:PASSED" || n === "tests:NOT_RUN"), names.join(","));
  assert.ok(names.includes("finding re-analysis:PASSED"), names.join(","));
  assert.match(rec.checks.find((c) => c.name === "tests")!.detail, /3 test\(s\) run, 3 passed/);
  assert.equal(rec.startLine, 2);
  assert.equal(rec.endLine, 2);
});

test("a finding not introduced by the PR is never suggestible (D4)", async () => {
  const s = seed();
  const engine = new SuggestionEngine(s.svc.store, { validate: async () => PASS_CHECKS() });
  const r = await engine.prepare({ analysisId: ANALYSIS, findingId: "item:1", headHash: HEAD, repoRoot: s.repoRoot, principalId: "amy", introduced: false, candidate: candidate() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not introduced by this PR/);
});

// ---------------------------------------------------------------- watcher integration

function fakeChatTransport() {
  const posts: { pr: number; inReplyTo: string; body: string }[] = [];
  const t: ChatTransport = {
    listComments: async () => [],
    postReply: async (pr, inReplyTo, body) => { posts.push({ pr, inReplyTo, body }); return { id: `reply-${posts.length}` }; },
    visibility: async () => "public" as const,
  };
  return { t, posts };
}

let seq = 0;
const evOf = (body: string, over: Partial<PrChatEvent> = {}): PrChatEvent => ({
  eventId: `e-${++seq}`, repository: REPO_ID, prNumber: 7, commentId: `c-${seq}`, author: "amy",
  authorAssociation: "MEMBER", body, headHash: HEAD, createdAt: "2026-10-07T10:00:00.000Z", untrusted: true, ...over,
});

const watcherFor = (seeded: ReturnType<typeof seed>, t: ChatTransport, suggestionsFor?: (ev: PrChatEvent, scope: PrScope) => ChatSuggestions | null) =>
  new PrChatWatcher({
    ledger: new ReplyLedger(seeded.svc.store),
    scopeFor: () => seeded.scope,
    buildEnv: () => { throw new Error("unused in these tests"); },
    reportHashOf: () => "rephash",
    nowHeadHashOf: () => null,
    deniedPrefixesOf: () => [],
    evidenceOf: () => ({}),
    transport: t,
    suggestionsFor,
  });

test("/cie suggest parses and is dispatched on its own role-gated path", async () => {
  assert.deepEqual(parseChat("/cie suggest 2"), { type: "command", verb: "suggest", args: "2" });
  const s = seed();
  const { t, posts } = fakeChatTransport();
  let called: { n: number; actor: string } | null = null;
  const w = watcherFor(s, t, () => ({ prepare: async (n, actor) => { called = { n, actor }; return { ok: true, summary: "a validated suggestion for item 2 (ERROR_PATH_ADDED) is posted as an inline review comment, bound to head hhhhhhh — apply it only if you agree." }; } }));
  const r = await w.handleEvent(evOf("/cie suggest 2"));
  assert.equal(r.outcome, "POSTED");
  assert.deepEqual(called, { n: 2, actor: "amy" });
  assert.match(posts[0]!.body, /a validated suggestion for item 2/);
});

test("/cie refuse: viewers get one role refusal; without hooks one disabled notice, then silence", async () => {
  const s = seed();
  const { t, posts } = fakeChatTransport();
  const w = watcherFor(s, t, () => ({ prepare: async () => ({ ok: true, summary: "unused" }) }));
  const r1 = await w.handleEvent(evOf("/cie suggest 1", { author: "ro", authorAssociation: "CONTRIBUTOR" }));
  assert.equal(r1.outcome, "POSTED");
  assert.match(posts[0]!.body, /needs at least the editor role/);
  const r2 = await w.handleEvent(evOf("/cie suggest 1", { author: "ro", authorAssociation: "CONTRIBUTOR", commentId: "c-other" }));
  assert.equal(r2.outcome, "SKIPPED"); // one refusal per (PR, author, kind), then silence
  assert.equal(posts.length, 1);

  const s2 = seed();
  const { t: t2, posts: posts2 } = fakeChatTransport();
  const w2 = watcherFor(s2, t2, undefined);
  const d1 = await w2.handleEvent(evOf("/cie suggest 1", { commentId: "c-1" }));
  assert.equal(d1.outcome, "POSTED");
  assert.match(posts2[0]!.body, /not enabled for this analysis/);
  const d2 = await w2.handleEvent(evOf("/cie suggest 1", { commentId: "c-2" }));
  assert.equal(d2.outcome, "SKIPPED");
  assert.equal(posts2.length, 1);
});

test("an unavailable candidate answers \"no validated fix\" as a refusal naming §7.1", async () => {
  const s = seed();
  const { t, posts } = fakeChatTransport();
  const w = watcherFor(s, t, () => ({ prepare: async () => ({ ok: false, reason: "no validated fix is available for this finding (§7.1); CIE does not invent one" }) }));
  const r = await w.handleEvent(evOf("/cie suggest 1"));
  assert.equal(r.outcome, "POSTED");
  assert.match(posts[0]!.body, /no validated fix is available for this finding/);
  assert.match(posts[0]!.body, /^Refused:/m);
});

// ---------------------------------------------------------------- service operations

test("C28/prepareSuggestion takes an explicit candidate; without one and no provider it says so; C23/getSuggestions lists records", async () => {
  const s = seed();
  const c = ctx("amy");
  const noCandidate = await s.svc.prOps["C28/prepareSuggestion"]!(c, { analysisId: ANALYSIS, findingId: "item:1" });
  assert.equal(noCandidate.ok, false);
  if (!noCandidate.ok) assert.match(noCandidate.error.message, /no validated fix is available/);
  const prepared = await s.svc.prOps["C28/prepareSuggestion"]!(c, {
    analysisId: ANALYSIS, findingId: "item:1",
    candidate: {
      id: "cand:1", findingId: "item:1", baseHash: HEAD, edits: [{ file: LEDGER, start: START, end: END, expected: OLD, newText: NEW }], validationHash: "vh:1", oraclePreserved: true,
      recheck: ({ text }: { file: string; text: string }) => ({ findingGone: text.includes("amount > balance"), newFindings: [] }),
    },
  });
  assert.equal(prepared.ok, true, prepared.ok ? "" : JSON.stringify(prepared.error));
  const listed = await s.svc.prOps["C23/getSuggestions"]!(c, { analysisId: ANALYSIS });
  assert.equal(listed.ok, true);
  if (listed.ok) {
    const list = (listed.value as { suggestions: SuggestionRecord[] }).suggestions;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.state, "PREPARED");
    assert.equal(list[0]!.path, LEDGER);
  }
  // the validated replacement is stored with the record, so a crash can re-post from it (§11)
  const row = s.svc.store.db.prepare("select replacement from suggestions where analysis_id = ?").get(ANALYSIS) as { replacement: string };
  assert.equal(row.replacement, NEW);
});

test("the service hook prepares through a provider and reports an honest publish failure", async () => {
  const s = seed();
  s.svc.suggestionEngine = new SuggestionEngine(s.svc.store, {
    provider: { candidateFor: async (findingId) => candidate({ findingId }) },
    validate: async () => PASS_CHECKS(),
  });
  const hooks = s.svc.chatSuggestionsFor(evOf("/cie suggest 1", {}), s.scope);
  assert.ok(hooks);
  // no transport is reachable for the fake repo, so the publish leg fails honestly; prepare is what the summary reports
  const r = await hooks!.prepare(1, "amy");
  assert.equal(r.ok, false); // the forge is unreachable in the test fixture — the failure is reported, never simulated
  const none = await s.svc.prOps["C28/prepareSuggestion"]!(ctx("amy"), { analysisId: ANALYSIS, findingId: "item:9" });
  assert.equal(none.ok, false); // provider: null candidate → the §7.1 answer
  if (!none.ok) assert.match(none.error.message, /no validated fix/);
});

const testWorkers: WorkerClient[] = [];
function trackedWorker(...args: ConstructorParameters<typeof WorkerClient>) { const worker = new WorkerClient(...args); testWorkers.push(worker); return worker; }
afterEach(() => { for (const worker of testWorkers.splice(0)) worker.close(); });
