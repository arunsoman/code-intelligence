import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { authorityPolicyHash, type AuthorityConfig } from "../src/feature/authority.ts";
import { materializeCandidate, type FeatureEdit } from "../src/feature/candidate.ts";
import { rawHash } from "../src/feature/canon.ts";
import { ConfigError, DEFAULT_CONFIG } from "../src/feature/config.ts";
import { contractHashOf, contractIdOf } from "../src/feature/decisions.ts";
import { diffDependencies, parseLock, parsePackageJson, reviewDependencies, type AdvisoryAdapter } from "../src/feature/dependencies.ts";
import { composeRunChecks, dependencyGate, gateRunCheck, scannerPlanHashOf, securityGate, tierOf, type GateContext } from "../src/feature/gates.ts";
import { featureHandlers } from "../src/feature/handlers.ts";
import { discoverFeatureContext, submitFeature } from "../src/feature/intake.ts";
import { buildProvenance } from "../src/feature/provenance.ts";
import { DEFAULT_SECURITY_POLICY, SAST_RULES, SECRET_RULES, introducedLines, loadSecurityPolicy, runSecurityScan, scanFiles, securityPolicyHash, type SastAdapter, type SecurityPolicy } from "../src/feature/security.ts";
import { SqliteFeatureStore } from "../src/feature/store.ts";
import { computeEligibility, runFeatureValidation } from "../src/feature/validation.ts";
import type { FeatureContract } from "../src/feature/types.ts";
import { ctx as mkctx, demoRepo, setup } from "./helpers.ts";
import { validationFixture } from "./feature-validation-fixtures.ts";

const none: AuthorityConfig = { bindings: [] };
const secAuth: AuthorityConfig = { bindings: [{ id: "sec", scope: "security", principals: ["owner"] }] };
const file = (path: string, text: string, base: string | null = null) => ({ path, text, base });
const rules = (id: string) => [...SECRET_RULES, ...SAST_RULES].find((r) => r.id === id)!;
const hit = (id: string, line: string) => rules(id).test(line) !== null;
/** A clearly-fake AWS access-key id, derived deterministically from a non-secret seed so the literal key never appears in source. */
const fakeAwsKey = () => "AKIA" + Buffer.from("aws-key unit-test seed").toString("hex").slice(0, 16).toUpperCase();
const cleanAdapter: SastAdapter = { name: "semgrep-like", version: "1.0", scan: () => [] };

test("PF-045 secret rules find real secrets, ignore placeholders and env references, and never keep the secret in the finding", () => {
  const aws = fakeAwsKey(), gh = "ghp_" + "a".repeat(36), sk = "sk-" + "Ab1".repeat(10);
  for (const [id, line] of [["SEC001", `const k = "${aws}";`], ["SEC002", `token: ${gh}`], ["SEC003", "-----BEGIN RSA PRIVATE KEY-----"], ["SEC004", "xoxb-1234567890-abcdefghij"], ["SEC005", "eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4"], ["SEC008", `const key = "${sk}"`],
    ["SEC009", 'const u = "postgres://app:hunter22@db.internal/x"'], ["SEC006", 'const password = "correct-horse-battery";'], ["SEC006", "api_key: 'abcd1234efgh5678'"], ["SEC007", 'const t = "Qx7Zk2LmP9aVbN4cR8sT1uW6yE3dF5gH0jKqX7Zk";']] as const) assert.ok(hit(id, line), `${id} should match ${line}`);
  for (const [id, line] of [["SEC006", 'const password = "changeme";'], ["SEC006", "const token = process.env.TOKEN_VALUE_X;"], ["SEC006", 'password: "${DB_PASSWORD}"'], ["SEC006", 'const secret = "<your-secret-here>"'], ["SEC009", 'const u = "postgres://app:${PW}@db/x"'], ["SEC001", "AKIA is a prefix"]] as const) assert.ok(!hit(id, line), `${id} should not match ${line}`);
  const f = scanFiles([file("src/a.ts", `const k = "${aws}";\nconst ok = 1;\n`)], SECRET_RULES);
  assert.equal(f.length, 1); assert.equal(f[0]!.line, 1); assert.equal(f[0]!.severity, "CRITICAL");
  assert.ok(!JSON.stringify(f).includes(aws) && f[0]!.excerpt!.includes("chars"), "only a masked excerpt is kept");
});

