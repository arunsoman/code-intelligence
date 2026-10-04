// F01 editor-side tests: the pure parts of "Find references in CIE" — repository discovery by path,
// the QuickPick rows with their tier/viaPackage honesty labels, and symbolId resolution that never
// fabricates an id. The thin vscode wiring itself is covered by hand on the bench machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findReferences, refQuickPicks, repoForPath, relativeTo, symbolIdForWord } from "../src/search.ts";

test("repoForPath: exact root wins, deeper ancestors win over shallower, cross-repo neighbours never collide", () => {
  const repos = [
    { repositoryId: "repo:a", displayName: "main", root: "/work/main", state: "ACTIVE" },
    { repositoryId: "repo:b", displayName: "vendor", root: "/work/main/vendor/sub", state: "ACTIVE" },
    { repositoryId: "repo:c", displayName: "elsewhere", root: "/work/mainx", state: "ACTIVE" },
  ];
  assert.equal(repoForPath(repos, "/work/main/src/a.ts")!.repositoryId, "repo:a", "the container repository for a plain path");
  assert.equal(repoForPath(repos, "/work/main/vendor/sub/x.ts")!.repositoryId, "repo:b", "the deepest registered ancestor wins");
  assert.equal(repoForPath(repos, "/work/mainx/src/a.ts")!.repositoryId, "repo:c", "a sibling whose name is a prefix is its own repository");
  assert.equal(repoForPath(repos, "/nowhere/file.ts"), null, "unknown paths are nothing, not the first repository");
  assert.equal(repoForPath(repos, ""), null, "an empty path is nothing");
});

test("relativeTo makes paths portable between editor and server vocabularies", () => {
  assert.equal(relativeTo("/work/main", "/work/main/src/a.ts"), "src/a.ts");
  assert.equal(relativeTo("/work/main", "/work/main/other.ts"), "other.ts");
  assert.equal(relativeTo("/work/mainx", "/work/mainx/deep/b.ts"), "deep/b.ts");
  assert.equal(relativeTo("/work/main", "src/already-relative.ts"), "src/already-relative.ts");
});

test("refQuickPicks: labels carry where, details carry the tier and the cross-repository binding", () => {
  const picks = refQuickPicks([
    { repositoryName: "main", path: "src/a.ts", display: { line: 7, column: 3 }, tier: "RESOLVED" },
    { repositoryName: "vendor", path: "src/use.ts", display: { line: 2, column: 15 }, tier: "HEURISTIC", viaPackage: "npm:vendor-pkg@^2" },
  ]);
  assert.match(picks[0].label, /^main\/src\/a\.ts:7$/, "label = repository/path:line");
  assert.match(picks[0].detail, /^tier: RESOLVED$/, "the tier is stated");
  assert.match(picks[1].label, /^vendor\/src\/use\.ts:2$/);
  assert.match(picks[1].detail, /via npm:vendor-pkg/, "a cross-repository row says what carried it");
  assert.deepEqual(picks[1].location, { path: "src/use.ts", line: 2, column: 15 }, "the location opens the exact line");
});

test("symbolIdForWord: exact symbol match is preferred; a word that is not indexed is null — never a guess", async () => {
  const calls: { body: any }[] = [];
  const fakeFetch = (async (_url: any, init: any) => {
    calls.push({ body: JSON.parse(init.body) });
    const q = calls[calls.length - 1].body;
    if (q.mode !== "SYMBOL") return { ok: true, status: 200, json: async () => ({ ok: false }) } as any;
    if (q.query === "nothere") return { ok: true, status: 200, json: async () => ({ ok: true, value: { hits: [] } }) } as any;
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, value: { hits: [
        { repositoryId: "repo:a", revision: "rev", path: "src/a.ts", display: { line: 3, column: 1 }, tier: "RESOLVED", matchKinds: ["SYMBOL_QUALIFIED"], symbol: { symbolId: "method:src/a.ts#C.work" } },
        { repositoryId: "repo:a", revision: "rev", path: "src/b.ts", display: { line: 4, column: 1 }, tier: "RESOLVED", matchKinds: ["SYMBOL_EXACT"], symbol: { symbolId: "function:src/b.ts#work" } },
      ] } }),
    } as any;
  }) as unknown as typeof fetch;
  const id = await symbolIdForWord("http://127.0.0.1:1", "repo:a", "rev", "work", fakeFetch);
  assert.equal(id, "function:src/b.ts#work", "the exact match wins over the qualified one");
  const none = await symbolIdForWord("http://127.0.0.1:1", "repo:a", "rev", "nothere", fakeFetch);
  assert.equal(none, null, "not indexed is null, honestly");
});

test("findReferences posts the C09 op and surfaces the server errors by name", async () => {
  const fakeFetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (body.symbolId === "missing") return { ok: true, status: 200, json: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "unknown symbol" } }) } as any;
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { references: [], unresolvedCallSites: [{ repositoryId: "repo:other", count: 3 }], gaps: ["x"] } }) } as any;
  }) as unknown as typeof fetch;
  const r = await findReferences("http://127.0.0.1:1", "repo:a", "rev", "function:a#x", fakeFetch);
  assert.deepEqual(r!.unresolvedCallSites, [{ repositoryId: "repo:other", count: 3 }], "unresolved call-site counts travel to the editor");
  await assert.rejects(() => findReferences("http://127.0.0.1:1", "repo:a", "rev", "missing", fakeFetch), /NOT_FOUND: unknown symbol/, "errors surface with their code");
});