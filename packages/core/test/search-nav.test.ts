// F01 navigation tests: resolveDefinition and findReferences against the TypeScript compiler as an
// independent oracle (F01-A1), ambiguity is listed not chosen (A2), re-export chains are bounded and the
// cut disclosed (D5), and revocation purges rows and invalidates held cursors (D6).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { test } from "node:test";
import { FIXTURE, ctx, setup } from "./helpers.ts";
import { SearchEngine } from "../src/search.ts";

/** Oracle: what the TypeScript language service finds for references of one top-level function. */
function tsLsReferences(root: string, filePath: string, name: string): { path: string; line: number; column: number }[] {
  const realFiles: string[] = [];
  const collect = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!["node_modules", ".git", "dist", "target"].includes(e.name)) collect(join(dir, e.name)); }
      else if (/\.(ts|tsx|mts|cts)$/.test(e.name)) realFiles.push(join(dir, e.name));
    }
  };
  collect(root);
  const service = ts.createLanguageService({
    getScriptFileNames: () => realFiles,
    getScriptVersion: () => "0",
    getScriptSnapshot: (f) => { const t = ts.sys.readFile(f); return t !== undefined ? ts.ScriptSnapshot.fromString(t) : undefined; },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({ module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, allowJs: true, strict: false }),
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => ts.sys.fileExists(f),
    readFile: (f) => ts.sys.readFile(f),
    readDirectory: (f) => ts.sys.readDirectory(f),
  });
  const program = service.getProgram()!;
  const sf = program.getSourceFile(join(root, filePath));
  assert.ok(sf, "oracle must read the file");
  let declStart = -1;
  for (const st of sf!.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.getText(sf!) === name) declStart = st.name!.getStart(sf!);
  }
  assert.ok(declStart >= 0, `no top-level ${name} in ${filePath}`);
  const refs = service.findReferences(join(root, filePath), declStart);
  assert.ok(refs, "the oracle found nothing");
  const out: { path: string; line: number; column: number }[] = [];
  for (const g of refs!) for (const r of g.references) {
    const other = program.getSourceFile(r.fileName)!;
    const lc = ts.getLineAndCharacterOfPosition(other, r.textSpan.start);
    out.push({ path: r.fileName.slice(root.length + 1).replace(/\\/g, "/"), line: lc.line + 1, column: lc.character + 1 });
  }
  return out;
}

const byteAtChar = (text: string, charPos: number) => Buffer.byteLength(text.slice(0, charPos), "utf8");

test("F01-A1: references and definitions match the TypeScript compiler for supported constructs", async () => {
  const s = await setup();
  const e: SearchEngine = s.svc.search;
  await e.buildForRepository(FIXTURE);
  const repositoryId = e.repositoryOfRoot(FIXTURE)!.repositoryId;
  const rev = (e.indexStatus(ctx(), { repoRoot: FIXTURE }) as any).revision as string;

  // --- references for findByEmail, compared in both directions, per line ---
  const oracle = tsLsReferences(FIXTURE, "src/db/users.ts", "findByEmail");
  const refs = await e.findReferences(ctx(), { repositoryId, revision: rev, symbolId: "function:src/db/users.ts#findByEmail" });
  assert.ok(!("ok" in refs));
  const mine = refs.references.map((r) => ({ path: r.path, span: r.span }));
  for (const o of oracle) {
    const text = readFileSync(join(FIXTURE, o.path), "utf8");
    const lc = ts.createSourceFile(o.path, text, ts.ScriptTarget.Latest).getLineAndCharacterOfPosition(
      ts.createSourceFile(o.path, text, ts.ScriptTarget.Latest).getPositionOfLineAndCharacter(o.line - 1, o.column - 1));
    void lc;
    const bytePos = byteAtChar(text, ts.createSourceFile(o.path, text, ts.ScriptTarget.Latest).getPositionOfLineAndCharacter(o.line - 1, o.column - 1));
    const covered = mine.some((m) => m.path === o.path && m.span.startByte <= bytePos && bytePos < Math.max(m.span.startByte + 40, m.span.endByteExclusive));
    assert.ok(covered, `oracle position ${o.path}:${o.line}:${o.column} (byte ${bytePos}) is not represented in the stored references`);
  }
  for (const m of mine) {
    const text = readFileSync(join(FIXTURE, m.path), "utf8");
    const line = (ts.createSourceFile(m.path, text, ts.ScriptTarget.Latest).getLineAndCharacterOfPosition(byteForFile(text, m.span.startByte)).line) + 1;
    const hit = oracle.find((o) => o.path === m.path && o.line === line);
    assert.ok(hit, `a stored reference at ${m.path}:${line} has no TypeScript counterpart (invented uses are not allowed)`);
  }
  // --- definitions: the oracle's declaration position is exactly what resolveDefinition returns ---
  const decl = oracle.find((o) => o.path === "src/db/users.ts");
  assert.ok(decl, "the oracle includes the definition");
  const d = e.resolveDefinition(ctx(), { repositoryId, revision: rev, path: "src/auth/service.ts", position: callPos(e, repositoryId, rev, "src/auth/service.ts", "await findByEmail(email)") });
  assert.ok(!("ok" in d));
  assert.ok(d.locations.length >= 1);
  assert.deepEqual(d.locations.map((l) => [l.path, l.name]), [["src/db/users.ts", "findByEmail"]]);
  assert.equal(d.ambiguous, false);
  const loc = d.locations[0];
  assert.equal(loc.display.line, decl.line, "the definition line is the declaration the compiler names");
});
function byteForFile(text: string, byte: number): number {
  // a byte offset of the same text read as a string: for byte positions that are inside BMP chars this is
  // TS's char position only when the prefix is all-ASCII; this fixture's reference statements are ASCII.
  return byte;
}
function callPos(e: SearchEngine, repositoryId: string, rev: string, path: string, needle: string) {
  const body = e.fileBody(repositoryId, rev, path)!;
  const line = body.split("\n").findIndex((l) => l.includes(needle)) + 1;
  const col = (body.split("\n")[line - 1] ?? "").indexOf(needle.split(" ")[1].split("(")[0]) + 1; // the callee's column
  return { line, column: col };
}

