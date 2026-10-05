import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { materializeCandidate } from "../src/feature/candidate.ts";
import { rawHash } from "../src/feature/canon.ts";
import { DEFAULT_OVERLAP_POLICY, alreadySupported, coversCriterion, loadAliases, overlapPolicyHash, STRATEGIES } from "../src/feature/overlap.ts";
import type { AcceptanceCriterion, CapabilityRef, FeatureRecord, Requirement } from "../src/feature/types.ts";
import { boot, createEdit, none } from "./feature-boot.ts";

const FILES: Record<string, string> = {
  "src/auth/permissions.ts": "export const authorize = (role: string) => { if (role !== 'finance') throw new Error('denied'); };\n",
  "src/export/transactionExport.ts": "import { authorize } from '../auth/permissions';\nexport function exportTransactions(tenantId: string, rows: unknown[]): string {\n  authorize('finance');\n  return rows.map((r) => JSON.stringify({ tenantId, r })).join('\\n');\n}\n",
  "src/api/exportController.ts": "import { exportTransactions } from '../export/transactionExport';\nexport const handle = (t: string) => exportTransactions(t, []);\n",
  "tests/transactionExport.test.ts": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { exportTransactions } from '../src/export/transactionExport';\ntest('exports transactions as csv rows', () => { assert.equal(exportTransactions('t', [1]).split('\\n').length, 1); });\n",
  "src/reports/reportMailer.ts": "export async function exportReportAndEmail(rows: unknown[]) {\n  await sendMail({ to: 'ops', body: String(rows.length) });\n  db.insert('reports', rows);\n  return rows.length;\n}\n",
  "src/export/publicExport.ts": "export function publicExportTransactions(rows: unknown[]): string {\n  return rows.map((r) => JSON.stringify(r)).join('\\n');\n}\n",
  "src/export/betaExport.ts": "import { authorize } from '../auth/permissions';\nexport function betaExportTransactions(rows: unknown[]) {\n  if (!isEnabled('betaCsvExport')) return '';\n  authorize('finance');\n  return rows.map((r) => JSON.stringify(r)).join('\\n');\n}\n",
  "config/flags.json": JSON.stringify({ betaCsvExport: false }),
  "tests/betaExport.test.ts": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { betaExportTransactions } from '../src/export/betaExport';\ntest('exports transactions as csv rows', () => { assert.ok(betaExportTransactions([1])); });\n",
  "src/export/brokenExport.ts": "import { authorize } from '../auth/permissions';\nexport function brokenExportTransactions(rows: unknown[]) { authorize('finance'); return rows.length; }\n",
  "tests/brokenExport.test.ts": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { brokenExportTransactions } from '../src/export/brokenExport';\ntest.skip('exports transactions as csv rows', () => { assert.equal(brokenExportTransactions([1]), 1); });\n",
  "src/billing/statementDownload.ts": "import { authorize } from '../auth/permissions';\nexport function statementDownload(rows: unknown[]): string { authorize('finance'); return rows.map((r) => JSON.stringify(r)).join('\\n'); }\n",
  "tests/statementDownload.test.ts": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { statementDownload } from '../src/billing/statementDownload';\ntest('downloads transactions as csv rows', () => { assert.equal(statementDownload([1]).length > 0, true); });\n",
  "src/export/untestedExport.ts": "import { authorize } from '../auth/permissions';\nexport function untestedExportTransactions(rows: unknown[]) { authorize('finance'); return rows.map((r) => JSON.stringify(r)).join('\\n'); }\n",
  "tests/export/areaChecks.test.ts": "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('exports transactions as csv rows for finance', () => { assert.equal(['a'].join('\\n'), 'a'); });\n",
};
const prepare = (extra: Record<string, string> = {}) => (repo: string) => { for (const [f, t] of Object.entries({ ...FILES, ...extra })) { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), t); } };
const rq = (id: string, text: string, over: Partial<Requirement> = {}): Requirement => ({ id, text, type: "FUNCTIONAL", origin: "USER", status: "ACTIVE", actorIds: [], conditions: [], dependsOn: [], acceptanceIds: [], source: { artifactId: "p", version: "1", locator: "prompt", contentHash: "h" }, ...over });
const ac = (id: string, requirementIds: string[], scenario: string, expectedOutcome: string): AcceptanceCriterion => ({ id, requirementIds, scenario, expectedOutcome, mandatory: true, oracleSourceRefs: [], oracleOrigin: "GENERATED_UNREVIEWED", validationKinds: ["UNIT"] });

