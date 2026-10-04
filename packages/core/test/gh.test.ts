import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { parseGitHubRemote, githubApiBase, githubRemote, ensureGhForgeConnector } from "../src/gh.ts";
import { Store } from "../src/store.ts";

test("parseGitHubRemote understands common origin URL shapes", () => {
  assert.deepEqual(parseGitHubRemote("git@github.com:acme/pay.git"), { host: "github.com", owner: "acme", repo: "pay" });
  assert.deepEqual(parseGitHubRemote("git@github.com:acme/pay"), { host: "github.com", owner: "acme", repo: "pay" });
  assert.deepEqual(parseGitHubRemote("https://github.com/acme/pay.git"), { host: "github.com", owner: "acme", repo: "pay" });
  assert.deepEqual(parseGitHubRemote("https://github.com/acme/pay"), { host: "github.com", owner: "acme", repo: "pay" });
  assert.deepEqual(parseGitHubRemote("https://GITHUB.com/Acme/Pay.git"), { host: "github.com", owner: "Acme", repo: "Pay" });
  assert.deepEqual(parseGitHubRemote("https://gitlab.com/acme/pay.git"), { host: "gitlab.com", owner: "acme", repo: "pay" });
  assert.equal(parseGitHubRemote("/some/local/path"), null);
});

test("githubApiBase uses the public API for github.com and /api/v3 for GitHub Enterprise", () => {
  assert.equal(githubApiBase({ host: "github.com", owner: "acme", repo: "pay" }), "https://api.github.com");
  assert.equal(githubApiBase({ host: "gh.acme.com", owner: "acme", repo: "pay" }), "https://gh.acme.com/api/v3");
});

test("githubRemote reads origin from a local repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "cie-gh-"));
  execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/pay.git"], { stdio: "ignore" });
  assert.deepEqual(githubRemote(dir), { host: "github.com", owner: "acme", repo: "pay" });
});

test("ensureGhForgeConnector returns null when there is no GitHub remote", () => {
  const dir = mkdtempSync(join(tmpdir(), "cie-gh-"));
  execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
  const store = new Store(":memory:");
  assert.equal(ensureGhForgeConnector(store, dir), null);
});

test("ensureGhForgeConnector creates a source when a GitHub remote is present and gh is available", () => {
  const dir = mkdtempSync(join(tmpdir(), "cie-gh-"));
  execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/pay.git"], { stdio: "ignore" });
  const store = new Store(":memory:");
  const conn = ensureGhForgeConnector(store, dir);
  // This test may be skipped at runtime if gh is not installed or not authenticated.
  if (!conn) return;
  const h = conn.health();
  assert.equal(h.sourceId, "gh:acme/pay");
  // The source row should now exist and be queryable through the normal source list.
  const row = store.db.prepare("select id, kind, repo_root from ext_sources where id = ?").get(h.sourceId) as any;
  assert.ok(row);
  assert.equal(row.kind, "forge");
  assert.equal(row.repo_root, dir);
});