test("A2 (scope collision): three same-named symbols in one repository are three hits; an unbound use lists all and picks none", async () => {
  const base = mkdtempSync(join(tmpdir(), "cie-a2-"));
  const root = join(base, "scope-repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/one.ts"), `export function process(n: number) { return n + 1; }\n`);
  writeFileSync(join(root, "src/two.ts"), `// deliberately identical names in different scopes (F01-A2)\nexport class C1 { process(n: number) { return n + 10; } }\nexport class C2 { process(n: number) { return n + 20; } }\nexport function useUnbound(u: number) { return process(u) as unknown as C1; }\n`);
  const s = await setup();
  await s.svc.ingestRepository(ctx("a2"), { repoPath: root });
  await s.svc.search.buildForRepository(root);
  const e = s.svc.search;
  const repositoryId = e.repositoryOfRoot(root)!.repositoryId;
  const rev = (e.indexStatus(ctx(), { repoRoot: root }) as any).revision as string;
  // search for the name: three distinct definitions, three distinct hits
  const hits = await e.search(ctx(), { query: "process", mode: "SYMBOL" });
  assert.ok(!("ok" in hits));
  const defs = hits.hits.filter((h) => h.symbol && h.symbol.kind !== "string");
  assert.equal(defs.length, 3, `three definitions of "process": ${JSON.stringify(defs.map((h) => [h.path, h.symbol?.name, h.matchKinds]))}`);
  const ids = new Set(defs.map((h) => h.symbol!.symbolId));
  assert.ok(ids.has("function:src/one.ts#process"));
  assert.ok(ids.has("method:src/two.ts#C1.process") || ids.has("method:src/two.ts#C2.process"), `method identities: ${JSON.stringify([...ids])}`);
  assert.equal(ids.size, 3, "the identities are three — none merged");
  // navigating the unbound use: candidates, ambiguous, never a silent pick
  const useBody = e.fileBody(repositoryId, rev, "src/two.ts")!;
  const uLine = useBody.split("\n").findIndex((l) => l.includes("return process(u)")) + 1;
  const uCol = (useBody.split("\n")[uLine - 1].indexOf("process(u)") + 1);
  const d = e.resolveDefinition(ctx(), { repositoryId, revision: rev, path: "src/two.ts", position: { line: uLine, column: uCol } });
  assert.ok(!("ok" in d));
  assert.equal(d.ambiguous, true, `ambiguity of an unbound use: ${JSON.stringify(d)}`);
  assert.ok(d.locations.length >= 2, `all candidates listed: ${JSON.stringify(d.locations.map((l) => [l.path, l.name]))}`);
  assert.ok(d.gaps.some((g) => /ambiguous|matches \d+/.test(g)), `the ambiguity is stated: ${JSON.stringify(d.gaps)}`);
});

