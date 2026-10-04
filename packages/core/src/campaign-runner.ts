// F08 — real execution adapters. The campaign engine is pure orchestration; this module supplies the things it names:
// a deterministic recipe runner that materialises an isolated candidate tree, a validator that type-checks and runs
// that tree's tests, a joint runner that links a producer and consumer with npm's local-link mechanism, a GitHub
// publisher that find-then-creates a draft pull request, and the repository inventory (packages, cross-repository
// edges, owners) that makes producer/consumer classification and reviewer assignment real.
//
// Every operation is synchronous on purpose: the campaign engine and its F07 sibling `changes.ts` are synchronous, and
// the repository convention already reads git and GitHub with `spawnSync`/`execFileSync` (`gh.ts`, `gitinfo.ts`).
// No function here writes inside a repository's own root — a scratch copy is made first, exactly as the change engine
// does, and a recipe that reaches a protected path is refused rather than applied.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, type CampaignRepo, type ChildArtifact, type JointCheckRequest, type JointOutcome, type PublicationOutcome, type PublishRequest, type RecipeOutcome, type ValidationOutcome } from "./campaigns.ts";
import type { CampaignTransformation, CompatibilityMode } from "@cie/schema";
import {
  IsolationError, applyTextEdits, compareDiagnostics, copyTree, hashTree, linkLocalPackage, makeScratch, removeScratch,
  runTestsIn, sha256, shapeHash, treeDiff, walkFiles, type TextEdit, type TreeChange,
} from "./isolated-exec.ts";
import { codeowners } from "./gitinfo.ts";
import { githubRemote, isGhInstalled } from "./gh.ts";
import type { Store } from "./store.ts";

/** Paths a transformation may never touch, whatever its selectors say (F08-D3, §7.1). */
export const PROTECTED_PREFIXES = [".github/workflows/", ".github/actions/", ".git/", ".env"];

export interface RecipeRewrite { file: string; find: string; replace: string; flags?: string }

export interface RecipeSpec {
  selectors?: string[];
  rewrites?: RecipeRewrite[];
  runner?: { command: string[] };
  protectedPaths?: string[];
}

/** A materialised candidate. `dir`/`baseDir` are scratch paths the caller keeps only for the campaign's lifetime. */
export interface RecipeArtifact {
  diffHash: string;
  headHash: string;
  shapeHash: string;
  files: string[];
  forbiddenPaths: string[];
  handle: string;
  dir: string;
  baseDir: string;
  changes: TreeChange[];
}

// ------------------------------------------------------------------ glob matching

