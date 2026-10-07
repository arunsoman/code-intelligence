// Task 3.P — C23/queryRelatedTests: which tests relate to which criteria and files, and on what BASIS (PF-074, AT-72).
// The basis is always named. Links here are explicit (a requirement-attributed edit, or a criterion that names a test as its oracle)
// or static (a test file that imports a changed file). Observed coverage is never claimed: nothing here runs code. A scan that hit its
// limit, and the whole class of dynamic imports, are reported as gaps; coverage is PARTIAL by construction.
import { readFileSync } from "node:fs";
import { policyFor } from "../access.ts";
import { isTestPath } from "../execution.ts";
import { safeJoin, walkFiles } from "../isolated-exec.ts";
import type { Store } from "../store.ts";
import { FeatureError } from "./errors.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { CandidateRecord, CoverageRecord, FeatureRecord, Id, Outcome, TestAssociation } from "./types.ts";
import { validationHash } from "./validation.ts";

export const TEST_SCAN_LIMIT = 3000, PAGE = 50;
const code = (p: string) => /\.[cm]?[jt]sx?$/.test(p);
const stem = (p: string) => p.replace(/\.[cm]?[jt]sx?$/, "");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Does `text` import the module at `path`? Matches the module's path tail (so "../src/export/csv" and "./csv" both count) with an optional extension. */
export function importsModule(text: string, path: string): boolean {
  const tail = stem(path).split("/").slice(-2).join("/"), last = stem(path).split("/").at(-1)!;
  const re = (t: string) => new RegExp(`(from|require\\(|import\\()\\s*['"][^'"]*${esc(t)}(\\.[cm]?[jt]sx?)?['"]`);
  return re(tail).test(text) || (last === tail ? false : new RegExp(`(from|require\\(|import\\()\\s*['"]\\./${esc(last)}(\\.[cm]?[jt]sx?)?['"]`).test(text));
}