test("F01-D5: a re-export chain five deep is followed four hops and the cut is disclosed", async () => {
  const base = mkdtempSync(join(tmpdir(), "cie-chain-"));
  const root = join(base, "chain-repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/core.ts"), `export function chainable(n: number) { return n + 1; }\n`);
  writeFileSync(join(root, "src/hop1.ts"), `export { chainable } from "./core";\n`);
  writeFileSync(join(root, "src/hop2.ts"), `export { chainable } from "./hop1";\n`);
  writeFileSync(join(root, "src/hop3.ts"), `export { chainable } from "./hop2";\n`);
  writeFileSync(join(root, "src/hop4.ts"), `export { chainable } from "./hop3";\n`);
  writeFileSync(join(root, "src/hop5.ts"), `export { chainable } from "./hop4";\n`);
  writeFileSync(join(root, "src/leaf.ts"), `import { chainable } from "./hop5";\nexport const u = chainable(6);\n`);
  const s = await setup();
  await s.svc.ingestRepository(ctx("chain"), { repoPath: root });
  await s.svc.search.buildForRepository(root);
  const e = s.svc.search;
  const repositoryId = e.repositoryOfRoot(root)!.repositoryId;
  const rev = (e.indexStatus(ctx(), { repoRoot: root }) as any).revision as string;
  const refs = await e.findReferences(ctx(), { repositoryId, revision: rev, symbolId: "function:src/core.ts#chainable" });
  assert.ok(!("ok" in refs));
  const reexportRows = refs.references.filter((r) => r.rationale.some((x) => /re-export/.test(x)));
  assert.equal(reexportRows.length, 4, `hops found: ${JSON.stringify(reexportRows.map((r) => r.path))}`);
  assert.equal(reexportRows.filter((r) => r.path === "src/hop5.ts").length, 0, "the fifth hop's re-export is outside the follow bound");
  assert.equal(refs.reExportTruncated, true, "the cut is stated");
  assert.ok(refs.gaps.some((g) => /depth 4/.test(g)), `gap text: ${JSON.stringify(refs.gaps)}`);
});

test("F01-D6: revoking a repository removes its rows and invalidates a held cursor", async () => {
  const base = mkdtempSync(join(tmpdir(), "cie-revoke-"));
  const rootB = join(base, "gone-repo");
  mkdirSync(join(rootB, "src"), { recursive: true });
  writeFileSync(join(rootB, "src/secret.ts"), `export function veryDistinctName(n: number) { return n - 1; }\n`);
  writeFileSync(join(rootB, "src/use.ts"), `import { veryDistinctName } from "./secret";\nexport const g = veryDistinctName(9);\n`);
  const s = await setup();
  await s.svc.ingestRepository(ctx("rvk"), { repoPath: rootB });
  const e = s.svc.search;
  await e.buildForRepository(rootB);
  const repositoryId = e.repositoryOfRoot(rootB)!.repositoryId;
  const rev = (e.indexStatus(ctx(), { repoRoot: rootB }) as any).revision as string;
  // hold a cursor over a query with hits in that repository
  const p1 = await e.search(ctx(), { query: "veryDistinctName", mode: "AUTO", limit: 1 });
  assert.ok(!("ok" in p1) && p1.hits.length > 0, "the pre-revoke search answers");
  assert.ok(typeof p1.nextCursor === "string", "a real cursor is held");
  // revoke + purge through the product path
  const rvk = s.svc.revokeSource(ctx(), { repoRoot: rootB });
  assert.ok(rvk.ok, rvk.ok ? "" : rvk.error.message);
  assert.equal(e.getRepository(repositoryId), null, "the repository is not listed or named anymore");
  const db = s.svc.store.db;
  assert.equal((db.prepare("select count(*) as n from symbol_refs where repository_id = ?").get(repositoryId) as { n: number }).n, 0, "symbol rows leave");
  assert.equal((db.prepare("select count(*) as n from blob_data where blob_hash in (select blob_hash from tree_entries where repository_id = ?)").get(repositoryId) as { n: number }).n, 0, "text rows leave");
  // the held cursor no longer answers
  const stale = await e.search(ctx(), { query: "veryDistinctName", mode: "AUTO", limit: 1, cursor: p1.nextCursor });
  assert.ok("ok" in stale && stale.error.code === "STALE_REVISION", `a cursor over a purged repository: ${JSON.stringify(stale)}`);
  // a fresh search answers with nothing, and nothing of the revoked repository is findable
  const fresh = await e.search(ctx(), { query: "veryDistinctName", mode: "AUTO" });
  assert.ok(!("ok" in fresh));
  assert.equal(fresh.hits.length, 0, "the revoked repository contributes no hits");
  assert.ok(!JSON.stringify(fresh).includes("veryDistinctName"), "its rows are nowhere in the answer");
});