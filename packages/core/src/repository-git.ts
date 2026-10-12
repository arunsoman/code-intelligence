import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { ApiResult, CallContext, DirListing, RepositoryGitInfo } from "@cie/schema";
import { ghAuthToken, parseGitHubRemote } from "./gh.ts";
import { actor, fail, ok } from "./service.ts";
import type { Service } from "./service.ts";

function safeIsDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function optional(root: string, args: string[]): string | null {
  try { return git(root, args) || null; } catch { return null; }
}

export function repositoryGit(repoPath: string, credentials = (host: string) => ghAuthToken(host).ok): RepositoryGitInfo {
  if (typeof repoPath !== "string" || !isAbsolute(repoPath)) throw new Error("Choose an absolute repository path.");
  const repoRoot = realpathSync(repoPath);
  const info: RepositoryGitInfo = { repoRoot, isGitRepo: false, branch: null, head: null, dirty: false, branches: [], remotes: [], remoteBranches: [], origin: null, github: null };
  const top = optional(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (!top) return info;
  if (realpathSync(top) !== repoRoot) throw new Error("Choose the Git repository's root folder.");
  info.isGitRepo = true;
  info.branch = optional(repoRoot, ["symbolic-ref", "--quiet", "HEAD"])?.replace(/^refs\/heads\//, "") ?? null;
  info.head = optional(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  info.dirty = git(repoRoot, ["status", "--porcelain", "--untracked-files=normal"]).length > 0;
  info.branches = git(repoRoot, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).split("\n").filter(Boolean).map((ref) => ref.slice("refs/heads/".length));
  info.remotes = git(repoRoot, ["remote"]).split("\n").filter(Boolean);
  const tracking = new Map<string, { remote?: string; merge?: string }>();
  for (const line of (optional(repoRoot, ["config", "--get-regexp", "^branch\\..*\\.(remote|merge)$"]) ?? "").split("\n")) {
    const match = /^branch\.(.+)\.(remote|merge) (.*)$/.exec(line);
    if (!match) continue;
    const settings = tracking.get(match[1]) ?? {};
    settings[match[2] as "remote" | "merge"] = match[3]; tracking.set(match[1], settings);
  }
  const remotes = [...info.remotes].sort((a, b) => b.length - a.length);
  for (const line of git(repoRoot, ["for-each-ref", "--format=%(refname)%09%(symref)", "refs/remotes/"]).split("\n")) {
    const [ref, symbolic] = line.split("\t");
    if (!ref || symbolic) continue; // origin/HEAD is an alias, not a branch.
    const remote = remotes.find((name) => ref.startsWith(`refs/remotes/${name}/`));
    if (!remote) continue;
    const branch = ref.slice(`refs/remotes/${remote}/`.length);
    const localBranch = info.branches.find((name) => tracking.get(name)?.remote === remote && tracking.get(name)?.merge === `refs/heads/${branch}`) ?? null;
    info.remoteBranches.push({ ref, remote, branch, localBranch });
  }
  const origin = optional(repoRoot, ["remote", "get-url", "origin"]);
  if (origin) {
    // Never expose credentials embedded in a remote URL.
    let safe = origin;
    try { const u = new URL(origin); u.username = ""; u.password = ""; u.search = ""; u.hash = ""; safe = u.toString(); } catch { /* SCP or local path */ }
    info.origin = safe;
    const slug = parseGitHubRemote(safe);
    if (slug && slug.host === "github.com") info.github = { repository: `${slug.owner}/${slug.repo}`, credentialsAvailable: credentials(slug.host) };
  }
  return info;
}

export async function fetchRepositoryBranches(repoPath: string): Promise<RepositoryGitInfo> {
  const current = repositoryGit(repoPath, () => false);
  if (!current.isGitRepo || !current.remotes.length) throw new Error("No Git remotes are configured for this repository.");
  for (const remote of current.remotes) {
    try {
      await promisify(execFile)("git", ["-C", current.repoRoot, "-c", "core.hooksPath=/dev/null", "fetch", "--prune", "--no-tags", "--no-recurse-submodules", "--", remote, `+refs/heads/*:refs/remotes/${remote}/*`], {
        timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", ...(process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || optional(current.repoRoot, ["config", "core.sshCommand"]) ? {} : { GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10" }) },
      });
    } catch { throw new Error(`Could not fetch branches from ${remote}. Check network access and Git credentials on the server, then retry. Some remotes may already have refreshed.`); }
  }
  return repositoryGit(current.repoRoot);
}

