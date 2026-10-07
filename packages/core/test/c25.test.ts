import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { ALARM_ROLE, grantRole } from "../src/claim-ledger.ts";
import { applyVerdict } from "../src/claims.ts";
import { RULES, Security, sensitiveLogArgs } from "../src/security.ts";
import { ctx, setup } from "./helpers.ts";

const REPO = resolve(import.meta.dirname, "../../../fixtures/security-repo");
async function world() { const t = await setup(undefined, REPO); return { ...t, sec: new Security(t.svc.store) }; }
const subjects = (fs: { ruleId: string; summary: string }[], rule: string) => fs.filter((f) => f.ruleId === rule).map((f) => f.summary);

test("seeded leak and authorisation gaps: the seeded password/email log and the unguarded delete are found, each with cited evidence and a counter-argument", async () => {
  const { sec, revision, worker, svc } = await world();
  const fs = sec.analyze({ revision });
  const pii = subjects(fs, "R-PII-LOG");
  assert.ok(pii.some((s) => /registerUser logs req\.body\.email, req\.body\.password without masking it/.test(s)), pii.join("|"));
  assert.ok(pii.some((s) => /legacyExport logs user\.ssn/.test(s)), "a leak in unreachable code is still a leak in the code");
  const high = fs.find((f) => /registerUser/.test(f.summary))!;
  assert.equal(high.severity, "high");
  const authz = subjects(fs, "R-AUTHZ-GAP");
  assert.equal(authz.length, 1, authz.join("|"));
  assert.match(authz[0], /deleteAccountHandler reaches removeAccount, which changes deleted, and nothing on the way can refuse the caller/);
  for (const f of fs) {
    assert.ok(f.evidenceIds.length > 0 && f.evidenceIds.every((id) => svc.store.evidence(revision, id)), `${f.id} cites stored evidence`);
    assert.ok(f.counterArgument.length > 0 && f.assumptions.length > 0);
    assert.equal(f.state, "CANDIDATE");
    assert.match(f.disclaimer, /No finding does not mean safe/);
    const claim = svc.store.getClaim(f.claimId)!;
    assert.notEqual(claim.displayMode, "FACT", "a finding is an inference at best");
  }
  // The finding's evidence is the actual bytes of the log call.
  const ev = svc.store.evidence(revision, high.evidenceIds[0])!;
  const resolved = svc.resolveEvidence(svc.store.revision(revision)!, ev);
  assert.match(resolved.snippet, /console\.log\("new user", req\.body\.email, req\.body\.password\)/);
  worker.close();
});

test("false paths: sanitised, constant, length-only, commented and quoted logging is not reported, and a guarded write is not an authorisation gap", async () => {
  const { sec, revision, worker } = await world();
  const fs = sec.analyze({ revision });
  const flagged = fs.map((f) => f.summary).join("\n");
  // Scoped to R-PII-LOG: ping does call console.log (R-DEBUG-LEFTOVER has its own opinion about that), the point
  // here is only that none of those calls leak a sensitive value.
  const piiFlagged = fs.filter((f) => f.ruleId === "R-PII-LOG").map((f) => f.summary).join("\n");
  assert.ok(!/\bping\b/.test(piiFlagged), "ping logs only constants, hashes, masks, a length, a string and a comment");
  assert.ok(!/updateProfileHandler/.test(flagged), "the owner is checked before the write");
  assert.ok(!/saveProfile/.test(flagged));
  // The detector on its own, over the ways code can look sensitive without being so.
  const hits = (src: string) => sensitiveLogArgs(src).flatMap((h) => h.ids);
  assert.deepEqual(hits('console.log("password", password)'), ["password"]);
  assert.deepEqual(hits('console.log("password is", 12)'), []);
  assert.deepEqual(hits("console.log(hash(password))"), []);
  assert.deepEqual(hits("console.log(maskEmail(user.email))"), []);
  assert.deepEqual(hits("console.log(password.length)"), []);
  assert.deepEqual(hits("// console.log(password)\nconst x = 1;"), []);
  assert.deepEqual(hits('const s = "console.log(password)";'), []);
  assert.deepEqual(hits("logger.error(`failed for ${token}`, token)"), ["token"]);
  assert.deepEqual(hits("console.log(user.emailVerified ? 1 : 0)"), ["user.emailVerified"], "a name that contains a sensitive word is still a candidate: it is shown with its counter-argument, not hidden");
  assert.deepEqual(hits("notALogger.log(password)"), [], "only logging calls");
  worker.close();
});

