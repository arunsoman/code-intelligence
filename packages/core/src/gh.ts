// C04-gh: GitHub CLI integration for reading a repository's pull requests and issues.
// Uses the locally installed `gh` command for authentication, so no token is ever stored
// or configured inside CIE. If `gh` is not installed or not authenticated, the source is
// silently skipped; an explicit gap is reported only when a commit names a PR whose
// content is not available.
import { execFileSync } from "node:child_process";
import { ForgeConnector, type HttpRequest, type HttpResponse, type Transport } from "./connectors.ts";
import type { Store } from "./store.ts";

export interface GhSlug { host: string; owner: string; repo: string }

/** Is the `gh` command available on this machine? */
export function isGhInstalled(): boolean {
  try { execFileSync("gh", ["--version"], { stdio: ["ignore", "ignore", "ignore"], timeout: 5_000 }); return true; }
  catch { return false; }
}

/** Ask `gh` for the currently active token. The token is read at call time and never stored. On a CI runner `gh`
 * may be absent while GITHUB_TOKEN (or GH_TOKEN) is injected by the workflow: accept those as a fallback, still
 * read at call time, never persisted. */
export function ghAuthToken(host = "github.com"): { ok: true; token: string } | { ok: false; reason: string } {
  try {
    const args = host === "github.com" ? ["auth", "token"] : ["auth", "token", "-h", host];
    const token = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim();
    if (!token) return { ok: false, reason: "gh auth token returned empty" };
    return { ok: true, token };
  } catch (e) {
    if (host === "github.com") {
      const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      if (env) return { ok: true, token: env };
    }
    return { ok: false, reason: String((e as Error).message ?? e).replace(/\n/g, "; ").slice(0, 200) };
  }
}

/** Ask `gh` whether it is authenticated and to which account. */
export function ghAuthStatus(host = "github.com"): { ok: true; user: string } | { ok: false; reason: string } {
  try {
    const args = host === "github.com" ? ["auth", "status"] : ["auth", "status", "-h", host];
    const out = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
    const m = /Logged in to\s+\S+\s+as\s+(\S+)/.exec(out) || /✓\s+Logged in to\s+\S+\s+account\s+(\S+)/.exec(out);
    if (!m) return { ok: false, reason: "could not parse gh auth status output" };
    return { ok: true, user: m[1] };
  } catch (e) {
    return { ok: false, reason: String((e as Error).message ?? e).replace(/\n/g, "; ").slice(0, 200) };
  }
}

/** Parse `owner/repo` out of a GitHub origin remote URL. */
export function parseGitHubRemote(url: string): GhSlug | null {
  const trimmed = url.trim();
  // git@github.com:owner/repo.git
  let m = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (m) return { host: m[1].toLowerCase(), owner: m[2], repo: m[3] };
  // https://github.com/owner/repo.git
  m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (m) return { host: m[1].toLowerCase(), owner: m[2], repo: m[3] };
  return null;
}

/** Read the `origin` remote of a local repository and, if it points to GitHub, return its slug. */
export function githubRemote(repoRoot: string): GhSlug | null {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
    return parseGitHubRemote(out);
  } catch { return null; }
}

/** Build the GitHub API base URL for a slug. GitHub Enterprise Server uses `/api/v3`. */
export function githubApiBase(slug: GhSlug): string {
  if (slug.host === "github.com") return "https://api.github.com";
  return `https://${slug.host}/api/v3`;
}

/** A transport that uses the token `gh` provides right now. Never stores the token. */
export function ghTransport(): Transport {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const host = new URL(req.url).host.toLowerCase();
    const tokenRes = ghAuthToken(host);
    if (!tokenRes.ok) return { status: 401, headers: {}, body: JSON.stringify({ message: tokenRes.reason }) };
    const headers: Record<string, string> = {
      authorization: `Bearer ${tokenRes.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
    for (const [k, v] of Object.entries(req.headers)) if (k.toLowerCase() !== "authorization") headers[k] = v;
    try {
      const res = await fetch(req.url, { method: req.method, headers });
      const body = await res.text();
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { outHeaders[k] = v; });
      return { status: res.status, headers: outHeaders, body };
    } catch (e) {
      return { status: 0, headers: {}, body: JSON.stringify({ message: String((e as Error).message ?? e) }) };
    }
  };
}

/**
 * If the repository has a GitHub `origin` remote and `gh` is authenticated,
 * register a forge source for it. The source id is `gh:owner/repo`.
 * Returns the connector so callers can ingest, or `null` when no source applies.
 */
export function ensureGhForgeConnector(store: Store, repoRoot: string): ForgeConnector | null {
  const slug = githubRemote(repoRoot);
  if (!slug) return null;
  if (!isGhInstalled()) return null;
  if (!ghAuthStatus(slug.host).ok) return null;
  const id = `gh:${slug.owner}/${slug.repo}`;
  const baseUrl = `${githubApiBase(slug)}/repos/${slug.owner}/${slug.repo}`;
  return new ForgeConnector(store, {
    sourceId: id,
    baseUrl,
    repoRoot,
    transport: ghTransport(),
    token: () => { const t = ghAuthToken(slug.host); return t.ok ? t.token : null; },
  });
}