async function world(o: { requirements?: Requirement[]; acceptance?: AcceptanceCriterion[]; extra?: Record<string, string> } = {}) {
  const b = await boot({ prepare: prepare(o.extra) });
  const rec = b.fs.getRequest(b.rid)!;
  b.fs.updateRequest(b.rid, rec.version, { ...rec, contract: { ...rec.contract!, hash: "contract-overlap", requirements: o.requirements ?? [rq("R1", "Export transactions as CSV for finance members")], acceptance: o.acceptance ?? [ac("AC1", ["R1"], "Export transactions", "CSV of transaction rows")] } });
  const call = (key: string, body: unknown, who = "arun") => b.h[key]!(b.as(who, `i-${Math.random()}`), body);
  const rec2 = () => b.fs.getRequest(b.rid)!;
  const find = async (scope = "", budget = 5000) => { const r = await call("C10/findRelatedCapabilities", { contractHash: "contract-overlap", snapshot: rec2().source, scope, budget: { files: budget } }); assert.ok(r.ok, JSON.stringify(r)); return r.value as { status: string; value: { capabilities: CapabilityRef[]; coverage: any[] }; diagnostics: string[] }; };
  const only = (caps: CapabilityRef[], file: string) => caps.filter((c) => c.sourceRefs[0]!.locator === `repo:${file}`);
  const compare = async (refs: CapabilityRef[], evidenceIds: string[] = []) => { const r = await call("C15/compareRequestedBehaviour", { contractHash: "contract-overlap", capabilityRefs: refs, evidenceIds }); assert.ok(r.ok, JSON.stringify(r)); return r.value as { value: any; diagnostics: string[] }; };
  const verify = (id: string, ids: string[] = []) => call("C16/verifyOverlap", { assessmentId: id, policyHash: overlapPolicyHash(), evidenceIds: ids });
  return { ...b, call, rec: rec2, find, only, compare, verify };
}

test("PF-057/062 related capabilities are found by name and identifier within the searched scope; tests are not capabilities; coverage says what was and was not searched", async () => {
  const w = await world();
  try {
    const r = await w.find(); assert.equal(r.status, "COMPLETE"); const files = r.value.capabilities.map((c) => c.sourceRefs[0]!.locator.slice(5));
    assert.ok(files.includes("src/export/transactionExport.ts") && !files.some((f) => f.startsWith("tests/")), JSON.stringify(files)); assert.ok(r.value.capabilities.length <= 12);
    const cap = w.only(r.value.capabilities, "src/export/transactionExport.ts")[0]!; assert.match(cap.id, /^cap:[0-9a-f]{16}$/); assert.deepEqual(cap.entryPoints, ["src/export/transactionExport.ts#exportTransactions"]); assert.deepEqual(cap.requirementIds, ["R1"]); assert.equal(cap.sourceRefs[0]!.contentHash, rawHash(FILES["src/export/transactionExport.ts"]!)); assert.equal(cap.availability, "UNKNOWN", "implemented does not mean deployed or reachable");
    const cov = r.value.coverage[0]; assert.deepEqual([cov.domain, cov.state, cov.found], ["CAPABILITIES", "COMPLETE_WITHIN_SCOPE", "FOUND"]); assert.ok(cov.excluded.some((e: any) => /tests are evidence/.test(e.reason))); assert.match(r.diagnostics[0]!, /a name match is a lead, not evidence of equivalence/);
    const scoped = await w.find("src/reports"); assert.deepEqual(scoped.value.capabilities.map((c) => c.sourceRefs[0]!.locator.slice(5)), ["src/reports/reportMailer.ts"], "scope limits the search to a path prefix");
    const none_ = await w.find("docs"); assert.equal(none_.value.capabilities.length, 0); assert.equal(none_.value.coverage[0].found, "NOT_FOUND_WITHIN_SEARCHED_SCOPE"); assert.match(none_.diagnostics[0]!, /nothing matched within the searched scope; that is not a statement about the whole repository/);
    const small = await w.find("", 3); assert.equal(small.status, "PARTIAL"); assert.equal(small.value.coverage[0].state, "PARTIAL"); assert.match(small.value.coverage[0].unresolved[0], /stopped after 3 files/);
  } finally { w.close(); }
});

test("PF-062 availability is reported separately from implementation: a flag the repository's own configuration turns off marks the capability DISABLED", async () => {
  const w = await world();
  try { const caps = (await w.find()).value.capabilities; assert.equal(w.only(caps, "src/export/betaExport.ts")[0]!.availability, "DISABLED"); assert.notEqual(w.only(caps, "src/export/betaExport.ts")[0]!.configBindingHash, w.only(caps, "src/export/transactionExport.ts")[0]!.configBindingHash); } finally { w.close(); }
});

