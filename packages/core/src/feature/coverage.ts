// #94B — OBSERVED coverage: which tests actually executed which source files, measured by running them.
//   * Three kinds of link exist and are never mixed up: declared (a requirement or criterion names the test), static (the test imports the
//     file; test-links.ts) and OBSERVED (this file: the test ran in a copy of the candidate tree and V8 reported functions of the file called).
//   * Only observed evidence satisfies an execution-coverage claim. A test that merely LOADED a file (imported it) is recorded as loaded and
//     is not an observed association: loading runs the module's top level, not the behaviour that changed.
//   * Every observation is bound to a run id and to the candidate's binding hash and content hash. A record for another candidate, or for
//     the same candidate after its tree changed, is ignored.
//   * Node cannot produce coverage under its permission model, so the local runner reports every test as NOT_OBSERVED with that reason; the container
//     runner (DockerRunner) can, and is what a certification run uses.
//   * Granularity is the function: V8 function-level counts. Line and branch coverage are not claimed.
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { makeScratch, removeScratch } from "../isolated-exec.ts";
import { isTestPath } from "../execution.ts";
import { FeatureError } from "./errors.ts";
import { nodeTestCapabilities } from "./runner.ts";
import { relatedTests } from "./test-links.ts";
import { unsafePath } from "./patch-export.ts";
import { applyCandidateToDir, copyTreeKeepLinks } from "./tree.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { Store } from "../store.ts";
import type { CandidateRecord, FeatureRecord, Id, Outcome, Runner } from "./types.ts";
import { validationHash } from "./validation.ts";

export const MAX_OBSERVED_TESTS = 25, DEFAULT_TEST_WALL_MS = 120_000;
export type ObservedFile = { file: string; loaded: true; functionsCalled: number; functionsTotal: number; calledNames: string[] };
export type ObservedTest = { testId: string; status: "OBSERVED" | "TEST_FAILED" | "NOT_OBSERVED"; exitCode: number | null; reason?: string; files: ObservedFile[] };
export type ObservedCoverage = {
  schemaVersion: 1; id: Id; runId: Id; requestId: Id; candidateHash: string; contentHash: string; tool: "v8-function-coverage"; granularity: "function";
  isolation: string; nodeVersion: string; observedAt: string; tests: ObservedTest[]; gaps: string[];
};

