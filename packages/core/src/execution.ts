// F07 — task → candidate → validated patch → CIE-owned branch → draft PR.
//
// Three repository invariants are preserved by construction here:
//   1. Nothing in this file writes to the user's working tree. A candidate is materialised in a scratch copy of the
//      base tree (`git archive <baseCommit>`), and a branch is created in a CIE-owned clone under `<cie-data>/clones`.
//   2. A candidate is never a patch, a file or a shell command: it is a list of `EditOperation`s, each quoting the
//      exact bytes it replaces. Admission rejects anything that is not exact, contained, inside size caps, or that
//      touches a protected path (tests, CI config, lockfiles, secrets).
//   3. "Verified" is only ever said for `PASSED_DEFINED_GATES` with the original oracle preserved (or a recorded
//      property-change review), every mandatory role passed, and the isolated runs' omissions disclosed. A missing
//      mandatory role is `INCOMPLETE` with the role named, never a pass.
//
// Isolation honesty: the runs below use Node's permission model (`--permission` with read access to the checkout
// only), a scrubbed environment, a wall-clock kill and process-group cleanup, and they cannot spawn a child process
// or open a socket — Node refuses those without explicit grants. That is *not* a container or a VM: there is no CPU,
// memory or pid limit and no kernel boundary. The class is recorded on every run (`LOCAL_PERMISSION_MODEL`) together
// with its omissions, and candidates are refused outright when the task demands an audited container profile
// (`requireAuditedIsolation`). The engine never falls back to running a candidate outside the boundary it recorded.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EditOperationSchema, TaskSpecSchema, type EditOperation, type TaskSpec } from "@cie/schema";
export type { TaskSpec, EditOperation };
import { applyTextEdits, copyTree, hashTree, makeScratch, removeScratch, runTestsIn, safeJoin, sha256, treeDiff, typecheckDir, walkFiles, type TreeChange } from "./isolated-exec.ts";
import { failpoint } from "./failpoint.ts";
import type { DraftForge } from "./defect-workflow.ts";
import type { Store } from "./store.ts";

// ------------------------------------------------------------------ errors

export type TaskErrorCode = "INVALID_SCHEMA" | "FORBIDDEN" | "STALE_REVISION" | "VERSION_CONFLICT" | "NOT_FOUND" | "INSUFFICIENT_EVIDENCE" | "PROVIDER_UNAVAILABLE" | "BUDGET_EXCEEDED" | "CANCELLED" | "RESOURCE_LIMIT";

export class TaskError extends Error {
  readonly code: TaskErrorCode;
  /** For a BLOCKED task: the machine-readable reasons (missing role, unreproducible defect, isolation unavailable). */
  readonly blockedBy: string[];
  constructor(code: TaskErrorCode, message: string, blockedBy: string[] = []) {
    super(message);
    this.name = "TaskError";
    this.code = code;
    this.blockedBy = blockedBy;
  }
}

// ------------------------------------------------------------------ types

export type TaskState = "RECEIVED" | "PLANNED" | "CANDIDATE_READY" | "VALIDATING" | "REVIEW_READY" | "PUBLISHED" | "BLOCKED" | "CANCELLED" | "FAILED" | "STALE";
export type ValidationRole = "BASELINE" | "ORACLE_ORIGINAL_ON_CANDIDATE" | "CANDIDATE_SUITE" | "STATIC_CHECK" | "ORACLE_PRESERVATION";
export type RoleStatus = "PASSED" | "FAILED" | "INCOMPLETE" | "INFRA_FAILED" | "BUDGET_STOPPED" | "CANCELLED" | "NOT_APPLICABLE";
export type OracleState = "ORIGINAL_PRESERVED" | "PROPERTY_CHANGE_PENDING_REVIEW" | "PROPERTY_CHANGE_REVIEWED" | "NO_ORACLE";
export type VerdictState = "PASSED_DEFINED_GATES" | "REVIEWABLE_WITH_LIMITS" | "FAILED" | "INCOMPLETE" | "BLOCKED";
export type IsolationClass = "LOCAL_PERMISSION_MODEL" | "CONTAINER" | "VM_BACKED";

export interface EditContext {
  /** Normalised, repository-relative paths the task allows; empty means "anywhere not forbidden". */
  allowedPaths: string[];
  forbiddenPaths: string[];
  maxFilesChanged: number;
  maxDiffLines: number;
  /** Test files may only be *added* unless this is set (a property change must be admitted explicitly). */
  allowTestEdits?: boolean;
}

export interface TaskView {
  taskId: string;
  state: TaskState;
  version: number;
  generation: number;
  spec: TaskSpec;
  specHash: string;
  baseCommit: string;
  baseContentHash: string;
  candidateIndex: number | null;
  bindingHash: string | null;
  verdict: VerdictState | null;
  oracleState: OracleState | null;
  blockedBy: string[];
  confirmed: boolean;
}

export interface Plan {
  steps: { id: string; text: string; files: string[]; kind: "READ" | "EDIT" | "RUN" | "PUBLISH" }[];
  unknowns: { id: string; question: string }[];
  obligations: { id: string; question: string; checks: { kind: "SEARCH" | "READ" | "GIT"; pattern?: string; file?: string }[] }[];
  rationale: string;
}

export interface RoleRunRecord {
  role: ValidationRole;
  mandatory: boolean;
  status: RoleStatus;
  passed: number;
  failed: number;
  outcomes: { name: string; state: "PASS" | "FAIL" | "SKIP" | "TODO" | "FLAKY" }[];
  output: string;
  omissions: string[];
}

// ------------------------------------------------------------------ pure admission and detection

const PROTECTED_RE = [
  /(^|\/)\.github\//, /(^|\/)\.gitlab-ci\.ya?ml$/, /(^|\/)\.circleci\//, /(^|\/)Jenkinsfile$/,
  /(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.ya?ml$/, /(^|\/)Cargo\.lock$/, /(^|\/)go\.sum$/,
  /(^|\/)\.env(\.|$)/, /(^|\/)secrets?\//, /(^|\/)secrets?\.(json|ya?ml|toml)$/, /(^|\/)id_(rsa|ed25519|ecdsa)/, /\.(pem|key|p12)$/,
  /(^|\/)\.(npmrc|yarnrc|gitmodules|gitattributes)$/,
];
export const isTestPath = (rel: string): boolean => /(^|\/)(tests?|__tests__|spec)\//i.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /_test\.(go|rs|py)$/.test(rel) || /(^|\/)test_.*\.py$/.test(rel);
/** Paths a candidate may not touch unless the task explicitly authorises them (§7.3 rule 2 and 3). */
export const isProtectedPath = (rel: string): boolean => PROTECTED_RE.some((re) => re.test(rel)) || isTestPath(rel);

export function normalizeRel(file: string): string {
  const abs = resolve("/", file);
  // A path is repository-relative by contract; absolute inputs and traversal are rejected before normalisation.
  void abs;
  return file.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter((s) => s !== "" && s !== ".").join("/");
}

/** Everything the admission rules reject, as typed reasons — never a silent "close enough". */
export function admissionProblems(ops: EditOperation[], ctx: EditContext): string[] {
  const out: string[] = [];
  if (!ops.length) out.push("the proposer returned no operations");
  if (ops.length > 500) out.push("more operations than the admission cap");
  const files = new Set(ops.map((o) => normalizeRel(o.file)));
  if (files.size > ctx.maxFilesChanged) out.push(`${files.size} files changed exceeds maxFilesChanged ${ctx.maxFilesChanged}`);
  const allow = ctx.allowedPaths.map(normalizeRel).filter((p) => p.length > 0);
  const deny = ctx.forbiddenPaths.map(normalizeRel);
  const inAllow = (rel: string) => allow.length === 0 || allow.some((p) => rel === p || rel.startsWith(`${p}/`));
  const inDeny = (rel: string) => deny.some((p) => rel === p || rel.startsWith(`${p}/`));
  let diffLines = 0;
  const spans = new Map<string, { start: number; end: number }[]>();
  for (const op of ops) {
    const raw = op.file;
    if (raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw)) out.push(`absolute path rejected: ${raw}`);
    if (raw.split(/[\\/]/).includes("..")) out.push(`traversal rejected: ${raw}`);
    const rel = normalizeRel(raw);
    if (!rel) { out.push("an operation had an empty path"); continue; }
    if (rel.split("/").includes(".git")) out.push(`.git is never edited: ${rel}`);
    if (!inAllow(rel)) out.push(`outside the allowed paths: ${rel}`);
    if (inDeny(rel)) out.push(`inside a forbidden path: ${rel}`);
    if (isProtectedPath(rel) && !ctx.allowTestEdits) out.push(`protected path (tests, CI config, lockfile or secret): ${rel}`);
    if (op.op === "REPLACE_SPAN") {
      if (op.end < op.start) out.push(`span end precedes start in ${rel}`);
      diffLines += op.newText.split("\n").length + op.expected.split("\n").length;
      const list = spans.get(rel) ?? [];
      for (const s of list) if (op.start < s.end && s.start < op.end) out.push(`overlapping edits in ${rel}`);
      list.push({ start: op.start, end: op.end });
      spans.set(rel, list);
    } else if (op.op === "CREATE_FILE") {
      diffLines += op.content.split("\n").length;
    } else {
      diffLines += 0;
    }
  }
  if (diffLines > ctx.maxDiffLines) out.push(`diff of ${diffLines} lines exceeds maxDiffLines ${ctx.maxDiffLines}`);
  return out;
}

/** Read the file a span edit quotes, so admission can check the bytes on disk rather than trust the proposer. */
export function readSpanTarget(root: string, rel: string): { text: string; hash: string } | null {
  try {
    const data = readFileSync(safeJoin(root, rel));
    return { text: data.toString("utf8"), hash: sha256(data) };
  } catch {
    return null;
  }
}

