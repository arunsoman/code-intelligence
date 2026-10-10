// F02 — PR analysis orchestration (WP-01..WP-04, WP-06, WP-07).
//
// One background job per analysis identity (§6.1): the base and head are checked out of the *base repository* (so a
// fork's head is fetched through the base repository's refs and never needs the fork's credentials), indexed, compared,
// analysed over the changed code and its dependent neighbourhood — with analyzer coverage labelled and disclosed — and
// every rule finding is fingerprinted and matched against a baseline produced by the same rule versions at the merge
// base. Test evidence attaches to the head revision, newest-trust-first; artifacts the PR itself supplies are accepted
// only with that disclosure. What the analysis cannot do is a stated gap; a superseded head's late writes are rejected
// at every commit point (§9.1).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import type { AnalyzerRecord, ChangedFile, CoverageEvidence, DetectorFinding, GateConditionResult, GateEvidence, ImpactReport, OracleEvidence, PrAnalysisView, PrFinding, TestSummaryInfo, WaiverRecord } from "@cie/schema";
import type { Store } from "./store.ts";
import type { ChangeSet, History } from "./history.ts";
import type { Registry } from "./registry.ts";
import type { Finding as SecFinding, Security } from "./security.ts";
import { dependents } from "./graph.ts";
import { detectIndexedDefects } from "./defect-indexed.ts";
import { parseIstanbul, parseJUnit, parseJestJson, parseLcov, type CoverageFile } from "./testartifacts.ts";
import { evaluate, findingFingerprint, hashId, matchBaselines, normalizeAnchor, policyHashOf, validatePolicy, validateWaiver } from "./pr-gate.ts";
import { buildImpactReport, impactReportHash } from "./impact-report.ts";
import { buildPrSummary, finalizeSummaryBudget } from "./pr-summary.ts";
import { applyFeedback, FeedbackStore } from "./feedback.ts";
import { resolveMentions } from "./mentions.ts";
import { policyFor } from "./access.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- git plumbing (read-only of the source repository)

export class PrCheckError extends Error {
  readonly code: "NOT_FOUND" | "INVALID_SCHEMA" | "STALE_REVISION" | "FORBIDDEN" | "EVIDENCE_STALE";
  constructor(code: "NOT_FOUND" | "INVALID_SCHEMA" | "STALE_REVISION" | "FORBIDDEN" | "EVIDENCE_STALE", message: string) { super(message); this.code = code; this.name = "PrCheckError"; }
}

