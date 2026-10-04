// Read-only git and ownership information for the history-based forms (archaeology, ownership, change risk).
// Every command is run without a shell, with a timeout, and only ever reads.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const git = (root: string, args: string[], max = 4 * 1024 * 1024): string | null => {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 15_000, maxBuffer: max, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
};

export interface Commit { hash: string; author: string; email: string; date: string; subject: string }

export function isGitRepo(root: string): boolean { return git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true"; }

/** The repository's current HEAD commit (full hash); null when it is not a git work tree or has no commits. */
export function headOf(root: string): string | null { return git(root, ["rev-parse", "HEAD"])?.trim() || null; }

// ------------------------------------------------------------------ repository-wide history index
// One `git log --name-only` pass groups every commit by the files it touched, so history-based forms
// (change risk, ownership, archaeology fallbacks) read the whole repository with a bounded number of
// git processes instead of starting one per file. The index is cached per repository and invalidated
// when a new revision is indexed, so a repository that advances is never served stale history.
interface HistoryIndex { limit: number; byFile: Map<string, Commit[]> }
const historyIndexCache = new Map<string, HistoryIndex>();

/** Drop the cached history for one repository, or for every repository when called with no argument. */
export function clearHistoryCache(root?: string): void {
  if (root === undefined) historyIndexCache.clear(); else historyIndexCache.delete(root);
}

const HISTORY_INDEX_MIN = 200;
function buildHistoryIndex(root: string, limit: number): HistoryIndex | null {
  const out = git(root, ["log", `-n${limit}`, "--no-renames", "--name-only", "--pretty=format:@@%H%x1f%an%x1f%ae%x1f%aI%x1f%s"], 32 * 1024 * 1024);
  if (out === null) return null;
  const byFile = new Map<string, Commit[]>();
  let current: Commit | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) { const [hash, author, email, date, subject] = line.slice(2).split("\x1f"); current = { hash, author, email, date, subject }; }
    else if (line.trim() && current) { const rel = line.trim(); const list = byFile.get(rel); if (list) list.push(current); else byFile.set(rel, [current]); }
  }
  return { limit, byFile };
}

function repoHistory(root: string, limit: number): HistoryIndex | null {
  const cached = historyIndexCache.get(root);
  if (cached && cached.limit >= limit) return cached;
  const built = buildHistoryIndex(root, Math.max(limit, HISTORY_INDEX_MIN));
  if (built) historyIndexCache.set(root, built);
  return built;
}

/** Commits that touched `rel`, newest first. Served from the repository-wide index when available. */
export function fileLog(root: string, rel: string, limit = 40): Commit[] {
  const index = repoHistory(root, limit);
  if (index) return (index.byFile.get(rel) ?? []).slice(0, limit);
  const out = git(root, ["log", `-n${limit}`, "--no-renames", "--pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%s", "--", rel]);
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((l) => { const [hash, author, email, date, subject] = l.split("\x1f"); return { hash, author, email, date, subject }; });
}

/** Per-file history summaries, keyed by repository-relative path. The shape and the 500-commit cap
 *  match the worker's index-time history, so a refresh replaces the facts with like for like. */
export interface FileHistory { commits: number; lastCommit: string; lastAuthor: string; lastDate: string; lastSubject: string; authors: number }
export function fileHistory(root: string, limit = 500): Map<string, FileHistory> {
  const out = new Map<string, FileHistory>();
  const index = repoHistory(root, limit);
  if (!index) return out;
  for (const [rel, commits] of index.byFile) {
    if (!commits.length) continue;
    const last = commits[0];
    out.set(rel, { commits: commits.length, lastCommit: last.hash, lastAuthor: last.author, lastDate: last.date, lastSubject: last.subject, authors: new Set(commits.map((c) => c.author)).size });
  }
  return out;
}

/** Per-author commit counts for a file (de facto ownership), most active first. */
export function authorCounts(root: string, rel: string, limit = 200): { author: string; commits: number; last: string }[] {
  const by = new Map<string, { commits: number; last: string }>();
  for (const c of fileLog(root, rel, limit)) { const cur = by.get(c.author) ?? { commits: 0, last: c.date }; cur.commits++; if (c.date > cur.last) cur.last = c.date; by.set(c.author, cur); }
  return [...by].map(([author, v]) => ({ author, ...v })).sort((a, b) => b.commits - a.commits || a.author.localeCompare(b.author));
}