test("PF-045 pattern rules for the common unsafe constructs fire on the unsafe form and stay quiet on the safe one", () => {
  for (const [id, line] of [["SAST001", "const x = eval(input);"], ["SAST001", "const f = new Function('a', body);"], ["SAST002", "execSync(`ls ${dir}`);"], ["SAST002", "execSync(cmd);"], ["SAST003", "{ rejectUnauthorized: false }"], ["SAST003", "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'"],
    ["SAST004", "el.innerHTML = value;"], ["SAST004", "<div dangerouslySetInnerHTML={{ __html: x }} />"], ["SAST005", "db.query(`select * from t where id = ${id}`)"], ["SAST005", "db.query('select * from t where id = ' + id)"], ["SAST006", "createHash('md5')"], ["SAST007", "const sessionToken = Math.random().toString(36);"],
    ["SAST008", "const u = 'http://api.vendor.io/v1';"], ["SAST009", "res.setHeader('Access-Control-Allow-Origin', '*')"], ["SAST010", "fs.readFileSync(path.join(root, req.query.file))"]] as const) assert.ok(hit(id, line), `${id} should match ${line}`);
  for (const [id, line] of [["SAST001", "const evaluate = 1; // medieval"], ["SAST002", "exec('ls');"], ["SAST003", "{ rejectUnauthorized: true }"], ["SAST004", "el.textContent = value;"], ["SAST005", "db.query('select * from t where id = ?', [id])"], ["SAST006", "createHash('sha256')"],
    ["SAST007", "const jitter = Math.random() * 100;"], ["SAST008", "const u = 'http://localhost:3000/x';"], ["SAST009", "res.setHeader('Access-Control-Allow-Origin', origin)"], ["SAST010", "fs.readFileSync(join(root, 'fixed.txt'))"]] as const) assert.ok(!hit(id, line), `${id} should not match ${line}`);
});

test("only lines the candidate introduces can block; pre-existing ones are reported separately and moved lines are not introduced", () => {
  const secret = `const k = "${fakeAwsKey()}";`;
  const base = `// header\n${secret}\nexport const a = 1;\n`;
  const same = scanFiles([file("src/a.ts", `${base}export const b = 2;\n`, base)], SECRET_RULES);
  assert.equal(same.length, 1); assert.equal(same[0]!.introduced, false);
  const moved = scanFiles([file("src/a.ts", `export const a = 1;\n${secret}\n// header\n`, base)], SECRET_RULES);
  assert.equal(moved[0]!.introduced, false, "a reordered line is not a new line");
  const added = scanFiles([file("src/a.ts", `${base}${secret.replace("MNOP", "MNOQ")}\n`, base)], SECRET_RULES);
  assert.deepEqual(added.map((f) => f.introduced), [false, true]);
  assert.deepEqual([...introducedLines("a\nb\nb\n", "a\nb\n")], [3], "a repeated line counts as a multiset");
  assert.deepEqual([...introducedLines("x\ny\n", null)], [1, 2, 3], "a new file introduces every line");
});

test("AT-35/AT-62 gate status: a secret blocks; no external analyser is INCOMPLETE above docs; a clean external run passes; a failing adapter is a gap", async () => {
  const base = { auth: none, requester: "u", policy: DEFAULT_SECURITY_POLICY };
  const code = [file("src/a.ts", "export const a = 1;\n")];
  const withSecret = [file("src/a.ts", `export const k = "${fakeAwsKey()}";\n`)];
  const blocked = await runSecurityScan({ ...base, files: withSecret, tier: "T1", tools: { sast: [cleanAdapter] } });
  assert.equal(blocked.status, "BLOCKED"); assert.equal(blocked.blocking[0]!.rule, "SEC001");
  const incomplete = await runSecurityScan({ ...base, files: code, tier: "T1" });
  assert.equal(incomplete.status, "INCOMPLETE"); assert.match(incomplete.gaps[0]!, /no external static-analysis adapter ran/); assert.ok(incomplete.tools.every((t) => t.kind === "BUILTIN"));
  assert.equal((await runSecurityScan({ ...base, files: code, tier: "T1", tools: { sast: [cleanAdapter] } })).status, "PASS");
  assert.equal((await runSecurityScan({ ...base, files: [file("docs/a.md", "text\n")], tier: "T0" })).status, "PASS", "docs-only needs only the secret scan");
  assert.equal((await runSecurityScan({ ...base, files: code, tier: "T1", policy: { ...DEFAULT_SECURITY_POLICY, requireExternalSast: false } })).status, "PASS");
  const broken: SastAdapter = { name: "boom", version: "0", scan: () => { throw new Error("license server unreachable"); } };
  const gap = await runSecurityScan({ ...base, files: code, tier: "T1", tools: { sast: [broken] } });
  assert.equal(gap.status, "INCOMPLETE"); assert.ok(gap.gaps.some((g) => /boom failed: license server unreachable/.test(g))); assert.deepEqual(gap.tools.at(-1), { name: "boom", version: "0", kind: "EXTERNAL", ran: false, error: "license server unreachable" });
  const finds: SastAdapter = { name: "ext", version: "2", scan: () => [{ id: "x", rule: "EXT1", cls: "SAST", severity: "HIGH", path: "src/a.ts", line: 1, message: "taint flow", origin: "x", introduced: true }] };
  const ext = await runSecurityScan({ ...base, files: code, tier: "T1", tools: { sast: [finds] } });
  assert.equal(ext.status, "BLOCKED"); assert.equal(ext.blocking[0]!.origin, "ext");
  const medium = await runSecurityScan({ ...base, files: [file("src/a.ts", "const u = 'http://api.vendor.io/x';\n")], tier: "T1", tools: { sast: [cleanAdapter] } });
  assert.equal(medium.status, "PASS"); assert.equal(medium.findings[0]!.severity, "LOW", "low findings are reported, not blocking");
});