export function switchRepositoryBranch(repoPath: string, branch: string, expectedHead: string | null, expectedBranch: string | null, kind: "local" | "remote" = "local"): RepositoryGitInfo {
  const current = repositoryGit(repoPath, () => false);
  const remote = kind === "remote" ? current.remoteBranches.find((b) => b.ref === branch) : undefined;
  if (!current.isGitRepo || typeof branch !== "string" || branch.startsWith("-") || (kind === "local" ? !current.branches.includes(branch) : kind !== "remote" || !remote)) throw new Error("Choose an existing local branch or a listed remote branch.");
  if (current.head !== expectedHead || current.branch !== expectedBranch) throw new Error("The checkout changed. Refresh Git details before switching.");
  if (current.dirty) throw new Error("Commit or stash local changes before switching branches.");
  for (const state of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_START", "sequencer"]) {
    if (existsSync(git(current.repoRoot, ["rev-parse", "--path-format=absolute", "--git-path", state]))) throw new Error("Finish the current Git operation before switching branches.");
  }
  if (remote && !remote.localBranch && current.branches.includes(remote.branch)) throw new Error(`Local branch ${remote.branch} already exists and tracks a different source. Select it under Local branches, or rename it before checking out this remote branch.`);
  const args = remote && !remote.localBranch ? ["--track=direct", "--create", remote.branch, remote.ref] : ["--no-guess", remote?.localBranch ?? branch];
  const trackingConfig = remote && !remote.localBranch ? ["-c", `remote.${remote.remote}.fetch=+refs/heads/*:refs/remotes/${remote.remote}/*`] : [];
  try { git(current.repoRoot, ["-c", "core.hooksPath=/dev/null", ...trackingConfig, "switch", ...args]); }
  catch { throw new Error("Git could not switch branches. The branch may be in use by another worktree, or a Git operation may be in progress."); }
  // Single-branch clones need a persistent fetch mapping for the new upstream,
  // otherwise Git cannot resolve @{upstream} or pull this branch later.
  if (remote && !optional(current.repoRoot, ["rev-parse", "--symbolic-full-name", "@{upstream}"])) {
    try { git(current.repoRoot, ["config", "--add", `remote.${remote.remote}.fetch`, `+refs/heads/${remote.branch}:${remote.ref}`]); }
    catch { throw new Error(`Switched to ${remote.localBranch ?? remote.branch}, but Git could not save its upstream fetch configuration. Refresh Git details and check the repository configuration.`); }
  }
  return repositoryGit(current.repoRoot);
}

export class GitBrowsing {
  declare readonly svc: Service;
  constructor(svc: Service) { Object.defineProperty(this, "svc", { value: svc, enumerable: false }); }
  private get store() { return this.svc.store; }

  repositoryGit(ctx: CallContext, req: { repoPath: string }) {
    try { return ok(ctx, repositoryGit(req?.repoPath)); }
    catch (e) { return fail(ctx, { code: "INVALID_SCHEMA", message: (e as Error).message, retryable: false }); }
  }

  async fetchBranches(ctx: CallContext, req: { repoPath: string }) {
    try { return ok(ctx, await fetchRepositoryBranches(req?.repoPath)); }
    catch (e) { return fail(ctx, { code: "PROVIDER_UNAVAILABLE", message: (e as Error).message, retryable: true }); }
  }

  switchBranch(ctx: CallContext, req: { repoPath: string; branch: string; expectedHead: string | null; expectedBranch: string | null; kind?: "local" | "remote" }) {
    if (this.store.activeJobs().length) return fail(ctx, { code: "VERSION_CONFLICT", message: "Wait for running jobs to finish before switching branches.", retryable: true });
    try {
      const info = switchRepositoryBranch(req?.repoPath, req?.branch, req?.expectedHead, req?.expectedBranch, req?.kind);
      this.store.audit(actor(ctx), "repository.switchBranch", info.repoRoot, { branch: info.branch, head: info.head });
      return ok(ctx, info);
    } catch (e) { return fail(ctx, { code: "INVALID_SCHEMA", message: (e as Error).message, retryable: false }); }
  }

  /** Directory names only (never file contents) so the UI can offer a folder picker. Loopback-only gateway. */
  browseDirectory(ctx: CallContext, req: { path?: string }): ApiResult<DirListing> {
    const want = req.path?.trim() || homedir();
    if (!isAbsolute(want)) return fail(ctx, { code: "INVALID_SCHEMA", message: "path must be absolute", retryable: false });
    let path: string;
    try {
      path = realpathSync(want);
      if (!statSync(path).isDirectory()) return fail(ctx, { code: "INVALID_SCHEMA", message: "not a directory", retryable: false });
    } catch { return fail(ctx, { code: "NOT_FOUND", message: "directory not found", retryable: false }); }
    const MAX = 500;
    let names: import("node:fs").Dirent[];
    try { names = readdirSync(path, { withFileTypes: true }); } catch { return fail(ctx, { code: "FORBIDDEN", message: "cannot read directory", retryable: false }); }
    const dirs = names
      .filter((d) => (d.isDirectory() || (d.isSymbolicLink() && safeIsDir(join(path, d.name)))) && !d.name.startsWith(".") && d.name !== "node_modules")
      .sort((a, b) => a.name.localeCompare(b.name));
    const entries = dirs.slice(0, MAX).map((d) => ({ name: d.name, path: join(path, d.name), isGitRepo: existsSync(join(path, d.name, ".git")) }));
    const parent = dirname(path);
    return ok(ctx, { path, parent: parent === path ? null : parent, entries, truncated: dirs.length > MAX });
  }
}
