import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchRepositoryBranches, repositoryGit, switchRepositoryBranch } from "../src/repository-git.ts";

test("Git details identify branch, dirty files, detached HEAD and sanitized GitHub origin", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cie-git-info-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  assert.equal(repositoryGit(root).isGitRepo, false);
  git("init", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial");
  git("remote", "add", "origin", "https://user:secret@github.com/owner/repo.git?token=secret");
  const info = repositoryGit(root, () => true);
  assert.equal(info.branch, "main"); assert.equal(info.dirty, false);
  assert.equal(info.head, git("rev-parse", "HEAD"));
  assert.deepEqual(info.github, { repository: "owner/repo", credentialsAvailable: true });
  assert.ok(!JSON.stringify(info).includes("secret"));
  writeFileSync(join(root, "new.ts"), "export const x = 1;");
  assert.equal(repositoryGit(root, () => false).dirty, true);
  git("checkout", "--detach");
  assert.equal(repositoryGit(root, () => false).branch, null);
});

test("fetch discovers all remote branches from a single-branch clone, tracks safely, and prunes deleted branches", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cie-remote-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), checkout = join(root, "checkout");
  const git = (at: string, ...args: string[]) => execFileSync("git", ["-C", at, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git(root, "init", "-b", "main", source);
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial");
  git(source, "branch", "feature/a"); git(source, "branch", "collision");
  git(root, "clone", "--single-branch", "--branch", "main", source, checkout);
  assert.ok(!repositoryGit(checkout).remoteBranches.some((b) => b.branch === "feature/a"));
  const fetched = await fetchRepositoryBranches(checkout);
  assert.equal(fetched.branch, "main");
  assert.ok(fetched.remoteBranches.some((b) => b.ref === "refs/remotes/origin/feature/a"));
  assert.ok(!fetched.remoteBranches.some((b) => b.branch === "HEAD"));
  const selected = switchRepositoryBranch(checkout, "refs/remotes/origin/feature/a", fetched.head, "main", "remote");
  assert.equal(selected.branch, "feature/a");
  assert.equal(git(checkout, "config", "branch.feature/a.remote"), "origin");
  assert.equal(git(checkout, "config", "branch.feature/a.merge"), "refs/heads/feature/a");
  // Preserve the original narrow fetch mapping and add only the selected branch.
  assert.equal(git(checkout, "config", "--get-all", "remote.origin.fetch"), "+refs/heads/main:refs/remotes/origin/main\n+refs/heads/feature/a:refs/remotes/origin/feature/a");
  assert.equal(git(checkout, "rev-parse", "--symbolic-full-name", "@{upstream}"), "refs/remotes/origin/feature/a");
  git(checkout, "branch", "-m", "my-feature"); git(checkout, "switch", "main");
  const reused = switchRepositoryBranch(checkout, "refs/remotes/origin/feature/a", fetched.head, "main", "remote");
  assert.equal(reused.branch, "my-feature");
  git(checkout, "branch", "collision");
  assert.throws(() => switchRepositoryBranch(checkout, "refs/remotes/origin/collision", reused.head, "my-feature", "remote"), /already exists/);
  git(source, "branch", "-D", "collision");
  const pruned = await fetchRepositoryBranches(checkout);
  assert.ok(!pruned.remoteBranches.some((b) => b.branch === "collision"));
  assert.ok(pruned.branches.includes("collision"), "pruning preserves local branches");
});

test("switching checks stale state, preserves dirty files, rejects invalid branches and changes clean checkout", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cie-git-switch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial");
  git("branch", "feature/a");
  const before = repositoryGit(root);
  assert.throws(() => switchRepositoryBranch(root, "feature/a", "stale", "main"), /checkout changed/);
  assert.throws(() => switchRepositoryBranch(root, "--detach", before.head, "main"), /existing local branch/);
  writeFileSync(join(root, "keep.txt"), "user work");
  assert.throws(() => switchRepositoryBranch(root, "feature/a", before.head, "main"), /Commit or stash/);
  assert.equal(git("branch", "--show-current"), "main");
  git("add", "keep.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "keep");
  const current = repositoryGit(root);
  const after = switchRepositoryBranch(root, "feature/a", current.head, "main");
  assert.equal(after.branch, "feature/a"); assert.equal(after.head, before.head);
  assert.throws(() => switchRepositoryBranch(root, "main", before.head, "main"), /checkout changed/);
});
