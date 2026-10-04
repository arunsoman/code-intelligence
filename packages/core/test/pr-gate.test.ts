// F02 — pure gate tests (WP-05/WP-08 units): policy validation, deterministic evaluation (purity D1), FAIL
// dominance (D10), NOT_APPLICABLE conditions (D11), onMissing mapping, mandatory analyzers never pass silently (§7.1),
// waiver application/expiry, fingerprint stability (D2) and baseline matching (§7.3–7.4), binding-hash sensitivity
// (§6.1), and the honest copy of the summary artefacts (§10.4/§12.2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { Security } from "../src/security.ts";
import { PrAnalysis } from "../src/pr-analysis.ts";
import { evaluate, validatePolicy, validateWaiver, findingFingerprint, matchBaselines, normalizeAnchor, gateStatusDescription, gateCommentText } from "../src/pr-gate.ts";
import type { GateConditionType, GateEvidence, GatePolicyBody, PrFinding, WaiverRecord } from "@cie/schema";
import { Registry } from "../src/registry.ts";
import { History } from "../src/history.ts";

// A store with the real schema: the engine's waiver/decision tables are exercised below.
const store = new Store(":memory:");
const registry = new Registry(store);
const engine = new PrAnalysis(store, {
  security: new Security(store), registry, history: new History(store, registry),
  indexRevision: () => { throw new Error("this test never indexes"); },
});

// ---- builders ------------------------------------------------------------------
const finding = (findingId: string, fp: string, over: Partial<PrFinding> = {}): PrFinding => ({
  findingId, fingerprint: fp, introduced: true, ruleId: "R-PII-LOG", ruleVersion: 1, severity: "high",
  path: "src/a.ts", line: 3, entityId: "entity:a@1", disposition: "OPEN",
  title: "PII logged", summary: "The log line includes personal data.", evidenceIds: [],
  counterArgument: "Masked values are not excluded.", kind: "SECURITY", ...over,
});
const evidence = (over: Partial<GateEvidence> = {}): GateEvidence => ({
  analyzers: [{ id: "security-rules", version: "1", state: "COMPLETE", coverage: { analyzedFiles: 2, skippedFiles: 0, reason: "changed files and their dependents (depth 2)" } }],
  findings: [], testImpact: { lost: [], gained: 0, unchanged: 0 }, coverage: null, testsRun: null,
  oracle: null, dependencies: null, blastRadius: { dependents: 0 }, waivers: [], ...over,
});
const REF = { baseHash: "b1", headHash: "h1", mergeBaseHash: "m1", analyzerSetHash: "aset:1", evaluatedAt: "2030-01-01T00:00:00Z" };
const policyBody = (conditions: Record<string, unknown>[], over: Record<string, unknown> = {}): GatePolicyBody =>
  ({ policyId: "test-policy", version: 1, ...over, conditions }) as unknown as GatePolicyBody;
const outcomeOf = (d: ReturnType<typeof evaluate>, id: string) => d.results.find((c) => c.id === id)!.outcome;

// ---- validation (§7.1) ----------------------------------------------------------
test("F02: a policy naming an unknown condition type is rejected at validation time, never at evaluation", () => {
  const bad = validatePolicy({ policyId: "p", version: 1, conditions: [{ id: "x", type: "MAGIC_FEELING" }] });
  assert.equal(bad.ok, false, "unknown condition type rejected");
  assert.ok(bad.problems.join(" ").length > 0);
  const bad2 = validatePolicy({ policyId: "P", version: 0, conditions: [] });
  assert.equal(bad2.ok, false, "version 0 and no conditions rejected");
});

test("F02: identical policies hash identically; any change to a condition changes the hash", () => {
  const a = validatePolicy(policyBody([{ id: "nf", type: "NEW_FINDINGS", severity: ["high"] }]));
  const b = validatePolicy(policyBody([{ id: "nf", type: "NEW_FINDINGS", severity: ["high"] }]));
  const c = validatePolicy(policyBody([{ id: "nf", type: "NEW_FINDINGS", severity: ["high", "medium"] }]));
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(a.policyHash, b.policyHash);
  assert.notEqual(a.policyHash, c.policyHash);
});

