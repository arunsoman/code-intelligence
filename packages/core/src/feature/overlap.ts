// Task 2.I — existing-capability overlap and reuse (spec §37; PF-057–062; AT-49–54, AT-60).
// A name, a similarity score or an embedding is only a RETRIEVAL signal. A relationship is claimed from observations read out of the
// repository (entry points, tests with assertions, access and tenant checks, side effects, flags), each citing a content hash so it
// goes stale when the file changes. EQUIVALENT / REUSED are never asserted without behavioural evidence or an authorised decision;
// without it the answer is UNCERTAIN and the unknowns are listed. A search that finds nothing says "not found within the searched scope".
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { policyFor } from "../access.ts";
import { extractAssertions, isTestPath } from "../execution.ts";
import { rawHash, canonHash, defineSchema, asSet, type Canon } from "./canon.ts";
import { readText, walk, SRC } from "./discovery.ts";
import { FeatureError } from "./errors.ts";
import { eventFor } from "./lifecycle.ts";
import { snapshotOf } from "./intake.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { Store } from "../store.ts";
import type { BehaviourMapping, CapabilityRef, CoverageRecord, FeatureRecord, Hash, Id, ImpactAssessment, OverlapAssessment, OverlapObservation, OverlapRelationship, Outcome, OverlapEvidence, ReuseStrategy, Snapshot, SourceRef, VerifiedOverlapAssessment } from "./types.ts";

export interface OverlapDeps { fs: SqliteFeatureStore; store: Store }
export const STRATEGIES: readonly ReuseStrategy[] = ["NO_CHANGE", "CONFIGURE", "EXTEND", "COMPOSE", "REFACTOR_AND_REUSE", "SEPARATE", "REPLACE"];
/** Retrieval is deliberately generous: a name match only OFFERS a capability for comparison. The comparison and the evidence rules decide anything. */
export const RETRIEVAL_MIN = 0.2;
const STOP = new Set(["that", "this", "with", "from", "have", "will", "shall", "must", "should", "when", "then", "than", "into", "their", "there", "which", "while", "each", "every", "only", "also", "been", "being", "were", "your", "they", "them", "does", "would", "could", "about", "such", "other", "these", "those", "user", "users", "system", "feature", "the", "and", "for", "are", "not", "can", "may", "all", "any", "data"]);
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");
const terms = (t: string): Set<string> => new Set((t.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOP.has(w)).map(stem));
const camelWords = (s: string): string[] => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
const idTerms = (s: string): Set<string> => new Set(camelWords(s).flatMap((w) => [...terms(w)]));
const hitRatio = (need: Set<string>, have: Set<string>): number => (need.size ? [...need].filter((w) => have.has(w)).length / need.size : 0);