/** A pull request or issue reference in a commit subject: squash-merges say "(#123)", bodies say "fixes #42". */
export interface ForgeRef { number: number; kind: "pr" | "issue" }
export function forgeRefs(subject: string): ForgeRef[] {
  const out: ForgeRef[] = [];
  const pr = subject.match(/\(#(\d+)\)/); // squash-merge convention: the PR number in parentheses
  if (pr) out.push({ number: Number(pr[1]), kind: "pr" });
  for (const m of subject.matchAll(/(?<![(\w])#(\d+)\b/g)) { const n = Number(m[1]); if (!out.some((x) => x.number === n)) out.push({ number: n, kind: "issue" }); }
  return out.slice(0, 3);
}

/** Commits in the repository, newest first, with the files each touched (names only). */
export function recentCommits(root: string, limit = 60): (Commit & { files: string[] })[] {
  const out = git(root, ["log", `-n${limit}`, "--no-renames", "--name-only", "--pretty=format:@@%H%x1f%an%x1f%ae%x1f%aI%x1f%s"]);
  if (!out) return [];
  const commits: (Commit & { files: string[] })[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) { const [hash, author, email, date, subject] = line.slice(2).split("\x1f"); commits.push({ hash, author, email, date, subject, files: [] }); }
    else if (line.trim() && commits.length) commits[commits.length - 1].files.push(line.trim());
  }
  return commits;
}

export interface OwnerRule { pattern: string; owners: string[]; line: number; re: RegExp }
const globToRe = (pattern: string): RegExp => {
  let p = pattern.trim();
  const anchored = p.startsWith("/");
  p = p.replace(/^\//, "");
  const dir = p.endsWith("/");
  const src = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${src}${dir ? ".*" : "(?:/.*)?"}$`);
};

/** CODEOWNERS from the usual places; the last matching rule wins, as on GitHub. */
export function codeowners(root: string): { rules: OwnerRule[]; path: string | null } {
  for (const rel of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    try {
      const rules: OwnerRule[] = [];
      readFileSync(abs, "utf8").split(/\r?\n/).forEach((raw, i) => {
        const line = raw.replace(/#.*/, "").trim();
        if (!line) return;
        const [pattern, ...owners] = line.split(/\s+/);
        if (pattern && owners.length) rules.push({ pattern, owners, line: i + 1, re: globToRe(pattern) });
      });
      return { rules, path: rel };
    } catch { /* unreadable: treat as absent */ }
  }
  return { rules: [], path: null };
}
export const ownersOf = (rules: OwnerRule[], rel: string): OwnerRule | null => { let hit: OwnerRule | null = null; for (const r of rules) if (r.re.test(rel)) hit = r; return hit; };

/**
 * Optional team-membership map (post-MVP): `.github/teams.json` maps a CODEOWNERS team handle
 * (`@payments-team`, the `@` optional) to its members. No network is used; if the file is absent
 * or malformed, team membership stays unknown and the ownership claim says so.
 */
export function teamMembers(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const rel of [".github/teams.json", "teams.json", ".github/CODEOWNERS.teams.json"]) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    try {
      const raw = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
      for (const [team, members] of Object.entries(raw)) {
        if (!Array.isArray(members)) continue;
        const names = members.filter((m): m is string => typeof m === "string").slice(0, 20);
        const handle = team.startsWith("@") ? team : `@${team}`;
        if (names.length) out.set(handle.toLowerCase(), names);
      }
      return out;
    } catch { /* malformed: treat as absent */ }
  }
  return out;
}

/** Comments that explain a symbol: the block directly above it, and TODO/FIXME/HACK/NOTE/deliberate remarks inside it. */
export interface CodeComment { text: string; line: number; startByte: number; endByte: number; kind: "doc" | "marker" | "remark" }
export function commentsAround(source: string, startByte: number, endByte: number): CodeComment[] {
  const out: CodeComment[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const byteOf = (charIdx: number) => Buffer.byteLength(source.slice(0, charIdx), "utf8");
  const startChar = Buffer.from(source, "utf8").subarray(0, startByte).toString("utf8").length;
  const endChar = Buffer.from(source, "utf8").subarray(0, endByte).toString("utf8").length;
  const lineOfChar = (c: number) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= c) lo = m; else hi = m - 1; } return lo; };
  const text = (l: number) => source.slice(lineStarts[l], l + 1 < lineStarts.length ? lineStarts[l + 1] - 1 : source.length);
  // block directly above
  let l = lineOfChar(startChar) - 1;
  const above: number[] = [];
  while (l >= 0 && /^\s*(\/\/|\/\*|\*)/.test(text(l))) { above.unshift(l); l--; }
  if (above.length) out.push({ text: above.map((x) => text(x).replace(/^\s*(\/\/+|\/\*+|\*+\/?|\*)\s?/, "").replace(/\*\/\s*$/, "").trim()).filter(Boolean).join(" "), line: above[0] + 1, startByte: byteOf(lineStarts[above[0]]), endByte: byteOf(lineStarts[above[above.length - 1]] + text(above[above.length - 1]).length), kind: "doc" });
  for (let x = lineOfChar(startChar); x <= lineOfChar(Math.max(startChar, endChar - 1)); x++) {
    const t = text(x), m = /\/\/\s*(.*)$/.exec(t);
    if (!m || !m[1].trim()) continue;
    const marker = /\b(TODO|FIXME|HACK|XXX|NOTE|WARNING|deliberately|on purpose|workaround|do not|don't|must not|legacy)\b/i.test(m[1]);
    const at = lineStarts[x] + (m.index ?? 0);
    out.push({ text: m[1].trim(), line: x + 1, startByte: byteOf(at), endByte: byteOf(lineStarts[x] + t.length), kind: marker ? "marker" : "remark" });
  }
  return out.filter((c) => c.text.length > 0);
}

/** Commits that touched specific lines of a file (`git log -L`), newest first; falls back to the whole file. */
export function symbolLog(root: string, rel: string, startLine: number, endLine: number, limit = 30): { commits: Commit[]; precise: boolean } {
  const out = git(root, ["log", `-n${limit}`, "--no-renames", "--pretty=format:%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%s", "-L", `${startLine},${endLine}:${rel}`], 8 * 1024 * 1024);
  if (out) {
    const commits = out.split("\x1e").filter((x) => x.includes("\x1f")).map((chunk) => { const [hash, author, email, date, subject] = chunk.split("\n")[0].split("\x1f"); return { hash, author, email, date, subject }; });
    if (commits.length) return { commits, precise: true };
  }
  return { commits: fileLog(root, rel, limit), precise: false };
}