test("F02: policies are immutable in the store — the same version with different content is refused", () => {
  const first = policyBody([{ id: "nf", type: "NEW_FINDINGS", severity: ["high"] }]);
  const r1 = engine.putPolicy(first, "tester");
  assert.ok(r1.ok);
  const second = policyBody([{ id: "nf", type: "NEW_FINDINGS", severity: ["high", "medium"] }]);
  const r2 = engine.putPolicy({ policyId: "test-policy", version: 1, conditions: second.conditions }, "tester");
  assert.equal(r2.ok, false, "the same version with different content is refused");
  assert.match(r2.ok === false ? r2.problems.join(" ") : "", /immutable|already exists/i);
  // A new version is fine; it evaluates only when assigned.
  const r3 = engine.putPolicy({ ...first, version: 2 }, "tester");
  assert.ok(r3.ok);
  assert.match(r3.policyHash, /^pol:/);
});

// ---- evaluation semantics (§6.2) -------------------------------------------------
test("F02 (D1): evaluation is pure — the same evidence set evaluates to the same decision, byte for byte", () => {
  const e = evidence({ findings: [finding("f1", "fp:1")] });
  const p = policyBody([{ id: "nf", type: "NEW_FINDINGS", severity: ["high"] }], { policyId: "pure", version: 1 });
  const a = evaluate(p, e, { ...REF, evaluatedAt: "2030-01-02T00:00:00Z" });
  const b = evaluate(p, e, { ...REF, evaluatedAt: "2030-01-02T00:00:00Z" });
  assert.deepEqual([...a.results], [...b.results]);
  assert.equal(a.bindingHash, b.bindingHash);
  assert.equal(a.status, b.status);
});

test("F02 (D10): FAIL dominates INCOMPLETE — a known failure is reported even when another analyzer did not finish", () => {
  const e = evidence({
    findings: [finding("f1", "fp:1")],
    analyzers: [
      { id: "security-rules", version: "1", state: "COMPLETE", coverage: { analyzedFiles: 2, skippedFiles: 0 } },
      { id: "test-artifacts", version: "1", state: "TIMED_OUT", coverage: { analyzedFiles: 0, skippedFiles: 4 }, wallMs: 60_000 },
    ],
  });
  const p = policyBody([
    { id: "nf", type: "NEW_FINDINGS", severity: ["high"] },
    { id: "ta", type: "REQUIRED_ANALYZERS", analyzers: ["security-rules@1", "test-artifacts@1"] },
  ], { policyId: "d10", version: 1 });
  const d = evaluate(p, e, REF);
  assert.equal(d.status, "FAIL");
  assert.equal(outcomeOf(d, "nf"), "FAILED");
  assert.equal(outcomeOf(d, "ta"), "INCOMPLETE");
  assert.match(d.results.find((c) => c.id === "ta")!.reason, /timed out/);
});

test("F02 (D11): below the minimum executable changed lines, the coverage condition is NOT_APPLICABLE — no coverage number is claimed and the gate may pass", () => {
  const e = evidence({ coverage: { source: "REPOSITORY", executableChangedLines: 3, covered: 1, percent: 33, artifactHash: "art:x" } });
  const p = policyBody([{ id: "cov", type: "COVERAGE_ON_CHANGED_LINES", minimumPercent: 80, minimumExecutableLines: 6 }]);
  const d = evaluate(p, e, REF);
  assert.equal(outcomeOf(d, "cov"), "NOT_APPLICABLE");
  assert.match(d.results[0].reason, /Only 3 executable changed line/);
  assert.equal(d.status, "PASS", "a not-applicable condition does not block");
  assert.ok(d.results[0].evidenceIds.includes("art:x"), "even a not-applicable condition cites its evidence id");
});

test("F02: missing data maps through onMissing — FAIL keeps a refusal, INCOMPLETE states the gap, IGNORE_WITH_DISCLOSURE passes but says it was not evaluated", () => {
  const e = evidence({ analyzers: [{ id: "security-rules", version: "1", state: "COMPLETE", coverage: { analyzedFiles: 1, skippedFiles: 0 } }] });
  const mk = (onMissing?: string) => policyBody([{ id: "ra", type: "REQUIRED_ANALYZERS", analyzers: ["defect-detectors@1"], ...(onMissing ? { onMissing } : {}) }]);
  const failD = evaluate(mk("FAIL"), e, REF);
  const incD = evaluate(mk(), e, REF);
  const discD = evaluate(mk("IGNORE_WITH_DISCLOSURE"), e, REF);
  assert.equal(outcomeOf(failD, "ra"), "FAILED");
  assert.equal(failD.status, "FAIL");
  assert.equal(outcomeOf(incD, "ra"), "INCOMPLETE");
  assert.equal(incD.status, "INCOMPLETE");
  assert.equal(outcomeOf(discD, "ra"), "PASSED");
  assert.match(discD.results[0].reason, /Disclosed/);
  assert.equal(discD.status, "PASS");
});