test("suppressions need an owner with security authority and a future expiry, and stay visible in the report", async () => {
  const secret = `const k = "${fakeAwsKey()}";\n`; const files = [file("tests/fixtures/keys.ts", secret)];
  const sup = (over = {}) => ({ rule: "SEC001", path: "tests/fixtures/", reason: "documented fake key used by the parser tests", owner: "owner", expires: "2027-01-01T00:00:00Z", ...over });
  const run = (policy: Partial<SecurityPolicy>, auth = secAuth) => runSecurityScan({ files, tier: "T1", policy: { ...DEFAULT_SECURITY_POLICY, requireExternalSast: false, ...policy }, tools: { sast: [] }, auth, requester: "u", now: "2026-10-05T00:00:00Z" });
  const ok = await run({ suppressions: [sup()] });
  assert.equal(ok.status, "PASS"); assert.equal(ok.suppressed.length, 1); assert.equal(ok.suppressed[0]!.suppression.owner, "owner"); assert.equal(ok.findings.length, 0);
  const expired = await run({ suppressions: [sup({ expires: "2026-01-01T00:00:00Z" })] });
  assert.equal(expired.status, "BLOCKED"); assert.ok(expired.gaps.some((g) => /expired and is ignored/.test(g)));
  const stranger = await run({ suppressions: [sup({ owner: "someone" })] });
  assert.equal(stranger.status, "BLOCKED"); assert.ok(stranger.gaps.some((g) => /someone has no security authority/.test(g)));
  assert.equal((await run({ suppressions: [sup()] }, none)).status, "BLOCKED", "without any binding nobody can suppress");
  assert.equal((await run({ suppressions: [sup({ path: "src/" })] })).status, "BLOCKED", "a suppression covers only its own path");
  assert.equal((await run({ suppressions: [sup({ rule: "SEC002" })] })).status, "BLOCKED", "and only its own rule");
});

test("security policy file: strict, defaults when absent, and its hash moves with every setting", () => {
  const dir = mkdtempSync(join(tmpdir(), "pf-sec-")); assert.deepEqual(loadSecurityPolicy(dir), DEFAULT_SECURITY_POLICY);
  mkdirSync(join(dir, ".cie")); const w = (o: unknown) => writeFileSync(join(dir, ".cie", "security.json"), typeof o === "string" ? o : JSON.stringify(o));
  w({ requireExternalSast: false, requireSimilarityCheck: true, allowInstallScripts: ["esbuild"], denyLicences: ["GPL-3.0"], suppressions: [{ rule: "SEC001", path: "t/", reason: "r", owner: "o", expires: "2030-01-01" }] });
  const p = loadSecurityPolicy(dir); assert.equal(p.requireExternalSast, false); assert.equal(p.requireSimilarityCheck, true); assert.deepEqual(p.allowInstallScripts, ["esbuild"]); assert.equal(p.suppressions.length, 1);
  for (const bad of ["{", [], { extra: 1 }, { requireExternalSast: "yes" }, { allowInstallScripts: "esbuild" }, { suppressions: [{ rule: "x" }] }, { suppressions: [{ rule: "a", path: "b", reason: "c", owner: "d", expires: "never" }] }, { suppressions: [{ rule: "a", path: "b", reason: "c", owner: "d", expires: "2030-01-01", why: "e" }] }]) { w(bad); assert.throws(() => loadSecurityPolicy(dir), ConfigError, JSON.stringify(bad)); }
  const h = securityPolicyHash(DEFAULT_SECURITY_POLICY);
  assert.notEqual(h, securityPolicyHash({ ...DEFAULT_SECURITY_POLICY, requireExternalSast: false })); assert.notEqual(h, securityPolicyHash({ ...DEFAULT_SECURITY_POLICY, trustedRegistries: [] }));
  assert.equal(h, securityPolicyHash({ ...DEFAULT_SECURITY_POLICY, denyLicences: [...DEFAULT_SECURITY_POLICY.denyLicences].reverse() }), "list order is not identity");
});