const EFFECTS: [string, RegExp][] = [["email", /\b(sendMail|smtp|nodemailer|sendEmail|mailer|email)\b/i], ["network", /\b(fetch\(|axios|http\.request|got\(|webhook)/i], ["database-write", /\b(insert into|update\s+\w+\s+set|delete from|\.insert\(|\.update\(|\.delete\(|\.save\()/i], ["file-write", /\b(writeFile|createWriteStream|appendFile)\b/i], ["queue", /\b(enqueue|publish\(|emit\(|\.send\(\s*['"`][\w.-]+['"`])/i], ["payment", /\b(charge|refund|capture|payout|stripe)\b/i]];
const REQUEST_EFFECT: [string, RegExp][] = [["email", /\b(email|e-mail|mail)\b/i], ["network", /\b(webhook|call (an )?api|http|third[- ]party)\b/i], ["database-write", /\b(store|save|persist|record|update|delete|remove|insert|write)\b/i], ["file-write", /\b(download|file|upload|csv|pdf|attachment)\b/i], ["queue", /\b(notify|notification|event|queue|background job)\b/i], ["payment", /\b(pay|payment|charge|refund)\b/i]];
const ACCESS = /\b(authorize|requireRole|hasPermission|isAdmin|checkAccess|assertCan|permit\(|can\()/;
const TENANT = /\b(tenantId|tenant_id|orgId|organizationId|workspaceId)\b/;
const FAILURE = /\b(retry|retries|timeout|AbortSignal|backoff|idempoten\w+|catch\s*\()/i;
const FLAG = /(?:featureFlag|isEnabled|flag)\(\s*['"`]([\w.-]+)['"`]|\bflags?\.([A-Za-z0-9_]+)|process\.env\.([A-Z][A-Z0-9_]*)/g;

const readSafe = (root: string, rel: string): string => readText(root, rel);
const policyOf = (d: OverlapDeps, rec: FeatureRecord) => policyFor(d.store, rec.repositoryId);
function byContract(fs: SqliteFeatureStore, actor: Id, hash: string): FeatureRecord {
  for (const r of fs.listRequests(undefined, 1000)) if (r.createdBy === actor && r.contract?.hash === hash) return r;
  throw new FeatureError("NOT_FOUND", "no contract with that hash");
}
function byAssessment(fs: SqliteFeatureStore, actor: Id, id: Id): FeatureRecord {
  for (const r of fs.listRequests(undefined, 1000)) if (r.createdBy === actor && r.contract?.overlap?.id === id) return r;
  throw new FeatureError("NOT_FOUND", `no overlap assessment ${id}`);
}
const staleSnapshot = (d: OverlapDeps, rec: FeatureRecord, s: Snapshot): boolean => { if (s.repositoryId !== rec.repositoryId) throw new FeatureError("INVALID_SCHEMA", "the snapshot is for a different repository"); return s.contentRootHash !== snapshotOf(d.store, rec.repositoryId).contentRootHash; };

/** Flag values from the repository's own configuration (a flags file or config/*.json). A flag with no recorded value stays UNKNOWN. */
function flagValues(root: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const files = ["flags.json", ".cie/flags.json", "config/flags.json", "config/features.json", "config/default.json"];
  for (const f of files) { const p = join(root, f); if (!existsSync(p)) continue; try { const j = JSON.parse(readFileSync(p, "utf8")); const walkObj = (o: any, pre: string) => { for (const [k, v] of Object.entries(o ?? {})) { if (typeof v === "boolean") out.set(k, v), out.set(`${pre}${k}`, v); else if (v && typeof v === "object") walkObj(v, `${pre}${k}.`); } }; walkObj(j, ""); } catch { /* an unreadable config is no evidence */ } }
  return out;
}

/** `.cie/glossary.json`: { "terms": { "export": ["download", "statement"] } }. Lets a differently named feature be found (AT-50); still only a retrieval signal. */
export function loadAliases(root: string): Map<string, string[]> {
  const p = join(root, ".cie", "glossary.json"); const out = new Map<string, string[]>(); if (!existsSync(p)) return out;
  let j: any; try { j = JSON.parse(readFileSync(p, "utf8")); } catch { throw new FeatureError("INVALID_SCHEMA", ".cie/glossary.json is not valid JSON"); }
  if (!j || typeof j !== "object" || Array.isArray(j) || Object.keys(j).some((k) => k !== "terms") || (j.terms !== undefined && (typeof j.terms !== "object" || Array.isArray(j.terms)))) throw new FeatureError("INVALID_SCHEMA", ".cie/glossary.json must be { \"terms\": { word: [aliases] } }");
  for (const [k, v] of Object.entries(j.terms ?? {})) { if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim())) throw new FeatureError("INVALID_SCHEMA", `glossary entry ${k} must be a list of words`); out.set(...[stem(k.toLowerCase()), (v as string[]).map((x) => stem(x.toLowerCase()))] as [string, string[]]); }
  return out;
}
const withAliases = (t: Set<string>, aliases: Map<string, string[]>): Set<string> => { const out = new Set(t); for (const w of t) for (const a of aliases.get(w) ?? []) out.add(a); return out; };

function symbolsOf(text: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  text.split("\n").forEach((l, n) => {
    const m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/.exec(l) ?? /\.(?:get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/.exec(l);
    if (m) out.push({ name: m[1]!, line: n + 1 });
  });
  return out;
}

/** Does any assertion (its test name or its expected value) in this test file speak about the criterion's behaviour? */
export function coversCriterion(path: string, text: string, need: Set<string>): boolean {
  return extractAssertions(path, text).some((x) => hitRatio(need, terms(`${x.testCase} ${x.value}`)) >= 0.3);
}
const refFor = (path: string, text: string): SourceRef => ({ artifactId: path, version: "1", locator: `repo:${path}`, contentHash: rawHash(text) });
const capId = (path: string, symbols: string[]): Id => `cap:${rawHash(`${path}\0${symbols.join(",")}`).slice(0, 16)}`;

export function findRelatedCapabilities(d: OverlapDeps, actor: Id, i: { contractHash: string; snapshot: Snapshot; scope: string; budget: { files: number } }): Outcome<{ capabilities: CapabilityRef[]; coverage: CoverageRecord[] }> {
  const rec = byContract(d.fs, actor, i.contractHash); const contract = rec.contract!;
  if (!(i.budget?.files > 0) || i.budget.files > 100_000) throw new FeatureError("INVALID_SCHEMA", "budget.files must be between 1 and 100000");
  if (typeof i.scope !== "string" || i.scope.includes("\0") || i.scope.startsWith("/") || i.scope.split("/").includes("..")) throw new FeatureError("INVALID_SCHEMA", "scope must be a repository-relative path prefix");
  if (staleSnapshot(d, rec, i.snapshot)) return { status: "STALE", evidenceIds: [], diagnostics: ["the repository changed since this snapshot was taken"] };
  const policy = policyOf(d, rec); const root = rec.repositoryId;
  const walked = walk(root, i.budget.files, (rel) => policy.denied(rel));
  const prefix = i.scope.replace(/^\.\//, "").replace(/\/$/, "");
  const files = walked.files.filter((f) => SRC.test(f) && !isTestPath(f) && (!prefix || f === prefix || f.startsWith(prefix + "/")));
  const flags = flagValues(root);
  const aliases = loadAliases(root); const reqTerms = contract.requirements.map((r) => ({ id: r.id, t: withAliases(terms(r.text), aliases) }));
  const found: { path: string; text: string; symbols: { name: string; line: number }[]; score: number; reqs: Id[] }[] = [];
  for (const rel of files) {
    const text = readSafe(root, rel); const symbols = symbolsOf(text); const own = new Set([...idTerms(rel), ...symbols.flatMap((s) => [...idTerms(s.name)])]);
    const reqs = reqTerms.filter((r) => hitRatio(r.t, own) >= RETRIEVAL_MIN).map((r) => r.id); if (!reqs.length) continue;
    const named = symbols.filter((s) => reqTerms.some((r) => hitRatio(r.t, idTerms(s.name)) >= 0.2)); const score = reqs.length + named.length;
    found.push({ path: rel, text, symbols: (named.length ? named : symbols).slice(0, 6), score, reqs });
  }
  found.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const capabilities: CapabilityRef[] = found.slice(0, 12).map((f) => {
    const used = [...f.text.matchAll(FLAG)].map((m) => m[1] ?? m[2] ?? m[3]!).filter(Boolean);
    const known = used.map((u) => flags.get(u)).filter((v): v is boolean => v !== undefined);
    const availability: CapabilityRef["availability"] = known.includes(false) ? "DISABLED" : "UNKNOWN";
    return { id: capId(f.path, f.symbols.map((s) => s.name)), snapshot: { ...i.snapshot }, requirementIds: f.reqs, entryPoints: f.symbols.map((s) => `${f.path}#${s.name}`), sourceRefs: [refFor(f.path, f.text)], configBindingHash: rawHash(JSON.stringify(used.sort().map((u) => [u, flags.get(u) ?? null]))), availability };
  });
  const coverage: CoverageRecord = { domain: "CAPABILITIES", state: walked.truncated ? "PARTIAL" : "COMPLETE_WITHIN_SCOPE", searchedRoots: [prefix || "."], excluded: [{ root: "tests", reason: "tests are evidence about a capability, not capabilities" }, { root: "node_modules, build output, VCS", reason: "dependencies and generated files" }],
    tools: ["file-walk", "identifier-scan", "flag-config"], found: capabilities.length ? "FOUND" : "NOT_FOUND_WITHIN_SEARCHED_SCOPE", artifacts: capabilities.flatMap((c) => c.entryPoints).slice(0, 20), unsupported: [],
    unresolved: [...(walked.truncated ? [`the walk stopped after ${walked.files.length} files; the rest was not searched`] : []), ...(walked.deniedCount ? [`${walked.deniedCount} path(s) were left out by access policy`] : [])] };
  return { status: coverage.state === "COMPLETE_WITHIN_SCOPE" ? "COMPLETE" : "PARTIAL", value: { capabilities, coverage: [coverage] }, evidenceIds: [], diagnostics: [capabilities.length ? `${capabilities.length} candidate(s) found by name and identifier; a name match is a lead, not evidence of equivalence` : "nothing matched within the searched scope; that is not a statement about the whole repository", ...coverage.unresolved] };
}

// ------------------------------------------------------------------------------------------------ comparison

interface Facts { path: string; text: string; obs: OverlapObservation[]; access: boolean; tenant: boolean; effects: Set<string>; failure: boolean; flagsOff: string[]; skippedTests: boolean; tests: { path: string; assertions: number; text: string }[] }
const obsId = (kind: string, path: string, line: number | undefined, detail: string): Id => `obs:${rawHash(`${kind}\0${path}\0${line ?? ""}\0${detail}`).slice(0, 16)}`;
const mkObs = (kind: OverlapObservation["kind"], path: string, line: number | undefined, detail: string, text: string): OverlapObservation => ({ id: obsId(kind, path, line, detail), kind, path, line, detail: detail.slice(0, 160), contentHash: rawHash(text) });

function factsFor(d: OverlapDeps, rec: FeatureRecord, ref: CapabilityRef, testFiles: { path: string; text: string }[]): Facts {
  const path = ref.sourceRefs[0]!.locator.slice(5); const text = readSafe(rec.repositoryId, path); const obs: OverlapObservation[] = []; const lines = text.split("\n");
  for (const e of ref.entryPoints) obs.push(mkObs("ENTRY_POINT", path, symbolsOf(text).find((s) => e.endsWith(`#${s.name}`))?.line, e, text));
  const effects = new Set<string>();
  lines.forEach((l, n) => {
    if (ACCESS.test(l)) obs.push(mkObs("ACCESS_CHECK", path, n + 1, l.trim(), text));
    if (TENANT.test(l)) obs.push(mkObs("TENANT_SCOPE", path, n + 1, l.trim(), text));
    for (const [name, re] of EFFECTS) if (re.test(l) && !effects.has(name)) { effects.add(name); obs.push(mkObs("SIDE_EFFECT", path, n + 1, name, text)); }
    if (FAILURE.test(l) && !obs.some((o) => o.kind === "FAILURE_HANDLING")) obs.push(mkObs("FAILURE_HANDLING", path, n + 1, l.trim(), text));
  });
  const flagsOff: string[] = []; const fv = flagValues(rec.repositoryId);
  for (const m of text.matchAll(FLAG)) { const name = m[1] ?? m[2] ?? m[3]!; const v = fv.get(name); if (v !== undefined) { obs.push(mkObs("CONFIG_FLAG", path, undefined, `${name}=${v}`, text)); if (v === false) flagsOff.push(name); } }
  const base = path.replace(/\.[^.]+$/, "").split("/").pop()!; const symbols = ref.entryPoints.map((e) => e.split("#")[1]!).filter(Boolean);
  const tests: Facts["tests"] = []; let skipped = false;
  for (const t of testFiles) {
    if (!(t.text.includes(base) || symbols.some((s) => new RegExp(`\\b${s.replace(/[^\w$]/g, "")}\\b`).test(t.text)))) continue;
    const a = extractAssertions(t.path, t.text).length; tests.push({ path: t.path, assertions: a, text: t.text });
    const at = t.text.split("\n").findIndex((l) => base && l.includes(base));
    obs.push(mkObs("TEST_REFERENCE", t.path, at >= 0 ? at + 1 : undefined, `${a} assertion(s) in a test that exercises ${base}`, t.text));
    if (/(\.skip|\.todo|xdescribe|xit)\s*\(/.test(t.text)) { skipped = true; obs.push(mkObs("SKIPPED_TEST", t.path, undefined, "a test for this capability is skipped or marked todo", t.text)); }
  }
  return { path, text, obs, access: obs.some((o) => o.kind === "ACCESS_CHECK"), tenant: obs.some((o) => o.kind === "TENANT_SCOPE"), effects, failure: obs.some((o) => o.kind === "FAILURE_HANDLING"), flagsOff, skippedTests: skipped, tests };
}

function allTests(d: OverlapDeps, rec: FeatureRecord): { path: string; text: string }[] {
  const policy = policyOf(d, rec); const w = walk(rec.repositoryId, 20_000, (rel) => policy.denied(rel));
  return w.files.filter((f) => isTestPath(f) && /\.[cm]?[jt]sx?$/.test(f)).map((path) => ({ path, text: readSafe(rec.repositoryId, path) }));
}

const OverlapId = defineSchema<{ contract: string; mappings: unknown; rel: string; strat: string; obs: string[] }>("pf.OverlapAssessment", "1", (o) => ({ contract: o.contract, mappings: JSON.stringify(o.mappings), rel: o.rel, strat: o.strat, obs: asSet(o.obs) as Canon }));
const STRATEGY_FOR: Record<OverlapRelationship, ReuseStrategy> = { EQUIVALENT: "NO_CHANGE", REQUEST_EXTENDS_EXISTING: "EXTEND", EXISTING_SUPERSET: "CONFIGURE", CONFIGURATION_ONLY: "CONFIGURE", PARTIAL_OVERLAP: "COMPOSE", RELATED_INCOMPATIBLE: "SEPARATE", EXISTING_DEFECT: "EXTEND", UNCERTAIN: "SEPARATE", NO_MATCH_WITHIN_SCOPE: "SEPARATE" };

export function compareRequestedBehaviour(d: OverlapDeps, actor: Id, i: { contractHash: string; capabilityRefs: CapabilityRef[]; evidenceIds: Id[] }): Outcome<OverlapAssessment> {
  const rec = byContract(d.fs, actor, i.contractHash); const contract = rec.contract!; const policy = policyOf(d, rec);
  if (!Array.isArray(i.capabilityRefs) || i.capabilityRefs.length > 12 || !Array.isArray(i.evidenceIds)) throw new FeatureError("INVALID_SCHEMA", "capabilityRefs (at most 12) and evidenceIds must be lists");
  const tests = allTests(d, rec); const aliases = loadAliases(rec.repositoryId); const caps: CapabilityRef[] = []; const facts = new Map<Id, Facts>();
  for (const ref of i.capabilityRefs) {
    const path = ref?.sourceRefs?.[0]?.locator?.startsWith("repo:") ? ref.sourceRefs[0]!.locator.slice(5) : "";
    if (!path || path.startsWith("/") || path.split("/").includes("..") || policy.denied(path) || !existsSync(join(rec.repositoryId, path))) throw new FeatureError("NOT_FOUND", "a capability reference does not name a file you can compare");
    if (rawHash(readSafe(rec.repositoryId, path)) !== ref.sourceRefs[0]!.contentHash) throw new FeatureError("STALE_REVISION", `${path} changed since the capability was found; search again`);
    caps.push(ref); facts.set(ref.id, factsFor(d, rec, ref, tests));
  }
  const decisions = d.fs.listDecisions(rec.requestId); const decisionObs: OverlapObservation[] = [];
  for (const id of i.evidenceIds) { const dec = decisions.find((x) => x.id === id); if (!dec) throw new FeatureError("NOT_FOUND", `evidence ${id} is not a recorded decision of this request`); decisionObs.push({ id: `obs:${dec.id}`, kind: "DECISION", path: dec.id, detail: `${dec.kind} by ${dec.actorId}: ${dec.answer.slice(0, 100)}`, contentHash: rawHash(dec.answer) }); }
  const observations = new Map<Id, OverlapObservation>(); for (const f of facts.values()) for (const o of f.obs) observations.set(o.id, o); for (const o of decisionObs) observations.set(o.id, o);
  const requirement = (id: Id) => contract.requirements.find((r) => r.id === id);
  const mappings: BehaviourMapping[] = []; const differences: NonNullable<OverlapAssessment["differences"]> = []; const regression = new Set<string>(); const unresolved: Id[] = []; const reasons: string[] = [];
  const kinds = new Set<string>();
  for (const a of contract.acceptance) {
    const need = withAliases(terms(`${a.scenario} ${a.expectedOutcome}`), aliases);
    const reqs = a.requirementIds.map((r) => requirement(r)).filter(Boolean) as NonNullable<ReturnType<typeof requirement>>[];
    const needsAccess = reqs.some((r) => r.type === "ACCESS" || /\b(role|permission|authori[sz]ed|only .* can|access)\b/i.test(r.text)), needsTenant = reqs.some((r) => /\b(tenant|their own|own (data|records)|current (tenant|organi[sz]ation))\b/i.test(`${r.text} ${r.conditions.join(" ")}`));
    const wantedEffects = new Set(REQUEST_EFFECT.filter(([, re]) => re.test(`${a.scenario} ${a.expectedOutcome}`)).map(([k]) => k));
    const matched = caps.filter((c) => { const f = facts.get(c.id)!; const have = new Set([...idTerms(f.path), ...c.entryPoints.flatMap((e) => [...idTerms(e)])]); return hitRatio(need, have) >= 0.3; });
    if (!matched.length) { mappings.push({ acceptanceId: a.id, capabilityIds: [], disposition: "NEW", differences: ["no existing capability matched within the searched scope"], evidenceIds: [], coverageState: "COMPLETE_WITHIN_SCOPE" }); continue; }
    const cap = matched[0]!; const f = facts.get(cap.id)!; const diffs: string[] = []; let incompatible = false, extend = false;
    if (needsAccess && !f.access) { diffs.push("access: the request needs a permission check and the existing capability has none"); incompatible = true; differences.push({ acceptanceId: a.id, dimension: "Actors/access", detail: diffs.at(-1)! }); }
    if (needsTenant && !f.tenant) { diffs.push("tenancy: the request is limited to the caller's tenant and the existing capability shows no tenant scope"); incompatible = true; differences.push({ acceptanceId: a.id, dimension: "Actors/access", detail: diffs.at(-1)! }); }
    const extra = [...f.effects].filter((e) => !wantedEffects.has(e)); if (extra.length) { diffs.push(`side effects: the existing capability also does ${extra.join(", ")}, which the request did not ask for`); incompatible = true; differences.push({ acceptanceId: a.id, dimension: "State/effects", detail: diffs.at(-1)! }); }
    const missing = [...wantedEffects].filter((e) => !f.effects.has(e) && !["database-write", "file-write"].includes(e)); if (missing.length) { diffs.push(`the request adds ${missing.join(", ")}, which the existing capability does not do`); extend = true; differences.push({ acceptanceId: a.id, dimension: "State/effects", detail: diffs.at(-1)! }); }
    if (f.flagsOff.length) { diffs.push(`availability: implemented but disabled by ${f.flagsOff.join(", ")}`); differences.push({ acceptanceId: a.id, dimension: "Availability", detail: diffs.at(-1)! }); }
    if (f.skippedTests) { diffs.push("evidence: tests for the existing capability are skipped, so it may be defective"); differences.push({ acceptanceId: a.id, dimension: "Evidence", detail: diffs.at(-1)! }); }
    // a test counts as evidence only if its assertions actually speak about this behaviour; a test that merely names the capability does not
    const covering = f.tests.filter((t) => coversCriterion(t.path, t.text, need));
    const evidence = f.obs.filter((o) => o.kind === "TEST_REFERENCE" && covering.some((t) => t.path === o.path)).map((o) => o.id);
    if (!covering.length && f.tests.length) diffs.push("tests mention this capability, but none asserts the behaviour the criterion describes");
    const decided = decisionObs.filter((o) => /^(equivalent|same|reuse|confirm)/i.test(o.detail.split(": ")[1] ?? "")).map((o) => o.id);
    if (incompatible) { mappings.push({ acceptanceId: a.id, capabilityIds: [cap.id], disposition: "NEW", differences: diffs, evidenceIds: [], coverageState: "COMPLETE_WITHIN_SCOPE" }); kinds.add("INCOMPATIBLE"); continue; }
    for (const t of f.tests) regression.add(`${t.path} must keep passing for ${f.path}`);
    if (f.skippedTests) { mappings.push({ acceptanceId: a.id, capabilityIds: [cap.id], disposition: "MODIFIED", differences: diffs, evidenceIds: [...evidence], coverageState: "COMPLETE_WITHIN_SCOPE" }); kinds.add("DEFECT"); continue; }
    if (evidence.length === 0 && decided.length === 0) { mappings.push({ acceptanceId: a.id, capabilityIds: [cap.id], disposition: "NEW", differences: [...diffs, "no behavioural evidence (a test with assertions, or an authorised decision) shows it already does this"], evidenceIds: [], coverageState: "PARTIAL" }); unresolved.push(a.id); kinds.add("UNCERTAIN"); continue; }
    mappings.push({ acceptanceId: a.id, capabilityIds: [cap.id], disposition: extend ? "MODIFIED" : "REUSED", differences: diffs, evidenceIds: [...new Set([...evidence, ...decided])], coverageState: "COMPLETE_WITHIN_SCOPE" });
    kinds.add(extend ? "EXTEND" : f.flagsOff.length ? "DISABLED" : "REUSED");
  }
  const reused = mappings.filter((m) => m.disposition === "REUSED").length, modified = mappings.filter((m) => m.disposition === "MODIFIED").length, fresh = mappings.filter((m) => m.disposition === "NEW").length;
  let relationship: OverlapRelationship;
  if (!caps.length || mappings.every((m) => m.capabilityIds.length === 0)) relationship = "NO_MATCH_WITHIN_SCOPE";
  else if (kinds.has("DEFECT")) relationship = "EXISTING_DEFECT";
  else if (kinds.has("INCOMPATIBLE") && !reused && !modified) relationship = "RELATED_INCOMPATIBLE";
  else if (kinds.has("DISABLED") && reused && !fresh && !modified) relationship = "CONFIGURATION_ONLY";
  else if (reused && !fresh && !modified && !unresolved.length) relationship = "EQUIVALENT";
  else if ((reused || modified) && (fresh || kinds.has("EXTEND"))) relationship = "REQUEST_EXTENDS_EXISTING";
  else if (unresolved.length && !reused && !modified) relationship = "UNCERTAIN";
  else relationship = "PARTIAL_OVERLAP";
  const strategy = STRATEGY_FOR[relationship];
  if (relationship === "UNCERTAIN") reasons.push("provisional: nothing is reused until the overlap is verified; use investigateOverlap or record a decision");
  if (relationship === "EQUIVALENT") reasons.push("equivalence still needs verifyOverlap before a request may be closed as ALREADY_SUPPORTED");
  const alternatives = STRATEGIES.filter((s) => s !== strategy).map((s) => `${s}: ${s === "SEPARATE" ? "a parallel implementation needs a justified reason" : s === "NO_CHANGE" ? "only if equivalence is verified" : s === "REPLACE" ? "needs a consumer inventory and authorisation" : "considered, not selected"}`);
  const body = { contract: contract.hash, mappings, rel: relationship, strat: strategy, obs: [...observations.keys()] };
  const assessment: OverlapAssessment = { id: `overlap:${canonHash(OverlapId, body).split(":").pop()!.slice(0, 24)}`, contractHash: contract.hash, comparedSnapshots: [rec.source], relationship, strategy, mappings, alternatives, unresolvedIds: unresolved, observations: [...observations.values()], capabilities: caps, differences, regressionObligations: [...regression].sort(), reasons, verified: false };
  store(d.fs, rec, actor, assessment, `overlap assessed: ${relationship} (${strategy}); ${unresolved.length} unresolved`);
  return { status: "COMPLETE", value: assessment, evidenceIds: [...observations.keys()], diagnostics: [...reasons, "a similarity match is a retrieval signal, never evidence of equivalence"] };
}

function store(fs: SqliteFeatureStore, rec: FeatureRecord, actor: Id, a: OverlapAssessment, rationale: string): void {
  for (let attempt = 0; ; attempt++) {
    const cur = fs.getRequest(rec.requestId)!; if (!cur.contract) throw new FeatureError("NOT_FOUND", "the request has no contract");
    try { fs.updateRequest(rec.requestId, cur.version, { ...cur, contract: { ...cur.contract, overlap: a }, workspace: { ...cur.workspace, workspaceVersion: cur.workspace.workspaceVersion + 1 } }, eventFor(cur, "StateChanged", actor, { producer: "C15", rationale })); return; }
    catch (e) { if (!(e instanceof FeatureError) || e.code !== "VERSION_CONFLICT" || attempt) throw e; }
  }
}

// ------------------------------------------------------------------------------------------------ investigation (bounded, manual or tool-assisted)

export function investigateOverlap(d: OverlapDeps, actor: Id, i: { assessmentId: Id; unknownIds: Id[]; budget: { steps: number } }): Outcome<OverlapEvidence> {
  const rec = byAssessment(d.fs, actor, i.assessmentId); const a = rec.contract!.overlap!;
  if (!Number.isInteger(i.budget?.steps) || i.budget.steps < 1 || i.budget.steps > 50) throw new FeatureError("INVALID_SCHEMA", "budget.steps must be an integer from 1 to 50");
  if (!Array.isArray(i.unknownIds) || !i.unknownIds.length) throw new FeatureError("INVALID_SCHEMA", "name at least one unknown criterion");
  for (const u of i.unknownIds) if (!a.unresolvedIds.includes(u)) throw new FeatureError("NOT_FOUND", `${u} is not an unresolved criterion of this assessment`);
  const contract = rec.contract!; const tests = allTests(d, rec); let steps = 0; const found: OverlapObservation[] = []; const settled = new Set<Id>(); const evidenceFor = new Map<Id, Id[]>();
  outer: for (const u of i.unknownIds) {
    const crit = contract.acceptance.find((x) => x.id === u)!; const need = terms(`${crit.scenario} ${crit.expectedOutcome}`); const mapping = a.mappings.find((m) => m.acceptanceId === u)!;
    for (const capId_ of mapping.capabilityIds) {
      const cap = a.capabilities?.find((c) => c.id === capId_); if (!cap) continue;
      const base = cap.sourceRefs[0]!.locator.slice(5).replace(/\.[^.]+$/, "").split("/").pop()!;
      const dirWords = new Set(cap.sourceRefs[0]!.locator.slice(5).split("/").slice(0, -1).filter((x) => x !== "src" && x.length > 2));
      for (const t of tests) {
        // wider than compare: also tests that sit in the same area (a directory name they share) even if they never name the file
        const near = [...dirWords].some((w) => t.path.split("/").includes(w));
        if (steps >= i.budget.steps) break outer; if (!t.text.includes(base) && !near) continue; steps++;
        const asserts = extractAssertions(t.path, t.text); const covered = asserts.filter((x) => hitRatio(need, terms(`${x.testCase} ${x.value}`)) >= 0.3);
        if (covered.length) { const o = mkObs("TEST_REFERENCE", t.path, undefined, `${covered.length} assertion(s) cover "${crit.expectedOutcome.slice(0, 60)}"`, t.text); found.push(o); evidenceFor.set(u, [...(evidenceFor.get(u) ?? []), o.id]); settled.add(u); }
      }
    }
  }
  const observations = new Map((a.observations ?? []).map((o) => [o.id, o])); for (const o of found) observations.set(o.id, o);
  const mappings = a.mappings.map((m) => (evidenceFor.has(m.acceptanceId) ? { ...m, evidenceIds: [...new Set([...m.evidenceIds, ...evidenceFor.get(m.acceptanceId)!])] } : m));
  const still = a.unresolvedIds.filter((u) => !settled.has(u));
  const next: OverlapAssessment = { ...a, mappings, observations: [...observations.values()], unresolvedIds: still, verified: false };
  const body = { contract: next.contractHash, mappings, rel: next.relationship, strat: next.strategy, obs: [...observations.keys()] };
  next.id = `overlap:${canonHash(OverlapId, body).split(":").pop()!.slice(0, 24)}`;
  store(d.fs, rec, actor, next, `overlap investigated: ${found.length} observation(s) in ${steps} step(s); ${still.length} still unresolved`);
  return { status: steps >= i.budget.steps && still.length ? "PARTIAL" : "COMPLETE", value: { schemaVersion: 1, id: `oev:${next.id.split(":").pop()}`, evidenceIds: found.map((o) => o.id), observations: found, stepsUsed: steps, unresolvedIds: still }, evidenceIds: found.map((o) => o.id), diagnostics: [`${steps} of ${i.budget.steps} step(s) used`, ...(still.length ? [`${still.length} criterion(s) still have no behavioural evidence; no equivalence is asserted for them`] : [])] };
}

// ------------------------------------------------------------------------------------------------ verification

export interface OverlapPolicy { requireAssertions: boolean; allowDecisionOverride: boolean }
export const DEFAULT_OVERLAP_POLICY: OverlapPolicy = { requireAssertions: true, allowDecisionOverride: true };
const PolicySchema = defineSchema<OverlapPolicy>("pf.OverlapPolicy", "1", (p) => ({ requireAssertions: p.requireAssertions, allowDecisionOverride: p.allowDecisionOverride }));
export const overlapPolicyHash = (p: OverlapPolicy = DEFAULT_OVERLAP_POLICY): Hash => canonHash(PolicySchema, p);

export function verifyOverlap(d: OverlapDeps, actor: Id, i: { assessmentId: Id; policyHash: Hash; evidenceIds: Id[] }): Outcome<VerifiedOverlapAssessment> {
  const rec = byAssessment(d.fs, actor, i.assessmentId); const a = rec.contract!.overlap!;
  if (i.policyHash !== overlapPolicyHash()) throw new FeatureError("STALE_REVISION", "the overlap verification policy changed; reload it");
  if (!Array.isArray(i.evidenceIds)) throw new FeatureError("INVALID_SCHEMA", "evidenceIds must be a list");
  const known = new Map((a.observations ?? []).map((o) => [o.id, o])); for (const id of i.evidenceIds) if (!known.has(id) && !d.fs.listDecisions(rec.requestId).some((x) => x.id === id)) throw new FeatureError("NOT_FOUND", `evidence ${id} is not part of this assessment`);
  const current = (o: OverlapObservation): boolean => o.kind === "DECISION" || (existsSync(join(rec.repositoryId, o.path)) && rawHash(readFileSync(join(rec.repositoryId, o.path), "utf8")) === o.contentHash);
  const allowed = new Set(i.evidenceIds.length ? i.evidenceIds : [...known.keys()]); const reasons: string[] = [...(a.reasons ?? []).filter((r) => !r.startsWith("verification:"))]; const stale: Id[] = [];
  const mappings = a.mappings.map((m): BehaviourMapping => {
    if (m.disposition !== "REUSED" && m.disposition !== "MODIFIED") return m;
    const ev = m.evidenceIds.filter((id) => allowed.has(id)).map((id) => known.get(id)).filter(Boolean) as OverlapObservation[];
    const fresh = ev.filter(current); for (const o of ev) if (!current(o)) stale.push(o.id);
    const ok = fresh.some((o) => o.kind === "TEST_REFERENCE") || (DEFAULT_OVERLAP_POLICY.allowDecisionOverride && fresh.some((o) => o.kind === "DECISION"));
    if (m.disposition === "MODIFIED" && m.differences.some((x) => /skipped/.test(x))) return m;
    return ok ? m : { ...m, disposition: "BLOCKED", differences: [...m.differences, "no current behavioural evidence: a verified test with assertions, or an authorised decision, is required"], coverageState: "PARTIAL" };
  });
  const blocked = mappings.filter((m) => m.disposition === "BLOCKED").map((m) => m.acceptanceId);
  let relationship = a.relationship; let strategy = a.strategy;
  if (blocked.length && (relationship === "EQUIVALENT" || relationship === "CONFIGURATION_ONLY")) { relationship = "UNCERTAIN"; strategy = "SEPARATE"; reasons.push("verification: equivalence was claimed without current evidence, so it is UNCERTAIN"); }
  if (stale.length) reasons.push(`verification: ${stale.length} observation(s) are stale because their file changed`);
  const verified = !blocked.length && !a.unresolvedIds.length && relationship !== "UNCERTAIN" && relationship !== "NO_MATCH_WITHIN_SCOPE" ? true : false;
  const entry = a.capabilities?.[0]?.entryPoints[0];
  if (verified && relationship === "EQUIVALENT" && strategy === "NO_CHANGE") reasons.push(`ALREADY_SUPPORTED: ${entry ?? "an existing capability"} already does this; no file will change`);
  const next: OverlapAssessment = { ...a, mappings, relationship, strategy, verified, policyHash: overlapPolicyHash(), unresolvedIds: [...new Set([...a.unresolvedIds, ...blocked])], reasons };
  store(d.fs, rec, actor, next, `overlap verified: ${verified ? "yes" : "no"} (${relationship})`);
  return { status: verified ? "COMPLETE" : "PARTIAL", value: { schemaVersion: 1, id: `vov:${next.id.split(":").pop()}`, assessment: next, verified }, evidenceIds: [...allowed], diagnostics: reasons };
}

/** AT-60: a verified equivalence with nothing to change. The candidate engine refuses to build one; the report says so. */
export const alreadySupported = (rec: Pick<FeatureRecord, "contract">): { entryPoint: string; evidenceIds: Id[] } | null => {
  const o = rec.contract?.overlap; if (!o || !o.verified || o.relationship !== "EQUIVALENT" || o.strategy !== "NO_CHANGE") return null;
  return { entryPoint: o.capabilities?.[0]?.entryPoints[0] ?? "", evidenceIds: o.mappings.flatMap((m) => m.evidenceIds) };
};

// ------------------------------------------------------------------------------------------------ reuse impact

/** Source files that import the capability. Tests that import it are not consumers: they are the regression obligations, listed separately. */
function consumersOf(d: OverlapDeps, rec: FeatureRecord, files: string[]): { consumers: string[]; truncated: boolean } {
  const policy = policyOf(d, rec); const w = walk(rec.repositoryId, 20_000, (rel) => policy.denied(rel));
  const bases = files.map((f) => f.replace(/\.[^.]+$/, "").split("/").pop()!); const out = new Set<string>();
  for (const rel of w.files) { if (!SRC.test(rel) || files.includes(rel) || isTestPath(rel)) continue; const text = readSafe(rec.repositoryId, rel); if (bases.some((b) => new RegExp(`(from|require\\(|import\\()\\s*["'\`][^"'\`]*\\b${b.replace(/[^\w-]/g, "")}(\\.[a-z]+)?["'\`]`).test(text))) out.add(rel); }
  return { consumers: [...out].sort(), truncated: w.truncated };
}

export function assessReuseImpact(d: OverlapDeps, actor: Id, i: { assessmentId: Id; strategy: string; snapshot: Snapshot }): Outcome<ImpactAssessment> {
  const rec = byAssessment(d.fs, actor, i.assessmentId); const a = rec.contract!.overlap!;
  if (!STRATEGIES.includes(i.strategy as ReuseStrategy)) throw new FeatureError("INVALID_SCHEMA", `strategy must be one of ${STRATEGIES.join(", ")}`);
  const strategy = i.strategy as ReuseStrategy;
  if (staleSnapshot(d, rec, i.snapshot)) return { status: "STALE", evidenceIds: [], diagnostics: ["the repository changed since this snapshot was taken"] };
  const reuses = ["NO_CHANGE", "CONFIGURE", "EXTEND", "COMPOSE", "REFACTOR_AND_REUSE"].includes(strategy);
  const access = (a.differences ?? []).filter((x) => x.dimension === "Actors/access");
  if (reuses && access.length) throw new FeatureError("FORBIDDEN", `${strategy} would bypass a requirement the existing capability does not meet (${access[0]!.detail}); keep it separate or extend it with the missing check`);
  if (strategy === "NO_CHANGE" && !(a.verified && a.relationship === "EQUIVALENT")) throw new FeatureError("FORBIDDEN", "NO_CHANGE needs a verified equivalence; verify the overlap first");
  if (strategy === "CONFIGURE" && !["CONFIGURATION_ONLY", "EXISTING_SUPERSET", "EQUIVALENT"].includes(a.relationship)) throw new FeatureError("FORBIDDEN", "CONFIGURE applies only when the existing capability already does what is asked");
  if (["EXTEND", "COMPOSE", "REFACTOR_AND_REUSE"].includes(strategy) && !a.mappings.some((m) => m.disposition === "REUSED" || m.disposition === "MODIFIED")) throw new FeatureError("FORBIDDEN", `${strategy} needs something to reuse, and nothing was matched with evidence`);
  const files = (a.capabilities ?? []).map((c) => c.sourceRefs[0]!.locator.slice(5)); const { consumers, truncated } = consumersOf(d, rec, files);
  const reasons: string[] = [];
  if (strategy === "SEPARATE" && a.mappings.some((m) => m.disposition === "REUSED")) reasons.push("a parallel implementation of behaviour that already exists needs a recorded reason");
  if (strategy === "SEPARATE" && access.length) reasons.push("kept separate because the existing capability does not enforce what the request requires");
  if (strategy === "NO_CHANGE") reasons.push("ALREADY_SUPPORTED: nothing will change");
  const gaps = ["dynamic or external consumers (scheduled jobs, dashboards, other repositories, feature flags) cannot be found by reading source", ...(truncated ? ["the consumer search stopped at its file limit"] : []), ...(strategy === "REPLACE" ? ["REPLACE needs a consumer inventory, a deprecation plan, a retained-data policy and authorisation; unknown consumers remain a gap, and no removal is safe until they are known"] : [])];
  const affected = strategy === "NO_CHANGE" || strategy === "CONFIGURE" ? [] : [...files, ...consumers];
  // when source will change, static analysis can never show that every consumer is known, so the result is PARTIAL by definition
  return { status: affected.length || strategy === "REPLACE" ? "PARTIAL" : "COMPLETE", value: { schemaVersion: 1, id: `rimpact:${rawHash(JSON.stringify([a.id, strategy, affected])).slice(0, 20)}`, affectedIds: affected, staleIds: [], reasons, regressionObligations: a.regressionObligations ?? [], consumers, gaps }, evidenceIds: [a.id], diagnostics: gaps };
}
