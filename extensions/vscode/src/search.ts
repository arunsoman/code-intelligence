// F01 commands for the editor: "Find references in CIE" (and the plain search jump).
// The pure parts (which repository is this file's, how references become quick-picks, which symbol id a
// word maps to) live here without any vscode import, so they are testable with node --test.

export interface RepoView {
  repositoryId: string;
  displayName: string;
  root: string | null;
  state: string;
}

/**
 * The repository this document belongs to, by the workspace root path the server registers.
 * An exact root match wins; otherwise the deepest ancestor match — so a document never lands in a
 * sibling repository by accident.
 */
export function repoForPath(repos: RepoView[], filePath: string): RepoView | null {
  if (!filePath) return null;
  const norm = filePath.replace(/\\/g, "/");
  const candidates = repos.filter((r) => !!r.root && (norm === r.root || norm.startsWith(r.root.endsWith("/") ? r.root : `${r.root}/`)));
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.root!.length - a.root!.length)[0];
}

export function relativeTo(root: string, filePath: string): string | null {
  if (!filePath.startsWith(root.endsWith("/") ? root : root + "/")) return filePath.replace(/\\/g, "/");
  return filePath.slice((root.endsWith("/") ? root : root + "/").length).replace(/\\/g, "/");
}

/** What the QuickPick shows: where, how far to trust it, and through what cross-repository binding. */
export interface RefPickRow {
  label: string;
  detail: string;
  location: { path: string; line: number; column: number };
  viaPackage?: string;
}

export function refQuickPicks(refs: { repositoryName: string; path: string; display?: { line: number; column: number }; tier?: string; viaPackage?: string }[]): RefPickRow[] {
  return refs.map((r) => ({
    label: `${r.repositoryName}/${r.path}${r.display ? `:${r.display.line}` : ""}`,
    detail: [r.tier ? `tier: ${r.tier}` : "", r.viaPackage ? `via ${r.viaPackage}` : ""].filter(Boolean).join(" · "),
    location: { path: r.path, line: r.display?.line ?? 1, column: r.display?.column ?? 1 },
    viaPackage: r.viaPackage,
  }));
}

/** The wire types, mirrored from @cie/schema (the extension does not depend on the monorepo at runtime). */
export interface WireRefResponse {
  ok: boolean;
  value?: { references: { repositoryId: string; repositoryName: string; path: string; display?: { line: number; column: number }; tier?: string; viaPackage?: string; refKind: string }[]; nextCursor?: string; unresolvedCallSites: { repositoryId: string; count: number }[]; reExportTruncated?: boolean; gaps: string[] };
  error?: { code: string; message: string };
}

export interface WireSearchResponse {
  ok: boolean;
  value?: { hits: { repositoryId: string; revision: string; symbol?: { symbolId: string }; path: string; display?: { line: number; column: number }; tier?: string; matchKinds: string[] }[] };
  error?: { code: string; message: string };
}

export async function postOp<T>(baseUrl: string, component: string, op: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/v1/components/${component}/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as { ok: boolean; value?: T; error?: { code: string; message: string } };
  if (!json.ok) throw new Error(`${json.error?.code}: ${json.error?.message}`);
  return json.value as T;
}

/**
 * A word in a file becomes the CIE symbol id the references API needs: symbol search first, exact
 * definition match preferred. Nothing here fabricates an id: a word with no indexed definition is an
 * honest "not indexed", never a guess.
 */
export async function symbolIdForWord(baseUrl: string, repositoryId: string, revision: string, word: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const r = await postOp<NonNullable<WireSearchResponse["value"]>>(baseUrl, "C10", "search", { query: word, mode: "SYMBOL", repositoryId, revision, limit: 20 }, fetchImpl);
  const exact = (r.hits ?? []).find((h) => h.matchKinds?.includes("SYMBOL_EXACT") && h.symbol?.symbolId);
  return exact?.symbol?.symbolId ?? (r.hits ?? []).find((h) => h.symbol?.symbolId)?.symbol?.symbolId ?? null;
}

export async function findReferences(baseUrl: string, repositoryId: string, revision: string, symbolId: string, fetchImpl: typeof fetch = fetch): Promise<WireRefResponse["value"]> {
  return postOp<NonNullable<WireRefResponse["value"]>>(baseUrl, "C09", "findReferences", { repositoryId, revision, symbolId }, fetchImpl);
}