const pkg = (deps: Record<string, string> = {}, scripts: Record<string, string> = {}) => JSON.stringify({ name: "x", version: "1.0.0", scripts, dependencies: deps }, null, 2);
const lock = (packages: Record<string, object>) => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "x" }, ...packages } });
const entry = (version: string, extra: object = {}) => ({ version, resolved: "https://registry.npmjs.org/p/-/p-1.tgz", integrity: "sha512-abc", license: "MIT", ...extra });
const review = (changed: Record<string, [string | null, string | null]>, over: Partial<Parameters<typeof reviewDependencies>[0]> = {}) => reviewDependencies({ changedPaths: Object.keys(changed), lockfileExists: true, policy: DEFAULT_SECURITY_POLICY, read: (p, side) => changed[p]![side === "base" ? 0 : 1], ...over });
const okAdvisory: AdvisoryAdapter = { name: "osv", lookup: () => [] };

test("PF-046 dependency review: parsing, direct changes and install scripts", () => {
  assert.deepEqual(parsePackageJson("{ nope").invalid, true); assert.deepEqual(parsePackageJson(null).sections, {});
  const d = diffDependencies(parsePackageJson(pkg({ a: "1.0.0", b: "2.0.0" }, { postinstall: "x" })), parsePackageJson(pkg({ a: "1.1.0", c: "3.0.0" }, { postinstall: "y", prepare: "z" })));
  assert.deepEqual(d.changes.map((c) => `${c.kind}:${c.name}`).sort(), ["ADDED:c", "CHANGED:a", "REMOVED:b"]); assert.deepEqual(d.scriptChanges, ["scripts.postinstall changed", "scripts.prepare added"]);
  const l3 = parseLock(lock({ "node_modules/a": entry("1.0.0"), "node_modules/a/node_modules/b": entry("2.0.0") })); assert.deepEqual([...l3.packages.keys()].sort(), ["a@1.0.0", "b@2.0.0"]);
  const l1 = parseLock(JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } } } })); assert.equal(l1.packages.size, 2);
  assert.equal(parseLock("{ nope").valid, false); assert.equal(parseLock('{"x":1}').valid, false);
});

test("AT-36 dependency findings: outside-registry sources, unpinned ranges, install scripts, integrity and licence", async () => {
  const code = (r: Awaited<ReturnType<typeof review>>) => r.findings.map((f) => f.rule).sort();
  const risky = await review({ "package.json": [pkg(), pkg({ g: "git+https://github.com/x/y.git", u: "https://evil.example/p.tgz", s: "*", l: "latest", ok: "^1.2.3" }, { postinstall: "node x.js" })] }, { advisories: [okAdvisory] });
  assert.deepEqual(code(risky), ["DEP002", "DEP003", "DEP003", "DEP004", "DEP004"]); assert.equal(risky.status, "BLOCKED");
  const lk = await review({ "package.json": [pkg(), pkg({ a: "1.0.0", b: "1.0.0", c: "1.0.0", d: "1.0.0", e: "1.0.0" })], "package-lock.json": [lock({}), lock({
    "node_modules/a": entry("1.0.0", { hasInstallScript: true }), "node_modules/b": entry("1.0.0", { resolved: "https://evil.example/b.tgz" }), "node_modules/c": entry("1.0.0", { integrity: undefined }),
    "node_modules/d": entry("1.0.0", { license: "GPL-3.0" }), "node_modules/e": entry("1.0.0", { license: "(MIT OR GPL-3.0)" }) })] }, { advisories: [okAdvisory] });
  assert.deepEqual(code(lk), ["DEP005", "DEP006", "DEP007", "DEP008"], "an OR licence with a permitted alternative passes"); assert.equal(lk.status, "BLOCKED");
  assert.equal((await review({ "package.json": [pkg(), pkg({ a: "1.0.0" })], "package-lock.json": [lock({}), lock({ "node_modules/a": entry("1.0.0", { hasInstallScript: true }) })] }, { advisories: [okAdvisory], policy: { ...DEFAULT_SECURITY_POLICY, allowInstallScripts: ["a"] } })).status, "PASS", "an allowed install script passes");
  const allow = await review({ "package.json": [pkg(), pkg({ a: "1.0.0" })], "package-lock.json": [lock({}), lock({ "node_modules/a": entry("1.0.0", { license: "ISC" }) })] }, { advisories: [okAdvisory], policy: { ...DEFAULT_SECURITY_POLICY, allowLicences: ["MIT"] } });
  assert.deepEqual(code(allow), ["DEP009"]);
});