/** Source files the V8 coverage files under `dir` report for scripts inside `root`: loaded, and which functions were called. */
export function readV8Coverage(dir: string, root: string): ObservedFile[] {
  const base = `file://${realpathSync(root)}/`, byFile = new Map<string, { total: number; called: Set<string> }>();
  for (const name of readdirSync(dir).filter((n) => /^coverage-.*\.json$/.test(n))) {
    let doc: { result?: { url: string; functions: { functionName: string; ranges: { startOffset: number; endOffset: number; count: number }[] }[] }[] };
    try { doc = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { continue; }
    for (const s of doc.result ?? []) {
      if (!s.url.startsWith(base)) continue;
      const rel = decodeURIComponent(s.url.slice(base.length)); if (/(^|\/)node_modules\//.test(rel)) continue;
      const cur = byFile.get(rel) ?? { total: 0, called: new Set<string>() };
      for (const f of s.functions) {
        const r0 = f.ranges[0]; if (!r0 || r0.startOffset === 0) continue; // the module's own top-level function: loading, not behaviour
        cur.total++; if (r0.count > 0) cur.called.add(f.functionName || `anonymous@${r0.startOffset}`);
      }
      byFile.set(rel, cur);
    }
  }
  return [...byFile].map(([file, v]) => ({ file, loaded: true as const, functionsCalled: v.called.size, functionsTotal: v.total, calledNames: [...v.called].sort().slice(0, 50) })).sort((a, b) => a.file.localeCompare(b.file));
}

export interface CoverageDeps { fs: SqliteFeatureStore; store: Store; runner: Runner; now?: () => number }

/** Run the candidate's related tests one by one in a copy of its tree and record what each one executed. */
export async function observeCoverage(d: CoverageDeps, actor: Id, i: { candidateHash: string; tests?: string[]; wallMs?: number; fencingToken?: number; signal?: AbortSignal }): Promise<Outcome<ObservedCoverage>> {
  const c = d.fs.getCandidateByBinding(i.candidateHash), request = c ? d.fs.getRequest(c.requestId) : null;
  if (!c || !request || request.createdBy !== actor) throw new FeatureError("NOT_FOUND", "no such candidate");
  if (c.status !== "MATERIALIZED") throw new FeatureError("ILLEGAL_TRANSITION", `the candidate is ${c.status}; only a current candidate is observed`);
  const wallMs = i.wallMs ?? DEFAULT_TEST_WALL_MS; if (!Number.isInteger(wallMs) || wallMs < 1_000 || wallMs > 600_000) throw new FeatureError("INVALID_SCHEMA", "wallMs must be between 1000 and 600000");
  const known = relatedTests(d, request, c).associations.map((a) => a.testId);
  const chosen = i.tests ?? known;
  for (const t of chosen) if (typeof t !== "string" || unsafePath(t) || !isTestPath(t) || !/\.[cm]?[jt]s$/.test(t)) throw new FeatureError("INVALID_SCHEMA", `${JSON.stringify(t)} is not a test file`);
  const gaps = ["function-level observation only: line, branch and statement coverage are not claimed", "tests run one file at a time, each as a plain node script: a test that needs a running service or its own runner is reported as not observed"];
  if (chosen.length > MAX_OBSERVED_TESTS) gaps.push(`only the first ${MAX_OBSERVED_TESTS} of ${chosen.length} tests were run`);
  if (!chosen.length) gaps.push("there is no related test to run");
  const checkout = makeScratch("pf-cov-"), covRoot = makeScratch("pf-covout-"); const tests: ObservedTest[] = [];
  try {
    try { copyTreeKeepLinks(request.repositoryId, checkout); applyCandidateToDir(checkout, c); } catch (e) { throw new FeatureError("FORBIDDEN", `the candidate tree could not be built: ${(e as Error).message}`); }
    let n = 0;
    for (const testId of chosen.slice(0, MAX_OBSERVED_TESTS)) {
      if (i.signal?.aborted) { tests.push({ testId, status: "NOT_OBSERVED", exitCode: null, reason: "cancelled", files: [] }); continue; }
      const out = join(covRoot, `t${++n}`); const { mkdirSync } = await import("node:fs"); mkdirSync(out, { recursive: true });
      const res = await d.runner.run({ capabilities: nodeTestCapabilities(checkout, covRoot, { wallMs }), argv: ["node", testId], cwd: checkout, env: { NODE_V8_COVERAGE: out }, fencingToken: i.fencingToken }, i.signal);
      if (res.status === "REFUSED" || res.status === "INFRA_ERROR" || res.status === "TIMEOUT" || res.status === "CANCELLED" || res.status === "RESOURCE_LIMIT") { tests.push({ testId, status: "NOT_OBSERVED", exitCode: res.exitCode, reason: `${res.status}${res.reason ? `: ${res.reason}` : ""}`.slice(0, 200), files: [] }); continue; }
      if (!readdirSync(out).some((n) => /^coverage-.*\.json$/.test(n))) { tests.push({ testId, status: "NOT_OBSERVED", exitCode: res.exitCode, reason: d.runner.isolation === "LOCAL_PERMISSION_MODEL" ? "this runner cannot produce coverage: Node disables its inspector under --permission; use the container runner" : "the run wrote no coverage files", files: [] }); continue; }
      const files = readV8Coverage(out, checkout).filter((f) => !isTestPath(f.file) && f.file !== testId);
      // A failing test still executed code, but its observation is marked so a failing run never reads as a clean association.
      tests.push({ testId, status: res.status === "PASSED" ? "OBSERVED" : "TEST_FAILED", exitCode: res.exitCode, files, ...(files.length ? {} : { reason: "no source file was reported (the test may not have run under this runner)" }) });
    }
  } finally { removeScratch(checkout); removeScratch(covRoot); }
  const observedAt = new Date((d.now ?? Date.now)()).toISOString(), runId = `covrun:${validationHash("pf.CoverageRun", { c: c.bindingHash, t: tests.map((x) => x.testId), at: observedAt }).split(":").pop()!.slice(0, 20)}`;
  const rec: ObservedCoverage = { schemaVersion: 1, id: `cov:${runId.slice(7)}`, runId, requestId: c.requestId, candidateHash: c.bindingHash, contentHash: c.binding.candidateContentHash, tool: "v8-function-coverage", granularity: "function", isolation: d.runner.isolation, nodeVersion: process.version, observedAt, tests, gaps };
  d.fs.putObservedCoverage(rec);
  return { status: tests.length && tests.every((t) => t.status === "OBSERVED") ? "COMPLETE" : "PARTIAL", value: rec, evidenceIds: [c.id], diagnostics: gaps };
}

/** The newest observation bound to exactly this candidate (binding AND content hash), or null. */
export function latestObservation(fs: SqliteFeatureStore, c: CandidateRecord): ObservedCoverage | null {
  const o = fs.latestObservedCoverage(c.bindingHash); return o && o.contentHash === c.binding.candidateContentHash && o.requestId === c.requestId ? o : null;
}
export type { FeatureRecord };