test("access and input checks for the search: denied paths are absent and uncounted, stale snapshots are STALE, unsafe scopes and budgets are refused, other people's contracts read as absent", async () => {
  const w = await world();
  try {
    w.svc.store.db.prepare("insert into access_deny(repo_root, prefix) values (?, ?)").run(w.repo, "src/reports");
    const r = await w.find(); assert.ok(!JSON.stringify(r).includes("reportMailer") && !JSON.stringify(r).includes("src/reports"), "a denied capability is never named"); assert.match(r.value.coverage[0].unresolved.join(" "), /path\(s\) were left out by access policy/);
    const call = (b: Record<string, unknown>, who = "arun") => w.call("C10/findRelatedCapabilities", { contractHash: "contract-overlap", snapshot: w.rec().source, scope: "", budget: { files: 100 }, ...b }, who);
    for (const [b, code] of [[{ scope: "../x" }, "INVALID_SCHEMA"], [{ scope: "/etc" }, "INVALID_SCHEMA"], [{ budget: { files: 0 } }, "INVALID_SCHEMA"], [{ budget: { files: 10_000_000 } }, "INVALID_SCHEMA"], [{ contractHash: "nope" }, "NOT_FOUND"], [{ snapshot: { ...w.rec().source, repositoryId: "/other" } }, "INVALID_SCHEMA"]] as const) { const x = await call(b); assert.ok(!x.ok && x.error.code === code, JSON.stringify(b)); }
    assert.equal((await call({}, "mallory")).error.code, "NOT_FOUND");
    writeFileSync(join(w.repo, "src/late.ts"), "export {};\n"); assert.equal((await call({})).value.status, "STALE");
  } finally { w.close(); }
});

test("AT-49 request X+Y where X exists: X is REUSED with its test as evidence, Y is NEW, the request EXTENDS the existing capability, and X's tests become regression obligations", async () => {
  const w = await world({ requirements: [rq("R1", "Export transactions as CSV"), rq("R2", "Email recipients a link to the export")], acceptance: [ac("AC1", ["R1"], "Export transactions", "CSV of transaction rows"), ac("AC2", ["R2"], "Recipients get an email link", "an email with a download link is sent")] });
  try {
    const refs = w.only((await w.find()).value.capabilities, "src/export/transactionExport.ts"); const out = await w.compare(refs); const a = out.value;
    assert.deepEqual([a.relationship, a.strategy, a.verified], ["REQUEST_EXTENDS_EXISTING", "EXTEND", false]); const m = Object.fromEntries(a.mappings.map((x: any) => [x.acceptanceId, x]));
    assert.equal(m.AC1.disposition, "REUSED"); assert.equal(m.AC1.capabilityIds[0], refs[0]!.id); assert.ok(m.AC1.evidenceIds.length >= 1); assert.equal(m.AC2.disposition, "NEW"); assert.deepEqual(m.AC2.capabilityIds, []);
    assert.deepEqual(a.regressionObligations, ["tests/transactionExport.test.ts must keep passing for src/export/transactionExport.ts"]); assert.ok(a.alternatives.some((x: string) => /SEPARATE: a parallel implementation needs a justified reason/.test(x)));
    assert.equal(w.rec().contract!.overlap!.id, a.id, "the assessment is stored on the contract"); assert.ok(a.observations.some((o: any) => o.kind === "ACCESS_CHECK") && a.observations.some((o: any) => o.kind === "TENANT_SCOPE") && a.observations.some((o: any) => o.kind === "ENTRY_POINT") && a.observations.every((o: any) => /^[0-9a-f]{64}$/.test(o.contentHash)));
    assert.match(out.diagnostics.join(" "), /a similarity match is a retrieval signal, never evidence of equivalence/);
    const again = await w.compare(refs); assert.equal(again.value.id, a.id, "the same comparison has the same identity");
  } finally { w.close(); }
});

test("AT-51 a similar feature that lacks the permission and tenant rule the request needs is RELATED_INCOMPATIBLE; reuse that would bypass it is refused, keeping it separate is allowed", async () => {
  const w = await world({ requirements: [rq("R1", "Only members of the current tenant with the finance role can export transactions", { type: "ACCESS", actorIds: ["finance"], conditions: ["current tenant"] })], acceptance: [ac("AC1", ["R1"], "Export transactions", "CSV of transaction rows")] });
  try {
    const refs = w.only((await w.find()).value.capabilities, "src/export/publicExport.ts"); const a = (await w.compare(refs)).value;
    assert.deepEqual([a.relationship, a.strategy, a.mappings[0].disposition], ["RELATED_INCOMPATIBLE", "SEPARATE", "NEW"]); assert.ok(a.differences.some((d: any) => d.dimension === "Actors/access" && /needs a permission check and the existing capability has none/.test(d.detail)) && a.differences.some((d: any) => /tenancy/.test(d.detail)));
    const snap = w.rec().source;
    for (const strategy of ["EXTEND", "COMPOSE", "CONFIGURE", "NO_CHANGE", "REFACTOR_AND_REUSE"]) { const r = await w.call("C23/assessReuseImpact", { assessmentId: a.id, strategy, snapshot: snap }); assert.ok(!r.ok && r.error.code === "FORBIDDEN" && /would bypass a requirement the existing capability does not meet/.test(r.error.message), strategy); }
    const sep = await w.call("C23/assessReuseImpact", { assessmentId: a.id, strategy: "SEPARATE", snapshot: snap }); assert.ok(sep.ok, JSON.stringify(sep)); assert.ok(sep.value.value.reasons.some((x: string) => /kept separate because the existing capability does not enforce what the request requires/.test(x)));
  } finally { w.close(); }
});