test("AT-62 dependency gaps: no advisory source, a failing one, a stale or missing lockfile and an unknown licence are INCOMPLETE, and real advisories block", async () => {
  const both = { "package.json": [pkg(), pkg({ a: "1.0.0" })] as [string, string], "package-lock.json": [lock({}), lock({ "node_modules/a": entry("1.0.0") })] as [string, string] };
  const offline = await review(both); assert.equal(offline.status, "INCOMPLETE"); assert.match(offline.gaps[0]!, /no advisory source is available \(offline\).*1 added package/); assert.equal(offline.advisoriesChecked, false);
  assert.equal((await review(both, { advisories: [okAdvisory] })).status, "PASS");
  const broken = await review(both, { advisories: [{ name: "osv", lookup: () => { throw new Error("timeout"); } }] }); assert.equal(broken.status, "INCOMPLETE"); assert.match(broken.gaps[0]!, /osv failed: timeout/);
  const bad = await review(both, { advisories: [{ name: "osv", lookup: () => [{ name: "a", version: "1.0.0", id: "GHSA-xxxx", severity: "HIGH", summary: "prototype pollution" }] }] });
  assert.equal(bad.status, "BLOCKED"); assert.equal(bad.findings[0]!.rule, "DEP010");
  const low = await review(both, { advisories: [{ name: "osv", lookup: () => [{ name: "a", version: "1.0.0", id: "X", severity: "LOW", summary: "minor" }] }] }); assert.equal(low.status, "PASS");
  const noLock = await review({ "package.json": [pkg(), pkg({ a: "1.0.0" })] }, { lockfileExists: true, advisories: [okAdvisory] }); assert.match(noLock.gaps[0]!, /lockfile did not/); assert.equal(noLock.lockfile, "UNCHANGED");
  assert.match((await review({ "package.json": [pkg(), pkg({ a: "1.0.0" })] }, { lockfileExists: false, advisories: [okAdvisory] })).gaps[0]!, /no lockfile/);
  const missing = await review({ "package.json": [pkg(), pkg({ a: "1.0.0" })], "package-lock.json": [lock({}), lock({})] }, { advisories: [okAdvisory] }); assert.match(missing.gaps[0]!, /a was added to package.json but does not appear in the updated lockfile/);
  const nolic = await review({ "package.json": [pkg(), pkg({ a: "1.0.0" })], "package-lock.json": [lock({}), lock({ "node_modules/a": entry("1.0.0", { license: undefined }) })] }, { advisories: [okAdvisory] }); assert.match(nolic.gaps[0]!, /licence of 1 added package/);
  const unparsable = await review({ "package-lock.json": [lock({}), "{ nope"] }); assert.match(unparsable.gaps[0]!, /could not be parsed/);
  const nothing = await review({}); assert.deepEqual([nothing.status, nothing.lockfile, nothing.advisoriesChecked], ["PASS", "NOT_APPLICABLE", false]);
  assert.equal((await review({ "package.json": [pkg({ a: "1.0.0" }), pkg()] })).status, "PASS", "removing a dependency needs no advisory lookup");
  assert.equal((await review({ "package.json": [pkg(), "{ nope"] })).findings[0]!.rule, "DEP001");
});

test("PF-047 provenance: who produced each file, licence markers on new text, and an honest coverage limit", () => {
  const prov = (files: Parameters<typeof buildProvenance>[0]["files"], invocationIds: string[] = ["inv:1"]) => buildProvenance({ bindingHash: "b1", invocationIds, policy: DEFAULT_SECURITY_POLICY, files, dependencies: [] });
  const gpl = prov([{ path: "src/a.ts", kind: "ADDED", text: "// SPDX-License-Identifier: GPL-3.0-only\nexport const a = 1;\n", base: null }]);
  assert.deepEqual(gpl.findings.map((f) => [f.rule, f.severity, f.line]), [["PROV001", "HIGH", 1]]); assert.deepEqual(gpl.files[0]!.spdx, ["GPL-3.0-only"]);
  const mit = prov([{ path: "src/b.ts", kind: "ADDED", text: "/* Copyright (c) 2019 Some Vendor Inc. */\nexport const b = 1;\n", base: null }]);
  assert.deepEqual(mit.findings.map((f) => [f.rule, f.severity]), [["PROV002", "MEDIUM"]]);
  const own = prov([{ path: "src/c.ts", kind: "MODIFIED", text: "// Copyright (c) 2024 Our Company\nexport const c = 2;\n", base: "// Copyright (c) 2024 Our Company\nexport const c = 1;\n" }]);
  assert.deepEqual(own.findings, [], "a header that was already there is not new");
  assert.equal(prov([{ path: "a.ts", kind: "ADDED", text: "x\n", base: null }]).files[0]!.origin, "MODEL"); assert.equal(prov([{ path: "a.ts", kind: "ADDED", text: "x\n", base: null }], []).files[0]!.origin, "HUMAN");
  assert.equal(prov([{ path: "a.ts", kind: "ADDED", text: "x\n", base: null, humanEdit: true }]).files[0]!.origin, "MIXED");
  assert.deepEqual(gpl.coverage, { markers: "CHECKED", similarity: "NOT_CONFIGURED" }, "copied code without a marker is not detected, and the record says so");
  assert.equal(prov([{ path: "a.ts", kind: "ADDED", text: "x\n", base: null }]).hash, prov([{ path: "a.ts", kind: "ADDED", text: "x\n", base: null }]).hash); assert.notEqual(gpl.hash, mit.hash);
  assert.match(gpl.hash, /^pf-canon-v1\/pf\.Provenance@1:/);
});