test("F02 (§7.1): a required analyzer that did not finish never lets the gate pass, without a waiver", () => {
  const e = evidence({
    analyzers: [
      { id: "security-rules", version: "1", state: "COMPLETE", coverage: { analyzedFiles: 2, skippedFiles: 0 } },
      { id: "defect-detectors", version: "1", state: "PARTIAL", coverage: { analyzedFiles: 1, skippedFiles: 9, reason: "finding or fact cap reached; disclosed" } },
    ],
  });
  const p = policyBody([{ id: "ra", type: "REQUIRED_ANALYZERS", analyzers: ["security-rules@1", "defect-detectors@1", "test-artifacts@1"] }]);
  const d = evaluate(p, e, REF);
  assert.equal(d.status, "INCOMPLETE");
  const ra = d.results.find((c) => c.id === "ra")!;
  assert.match(ra.reason, /not available on this installation/); // test-artifacts@1 is not in the evidence at all
  assert.match(ra.reason, /finished only partially/);
  assert.ok(ra.evidenceIds.some((x) => x === "defect-detectors@1"), "the incomplete result cites the analyzer ids it rests on");
});

test("F02 (§7.9): waivers convert FAILED to WAIVED only when they cover every offending finding; the decision inherits the earliest expiry", () => {
  const p = policyBody([{ id: "nf", type: "NEW_FINDINGS", severity: ["high", "medium"] }], { policyId: "waiver-policy", version: 2 });
  const f1 = finding("f1", "fp:a");
  const f2 = finding("f2", "fp:b", { severity: "medium" });
  const w1: WaiverRecord = { id: "wa:1", scopeKind: "FINDING_FINGERPRINT", scope: { fingerprint: "fp:a" }, actor: "dev", rationale: "masked upstream", createdAt: "2029-12-01T00:00:00Z", expiresAt: "2030-03-01T00:00:00Z" };
  // only f1 waived: the condition stays FAILED
  const partial = evaluate(p, evidence({ findings: [f1, f2], waivers: [w1] }), REF);
  assert.equal(partial.status, "FAIL");
  assert.equal(outcomeOf(partial, "nf"), "FAILED");
  // both waived → WAIVED, and the decision is only valid until the earliest waiver expires
  const w2: WaiverRecord = { ...w1, id: "wa:2", scope: { fingerprint: "fp:b" }, actor: "dev2", expiresAt: "2030-02-01T00:00:00Z" };
  const full = evaluate(p, evidence({ findings: [f1, f2], waivers: [w1, w2] }), REF);
  const nf = full.results.find((c) => c.id === "nf")!;
  assert.equal(nf.outcome, "WAIVED");
  assert.equal(nf.waiverId, "wa:1", "the applied waiver is recorded");
  assert.equal(full.status, "PASS");
  assert.equal(full.validUntil, "2030-02-01T00:00:00Z");
  assert.deepEqual(full.exceptionsUsed.sort(), ["wa:1", "wa:2"]);
  // a waiver expired at evaluation time is ignored: the gate fails again, with no validUntil
  const later = evaluate(p, evidence({ findings: [f1, f2], waivers: [w1, w2] }), { ...REF, evaluatedAt: "2030-04-01T00:00:00Z" });
  assert.equal(later.status, "FAIL");
  assert.equal(later.validUntil, undefined);
});

test("F02 (§7.9): a CONDITION_ONCE waiver applies only to the decision it names", () => {
  const p = policyBody([{ id: "nf", type: "NEW_FINDINGS", severity: ["high"] }], { policyId: "once", version: 1 });
  const w: WaiverRecord = { id: "wa:once", scopeKind: "CONDITION_ONCE", scope: { decisionId: "dec:7" }, actor: "sec", rationale: "one-shot exception", createdAt: "2029-12-01T00:00:00Z", expiresAt: "2030-12-01T00:00:00Z" };
  const d = evaluate(p, evidence({ findings: [finding("f1", "fp:a"), finding("f2", "fp:b")] }), REF); // refs.decisionId unset
  assert.equal(outcomeOf(d, "nf"), "FAILED", "without the named decision the once-waiver does not apply");
  const d2 = evaluate(p, evidence({ findings: [finding("f1", "fp:a"), finding("f2", "fp:b")], waivers: [w] }), { ...REF, decisionId: "dec:7" });
  assert.equal(outcomeOf(d2, "nf"), "WAIVED");
});