test("AT-52 an implemented capability that is switched off is reported as implemented AND unavailable; the right move is to configure it, not to rebuild it", async () => {
  const w = await world();
  try {
    const refs = w.only((await w.find()).value.capabilities, "src/export/betaExport.ts"); assert.equal(refs[0]!.availability, "DISABLED"); const a = (await w.compare(refs)).value;
    assert.deepEqual([a.relationship, a.strategy, a.mappings[0].disposition], ["CONFIGURATION_ONLY", "CONFIGURE", "REUSED"]); assert.ok(a.differences.some((d: any) => d.dimension === "Availability" && /implemented but disabled by betaCsvExport/.test(d.detail))); assert.ok(a.observations.some((o: any) => o.kind === "CONFIG_FLAG" && o.detail === "betaCsvExport=false"));
    const snap = w.rec().source; const cfg = await w.call("C23/assessReuseImpact", { assessmentId: a.id, strategy: "CONFIGURE", snapshot: snap }); assert.ok(cfg.ok, JSON.stringify(cfg)); assert.deepEqual(cfg.value.value.affectedIds, [], "configuring changes no source file");
    const noChange = await w.call("C23/assessReuseImpact", { assessmentId: a.id, strategy: "NO_CHANGE", snapshot: snap }); assert.ok(!noChange.ok && /NO_CHANGE needs a verified equivalence/.test(noChange.error.message), "disabled is not the same as already available");
  } finally { w.close(); }
});

test("AT-53 a high-similarity capability with different side effects is not equivalent: it also sends email and writes a record the request never asked for", async () => {
  const w = await world({ requirements: [rq("R1", "Export transactions as a read-only CSV")], acceptance: [ac("AC1", ["R1"], "Export transactions report", "CSV report of transactions")] });
  try {
    const refs = w.only((await w.find()).value.capabilities, "src/reports/reportMailer.ts"); const a = (await w.compare(refs)).value;
    assert.deepEqual([a.relationship, a.strategy, a.mappings[0].disposition], ["RELATED_INCOMPATIBLE", "SEPARATE", "NEW"]); const d = a.differences.find((x: any) => x.dimension === "State/effects"); assert.match(d.detail, /also does email, database-write, which the request did not ask for/);
  } finally { w.close(); }
});

test("AT-54 an existing capability whose tests are skipped is an EXISTING_DEFECT: repair X (MODIFIED) and build Y (NEW) are separate obligations", async () => {
  const w = await world({ requirements: [rq("R1", "Export transactions as CSV"), rq("R2", "Notify finance by chat when the export is ready")], acceptance: [ac("AC1", ["R1"], "Export transactions", "CSV of transaction rows"), ac("AC2", ["R2"], "Finance is notified in chat", "a chat message announces the export is ready")] });
  try {
    const refs = w.only((await w.find()).value.capabilities, "src/export/brokenExport.ts"); const a = (await w.compare(refs)).value; const m = Object.fromEntries(a.mappings.map((x: any) => [x.acceptanceId, x]));
    assert.equal(a.relationship, "EXISTING_DEFECT"); assert.deepEqual([m.AC1.disposition, m.AC2.disposition], ["MODIFIED", "NEW"]); assert.ok(m.AC1.differences.some((x: string) => /tests for the existing capability are skipped/.test(x))); assert.ok(a.observations.some((o: any) => o.kind === "SKIPPED_TEST"));
  } finally { w.close(); }
});

