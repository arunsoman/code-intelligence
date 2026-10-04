// F06 WP-01: scripted real-git repositories with deterministic histories — renames, bulk format
// commits, bot bumps, revert pairs, squash and merge-commit workflows, shallow clones, force pushes.
// Every step is a plain commit on a branch; every command runs without a shell.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Step {
  subject: string;
  /** Committer and author date, ISO-8601 with an offset (git accepts `2026-08-01T10:00:00Z`). */
  date: string;
  author?: { name: string; email: string };
  /** Write (or overwrite) these files, paths relative to the repository root. */
  files?: Record<string, string>;
  delete?: string[];
  /** `git mv` with an optional content edit afterwards (controls rename similarity). */
  rename?: { from: string; to: string; content?: string }[];
  /** Commit on a branch instead of the working branch; branches start from HEAD unless built earlier. */
  branch?: string;
  /** After committing, merge `branch` into this branch with a real merge commit (second parent). */
  mergeInto?: string;
}

const BASE = mkdtempSync(join(tmpdir(), "cie-f06-"));
process.on("exit", () => { try { rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ } });

const g = (dir: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: input === undefined ? ["ignore", "pipe", "ignore"] : ["pipe", "pipe", "ignore"], env: { ...process.env, ...env }, input });

/** Built repository directory name → absolute path. Same steps → same commit hashes (fixed dates/authors). */
export function scriptedRepo(purpose: string, steps: Step[]): string {
  const n = Math.abs([...`${purpose}:${steps.length}:${steps.at(0)?.subject ?? ""}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));
  const dir = join(BASE, purpose.replace(/[^a-zA-Z0-9-]+/g, "-"), String(n));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  g(dir, ["init", "-q", "-b", "main"]);
  const made: string[] = [];
  let current = "main";
  for (const s of steps) {
    if (s.mergeInto) {
      // A merge step does not commit its own files: it merges `branch` (or the current branch) into `mergeInto`.
      const src = s.branch ?? current;
      if (!made.includes(src) && src !== "main") throw new Error(`merge source '${src}' must have been built with branch: earlier`);
      if (s.mergeInto !== current) {
        if (!made.includes(s.mergeInto) && s.mergeInto !== "main") throw new Error(`mergeInto '${s.mergeInto}' must have been built with branch: earlier`);
        g(dir, ["checkout", "-q", s.mergeInto]);
      }
      const when = new Date(new Date(s.date).getTime() + 60_000).toISOString().replace(/\.\d+/, "");
      const name2 = s.author?.name ?? "Dana", email2 = s.author?.email ?? "dana@example.com";
      g(dir, ["merge", "-q", "--no-ff", "--no-edit", "-m", s.subject, src], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_AUTHOR_NAME: name2, GIT_AUTHOR_EMAIL: email2, GIT_COMMITTER_NAME: name2, GIT_COMMITTER_EMAIL: email2 });
      current = s.mergeInto;
      continue;
    }
    const target = s.branch ?? "main";
    if (target !== current) {
      if (target === "main" || made.includes(target)) g(dir, ["checkout", "-q", target]);
      else { g(dir, ["checkout", "-q", "-b", target, "main"]); made.push(target); }
      current = target;
    }
    if (s.delete?.length) g(dir, ["rm", "-qrf", "--", ...s.delete]);
    for (const [rel, content] of Object.entries(s.files ?? {})) {
      if (dirname(rel) !== ".") mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    for (const r of s.rename ?? []) {
      if (dirname(r.to) !== ".") mkdirSync(join(dir, dirname(r.to)), { recursive: true });
      g(dir, ["mv", r.from, r.to]);
      if (r.content !== undefined) writeFileSync(join(dir, r.to), r.content);
    }
    const name = s.author?.name ?? "Dana", email = s.author?.email ?? "dana@example.com";
    const dates = { GIT_AUTHOR_DATE: s.date, GIT_COMMITTER_DATE: s.date, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    g(dir, ["add", "-A"]);
    g(dir, ["commit", "-q", "--allow-empty", "-m", s.subject], dates);
  }
  if (current !== "main") g(dir, ["checkout", "-q", "main"]);
  return dir;
}

export const head = (root: string): string => g(root, ["rev-parse", "HEAD"]).trim();
export const commitCount = (root: string): number => Number(g(root, ["rev-list", "--count", "HEAD"]).trim());
export const isShallow = (root: string): boolean => g(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true";

/** `git clone --depth 1` of a built repository — the shallow (F06-D4) fixture. */
export function shallowCopyOf(root: string): string {
  const dir = join(BASE, "shallow-of-" + root.split("-").slice(-1)[0]);
  rmSync(dir, { recursive: true, force: true });
  // --no-local: without it a local clone ignores --depth (git copies the object store, not a wire fetch).
  execFileSync("git", ["clone", "-q", "--no-local", "--depth", "1", root, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return dir;
}

/** Rewrite main to a new commit from an older base — a force push, without a server. */
export function forcePushTo(root: string, oldCommitsBack: number, subject: string): string {
  g(root, ["checkout", "-q", "--detach", `HEAD~${oldCommitsBack}`]);
  const dates = { GIT_AUTHOR_DATE: "2027-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2027-01-01T00:00:00Z", GIT_AUTHOR_NAME: "Eve", GIT_AUTHOR_EMAIL: "eve@example.com", GIT_COMMITTER_NAME: "Eve", GIT_COMMITTER_EMAIL: "eve@example.com" };
  writeFileSync(join(root, "rewrite.txt"), subject + "\n");
  g(root, ["add", "-A"]);
  g(root, ["commit", "-q", "-m", subject], dates);
  const id = head(root);
  g(root, ["checkout", "-q", "main"]);
  g(root, ["reset", "-q", "--hard", id]);
  return id;
}

export const readFileAt = (root: string, rel: string): string => { try { return readFileSync(join(root, rel), "utf8"); } catch { return ""; } };
export const gitIn = g;
export const cleanupDir = (dir: string) => rmSync(dir, { recursive: true, force: true });