const git = (root: string, args: string[], max = 8 * 1024 * 1024): string => {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 20_000, maxBuffer: max, stdio: ["ignore", "pipe", "ignore"] }); }
  catch (e) { throw new PrCheckError("NOT_FOUND", `git ${args[0]} failed: ${(e as Error).message.slice(0, 200)}`); }
};
const revParse = (root: string, ref: string): string | null => {
  if (!ref) return null;
  try { return execFileSync("git", ["-C", root, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8", timeout: 10_000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
};
const mergeBaseOf = (root: string, a: string, b: string): string | null => {
  try { return execFileSync("git", ["-C", root, "merge-base", a, b], { encoding: "utf8", timeout: 10_000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
};

/** A PR file name that could escape the checkout: rejected before anything is read (D7). */
export function isUnsafePath(p: string): boolean {
  if (!p || p.includes("\0")) return true;
  if (p.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(p)) return true;
  return p.split("/").some((x) => x === ".." || x === "");
}

const GENERATED_FILES = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|.*\.min\.[a-z]+|.*\.d\.ts)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.go$/i;
export const isTestPath = (p: string) => TEST_PATH.test(p);

export interface PrRef { repoRoot: string; forge: string; prNumber: number; headRef?: string; baseRef?: string; headRepository?: string }

export interface ResolvedPr {
  baseHash: string; headHash: string; mergeBaseHash: string;
  changedFiles: ChangedFile[];
  /** The added lines of each changed path, from unified=0 hunks (coverage on changed lines maps onto these). */
  changedLineRanges: Map<string, number[]>;
}

/**
 * F13 §7.5: best-effort fetch of the PR title and body for the description-versus-change check. Attacker-controlled
 * and untrusted; it is only ever shown escaped inside a quoted block labelled unverified, never interpolated into a
 * sentence template, and never executed or passed to a model (§10.3–10.5). Absent `gh`, a detached head or any
 * failure yields null — the section then says "no description to compare", which is a true statement.
 */
export function fetchPrDescription(root: string, prNumber: number): string | null {
  try {
    const out = execFileSync("gh", ["pr", "view", String(prNumber), "--json", "title,body"], { cwd: root, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
    const v = JSON.parse(out) as { title?: string; body?: string | null };
    if (!v.title && !v.body) return null;
    return `${v.title ?? ""}\n\n${v.body ?? ""}`.trim() || null;
  } catch {
    return null;
  }
}

/** Resolve a PR into base, head and merge base plus changed files. Network fetch is only ever `refs/pull/N/head` (§10.1). */
export function resolvePr(root: string, pr: { prNumber: number; headRef?: string; baseRef?: string }): ResolvedPr {
  const baseRef = pr.baseRef ?? "origin/main";
  const headRef = pr.headRef ?? `refs/pull/${pr.prNumber}/head`;
  let headHash = revParse(root, headRef);
  if (!headHash && !pr.headRef) {
    try { execFileSync("git", ["-C", root, "fetch", "--quiet", "--no-tags", "origin", `+${headRef}:${headRef}`], { timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] }); } catch { /* stays unretrievable */ }
    headHash = revParse(root, headRef);
  }
  const baseHash = revParse(root, baseRef);
  if (!headHash) throw new PrCheckError("NOT_FOUND", `the head ${headRef} is not retrievable; a fork's head is fetched through the base repository, and no stale head is used`);
  if (!baseHash) throw new PrCheckError("NOT_FOUND", `the base ref ${baseRef} is not retrievable`);
  const mergeBaseHash = mergeBaseOf(root, baseHash, headHash);
  if (!mergeBaseHash) throw new PrCheckError("NOT_FOUND", "no merge base between base and head; the histories do not share a common ancestor");
  const nameStatus = git(root, ["diff", "--name-status", "-M", "-z", mergeBaseHash, headHash]);
  const numstat = git(root, ["diff", "--numstat", "-M", mergeBaseHash, headHash]);
  const num = new Map<string, { a: number; d: number }>();
  for (const line of numstat.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (m) num.set(m[3], { a: m[1] === "-" ? 0 : Number(m[1]), d: m[2] === "-" ? 0 : Number(m[2]) });
  }
  const changedFiles: ChangedFile[] = [];
  const z = nameStatus.split("\0").filter(Boolean);
  for (let i = 0; i < z.length;) {
    const code = z[i++];
    let status: ChangedFile["status"] = "modified", oldPath: string | undefined;
    if (code.startsWith("R") || code.startsWith("C")) { oldPath = z[i++]; status = code.startsWith("R") ? "renamed" : "modified"; }
    else if (code === "A") status = "added";
    else if (code === "D") status = "removed";
    const path = z[i++];
    if (!path) break;
    if (isUnsafePath(path) || (oldPath && isUnsafePath(oldPath))) throw new PrCheckError("INVALID_SCHEMA", `the PR changes a file name that could escape the checkout: ${path.slice(0, 80)}`);
    changedFiles.push({ path, status, ...(oldPath ? { oldPath } : {}), additions: num.get(path)?.a ?? 0, deletions: num.get(path)?.d ?? 0, generated: GENERATED_FILES.test(path.split("/").pop() ?? "") });
  }
  const changedLineRanges = new Map<string, number[]>();
  const u0 = git(root, ["diff", "--unified=0", "--no-renames", mergeBaseHash, headHash]);
  let cur: string | null = null;
  for (const line of u0.split("\n")) {
    if (line.startsWith("+++ b/")) cur = decodeGitPath(line.slice(6));
    else if (line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (m && cur) {
        const s = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]);
        const arr = changedLineRanges.get(cur) ?? [];
        for (let k = 0; k < n; k++) arr.push(s + k);
        changedLineRanges.set(cur, arr);
      }
    }
  }
  return { baseHash, headHash, mergeBaseHash, changedFiles, changedLineRanges };
}
const decodeGitPath = (p: string) => (/^"(.*)"$/.exec(p)?.[1] ?? p).replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

// ---------------------------------------------------------------- sandboxed checkout (§10.5)

export interface Checkout { dir: string; dispose: () => void }

/**
 * Check one commit out into a temporary directory outside any trusted-root list, without running anything from it.
 * `git worktree add --detach` writes nothing to branches. A symbolic link whose target escapes the checkout is
 * refused, not followed (D7). Static analysis never needs a trusted root, and PR content is never one.
 */
export function checkoutCommit(root: string, hash: string): Checkout {
  const base = join(process.env.CIE_TMP_ROOT ?? process.env.TMPDIR ?? ".", `cie-pr-${sha(hash).slice(0, 16)}`);
  mkdirSync(base, { recursive: true });
  const wt = join(base, "wt");
  if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
  try { execFileSync("git", ["-C", root, "worktree", "add", "--detach", "--quiet", wt, hash], { timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) {
    rmSync(base, { recursive: true, force: true });
    throw new PrCheckError("NOT_FOUND", `the commit ${hash.slice(0, 10)} could not be checked out: ${(e as Error).message.slice(0, 160)}`);
  }
  const refused: string[] = [];
  const scan = (dir: string) => {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".git") continue; // a worktree's .git is a file pointing at the holder's gitdir
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) { try { const target = resolve(dirname(p), readlinkSync(p)); if (!target.startsWith(resolve(wt) + sep)) refused.push(p); } catch { refused.push(p); } }
      else if (e.isDirectory()) scan(p);
    }
  };
  scan(wt);
  const dispose = () => {
    try { execFileSync("git", ["-C", root, "worktree", "remove", "--force", wt], { timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] }); } catch { /* best effort */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  if (refused.length) { dispose(); throw new PrCheckError("FORBIDDEN", `the commit contains symbolic link(s) pointing outside the checkout (${refused.length}); none is followed and the analysis is refused`); }
  return { dir: wt, dispose };
}

// ---------------------------------------------------------------- analyzers over a subset (WP-03, §7.5–7.6)

export interface AnalyzerSpec { id: string; version: string; scope: "NEIGHBOURHOOD" | "WHOLE_REPOSITORY" }
/**
 * What this installation can analyse. A policy naming an id/version not on this list starts INCOMPLETE with a stated
 * reason "analyzer X@v not available" — never a pass, never a silent skip (§7.1). R-POLICY-MISSING is a
 * whole-repository rule, so its analyzer is flagged WHOLE_REPOSITORY.
 */
export function installedAnalyzers(): AnalyzerSpec[] {
  return [
    { id: "security-rules", version: "1", scope: "NEIGHBOURHOOD" },
    { id: "defect-detectors", version: "1", scope: "NEIGHBOURHOOD" },
    { id: "test-artifacts", version: "1", scope: "NEIGHBOURHOOD" },
  ];
}
export const analyzerSetHashOf = (specs: { id: string; version: string }[]) =>
  "aset:" + sha(specs.map((s) => `${s.id}@${s.version}`).sort().join(",")).slice(0, 16);

export const MAX_FINDINGS_PER_RULE = 200;

// ---------------------------------------------------------------- per-revision test + coverage evidence (WP-06, §7.7)

const COVERAGE_PATHS = ["coverage/lcov.info", "lcov.info", "coverage/coverage-final.json", "coverage-final.json"];
const RESULT_PATHS = ["junit.xml", "test-results/junit.xml", "reports/junit.xml", "test-report.xml", "jest-results.json", "vitest-results.json", "test-results.json", "reports/test-results.json"];
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const readSmall = (p: string): string | null => { try { if (!existsSync(p)) return null; const b = readFileSync(p); return b.length <= MAX_ARTIFACT_BYTES ? b.toString("utf8") : null; } catch { return null; } };

export interface RevisionTestEvidence {
  source: "CI" | "REPOSITORY";
  artifactHash: string;
  ciRunId?: string;
  artifactHead?: string;
  found: string[];
  tests: { passed: number; failed: number; skipped: number };
  failing: { name: string; message?: string }[];
  coverage: Map<string, CoverageFile> | null;
  coverageFiles: number;
  coverageLinePercent: number | null;
  /** "supplied by the PR itself": artifacts committed at the head are accepted only with this disclosure. */
  disclosure?: string;
}

/** CI artifacts are accepted only for the exact head commit (level 1); PR-committed artifacts are accepted with a disclosure (level 2). */
export function ingestRevisionTestArtifacts(store: Store, revision: string, opts: { ci?: { headCommit: string; runId: string; junitXml?: string; jestJson?: unknown; lcovText?: string; istanbulJson?: unknown; artifactsHash: string } | null } = {}): RevisionTestEvidence | null {
  const rev = store.revision(revision);
  if (!rev) return null;
  const found: string[] = [];
  let results: ReturnType<typeof parseJUnit> = [];
  let cov: Map<string, CoverageFile> | null = null;

  if (opts.ci) {
    // The artifact names the commit it was produced for; another commit's artifact is rejected, never applied (D4).
    if (rev.gitHead && opts.ci.headCommit !== rev.gitHead) throw new PrCheckError("EVIDENCE_STALE", `the CI artifact was produced for ${opts.ci.headCommit.slice(0, 10)}, not for this head (${rev.gitHead.slice(0, 10)})`);
    found.push(`CI:${opts.ci.runId}`);
    try { if (opts.ci.junitXml) results = parseJUnit(opts.ci.junitXml); } catch { /* unparseable: no results claimed */ }
    try { if (opts.ci.jestJson) results = results.length ? results : parseJestJson(opts.ci.jestJson); } catch { /* unparseable: no results claimed */ }
    try { if (opts.ci.lcovText) cov = parseLcov(opts.ci.lcovText); } catch { /* unparseable: no coverage claimed */ }
    try { if (!cov && opts.ci.istanbulJson) cov = parseIstanbul(opts.ci.istanbulJson); } catch { /* unparseable: no coverage claimed */ }
  } else {
    // Artifacts committed at the head: the PR itself can fabricate them, so they are labelled (§7.7, level 2).
    const disclose = (f: string) => `test artifact "${f}" was supplied by the PR itself and is trusted no further than that`;
    for (const rel of COVERAGE_PATHS) {
      const text = readSmall(join(rev.repoRoot, rel));
      if (text === null) continue;
      try { cov = rel.endsWith(".json") ? parseIstanbul(JSON.parse(text)) : parseLcov(text); found.push(disclose(rel)); break; } catch { /* unparseable: no coverage claimed */ }
    }
    for (const rel of RESULT_PATHS) {
      const text = readSmall(join(rev.repoRoot, rel));
      if (text === null) continue;
      try { results = rel.endsWith(".xml") ? parseJUnit(text) : parseJestJson(JSON.parse(text)); found.push(disclose(rel)); break; } catch { /* unparseable: no results claimed */ }
    }
  }
  if (!found.length) return null;
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const r of results) counts[r.status]++;
  const ev: RevisionTestEvidence = {
    source: opts.ci ? "CI" : "REPOSITORY",
    artifactHash: "art:" + sha(opts.ci?.artifactsHash ?? found.join("|")).slice(0, 16),
    ...(opts.ci ? { ciRunId: opts.ci.runId, artifactHead: opts.ci.headCommit } : {}),
    found, tests: counts,
    failing: results.filter((r) => r.status === "failed").slice(0, 20).map((r) => ({ name: r.name, ...(r.message ? { message: r.message } : {}) })),
    coverage: cov,
    coverageFiles: cov?.size ?? 0,
    coverageLinePercent: cov && cov.size
      ? Math.round((([...cov.values()].reduce((n, f) => n + Object.keys(f.lines).filter((k) => f.lines[Number(k)] > 0).length, 0)) / (([...cov.values()].reduce((n, f) => n + Object.keys(f.lines).length, 0)) || 1)) * 100)
      : null,
    ...(opts.ci ? {} : { disclosure: "test artifacts were supplied by the PR itself, not by CI" }),
  };
  // Per-revision evidence (the per-repository test summary is untouched; §6.2): keyed by revision, hash-bound.
  store.db.prepare("insert into revision_test_runs values (?,?,?,?) on conflict(revision) do update set json = excluded.json, source_hash = excluded.source_hash, ingested_at = excluded.ingested_at")
    .run(revision, JSON.stringify({ source: ev.source, found: ev.found, tests: ev.tests, failing: ev.failing, coverageFiles: ev.coverageFiles, coverageLinePercent: ev.coverageLinePercent, artifactHash: ev.artifactHash, artifactHead: ev.artifactHead ?? null, ciRunId: ev.ciRunId ?? null, disclosure: ev.disclosure ?? null }), ev.artifactHash, new Date().toISOString());
  return ev;
}
export interface StoredTestEvidence { source: string; found: string[]; tests: TestSummaryInfo["tests"]; failing: TestSummaryInfo["failing"]; coverageFiles: number; coverageLinePercent: number | null; artifactHash?: string; artifactHead?: string | null; ciRunId?: string | null; disclosure?: string | null }
export function loadRevisionTestEvidence(store: Store, revision: string): StoredTestEvidence | null {
  const r = store.db.prepare("select json from revision_test_runs where revision = ?").get(revision) as { json: string } | undefined;
  return r ? JSON.parse(r.json) as StoredTestEvidence : null;
}

/** Coverage on changed lines (§7.7): intersect the PR's hunks with the coverage file's executable lines. */
export function changedLineCoverage(changed: Map<string, number[]>, coverage: Map<string, CoverageFile> | null): { executableChangedLines: number; covered: number; percent: number | null } {
  if (!coverage) return { executableChangedLines: 0, covered: 0, percent: null };
  const find = (path: string): CoverageFile | undefined => coverage.get(path) ?? [...coverage.entries()].find(([k]) => k.endsWith(path))?.[1];
  let executable = 0, covered = 0;
  for (const [path, lines] of changed) {
    const cf = find(path);
    if (!cf) continue;
    for (const l of lines) if (cf.lines[l] !== undefined) { executable++; if (cf.lines[l] > 0) covered++; }
  }
  return { executableChangedLines: executable, covered, percent: executable ? Math.round((covered / executable) * 100) : null };
}

// ---------------------------------------------------------------- the engine

export interface Control {
  checkpoint(): void;
  progress(p: { phase: string; message?: string; done?: number; total?: number }): void;
  commit(): void;
  guard<T>(p: Promise<T>): Promise<T>;
  onCancel(fn: () => void): () => void;
}
export interface IndexCall {
  /** Indexes a checkout directory; returns the created or reused revision. */
  (repoPath: string, control?: Control): Promise<{ id: string; repoRoot: string }>;
}
export type AnalyzerInjection = () => Promise<Partial<AnalyzerRecord>>;
export interface AnalysisRunOptions {
  /** Wall-clock budget per analyzer round (§7.6); exceeding it marks that analyzer TIMED_OUT, partial findings retained. */
  analyzerBudgetMs?: number;
  /** CI artifacts for an exact head (trust level 1). An artifact produced for another commit is rejected, not applied. */
  ciArtifacts?: (headHash: string, prNumber: number) => { headCommit: string; runId: string; junitXml?: string; jestJson?: unknown; lcovText?: string; istanbulJson?: unknown; artifactsHash: string } | null;
  /** Depth of the reverse-dependency neighbourhood (§13): 2 default, 4 max. */
  neighbourhoodDepth?: number;
  /** Called once the analysis row exists and the refs are known; the caller may publish a "pending" status. */
  onPending?: (analysisId: string, info: { headHash: string; prNumber: number }) => Promise<void> | void;
}

export interface PolicyRecord { policyId: string; version: number; policyHash: string; body: unknown; createdBy: string; createdAt: string }

/** Evidence the gate decision was computed from, in the shape later re-evaluations need it back (§7.9). */
interface StoredDecision {
  policy: { id: string; version: number; hash: string };
  analyzers: AnalyzerRecord[];
  baselineMode: "REUSED" | "REANALYZED";
  testImpact: { lost: string[]; gained: number; unchanged: number };
  coverage: CoverageEvidence | null;
  oracle: OracleEvidence;
  testsRun: GateEvidence["testsRun"];
  blastRadius: GateEvidence["blastRadius"];
  unresolvedDynamic: number;
  results: GateConditionResult[];
  exceptionsUsed?: string[];
}

export class PrAnalysis {
  readonly store: Store;
  readonly registry: Registry;
  readonly history: History;
  readonly security: Security;
  private readonly indexRevision: IndexCall;
  private readonly opts: AnalysisRunOptions;
  /** Test-injected analyzer runs (A2): id → a run reporting its own state; ids not in the map use the real analyzers. */
  readonly analyzerOverrides: Map<string, AnalyzerInjection> | null;
  /** Accumulated during the analyzer loop; committed with the defect findings afterwards. */
  private headDefectsSeen: DetectorFinding[] = [];

  constructor(store: Store, deps: { security: Security; registry: Registry; history: History; indexRevision: IndexCall }, opts: AnalysisRunOptions & { analyzerOverrides?: Map<string, AnalyzerInjection> } = {}) {
    this.store = store; this.security = deps.security; this.registry = deps.registry; this.history = deps.history;
    this.indexRevision = deps.indexRevision; this.opts = opts;
    this.analyzerOverrides = opts.analyzerOverrides ?? null;
  }

  // ------------------------------------------------------------------ rows & identity (§6)
  row(id: string) { return this.store.db.prepare("select * from pr_analyses where id = ?").get(id) as any; }
  latestForPr(repoRoot: string, prNumber: number) {
    return (this.store.db.prepare("select * from pr_analyses where repo_root = ? and pr_number = ? and state not in ('SUPERSEDED','EXPIRED_WAIVER') order by created_at desc, rowid desc limit 1").get(repoRoot, prNumber) as any) ?? null;
  }
  allForPr(repoRoot: string, prNumber: number) {
    return this.store.db.prepare("select * from pr_analyses where repo_root = ? and pr_number = ? order by created_at desc, rowid desc").all(repoRoot, prNumber) as any[];
  }
  /** A superseded head's late writes never land: every commit point checks. */
  assertActive(id: string, opts: { allowExpiredReevaluate?: boolean } = {}) {
    const r = this.row(id);
    if (!r) throw new PrCheckError("NOT_FOUND", `analysis ${id} is gone`);
    if (r.state === "SUPERSEDED") throw new PrCheckError("STALE_REVISION", `analysis ${id} is SUPERSEDED; a newer head superseded it, so nothing late is written by it`);
    // EXPIRED_WAIVER may only be re-evaluated (the cheap path): nothing late is indexed or analysed again.
    if (r.state === "EXPIRED_WAIVER" && !opts.allowExpiredReevaluate) throw new PrCheckError("STALE_REVISION", `analysis ${id} is EXPIRED_WAIVER: its waiver expired; use re-evaluate (C16/evaluateQualityGate) or re-run the analysis`);
    return r;
  }
  private setState(id: string, state: string, extra: Partial<{ job_id: string; base_revision: string; head_revision: string }> = {}) {
    const cols = Object.keys(extra).map((k) => `${k} = ?`);
    this.store.db.prepare(`update pr_analyses set state = ?, updated_at = ?${cols.length ? `, ${cols.join(", ")}` : ""} where id = ?`)
      .run(state, new Date().toISOString(), ...(Object.values(extra) as string[]), id);
  }

  /** Create (or reuse) the analysis for an exact identity (§6.1); on creation, older heads of the same PR are superseded (§11). */
  createAnalysis(req: {
    repoRoot: string; forge: string; prNumber: number; baseHash: string; headHash: string; mergeBaseHash: string;
    headRepository?: string; changedFiles: ChangedFile[]; policyId: string; policyHash: string; analyzerSetHash: string;
  }): { analysisId: string; reused: boolean; supersededIds: string[] } {
    return this.store.tx(() => {
      const existing = this.store.db.prepare("select id from pr_analyses where repository_id = ? and forge = ? and pr_number = ? and base_hash = ? and head_hash = ? and policy_hash = ? and analyzer_set_hash = ?")
        .get(req.repoRoot, req.forge, req.prNumber, req.baseHash, req.headHash, req.policyHash, req.analyzerSetHash) as { id: string } | undefined;
      if (existing) return { analysisId: existing.id, reused: true, supersededIds: [] };
      const id = "pna:" + randomUUID();
      const supersededIds: string[] = [];
      for (const o of this.store.db.prepare("select id from pr_analyses where repository_id = ? and pr_number = ? and head_hash <> ? and state not in ('SUPERSEDED','EXPIRED_WAIVER')").all(req.repoRoot, req.prNumber, req.headHash) as { id: string }[]) {
        this.store.db.prepare("update pr_analyses set state = 'SUPERSEDED', superseded_by = ?, updated_at = ? where id = ?").run(id, new Date().toISOString(), o.id);
        this.store.db.prepare("update gate_decisions set superseded = 1, revoked_reason = ? where analysis_id = ? and superseded = 0").run("a newer commit was pushed", o.id);
        this.store.db.prepare("update check_publications set state = 'SUPERSEDED', updated_at = ? where decision_id in (select decision_id from gate_decisions where analysis_id = ?)").run(new Date().toISOString(), o.id);
        this.store.db.prepare("update impact_reports set state = 'SUPERSEDED', updated_at = ? where analysis_id = ?").run(new Date().toISOString(), o.id);
        supersededIds.push(o.id);
      }
      this.store.db.prepare("insert into pr_analyses values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        id, req.repoRoot, req.forge, req.prNumber, req.repoRoot, req.baseHash, req.headHash, req.mergeBaseHash,
        req.headRepository ?? null, null, null, req.policyId, req.policyHash, req.analyzerSetHash,
        "RECEIVED", null, 1, supersededIds[0] ?? null, new Date().toISOString(), new Date().toISOString());
      const ins = this.store.db.prepare("insert or ignore into pr_changed_files values (?,?,?,?,?,?,?)");
      for (const f of req.changedFiles) ins.run(id, f.path, f.status, f.oldPath ?? null, f.additions ?? null, f.deletions ?? null, f.generated ? 1 : 0);
      return { analysisId: id, reused: false, supersededIds };
    });
  }

  bindJob(analysisId: string, jobId: string) { this.store.db.prepare("update pr_analyses set job_id = ? where id = ?").run(jobId, analysisId); }

  /** A decision's publication to GitHub succeeded; state moves DECIDED → PUBLISHED (§6.4). */
  markPublished(analysisId: string) {
    const r = this.row(analysisId);
    if (r && ["DECIDED", "PUBLISHED"].includes(r.state)) this.setState(analysisId, "PUBLISHED");
  }

  // ------------------------------------------------------------------ policies (WP-05)

  putPolicy(body: unknown, createdBy: string): { ok: true; policyId: string; version: number; policyHash: string } | { ok: false; problems: string[] } {
    const v = validatePolicy(body);
    if (!v.ok) return v;
    const old = this.store.db.prepare("select body from gate_policies where policy_id = ? and version = ?").get(v.body.policyId, v.body.version) as { body: string } | undefined;
    if (old) {
      if (policyHashOf(JSON.parse(old.body) as never) !== v.policyHash) return { ok: false, problems: ["policies are immutable once used; this version already exists with different content"] };
      return { ok: true, policyId: v.body.policyId, version: v.body.version, policyHash: v.policyHash };
    }
    this.store.db.prepare("insert into gate_policies values (?,?,?,?,?,?)").run(v.body.policyId, v.body.version, v.policyHash, JSON.stringify(v.body), createdBy, new Date().toISOString());
    return { ok: true, policyId: v.body.policyId, version: v.body.version, policyHash: v.policyHash };
  }
  listPolicies(policyId?: string): PolicyRecord[] {
    return (this.store.db.prepare("select policy_id, version, policy_hash, created_by, created_at, body from gate_policies where (? is null or policy_id = ?) order by policy_id, version").all(policyId ?? null, policyId ?? null) as any[])
      .map((r) => ({ policyId: r.policy_id, version: r.version, policyHash: r.policy_hash, body: JSON.parse(r.body), createdBy: r.created_by, createdAt: r.created_at }));
  }
  getPolicy(policyId: string, version?: number): PolicyRecord | null {
    const r = version
      ? (this.store.db.prepare("select * from gate_policies where policy_id = ? and version = ?").get(policyId, version) ?? null) as any
      : ((this.store.db.prepare("select * from gate_policies where policy_id = ? order by version desc limit 1").get(policyId) ?? null) as any);
    return r ? { policyId: r.policy_id, version: r.version, policyHash: r.policy_hash, body: JSON.parse(r.body), createdBy: r.created_by, createdAt: r.created_at } : null;
  }
  policyOfHash(policyId: string, policyHash: string) {
    return this.listPolicies(policyId).find((p) => p.policyHash === policyHash) ?? null;
  }
  /** Which policy a repository uses. Chosen through the store, never from the PR's head (D3). */
  setRepositoryPolicy(repoRoot: string, policyId: string | null) {
    if (!policyId) this.store.db.prepare("delete from gate_repo_policy where repo_root = ?").run(repoRoot);
    else this.store.db.prepare("insert into gate_repo_policy values (?,?,?) on conflict(repo_root) do update set policy_id = excluded.policy_id, updated_at = excluded.updated_at").run(repoRoot, policyId, new Date().toISOString());
  }
  repositoryPolicy(repoRoot: string) {
    return (this.store.db.prepare("select policy_id from gate_repo_policy where repo_root = ?").get(repoRoot) as { policy_id: string } | undefined)?.policy_id ?? null;
  }

  // ------------------------------------------------------------------ the pipeline (§4, §9.1)

  /** One run per identity: resolve → create/reuse → pending hook → index → compare → analyse → baseline → gate → DECIDED. */
  async run(ctx: { actor: string }, control: Control | undefined, req: PrRef & { policyId?: string }): Promise<PrAnalysisView> {
    void ctx;
    const repoRoot = resolve(req.repoRoot);
    if (!existsSync(repoRoot)) throw new PrCheckError("NOT_FOUND", "the repository folder is gone; nothing is analysed from a missing source");
    control?.progress({ phase: "fetching", message: "Resolving the PR's base, head and merge base…" });
    const resolved = resolvePr(repoRoot, req);
    const policyId = req.policyId ?? this.repositoryPolicy(repoRoot);
    let policyRecord: PolicyRecord | null = null;
    if (policyId) {
      policyRecord = this.getPolicy(policyId);
      if (!policyRecord) throw new PrCheckError("NOT_FOUND", `the policy ${policyId} is not in the store; policies come from the store, never from the PR's head`);
    }
    const created = this.createAnalysis({
      repoRoot, forge: req.forge, prNumber: req.prNumber, baseHash: resolved.baseHash, headHash: resolved.headHash,
      mergeBaseHash: resolved.mergeBaseHash, headRepository: req.headRepository, changedFiles: resolved.changedFiles,
      policyId: policyId ?? "(none)", policyHash: policyRecord?.policyHash ?? "pol:none", analyzerSetHash: analyzerSetHashOf(installedAnalyzers()),
    });
    const analysisId = created.analysisId;
    // The caller can publish a "pending" status now; the publisher is idempotent, so this also covers runs after a restart.
    try { await this.opts.onPending?.(analysisId, { headHash: resolved.headHash, prNumber: req.prNumber }); }
    catch { /* publications track their own state; a pending failure never blocks the analysis */ }
    try {
      control?.checkpoint();
      // Fast path: the same head already holds a current decision under the same policy — return it, not a re-run (§6.1).
      const existing = this.row(analysisId);
      if (created.reused && ["DECIDED", "PUBLISHED"].includes(existing.state) && this.lastDecisionRow(analysisId)) return this.compileReviewView(analysisId);
      await this.pipelineToDecision(control, analysisId, resolved, req, policyRecord);
      return this.compileReviewView(analysisId);
    } catch (e) {
      const r = this.row(analysisId);
      if (r && !["SUPERSEDED", "EXPIRED_WAIVER", "DECIDED", "PUBLISHED"].includes(r.state)) this.setState(analysisId, "FAILED");
      throw e;
    }
  }

  private async pipelineToDecision(control: Control | undefined, analysisId: string, resolved: ResolvedPr, req: { repoRoot: string; prNumber: number }, policyRecord: PolicyRecord | null): Promise<void> {
    const assertA = () => this.assertActive(analysisId);
    const asetHash = analyzerSetHashOf(installedAnalyzers());
    const baseCo = checkoutCommit(req.repoRoot, resolved.mergeBaseHash);
    const headCo = checkoutCommit(req.repoRoot, resolved.headHash);
    try {
      // ---- index base and head (WP-01/WP-02); the worker's parse cache makes the second pass cheap ----
      control?.progress({ phase: "index", message: "Indexing the merge base…" });
      const baseRev = await this.indexRevision(baseCo.dir, control);
      assertA();
      control?.progress({ phase: "index", message: "Indexing the head…" });
      const headRev = await this.indexRevision(headCo.dir, control);
      assertA();
      this.setState(analysisId, "INDEXING", { base_revision: baseRev.id, head_revision: headRev.id });
      // Canonical identities across the pair: the head inherits the merge base's identities where bodies match, so a
      // rename or move keeps its fingerprint (§7.4). A failure loses nothing but the nicer fingerprint.
      try { this.registry.registerRevision(headRev.id, baseRev.id, `pr-${req.prNumber}`); } catch { /* identities can be rebuilt later; the index is intact */ }

      // ---- compare + scope (WP-03, §7.5): the changed files plus their reverse-dependency neighbourhood ----
      control?.progress({ phase: "compare", message: "Comparing the two revisions…" });
      const cs = this.history.compare(baseRev.id, headRev.id);
      assertA();
      // F11 (slice S1): the ChangeSet used to be discarded after the gate evaluation. Keep it: the impact report
      // and the review view's populated `changes` are built from exactly these bytes.
      this.store.db.prepare("insert or replace into pr_change_sets values (?,?,?)").run(analysisId, JSON.stringify(cs), new Date().toISOString());
      const depth = Math.min(4, Math.max(1, this.opts.neighbourhoodDepth ?? 2));
      const analysedFiles = new Set(resolved.changedFiles.filter((f) => f.status !== "removed").map((f) => f.path));
      for (const t of cs.entities) {
        if (!t.head || t.change === "UNCHANGED") continue;
        for (const n of dependents(this.store, headRev.id, t.head, { maxDepth: depth }).nodes) {
          if (n.file && !isTestPath(n.file) && n.id !== t.head) analysedFiles.add(n.file);
        }
      }
      const totalFiles = Number((this.store.db.prepare("select count(distinct file) n from entities where revision = ?").get(headRev.id) as { n: number }).n);
      const uncovered = Math.max(0, totalFiles - analysedFiles.size);
      const scopeNote = `changed files and their dependents (depth ${depth})`;

      // ---- baseline decision points: cache (merge_base_hash + analyzer_set_hash pins the rule set; D6/R1) ----
      let baselineMode: "REUSED" | "REANALYZED" = "REANALYZED";
      let baseFindings: PrFinding[] = [];
      const cachedRow = this.store.db.prepare("select findings_json from pr_baselines where merge_base_hash = ? and analyzer_set_hash = ?").get(resolved.mergeBaseHash, asetHash) as { findings_json: string } | undefined;
      if (cachedRow) {
        const cached = (JSON.parse(cachedRow.findings_json) as { findings?: PrFinding[] }).findings ?? [];
        if (cached.length) { baseFindings = cached; baselineMode = "REUSED"; }
      }

      // ---- analyzers over the scope (WP-03) ----
      this.setState(analysisId, "ANALYZING");
      control?.progress({ phase: "analyse", message: "Running the configured analyzers over the changed code and its neighbourhood…" });
      const budgetMs = this.opts.analyzerBudgetMs ?? 300_000;
      const analyzers: AnalyzerRecord[] = [];
      const headSec: SecFinding[] = [];
      const baseSec: SecFinding[] = [];
      for (const spec of installedAnalyzers()) {
        const coverageLabel = (): AnalyzerRecord["coverage"] => ({ analyzedFiles: analysedFiles.size, skippedFiles: uncovered, reason: scopeNote });
        if (this.analyzerOverrides?.has(spec.id)) {
          const inj = await this.analyzerOverrides.get(spec.id)!();
          analyzers.push({ id: spec.id, version: spec.version, state: inj.state ?? "COMPLETE", coverage: inj.coverage ?? coverageLabel(), ...(inj.reason ? { reason: inj.reason } : {}), ...(inj.wallMs !== undefined ? { wallMs: inj.wallMs } : {}) });
          continue;
        }
        const t0 = Date.now();
        try {
          if (spec.id === "security-rules") {
            headSec.push(...(this.security.analyze({ revision: headRev.id }) as SecFinding[]).filter((f) => !f.superseded));
            // The base is analysed by the same rule versions only when its baseline is not reused (§7.3).
            if (baselineMode === "REANALYZED") {
              baseSec.push(...(this.security.analyze({ revision: baseRev.id }) as SecFinding[]).filter((f) => !f.superseded));
            }
            const over = Date.now() - t0 > budgetMs;
            if (over) { /* partial findings are retained and disclosed (§7.6) */ }
            analyzers.push({ id: spec.id, version: spec.version, state: over ? "TIMED_OUT" : "COMPLETE", coverage: coverageLabel(), ...(over ? { reason: `timed out after ${Math.round(budgetMs / 1000)} s` } : {}), wallMs: Date.now() - t0 });
          } else if (spec.id === "defect-detectors") {
            const ids = this.entitiesInFiles(headRev.id, analysedFiles);
            const r = detectIndexedDefects(this.store, headRev.id, { maxFindings: MAX_FINDINGS_PER_RULE, entityIds: ids });
            const kept = r.findings.filter((d) => { const f = this.fileOfEntity(headRev.id, d.entityIds[0]); return f && analysedFiles.has(f); });
            this.headDefectsSeen.push(...kept); // partial findings are retained and disclosed (§7.6)
            const over = Date.now() - t0 > budgetMs;
            analyzers.push({ id: spec.id, version: spec.version, state: over ? "TIMED_OUT" : r.truncated ? "PARTIAL" : "COMPLETE", coverage: coverageLabel(), ...(over ? { reason: `timed out after ${Math.round(budgetMs / 1000)} s` } : {}), ...(r.truncated && !over ? { reason: "finding or fact cap reached; disclosed" } : {}), wallMs: Date.now() - t0 });
          } else if (spec.id === "test-artifacts") {
            analyzers.push({ id: spec.id, version: spec.version, state: "COMPLETE", coverage: { analyzedFiles: 0, skippedFiles: 0, reason: "artifacts, not source scope" }, wallMs: Date.now() - t0 });
          }
        } catch (e) {
          analyzers.push({ id: spec.id, version: spec.version, state: "FAILED", coverage: { analyzedFiles: 0, skippedFiles: totalFiles, reason: "the analyzer stopped early; its findings are not claimed" }, reason: (e as Error).message.slice(0, 160), wallMs: Date.now() - t0 });
        }
      }
      assertA();

      // ---- findings: scope filter → fingerprint → baseline match (WP-04, §7.4) ----
      control?.progress({ phase: "findings", message: "Fingerprinting findings and matching the baseline…" });
      if (baselineMode === "REUSED" && !baseFindings.length && baseSec.length) baselineMode = "REANALYZED";
      if (baselineMode === "REANALYZED") {
        baseFindings = this.fingerprintAll(this.inScope(baseSec, baseRev.id, this.baseScopeOf(resolved, baseRev.id)), baseRev.id, baseCo.dir);
        this.store.db.prepare("insert or replace into pr_baselines values (?,?,?,?,?)")
          .run(resolved.mergeBaseHash, asetHash, baseRev.id, JSON.stringify({ findings: baseFindings }), new Date().toISOString());
      }
      const headFindings = this.fingerprintAll(this.inScope(headSec, headRev.id, analysedFiles), headRev.id, headCo.dir);
      const matched = matchBaselines(headFindings, baseFindings);
      assertA();
      // Persist head findings and base-side resolutions; late writes are fenced at every commit point (§9.1).
      this.store.db.prepare("delete from pr_findings where analysis_id = ? and kind = 'SECURITY'").run(analysisId);
      this.writeFindings(analysisId, matched.head, "SECURITY");
      this.writeFindings(analysisId, matched.resolvedByChange, "SECURITY");
      assertA();

      // ---- defect detector findings into the view (WP-04: candidates surfaced; not gate-blocking in the default policy) ----
      this.store.db.prepare("delete from pr_findings where analysis_id = ? and kind = 'DEFECT'").run(analysisId);
      this.writeFindings(analysisId, this.headDefectsSeen.map((d): PrFinding => this.defectToPrFinding(d, headRev.id)), "DEFECT");

      // ---- test + coverage evidence for the head (WP-06) ----
      control?.progress({ phase: "tests", message: "Reading test and coverage evidence for the head…" });
      const ci = this.opts.ciArtifacts?.(resolved.headHash, req.prNumber) ?? null;
      // CI evidence is level 1: an artifact that does not name this head is refused, and the refusal is said (§7.7, D4).
      let ciRefused: string | undefined;
      let testEvidence: RevisionTestEvidence | null = null;
      try { testEvidence = ingestRevisionTestArtifacts(this.store, headRev.id, { ci }); }
      catch (e) {
        if ((e as PrCheckError).name !== "PrCheckError") throw e;
        ciRefused = (e as PrCheckError).message;
        control?.progress({ phase: "tests", message: `CI evidence refused: ${ciRefused}` });
      }
      const changedCov = changedLineCoverage(resolved.changedLineRanges, testEvidence?.coverage ?? null);
      const coverageEvidence: CoverageEvidence = testEvidence
        ? {
          source: testEvidence.source, artifactHead: testEvidence.artifactHead ?? undefined, ciRunId: testEvidence.ciRunId ?? undefined,
          artifactHash: testEvidence.artifactHash,
          executableChangedLines: changedCov.executableChangedLines, covered: changedCov.covered, percent: changedCov.percent,
          ...(testEvidence.disclosure ? { disclosure: testEvidence.disclosure } : {}),
        }
        : { source: "REPOSITORY", executableChangedLines: 0, covered: 0, percent: null, disclosure: `no test or coverage artifact was available for this head, from CI or from the commit${ciRefused ? ` (the CI evidence was refused: ${ciRefused})` : ""}` };

      // ---- oracle candidates (WP-07, §7.8) ----
      const oracleRows = this.oracleCandidates(resolved, baseCo.dir, headCo.dir);
      this.store.db.prepare("delete from pr_findings where analysis_id = ? and kind = 'ORACLE_CANDIDATE'").run(analysisId);
      this.writeFindings(analysisId, oracleRows, "ORACLE_CANDIDATE");

      // ---- gate decision (WP-05, §7.2) ----
      control?.progress({ phase: "evaluate", message: "Evaluating the gate policy…" });
      this.setState(analysisId, "EVALUATING");
      assertA();
      this.makeDecision(analysisId, {
        policyRecord, analyzers, baselineMode, cs, coverage: coverageEvidence,
        oracle: { candidates: oracleRows.length, reviewed: 0, headChangesTests: this.testsChanged(resolved) },
        testsRun: testEvidence
          ? { source: testEvidence.source, headHash: testEvidence.artifactHead ?? resolved.headHash, failedTests: testEvidence.tests.failed }
          : null,
      });
      control?.checkpoint();
      control?.commit();
      this.setState(analysisId, "DECIDED");
      // F11 (slice S2): assemble, rank and store the cited impact report behind the blast-radius comment.
      this.buildAndStoreImpactReport(analysisId, resolved, cs, coverageEvidence, analyzers, headRev.id, headCo.dir, req.repoRoot, req.prNumber);
    } finally { baseCo.dispose(); headCo.dispose(); }
  }
  // ------------------------------------------------------------------ F11: the retained ChangeSet and impact report

  /** The ChangeSet stored at compare time (slice S1); null for analyses that predate the table. */
  changeSetOf(analysisId: string): ChangeSet | null {
    const row = this.store.db.prepare("select json from pr_change_sets where analysis_id = ?").get(analysisId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as ChangeSet : null;
  }

  /** The CURRENT impact report for an analysis; superseded heads return null (F11-A1). */
  impactReportOf(analysisId: string): ImpactReport | null {
    const row = this.store.db.prepare("select json from impact_reports where analysis_id = ? and state = 'CURRENT'").get(analysisId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as ImpactReport : null;
  }

  /**
   * Build and persist the impact report (§7.1). Everything it needs was already computed for the gate; the only
   * extra inputs are the unresolved dynamic-call count (a Fog input) and an evidence-id → citation resolver that
   * converts stored byte spans to line numbers against the head checkout. Stored with its hash: the publisher's
   * idempotency key binds a saying to exactly this report (F11-A13).
   */
  private buildAndStoreImpactReport(analysisId: string, resolved: { headHash: string; baseHash: string }, cs: ChangeSet, coverage: CoverageEvidence | null, analyzers: AnalyzerRecord[], headRevId: string, headDir: string, repoRoot: string, prNumber: number): void {
    const unresolvedRow = this.store.db.prepare("select count(*) n from relationships where revision = ? and json like ?").get(headRevId, '%"resolution":"UNRESOLVED"%') as { n: number };
    const incompleteReasons = analyzers.filter((a) => a.state !== "COMPLETE").map((a) => `analyzer ${a.id}@${a.version} states ${a.state}: ${(a.reason ?? "findings in files it did not analyse are not claimed").slice(0, 120)}`);
    const lineTableOf = (path: string): number[] | null => {
      try {
        const bytes = readFileSync(join(headDir, path));
        const starts = [0];
        for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) starts.push(i + 1);
        return starts;
      } catch { return null; }
    };
    const lineOf = (starts: number[] | null, byte: number): number | null => {
      if (!starts) return null;
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= byte) lo = mid; else hi = mid - 1; }
      return lo + 1;
    };
    const evidenceLocation = (evidenceId: string): { path: string; startLine: number; endLine: number } | null => {
      const ev = this.store.evidence(headRevId, evidenceId);
      const loc = ev?.location as { kind?: string; span?: { sourceId: string; startByte: number; endByteExclusive: number } } | undefined;
      if (loc?.kind !== "CodeLocation" || !loc.span) return null;
      const starts = lineTableOf(loc.span.sourceId);
      const startLine = lineOf(starts, loc.span.startByte);
      const endLine = lineOf(starts, Math.max(loc.span.startByte, loc.span.endByteExclusive - 1));
      if (startLine === null) return null;
      return { path: loc.span.sourceId, startLine, endLine: endLine ?? startLine };
    };
    const report = buildImpactReport({
      analysisId, baseHash: resolved.baseHash, headHash: resolved.headHash, cs,
      coverage, analyzers, unresolvedDynamicCalls: Number(unresolvedRow?.n ?? 0),
      incomplete: analyzers.some((a) => a.state !== "COMPLETE"), incompleteReasons,
      evidenceLocation,
    });
    // F13: the deterministic summary/walkthrough rides in the same stored report (§5). It is built from exactly
    // the bytes the gate already computed; the description check resolves names against the head index with the
    // denied-path policy applied (§7.5). A description that cannot be fetched yields "no description to compare".
    report.summary = this.buildPrSummary(cs, headRevId, repoRoot, prNumber, Number(unresolvedRow?.n ?? 0), analyzers);
    // F15: reviewer feedback (mutes + kind weights) applies inside the ranking step as inputs, recorded in the
    // report's rank.factors and footer (§5) — a muted kind appears as factor MUTE, so why-not can explain a
    // suppression. The stored report pins the feedback state it was ranked under (§11).
    const feedback = new FeedbackStore(this.store);
    const feedbackRepository = this.row(analysisId)?.repository_id ?? repoRoot;
    const mutes = feedback.mutes(feedbackRepository).active;
    const weights = feedback.weights(feedbackRepository);
    const fbState = feedback.state(feedbackRepository);
    // No feedback yet still records the default footer, so every comment states its ranking status (§7.6).
    const withFeedback = applyFeedback(report, {
      mutes, weights,
      labelSummary: { total: fbState.labels.total, principals: fbState.labels.principals },
      logHash: feedback.logHash(repoRoot),
    });
    report.surfaced = withFeedback.surfaced;
    report.muted = withFeedback.muted;
    report.feedback = withFeedback.feedback;
    const now = new Date().toISOString();
    this.store.db.prepare(`insert into impact_reports values (?,?,?,?,?,?)
      on conflict(analysis_id) do update set json = excluded.json, report_hash = excluded.report_hash, state = 'CURRENT', updated_at = excluded.updated_at`)
      .run(analysisId, JSON.stringify(report), impactReportHash(report), "CURRENT", now, now);
  }

  /**
   * F13 (§7): build the PrSummary from the retained ChangeSet. Every lookup is store-backed and deterministic;
   * the reading order is omitted when the call graph did not finish (unresolved dynamic calls or an incomplete
   * analyzer — §9), because a wrong order is worse than none.
   */
  private buildPrSummary(cs: ChangeSet, headRevId: string, repoRoot: string, prNumber: number, unresolvedDynamicCalls: number, analyzers: AnalyzerRecord[]) {
    const access = policyFor(this.store, repoRoot);
    const headEntities = new Map(this.store.entities(headRevId).map((e) => [e.entityId, e]));
    const routeSubjects = new Set(this.store.factsByPredicate(headRevId, "route").map((f) => f.subject));
    return finalizeSummaryBudget(buildPrSummary({
      cs,
      access,
      graphComplete: unresolvedDynamicCalls === 0 && analyzers.every((a) => a.state === "COMPLETE"),
      descriptionText: fetchPrDescription(repoRoot, prNumber),
      resolveDescription: (text) => resolveMentions(this.store, headRevId, text, access),
      entityFile: (id) => headEntities.get(id)?.file ?? null,
      dependentsOf: (id) => { try { return dependents(this.store, headRevId, id, { maxDepth: 2 }).nodes.map((n) => n.id); } catch { return []; } },
      isEntryPoint: (id) => routeSubjects.has(id),
      changeSize: (id) => (headEntities.get(id)?.spans ?? []).reduce((a, s) => a + Math.max(0, s.endByteExclusive - s.startByte), 0),
    }));
  }

  // ------------------------------------------------------------------ findings (WP-04)

  /** Rule findings whose evidence spans files in scope. The whole-repository rule (R-POLICY-MISSING) is never scoped away (§7.5). */
  private inScope(findings: SecFinding[], revId: string, files: Set<string>): SecFinding[] {
    return findings.filter((f) => {
      if (f.ruleId === "R-POLICY-MISSING") return true;
      for (const evId of f.evidenceIds) {
        const ev = this.store.evidence(revId, evId);
        const loc = ev?.location as { kind: string; span?: { sourceId: string } } | undefined;
        if (loc?.kind === "CodeLocation" && loc.span && files.has(loc.span.sourceId)) return true;
      }
      return false;
    });
  }

  /** Rule findings → PR findings with fingerprints (§7.4): canonical identity + normalized anchor + occurrence index. */
  private fingerprintAll(findings: SecFinding[], revId: string, checkoutDir: string | null): PrFinding[] {
    type Meta = { f: SecFinding; path: string; line: number | null; canonical: string | null; anchor: string; spanStart: number; occurrence: number };
    const metas: Meta[] = findings.map((f) => {
      // Canonical identity: the first id-shaped token of the subject that is an entity of this revision (§7.4). A move
      // of the same construct between files keeps its canon id (registry rename/move inheritance), and with it the fingerprint.
      let canonical: string | null = null;
      let entitySpan: { startByte: number; endByteExclusive: number } | null = null;
      for (const token of f.subject.split(/[@>|]/)) {
        const ent = this.entitiesOf(revId, token);
        if (ent.length) { canonical = this.registry.canonOf(revId, token); entitySpan = ent[0].spans?.[0] ?? null; break; }
      }
      let path = "", line: number | null = null, anchor = f.subject, spanStart = 0;
      for (const evId of f.evidenceIds) {
        const ev = this.store.evidence(revId, evId);
        const loc = ev?.location as { kind: string; span?: { sourceId: string; startByte: number; endByteExclusive: number } } | undefined;
        if (loc?.kind === "CodeLocation" && loc.span) {
          path = loc.span.sourceId;
          spanStart = loc.span.startByte;
          if (checkoutDir) {
            try {
              const buf = readFileSync(join(checkoutDir, loc.span.sourceId));
              // The anchor stays inside the finding's own construct (±120 bytes clamped to the entity span): neighbours
              // added further in the file must not change an untouched finding's fingerprint (§7.4).
              const lo = Math.max(entitySpan?.startByte ?? 0, Math.max(0, loc.span.startByte - 120));
              const hi = Math.min(entitySpan?.endByteExclusive ?? buf.length, Math.min(buf.length, loc.span.endByteExclusive + 120));
              anchor = buf.subarray(lo, hi).toString("utf8");
              line = buf.subarray(0, loc.span.startByte).toString("utf8").split("\n").length;
            } catch { /* checkout gone: the anchor degenerates to the subject — still deterministic; no file text claimed */ }
          }
          break;
        }
      }
      return { f, path, line, canonical, anchor, spanStart, occurrence: 0 };
    });
    // Occurrence index: the nth finding with the same (rule, identity, anchor), in deterministic (path, offset) order (§7.4).
    const occurrences = new Map<string, number>();
    for (const m of [...metas].sort((a, b) => a.path.localeCompare(b.path) || a.spanStart - b.spanStart)) {
      const key = `${m.f.ruleId}|${m.canonical ?? `path:${m.path}`}|${normalizeAnchor(m.anchor)}`;
      const next = occurrences.get(key) ?? 0;
      m.occurrence = next;
      occurrences.set(key, next + 1);
    }
    return metas.map((m): PrFinding => ({
      findingId: m.f.id,
      fingerprint: findingFingerprint({ ruleId: m.f.ruleId, canonicalEntityId: m.canonical, anchor: m.anchor, occurrenceIndex: m.occurrence, fallbackPath: m.path }),
      introduced: true, // set by matchBaselines
      ruleId: m.f.ruleId, ruleVersion: m.f.ruleVersion, severity: m.f.severity,
      path: m.path, line: m.line,
      entityId: (() => { for (const t of m.f.subject.split(/[@>|]/)) if (this.entitiesOf(revId, t).length) return t; return null; })(),
      disposition: "OPEN", title: m.f.title, summary: m.f.summary, evidenceIds: m.f.evidenceIds,
      counterArgument: m.f.counterArgument, claimId: m.f.claimId, kind: "SECURITY",
    }));
  }

  private entitiesOf(revId: string, id: string) { return id && this.store.entitiesById(revId, [id]).length ? [this.store.entitiesById(revId, [id])[0]] : []; }
  private fileOfEntity(revId: string, id: string | undefined): string | null { return id ? (this.store.entitiesById(revId, [id])[0]?.file ?? null) : null; }
  private entitiesInFiles(revId: string, files: Set<string>): string[] {
    return this.store.entities(revId).filter((e) => files.has(e.file)).map((e) => e.entityId);
  }
  /** Base-side scope: the same changed paths (mapped through renames) that exist at base, plus their neighbourhood. */
  private baseScopeOf(resolved: ResolvedPr, baseRevId: string): Set<string> {
    const out = new Set<string>();
    for (const f of resolved.changedFiles) if (f.status !== "added") out.add(f.status === "renamed" && f.oldPath ? f.oldPath : f.path);
    const depth = Math.min(4, Math.max(1, this.opts.neighbourhoodDepth ?? 2));
    for (const id of this.entitiesInFiles(baseRevId, out)) {
      for (const n of dependents(this.store, baseRevId, id, { maxDepth: depth }).nodes) {
        if (n.file && !isTestPath(n.file) && n.id !== id) out.add(n.file);
      }
    }
    return out;
  }

  private defectToPrFinding(d: DetectorFinding, headRevId: string): PrFinding {
    const ent = d.entityIds[0] ? this.store.entitiesById(headRevId, [d.entityIds[0]])[0] : undefined;
    const sev = d.severity === "CRITICAL" || d.severity === "HIGH" ? "high" : d.severity === "MEDIUM" ? "medium" : "low";
    return {
      findingId: d.id, fingerprint: d.id, introduced: true,
      ruleId: d.ruleId, ruleVersion: d.ruleVersion, severity: sev,
      path: ent?.file ?? "", line: null, entityId: d.entityIds[0] ?? null, disposition: "OPEN",
      title: d.kind, summary: d.witness?.detail ?? d.kind,
      evidenceIds: d.evidenceIds, counterArgument: (d.coverageGaps ?? []).join("; "), kind: "DEFECT",
    };
  }

  private writeFindings(analysisId: string, rows: PrFinding[], kind: NonNullable<PrFinding["kind"]>) {
    const ins = this.store.db.prepare("insert or replace into pr_findings values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const f of rows) ins.run(analysisId, f.findingId, f.fingerprint, f.introduced ? 1 : 0, f.baselineFindingId ?? null, f.ruleId, f.ruleVersion, f.severity, f.path, f.line, f.entityId, kind, f.disposition, JSON.stringify(f));
  }
  prFindings(analysisId: string): PrFinding[] {
    return (this.store.db.prepare("select json, introduced, disposition, finding_id from pr_findings where analysis_id = ?").all(analysisId) as any[])
      .map((r) => { const f = JSON.parse(r.json) as PrFinding; f.introduced = !!r.introduced; f.disposition = r.disposition; f.findingId = r.finding_id; return f; });
  }

  // ------------------------------------------------------------------ oracle preservation (WP-07, §7.8)

  /**
   * Detector candidates with a stated limitation: removed or changed assertions, skipped or disabled tests, deleted
   * test files. They never claim completeness — a person answers whether behaviour is still pinned.
   */
  private oracleCandidates(resolved: ResolvedPr, baseDir: string, headDir: string): PrFinding[] {
    const out: PrFinding[] = [];
    const assertLine = (t: string) => /^\s*(?:await\s+)?(?:assert|expect|verify|t)\b/.test(t);
    for (const cf of resolved.changedFiles) {
      if (cf.status === "removed" && isTestPath(cf.path)) { out.push(this.oracleFinding(cf.path, null, "A test file is deleted in this PR.")); continue; }
      if (!isTestPath(cf.path) || cf.status === "removed") continue;
      const headText = readSmall(join(headDir, cf.path));
      if (headText === null) continue;
      // Added skips and disables, from the PR's own hunks.
      const lines = headText.split("\n");
      for (const l of resolved.changedLineRanges.get(cf.path) ?? []) {
        const text = (lines[l - 1] ?? "").trim();
        if (/\.skip\(|\bxit\(|@(?:Disabled|Ignore)\b/.test(text)) out.push(this.oracleFinding(cf.path, l, `The change adds a skip: ${text.slice(0, 60)}`));
      }
      // Removed or changed assertions: assert-family lines present at base but gone from the head of the same path.
      const baseFile = cf.status === "renamed" && cf.oldPath ? cf.oldPath : cf.path;
      const baseText = readSmall(join(baseDir, baseFile));
      if (baseText !== null) {
        const normalized = (text: string) => new Set(text.split("\n").filter(assertLine).map((l) => l.trim().replace(/\s+/g, " ")));
        for (const a of normalized(baseText)) if (!normalized(headText).has(a)) out.push(this.oracleFinding(cf.path, null, `An assertion is changed or removed: ${a.slice(0, 60)}`));
      }
    }
    return out.slice(0, MAX_FINDINGS_PER_RULE);
  }
  private oracleFinding(path: string, line: number | null, summary: string): PrFinding {
    return {
      findingId: `oracle:${sha([path, line, summary].join("|")).slice(0, 14)}`,
      fingerprint: "fp:" + sha(["ORACLE-CANDIDATE", `path:${path}`, normalizeAnchor(summary), line ?? 0].join("|")).slice(0, 24),
      introduced: true, ruleId: "ORACLE-CANDIDATE", ruleVersion: 1, severity: "low",
      path, line, entityId: null, disposition: "OPEN",
      title: "Assertion-level test change", summary, evidenceIds: [],
      counterArgument: "A removed, changed or skipped assertion can be a legitimate property change; only a person can tell.",
      kind: "ORACLE_CANDIDATE",
    };
  }

  // ------------------------------------------------------------------ gate decision (§7.2)

  /** The one place a decision is computed and stored. Pure evaluation; identity-deduplicated on (analysis, binding). */
  makeDecision(analysisId: string, dep: {
    policyRecord: PolicyRecord | null;
    analyzers: AnalyzerRecord[];
    baselineMode: "REUSED" | "REANALYZED";
    cs?: ChangeSet;
    coverage?: CoverageEvidence | null;
    oracle?: OracleEvidence | null;
    testsRun?: GateEvidence["testsRun"];
  }, opts: { now?: string; allowExpiredReevaluate?: boolean } = {}): string | null {
    const r = this.assertActive(analysisId, { allowExpiredReevaluate: opts.allowExpiredReevaluate });
    if (!dep.policyRecord) return null; // "no gate policy applies … findings are shown without a decision" (§12.4)
    const policyBody = dep.policyRecord.body as Parameters<typeof evaluate>[0];
    const evaluatedAt = opts.now ?? new Date().toISOString();
    const testImpact: GateEvidence["testImpact"] = dep.cs
      ? {
        lost: [...new Set(dep.cs.testImpact.flatMap((t) => t.lost))].sort(),
        gained: dep.cs.testImpact.reduce((n, t) => n + t.gained.length, 0),
        unchanged: dep.cs.testImpact.reduce((n, t) => n + t.unchanged.length, 0),
      }
      : (loadLastDecision(this.store, analysisId)?.testImpact ?? { lost: [], gained: 0, unchanged: 0 });
    const blastDependents = dep.cs?.blastRadius?.length ? dep.cs.blastRadius.reduce((m, b) => Math.max(m, b.dependents), 0) : (loadLastDecision(this.store, analysisId)?.blastRadius?.dependents ?? 0);
    const unresolvedDynamic = Number((this.store.db.prepare("select count(*) n from relationships where revision = ? and json like ?").get(r.head_revision ?? "", '%"resolution":"UNRESOLVED"%') as { n: number }).n);
    const testArtifact = loadRevisionTestEvidence(this.store, r.head_revision ?? "");
    const oracleRows = this.prFindings(analysisId).filter((f) => f.kind === "ORACLE_CANDIDATE");
    const oracle: OracleEvidence | null = dep.oracle ?? {
      candidates: oracleRows.length,
      reviewed: oracleRows.filter((f) => f.disposition !== "OPEN").length,
      headChangesTests: this.testsChanged(this.resolvedOf(analysisId)),
    };
    const evidence: GateEvidence = {
      analyzers: dep.analyzers,
      findings: this.prFindings(analysisId).filter((f) => f.kind === "SECURITY" && f.disposition !== "RESOLVED_BY_CHANGE"),
      testImpact,
      coverage: dep.coverage ?? null,
      testsRun: dep.testsRun ?? (testArtifact
        ? { source: testArtifact.source as "CI" | "REPOSITORY", headHash: testArtifact.artifactHead ?? r.head_hash, failedTests: testArtifact.tests.failed }
        : null),
      oracle,
      dependencies: null,
      blastRadius: { dependents: blastDependents },
      waivers: this.activeWaiversOf(r.repo_root, r.policy_id, evaluatedAt),
    };
    const decision = evaluate(policyBody, evidence, {
      baseHash: r.base_hash, headHash: r.head_hash, mergeBaseHash: r.merge_base_hash,
      analyzerSetHash: r.analyzer_set_hash, evaluatedAt,
    });
    // Deterministic per (analysis, binding): re-evaluating identical evidence refreshes the same row, not a duplicate (§6.1).
    const decisionId = hashId("dec", [analysisId, dep.policyRecord.policyHash, decision.bindingHash]);
    this.store.tx(() => {
      this.store.db.prepare("update gate_decisions set superseded = 1 where analysis_id = ? and superseded = 0 and decision_id <> ?").run(analysisId, decisionId);
      this.store.db.prepare(`insert into gate_decisions values (?,?,?,?,?,?,0,null,?)
        on conflict(decision_id) do update set status = excluded.status, binding_hash = excluded.binding_hash,
          evaluated_at = excluded.evaluated_at, valid_until = excluded.valid_until, superseded = 0, revoked_reason = null, json = excluded.json`)
        .run(decisionId, analysisId, decision.status, decision.bindingHash, decision.evaluatedAt, decision.validUntil ?? null, JSON.stringify({
          policy: { id: dep.policyRecord!.policyId, version: dep.policyRecord!.version, hash: dep.policyRecord!.policyHash },
          analyzers: dep.analyzers, baselineMode: dep.baselineMode, testImpact, coverage: dep.coverage ?? null,
          oracle, testsRun: evidence.testsRun, blastRadius: evidence.blastRadius, unresolvedDynamic, results: decision.results, exceptionsUsed: decision.exceptionsUsed,
        } satisfies StoredDecision));
      this.store.db.prepare("delete from gate_condition_results where decision_id = ?").run(decisionId);
      for (const cr of decision.results) this.store.db.prepare("insert into gate_condition_results values (?,?,?,?,?,?)").run(decisionId, cr.id, cr.outcome, cr.reason, JSON.stringify(cr.evidenceIds), cr.waiverId ?? null);
    });
    return decisionId;
  }

  private resolvedOf(analysisId: string): ResolvedPr {
    const r = this.row(analysisId);
    const files: ChangedFile[] = (this.store.db.prepare("select * from pr_changed_files where analysis_id = ?").all(analysisId) as any[])
      .map((c) => ({ path: c.path, status: c.status, oldPath: c.old_path ?? undefined, generated: !!c.generated }));
    return { baseHash: r.base_hash, headHash: r.head_hash, mergeBaseHash: r.merge_base_hash, changedFiles: files, changedLineRanges: new Map() };
  }
  private testsChanged(resolved: { changedFiles: { path: string; status: string }[] }): boolean {
    return resolved.changedFiles.some((f) => f.status !== "removed" && isTestPath(f.path));
  }

  /** The cheap re-evaluation (§7.9): dispositions and waivers feed the next evaluation without re-running analyzers. */
  reEvaluate(analysisId: string, opts: { now?: string } = {}): { decisionId: string | null; view: PrAnalysisView } {
    const r = this.row(analysisId);
    if (!r) throw new PrCheckError("NOT_FOUND", "no such analysis");
    let priorRow = this.lastDecisionRow(analysisId);
    // After an expired waiver the newest decision exists but is superseded; re-evaluation reads the newest row anyway.
    priorRow = (priorRow ?? (this.store.db.prepare("select * from gate_decisions where analysis_id = ? order by evaluated_at desc limit 1").get(analysisId) ?? null)) as typeof priorRow;
    if (!priorRow?.json) throw new PrCheckError("NOT_FOUND", "the analysis holds no current decision to re-evaluate; first run the analysis");
    const j = JSON.parse(priorRow.json) as StoredDecision;
    const policyRecord = this.policyOfHash(j.policy.id, j.policy.hash);
    if (!policyRecord) throw new PrCheckError("NOT_FOUND", `the policy version ${j.policy.id} v${j.policy.version} is gone from the store`);
    // Fresh dispositions (WP-08) and waivers feed the next evaluation (§7.9); the analyzer list is stored, not re-run.
    const decisionId = this.makeDecision(analysisId, {
      policyRecord, analyzers: j.analyzers, baselineMode: j.baselineMode,
      coverage: j.coverage, testsRun: j.testsRun,
    }, { now: opts.now, allowExpiredReevaluate: true });
    return { decisionId, view: this.compileReviewView(analysisId) };
  }

  // ------------------------------------------------------------------ waivers (WP-08, §7.9)

  createWaiver(repoRoot: string, input: { scopeKind: WaiverRecord["scopeKind"]; scope: Record<string, string>; rationale: string; expiresAt: string; actor: string; approver?: string; policyId?: string }, hasRole: (principal: string, role: string) => boolean): { ok: true; id: string } | { ok: false; error: string } {
    const policyId = input.policyId ?? this.repositoryPolicy(resolve(repoRoot));
    const policy = policyId ? this.getPolicy(policyId) : null;
    const v = validateWaiver({ scopeKind: input.scopeKind, scope: input.scope, rationale: input.rationale, expiresAt: input.expiresAt, policy: (policy?.body ?? undefined) as never });
    if (!v.ok) return v;
    const requireFrom = (policy?.body as { exceptions?: { requireApprovalFrom?: string[] } } | undefined)?.exceptions?.requireApprovalFrom ?? [];
    if (requireFrom.length) {
      if (!input.approver) return { ok: false, error: `a waiver under ${policyId} needs approval from a principal holding: ${requireFrom.join(", ")}` };
      if (!requireFrom.some((role) => hasRole(input.approver!, role))) return { ok: false, error: `the approver holds none of the roles this policy requires: ${requireFrom.join(", ")}` };
    }
    const id = "wa:" + randomUUID();
    this.store.db.prepare("insert into gate_waivers values (?,?,?,?,?,?,?,?,?,?)")
      .run(id, repoRoot, input.scopeKind, JSON.stringify(input.scope), input.actor, input.approver ?? null, input.rationale.slice(0, 500), new Date().toISOString(), input.expiresAt, null);
    this.store.audit(input.actor, "waiver.create", id, { scopeKind: input.scopeKind, approver: input.approver ?? null });
    return { ok: true, id };
  }
  revokeWaiver(id: string, reason: string) {
    this.store.db.prepare("update gate_waivers set revoked_at = ? where id = ?").run(new Date().toISOString(), id);
    this.store.audit("system", "waiver.revoke", id, { reason: reason.slice(0, 200) });
  }
  listWaivers(repoRoot?: string): WaiverRecord[] {
    return (this.store.db.prepare("select * from gate_waivers where (? is null or repository_id = ?) order by created_at desc, id").all(repoRoot ?? null, repoRoot ?? null) as any[]).map((r) => ({
      id: r.id, scopeKind: r.scope_kind, scope: JSON.parse(r.scope_json), actor: r.actor, approver: r.approver ?? undefined,
      rationale: r.rationale, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at,
    }));
  }
  private activeWaiversOf(repoRoot: string, policyId: string, at: string): WaiverRecord[] {
    void policyId; // waivers are repository-scoped; the policy pins only the approval requirements
    return this.listWaivers(repoRoot).filter((w) => !w.revokedAt && Date.parse(w.expiresAt) > Date.parse(at));
  }

  /** Record a disposition on one finding of one analysis (C18). A WAIVED disposition creates its waiver with scope and expiry. */
  recordDisposition(req: {
    analysisId: string; findingId: string; disposition: PrFinding["disposition"]; rationale?: string; actor: string;
    waiver?: { scopeKind: WaiverRecord["scopeKind"]; scope?: Record<string, string>; expiresAt?: string; approver?: string; policyId?: string };
    hasRole?: (principal: string, role: string) => boolean;
  }): { ok: true; finding: PrFinding; decisionId: string | null } | { ok: false; error: string } {
    const rows = (this.store.db.prepare("select kind, fingerprint, path, json from pr_findings where analysis_id = ? and finding_id = ?").get(req.analysisId, req.findingId) ?? null) as { kind: string; fingerprint: string; path: string; json: string } | null;
    if (!rows) return { ok: false, error: `no finding ${req.findingId} in analysis ${req.analysisId}` };
    const f = JSON.parse(rows.json) as PrFinding;
    let waiverId: string | undefined;
    if (req.disposition === "WAIVED") {
      if (!req.waiver || !req.waiver.expiresAt) return { ok: false, error: "waiving needs a waiver with scope and expiry" };
      const w = this.createWaiver((this.row(req.analysisId) as any).repo_root, {
        scopeKind: req.waiver.scopeKind,
        scope: req.waiver.scopeKind === "FINDING_FINGERPRINT" ? { fingerprint: rows.fingerprint }
          : req.waiver.scopeKind === "RULE_IN_PATH" ? { ruleId: f.ruleId, path: rows.path }
          : { ...(req.waiver.scope ?? {}), fingerprint: rows.fingerprint },
        rationale: req.rationale ?? "", expiresAt: req.waiver.expiresAt, actor: req.actor, approver: req.waiver.approver,
        policyId: req.waiver.policyId,
      }, req.hasRole ?? (() => true));
      if (!w.ok) return { ok: false, error: w.error };
      waiverId = w.id;
      this.store.audit(req.actor, "pr.disposition", `${req.analysisId}/${req.findingId}`, { disposition: req.disposition, waiverId });
    } else {
      if (req.disposition === "DISMISSED_FALSE_POSITIVE" && !(req.rationale ?? "").trim()) return { ok: false, error: "a dismissal needs a rationale" };
      this.store.audit(req.actor, "pr.disposition", `${req.analysisId}/${req.findingId}`, { disposition: req.disposition });
    }
    const next: PrFinding = {
      ...f, findingId: req.findingId, disposition: req.disposition,
      kind: (rows.kind === "ORACLE_CANDIDATE" || rows.kind === "DEFECT" ? rows.kind : "SECURITY") as PrFinding["kind"],
    };
    this.store.db.prepare("update pr_findings set disposition = ?, json = ? where analysis_id = ? and finding_id = ?")
      .run(req.disposition, JSON.stringify(next), req.analysisId, req.findingId);
    // Dispositions change the evidence a decision rests on: re-evaluate now; this is the cheap path (no analyzers re-run).
    const decisionId = this.lastDecisionRow(req.analysisId) ? this.reEvaluate(req.analysisId).decisionId : null;
    return { ok: true, finding: next, decisionId };
  }

  // ------------------------------------------------------------------ decisions: verify, invalidate, list

  decisionRow(decisionId: string) {
    return (this.store.db.prepare("select * from gate_decisions where decision_id = ?").get(decisionId) ?? null) as any;
  }
  lastDecisionRow(analysisId: string) {
    return (this.store.db.prepare("select * from gate_decisions where analysis_id = ? and superseded = 0 order by evaluated_at desc limit 1").get(analysisId) ?? null) as any;
  }
  decisionsOf(analysisId: string) {
    return this.store.db.prepare("select decision_id, status, binding_hash, evaluated_at, valid_until, superseded, revoked_reason from gate_decisions where analysis_id = ? order by evaluated_at desc, decision_id").all(analysisId) as any[];
  }

  /** Is the decision still valid? Answers with reasons for what would no longer hold, never a bare boolean in prose (§6.3). */
  verifyBinding(decisionId: string): { decisionId: string; analysisId: string; valid: boolean; reasons: string[] } {
    const d = this.decisionRow(decisionId);
    if (!d) return { decisionId, analysisId: "", valid: false, reasons: ["no such decision"] };
    const reasons: string[] = [];
    if (d.superseded) reasons.push(`the decision is superseded: ${d.revoked_reason ?? "a newer decision exists"}`);
    const j = JSON.parse(d.json) as { policy?: { id: string; version: number; hash: string } };
    const policy = j.policy ? this.policyOfHash(j.policy.id, j.policy.hash) : null;
    if (j.policy && !policy) reasons.push(`the policy version ${j.policy.id} v${j.policy.version} (${j.policy.hash}) is gone from the store`);
    if (reasons.length) return { decisionId, analysisId: d.analysis_id, valid: false, reasons };
    return {
      decisionId, analysisId: d.analysis_id, valid: true,
      reasons: [`the decision is current, its policy ${j.policy?.id} v${j.policy?.version} is intact, and every condition outcome carries the evidence ids it rests on`],
    };
  }

  invalidateDecision(decisionId: string, reason: string) {
    if (!this.decisionRow(decisionId)) throw new PrCheckError("NOT_FOUND", "no such decision");
    this.store.db.prepare("update gate_decisions set superseded = 1, revoked_reason = ? where decision_id = ?").run(reason.slice(0, 300), decisionId);
    this.store.db.prepare("update check_publications set state = 'SUPERSEDED', updated_at = ? where decision_id = ?").run(new Date().toISOString(), decisionId);
    this.store.audit("system", "decision.invalidate", decisionId, { reason: reason.slice(0, 200) });
  }

  // ------------------------------------------------------------------ expiry sweep (§7.9, §11)

  /** A decision that relied on a waiver has just that long to live; past it, supersede the decision, mark the analysis EXPIRED_WAIVER, supersede its publications. */
  sweepExpired(now = new Date()): { expired: string[] } {
    const expired: string[] = [];
    const at = now.getTime();
    for (const w of this.listWaivers()) {
      if (w.revokedAt || Date.parse(w.expiresAt) >= at) continue;
      // An expired waiver stops covering: its findings are shown OPEN again at once (§7.9).
      if (w.scopeKind === "FINDING_FINGERPRINT") {
        this.store.db.prepare("update pr_findings set disposition = 'OPEN' where fingerprint = ? and disposition = 'WAIVED'").run(w.scope.fingerprint as string);
        expired.push(w.id);
      } else if (w.scopeKind === "RULE_IN_PATH") {
        this.store.db.prepare("update pr_findings set disposition = 'OPEN' where rule_id = ? and path = ? and disposition = 'WAIVED'").run(w.scope.ruleId as string, w.scope.path as string);
        expired.push(w.id);
      }
    }
    for (const d of this.store.db.prepare("select decision_id, valid_until, analysis_id from gate_decisions where superseded = 0 and valid_until is not null").all() as any[]) {
      if (Date.parse(d.valid_until) < at) {
        this.invalidateDecision(d.decision_id, "a waiver the decision relied on has expired");
        this.setState(d.analysis_id, "EXPIRED_WAIVER");
        expired.push(d.decision_id);
      }
    }
    return { expired };
  }

  // ------------------------------------------------------------------ the review view (WP-10, §12)

  compileReviewView(analysisId: string): PrAnalysisView {
    const r = this.row(analysisId);
    if (!r) throw new PrCheckError("NOT_FOUND", "no such analysis");
    const job = r.job_id ? this.store.job(r.job_id as string) : null;
    const files: ChangedFile[] = (this.store.db.prepare("select * from pr_changed_files where analysis_id = ? order by path").all(analysisId) as any[]).map((c) => ({
      path: c.path, status: c.status as ChangedFile["status"], oldPath: c.old_path ?? undefined,
      additions: c.additions ?? undefined, deletions: c.deletions ?? undefined, generated: !!c.generated,
    }));
    const findings = this.prFindings(analysisId);
    const denied = this.store.deniedPrefixes(r.repo_root);
    const visible = findings.filter((f) => !denied.some((p) => f.path === p || f.path.startsWith(p + "/")));
    const withheld = findings.length - visible.length;
    const drow = this.lastDecisionRow(analysisId);
    const dj = drow ? JSON.parse(drow.json) as StoredDecision : null;
    const te = loadRevisionTestEvidence(this.store, r.head_revision ?? "");
    // F11 (slice S1): the retained ChangeSet populates `changes`; its derived impact report rides along when built.
    const cs = this.changeSetOf(analysisId);
    const impact = this.impactReportOf(analysisId);
    return {
      analysisId,
      pr: { repositoryId: r.repository_id, forge: r.forge, prNumber: r.pr_number },
      repoRoot: r.repo_root, baseHash: r.base_hash, headHash: r.head_hash, mergeBaseHash: r.merge_base_hash, headRepository: r.head_repository ?? undefined,
      baseRevision: r.base_revision ?? undefined, headRevision: r.head_revision ?? undefined,
      policyId: r.policy_id, policyHash: r.policy_hash, analyzerSetHash: r.analyzer_set_hash,
      state: r.state as PrAnalysisView["state"], ...(r.superseded_by ? { supersededBy: r.superseded_by } : {}),
      ...(job ? { job: { id: job.id, kind: job.kind, state: job.state, phase: job.phase, message: job.message } } : {}),
      changes: {
        files,
        consequences: cs ? cs.consequences.map((c) => ({ id: c.id, text: c.text, kind: c.kind })) : [],
        blastRadius: cs?.blastRadius ?? [],
        testImpact: cs?.testImpact ?? [],
        gaps: cs?.gaps ?? [],
      },
      findings: {
        introduced: visible.filter((f) => f.introduced && f.kind === "SECURITY"),
        existing: visible.filter((f) => !f.introduced && f.kind === "SECURITY" && f.disposition !== "RESOLVED_BY_CHANGE"),
        resolvedByChange: visible.filter((f) => f.kind === "SECURITY" && f.disposition === "RESOLVED_BY_CHANGE"),
        // detector and oracle candidates: surfaced for review, never gate-blocking on their own (§7.8)
        detectorCandidates: visible.filter((f) => f.kind && f.kind !== "SECURITY"),
      },
      analyzers: dj?.analyzers ?? [],
      baseline: { mode: dj?.baselineMode ?? "REANALYZED", analyzerSetHash: r.analyzer_set_hash },
      tests: te ? {
        summary: {
          found: te.found, coverageFiles: te.coverageFiles, coverageLinePercent: te.coverageLinePercent,
          tests: te.tests, failing: te.failing, generatedAt: "", staleness: [],
        } satisfies TestSummaryInfo,
        coverage: dj?.coverage ?? null, source: te.source,
      } : null,
      waivers: this.listWaivers(r.repo_root),
      unresolved: { dynamicCalls: dj?.unresolvedDynamic ?? 0, runtimeData: false },
      disclosure: this.disclosureOf(r, dj, te, withheld, findings.length),
      ...(impact ? { impact } : {}),
      ...(drow && dj ? {
        decision: {
          decisionId: drow.decision_id, status: drow.status, bindingHash: drow.binding_hash,
          policy: { policyId: dj.policy.id, version: dj.policy.version, policyHash: dj.policy.hash },
          evaluatedAt: drow.evaluated_at, validUntil: drow.valid_until ?? undefined,
          ...(dj.exceptionsUsed ? { exceptionsUsed: dj.exceptionsUsed } : {}),
          superseded: !!drow.superseded, revokedReason: drow.revoked_reason ?? undefined,
          conditions: dj.results, analysisId,
        } satisfies import("@cie/schema").GateDecisionView,
      } : {}),
    };
  }

  /** "What this does not tell you" — the analysis's own limits, in plain sentences (§12.3). */
  private disclosureOf(r: any, dj: StoredDecision | null, te: StoredTestEvidence | null, withheld: number, totalFindings: number): string[] {
    const out: string[] = [];
    const unresolvedRow = this.store.db.prepare("select count(*) n from relationships where revision = ? and json like ?").get(r.head_revision ?? "", '%"resolution":"UNRESOLVED"%') as { n: number };
    if (Number(unresolvedRow?.n ?? 0) > 0) out.push(`Dynamic calls static analysis could not resolve are not followed (${unresolvedRow.n} unresolved relationship(s) at the head); their behaviour is not analysed.`);
    out.push("No runtime data was used; this is static analysis of the PR's code, over the changed files and their dependents.");
    if (te?.disclosure) out.push(te.disclosure);
    if (dj?.coverage?.disclosure) out.push(dj.coverage.disclosure);
    for (const a of dj?.analyzers ?? []) {
      if (a.state !== "COMPLETE") out.push(`analyzer ${a.id}@${a.version} states ${a.state}: ${(a.reason ?? "findings in files it did not analyse are not claimed").slice(0, 120)}`);
    }
    if (withheld) out.push(`${withheld} finding(s) are in code you do not have access to; they are counted here, not named (of ${totalFindings} in total).`);
    else if (!totalFindings) out.push("No findings were produced in the analysed scope; no finding does not mean safe.");
    return out;
  }
}

function loadLastDecision(store: Store, analysisId: string): StoredDecision | null {
  const r = store.db.prepare("select json from gate_decisions where analysis_id = ? and superseded = 0 order by evaluated_at desc limit 1").get(analysisId) as { json: string } | undefined;
  return r ? JSON.parse(r.json) as StoredDecision : null;
}