export function relatedTests(d: { fs: SqliteFeatureStore; store: Store }, request: FeatureRecord, c: CandidateRecord): { associations: TestAssociation[]; coverage: CoverageRecord[]; gaps: string[] } {
  const criteria = request.contract?.acceptance ?? []; const policy = policyFor(d.store, request.repositoryId);
  const changedCode = c.mutations.map((m) => (m.newPath ?? m.oldPath)!).filter((p) => code(p) && !isTestPath(p));
  const unitEvidence = d.fs.listEvidence(c.id).filter((e) => !e.verdict && (e.kind === "UNIT" || e.kind === "INTEGRATION")).map((e) => e.id).sort();
  const byPath = new Map<string, TestAssociation>(); const gaps = ["associations are static (explicit links and imports); runtime coverage was not observed"];
  const touch = (path: string, sourceStatus: TestAssociation["sourceStatus"], text: string | null, requirementIds: Id[]) => {
    const files = text === null ? [] : changedCode.filter((f) => importsModule(text, f));
    const explicit = criteria.filter((a) => a.requirementIds.some((r) => requirementIds.includes(r)) || a.oracleSourceRefs.some((s) => s.locator === `repo:${path}`));
    const acceptanceIds = explicit.map((a) => a.id).sort();
    const basis: TestAssociation["basis"] = acceptanceIds.length ? "EXPLICIT" : files.length ? "STATIC_DEPENDENCY" : "HEURISTIC";
    if (!acceptanceIds.length && !files.length && sourceStatus === "EXISTING") return; // an unrelated existing test is not listed
    byPath.set(path, { testId: path, acceptanceIds, fileIds: files, basis, sourceStatus, evidenceIds: unitEvidence });
  };
  for (const m of c.mutations) {
    const p = m.newPath ?? m.oldPath!; if (!isTestPath(p) || !code(p) || m.kind === "DELETED") continue;
    touch(p, m.kind === "ADDED" ? "ADDED" : "MODIFIED", c.contents?.[p] ?? null, m.requirementIds);
  }
  let scanned = 0, truncated = false;
  const tests = walkFiles(request.repositoryId, (p) => isTestPath(p) && code(p), TEST_SCAN_LIMIT + 1);
  if (tests.length > TEST_SCAN_LIMIT) { truncated = true; gaps.push(`only the first ${TEST_SCAN_LIMIT} test files were scanned`); }
  for (const p of tests.slice(0, TEST_SCAN_LIMIT)) {
    if (byPath.has(p) || policy.denied(p) || c.mutations.some((m) => (m.newPath ?? m.oldPath) === p)) continue;
    let text: string; try { text = readFileSync(safeJoin(request.repositoryId, p), "utf8"); } catch { continue; }
    scanned++; touch(p, "EXISTING", text, []);
  }
  if (!changedCode.length) gaps.push("the candidate changes no non-test source file, so there is nothing for a test to depend on");
  gaps.push("dynamic imports, reflection and tests that exercise code through a running service are not detected");
  // Observed coverage (#94B) upgrades a link only when it is bound to exactly this candidate: its binding hash AND content hash.
  const obs = d.fs.latestObservedCoverage(c.bindingHash), bound = obs && obs.contentHash === c.binding.candidateContentHash && obs.requestId === c.requestId ? obs : null;
  if (bound) {
    const hit = new Set<string>();
    for (const t of bound.tests) {
      if (t.status !== "OBSERVED") { gaps.push(`${t.testId}: ${t.status === "TEST_FAILED" ? "the test failed under the coverage run" : "not observed"}${t.reason ? ` (${t.reason})` : ""}`); continue; }
      const called = t.files.filter((f) => f.functionsCalled > 0 && changedCode.includes(f.file)).map((f) => f.file);
      const loadedOnly = t.files.filter((f) => f.functionsCalled === 0 && changedCode.includes(f.file)).map((f) => f.file);
      if (loadedOnly.length) gaps.push(`${t.testId} loaded ${loadedOnly.join(", ")} without calling anything in it`);
      for (const f of called) hit.add(f);
      const cur = byPath.get(t.testId);
      if (called.length) byPath.set(t.testId, { ...(cur ?? { testId: t.testId, acceptanceIds: [], sourceStatus: "EXISTING" as const, evidenceIds: unitEvidence }), fileIds: [...new Set([...(cur?.fileIds ?? []), ...called])].sort(), basis: "OBSERVED_COVERAGE" });
    }
    for (const f of changedCode) if (!hit.has(f)) gaps.push(`${f}: no test was observed calling it`);
    gaps.splice(gaps.indexOf("associations are static (explicit links and imports); runtime coverage was not observed"), 1, `observed coverage from run ${bound.runId} (function level, ${bound.tests.length} test file(s)); links not listed as observed are static or declared only`);
  }
  const associations = [...byPath.values()].sort((a, b) => a.testId.localeCompare(b.testId));
  const coverage: CoverageRecord[] = [{ domain: "TESTS", state: "PARTIAL", searchedRoots: ["."], excluded: [{ root: "node_modules, build output and VCS metadata", reason: "not source" }, ...(truncated ? [{ root: "test files beyond the scan limit", reason: "bounded scan" }] : [])],
    tools: bound ? ["static-import-scan", "v8-function-coverage"] : ["static-import-scan"], found: associations.length ? "FOUND" : "NOT_FOUND_WITHIN_SEARCHED_SCOPE", artifacts: associations.map((a) => a.testId).slice(0, 20), unsupported: bound ? ["line and branch coverage"] : ["observed (runtime) coverage"], unresolved: [`${scanned} existing test files scanned`] }];
  return { associations, coverage, gaps };
}

export function queryRelatedTests(d: { fs: SqliteFeatureStore; store: Store }, actor: Id, i: { candidateHash: string; fileId?: Id; acceptanceId?: Id; cursor?: string }): Outcome<{ associations: TestAssociation[]; coverage: CoverageRecord[]; gaps: string[] }> {
  const c = d.fs.getCandidateByBinding(i.candidateHash); const request = c ? d.fs.getRequest(c.requestId) : null;
  if (!c || !request || request.createdBy !== actor) throw new FeatureError("NOT_FOUND", "no such candidate");
  const all = relatedTests(d, request, c);
  const rows = all.associations.filter((a) => (!i.fileId || a.fileIds.includes(i.fileId)) && (!i.acceptanceId || a.acceptanceIds.includes(i.acceptanceId)));
  const scope = validationHash("pf.TestPage", { b: i.candidateHash, f: i.fileId ?? "", a: i.acceptanceId ?? "", n: rows.map((r) => r.testId) });
  const parts = i.cursor?.split("|"); const offset = parts ? Number(parts[1]) : 0;
  if (parts && (parts[0] !== scope || !Number.isSafeInteger(offset) || offset < 0)) throw new FeatureError("STALE_REVISION", "the test cursor is stale; start again");
  const page = rows.slice(offset, offset + PAGE);
  return { status: "PARTIAL", value: { associations: page, coverage: all.coverage, gaps: all.gaps }, evidenceIds: [c.id], diagnostics: [...all.gaps, ...(offset + PAGE < rows.length ? [`next:${scope}|${offset + PAGE}`] : [])] };
}