/** Translate a small glob language (`*`, `**`, `?`, `{a,b}`) into an anchored regular expression. */
export function globToRe(pattern: string): RegExp {
  let p = pattern.trim().replace(/^\//, "");
  const dir = p.endsWith("/");
  let src = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*" && p[i + 1] === "*") { src += "(?:.*/)?"; i++; if (p[i + 1] === "/") i++; }
    else if (ch === "*") src += "[^/]*";
    else if (ch === "?") src += "[^/]";
    else if (ch === "{") { const end = p.indexOf("}", i); if (end > i) { src += `(?:${p.slice(i + 1, end).split(",").map((x) => x.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("|")})`; i = end; } else src += "\\{"; }
    else src += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^(?:.*/)?${src}${dir ? "(?:.*)?" : "(?:/.*)?"}$`);
}

export const matchesAny = (rel: string, globs: string[]): boolean => globs.some((g) => globToRe(g).test(rel));

function readJson<T>(path: string): T | null { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; } }

/**
 * Materialise the child's base tree into `destDir`. When the repository is git and `baseCommit` resolves to a commit,
 * a detached worktree at that commit is copied (so the recipe runs against the pinned base, not whatever the working
 * tree happens to be); otherwise the working tree is copied and the caller knows it was an approximation.
 */
export function materializeBase(repoRoot: string, baseCommit: string, destDir: string): { exact: boolean } {
  const git = (args: string[], cwd = repoRoot) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, shell: false });
  if (baseCommit && git(["rev-parse", "--is-inside-work-tree"]).stdout?.trim() === "true" && git(["rev-parse", "--verify", "--quiet", `${baseCommit}^{commit}`]).status === 0) {
    const wt = makeScratch("cie-base-");
    try {
      if (git(["worktree", "add", "--detach", "--quiet", wt, baseCommit]).status === 0) { copyTree(wt, destDir); return { exact: true }; }
    } finally {
      git(["worktree", "remove", "--force", wt]);
      removeScratch(wt);
    }
  }
  copyTree(repoRoot, destDir);
  return { exact: false };
}

// ------------------------------------------------------------------ recipe runner

export class RecipeRunner {
  /** An operator-trusted checkout may have its tests run; untrusted checkouts are compile-checked only. */
  readonly trustedRoots = new Set<string>();
  private readonly maxRecipeMs: number;
  constructor(opts: { maxRecipeMs?: number } = {}) { this.maxRecipeMs = opts.maxRecipeMs ?? 120_000; }
  trust(root: string) { this.trustedRoots.add(root); }

  private spec(transformation: CampaignTransformation): RecipeSpec {
    if (transformation.kind !== "RECIPE") return {};
    const args = transformation.args as RecipeSpec;
    return {
      selectors: args.selectors,
      rewrites: args.rewrites,
      runner: args.runner,
      protectedPaths: args.protectedPaths,
    };
  }

  /** Does this transformation have anything to do in this repository? A recipe with no selector matches everything. */
  transformationApplies(repoRoot: string, transformation: CampaignTransformation): { applies: boolean; reason: string } {
    if (transformation.kind === "TASK_TEMPLATE") return { applies: true, reason: "task templates are not selector-bound" };
    const spec = this.spec(transformation);
    const globs = spec.selectors ?? spec.rewrites?.map((r) => r.file) ?? [];
    if (!globs.length) return { applies: true, reason: "the recipe declares no file selector" };
    let files: string[];
    try { files = walkFiles(repoRoot, () => true); } catch (e) { return { applies: false, reason: `could not read the checkout: ${(e as Error).message}` }; }
    const hit = files.find((f) => matchesAny(f, globs));
    return hit ? { applies: true, reason: `matches ${hit}` } : { applies: false, reason: `no file matches the recipe selectors (${globs.join(", ")})` };
  }

  /**
   * Run the deterministic transformation against an isolated copy of `repoRoot`. The candidate tree is left under
   * `dir` for the validator and the joint runner; the repository itself is never touched.
   */
  applyRecipe(repoRoot: string, baseCommit: string, transformation: CampaignTransformation): RecipeOutcome & Partial<Omit<RecipeArtifact, "diffHash" | "files" | "forbiddenPaths">> {
    if (transformation.kind === "TASK_TEMPLATE") return { ok: false, error: "task templates are not enabled: this deployment runs deterministic recipes only (F08 §18 D1)" };
    const spec = this.spec(transformation);
    const scratch = makeScratch();
    const baseDir = join(scratch, "base"), headDir = join(scratch, "head");
    try {
      materializeBase(repoRoot, baseCommit, baseDir);
      copyTree(baseDir, headDir);
    } catch (e) {
      removeScratch(scratch);
      return { ok: false, error: `the checkout could not be isolated: ${(e as Error).message}` };
    }
    try {
      if (spec.runner?.command?.length) {
        if (!Array.isArray(spec.runner.command) || spec.runner.command.some((c) => typeof c !== "string" || c.includes("\0"))) throw new IsolationError("INVALID_SCHEMA", "recipe runner command must be a list of strings");
        const [cmd, ...rest] = spec.runner.command;
        const res = spawnSync(cmd!, rest, { cwd: headDir, shell: false, encoding: "utf8", timeout: this.maxRecipeMs, maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", HOME: headDir, LANG: "C" } });
        if (res.error) throw new IsolationError("RESOURCE_LIMIT", `the recipe runner could not start: ${res.error.message}`);
        if (res.status !== 0) throw new IsolationError("INVALID_SCHEMA", `the recipe runner exited ${res.status}: ${(res.stderr ?? "").slice(0, 400)}`);
      } else if (spec.rewrites?.length) {
        this.applyRewrites(headDir, spec.rewrites);
      } else {
        throw new IsolationError("INVALID_SCHEMA", "a RECIPE needs a runner command or deterministic rewrites");
      }
    } catch (e) {
      removeScratch(scratch);
      const err = e as Error;
      return { ok: false, error: err instanceof IsolationError ? `${err.code}: ${err.message}` : err.message };
    }

    const changes = treeDiff(baseDir, headDir);
    const protectedList = [...PROTECTED_PREFIXES, ...(spec.protectedPaths ?? [])];
    const selectors = spec.selectors ?? spec.rewrites?.map((r) => r.file) ?? [];
    const forbiddenPaths = [...new Set(changes.filter((c) => protectedList.some((p) => c.file === p.replace(/\/$/, "") || c.file.startsWith(p))).map((c) => c.file))].sort();
    // Admission also refuses a change outside the recipe's declared selectors: a transformation may only touch what it says it touches.
    const outsideSelectors = selectors.length ? changes.filter((c) => !matchesAny(c.file, selectors)).map((c) => c.file) : [];
    const allForbidden = [...new Set([...forbiddenPaths, ...outsideSelectors])].sort();
    const diffHash = sha256(canonical(changes.map((c) => [c.file, c.kind, c.oldHash, c.newHash])));
    const headHash = hashTree(headDir);
    return {
      ok: true, diffHash, files: changes.map((c) => c.file), forbiddenPaths: allForbidden,
      headHash, shapeHash: shapeHash(changes), handle: sha256(`${diffHash}:${headHash}`), dir: headDir, baseDir, changes,
    };
  }

  private applyRewrites(dir: string, rewrites: RecipeRewrite[]): void {
    for (const r of rewrites) {
      if (typeof r.find !== "string" || typeof r.replace !== "string" || !r.find) throw new IsolationError("INVALID_SCHEMA", "a rewrite needs find and replace strings");
      const globs = [r.file];
      const files = walkFiles(dir, (rel) => matchesAny(rel, globs));
      if (!files.length) throw new IsolationError("INVALID_SCHEMA", `rewrite selector matched no file: ${r.file}`);
      for (const rel of files) {
        const path = join(dir, rel);
        const before = readFileSync(path);
        const text = before.toString("utf8");
        let next: string;
        if (r.flags) { const re = new RegExp(r.find, r.flags.includes("g") ? r.flags : `${r.flags}g`); next = text.replace(re, r.replace); }
        else next = text.split(r.find).join(r.replace);
        if (next === text) continue;
        // Record the rewrite as exact byte-span edits, then apply them: the same admission path a person's edit takes.
        const edits: TextEdit[] = [];
        if (!r.flags) {
          let idx = 0;
          while (true) { const at = text.indexOf(r.find, idx); if (at < 0) break; const start = Buffer.byteLength(text.slice(0, at), "utf8"); edits.push({ file: rel, start, end: start + Buffer.byteLength(r.find, "utf8"), expected: r.find, newText: r.replace }); idx = at + r.find.length; }
        }
        if (edits.length) applyTextEdits(dir, edits);
        else writeRewritten(path, next);
      }
    }
  }
}

function writeRewritten(path: string, text: string) { writeFileSync(path, text); }

// ------------------------------------------------------------------ validation

export interface ValidateRequest { candidate: ChildArtifact; trusted: boolean; contractTests?: string[] }

/** Type-check the candidate against its base and run its tests when the checkout is trusted. A failure states why. */
export function validateCandidate(req: ValidateRequest): ValidationOutcome {
  const baseDir = req.candidate.baseDir, candidateDir = req.candidate.dir;
  if (!baseDir || !candidateDir) return { state: "FAILED", runs: 0, passedRuns: 0, failedRuns: 0, reason: "the candidate tree was not materialised; nothing could be checked" };
  let introduced: string[];
  try { introduced = compareDiagnostics(baseDir, candidateDir).introduced; }
  catch (e) { return { state: "FAILED", runs: 0, passedRuns: 0, failedRuns: 0, reason: `the candidate could not be checked: ${(e as Error).message}` }; }
  if (introduced.length) return { state: "FAILED", runs: 1, passedRuns: 0, failedRuns: 1, reason: `the change introduces ${introduced.length} new compile error(s): ${introduced.slice(0, 3).join("; ")}` };
  if (!req.trusted) return { state: "PASSED", runs: 1, passedRuns: 1, failedRuns: 0, reason: "compile check only (this checkout is not trusted for running its tests)" };
  const tests = runTestsIn(candidateDir);
  const runs = 1;
  if (!tests.ran) return { state: "FAILED", runs, passedRuns: 0, failedRuns: 1, reason: tests.reason ?? "tests could not run" };
  if (tests.failed > 0) return { state: "FAILED", runs, passedRuns: tests.passed, failedRuns: tests.failed, reason: `${tests.failed} test(s) failed: ${tests.output.slice(0, 300)}` };
  return { state: "PASSED", runs, passedRuns: tests.passed, failedRuns: 0 };
}

// ------------------------------------------------------------------ joint runner (npm local link)

export interface JointManifest {
  manifestHash: string; role: "JOINT"; mode: CompatibilityMode; linkMethod: "npm-workspace-symlink";
  producerContentHash: string; consumerContentHash: string; status: "PASSED" | "FAILED"; diagnostics: string; contractTests: string[];
}

/** Materialise a candidate or base tree and link a producer package into a consumer workspace. */
export class JointRunner {
  private readonly maxMs: number;
  constructor(opts: { maxMs?: number } = {}) { this.maxMs = opts.maxMs ?? 180_000; }

  check(req: JointCheckRequest & { contractTests?: string[] }): JointOutcome & { manifest?: JointManifest } {
    const producerCandidate = req.producer.dir, producerBase = req.producer.baseDir ?? req.producer.dir;
    const consumerCandidate = req.consumer.dir, consumerBase = req.consumer.baseDir ?? req.consumer.dir;
    if (!producerCandidate || !consumerCandidate || !producerBase || !consumerBase) return { state: "NOT_EVALUABLE", reason: "a candidate tree was not materialised; no local-link mechanism applies" };
    const producerDir = req.mode === "BASE_WITH_CANDIDATE" ? producerBase : producerCandidate;
    const consumerDir = req.mode === "CANDIDATE_WITH_BASE" ? consumerBase : consumerCandidate;
    const producerPkg = readJson<{ name?: string }>(join(producerDir, "package.json"));
    const consumerPkg = readJson<{ name?: string }>(join(consumerDir, "package.json"));
    if (!producerPkg?.name) return { state: "NOT_EVALUABLE", reason: "the producer is not an npm package (no package.json name); no local-link mechanism applies" };
    if (!consumerPkg) return { state: "NOT_EVALUABLE", reason: "the consumer is not an npm project (no package.json); no local-link mechanism applies" };

    const workspace = makeScratch("cie-joint-");
    try {
      const wsProducer = join(workspace, "producer"), wsConsumer = join(workspace, "consumer");
      copyTree(producerDir, wsProducer);
      copyTree(consumerDir, wsConsumer);
      let linkMethod: "npm-workspace-symlink" = "npm-workspace-symlink";
      try { linkLocalPackage(workspace, wsConsumer, producerPkg.name, wsProducer); }
      catch (e) { return { state: "NOT_EVALUABLE", reason: `the npm linker refused: ${(e as Error).message}` }; }

      // Run the consumer's tests (plus any policy-named contract tests) against the linked producer.
      const testFiles = walkFiles(wsConsumer, (rel) => /\.test\.(ts|js|mjs)$/.test(rel));
      const contract = (req.contractTests ?? []).filter((t) => existsSync(join(wsConsumer, t)));
      const toRun = [...new Set([...testFiles, ...contract])];
      let status: "PASSED" | "FAILED" = "PASSED"; let diagnostics = "";
      if (toRun.length) {
        const res = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${workspace}`, "--test", "--test-isolation=none", ...toRun], {
          cwd: wsConsumer, env: { PATH: "/usr/bin:/bin", HOME: wsConsumer, LANG: "C" }, encoding: "utf8", timeout: this.maxMs, maxBuffer: 8 * 1024 * 1024, shell: false,
        });
        const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
        const failed = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 0);
        const passed = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0);
        if (res.error || res.status !== 0 || failed > 0 || (passed === 0 && !/ℹ tests 0/.test(out))) {
          status = "FAILED";
          diagnostics = out.split("\n").filter((l) => /✖|Error|error|not assignable|Cannot find/.test(l)).slice(0, 12).join("\n") || `link check exited ${res.status}`;
        }
      } else {
        // No runnable test: a link that at least resolves is reported as evaluated only when the package resolves.
        status = "FAILED";
        diagnostics = "the consumer has no test to run against the linked producer; the joint case cannot be proven";
      }
      const producerContentHash = hashTree(wsProducer), consumerContentHash = hashTree(wsConsumer);
      const manifest: JointManifest = {
        manifestHash: sha256(canonical({ mode: req.mode, linkMethod, producerContentHash, consumerContentHash, status, diagnostics })),
        role: "JOINT", mode: req.mode, linkMethod, producerContentHash, consumerContentHash, status, diagnostics, contractTests: contract,
      };
      if (status === "FAILED") return { state: "FAILED", reason: diagnostics, runManifestId: manifest.manifestHash, manifest };
      return { state: "PASSED", runManifestId: manifest.manifestHash, manifest };
    } catch (e) {
      return { state: "NOT_EVALUABLE", reason: `the joint workspace could not be built: ${(e as Error).message}` };
    } finally {
      removeScratch(workspace);
    }
  }
}