test("AT-50/AT-60 the same feature under another name is found through the glossary, shown as verified equivalent with its evidence, closed as ALREADY_SUPPORTED, and the candidate engine refuses to change anything", async () => {
  const w = await world({ extra: { ".cie/glossary.json": JSON.stringify({ terms: { export: ["download", "statement"] } }) } });
  try {
    const found = (await w.find()).value.capabilities; const refs = w.only(found, "src/billing/statementDownload.ts"); assert.equal(refs.length, 1, "found by an alias, not by its name");
    const a = (await w.compare(refs)).value; assert.deepEqual([a.relationship, a.strategy, a.mappings[0].disposition], ["EQUIVALENT", "NO_CHANGE", "REUSED"]); assert.equal(a.verified, false, "equivalence is not yet verified"); assert.match(a.reasons.join(" "), /still needs verifyOverlap/);
    assert.equal(alreadySupported(w.rec()), null, "nothing is closed on an unverified claim");
    const bad = await w.verify(a.id, ["obs:nonexistent"]); assert.ok(!bad.ok && bad.error.code === "NOT_FOUND"); const stalePolicy = await w.call("C16/verifyOverlap", { assessmentId: a.id, policyHash: "x", evidenceIds: [] }); assert.ok(!stalePolicy.ok && stalePolicy.error.code === "STALE_REVISION");
    const v = await w.verify(a.id); assert.ok(v.ok, JSON.stringify(v)); assert.equal(v.value.value.verified, true); assert.match(v.value.diagnostics.join(" "), /ALREADY_SUPPORTED: src\/billing\/statementDownload\.ts#statementDownload already does this; no file will change/);
    const sup = alreadySupported(w.rec())!; assert.equal(sup.entryPoint, "src/billing/statementDownload.ts#statementDownload"); assert.ok(sup.evidenceIds.length >= 1);
    const rec = w.rec(); w.fs.updateRequest(w.rid, rec.version, { ...rec, blockers: [], state: "CONTRACTING" });
    assert.throws(() => materializeCandidate({ fs: w.fs, store: w.svc.store, auth: none }, "arun", { requestId: w.rid, snapshot: w.rec().source, edits: [createEdit("src/new.ts", "x")], idempotencyKey: "zz" }), (e: any) => e.code === "FORBIDDEN" && /already supported by src\/billing\/statementDownload\.ts#statementDownload \(verified\); nothing needs to change/.test(e.message));
    assert.equal(w.fs.listCandidates(w.rid).length, 0, "a zero-change inventory: no candidate exists");
    const ok = await w.call("C23/assessReuseImpact", { assessmentId: a.id, strategy: "NO_CHANGE", snapshot: w.rec().source }); assert.ok(ok.ok); assert.deepEqual(ok.value.value.affectedIds, []); assert.ok(ok.value.value.reasons.includes("ALREADY_SUPPORTED: nothing will change"));
    // the file the evidence came from changes: the observation goes stale and the verification no longer holds
    writeFileSync(join(w.repo, "tests/statementDownload.test.ts"), FILES["tests/statementDownload.test.ts"] + "// edited\n");
    const rec2 = w.rec(); w.fs.updateRequest(w.rid, rec2.version, { ...rec2, source: { ...rec2.source } });
    const reverify = await w.verify(a.id); assert.equal(reverify.value.value.verified, false); assert.match(reverify.value.diagnostics.join(" "), /observation\(s\) are stale because their file changed/); assert.equal(reverify.value.value.assessment.relationship, "UNCERTAIN"); assert.equal(alreadySupported(w.rec()), null);
  } finally { w.close(); }
});

test("PF-058 without evidence the answer is UNCERTAIN: nothing is reused, the unknowns are listed, investigation is bounded, and an authorised decision can settle it", async () => {
  const w = await world();
  try {
    const refs = w.only((await w.find()).value.capabilities, "src/export/untestedExport.ts"); const a = (await w.compare(refs)).value;
    assert.deepEqual([a.relationship, a.unresolvedIds, a.mappings[0].disposition], ["UNCERTAIN", ["AC1"], "NEW"]); assert.ok(a.mappings[0].differences.some((x: string) => /no behavioural evidence/.test(x))); assert.match(a.reasons.join(" "), /nothing is reused until the overlap is verified/);
    const bad = (body: Record<string, unknown>) => w.call("C22/investigateOverlap", { assessmentId: a.id, unknownIds: ["AC1"], budget: { steps: 5 }, ...body });
    for (const [b, code] of [[{ budget: { steps: 0 } }, "INVALID_SCHEMA"], [{ budget: { steps: 51 } }, "INVALID_SCHEMA"], [{ unknownIds: [] }, "INVALID_SCHEMA"], [{ unknownIds: ["AC9"] }, "NOT_FOUND"], [{ assessmentId: "overlap:none" }, "NOT_FOUND"]] as const) { const r = await bad(b); assert.ok(!r.ok && r.error.code === code, JSON.stringify(b)); }
    assert.equal((await w.call("C22/investigateOverlap", { assessmentId: a.id, unknownIds: ["AC1"], budget: { steps: 5 } }, "mallory")).error.code, "NOT_FOUND");
    const inv = await bad({}); assert.ok(inv.ok, JSON.stringify(inv)); assert.ok(inv.value.value.stepsUsed <= 5); assert.deepEqual(inv.value.value.unresolvedIds, [], "a test in the same area asserts the behaviour"); assert.ok(inv.value.value.observations.some((o: any) => o.path === "tests/export/areaChecks.test.ts"));
    const stored = w.rec().contract!.overlap!; assert.deepEqual(stored.unresolvedIds, []); assert.ok(stored.mappings[0]!.evidenceIds.length >= 1); assert.notEqual(stored.id, a.id, "new evidence is a new assessment identity");
    const capped = await w.call("C22/investigateOverlap", { assessmentId: "x", unknownIds: ["AC1"], budget: { steps: 1 } }); assert.ok(!capped.ok);
    // a decision by the requester settles what code cannot
    const rec = w.rec(); const refs2 = w.only((await w.find()).value.capabilities, "src/export/untestedExport.ts"); w.fs.updateRequest(w.rid, rec.version, { ...rec, contract: { ...rec.contract!, overlap: undefined } });
    w.fs.putDecision({ schemaVersion: 1, id: "decision:eq", requestId: w.rid, kind: "ANSWER", questionId: "overlap:AC1", answer: "Equivalent: product owner confirmed this is the same export", actorId: "arun", contractVersion: 0, affectedIds: ["AC1"], rationale: "", createdAt: "2026-10-05T00:00:00Z" });
    const noTests = await w.call("C15/compareRequestedBehaviour", { contractHash: "contract-overlap", capabilityRefs: refs2, evidenceIds: ["decision:eq"] }); assert.ok(noTests.ok);
    const mapped = noTests.value.value.mappings[0]; assert.ok(mapped.evidenceIds.includes("obs:decision:eq") || mapped.disposition !== "NEW", JSON.stringify(mapped));
    const unknownDecision = await w.call("C15/compareRequestedBehaviour", { contractHash: "contract-overlap", capabilityRefs: refs2, evidenceIds: ["decision:none"] }); assert.ok(!unknownDecision.ok && unknownDecision.error.code === "NOT_FOUND");
  } finally { w.close(); }
});

test("comparison input checks: capability references must be current, readable files; a changed file is STALE; the list is bounded", async () => {
  const w = await world();
  try {
    const refs = w.only((await w.find()).value.capabilities, "src/export/transactionExport.ts"); const call = (b: Record<string, unknown>, who = "arun") => w.call("C15/compareRequestedBehaviour", { contractHash: "contract-overlap", capabilityRefs: refs, evidenceIds: [], ...b }, who);
    for (const [b, code, re] of [[{ capabilityRefs: "x" }, "INVALID_SCHEMA", /capabilityRefs/], [{ capabilityRefs: Array.from({ length: 13 }, () => refs[0]) }, "INVALID_SCHEMA", /at most 12/], [{ capabilityRefs: [{ ...refs[0], sourceRefs: [{ ...refs[0]!.sourceRefs[0], locator: "repo:../x" }] }] }, "NOT_FOUND", /does not name a file/], [{ capabilityRefs: [{ ...refs[0], sourceRefs: [{ ...refs[0]!.sourceRefs[0], locator: "repo:src/none.ts" }] }] }, "NOT_FOUND", /does not name a file/], [{ contractHash: "nope" }, "NOT_FOUND", /no contract/]] as const) { const r = await call(b); assert.ok(!r.ok && r.error.code === code && re.test(r.error.message), JSON.stringify(b).slice(0, 80)); }
    assert.equal((await call({}, "mallory")).error.code, "NOT_FOUND");
    w.svc.store.db.prepare("insert into access_deny(repo_root, prefix) values (?, ?)").run(w.repo, "src/export"); const denied = await call({}); assert.ok(!denied.ok && denied.error.code === "NOT_FOUND" && !/export/.test(denied.error.message.replace("does not name a file you can compare", "")), "a denied capability is not named");
    w.svc.store.db.prepare("delete from access_deny").run(); writeFileSync(join(w.repo, "src/export/transactionExport.ts"), FILES["src/export/transactionExport.ts"] + "// changed\n"); const stale = await call({}); assert.ok(!stale.ok && stale.error.code === "STALE_REVISION" && /changed since the capability was found/.test(stale.error.message));
  } finally { w.close(); }
});

test("PF-059/060 reuse impact: the strategy must fit the relationship, consumers are found by static references, regression obligations carry over, and unknown consumers are always a stated gap", async () => {
  const w = await world({ requirements: [rq("R1", "Export transactions as CSV"), rq("R2", "Email recipients a link to the export")], acceptance: [ac("AC1", ["R1"], "Export transactions", "CSV of transaction rows"), ac("AC2", ["R2"], "Recipients get an email link", "an email with a download link is sent")] });
  try {
    const a = (await w.compare(w.only((await w.find()).value.capabilities, "src/export/transactionExport.ts"))).value; const snap = w.rec().source;
    const impact = (strategy: string, who = "arun", s = snap) => w.call("C23/assessReuseImpact", { assessmentId: a.id, strategy, snapshot: s }, who);
    const ext = await impact("EXTEND"); assert.ok(ext.ok, JSON.stringify(ext)); const v = ext.value.value;
    assert.deepEqual(v.consumers, ["src/api/exportController.ts"]); assert.deepEqual(v.affectedIds.sort(), ["src/api/exportController.ts", "src/export/transactionExport.ts"]); assert.deepEqual(v.regressionObligations, a.regressionObligations); assert.ok(v.gaps.some((g: string) => /dynamic or external consumers .* cannot be found by reading source/.test(g))); assert.equal(ext.value.status, "PARTIAL", "unknown consumers keep it from being COMPLETE");
    const sep = await impact("SEPARATE"); assert.ok(sep.value.value.reasons.some((r: string) => /a parallel implementation of behaviour that already exists needs a recorded reason/.test(r)));
    const rep = await impact("REPLACE"); assert.ok(rep.value.value.gaps.some((g: string) => /REPLACE needs a consumer inventory, a deprecation plan, a retained-data policy and authorisation; unknown consumers remain a gap/.test(g)));
    for (const [strategy, re] of [["NO_CHANGE", /needs a verified equivalence/], ["CONFIGURE", /applies only when the existing capability already does what is asked/]] as const) { const r = await impact(strategy); assert.ok(!r.ok && r.error.code === "FORBIDDEN" && re.test(r.error.message), strategy); }
    const bad = await impact("MERGE"); assert.ok(!bad.ok && bad.error.code === "INVALID_SCHEMA" && new RegExp(STRATEGIES.join(", ")).test(bad.error.message)); assert.equal((await impact("EXTEND", "mallory")).error.code, "NOT_FOUND");
    writeFileSync(join(w.repo, "src/late.ts"), "export {};\n"); assert.equal((await impact("EXTEND")).value.status, "STALE");
    const noReuse = await world({ acceptance: [ac("AC1", ["R1"], "Zebra grazing schedule", "pasture rotation chart")] });
    try { const x = (await noReuse.compare(noReuse.only((await noReuse.find()).value.capabilities, "src/export/transactionExport.ts"))).value; assert.equal(x.relationship, "NO_MATCH_WITHIN_SCOPE"); const r = await noReuse.call("C23/assessReuseImpact", { assessmentId: x.id, strategy: "EXTEND", snapshot: noReuse.rec().source }); assert.ok(!r.ok && /needs something to reuse/.test(r.error.message)); } finally { noReuse.close(); }
  } finally { w.close(); }
});

test("evidence rules and helpers: only assertions that speak about the behaviour count, the verification policy has a stable identity, and the glossary file is strict", async () => {
  const need = new Set(["export", "transaction", "csv", "row"]);
  assert.equal(coversCriterion("t.test.ts", "test('exports transactions as csv rows', () => { assert.equal(1, 1); });", need), true);
  assert.equal(coversCriterion("t.test.ts", "test('renders the login page', () => { assert.equal(1, 1); });", need), false, "a test that does not speak about the behaviour is not evidence");
  assert.equal(coversCriterion("t.test.ts", "// export transactions csv rows\nconst x = 1;", need), false, "a comment is not an assertion");
  assert.equal(overlapPolicyHash(), overlapPolicyHash(DEFAULT_OVERLAP_POLICY)); assert.notEqual(overlapPolicyHash(), overlapPolicyHash({ ...DEFAULT_OVERLAP_POLICY, allowDecisionOverride: false }));
  const dir = join(process.env.TMPDIR ?? "/tmp", `pf-gl-${Math.random().toString(36).slice(2)}`); mkdirSync(join(dir, ".cie"), { recursive: true });
  assert.equal(loadAliases(dir).size, 0); const w = (o: string) => writeFileSync(join(dir, ".cie", "glossary.json"), o);
  w(JSON.stringify({ terms: { Export: ["Download", "Statements"] } })); assert.deepEqual([...loadAliases(dir).entries()], [["export", ["download", "statement"]]], "terms are lower-cased and stemmed like the words they match");
  for (const bad of ["{", "[]", JSON.stringify({ other: 1 }), JSON.stringify({ terms: [] }), JSON.stringify({ terms: { a: "b" } }), JSON.stringify({ terms: { a: [1] } })]) { w(bad); assert.throws(() => loadAliases(dir), /glossary/, bad); }
  assert.deepEqual(STRATEGIES, ["NO_CHANGE", "CONFIGURE", "EXTEND", "COMPOSE", "REFACTOR_AND_REUSE", "SEPARATE", "REPLACE"]);
  void (null as unknown as FeatureRecord);
});

// ---- plans (1.E leftovers that depend on 2.I)
test("PF-018 planFeatureChange: one task per requirement, files only where the overlap named them and the caller allowed that capability, tier from those files, held by open items", async () => {
  const w = await world({ requirements: [rq("R1", "Export transactions as CSV"), rq("R2", "Email recipients a link to the export", { dependsOn: ["R1"] })], acceptance: [ac("AC1", ["R1"], "Export transactions", "CSV of transaction rows"), ac("AC2", ["R2"], "Recipients get an email link", "an email with a download link is sent")] });
  try {
    const refs = w.only((await w.find()).value.capabilities, "src/export/transactionExport.ts"); await w.compare(refs); const snap = w.rec().source;
    const impact = await w.call("C23/assessFeatureImpact", { contractHash: "contract-overlap", snapshot: snap }); const impactId = impact.value.value.id;
    const plan = (b: Record<string, unknown>, who = "arun") => w.call("C28/planFeatureChange", { contractHash: "contract-overlap", impactAssessmentId: impactId, capabilities: [refs[0]!.id], ...b }, who);
    const out = await plan({}); assert.ok(out.ok, JSON.stringify(out)); const tasks = out.value.value.tasks as any[];
    assert.deepEqual(tasks.map((t) => t.id), ["t:R1", "t:R2"]); assert.deepEqual(tasks[1].dependencyTaskIds, ["t:R1"]); assert.deepEqual(tasks.map((t) => t.plannedEdits), [[], []], "REUSED and NEW behaviour name no file to edit: the candidate's edit plan decides the new files");
    assert.deepEqual(w.rec().tasks.map((t) => t.id), ["t:R1", "t:R2"]); assert.ok(out.value.diagnostics.some((x: string) => /no file is named yet, so the tier is provisional/.test(x)));
    assert.equal(out.value.value.id, (await plan({})).value.value.id, "the same inputs give the same plan"); assert.equal(out.value.value.reuse.length, 2);
    assert.equal((await plan({}, "mallory")).error.code, "NOT_FOUND"); assert.equal((await plan({ impactAssessmentId: "impact:old" })).error.code, "STALE_REVISION"); assert.equal((await plan({ capabilities: ["cap:none"] })).error.code, "NOT_FOUND"); assert.equal((await plan({ capabilities: "x" })).error.code, "INVALID_SCHEMA");
    const rec = w.rec(); w.fs.updateRequest(w.rid, rec.version, { ...rec, contract: { ...rec.contract!, requirements: [] } }); const empty = await plan({ impactAssessmentId: (await w.call("C23/assessFeatureImpact", { contractHash: "contract-overlap", snapshot: snap })).value.value.id }); assert.equal(empty.error.code, "FORBIDDEN"); assert.match(empty.error.message, /no active requirement to plan/);
  } finally { w.close(); }
});

test("PF-059/AT-60 planReuseChange needs a VERIFIED assessment: reuse that modifies gets edit files and a regression task, configuration names the config file, already-supported plans nothing", async () => {
  const ext = await world({ requirements: [rq("R1", "Export transactions as CSV"), rq("R2", "Notify finance by chat when the export is ready")], acceptance: [ac("AC1", ["R1"], "Export transactions", "CSV of transaction rows"), ac("AC2", ["R2"], "Finance is notified in chat", "a chat message announces the export is ready")] });
  try {
    const refs = ext.only((await ext.find()).value.capabilities, "src/export/brokenExport.ts"); const a = (await ext.compare(refs)).value; const plan = (id: string, caps: string[] = [refs[0]!.id], who = "arun") => ext.call("C28/planReuseChange", { contractHash: "contract-overlap", verifiedAssessmentId: id, capabilities: caps }, who);
    const unverified = await plan(a.id); assert.ok(!unverified.ok && unverified.error.code === "FORBIDDEN" && /not verified/.test(unverified.error.message));
    assert.equal((await plan("overlap:none")).error.code, "NOT_FOUND"); assert.equal((await plan(a.id, [], "mallory")).error.code, "NOT_FOUND");
    const rec = ext.rec(); ext.fs.updateRequest(ext.rid, rec.version, { ...rec, contract: { ...rec.contract!, overlap: { ...rec.contract!.overlap!, verified: true } } }); // the defect case is verified by hand here: its mappings are MODIFIED and NEW
    const out = await plan(a.id); assert.ok(out.ok, JSON.stringify(out)); const tasks = out.value.value.tasks as any[];
    assert.deepEqual(tasks.map((t) => t.id), ["t:R1", "t:R2", "t:regression"]); assert.deepEqual(tasks[0].plannedEdits, ["src/export/brokenExport.ts"]); assert.deepEqual(tasks[1].plannedEdits, []); assert.equal(tasks[0].componentId, "src/export"); assert.deepEqual(tasks[2].plannedEdits, []);
    assert.equal(out.value.value.tier, "T1"); assert.equal(ext.rec().tier, "T1"); assert.match(out.value.diagnostics.join(" "), /strategy EXTEND/); assert.equal((await plan(a.id, ["cap:none"])).error.code, "NOT_FOUND"); assert.equal((await plan(a.id, "x" as never)).error.code, "INVALID_SCHEMA");
  } finally { ext.close(); }
  const dis = await world();
  try {
    const refs = dis.only((await dis.find()).value.capabilities, "src/export/betaExport.ts"); const a = (await dis.compare(refs)).value; const rec = dis.rec(); dis.fs.updateRequest(dis.rid, rec.version, { ...rec, contract: { ...rec.contract!, overlap: { ...rec.contract!.overlap!, verified: true } } });
    const out = await dis.call("C28/planReuseChange", { contractHash: "contract-overlap", verifiedAssessmentId: a.id, capabilities: [refs[0]!.id] }); assert.ok(out.ok, JSON.stringify(out)); const t = out.value.value.tasks[0]; assert.deepEqual([t.componentId, t.plannedEdits], ["configuration", ["src/export/betaExport.ts"]], "the observation of the flag points at the file that reads it");
  } finally { dis.close(); }
  const eq = await world({ extra: { ".cie/glossary.json": JSON.stringify({ terms: { export: ["download", "statement"] } }) } });
  try {
    const refs = eq.only((await eq.find()).value.capabilities, "src/billing/statementDownload.ts"); const a = (await eq.compare(refs)).value; assert.ok((await eq.verify(a.id)).ok);
    const none_ = await eq.call("C28/planReuseChange", { contractHash: "contract-overlap", verifiedAssessmentId: a.id, capabilities: [] }); assert.ok(none_.ok, JSON.stringify(none_)); assert.deepEqual(none_.value.value.tasks, []); assert.match(none_.value.diagnostics[0], /ALREADY_SUPPORTED by src\/billing\/statementDownload\.ts#statementDownload: there is nothing to change/); assert.deepEqual(eq.rec().tasks, []);
  } finally { eq.close(); }
});