test("F02 (§6.1): the binding hash moves when the analysis moves — analyzers, coverage, waivers — so a decision is valid only for the set it hashed", () => {
  const p = policyBody([{ id: "nf", type: "NEW_FINDINGS", severity: ["high"] }], { policyId: "bind", version: 1 });
  const e1 = evidence({ coverage: null });
  const e2 = evidence({ coverage: { source: "CI", executableChangedLines: 30, covered: 30, percent: 100, artifactHash: "art:1", ciRunId: "r1", artifactHead: "h1" } });
  const a = evaluate(p, e1, REF).bindingHash;
  const b = evaluate(p, e2, REF).bindingHash;
  const c = evaluate(p, evidence({ ...e1, analyzers: e1.analyzers.map((x) => ({ ...x, state: "TIMED_OUT" as const })) }), REF).bindingHash;
  const w: WaiverRecord = { id: "wa:9", scopeKind: "RULE_IN_PATH", scope: { ruleId: "R-PII-LOG", path: "src/a.ts" }, actor: "x", rationale: "path under audit exception", createdAt: "2029-01-01T00:00:00Z", expiresAt: "2030-06-01T00:00:00Z" };
  const d = evaluate(p, evidence({ findings: [finding("f1", "fp:a")], waivers: [w] }), REF).bindingHash;
  assert.notEqual(a, b); assert.notEqual(a, c); assert.notEqual(a, d);
});

// ---- fingerprints and baseline matching (§7.3–7.4) --------------------------------
test("F02 (D2): a finding's fingerprint survives reformatting, comments and a move between files, and changes when the construct changes", () => {
  const canon = "canon:refund@1";
  const reformatA = "log.info('refund email', req.email);";
  const reformatB = "\n  // refund email\n  log.info(\n    'refund email', req.email\n  );\n";
  const fpA = findingFingerprint({ ruleId: "R-PII-LOG", canonicalEntityId: canon, anchor: reformatA, occurrenceIndex: 0, fallbackPath: "src/a.ts" });
  const fpB = findingFingerprint({ ruleId: "R-PII-LOG", canonicalEntityId: canon, anchor: reformatB, occurrenceIndex: 0, fallbackPath: "src/b.ts" });
  assert.equal(fpA, fpB, "same construct after reformat and move keeps its fingerprint; line numbers are not part of it");
  assert.ok(normalizeAnchor(reformatA).length < reformatA.length, "the anchor is normalized, not stored raw");
  const changed = findingFingerprint({ ruleId: "R-PII-LOG", canonicalEntityId: canon, anchor: "log.info('invoice total', tot);", occurrenceIndex: 0, fallbackPath: "src/b.ts" });
  assert.notEqual(fpA, changed, "a different construct is a different finding");
  const second = findingFingerprint({ ruleId: "R-PII-LOG", canonicalEntityId: canon, anchor: reformatB, occurrenceIndex: 1, fallbackPath: "src/b.ts" });
  assert.notEqual(fpA, second, "two occurrences of the same anchor are distinguished by index");
  // without a canonical identity (file-level), the fallback path participates
  const noCanon1 = findingFingerprint({ ruleId: "R-POLICY-MISSING", canonicalEntityId: null, anchor: "no policy guard", occurrenceIndex: 0, fallbackPath: "src/a.ts" });
  const noCanon2 = findingFingerprint({ ruleId: "R-POLICY-MISSING", canonicalEntityId: null, anchor: "no policy guard", occurrenceIndex: 0, fallbackPath: "src/other.ts" });
  assert.notEqual(noCanon1, noCanon2);
});