// ------------------------------------------------------------------ GitHub publisher (gh CLI, find-then-create)

/**
 * Commit a candidate tree onto a new branch and push it, so a draft pull request can name it. The repository is never
 * modified in place: a detached git worktree at the child's base is created, the candidate's files are overlaid (files
 * the recipe deleted are removed), the result is committed and pushed. An existing remote branch is left untouched: the
 * push is a normal fast-forward and a divergent branch fails rather than being overwritten.
 */
export function pushCandidateBranch(req: { repoRoot: string; baseCommit: string; candidateDir: string; branch: string; title: string }): { ok: true; headHash: string } | { ok: false; reason: string } {
  const git = (args: string[], cwd = req.repoRoot) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, shell: false });
  if (git(["rev-parse", "--is-inside-work-tree"]).stdout?.trim() !== "true") return { ok: false, reason: "the checkout is not a git repository" };
  const wt = makeScratch("cie-push-");
  try {
    const add = git(["worktree", "add", "--detach", "--quiet", wt, req.baseCommit]);
    if (add.status !== 0) return { ok: false, reason: `git worktree add failed: ${(add.stderr ?? "").trim().slice(0, 200)}` };
    const candidateFiles = new Set(walkFiles(req.candidateDir, () => true));
    for (const rel of candidateFiles) { const dst = join(wt, rel); mkdirSync(dirname(dst), { recursive: true }); copyFileSync(join(req.candidateDir, rel), dst); }
    for (const rel of walkFiles(wt, () => true)) if (!candidateFiles.has(rel)) rmSync(join(wt, rel), { force: true });
    git(["add", "-A"], wt);
    const commit = git(["-c", "user.email=cie@localhost", "-c", "user.name=cie", "commit", "-m", req.title, "--no-verify"], wt);
    if (commit.status !== 0 && !/nothing to commit|no changes added/i.test(`${commit.stdout ?? ""}${commit.stderr ?? ""}`)) return { ok: false, reason: `git commit failed: ${(commit.stderr ?? "").trim().slice(0, 200)}` };
    const headHash = git(["rev-parse", "HEAD"], wt).stdout?.trim() ?? "";
    const push = git(["push", "--quiet", "origin", `HEAD:refs/heads/${req.branch}`], wt);
    if (push.status !== 0) return { ok: false, reason: `git push failed: ${(push.stderr ?? "").trim().slice(0, 300)}` };
    return { ok: true, headHash };
  } catch (e) {
    return { ok: false, reason: `the branch could not be pushed: ${(e as Error).message}` };
  } finally {
    git(["worktree", "remove", "--force", wt]);
    removeScratch(wt);
  }
}