test("missing policy: a required policy that is not declared is a finding; declared ones are reported as 'none found' or 'violation candidates', never as met", async () => {
  const { sec, revision, worker } = await world();
  const fs = sec.analyze({ revision, policyIds: ["POL-PII-1", "POL-AUTHZ-1", "POL-RETENTION-9"] });
  const missing = fs.filter((f) => f.ruleId === "R-POLICY-MISSING");
  assert.equal(missing.length, 1);
  assert.match(missing[0].summary, /POL-RETENTION-9 is not declared/);
  const st = sec.policyStatus(revision);
  assert.deepEqual(st.map((p) => [p.id, p.status]), [["POL-PII-1", "VIOLATION_CANDIDATES"], ["POL-AUTHZ-1", "VIOLATION_CANDIDATES"]]);
  // A repository with the rule disabled shows "none found", which is not "met".
  const off = new Security(sec.store);
  const none = off.analyze({ revision, rules: { "R-PII-LOG": { ...RULES["R-PII-LOG"], version: 2, enabled: false } } });
  assert.ok(!none.some((f) => f.ruleId === "R-PII-LOG"));
  const narrative = sec.buildAuditNarrative(revision, fs.map((f) => f.id));
  assert.match(narrative.markdown, /not a statement that it is met|violation candidate/);
  assert.match(narrative.markdown, /candidate \(inference, not confirmed\)/);
  assert.deepEqual(narrative.missingControls, ["POL-RETENTION-9"]);
  assert.match(narrative.markdown, /No finding does not mean safe/);
  worker.close();
});

test("alarm gating: a finding becomes an alarm only with deterministic proof or two authorised confirmations; a model's accusation, one approver, or an unauthorised pair is not enough", async () => {
  const { sec, revision, worker, svc } = await world();
  const fs = sec.analyze({ revision });
  const authz = fs.find((f) => f.ruleId === "R-AUTHZ-GAP")!, pii = fs.find((f) => /registerUser/.test(f.summary))!;
  // Nothing supplied: stays a candidate.
  assert.equal(sec.gateSecurityAlarm(authz.id, { proofEvidenceIds: [] }).ok, false);
  // The call chain's resolved edges are deterministic proof.
  const proof = authz.evidenceIds.filter((id) => svc.store.evidence(revision, id)!.class === "STATIC_RESOLVED");
  assert.ok(proof.length > 0, "the route cites resolved call edges");
  const viaProof = sec.gateSecurityAlarm(authz.id, { proofEvidenceIds: proof });
  assert.equal(viaProof.ok, true); assert.equal(viaProof.basis, "DETERMINISTIC_PROOF");
  assert.equal(sec.get(authz.id)!.state, "ALARM");
  // A parsed log call is evidence, but not resolved proof: it needs people.
  assert.equal(sec.gateSecurityAlarm(pii.id, { proofEvidenceIds: pii.evidenceIds }).ok, false, "parsed text is not proof");
  const claim = svc.store.getClaim(pii.claimId)!;
  applyVerdict(svc.store, { claimId: claim.draft.id, verdict: "CONFIRM", explanation: "real", actorId: "alice", expectedVersion: claim.version });
  grantRole(svc.store, "alice", ALARM_ROLE);
  assert.equal(sec.gateSecurityAlarm(pii.id, { proofEvidenceIds: [] }).ok, false, "one approver is not two");
  applyVerdict(svc.store, { claimId: claim.draft.id, verdict: "CONFIRM", explanation: "agree", actorId: "mallory", expectedVersion: claim.version + 1 });
  assert.equal(sec.gateSecurityAlarm(pii.id, { proofEvidenceIds: [] }).ok, false, "the second is not authorised");
  grantRole(svc.store, "mallory", ALARM_ROLE);
  const two = sec.gateSecurityAlarm(pii.id, { proofEvidenceIds: [] });
  assert.equal(two.ok, true); assert.equal(two.basis, "TWO_CONFIRMATIONS");
  // A model's accusation: INFERRED evidence, no proof; confirmations by a model name do not exist as roles.
  const ev = svc.store.evidence(revision, pii.evidenceIds[0])!;
  svc.store.putEvidence(revision, { ...ev, id: "ev:model-reading", class: "INFERRED" });
  const accusation = sec.proposeFromModel(revision, { title: "Possible backdoor", summary: "The login flow looks like it has a backdoor.", evidenceIds: ["ev:model-reading"] });
  assert.equal(accusation.state, "CANDIDATE"); assert.equal(accusation.source, "MODEL");
  const g = sec.gateSecurityAlarm(accusation.id, { proofEvidenceIds: ["ev:model-reading"] });
  assert.equal(g.ok, false);
  assert.match(g.reasons.join(" "), /INFERRED, not deterministic proof/);
  assert.equal(sec.get(accusation.id)!.state, "CANDIDATE");
  // A refuted finding can no longer alarm, whatever else is supplied.
  const c2 = svc.store.getClaim(authz.claimId)!;
  applyVerdict(svc.store, { claimId: c2.draft.id, verdict: "REFUTE", explanation: "a gateway checks", actorId: "bob", expectedVersion: c2.version });
  assert.equal(sec.gateSecurityAlarm(authz.id, { proofEvidenceIds: proof }).ok, false);
  worker.close();
});

