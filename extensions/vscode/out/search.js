// F01 commands for the editor: "Find references in CIE" (and the plain search jump).
// The pure parts (which repository is this file's, how references become quick-picks, which symbol id a
// word maps to) live here without any vscode import, so they are testable with node --test.
/**
 * The repository this document belongs to, by the workspace root path the server registers.
 * An exact root match wins; otherwise the deepest ancestor match — so a document never lands in a
 * sibling repository by accident.
 */
export function repoForPath(repos, filePath) {
    if (!filePath)
        return null;
    const norm = filePath.replace(/\\/g, "/");
    const candidates = repos.filter((r) => !!r.root && (norm === r.root || norm.startsWith(r.root.endsWith("/") ? r.root : `${r.root}/`)));
    if (candidates.length === 0)
        return null;
    return candidates.sort((a, b) => b.root.length - a.root.length)[0];
}
export function relativeTo(root, filePath) {
    if (!filePath.startsWith(root.endsWith("/") ? root : root + "/"))
        return filePath.replace(/\\/g, "/");
    return filePath.slice((root.endsWith("/") ? root : root + "/").length).replace(/\\/g, "/");
}
export function refQuickPicks(refs) {
    return refs.map((r) => ({
        label: `${r.repositoryName}/${r.path}${r.display ? `:${r.display.line}` : ""}`,
        detail: [r.tier ? `tier: ${r.tier}` : "", r.viaPackage ? `via ${r.viaPackage}` : ""].filter(Boolean).join(" · "),
        location: { path: r.path, line: r.display?.line ?? 1, column: r.display?.column ?? 1 },
        viaPackage: r.viaPackage,
    }));
}
export async function postOp(baseUrl, component, op, body, fetchImpl = fetch) {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/v1/components/${component}/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json());
    if (!json.ok)
        throw new Error(`${json.error?.code}: ${json.error?.message}`);
    return json.value;
}
/**
 * A word in a file becomes the CIE symbol id the references API needs: symbol search first, exact
 * definition match preferred. Nothing here fabricates an id: a word with no indexed definition is an
 * honest "not indexed", never a guess.
 */
export async function symbolIdForWord(baseUrl, repositoryId, revision, word, fetchImpl = fetch) {
    const r = await postOp(baseUrl, "C10", "search", { query: word, mode: "SYMBOL", repositoryId, revision, limit: 20 }, fetchImpl);
    const exact = (r.hits ?? []).find((h) => h.matchKinds?.includes("SYMBOL_EXACT") && h.symbol?.symbolId);
    return exact?.symbol?.symbolId ?? (r.hits ?? []).find((h) => h.symbol?.symbolId)?.symbol?.symbolId ?? null;
}
export async function findReferences(baseUrl, repositoryId, revision, symbolId, fetchImpl = fetch) {
    return postOp(baseUrl, "C09", "findReferences", { repositoryId, revision, symbolId }, fetchImpl);
}