export class GitHubPublisher {
  readonly enabled: boolean;
  constructor() { this.enabled = isGhInstalled(); }

  private slug(repoRoot: string) { return githubRemote(repoRoot); }

  private gh(args: string[], repoRoot: string): { ok: boolean; out: string } {
    const res = spawnSync("gh", args, { cwd: repoRoot, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, shell: false, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
    return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  }

  /** Find-or-create, keyed by the child's head branch: an existing draft is adopted, never duplicated (F08-A4). */
  publish(req: PublishRequest): PublicationOutcome {
    if (!this.enabled) return { state: "FAILED", reason: "the gh CLI is not installed; no GitHub publication is available" };
    const slug = this.slug(req.repoRoot);
    if (!slug) return { state: "FAILED", reason: "this repository has no GitHub origin remote" };
    const repo = `${slug.owner}/${slug.repo}`;
    // The candidate has to exist as a branch before a pull request can name it. A branch that already exists is left alone.
    if (req.candidateDir) {
      const existing = this.gh(["api", `repos/${repo}/git/ref/heads/${req.branch}`, "--jq", ".object.sha"], req.repoRoot);
      if (!existing.ok && !/404|Not Found/i.test(existing.out)) {
        const pushed = pushCandidateBranch({ repoRoot: req.repoRoot, baseCommit: req.baseCommit, candidateDir: req.candidateDir, branch: req.branch, title: req.title });
        if (!pushed.ok) return { state: "FAILED", reason: pushed.reason };
      }
    }
    const found = this.gh(["pr", "list", "--repo", repo, "--head", req.branch, "--state", "all", "--json", "number,state,isDraft", "--limit", "1"], req.repoRoot);
    if (found.ok) {
      try {
        const list = JSON.parse(found.out) as { number: number; state: string; isDraft: boolean }[];
        if (list.length) return { state: "ADOPTED", prNumber: list[0]!.number, prState: list[0]!.isDraft ? "draft" : list[0]!.state.toLowerCase() };
      } catch { /* fall through to create */ }
    }
    const created = this.gh(["pr", "create", "--repo", repo, "--draft", "--base", req.defaultBranch, "--head", req.branch, "--title", req.title, "--body", req.body], req.repoRoot);
    if (!created.ok) return { state: "FAILED", reason: `gh pr create failed: ${created.out.replace(/\s+/g, " ").slice(0, 300)}` };
    const m = /\/pull\/(\d+)/.exec(created.out) ?? /#(\d+)/.exec(created.out);
    const number = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(number)) return { state: "FAILED", reason: "gh pr create returned no pull request number" };
    return { state: "CREATED", prNumber: number, prState: "draft" };
  }

  state(repoRoot: string, prNumber: number): string | null {
    if (!this.enabled) return null;
    const slug = this.slug(repoRoot);
    if (!slug) return null;
    const res = this.gh(["pr", "view", String(prNumber), "--repo", `${slug.owner}/${slug.repo}`, "--json", "state,isDraft"], repoRoot);
    if (!res.ok) return null;
    try { const j = JSON.parse(res.out) as { state: string; isDraft: boolean }; return j.isDraft ? "draft" : j.state.toLowerCase(); } catch { return null; }
  }

  /** The connector's rate-limit state, so the campaign limiter can pause with the resume time. */
  rateLimit(): { limited: boolean; resumeAt?: string } {
    if (!this.enabled) return { limited: false };
    const res = this.gh(["api", "rate_limit", "--jq", ".resources.core"], process.cwd());
    if (!res.ok) return { limited: false };
    try {
      const j = JSON.parse(res.out) as { remaining: number; reset: number };
      if (j.remaining > 0) return { limited: false };
      return { limited: true, resumeAt: new Date(j.reset * 1000).toISOString() };
    } catch { return { limited: false }; }
  }
}

// ------------------------------------------------------------------ repository inventory

export interface RepoInventoryDeps { store: Store; repoRoots: () => { repositoryId: string; repoRoot: string; defaultBranch: string; baseCommit: string }[] }

/**
 * Build the campaign's view of each repository: packages it exports, packages/edges it consumes (F01 `cross_repo_edges`
 * and F04 `package_requires`), a CODEOWNERS owner and a language. This is what makes producer/consumer ordering real.
 */
export function repositoryInventory(store: Store, repoRoots: RepoInventoryDeps["repoRoots"]): CampaignRepo[] {
  const db = store.db;
  const byRoot = new Map<string, string>();
  try {
    for (const r of db.prepare("select repository_id, root from repositories where root is not null").all() as { repository_id: string; root: string }[]) byRoot.set(r.root, r.repository_id);
  } catch { /* F01 tables absent: identity stays path-based */ }

  return repoRoots().map((row) => {
    const repositoryId = byRoot.get(row.repoRoot) ?? row.repositoryId;
    const rev = (db.prepare("select id from revisions where repo_root = ? order by rowid desc limit 1").get(row.repoRoot) as { id: string } | undefined)?.id;
    const packages = rev ? (db.prepare("select distinct package_name from package_provides where repository_id = ? and revision = ? order by package_name").all(repositoryId, rev) as { package_name: string }[]).map((r) => r.package_name) : [];
    const requiresPackages = rev ? (db.prepare("select distinct package_name from package_requires where repository_id = ? and revision = ? order by package_name").all(repositoryId, rev) as { package_name: string }[]).map((r) => r.package_name) : [];
    const requiresRepositories = rev ? (db.prepare("select distinct to_repository from cross_repo_edges where from_repository = ? and from_revision = ? order by to_repository").all(repositoryId, rev) as { to_repository: string }[]).map((r) => r.to_repository) : [];
    let owner: string | undefined;
    let language: string | undefined;
    try {
      const rules = codeowners(row.repoRoot);
      // The owner most frequently named first among rules, so the value is stable.
      const counts = new Map<string, number>();
      for (const rule of rules.rules) for (const o of rule.owners) counts.set(o, (counts.get(o) ?? 0) + 1);
      owner = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    } catch { /* no CODEOWNERS */ }
    try {
      const has = (p: string) => existsSync(join(row.repoRoot, p));
      language = has("tsconfig.json") ? "typescript" : has("Cargo.toml") ? "rust" : has("go.mod") ? "go" : has("pyproject.toml") || has("requirements.txt") ? "python" : has("pom.xml") ? "java" : undefined;
    } catch { /* unreadable */ }
    return {
      repositoryId: row.repositoryId, repoRoot: row.repoRoot, name: row.repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? row.repoRoot,
      defaultBranch: row.defaultBranch, baseCommit: row.baseCommit, packages, requiresPackages, requiresRepositories, owner, language,
      symbolsReferenced: [],
    };
  });
}

export { IsolationError };
export type { TreeChange, TextEdit };