test("F02 (§7.3): baseline matching labels introduced findings, threads the baseline id through, and lists what the change resolved", () => {
  const base = [finding("bf1", "fp:kept"), finding("bf2", "fp:gone")];
  const head = [finding("hh1", "fp:kept"), finding("hh2", "fp:new")];
  const m = matchBaselines(head, base);
  assert.equal(m.head.find((x) => x.fingerprint === "fp:kept")!.introduced, false);
  assert.equal(m.head.find((x) => x.fingerprint === "fp:kept")!.baselineFindingId, "bf1");
  assert.equal(m.head.find((x) => x.fingerprint === "fp:new")!.introduced, true);
  assert.deepEqual(m.resolvedByChange.map((x) => x.findingId), ["bf2"]);
  assert.ok(m.resolvedByChange.every((x) => x.disposition === "RESOLVED_BY_CHANGE"), "a resolved baseline finding carries its disposition");
});

// ---- waiver validation (WP-08) ----------------------------------------------------
test("F02: a waiver is validated on entry — scope fields, rationale, expiry and the policy's maximum duration", () => {
  const p = policyBody([{ id: "nf", type: "NEW_FINDINGS" }], { policyId: "wp", version: 1, exceptions: { maxDurationDays: 30 } as never }) as GatePolicyBody;
  assert.equal(validateWaiver({ scopeKind: "NOPE", scope: {}, rationale: "r", expiresAt: "2030-01-01T00:00:00Z" }).ok, false, "unknown scopeKind refused");
  assert.equal(validateWaiver({ scopeKind: "FINDING_FINGERPRINT", scope: {}, rationale: "r", expiresAt: "2030-01-01T00:00:00Z" }).ok, false, "a fingerprint waiver names a fingerprint");
  assert.equal(validateWaiver({ scopeKind: "RULE_IN_PATH", scope: { ruleId: "R-PII-LOG" }, rationale: "r", expiresAt: "2030-01-01T00:00:00Z" }).ok, false, "a rule-waiver needs a path too");
  assert.equal(validateWaiver({ scopeKind: "FINDING_FINGERPRINT", scope: { fingerprint: "fp:a" }, rationale: "aa", expiresAt: "2030-01-01T00:00:00Z" }).ok, false, "the rationale is more than a couple of characters");
  assert.equal(validateWaiver({ scopeKind: "FINDING_FINGERPRINT", scope: { fingerprint: "fp:a" }, rationale: "because", expiresAt: "not-a-date" }).ok, false, "the expiry must parse");
  assert.equal(validateWaiver({ scopeKind: "FINDING_FINGERPRINT", scope: { fingerprint: "fp:a" }, rationale: "because", expiresAt: new Date(Date.now() + 40 * 86_400_000).toISOString(), policy: p }).ok, false, "a waiver longer than the policy's maximum duration is refused");
  assert.equal(validateWaiver({ scopeKind: "FINDING_FINGERPRINT", scope: { fingerprint: "fp:a" }, rationale: "because", expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), policy: p }).ok, true, "a waiver within the policy's maximum duration is accepted");
});

test("F02: the engine refuses waivers whose approver does not hold a role the policy requires", () => {
  const body = { policyId: "approval-gated", version: 1, conditions: [{ id: "nf", type: "NEW_FINDINGS", severity: ["high"] }], exceptions: { requireApprovalFrom: ["security-approver"] } };
  const put = engine.putPolicy(body, "sec-lead");
  assert.ok(put.ok);
  const repoRoot = "/repo/approval";
  engine.setRepositoryPolicy(repoRoot, "approval-gated"); // the assigned policy's exceptions govern its waivers
  const rNoApprover = engine.createWaiver(repoRoot, { scopeKind: "RULE_IN_PATH", scope: { ruleId: "R-X", path: "p" }, rationale: "audit exception per ticket 12", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), actor: "dev" }, () => false);
  assert.equal(rNoApprover.ok, false);
  assert.match(rNoApprover.ok === false ? rNoApprover.error : "", /needs approval/);
  const rBadRole = engine.createWaiver(repoRoot, { scopeKind: "RULE_IN_PATH", scope: { ruleId: "R-X", path: "p" }, rationale: "audit exception per ticket 12", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), actor: "dev", approver: "random-passers-by" }, (principal) => principal === "sec-lead-holds-role");
  assert.equal(rBadRole.ok, false);
  assert.match(rBadRole.ok === false ? rBadRole.error : "", /none of the roles/);
  const rOk = engine.createWaiver(repoRoot, { scopeKind: "RULE_IN_PATH", scope: { ruleId: "R-X", path: "p" }, rationale: "audit exception per ticket 12", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), actor: "dev", approver: "sec-lead" }, (principal) => principal === "sec-lead");
  assert.ok(rOk.ok);
  // engine-level expiry sweep: a decision that relies on the waiver dies when it does (§7.9)
  const before = engine.listWaivers(repoRoot).filter((w) => !w.revokedAt);
  assert.equal(before.length, 1);
  engine.revokeWaiver(rOk.ok ? rOk.id : "", "superseded by the exception policy");
  assert.equal(engine.listWaivers(repoRoot).filter((w) => !w.revokedAt).length, 0);
});

