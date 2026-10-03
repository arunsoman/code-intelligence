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

/** Commits that touched `rel`, newest first. */
export function fileLog(root: string, rel: string, limit = 40): Commit[] {
  const out = git(root, ["log", `-n${limit}`, "--no-renames", "--pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%s", "--", rel]);
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((l) => { const [hash, author, email, date, subject] = l.split("\x1f"); return { hash, author, email, date, subject }; });
}

/** Per-author commit counts for a file (de facto ownership), most active first. */
export function authorCounts(root: string, rel: string, limit = 200): { author: string; commits: number; last: string }[] {
  const by = new Map<string, { commits: number; last: string }>();
  for (const c of fileLog(root, rel, limit)) { const cur = by.get(c.author) ?? { commits: 0, last: c.date }; cur.commits++; if (c.date > cur.last) cur.last = c.date; by.set(c.author, cur); }
  return [...by].map(([author, v]) => ({ author, ...v })).sort((a, b) => b.commits - a.commits || a.author.localeCompare(b.author));
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