test("rule version traceability: each finding records the rule and version that fired it; a changed rule makes new findings and supersedes the old ones, which stay readable", async () => {
  const { sec, revision, worker } = await world();
  const v1 = sec.analyze({ revision });
  const f1 = v1.find((f) => f.ruleId === "R-PII-LOG")!;
  assert.equal(f1.ruleVersion, 1); assert.match(f1.ruleDigest, /^[0-9a-f]{12}$/);
  const t1 = sec.ruleTrace(f1.id)!;
  assert.deepEqual([t1.firedUnderVersion, t1.changedSince, t1.superseded], [1, false, false]);
  // The rule is tightened and re-versioned.
  const next = { ...RULES["R-PII-LOG"], version: 2, text: RULES["R-PII-LOG"].text + " Email addresses are only reported when combined with a secret." };
  const v2 = sec.analyze({ revision, rules: { "R-PII-LOG": next } });
  const f2 = v2.find((f) => f.ruleId === "R-PII-LOG" && f.subject === f1.subject)!;
  assert.notEqual(f2.id, f1.id, "a finding under a new rule version is a new finding");
  assert.equal(f2.ruleVersion, 2); assert.notEqual(f2.ruleDigest, f1.ruleDigest);
  const old = sec.get(f1.id)!;
  assert.equal(old.superseded, true, "the old finding is marked superseded, not deleted");
  assert.equal(old.ruleVersion, 1, "and still says which version fired it");
  assert.deepEqual(sec.list(revision).filter((f) => f.ruleId === "R-PII-LOG").every((f) => f.ruleVersion === 2), true, "only current-version findings are listed");
  assert.ok(sec.list(revision, { includeSuperseded: true }).some((f) => f.id === f1.id), "and the old ones are still there");
  const trace = sec.ruleTrace(f1.id, { ...RULES, "R-PII-LOG": next })!;
  assert.deepEqual([trace.firedUnderVersion, trace.currentVersion, trace.changedSince, trace.superseded], [1, 2, true, true]);
  worker.close();
});

test("proof and test evidence: an invariant is supported by passing tests that reach it, refuted by failing ones, and not established by an argument; it is never called proven", async () => {
  const { cpSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const junit = (failing: boolean) => `<?xml version="1.0"?><testsuites><testsuite name="profile" tests="2" failures="${failing ? 1 : 0}">
    <testcase classname="profile" name="lets the owner rename" file="tests/profile.test.ts" time="0.01"/>
    <testcase classname="profile" name="saves a profile name" file="tests/profile.test.ts" time="0.01">${failing ? '<failure message="expected Z got B">x</failure>' : ""}</testcase></testsuite></testsuites>`;
  const run = async (results: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "cie-sec-"));
    cpSync(REPO, dir, { recursive: true });
    rmSync(join(dir, "test-results"), { recursive: true, force: true });
    if (results) { const { mkdirSync } = await import("node:fs"); mkdirSync(join(dir, "test-results")); writeFileSync(join(dir, "test-results/junit.xml"), results); }
    const t = await setup(undefined, dir);
    const out = new Security(t.svc.store).checkInvariant(t.revision, { entityIds: ["function:src/data/store.ts#saveProfile"] });
    t.worker.close();
    return out;
  };
  const none = await run(null);
  assert.ok(none.tests.length >= 2 && none.tests.every((t) => t.status === "unknown"), "tests reach it but have no results: that is not a pass");
  assert.equal(none.status, "NOT_ESTABLISHED");
  const passing = await run(junit(false));
  assert.equal(passing.status, "SUPPORTED_BY_TESTS");
  assert.match(passing.reason, /support, not proof/);
  assert.ok(passing.tests.every((t) => t.status === "passed" && t.evidenceIds.length > 0));
  assert.ok(passing.assumptions.some((a) => /assert the property/.test(a)) && passing.assumptions.some((a) => /passing test/.test(a)));
  const failing = await run(junit(true));
  assert.equal(failing.status, "COUNTEREXAMPLE");
  assert.match(failing.reason, /saves a profile name fails/);
  for (const r of [none, passing, failing]) { assert.equal(r.proof, false); assert.doesNotMatch(JSON.stringify(r), /\bproven\b|\bcertified\b/i); assert.match(r.disclaimer, /No finding does not mean safe/); }
  // Code no test reaches: an argument is not enough.
  const { sec, revision, worker } = await world();
  const unreached = sec.checkInvariant(revision, { entityIds: ["function:src/data/store.ts#removeAccount"] });
  assert.equal(unreached.status, "NOT_ESTABLISHED");
  assert.match(unreached.reason, /an argument without a test or a verifier is not proof/);
  worker.close();
});