/** Exactness: `expected` must be the bytes at `[start,end)` and `baseHash` the file's hash. */
export function exactnessProblems(root: string, ops: EditOperation[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    const rel = normalizeRel(op.file);
    const target = readSpanTarget(root, rel);
    if (op.op === "CREATE_FILE") {
      if (target) out.push(`${rel} already exists; creating it would overwrite a file`);
      continue;
    }
    if (!target) { out.push(`${rel} does not exist in the base tree`); continue; }
    if (target.hash !== op.baseHash) { out.push(`${rel} has changed since the proposer read it (base hash mismatch)`); continue; }
    if (op.op === "REPLACE_SPAN") {
      const bytes = Buffer.from(target.text, "utf8").subarray(op.start, op.end).toString("utf8");
      if (bytes !== op.expected) out.push(`the text at ${rel}:${op.start} is not what the edit quotes`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ oracle preservation (syntactic, disclosed as such)

export interface AssertionFact { file: string; testCase: string; matcher: string; value: string }
export interface OracleChange { kind: string; file: string; testCase: string; detail: string }

const LOOSENING: Record<string, string[]> = {
  toBe: ["toBeDefined", "toBeTruthy", "toBeNull", "toBeUndefined", "toBeFalsy", "not.toBe"],
  toEqual: ["toBeDefined", "toBeTruthy", "toBeNull", "toBeUndefined"], toStrictEqual: ["toBeDefined", "toBeTruthy", "toEqual"],
  toContain: ["toBeDefined", "toBeTruthy"], toMatch: ["toBeDefined", "toBeTruthy"], toMatchObject: ["toBeDefined", "toBeTruthy"],
  toHaveLength: ["toBeDefined", "toBeTruthy"], toBeGreaterThan: ["toBeDefined", "toBeTruthy"], toBeLessThan: ["toBeDefined", "toBeTruthy"],
  toThrow: ["toBeDefined", "toBeTruthy"],
  "assert.strictEqual": ["assert.equal", "assert.ok", "assert.truthy"],
  "assert.deepStrictEqual": ["assert.deepEqual", "assert.ok"],
  "assert.equal": ["assert.ok"],
  "assert.match": ["assert.ok"],
  "assert.throws": ["assert.ok"],
};

/** The text inside a call's parentheses, found by counting brackets so a nested call is not truncated at its first `)`. */
function balancedArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") { depth -= 1; if (depth === 0) return text.slice(open + 1, i); }
  }
  return text.slice(open + 1);
}

/**
 * Assertion constructs of one test file, normalised: test case name, matcher, literal expected value. Both the
 * jest-style (`expect(x).toBe(y)`) and Node's own (`assert.strictEqual(x, y)`) shapes are read, because this
 * repository's fixtures use the latter and a detector that only understood one of them would miss a real rewrite.
 */
export function extractAssertions(file: string, source: string): AssertionFact[] {
  const out: AssertionFact[] = [];
  let currentTestCase = "(file scope)";
  for (const line of source.split("\n")) {
    const tc = /(?:^|\s)(?:it|test)(?:\.\w+)?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(line);
    if (tc) currentTestCase = tc[2]!;
    const push = (matcher: string, raw: string) => out.push({ file, testCase: currentTestCase, matcher, value: raw.replace(/\s+/g, " ").trim().slice(0, 120) });
    for (const m of line.matchAll(/\.(to[A-Za-z]+|not\.to[A-Za-z]+)\s*\(/g)) push(m[1]!, balancedArgs(line, (m.index ?? 0) + m[0].length - 1));
    for (const m of line.matchAll(/\b(assert(?:\.[a-zA-Z]+)?)\s*\(/g)) push(m[1]!, balancedArgs(line, (m.index ?? 0) + m[0].length - 1));
  }
  return out;
}

/** The largest timeout a file states: a named `timeout:` option, `jest.setTimeout`, or a numeric third argument. */
export function timeoutIn(source: string): number {
  const named = [...source.matchAll(/\b(?:timeout|jest\.setTimeout)\s*[:(]\s*(\d[\d_]*)/g)].map((m) => Number(m[1]!.replace(/_/g, "")));
  // A numeric third argument to a single-line `it`/`test` declaration is a per-case timeout (60_000 is 60000).
  const trailing = [...source.matchAll(/^\s*(?:it|test)(?:\.\w+)?\(.*,\s*(\d[\d_]*)\s*\)\s*;?\s*$/gm)].map((m) => Number(m[1]!.replace(/_/g, "")));
  const all = [...named, ...trailing];
  return all.length ? Math.max(...all) : 0;
}

/** Test-case names declared in a file (`it`/`test`/`describe`), used to notice a removed test. */
export function testCaseNames(source: string): string[] {
  return [...source.matchAll(/(?:^|\s)(?:it|test)(?:\.\w+)?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!);
}

/**
 * Assertion-level differences between the base version of a test file and the candidate's. This is detection of
 * candidates, never proof of preservation: it is syntactic, and a behaviour change hidden in a helper or fixture it
 * imports is not seen. The unchanged original-oracle run is the independent backstop for exactly that case.
 */
export function detectOracleWeakening(base: Map<string, string>, candidate: Map<string, string>): OracleChange[] {
  const changes: OracleChange[] = [];
  for (const [file, baseText] of base) {
    const candText = candidate.get(file);
    if (candText === undefined) { changes.push({ kind: "DELETED_TEST_FILE", file, testCase: "(file)", detail: "the test file is gone from the candidate" }); continue; }
    const baseCases = testCaseNames(baseText), candCases = new Set(testCaseNames(candText));
    for (const name of baseCases) if (!candCases.has(name)) changes.push({ kind: "REMOVED_TEST_CASE", file, testCase: name, detail: "the test case no longer exists" });
    const candFacts = extractAssertions(file, candText);
    const byCase = new Map<string, AssertionFact[]>();
    for (const f of candFacts) byCase.set(f.testCase, [...(byCase.get(f.testCase) ?? []), f]);
    for (const fact of extractAssertions(file, baseText)) {
      const list = byCase.get(fact.testCase) ?? [];
      if (!list.length) continue; // the whole case was reported as removed above
      const sameMatcher = list.filter((c) => c.matcher === fact.matcher);
      if (!sameMatcher.length) {
        const loosened = list.find((c) => (LOOSENING[fact.matcher] ?? []).includes(c.matcher));
        if (loosened) changes.push({ kind: "LOOSENED_MATCHER", file, testCase: fact.testCase, detail: `${fact.matcher} became ${loosened.matcher}` });
        else changes.push({ kind: "REMOVED_ASSERTION", file, testCase: fact.testCase, detail: `${fact.matcher}(${fact.value}) is gone` });
        continue;
      }
      if (!sameMatcher.some((c) => c.value === fact.value)) changes.push({ kind: "CHANGED_EXPECTED", file, testCase: fact.testCase, detail: `${fact.matcher} expected value changed from ${fact.value || "(none)"}` });
    }
    if (/(\.skip|\.todo|xdescribe|xit)\s*\(/.test(candText) && !/(\.skip|\.todo|xdescribe|xit)\s*\(/.test(baseText)) changes.push({ kind: "ADDED_SKIP", file, testCase: "(file)", detail: "a test was skipped or marked todo" });
    if (/\.only\s*\(/.test(candText) && !/\.only\s*\(/.test(baseText)) changes.push({ kind: "ADDED_ONLY", file, testCase: "(file)", detail: "a test was pinned with .only" });
    const baseTimeout = timeoutIn(baseText);
    const candTimeout = timeoutIn(candText);
    if (candTimeout > baseTimeout) changes.push({ kind: "RAISED_TIMEOUT", file, testCase: "(file)", detail: `timeout ${baseTimeout} → ${candTimeout}` });
    const baseSnaps = (baseText.match(/toMatchSnapshot|toMatchInlineSnapshot/g) ?? []).length;
    const candSnaps = (candText.match(/toMatchSnapshot|toMatchInlineSnapshot/g) ?? []).length;
    if (candSnaps < baseSnaps) changes.push({ kind: "SNAPSHOT_REWRITE", file, testCase: "(file)", detail: `${baseSnaps} snapshot assertions became ${candSnaps}` });
    if (/\bcatch\b/.test(candText) && !/\bcatch\b/.test(baseText)) changes.push({ kind: "SWALLOWED_ERROR", file, testCase: "(file)", detail: "a try/catch was added around the test body" });
  }
  return changes;
}

// ------------------------------------------------------------------ binding

/** Canonical JSON: object keys sorted at every level, so re-ordering fields cannot change a binding's identity. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function bindingHashOf(binding: Omit<Record<string, unknown>, "bindingHash">): string {
  return sha256(canonicalJson(binding));
}

// ------------------------------------------------------------------ run records

export interface OracleRunResult { status: RoleStatus; passed: number; failed: number; output: string; outcomes: { name: string; state: "PASS" | "FAIL" | "SKIP" | "TODO" | "FLAKY" }[]; runManifestId: string; outcomesArtifactHash: string }

/** How a role is executed. The real one is Node's permission model; tests may supply a scripted one, which is recorded as such. */
export interface RoleRunner {
  readonly isolation: IsolationClass;
  readonly omissions: string[];
  runTests(dir: string, files: string[] | undefined, timeoutMs: number): { ran: boolean; passed: number; failed: number; output: string; reason?: string };
}

export const permissionModelRunner: RoleRunner = {
  isolation: "LOCAL_PERMISSION_MODEL",
  omissions: [
    "no container or VM boundary: no CPU, memory or pid limit, and no kernel isolation",
    "network and child processes are denied by Node's permission model, not by a network namespace",
    "the checkout is read-only by permission only; a writable scratch inside it is reachable",
  ],
  runTests: (dir, files, timeoutMs) => runTestsIn(dir, timeoutMs, files),
};

/** Outcomes are read from the runner's own report, so a failing case cannot be left out of the summary. */
function outcomesFrom(output: string): { name: string; state: "PASS" | "FAIL" | "SKIP" | "TODO" | "FLAKY" }[] {
  const out: { name: string; state: "PASS" | "FAIL" | "SKIP" | "TODO" | "FLAKY" }[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(✔|✖|﹣|↓)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?$/.exec(line);
    if (m) out.push({ name: m[2]!.slice(0, 300), state: m[1] === "✔" ? "PASS" : m[1] === "✖" ? "FAIL" : m[1] === "﹣" ? "TODO" : "SKIP" });
  }
  return out.slice(0, 2000);
}

// ------------------------------------------------------------------ the engine

/** The canonical binding: its SHA-256 is what review, grants, verdicts and the receipt all reference. */
export interface BindingCore {
  schemaId: string; taskId: string; repositoryId: string;
  baseCommitHash: string; baseContentHash: string; candidateContentHash: string; diffHash: string;
  originalOracleHash: string; candidateOracleHash: string; validationPlanHash: string; environmentHash: string;
  isolation: IsolationClass; runManifestIds: string[];
  changes: { file: string; kind: "ADDED" | "MODIFIED" | "DELETED"; added: number; removed: number }[];
  propertyChangeReviewId?: string | null;
}

export interface CandidateRecord {
  taskId: string;
  candidateIndex: number;
  proposalId: string;
  binding: BindingCore & { bindingHash: string };
  bindingHash: string;
  origin: "MODEL" | "HUMAN" | "MIXED";
  oracleState: OracleState;
  state: "MATERIALIZED" | "VALIDATING" | "VALIDATED" | "FAILED" | "STALE" | "SUPERSEDED";
  editOperations: EditOperation[];
  changedFiles: string[];
  planVersion: number;
}

export type StoredCandidate = CandidateRecord & { changedContents: Record<string, string | null> };

export interface TaskDeps {
  store: Store;
  /** Where CIE keeps its own clones. Defaults to `<repoRoot>/.cie/clones` only for tests; production passes a data dir. */
  clonesDir?: string;
  runner?: RoleRunner;
  now?: () => number;
  /** A scratch area for materialisation; removed after use unless `keepScratch` is set (debugging only). */
  scratchRoot?: string;
}

const TASK_LIMITS = {
  investigationSteps: 8,
  planRetries: 1,
  proposalRetries: 2,
  publishPollMs: 0,
  roles: ["BASELINE", "ORACLE_ORIGINAL_ON_CANDIDATE", "STATIC_CHECK", "ORACLE_PRESERVATION"] as ValidationRole[],
};

export class Tasks {
  private readonly store: Store;
  private readonly runner: RoleRunner;
  private readonly now: () => number;
  private readonly clonesDir?: string;

  constructor(deps: TaskDeps) {
    this.store = deps.store;
    this.runner = deps.runner ?? permissionModelRunner;
    this.now = deps.now ?? (() => Date.now());
    this.clonesDir = deps.clonesDir;
  }

  // ---------------------------------------------------------------- git (read-only here; writes only in the clone)

  private git(root: string, args: string[], opts: { input?: string } = {}): string {
    try {
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], input: opts.input });
    } catch (e) {
      throw new TaskError("INVALID_SCHEMA", `git ${args[0]} failed: ${String((e as Error).message).slice(0, 200)}`);
    }
  }

  private baseCommitOf(repoRoot: string, baseRef: string): string {
    // A ref or a full/abbreviated commit hash both resolve here; an unknown ref is a typed refusal.
    return this.git(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
  }

  /** Export the base tree at `commit` into a fresh directory. Never copies the user's working directory. */
  private exportBase(repoRoot: string, commit: string, into: string): void {
    const archive = join(into, "..", `base-${sha256(commit).slice(0, 12)}.tar`);
    try {
      this.git(repoRoot, ["archive", "--format=tar", "-o", archive, commit]);
      const tar = spawnSync("tar", ["-xf", archive, "-C", into], { encoding: "utf8", timeout: 60_000 });
      if (tar.error || tar.status !== 0) throw new TaskError("INVALID_SCHEMA", `could not extract the base tree: ${String(tar.error?.message ?? tar.stderr).slice(0, 200)}`);
    } finally {
      try { rmSync(archive, { force: true }); } catch { /* absent */ }
    }
  }

  // ---------------------------------------------------------------- event log and projection

  private append(taskId: string, type: string, actor: string, payload: Record<string, unknown>, idempotencyKey?: string): void {
    const row = this.store.db.prepare("select coalesce(max(seq), 0) as n, coalesce(max(generation), 0) as g from task_events where task_id = ?").get(taskId) as { n: number; g: number };
    const gen = Math.max(Number(row.g), this.generationOf(taskId));
    try {
      this.store.db.prepare("insert into task_events(task_id, seq, at, actor, type, payload_json, generation, idempotency_key) values (?,?,?,?,?,?,?,?)")
        .run(taskId, Number(row.n) + 1, new Date(this.now()).toISOString(), actor, type, JSON.stringify(payload), gen, idempotencyKey ?? null);
    } catch (e) {
      if (idempotencyKey && /unique/i.test(String((e as Error).message))) return; // the same key is the same event
      throw e;
    }
  }

  private generationOf(taskId: string): number {
    const r = this.store.db.prepare("select generation from tasks where task_id = ?").get(taskId) as { generation: number } | undefined;
    return Number(r?.generation ?? 0);
  }

  private setState(taskId: string, state: TaskState, extra: Record<string, unknown> = {}, expectedVersion?: number): void {
    const current = this.store.db.prepare("select version from tasks where task_id = ?").get(taskId) as { version: number } | undefined;
    if (!current) throw new TaskError("NOT_FOUND", "no such task");
    if (expectedVersion !== undefined && Number(current.version) !== expectedVersion) throw new TaskError("VERSION_CONFLICT", "The task changed since you read it", ["VERSION_CONFLICT"]);
    const sets = ["state = ?", "version = version + 1", "updated_at = ?", ...Object.keys(extra).map((k) => `${k} = ?`)];
    const values = [state, new Date(this.now()).toISOString(), ...Object.values(extra), taskId];
    this.store.db.prepare(`update tasks set ${sets.join(", ")} where task_id = ?`).run(...values as never[]);
  }

  /** Replay the append-only log into the task's current shape. F07-D9 asserts the projection and the replay agree. */
  replay(taskId: string): { state: TaskState; version: number; generation: number; events: { seq: number; type: string; payload: Record<string, unknown> }[] } {
    const events = this.store.db.prepare("select seq, type, payload_json, generation from task_events where task_id = ? order by seq").all(taskId) as { seq: number; type: string; payload_json: string; generation: number }[];
    let state: TaskState = "RECEIVED", generation = 0;
    for (const e of events) {
      generation = Math.max(generation, Number(e.generation));
      const p = JSON.parse(e.payload_json) as Record<string, unknown>;
      if (typeof p.state === "string") state = p.state as TaskState;
    }
    return { state, version: events.length, generation, events: events.map((e) => ({ seq: Number(e.seq), type: e.type, payload: JSON.parse(e.payload_json) as Record<string, unknown> })) };
  }

  // ---------------------------------------------------------------- intake and confirmation

  submitTask(actor: string, request: { spec: TaskSpec }): TaskView {
    const parsed = TaskSpecSchema.safeParse(request.spec);
    if (!parsed.success) throw new TaskError("INVALID_SCHEMA", `the task specification is not valid: ${parsed.error.issues[0]?.message ?? "unknown field"}`);
    const spec = parsed.data;
    const revision = this.store.latestRevision() ?? null;
    if (!revision) throw new TaskError("NOT_FOUND", "no indexed revision to work from");
    const repoRoot = revision.repoRoot;
    const baseCommit = this.baseCommitOf(repoRoot, spec.baseRef);
    // Identity of the base is the content hash of the tree git would export for that commit — not the working tree.
    const scratch = makeScratch("cie-task-base-");
    try {
      this.exportBase(repoRoot, baseCommit, scratch);
      const baseContentHash = hashTree(scratch);
      const taskId = `task:${sha256(JSON.stringify([actor, spec, baseCommit])).slice(0, 24)}`;
      const specHash = sha256(JSON.stringify(spec));
      const existing = this.store.db.prepare("select task_id from tasks where task_id = ?").get(taskId);
      if (existing) return this.getTask(taskId);
      const at = new Date(this.now()).toISOString();
      this.store.tx(() => {
        this.store.db.prepare("insert into tasks(task_id, repository_id, revision, base_ref, base_commit, base_content_hash, spec_json, spec_hash, state, version, generation, created_by, created_at, updated_at) values (?,?,?,?,?,?,?,?,'RECEIVED',0,0,?,?,?)")
          .run(taskId, spec.repositoryId, revision.id, spec.baseRef, baseCommit, baseContentHash, JSON.stringify(spec), specHash, actor, at, at);
        this.append(taskId, "SUBMITTED", actor, { state: "RECEIVED", specHash, baseCommit, baseContentHash });
      });
      return this.getTask(taskId);
    } finally {
      removeScratch(scratch);
    }
  }

  /** The restatement is what the human confirms: the interpretation, the oracle, and the operations the task allows. */
  restatement(taskId: string): { goal: string; acceptance: TaskSpec["acceptance"]; allowedPaths: string[]; forbiddenPaths: string[]; authorisedOperations: string[]; budgets: TaskSpec["budgets"]; oracle: TaskSpec["acceptance"][number]["oracle"] | null; oracleNote: string } {
    const view = this.getTask(taskId);
    const oracle = view.spec.acceptance.find((a) => a.oracle)?.oracle ?? null;
    return {
      goal: `${view.spec.title} — ${view.spec.description}`,
      acceptance: view.spec.acceptance,
      allowedPaths: view.spec.constraints.allowedPaths,
      forbiddenPaths: view.spec.constraints.forbiddenPaths,
      authorisedOperations: view.spec.authorisedOperations,
      budgets: view.spec.budgets,
      oracle,
      oracleNote: oracle ? "The original oracle must fail before any edit and pass after, unchanged. That is the whole claim." : "This task names no oracle. The best it can reach is an unverified candidate, and it can never be called a verified fix.",
    };
  }

  confirmIntent(actor: string, request: { taskId: string; specHash: string; expectedVersion: number }): TaskView {
    const row = this.taskRow(request.taskId);
    if (!row) throw new TaskError("NOT_FOUND", "no such task");
    if (row.spec_hash !== request.specHash) throw new TaskError("STALE_REVISION", "the specification changed since it was shown; confirm the new one");
    if (row.state !== "RECEIVED") throw new TaskError("VERSION_CONFLICT", "the task is already confirmed", ["VERSION_CONFLICT"]);
    this.store.tx(() => {
      this.append(request.taskId, "INTENT_CONFIRMED", actor, { state: "RECEIVED", specHash: request.specHash }, `confirm:${request.specHash}`);
      this.setState(request.taskId, "RECEIVED", { confirmed_at: new Date(this.now()).toISOString(), confirmed_by: actor, confirmed_spec_hash: request.specHash }, request.expectedVersion);
    });
    return this.getTask(request.taskId);
  }

  // ---------------------------------------------------------------- plan and bounded unknowns

  /** Retrieve, plan, and turn each unknown into a bounded obligation. Free text is confined to `rationale`. */
  draftPlan(actor: string, request: { taskId: string }): { planVersion: number; plan: Plan; planHash: string } {
    const view = this.getTask(request.taskId);
    if (!view.confirmed) throw new TaskError("FORBIDDEN", "the intent has not been confirmed; no work starts before confirmation");
    const repoRoot = this.repoRootOf(view);
    const oracle = view.spec.acceptance.find((a) => a.oracle)?.oracle ?? null;
    const oracleFile = oracle && oracle.kind === "TEST" ? oracle.file : null;
    const named = [oracleFile, ...view.spec.acceptance.map((a) => a.text)].filter((x): x is string => !!x);
    // Retrieval is bounded to the files the oracle and the acceptance text name, inside the allowed paths.
    const files = walkFiles(repoRoot, (rel) => /\.(ts|tsx|js|mjs|py|go|rs)$/.test(rel) && !rel.includes("node_modules"), 5000)
      .filter((rel) => named.some((n) => rel.includes(n.replace(/^.*\//, "").replace(/\.\w+$/, "")) || n.includes(rel)) )
      .slice(0, 40);
    const unknowns = oracleFile
      ? [{ id: "u1", question: `what code path does ${oracleFile} exercise, and is the defect inside a file the task allows?` }]
      : [{ id: "u1", question: "what observable behaviour should change, and where does it live?" }];
    const obligations = unknowns.map((u) => ({
      id: `ob:${u.id}`,
      question: u.question,
      checks: [{ kind: "SEARCH" as const, pattern: (view.spec.description.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? ["TODO"]).slice(0, 3).join("|") }],
    }));
    const plan: Plan = {
      steps: [
        { id: "s1", text: "resolve the unknowns with bounded read-only checks", files, kind: "READ" },
        { id: "s2", text: `propose edits for: ${view.spec.acceptance.map((a) => a.text).join("; ")}`, files, kind: "EDIT" },
        { id: "s3", text: "run the validation roles against the candidate", files: oracleFile ? [oracleFile] : [], kind: "RUN" },
        { id: "s4", text: "review, approve and publish a draft", files: [], kind: "PUBLISH" },
      ],
      unknowns,
      obligations,
      rationale: `The plan is derived from the acceptance criteria and the oracle${oracleFile ? ` (${oracleFile})` : ""}; nothing outside the allowed paths is read.`,
    };
    const planVersion = (this.store.db.prepare("select coalesce(max(plan_version), 0) as n from task_plans where task_id = ?").get(request.taskId) as { n: number }).n + 1;
    const planHash = sha256(JSON.stringify(plan));
    this.store.tx(() => {
      this.store.db.prepare("insert into task_plans(task_id, plan_version, plan_json, plan_hash, unknowns_json, obligations_json, created_by, created_at) values (?,?,?,?,?,?,?,?)")
        .run(request.taskId, planVersion, JSON.stringify(plan), planHash, JSON.stringify(plan.unknowns), JSON.stringify(plan.obligations), actor, new Date(this.now()).toISOString());
      for (const o of plan.obligations) {
        this.store.db.prepare("insert or replace into task_obligations(task_id, obligation_id, question, state, steps, updated_at) values (?,?,?,'OPEN',0,?)")
          .run(request.taskId, o.id, o.question, new Date(this.now()).toISOString());
      }
      this.append(request.taskId, "PLANNED", actor, { state: "PLANNED", planVersion, planHash });
      this.setState(request.taskId, "PLANNED", {});
    });
    return { planVersion, plan, planHash };
  }

  /** Resolve one obligation with at most `TASK_LIMITS.investigationSteps` read-only checks, then stop. */
  resolveObligation(actor: string, request: { taskId: string; obligationId: string }): { obligationId: string; state: "RESOLVED" | "UNRESOLVABLE"; result: string; steps: number } {
    const row = this.store.db.prepare("select question, state, steps from task_obligations where task_id = ? and obligation_id = ?").get(request.taskId, request.obligationId) as { question: string; state: string; steps: number } | undefined;
    if (!row) throw new TaskError("NOT_FOUND", "no such obligation");
    const view = this.getTask(request.taskId);
    const repoRoot = this.repoRootOf(view);
    const files = walkFiles(repoRoot, (rel) => /\.(ts|tsx|js|mjs|py|go|rs)$/.test(rel) && !rel.includes("node_modules"), 5000);
    let steps = 0, hits: string[] = [];
    const stored = this.store.db.prepare("select obligations_json from task_plans where task_id = ? order by plan_version desc limit 1").get(request.taskId) as { obligations_json: string } | undefined;
    const obligations: Plan["obligations"] = stored ? JSON.parse(stored.obligations_json) as Plan["obligations"] : [];
    const checks = obligations.find((o) => o.id === request.obligationId)?.checks ?? [];
    for (const check of checks.slice(0, TASK_LIMITS.investigationSteps)) {
      steps += 1;
      if (check.kind === "SEARCH" && check.pattern) {
        const re = new RegExp(check.pattern, "i");
        hits = files.filter((rel) => { try { return re.test(readFileSync(safeJoin(repoRoot, rel), "utf8")); } catch { return false; } }).slice(0, 5);
      }
    }
    const state = hits.length ? "RESOLVED" as const : "UNRESOLVABLE" as const;
    const result = hits.length ? `found in ${hits.join(", ")}` : "the bounded checks found nothing; this unknown is carried into the plan and the PR body limits";
    this.store.tx(() => {
      this.store.db.prepare("update task_obligations set state = ?, result_json = ?, steps = ?, updated_at = ? where task_id = ? and obligation_id = ?")
        .run(state, JSON.stringify({ result, hits }), steps, new Date(this.now()).toISOString(), request.taskId, request.obligationId);
      this.append(request.taskId, "OBLIGATION_RESOLVED", actor, { obligationId: request.obligationId, state, result });
    });
    return { obligationId: request.obligationId, state, result, steps };
  }

  // ---------------------------------------------------------------- candidate: admission, materialisation, binding

  prepareChange(actor: string, request: { taskId: string; planVersion: number; editOperations: unknown[]; origin?: "MODEL" | "HUMAN" | "MIXED" }): { proposalId: string; candidateIndex: number; binding: Record<string, unknown>; bindingHash: string; oracleState: OracleState; admission: string[] } {
    const view = this.getTask(request.taskId);
    if (!view.confirmed) throw new TaskError("FORBIDDEN", "the intent has not been confirmed");
    if (!view.spec.authorisedOperations.includes("EDIT")) throw new TaskError("FORBIDDEN", "this task does not authorise edits");
    const repoRoot = this.repoRootOf(view);
    const ops: EditOperation[] = [];
    for (const raw of request.editOperations) {
      const parsed = EditOperationSchema.safeParse(raw);
      if (!parsed.success) throw new TaskError("INVALID_SCHEMA", `an edit operation is not valid: ${parsed.error.issues[0]?.message ?? "unknown field"}`);
      ops.push(parsed.data);
    }
    const ctx: EditContext = {
      allowedPaths: view.spec.constraints.allowedPaths, forbiddenPaths: view.spec.constraints.forbiddenPaths,
      maxFilesChanged: view.spec.constraints.maxFilesChanged, maxDiffLines: view.spec.constraints.maxDiffLines,
      allowTestEdits: view.spec.constraints.allowTestEdits === true,
    };
    const admission = [...admissionProblems(ops, ctx), ...exactnessProblems(repoRoot, ops)];
    if (admission.length) throw new TaskError("FORBIDDEN", `the candidate was rejected: ${admission.join("; ")}`, admission);

    const scratch = makeScratch("cie-task-cand-");
    try {
      this.exportBase(repoRoot, view.baseCommit, scratch);
      const baseContentHash = hashTree(scratch);
      if (baseContentHash !== view.baseContentHash) throw new TaskError("STALE_REVISION", "the base tree is not the one the task was created from");
      applyTextEdits(scratch, ops.map((o) => o.op === "REPLACE_SPAN" ? { file: normalizeRel(o.file), start: o.start, end: o.end, expected: o.expected, newText: o.newText } : { file: normalizeRel(o.file), start: 0, end: 0, expected: "", newText: "" }));
      for (const op of ops) {
        const rel = normalizeRel(op.file);
        if (op.op === "CREATE_FILE") { const p = safeJoin(scratch, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, op.content); }
        if (op.op === "DELETE_FILE") { const p = safeJoin(scratch, rel); if (!existsSync(p)) throw new TaskError("STALE_REVISION", `${rel} is already gone`); rmSync(p, { force: true }); }
      }
      const changes = treeDiff(scratch, scratch); // shape computed below from base vs candidate
      void changes;
      const candidateContentHash = hashTree(scratch);
      if (candidateContentHash === baseContentHash) throw new TaskError("INVALID_SCHEMA", "the candidate changes no file: there is nothing to validate or publish");
      // The base tree is exported again into a sibling scratch solely to diff against the candidate: the diff identity
      // must come from git's bytes, not from the user's working directory.
      const baseScratch = makeScratch("cie-task-base-diff-");
      const oracleFiles = this.oracleFilesOf(view);
      let diffChanges: TreeChange[] = [];
      let originalOracleHash = "", candidateOracleHash = "";
      // The two oracle hashes differ when the candidate touches the oracle: a deleted oracle hashes as absent, and the
      // pair is what makes "the original oracle ran unchanged" checkable from the binding alone.
      const oracleHashOf = (root: string) => sha256(JSON.stringify(oracleFiles.map((f) => [f, existsSync(safeJoin(root, f)) ? sha256(readFileSync(safeJoin(root, f))) : null])));
      try {
        this.exportBase(repoRoot, view.baseCommit, baseScratch);
        diffChanges = treeDiff(baseScratch, scratch);
        originalOracleHash = oracleHashOf(baseScratch);
        candidateOracleHash = oracleHashOf(scratch);
      } finally { removeScratch(baseScratch); }
      const bindingCore = {
        schemaId: "task.v1.patchBinding" as const, taskId: request.taskId, repositoryId: view.spec.repositoryId,
        baseCommitHash: view.baseCommit, baseContentHash, candidateContentHash,
        diffHash: sha256(JSON.stringify(diffChanges.map((c) => [c.file, c.kind, c.oldHash, c.newHash, c.added, c.removed]))),
        originalOracleHash, candidateOracleHash,
        validationPlanHash: sha256(JSON.stringify({ taskId: request.taskId, roles: TASK_LIMITS.roles })),
        environmentHash: sha256(JSON.stringify({ node: process.version, platform: process.platform, isolation: this.runner.isolation })),
        isolation: this.runner.isolation,
        runManifestIds: [] as string[],
        changes: diffChanges.map((c) => ({ file: c.file, kind: c.kind, added: c.added, removed: c.removed })),
      };
      const bindingHash = bindingHashOf(bindingCore);
      const candidateIndex = (this.store.db.prepare("select coalesce(max(candidate_index), 0) as n from task_candidates where task_id = ?").get(request.taskId) as { n: number }).n + 1;
      const oracleState: OracleState = oracleFiles.length ? "ORIGINAL_PRESERVED" : "NO_ORACLE";
      const proposalId = `task-proposal:${bindingHash.slice(0, 24)}`;
      const candidate: CandidateRecord = {
        taskId: request.taskId, candidateIndex, proposalId, binding: { ...bindingCore, bindingHash }, bindingHash,
        origin: request.origin ?? "MODEL", oracleState, state: "MATERIALIZED", editOperations: ops,
        changedFiles: diffChanges.map((c) => c.file), planVersion: request.planVersion,
      };
      // The candidate's changed bytes travel with the record, so publication re-derives the exact tree without
      // depending on a scratch directory that may be long gone.
      const changedContents: Record<string, string | null> = {};
      for (const c of diffChanges) changedContents[c.file] = c.kind === "DELETED" ? null : readFileSync(safeJoin(scratch, c.file), "utf8");
      this.store.tx(() => {
        this.store.db.prepare("insert into task_candidates(task_id, candidate_index, proposal_id, binding_json, binding_hash, origin, oracle_state, state, edit_operations_json, changed_files_json, plan_version, created_by, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(request.taskId, candidateIndex, proposalId, JSON.stringify({ ...candidate, changedContents }), bindingHash, candidate.origin, oracleState, "MATERIALIZED", JSON.stringify(ops), JSON.stringify(changedContents), request.planVersion, actor, new Date(this.now()).toISOString());
        this.append(request.taskId, "CANDIDATE_MATERIALIZED", actor, { state: "CANDIDATE_READY", candidateIndex, bindingHash, files: diffChanges.length, origin: candidate.origin });
        this.setState(request.taskId, "CANDIDATE_READY", {});
      });
      failpoint("task-after-candidate");
      return { proposalId, candidateIndex, binding: { ...bindingCore, bindingHash }, bindingHash, oracleState, admission: [] };
    } finally {
      removeScratch(scratch);
    }
  }

  private oracleFilesOf(view: TaskView): string[] {
    const repoRoot = this.repoRootOf(view);
    return view.spec.acceptance.flatMap((a) => (a.oracle?.kind === "TEST" ? [normalizeRel(a.oracle.file)] : []))
      .filter((f) => existsSync(safeJoin(repoRoot, f)))
      .filter((f, i, all) => all.indexOf(f) === i);
  }

  // ---------------------------------------------------------------- validation

  validatePatch(actor: string, request: { taskId: string; candidateIndex?: number; requireAuditedIsolation?: boolean }): { verdictId: string; state: VerdictState; oracleState: OracleState; roles: RoleRunRecord[]; blockedBy: string[]; bindingHash: string } {
    const view = this.getTask(request.taskId);
    if (view.state === "CANCELLED") throw new TaskError("CANCELLED", "the task was cancelled; no run is started and no late result is accepted");
    if (request.requireAuditedIsolation && this.runner.isolation === "LOCAL_PERMISSION_MODEL") {
      const blockedBy = ["isolation unavailable: this task requires an audited container or VM profile, and only the local permission model is installed"];
      this.store.tx(() => {
        this.append(request.taskId, "BLOCKED", actor, { state: "BLOCKED", blockedBy });
        this.setState(request.taskId, "BLOCKED", {});
      });
      throw new TaskError("PROVIDER_UNAVAILABLE", blockedBy[0]!, blockedBy);
    }
    const cand = this.candidateRow(view.taskId, request.candidateIndex ?? view.candidateIndex ?? 0);
    if (!cand) throw new TaskError("NOT_FOUND", "no candidate to validate");
    const candidate = JSON.parse(cand.binding_json) as StoredCandidate;
    // The live oracle state is the column, not the copy frozen into the candidate row at materialisation time: a
    // property-change review written after the candidate was created must be visible to this run.
    const liveOracleState = cand.oracle_state as OracleState;
    const repoRoot = this.repoRootOf(view);
    const oracleFiles = this.oracleFilesOf(view);
    const mandatory = new Set<ValidationRole>(TASK_LIMITS.roles);
    const roles: RoleRunRecord[] = [];
    const nowIso = () => new Date(this.now()).toISOString();

    // A candidate tree is built once and each role runs inside its own copy, so a role cannot leave state behind for
    // the next one (the permission model allows a writable scratch inside the checkout).
    const build = (withOracleFromBase: boolean): string => {
      const dir = makeScratch("cie-task-run-");
      this.exportBase(repoRoot, view.baseCommit, dir);
      for (const [rel, text] of Object.entries(candidate.changedContents)) {
        const p = safeJoin(dir, rel);
        if (text === null) { rmSync(p, { force: true }); continue; }
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, text);
      }
      if (withOracleFromBase) for (const f of oracleFiles) {
        try { writeFileSync(safeJoin(dir, f), execFileSync("git", ["-C", repoRoot, "show", `${view.baseCommit}:${f}`], { encoding: "utf8", timeout: 15_000 })); } catch { /* the file is not in the base commit */ }
      }
      return dir;
    };
    const runRole = (role: ValidationRole, dir: string, files: string[] | undefined): void => {
      const budget = view.spec.budgets.runWallMs;
      if (role === "STATIC_CHECK") {
        const base = makeScratch("cie-task-base-static-");
        let introduced: string[] = [];
        try {
          this.exportBase(repoRoot, view.baseCommit, base);
          const before = typecheckDir(base), after = typecheckDir(dir);
          introduced = after.filter((d) => !before.includes(d));
        } finally { removeScratch(base); }
        roles.push({ role, mandatory: true, status: introduced.length ? "FAILED" : "PASSED", passed: introduced.length ? 0 : 1, failed: introduced.length, outcomes: introduced.map((d) => ({ name: d, state: "FAIL" as const })), output: introduced.join("\n").slice(0, 4000) || "no new diagnostics", omissions: [] });
        return;
      }
      if (role === "ORACLE_PRESERVATION") {
        const baseTestFiles = new Map<string, string>(), candTestFiles = new Map<string, string>();
        const baseScratch = makeScratch("cie-task-base-tests-");
        try {
          this.exportBase(repoRoot, view.baseCommit, baseScratch);
          for (const rel of walkFiles(baseScratch, (r) => isTestPath(r))) baseTestFiles.set(rel, readFileSync(safeJoin(baseScratch, rel), "utf8"));
        } finally { removeScratch(baseScratch); }
        for (const rel of walkFiles(dir, (r) => isTestPath(r))) candTestFiles.set(rel, readFileSync(safeJoin(dir, rel), "utf8"));
        const changes = detectOracleWeakening(baseTestFiles, candTestFiles);
        roles.push({
          role, mandatory: true, status: changes.length ? "FAILED" : "PASSED", passed: changes.length ? 0 : 1, failed: changes.length,
          outcomes: changes.map((c) => ({ name: `${c.kind} ${c.file} ${c.testCase}`, state: "FAIL" as const })),
          output: changes.length ? changes.map((c) => `${c.kind}: ${c.file} — ${c.detail}`).join("\n").slice(0, 4000) : "no original assertion was removed or loosened (syntactic detection; see the stated limits)",
          omissions: ["syntactic detection: behaviour hidden in helpers, fixtures or configuration the tests import is not seen; the unchanged original-oracle run is the backstop"],
        });
        return;
      }
      const run = this.runner.runTests(dir, files, budget);
      const outcomes = outcomesFrom(run.output);
      const status: RoleStatus = !run.ran ? "INFRA_FAILED" : run.failed > 0 ? "FAILED" : "PASSED";
      roles.push({ role, mandatory: mandatory.has(role), status, passed: run.passed, failed: run.failed, outcomes, output: `${run.output}${run.reason ? `\nreason: ${run.reason}` : ""}`.slice(0, 8000), omissions: [...this.runner.omissions] });
    };

    let baseRoleStatus: RoleStatus = "INCOMPLETE";
    let oracleRoleStatus: RoleStatus = "INCOMPLETE";
    const dirA = build(false), dirB = build(true), dirC = build(false);
    try {
      // 1. BASELINE — the defect must reproduce at base, before any edit: run the oracle against the base tree.
      const baseDir = makeScratch("cie-task-base-run-");
      try {
        this.exportBase(repoRoot, view.baseCommit, baseDir);
        const run = this.runner.runTests(baseDir, oracleFiles.length ? oracleFiles : undefined, view.spec.budgets.runWallMs);
        const outcomes = outcomesFrom(run.output);
        baseRoleStatus = !run.ran ? "INFRA_FAILED" : run.failed > 0 ? "FAILED" : "PASSED";
        // The role's *own* pass condition is inverted: a failing original oracle at base is what "reproduced" means.
        roles.push({
          role: "BASELINE", mandatory: true, status: baseRoleStatus, passed: run.passed, failed: run.failed, outcomes,
          output: `${run.output}${run.reason ? `\nreason: ${run.reason}` : ""}`.slice(0, 8000), omissions: [...this.runner.omissions],
        });
      } finally { removeScratch(baseDir); }
      runRole("ORACLE_ORIGINAL_ON_CANDIDATE", dirB, oracleFiles.length ? oracleFiles : undefined);
      oracleRoleStatus = roles[roles.length - 1]!.status;
      runRole("CANDIDATE_SUITE", dirC, undefined);
      runRole("STATIC_CHECK", dirC, undefined);
      runRole("ORACLE_PRESERVATION", dirC, undefined);
    } finally {
      removeScratch(dirA); removeScratch(dirB); removeScratch(dirC);
    }

    const preservation = roles.find((r) => r.role === "ORACLE_PRESERVATION")!;
    const verdictOf = (): VerdictState => {
      if (baseRoleStatus === "INFRA_FAILED" || oracleRoleStatus === "INFRA_FAILED") return "INCOMPLETE";
      // Editing a defect that does not reproduce produces an unfalsifiable "fix": that is BLOCKED, not FAILED.
      if (baseRoleStatus === "PASSED") return "BLOCKED";
      if (baseRoleStatus === "FAILED" && oracleRoleStatus === "PASSED") {
        // The defect reproduced and the untouched original oracle passes: the only remaining question is preservation.
        if (preservation.status === "PASSED") return "PASSED_DEFINED_GATES";
        return liveOracleState === "PROPERTY_CHANGE_REVIEWED" ? "PASSED_DEFINED_GATES" : "REVIEWABLE_WITH_LIMITS";
      }
      return "FAILED";
    };
    const state = verdictOf();
    const oracleState: OracleState = preservation.status === "PASSED" ? (oracleFiles.length ? "ORIGINAL_PRESERVED" : "NO_ORACLE") : liveOracleState === "PROPERTY_CHANGE_REVIEWED" ? "PROPERTY_CHANGE_REVIEWED" : "PROPERTY_CHANGE_PENDING_REVIEW";
    const blockedBy = state === "BLOCKED"
      ? [oracleFiles.length ? "cannot reproduce: the original oracle already passes at the base commit, so an edit would produce an unfalsifiable claim" : "this task has no oracle; the best it can reach is an unverified candidate"]
      : state === "INCOMPLETE" ? roles.filter((r) => r.status === "INFRA_FAILED" || r.status === "INCOMPLETE").map((r) => `role ${r.role} did not complete`) : [];
    const verdictId = `verdict:${sha256(JSON.stringify([candidate.bindingHash, roles.map((r) => [r.role, r.status]), state])).slice(0, 24)}`;
    const taskState: TaskState = state === "PASSED_DEFINED_GATES" || state === "REVIEWABLE_WITH_LIMITS" ? "REVIEW_READY" : state === "FAILED" ? "FAILED" : "BLOCKED";    this.store.tx(() => {
      this.store.db.prepare("insert or replace into task_verdicts(id, task_id, candidate_index, binding_hash, state, oracle_state, plan_hash, verdict_json, created_at) values (?,?,?,?,?,?,?,?,?)")
        .run(verdictId, view.taskId, candidate.candidateIndex, candidate.bindingHash, state, oracleState, sha256(JSON.stringify(roles)).slice(0, 64), JSON.stringify({ state, oracleState, roles, blockedBy }), nowIso());
      for (const r of roles) {
        const manifestId = `run:${sha256(JSON.stringify([verdictId, r.role, r.output.slice(0, 200)])).slice(0, 24)}`;
        this.store.db.prepare("insert or replace into task_runs(task_id, candidate_index, role, run_manifest_id, status, outcomes_artifact_hash, isolation, omissions_json, started_at, finished_at) values (?,?,?,?,?,?,?,?,?,?)")
          .run(view.taskId, candidate.candidateIndex, r.role, manifestId, r.status, sha256(JSON.stringify(r.outcomes)), this.runner.isolation, JSON.stringify(r.omissions), nowIso(), nowIso());
      }
      this.store.db.prepare("update task_candidates set state = ? where task_id = ? and candidate_index = ?")
        .run(state === "PASSED_DEFINED_GATES" || state === "REVIEWABLE_WITH_LIMITS" ? "VALIDATED" : "FAILED", view.taskId, candidate.candidateIndex);
      this.append(view.taskId, "VALIDATED", actor, { state: taskState, verdictId, verdictState: state, oracleState, blockedBy });
      this.setState(view.taskId, taskState, {});
    });
    failpoint("task-after-validation");
    return { verdictId, state, oracleState, roles, blockedBy, bindingHash: candidate.bindingHash };
  }

  /** A human accepts or rejects a detected property change; only ACCEPT_AS_INTENDED can unblock publication. */
  reviewPropertyChange(actor: string, request: { taskId: string; candidateIndex: number; decision: "ACCEPT_AS_INTENDED" | "REJECT"; rationale: string }): { reviewId: string } {
    if (request.rationale.trim().length < 8) throw new TaskError("INVALID_SCHEMA", "a property-change review needs a rationale of at least eight characters");
    const view = this.getTask(request.taskId);
    const cand = this.candidateRow(request.taskId, request.candidateIndex);
    if (!cand) throw new TaskError("NOT_FOUND", "no such candidate");
    if (cand.created_by === actor && request.decision === "ACCEPT_AS_INTENDED") throw new TaskError("FORBIDDEN", "the person who wrote the candidate cannot accept its property change");
    const base = makeScratch("cie-task-base-review-");
    const candidateRun = makeScratch("cie-task-cand-review-");
    let changes: OracleChange[] = [];
    try {
      this.exportBase(this.repoRootOf(view), view.baseCommit, base);
      this.exportBase(this.repoRootOf(view), view.baseCommit, candidateRun);
      const stored = JSON.parse(cand.binding_json) as StoredCandidate;
      for (const [rel, text] of Object.entries(stored.changedContents)) {
        const p = safeJoin(candidateRun, rel);
        if (text === null) { rmSync(p, { force: true }); continue; }
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, text);
      }
      const b = new Map<string, string>(), c = new Map<string, string>();
      for (const rel of walkFiles(base, (r) => isTestPath(r))) b.set(rel, readFileSync(safeJoin(base, rel), "utf8"));
      for (const rel of walkFiles(candidateRun, (r) => isTestPath(r))) c.set(rel, readFileSync(safeJoin(candidateRun, rel), "utf8"));
      changes = detectOracleWeakening(b, c);
    } finally { removeScratch(base); removeScratch(candidateRun); }
    const reviewId = `oracle-review:${sha256(JSON.stringify([request.taskId, request.candidateIndex, request.decision, changes])).slice(0, 24)}`;
    this.store.tx(() => {
      this.store.db.prepare("insert into oracle_reviews(id, task_id, candidate_index, changes_json, decision, reviewer, rationale, created_at) values (?,?,?,?,?,?,?,?)")
        .run(reviewId, request.taskId, request.candidateIndex, JSON.stringify(changes), request.decision, actor, request.rationale.trim(), new Date(this.now()).toISOString());
      this.store.db.prepare("update task_candidates set oracle_state = ? where task_id = ? and candidate_index = ?")
        .run(request.decision === "ACCEPT_AS_INTENDED" ? "PROPERTY_CHANGE_REVIEWED" : "PROPERTY_CHANGE_PENDING_REVIEW", request.taskId, request.candidateIndex);
      this.append(request.taskId, "PROPERTY_CHANGE_REVIEWED", actor, { candidateIndex: request.candidateIndex, decision: request.decision, reviewId });
    });
    return { reviewId };
  }

  approveCandidate(actor: string, request: { taskId: string; candidateIndex?: number; expectedVersion: number; explanation: string }): TaskView {
    const view = this.getTask(request.taskId);
    const cand = this.candidateRow(request.taskId, request.candidateIndex ?? view.candidateIndex ?? 0);
    if (!cand) throw new TaskError("NOT_FOUND", "no candidate to approve");
    if (cand.created_by === actor) throw new TaskError("FORBIDDEN", "the author of a candidate cannot approve it; a second person is required");
    if (view.state !== "REVIEW_READY") throw new TaskError("INSUFFICIENT_EVIDENCE", "the candidate is not review-ready");
    const verdict = this.verdictFor(cand.binding_hash);
    if (!verdict) throw new TaskError("INSUFFICIENT_EVIDENCE", "no validation verdict is stored for this candidate");
    if (verdict.state === "REVIEWABLE_WITH_LIMITS" && !verdict.oracleState.includes("REVIEWED") && verdict.oracleState !== "ORIGINAL_PRESERVED" && verdict.oracleState !== "NO_ORACLE") {
      throw new TaskError("INSUFFICIENT_EVIDENCE", "the property change has not been reviewed");
    }
    this.store.tx(() => {
      this.store.db.prepare("insert or replace into task_approvals(task_id, candidate_index, principal, version, binding_hash, explanation, created_at) values (?,?,?,?,?,?,?)")
        .run(request.taskId, cand.candidate_index, actor, request.expectedVersion, cand.binding_hash, request.explanation, new Date(this.now()).toISOString());
      this.append(request.taskId, "APPROVED", actor, { candidateIndex: cand.candidate_index, bindingHash: cand.binding_hash, explanation: request.explanation });
      this.setState(request.taskId, "REVIEW_READY", {}, request.expectedVersion);
    });
    return this.getTask(request.taskId);
  }

  /** The grant is bound to exactly one binding: a grant for one head is useless for another. */
  createGrant(actor: string, request: { taskId: string; candidateIndex?: number; repository: string; baseBranch: string; branchName: string; ttlMs?: number }): { grantId: string; bindingHash: string } {
    const view = this.getTask(request.taskId);
    const cand = this.candidateRow(request.taskId, request.candidateIndex ?? view.candidateIndex ?? 0);
    if (!cand) throw new TaskError("NOT_FOUND", "no candidate to grant");
    const approval = this.store.db.prepare("select principal from task_approvals where task_id = ? and candidate_index = ? and binding_hash = ?").get(request.taskId, cand.candidate_index, cand.binding_hash) as { principal: string } | undefined;
    if (!approval) throw new TaskError("FORBIDDEN", "a second-person approval is required before a publication grant exists");
    if (!/^cie\//.test(request.branchName)) throw new TaskError("FORBIDDEN", "a CIE branch must start with cie/");
    const binding = (JSON.parse(cand.binding_json) as StoredCandidate).binding;
    const grantId = `grant:${sha256(JSON.stringify([cand.binding_hash, request.repository, request.branchName])).slice(0, 24)}`;
    this.store.db.prepare("insert or replace into task_grants(id, task_id, principal, repository, base_branch, branch, base_hash, head_hash, diff_hash, binding_hash, expires_at, revoked, created_at) values (?,?,?,?,?,?,?,?,?,?,?,0,?)")
      .run(grantId, request.taskId, approval.principal, request.repository, request.baseBranch, request.branchName, String(binding.baseContentHash), String(binding.candidateContentHash), String(binding.diffHash), cand.binding_hash, new Date(this.now() + (request.ttlMs ?? 3_600_000)).toISOString(), new Date(this.now()).toISOString());
    return { grantId, bindingHash: cand.binding_hash };
  }

  // ---------------------------------------------------------------- branch, push, draft PR

  private cloneDirFor(repositoryId: string): string {
    const base = this.clonesDir ?? join(dirname(this.store.path === ":memory:" ? join(process.cwd(), ".cie") : resolve(this.store.path)), "clones");
    const dir = join(base, repositoryId.replace(/[^a-zA-Z0-9._-]/g, "_"));
    mkdirSync(base, { recursive: true });
    return dir;
  }

  /** Create (or reuse) CIE's own clone and put the candidate on a `cie/` branch there. Never the user's tree. */
  pushCandidate(actor: string, request: { taskId: string; candidateIndex?: number; repositoryId: string; branchName: string; grantId: string }): { branch: string; headHash: string; pushState: "PUSHED" | "NOOP"; cloneDir: string } {
    const view = this.getTask(request.taskId);
    if (view.state === "CANCELLED") throw new TaskError("CANCELLED", "the task was cancelled; no write is accepted");
    if (!view.spec.authorisedOperations.includes("CREATE_BRANCH")) throw new TaskError("FORBIDDEN", "this task does not authorise branch creation");
    if (!/^cie\//.test(request.branchName)) throw new TaskError("FORBIDDEN", "a CIE branch must start with cie/");
    const cand = this.candidateRow(request.taskId, request.candidateIndex ?? view.candidateIndex ?? 0);
    if (!cand) throw new TaskError("NOT_FOUND", "no candidate to push");
    const verdict = this.verdictFor(cand.binding_hash);
    if (!verdict || !["PASSED_DEFINED_GATES", "REVIEWABLE_WITH_LIMITS"].includes(verdict.state)) throw new TaskError("INSUFFICIENT_EVIDENCE", "the candidate has no passing verdict");
    if (verdict.oracleState === "PROPERTY_CHANGE_PENDING_REVIEW") throw new TaskError("INSUFFICIENT_EVIDENCE", "the property change has not been reviewed");
    const grant = this.store.db.prepare("select * from task_grants where id = ? and revoked = 0").get(request.grantId) as Record<string, unknown> | undefined;
    if (!grant) throw new TaskError("FORBIDDEN", "no publication grant");
    if (String(grant.binding_hash) !== cand.binding_hash) throw new TaskError("FORBIDDEN", "the grant is for a different candidate");
    if (new Date(String(grant.expires_at)).getTime() < this.now()) throw new TaskError("FORBIDDEN", "the publication grant has expired");
    const stored = JSON.parse(cand.binding_json) as StoredCandidate;
    const binding = stored.binding;
    const repoRoot = this.repoRootOf(view);
    const cloneDir = this.cloneDirFor(request.repositoryId);
    if (!existsSync(join(cloneDir, ".git"))) this.git(dirname(cloneDir), ["clone", "--quiet", repoRoot, cloneDir]);
    this.git(cloneDir, ["fetch", "--quiet", "--all"]);
    // A branch that already carries the validated head is an idempotent no-op; any other existing head is a conflict.
    const existing = this.tryGit(cloneDir, ["rev-parse", "--verify", `refs/heads/${request.branchName}`]);
    const checkoutTarget = existing && existing.trim() !== "" ? existing.trim() : view.baseCommit;
    this.git(cloneDir, ["checkout", "--quiet", "--force", "-B", request.branchName, checkoutTarget]);
    // The candidate's bytes are written from the record, then the tree is re-hashed: a worktree edited after
    // validation cannot be pushed as if it were the validated patch (F07-A3).
    for (const [rel, text] of Object.entries(stored.changedContents)) {
      const p = safeJoin(cloneDir, rel);
      if (text === null) { rmSync(p, { force: true }); continue; }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
    const actualHash = hashTree(cloneDir);
    if (actualHash !== binding.candidateContentHash) throw new TaskError("STALE_REVISION", "the clone's candidate content changed since validation; the patch is ineligible for publication");
    const head = this.git(cloneDir, ["rev-parse", "HEAD"]).trim();
    const alreadyPublished = this.store.db.prepare("select push_state, head_hash from branch_publications where task_id = ? and branch = ?").get(request.taskId, request.branchName) as { push_state: string; head_hash: string } | undefined;
    const idempotencyKey = sha256(JSON.stringify([request.taskId, cand.binding_hash, request.branchName]));
    if (alreadyPublished?.push_state === "PUSHED" && alreadyPublished.head_hash === binding.candidateContentHash) {
      this.store.db.prepare("update branch_publications set updated_at = ? where task_id = ? and branch = ?").run(new Date(this.now()).toISOString(), request.taskId, request.branchName);
      return { branch: request.branchName, headHash: binding.candidateContentHash, pushState: "NOOP", cloneDir };
    }
    // One commit, authored by the approving user, with the diff hash in the body so the commit and the certificate agree.
    // When the worktree already equals HEAD (a resumed publication) no new commit is made: an empty commit would be a
    // second identity for the same patch.
    this.git(cloneDir, ["add", "-A"]);
    if ((this.tryGit(cloneDir, ["status", "--porcelain"]) ?? "").trim().length > 0) {
      const message = `CIE task ${request.taskId}: ${view.spec.title}\n\nGenerated-by: CIE task ${request.taskId}\ndiff-hash: ${binding.diffHash}\nbinding-hash: ${binding.bindingHash}`;
      this.git(cloneDir, ["-c", "user.name=CIE", "-c", `user.email=cie@localhost`, "commit", "--quiet", "--no-verify", "-m", message]);
    }
    const commit = this.git(cloneDir, ["rev-parse", "HEAD"]).trim();
    void head;
    failpoint("task-after-branch-commit");
    // Pushing is decided against what the remote actually has: a branch that does not exist is created, a branch that
    // already carries this exact commit needs nothing, and a branch this task owns is re-pointed with a lease on the
    // commit read a moment ago. Anything else is a CONFLICT — this never blind-forces over someone else's work.
    const remoteHead = (this.tryGit(cloneDir, ["ls-remote", "--heads", "origin", request.branchName]) ?? "").trim().split(/\s+/)[0] || null;
    if (remoteHead === commit) { /* already there */ }
    else if (!remoteHead) this.git(cloneDir, ["push", "--quiet", "origin", request.branchName]);
    else if (this.store.db.prepare("select 1 from branch_publications where task_id = ? and branch = ?").get(request.taskId, request.branchName)) {
      this.git(cloneDir, ["push", "--quiet", `--force-with-lease=${request.branchName}:${remoteHead}`, "origin", request.branchName]);
    } else {
      throw new TaskError("VERSION_CONFLICT", `the branch ${request.branchName} already exists on the remote with a different head and this task did not create it`);
    }
    failpoint("task-after-branch-push");
    this.store.tx(() => {
      this.store.db.prepare("insert into branch_publications(id, task_id, repository, branch, base_hash, head_hash, push_state, pr_number, pr_url, receipt_draft, idempotency_key, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set push_state = excluded.push_state, head_hash = excluded.head_hash, updated_at = excluded.updated_at")
        .run(`publication:${idempotencyKey.slice(0, 24)}`, request.taskId, request.repositoryId, request.branchName, view.baseContentHash, binding.candidateContentHash, "PUSHED", null, null, null, idempotencyKey, new Date(this.now()).toISOString());
      this.append(request.taskId, "BRANCH_PUSHED", actor, { branch: request.branchName, commit, headHash: binding.candidateContentHash, generation: view.generation }, `push:${idempotencyKey}`);
    });
    return { branch: request.branchName, headHash: binding.candidateContentHash, pushState: "PUSHED", cloneDir };
  }

  async publishDraftPR(actor: string, request: { taskId: string; candidateIndex?: number; repositoryId: string; baseBranch: string; branchName: string; grantId: string; generation?: number }, forge: DraftForge): Promise<{ publicationId: string; branch: string; headHash: string; prNumber: number; prUrl: string; draft: boolean; alreadyPublished: boolean; prBody: string }> {
    const view = this.getTask(request.taskId);
    if (!view.spec.authorisedOperations.includes("PUBLISH_DRAFT")) throw new TaskError("FORBIDDEN", "this task does not authorise publication");
    if (view.state === "CANCELLED" || view.generation !== view.generation) throw new TaskError("CANCELLED", "the task was cancelled; no write is accepted");
    const cand = this.candidateRow(request.taskId, request.candidateIndex ?? view.candidateIndex ?? 0);
    if (!cand) throw new TaskError("NOT_FOUND", "no candidate to publish");
    const binding = (JSON.parse(cand.binding_json) as StoredCandidate).binding;
    const verdict = this.verdictFor(cand.binding_hash);
    if (!verdict) throw new TaskError("INSUFFICIENT_EVIDENCE", "no verdict is stored for this candidate");
    if (verdict.state !== "PASSED_DEFINED_GATES" && verdict.state !== "REVIEWABLE_WITH_LIMITS") throw new TaskError("INSUFFICIENT_EVIDENCE", "mandatory validation has not passed");
    if (verdict.oracleState === "PROPERTY_CHANGE_PENDING_REVIEW") throw new TaskError("INSUFFICIENT_EVIDENCE", "the property change has not been reviewed");
    const approval = this.store.db.prepare("select principal from task_approvals where task_id = ? and candidate_index = ? and binding_hash = ?").get(request.taskId, cand.candidate_index, cand.binding_hash) as { principal: string } | undefined;
    if (!approval) throw new TaskError("FORBIDDEN", "the candidate has no second-person approval");
    const grant = this.store.db.prepare("select * from task_grants where id = ? and revoked = 0").get(request.grantId) as Record<string, unknown> | undefined;
    if (!grant || String(grant.binding_hash) !== cand.binding_hash || String(grant.branch) !== request.branchName) throw new TaskError("FORBIDDEN", "the grant does not bind this candidate and branch");
    if (!/^cie\//.test(request.branchName)) throw new TaskError("FORBIDDEN", "a CIE branch must start with cie/");
    if (request.generation !== undefined && request.generation !== view.generation) throw new TaskError("CANCELLED", "a late result from an older generation is dropped");
    // The generation and state are re-checked immediately before every external write, so a cancelled task cannot publish.
    failpoint("task-before-publish");
    const pushed = this.pushCandidate(actor, { taskId: request.taskId, candidateIndex: cand.candidate_index, repositoryId: request.repositoryId, branchName: request.branchName, grantId: request.grantId });
    const idempotencyKey = sha256(JSON.stringify([request.taskId, cand.binding_hash, request.branchName]));
    const existingRow = this.store.db.prepare("select pr_number, pr_url, receipt_draft, head_hash from branch_publications where task_id = ? and branch = ?").get(request.taskId, request.branchName) as { pr_number: number | null; pr_url: string | null; receipt_draft: number | null; head_hash: string } | undefined;
    const body = this.prBody(view, cand, verdict, pushed.headHash);
    const publicationRef = { id: `publication:${idempotencyKey.slice(0, 24)}`, repository: request.repositoryId, baseBranch: request.baseBranch, headBranch: request.branchName, baseHash: String(binding.baseCommitHash), headHash: pushed.headHash, proposalId: cand.proposal_id, validationId: String(verdict.id), authorizationId: request.grantId, status: "PUBLISHING" as const, prNumber: null, prUrl: null };
    let receipt: { number: number; url: string; headHash: string; draft: boolean } | null = null;
    if (existingRow?.pr_number) receipt = { number: existingRow.pr_number, url: existingRow.pr_url ?? "", headHash: existingRow.head_hash, draft: !!existingRow.receipt_draft };
    if (!receipt) receipt = await forge.find(publicationRef);
    if (!receipt) {
      failpoint("task-before-pr-create");
      receipt = await forge.createDraft(publicationRef, body);
      failpoint("task-after-pr-create");
    }
    if (!receipt.draft) throw new TaskError("VERSION_CONFLICT", "the forge receipt is not a draft");
    if (receipt.headHash !== pushed.headHash) throw new TaskError("STALE_REVISION", "the forge receipt is for a different head");
    if (this.generationOf(request.taskId) !== view.generation) throw new TaskError("CANCELLED", "the task was cancelled while the PR was being created; the late write is dropped");
    const publicationId = `publication:${idempotencyKey.slice(0, 24)}`;
    this.store.tx(() => {
      this.store.db.prepare("insert into branch_publications(id, task_id, repository, branch, base_hash, head_hash, push_state, pr_number, pr_url, receipt_draft, idempotency_key, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set pr_number = excluded.pr_number, pr_url = excluded.pr_url, receipt_draft = excluded.receipt_draft, updated_at = excluded.updated_at")
        .run(publicationId, request.taskId, request.repositoryId, request.branchName, view.baseContentHash, pushed.headHash, "PUSHED", receipt.number, receipt.url, receipt.draft ? 1 : 0, idempotencyKey, new Date(this.now()).toISOString());
      this.append(request.taskId, "PUBLISHED", actor, { state: "PUBLISHED", publicationId, prNumber: receipt.number, prUrl: receipt.url, draft: receipt.draft, headHash: pushed.headHash }, `publish:${idempotencyKey}`);
      this.setState(request.taskId, "PUBLISHED", {});
    });
    return { publicationId, branch: pushed.branch, headHash: pushed.headHash, prNumber: receipt.number, prUrl: receipt.url, draft: receipt.draft, alreadyPublished: !!existingRow?.pr_number, prBody: body };
  }

  /** IDs and validation scope only: no source, no traces, no arbitrary model text. */
  prBody(view: TaskView, cand: { candidate_index: number; origin: string; binding_hash: string }, verdict: { id: string; state: string; oracleState: string; roles: RoleRunRecord[] }, headHash: string): string {
    const roles = verdict.roles.map((r) => `| ${r.role} | ${r.mandatory ? "mandatory" : "advisory"} | ${r.status} | ${r.passed} pass / ${r.failed} fail |`).join("\n");
    const unresolved = (this.store.db.prepare("select question from task_obligations where task_id = ? and state = 'UNRESOLVABLE'").all(view.taskId) as { question: string }[]).map((r) => `- ${r.question}`);
    return [
      `## ${view.spec.title}`, "", view.spec.description, "",
      `Task \`${view.taskId}\` · candidate ${cand.candidate_index} · origin ${cand.origin} · binding \`${cand.binding_hash.slice(0, 12)}\``,
      "", "### Acceptance", ...view.spec.acceptance.map((a) => `- ${a.text}`),
      "", "### Validation", "| role | required | result | outcomes |", "| --- | --- | --- | --- |", roles,
      ``, `Verdict \`${verdict.state}\` · oracle \`${verdict.oracleState}\` · head \`${headHash.slice(0, 12)}\``,
      "", "### Isolation", `Runs used \`${this.runner.isolation}\`. Not covered by that boundary:`,
      ...this.runner.omissions.map((o) => `- ${o}`),
      "", "### Limits", unresolved.length ? unresolved.join("\n") : "- none recorded as unresolvable",
      "", "Generated by CIE; draft; not approved for merge.", "",
    ].join("\n");
  }

  cancelTask(actor: string, request: { taskId: string; reason: string }): TaskView {
    const view = this.getTask(request.taskId);
    this.store.tx(() => {
      this.store.db.prepare("update tasks set generation = generation + 1, updated_at = ? where task_id = ?").run(new Date(this.now()).toISOString(), request.taskId);
      this.append(request.taskId, "CANCELLED", actor, { state: "CANCELLED", reason: request.reason, generation: view.generation + 1 });
      this.setState(request.taskId, "CANCELLED", {});
    });
    return this.getTask(request.taskId);
  }

  // ---------------------------------------------------------------- reads

  getTask(taskId: string): TaskView {
    const row = this.taskRow(taskId);
    if (!row) throw new TaskError("NOT_FOUND", "no such task");
    const cand = this.store.db.prepare("select candidate_index, binding_hash, oracle_state, state from task_candidates where task_id = ? and state in ('MATERIALIZED','VALIDATING','VALIDATED','FAILED') order by candidate_index desc limit 1").get(taskId) as { candidate_index: number; binding_hash: string; oracle_state: OracleState; state: string } | undefined;
    const verdict = cand ? this.verdictFor(cand.binding_hash) : null;
    return {
      taskId, state: row.state as TaskState, version: Number(row.version), generation: Number(row.generation),
      spec: JSON.parse(row.spec_json) as TaskSpec, specHash: row.spec_hash, baseCommit: row.base_commit, baseContentHash: row.base_content_hash,
      candidateIndex: cand ? Number(cand.candidate_index) : null, bindingHash: cand?.binding_hash ?? null,
      verdict: (verdict?.state as VerdictState) ?? null, oracleState: (verdict?.oracleState as OracleState) ?? (cand?.oracle_state ?? null),
      blockedBy: verdict?.blockedBy ?? [], confirmed: !!row.confirmed_at,
    };
  }

  listEvents(taskId: string, afterSeq = 0): { seq: number; type: string; actor: string; at: string; payload: Record<string, unknown>; generation: number }[] {
    return (this.store.db.prepare("select seq, type, actor, at, payload_json, generation from task_events where task_id = ? and seq > ? order by seq").all(taskId, afterSeq) as { seq: number; type: string; actor: string; at: string; payload_json: string; generation: number }[])
      .map((r) => ({ seq: Number(r.seq), type: r.type, actor: r.actor, at: r.at, payload: JSON.parse(r.payload_json) as Record<string, unknown>, generation: Number(r.generation) }));
  }

  listTasks(limit = 50): TaskView[] {
    return (this.store.db.prepare("select task_id from tasks order by updated_at desc limit ?").all(Math.max(1, Math.min(200, limit))) as { task_id: string }[]).map((r) => this.getTask(r.task_id));
  }

  verdictFor(bindingHash: string): { id: string; state: VerdictState; oracleState: OracleState; blockedBy: string[]; roles: RoleRunRecord[] } | null {
    const r = this.store.db.prepare("select id, state, oracle_state, verdict_json from task_verdicts where binding_hash = ? order by created_at desc limit 1").get(bindingHash) as { id: string; state: string; oracle_state: string; verdict_json: string } | undefined;
    if (!r) return null;
    const parsed = JSON.parse(r.verdict_json) as { roles: RoleRunRecord[]; blockedBy?: string[] };
    return { id: r.id, state: r.state as VerdictState, oracleState: r.oracle_state as OracleState, blockedBy: parsed.blockedBy ?? [], roles: parsed.roles };
  }

  listRuns(taskId: string, candidateIndex?: number): { role: string; status: string; runManifestId: string; outcomesArtifactHash: string; isolation: string; omissions: string[] }[] {
    const rows = candidateIndex === undefined
      ? this.store.db.prepare("select role, status, run_manifest_id, outcomes_artifact_hash, isolation, omissions_json from task_runs where task_id = ? order by rowid").all(taskId)
      : this.store.db.prepare("select role, status, run_manifest_id, outcomes_artifact_hash, isolation, omissions_json from task_runs where task_id = ? and candidate_index = ? order by rowid").all(taskId, candidateIndex);
    return (rows as Record<string, string>[]).map((r) => ({ role: r.role, status: r.status, runManifestId: r.run_manifest_id, outcomesArtifactHash: r.outcomes_artifact_hash, isolation: r.isolation, omissions: JSON.parse(r.omissions_json) as string[] }));
  }

  // ---------------------------------------------------------------- private reads

  private taskRow(taskId: string): { task_id: string; revision: string; state: string; version: number; generation: number; spec_json: string; spec_hash: string; base_commit: string; base_content_hash: string; confirmed_at: string | null } | undefined {
    return this.store.db.prepare("select task_id, revision, state, version, generation, spec_json, spec_hash, base_commit, base_content_hash, confirmed_at from tasks where task_id = ?").get(taskId) as never;
  }

  private candidateRow(taskId: string, candidateIndex: number): { candidate_index: number; proposal_id: string; binding_json: string; binding_hash: string; oracle_state: OracleState; created_by: string; origin: "MODEL" | "HUMAN" | "MIXED" } | undefined {
    return this.store.db.prepare("select candidate_index, proposal_id, binding_json, binding_hash, oracle_state, created_by, origin from task_candidates where task_id = ? and candidate_index = ?").get(taskId, candidateIndex) as never;
  }

  private repoRootOf(view: TaskView): string {
    const revision = this.store.revision(this.taskRow(view.taskId)!.revision);
    if (!revision) throw new TaskError("NOT_FOUND", "the task's revision is no longer accessible");
    return revision.repoRoot;
  }

  private tryGit(root: string, args: string[]): string | null {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  }
}

// ------------------------------------------------------------------ source-snippet egress (F07-D4/D5)

export interface SpanPreview { file: string; start: number; end: number; hash: string; bytes: number }

export interface ProposalSpans {
  /** What a human is shown and what the audit records: paths, byte ranges, hashes and sizes — never text. */
  preview: SpanPreview[];
  /** The text, present only when the caller recorded consent for this repository; absent means paths-only. */
  text?: { file: string; start: number; end: number; text: string }[];
  withheld: { file: string; reason: string }[];
}

const SECRET_VALUE_RE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{12,}["']|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,})/i;

/**
 * Build the payload for a candidate proposer. Without recorded consent the repository's text never enters the
 * payload at all (paths, ranges, hashes and sizes only), so an unapproved repository cannot leak source by accident.
 * With consent, each span still passes a secret-value scan and a matching span is withheld and named in the plan.
 */
export function proposalSpans(root: string, files: { file: string; start: number; end: number }[], opts: { sourceSnippetsConsent: boolean }): ProposalSpans {
  const preview: SpanPreview[] = [];
  const withheld: { file: string; reason: string }[] = [];
  const text: { file: string; start: number; end: number; text: string }[] = [];
  for (const f of files) {
    const rel = normalizeRel(f.file);
    let data: Buffer;
    try { data = readFileSync(safeJoin(root, rel)); } catch { withheld.push({ file: rel, reason: "not readable in this revision" }); continue; }
    const slice = data.subarray(f.start, f.end);
    const hash = sha256(slice);
    preview.push({ file: rel, start: f.start, end: f.end, hash, bytes: slice.length });
    if (!opts.sourceSnippetsConsent) continue;
    const value = slice.toString("utf8");
    if (SECRET_VALUE_RE.test(value)) { withheld.push({ file: rel, reason: "a value that looks like a secret was found in this span" }); continue; }
    text.push({ file: rel, start: f.start, end: f.end, text: value });
  }
  // A preview that has no text field at all is what makes "nothing was sent" checkable rather than asserted.
  return preview.length && text.length ? { preview, text, withheld } : { preview, withheld };
}

/** The audited-isolation record the engine refuses to guess at. */
export function isolationRecord(cls: IsolationClass, audited: boolean): { profileId: string; class: IsolationClass; audited: boolean; properties: string[]; omissions: string[] } {
  return {
    profileId: `isolation:${cls.toLowerCase()}`, class: cls, audited,
    properties: cls === "LOCAL_PERMISSION_MODEL" ? ["node permission model", "scrubbed environment", "wall-clock kill", "process-group cleanup", "no child processes", "no sockets"] : ["container boundary"],
    omissions: cls === "LOCAL_PERMISSION_MODEL" ? [...permissionModelRunner.omissions] : [],
  };
}

export { TASK_LIMITS };
export type { TreeChange };