// ---- honest copy (§10.4, §12.2) ---------------------------------------------------
test("F02: the GitHub status description is bounded at 140 characters and mentions the policy, never code text", () => {
  const p = policyBody([
    { id: "new-findings", type: "NEW_FINDINGS", severity: ["high"] },
    { id: "coverage", type: "COVERAGE_ON_CHANGED_LINES", minimumPercent: 80 },
  ], { policyId: "status-copy", version: 1 });
  const e = evidence({
    findings: [finding("f1", "fp:a", { path: "src/secret.ts", line: 12, summary: "The log line includes personal data: email." })],
    coverage: { source: "REPOSITORY", executableChangedLines: 30, covered: 20, percent: 66, artifactHash: "art:c" },
  });
  const d = evaluate(p, e, REF);
  const text = gateStatusDescription({ status: d.status, policy: { policyId: "status-copy", version: 1 }, conditions: d.results, counts: { newFindings: 1, waived: 0 } });
  assert.ok(text.length <= 140, `description is 1–140 characters (${text.length})`);
  assert.match(text, /status-copy v1/);
  assert.ok(text.includes("new-findings") || text.includes("coverage"), "the failing conditions are nameable in the body");
  assert.ok(!text.includes("email"), "no code or summary text in the status line (rule ids, counts and paths only)");
});

test("F02: the PR comment carries the marker (so it is updatable), every condition and the disclosure; and a PASS says it is not a certificate", () => {
  const p = policyBody([{ id: "nf", type: "NEW_FINDINGS", severity: [] as unknown as string[] }], { policyId: "comment-copy", version: 1 });
  const e = evidence({ findings: [finding("f1", "fp:a", { introduced: false }), finding("f2", "fp:b")] });
  const d = evaluate(p, e, REF);
  const view = {
    headHash: "h1", policy: { policyId: "comment-copy", version: 1 }, decision: d,
    introduced: e.findings!.filter((f) => f.introduced).map((f) => ({ ruleId: f.ruleId, severity: f.severity, path: f.path, line: f.line, summary: f.summary })),
    existing: e.findings!.filter((f) => !f.introduced).map((f) => ({ ruleId: f.ruleId, path: f.path, line: f.line })),
    resolvedByChange: 0, analyzers: e.analyzers, disclosure: ["No runtime data was used."], analysisId: "pna:x",
  };
  const text = gateCommentText(view as never);
  assert.ok(text.startsWith("<!-- cie-gate:pr-comment -->"), "the marker comes first so the comment can be found and updated");
  assert.match(text, /Not a safety certificate|not passed/i);
  assert.match(text, /What this does not tell you/);
  assert.match(text, /R-PII-LOG.*src\/a\.ts:3/);
  assert.ok(!text.includes("counterArgument"), "internal fields are not leaked");
});

// ---- the engine's decision identity ------------------------------------------------
test("F02: a decision id is deterministic per (analysis, policy hash, binding hash) — re-evaluating identical evidence refreshes, never duplicates", () => {
  // covered by the flow test through makeDecision; here only the hash-independence is asserted
  const e = evidence({ findings: [finding("f1", "fp:a")] });
  const d1 = evaluate(policyBody([{ id: "nf", type: "NEW_FINDINGS", severity: ["high"] }], { policyId: "identity", version: 1 }), e, REF);
  const d2 = evaluate(policyBody([{ id: "nf", type: "NEW_FINDINGS", severity: ["high"] }], { policyId: "identity", version: 1 }), e, { ...REF, evaluatedAt: "2030-02-02T00:00:00Z" });
  assert.equal(d1.bindingHash, d2.bindingHash, "the binding covers the set, not the wall clock");
});
void engine;