// ---- the gate inside 2.J's orchestrator, on its own fixture
const gateCtx = (f: ReturnType<typeof validationFixture>, over: Partial<GateContext> = {}): GateContext => ({ candidate: f.candidate, request: f.request, repoRoot: f.root, auth: none, policy: DEFAULT_SECURITY_POLICY, ...over });
const gateRun = (f: ReturnType<typeof validationFixture>, c: GateContext) => runFeatureValidation({ store: f.fs, runner: f.runner, runCheck: gateRunCheck(c) }, { candidateId: f.candidate.id, plan: f.plan, actor: "u", wallMs: 30_000 });
const status = (ev: Awaited<ReturnType<typeof gateRun>>, id: string) => ev.find((e) => e.validation!.checkId === id)!.results[0]!.status;

test("2.K inside 2.J: the SECURITY and DEPENDENCY checks become real evidence, other checks still run on the runner, and eligibility follows", async () => {
  const f = validationFixture();
  try {
    assert.equal(tierOf(f.candidate), "T1");
    const incomplete = await gateRun(f, gateCtx(f));
    assert.equal(status(incomplete, "security"), "INCOMPLETE", "no analyser is a gap");
    assert.equal(status(incomplete, "dependency"), "PASS", "no dependency files changed");
    assert.equal(status(incomplete, "backend"), "PASS", "builds still ran on the default runner");
    assert.ok(f.runner.calls.length > 0 && f.runner.calls.every((c) => !/security|dependency/.test(c.argv.join(" "))), "the gate never goes through the runner");
    const sec = incomplete.find((e) => e.validation!.checkId === "security")!;
    assert.match(sec.coverage.gaps.join(" "), /no external static-analysis adapter ran/); assert.equal(sec.manifest.isolation, "LOCAL_PERMISSION_MODEL");
    assert.ok(sec.validation!.isolationOmissions.some((o) => /no candidate code is executed/.test(o)));
    const clean = await gateRun(f, gateCtx(f, { tools: { sast: [cleanAdapter] } })); assert.equal(status(clean, "security"), "PASS");
    const dirty = { ...f.candidate, contents: { "src/app.ts": `export const k = "${fakeAwsKey()}";\n` }, baseContents: { "src/app.ts": "export const version = 1;\n" } };
    const blocked = await gateRun(f, gateCtx(f, { candidate: dirty, tools: { sast: [cleanAdapter] } })); assert.equal(status(blocked, "security"), "FAIL");
    const e = blocked.find((x) => x.validation!.checkId === "security")!; assert.match(e.results[0]!.gaps.join(" "), /SEC001 CRITICAL src\/app\.ts:1/); assert.ok(!JSON.stringify(e).includes(fakeAwsKey()), "evidence never carries the secret");
    const decision = computeEligibility({ request: f.request, candidate: f.candidate, plan: f.plan, evidence: blocked });
    assert.equal(decision.eligibility, "BLOCKED"); assert.ok(decision.reasons.some((r) => /security: FAIL/.test(r)));
    const composed = composeRunChecks(undefined, gateRunCheck(gateCtx(f)), async () => undefined);
    assert.equal(await composed({ ...f.plan.checks[0]!, kind: "UNIT" }, f.root), undefined, "a check no driver owns falls through to the runner");
    assert.ok(await composed({ ...f.plan.checks[0]!, kind: "SECURITY" }, f.root));
  } finally { f.close(); }
});

test("2.K reports: the security gate merges scan, provenance and policy, and the plan hash changes with tools and policy", async () => {
  const f = validationFixture();
  try {
    const gpl = { ...f.candidate, contents: { "src/app.ts": "// SPDX-License-Identifier: AGPL-3.0\nexport const version = 2;\n" } };
    const r = await securityGate(gateCtx(f, { candidate: gpl, tools: { sast: [cleanAdapter] } }));
    assert.equal(r.status, "BLOCKED"); assert.ok(r.provenance.findings.some((x) => x.rule === "PROV001")); assert.ok(r.blocking.some((x) => x.rule === "PROV001"));
    assert.equal(r.provenance.bindingHash, f.candidate.bindingHash);
    const sim = await securityGate(gateCtx(f, { tools: { sast: [cleanAdapter] }, policy: { ...DEFAULT_SECURITY_POLICY, requireSimilarityCheck: true } }));
    assert.equal(sim.status, "INCOMPLETE"); assert.ok(sim.gaps.some((g) => /no code-similarity source/.test(g)));
    const dep = await dependencyGate(gateCtx(f)); assert.equal(dep.status, "PASS");
    const a = scannerPlanHashOf(DEFAULT_SECURITY_POLICY), b = scannerPlanHashOf(DEFAULT_SECURITY_POLICY, { sast: [cleanAdapter] }), c = scannerPlanHashOf(DEFAULT_SECURITY_POLICY, undefined, [okAdvisory]);
    assert.equal(new Set([a, b, c]).size, 3); assert.equal(a, scannerPlanHashOf(DEFAULT_SECURITY_POLICY));
  } finally { f.close(); }
});

// ---- the operations over the gateway handlers
async function boot(edits: (repo: string) => FeatureEdit[], hooks = {}) {
  const repo = demoRepo(); const { svc, worker } = await setup(undefined, repo);
  const fs = new SqliteFeatureStore(svc.store); const intake = { fs, store: svc.store, config: () => ({ ...DEFAULT_CONFIG }) };
  const rid = submitFeature(intake, "arun", { inputRefs: [], text: "Add export", repositoryId: repo, mode: "BUILD_PREVIEW", idempotencyKey: "k" }).requestId;
  discoverFeatureContext(intake, "arun", { requestId: rid, snapshot: fs.getRequest(rid)!.source, retrievalBudget: { tokens: 1000, files: 1000 } });
  let rec = fs.getRequest(rid)!;
  const draft = { schemaVersion: 1 as const, id: contractIdOf(rid), version: 0, requestId: rid, snapshot: rec.source, requirements: [], acceptance: [], assumptions: [], obligationIds: [], authorityPolicyHash: authorityPolicyHash(none) };
  const contract: FeatureContract = { ...draft, hash: contractHashOf(draft) }; rec = fs.updateRequest(rid, rec.version, { ...rec, contract });
  const cand = materializeCandidate({ fs, store: svc.store, auth: none }, "arun", { requestId: rid, snapshot: rec.source, edits: edits(repo), idempotencyKey: "m" }).candidate;
  const as = (p: string, idem?: string) => { const c = mkctx(idem); return { ...c, actor: { ...c.actor, principalId: p } }; };
  const h = featureHandlers(svc, { gates: hooks }) as Record<string, (c: any, b: any) => any>;
  return { svc, fs, repo, rid, cand, as, h, close: () => worker.close() };
}
const create = (file: string, content: string): FeatureEdit => ({ op: "CREATE_FILE", file, content, why: "new", requirementIds: ["r1"] });

test("C27/runSecurityValidation and C25/reviewDependencyDiff: owner-only, plan-bound, stale-checked, and the job reports the finding without the secret", async () => {
  const secret = fakeAwsKey();
  const b = await boot((repo) => [create("src/export.ts", `export const key = "${secret}";\n`), create("package.json", pkg({ a: "1.0.0" }))].slice(0, 1));
  try {
    const gc = { candidate: b.cand, request: b.fs.getRequest(b.rid)!, repoRoot: b.repo, auth: none, policy: DEFAULT_SECURITY_POLICY };
    const plan = scannerPlanHashOf(gc.policy);
    const start = await b.h["C27/runSecurityValidation"]!(b.as("arun", "s1"), { patchBindingHash: b.cand.bindingHash, scannerPlanHash: plan, budget: { wallMs: 20_000 } });
    assert.ok(start.ok, JSON.stringify(start)); const job = await b.svc.jobs.settled(start.value.jobId);
    assert.equal(job.state, "SUCCEEDED", job.message); const a = (job.result!.value as any).value ?? job.result!.value;
    assert.equal(a.status, "BLOCKED"); assert.ok(a.findings.some((l: string) => /^SEC001 CRITICAL src\/export\.ts:1/.test(l))); assert.ok(a.findings.some((l: string) => /^GAP no external static-analysis adapter/.test(l)));
    assert.ok(!JSON.stringify(job).includes(secret), "the job result never carries the secret");
    const stale = await b.h["C27/runSecurityValidation"]!(b.as("arun", "s2"), { patchBindingHash: b.cand.bindingHash, scannerPlanHash: "pf-canon-v1/old", budget: { wallMs: 20_000 } });
    assert.ok(!stale.ok && stale.error.code === "STALE_REVISION");
    const noBudget = await b.h["C27/runSecurityValidation"]!(b.as("arun", "s3"), { patchBindingHash: b.cand.bindingHash, scannerPlanHash: plan, budget: { wallMs: 0 } }); assert.ok(!noBudget.ok && noBudget.error.code === "INVALID_SCHEMA");
    for (const key of ["C27/runSecurityValidation", "C25/reviewDependencyDiff"]) { const r = await b.h[key]!(b.as("mallory", `m-${key}`), { patchBindingHash: b.cand.bindingHash, scannerPlanHash: plan, policyHash: securityPolicyHash(DEFAULT_SECURITY_POLICY), inventoryHashes: [], budget: { wallMs: 5000 } }); assert.ok(!r.ok && r.error.code === "NOT_FOUND", key); }
    const bad = await b.h["C27/runSecurityValidation"]!(b.as("arun", "s4"), { patchBindingHash: "pf-canon-v1/none", scannerPlanHash: plan, budget: { wallMs: 5000 } }); assert.ok(!bad.ok && bad.error.code === "NOT_FOUND");
    const dep = await b.h["C25/reviewDependencyDiff"]!(b.as("arun"), { patchBindingHash: b.cand.bindingHash, policyHash: securityPolicyHash(DEFAULT_SECURITY_POLICY), inventoryHashes: [] });
    assert.ok(dep.ok, JSON.stringify(dep)); assert.equal(dep.value.status, "COMPLETE"); assert.equal(dep.value.value.status, "PASS");
    const staleDep = await b.h["C25/reviewDependencyDiff"]!(b.as("arun"), { patchBindingHash: b.cand.bindingHash, policyHash: "pf-canon-v1/old", inventoryHashes: [] }); assert.ok(!staleDep.ok && staleDep.error.code === "STALE_REVISION");
    const badInv = await b.h["C25/reviewDependencyDiff"]!(b.as("arun"), { patchBindingHash: b.cand.bindingHash, policyHash: securityPolicyHash(DEFAULT_SECURITY_POLICY), inventoryHashes: "x" }); assert.ok(!badInv.ok && badInv.error.code === "INVALID_SCHEMA");
  } finally { b.close(); }
});

test("a repository's own security policy changes the plan hash and is enforced; an invalid policy file is a typed error", async () => {
  const b = await boot(() => [create("src/export.ts", "export const a = 1;\n")]);
  try {
    const before = scannerPlanHashOf(DEFAULT_SECURITY_POLICY);
    mkdirSync(join(b.repo, ".cie"), { recursive: true }); writeFileSync(join(b.repo, ".cie", "security.json"), JSON.stringify({ requireExternalSast: false }));
    const ok = await b.h["C27/runSecurityValidation"]!(b.as("arun", "p1"), { patchBindingHash: b.cand.bindingHash, scannerPlanHash: before, budget: { wallMs: 5000 } });
    assert.ok(!ok.ok && ok.error.code === "STALE_REVISION", "the old hash no longer matches the repository's policy");
    const now = scannerPlanHashOf({ ...DEFAULT_SECURITY_POLICY, requireExternalSast: false });
    const run = await b.h["C27/runSecurityValidation"]!(b.as("arun", "p2"), { patchBindingHash: b.cand.bindingHash, scannerPlanHash: now, budget: { wallMs: 5000 } });
    assert.ok(run.ok); const job = await b.svc.jobs.settled(run.value.jobId); assert.equal(((job.result!.value as any).value ?? job.result!.value).status, "PASS", "the policy that waives the external analyser applies");
    writeFileSync(join(b.repo, ".cie", "security.json"), "{ nope");
    const broken = await b.h["C27/runSecurityValidation"]!(b.as("arun", "p3"), { patchBindingHash: b.cand.bindingHash, scannerPlanHash: now, budget: { wallMs: 5000 } });
    assert.ok(!broken.ok && broken.error.code === "INVALID_SCHEMA" && /security\.json is invalid/.test(broken.error.message));
    void rawHash; void dirname;
  } finally { b.close(); }
});

test("#79 SEC007 ignores SRI integrity strings but still flags other high-entropy literals", () => {
  const rule = SECRET_RULES.find((r) => r.id === "SEC007")!;
  assert.equal(rule.test(`integrity: "sha512-Zm9vYmFyYmF6cXV4Y29yZ2VncmF1bHRnYXJwbHlmcmVkcGx1Z2h4eg"`), null);
  assert.ok(rule.test(`const k = "Zm9vYmFyYmF6cXV4Y29yZ2VncmF1bHRnYXJwbHlmcmVkcGx1Z2h4eg";`));
  assert.equal(rule.test(`"0123456789abcdef0123456789abcdef"`), null);
});

test("#80 SAST002 flags child_process commands built from text and not RegExp.exec or literals", () => {
  const rule = SAST_RULES.find((r) => r.id === "SAST002")!;
  for (const l of [`exec("ls " + dir)`, `child_process.exec('ls ' + dir)`, "execSync(`ls ${dir}`)", `execSync(cmd)`, `cp.execFile(cmd, args)`, `spawn(cmd, { shell: true })`]) assert.ok(rule.test(l), l);
  for (const l of [`const m = re.exec(value)`, `const r = pattern.exec(input);`, `exec('ls')`, `/a/g.exec(x)`, `spawn("ls", ["-l"])`, `execFile("ls", [dir])`]) assert.equal(rule.test(l), null, l);
});
