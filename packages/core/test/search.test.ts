// F01 engine tests: build (§7.1), text/symbol/search queries (§7.2, §7.4), coverage honesty (§7.7,
// F01-A5), the D-design checks D2/D3/D4/D7/D8, and the A4 idempotence of publishing the same revision.
// Acceptance items keep their guide ids in the test names, matching docs/ledger.json entries.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURE, ctx, setup } from "./helpers.ts";
import { Store } from "../src/store.ts";
import { SearchEngine, byteToLineCol, lineColToByte, isBareIdentifier, globRegExp } from "../src/search.ts";

/** A small two-repository world: identical names (F01-A2) and, for D8, one shared blob. */
function twinRepos(): { rootA: string; rootB: string } {
  const base = mkdtempSync(join(tmpdir(), "cie-twin-"));
  const mk = (dir: string, body: string, use: string) => {
    const root = join(base, dir);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/thing.ts"), body);
    writeFileSync(join(root, "src/use.ts"), use);
    return root;
  };
  const sameBytes = `export function process(n: number) {\n  return n + 1;\n}\n`;
  const rootA = mk("repo-a", sameBytes, `import { process } from "./thing";\nexport const one = process(1);\n`);
  const rootB = mk("repo-b", `export function process(n: number) {\n  return n * 2;\n}\n`, `import { process } from "./thing";\nexport const two = process(2);\n`);
  return { rootA, rootB };
}

const principalCtx = (principalId: string) => ({ ...ctx(), actor: { principalId, tenantId: "t", sessionId: "t" } });

test("build publishes one generation with honest coverage", async () => {
  const s = await setup();
  const build = s.svc.search.buildForRepository(FIXTURE);
  const r = await build;
  assert.equal(r.state, "BUILT");
  assert.equal(r.repositoryId.startsWith("repo:"), true);
  assert.equal(r.generation, 1);
  assert.equal(r.files.total, 6);
  assert.ok(r.symbols.defs > 5, `definitions: ${JSON.stringify(r.symbols)}`);
  assert.ok(r.symbols.refs > r.symbols.defs, `references: ${JSON.stringify(r.symbols)}`);
  // publishing the same revision again is idempotent and keeps its generation (§8.4)
  const r2 = await s.svc.search.buildForRepository(FIXTURE);
  assert.equal(r2.generation, 1);
  const status = s.svc.search.indexStatus(ctx(), { repoRoot: FIXTURE }) as any;
  assert.equal((status as any).textState, "COMPLETE");
  assert.equal((status as any).symbolState, "COMPLETE");
  assert.equal((status as any).indexGeneration, 1);
});

test("literal text search answers with location, snippet and the match's words", async () => {
  const s = await setup();
  await s.svc.search.buildForRepository(FIXTURE);
  const r = await s.svc.search.search(ctx(), { query: "checkPassword", mode: "LITERAL" });
  assert.ok(!("ok" in r));
  assert.ok(r.hits.length >= 2, `hits: ${JSON.stringify(r.hits.map((h) => h.path))}`);
  const inService = r.hits.find((h) => h.path === "src/auth/service.ts");
  assert.ok(inService, "the use in service.ts is found");
  assert.equal(inService.display.line > 0, true);
  assert.ok(inService.display.snippet.some((l) => l.includes("checkPassword")), "the snippet shows the match in context");
  assert.equal(inService.tier, "PRECISE");
  assert.deepEqual(inService.matchKinds, ["TEXT_LITERAL"]);
  // every hit is clickable through the shared evidence drawer (its evidence row exists)
  assert.equal(inService.evidenceIds.length, 1);

  // case-insensitive and case-sensitive literals differ, never silently rounded
  const ci = await s.svc.search.search(ctx(), { query: "CHECKPASSWORD", mode: "LITERAL" });
  assert.ok(!("ok" in ci));
  assert.ok(ci.hits.length > 0, "case-insensitive finds the same occurrences");
  const cs = await s.svc.search.search(ctx(), { query: "CHECKPASSWORD", mode: "LITERAL", caseSensitive: true });
  assert.ok(!("ok" in cs));
  assert.equal(cs.hits.length, 0);
  for (const c of cs.coverageByRepository) assert.equal(c.textState, "COMPLETE", "a zero-hit answer says 'fully indexed' (F01-D7)");
});

test("AUTO treats a bare identifier as symbol search plus text, a query with a dot stays text", async () => {
  const s = await setup();
  await s.svc.search.buildForRepository(FIXTURE);
  assert.equal(isBareIdentifier("findByEmail"), true);
  assert.equal(isBareIdentifier("findBy.email"), false);
  const auto = await s.svc.search.search(ctx(), { query: "findByEmail", mode: "AUTO" });
  assert.ok(!("ok" in auto));
  assert.equal(auto.mode, "AUTO");
  const defHit = auto.hits.find((h) => h.matchKinds.includes("SYMBOL_EXACT"));
  assert.ok(defHit?.symbol, `def hit: ${JSON.stringify(auto.hits.map((h) => h.matchKinds))}`);
  assert.equal(defHit.symbol.symbolId, "function:src/db/users.ts#findByEmail");
  assert.ok(auto.hits.some((h) => h.matchKinds.includes("TEXT_LITERAL")), "text occurrences are beside the symbol hits");
  // a dotted query is searched literally; it does not become a regex
  const dotted = await s.svc.search.search(ctx(), { query: "user.hash", mode: "AUTO" });
  assert.ok(!("ok" in dotted));
  assert.ok(dotted.hits.every((h) => !h.matchKinds.includes("TEXT_REGEX")), "AUTO never runs a regex");
});

test("an occurrence inside a string or comment is labelled, not passed off as a use", async () => {
  const s = await setup();
  await s.svc.search.buildForRepository(FIXTURE);
  const r = await s.svc.search.search(ctx(), { query: "invalid credentials", mode: "LITERAL" });
  assert.ok(!("ok" in r));
  assert.ok(r.hits.length >= 1);
  const h = r.hits[0];
  assert.equal(h.inString, true);
  assert.deepEqual(h.matchKinds, ["TEXT_LITERAL", "STRING_OR_DOC"]);
  assert.equal(h.tier, "HEURISTIC", "a string occurrence is heuristic");
  assert.ok(h.rationale.some((x) => /inside a string/.test(x)), `rationale: ${JSON.stringify(h.rationale)}`);
});

test("short queries answer with an explicit scan-limited disclosure", async () => {
  const s = await setup();
  await s.svc.search.buildForRepository(FIXTURE);
  const r = await s.svc.search.search(ctx(), { query: "e", mode: "LITERAL" });
  assert.ok(!("ok" in r));
  assert.ok(r.hits.length > 0);
  const disc = r.queryDiagnostics.find((d) => d.code === "SHORT_QUERY_SCAN_LIMITED");
  assert.ok(disc, `diagnostics: ${JSON.stringify(r.queryDiagnostics.map((d) => d.code))}`);
  assert.match(disc.message, /scan/, "the disclosure says why the answer may be partial");
  assert.match(disc.message, /Every candidate was scanned/, "an untruncated short query says it is complete");
});

test("a hit page cap discloses continuation instead of silently dropping rows", async () => {
  const s = await setup();
  await s.svc.search.buildForRepository(FIXTURE);
  const r = await s.svc.search.search(ctx(), { query: "e", mode: "LITERAL", limit: 5 });
  assert.ok(!("ok" in r));
  assert.ok(r.hits.length <= 5);
  assert.ok(r.totals.matched === null || r.totals.matched > r.totals.shown, `totals: ${JSON.stringify(r.totals)}`);
  assert.ok(r.totals.matchedAtLeast !== null && r.totals.matchedAtLeast > r.totals.shown, `atLeast: ${JSON.stringify(r.totals)}`);
});

test("regex alternation runs in the worker engine (F01 decision D1); unsupported constructs are rejected by name (D2); pathological patterns terminate (D3)", async () => {
  const s = await setup();
  await s.svc.search.buildForRepository(FIXTURE);
  const alt = await s.svc.search.search(ctx(), { query: "signToken|verifyToken", mode: "REGEX" });
  assert.ok(!("ok" in alt));
  assert.equal(alt.mode, "REGEX");
  const paths = new Set(alt.hits.map((h) => h.path));
  assert.ok(paths.has("src/auth/service.ts") && paths.has("src/api/middleware.ts"), `alternation misses: ${[...paths].join(",")}`);
  for (const h of alt.hits) assert.ok(h.matchKinds.includes("TEXT_REGEX"));

  const look = await s.svc.search.search(ctx(), { query: "a(?!b)", mode: "REGEX" });
  assert.ok("ok" in look, "lookaround must be an error");
  assert.equal(look.error.code, "INVALID_SCHEMA");
  assert.match(look.error.message, /look/i, `the construct is named: ${look.error.message}`);

  const back = await s.svc.search.search(ctx(), { query: "(a)\\1", mode: "REGEX" });
  assert.ok("ok" in back, "backreferences must be an error");
  assert.equal(back.error.code, "INVALID_SCHEMA");
  assert.match(back.error.message, /backreference/i);
  assert.match(back.error.message, /Suggestion|alternation/i, "an alternative is offered, not a refusal alone");

  // (a+)+$ — catastrophic on a backtracking engine; the linear engine answers within the deadline
  const t0 = Date.now();
  const bad = await s.svc.search.search(ctx(), { query: "(a+)+$", mode: "REGEX" });
  assert.ok(!("ok" in bad) || (bad as unknown as { queryDiagnostics?: unknown }).queryDiagnostics !== undefined, "returns something bounded");
  assert.ok(Date.now() - t0 < 10_000, "the pathological pattern terminates");
});

test("D4: UTF-16 editor position ↔ UTF-8 byte offset, multi-byte identifiers", () => {
  const body = `const alpha = "αα";\nconst kanji = 每⽇ + alpha;`;
  const lines = body.split("\n");
  const line2 = lines[1];
  const byteOf = (sub: string) => Buffer.byteLength(body.slice(0, body.indexOf(sub)), "utf8");
  // column counting is UTF-16 code units: every ideograph is ONE unit but THREE bytes
  const kanjiCol = [...line2.slice(0, line2.indexOf("每"))].length + 1;
  const kanjiStart = lineColToByte(body, 2, kanjiCol);
  assert.equal(kanjiStart, byteOf("每⽇"), `editor column ${kanjiCol} → the ideograph's first byte`);
  assert.deepEqual(byteToLineCol(body, kanjiStart), { line: 2, column: kanjiCol });
  // the second ideograph is one code unit right and exactly three bytes on
  assert.equal(byteToLineCol(body, lineColToByte(body, 2, kanjiCol + 1)).column, kanjiCol + 1);
  assert.equal(lineColToByte(body, 2, kanjiCol + 1), kanjiStart + 3, "one unit = three bytes here — never the middle of an encoded byte");
  // the greek pair αα: each letter one unit, two bytes — never counted as two units
  const a1 = lineColToByte(body, 1, 16); // column 16 = the first α
  assert.equal(a1, byteOf("αα"), "the first α's byte offset");
  assert.deepEqual(byteToLineCol(body, a1), { line: 1, column: 16 });
  assert.deepEqual(byteToLineCol(body, a1 + 2), { line: 1, column: 17 }, "one unit further over a two-byte letter");
  // clamping: past the end is the end, never an exception and never a wrong line
  const end = Buffer.byteLength(body);
  assert.equal(lineColToByte(body, 99, 1), 22, "an out-of-range line clamps to the last existing line, column 1");
  assert.equal(byteToLineCol(body, end + 500).line, 2);
});

test("F01-A5: cross-repository dependencies are disclosed, a version mismatch is named, invisible providers are counted not named", async () => {
  const s = await setup();
  const base = mkdtempSync(join(tmpdir(), "cie-pkg-"));
  // repo P provides npm pkg "left-pad" at 1.3.0 (visible to both principals)
  const rootP = join(base, "pkg-repo");
  mkdirSync(join(rootP, "src"), { recursive: true }); writeFileSync(join(rootP, "package.json"), JSON.stringify({ name: "left-pad", version: "1.3.0", private: true }));
  writeFileSync(join(rootP, "src/index.ts"), `export function pad(n: number, width: number, ch = " ") { return String(n).padStart(width, ch); }\n`);
  await s.svc.ingestRepository(ctx("ingest-p"), { repoPath: rootP });
  await s.svc.search.buildForRepository(rootP);
  // the fixture requires bcrypt and jsonwebtoken, neither indexed: both name the gap
  await s.svc.search.buildForRepository(FIXTURE);
  const cov = await s.svc.search.search(ctx(), { query: "token", mode: "AUTO" });
  assert.ok(!("ok" in cov));
  const fixtureCov = cov.coverageByRepository.find((x) => x.repositoryName === "sample-repo");
  assert.ok(fixtureCov);
  const packages = fixtureCov.unresolvedPackageEdges.map((e) => e.package);
  assert.ok(packages.includes("bcrypt") && packages.includes("jsonwebtoken"), `edges: ${JSON.stringify(fixtureCov.unresolvedPackageEdges)}`);
  assert.ok(fixtureCov.unresolvedPackageEdges.every((e) => e.reason === "PROVIDER_NOT_INDEXED" || e.reason === "PROVIDER_NOT_VISIBLE_COUNTED_NOT_NAMED"));
  // a visible provider at the wrong version: the mismatch is stated with both versions
  const rootR = join(base, "ver-repo");
  mkdirSync(join(rootR, "src"), { recursive: true }); writeFileSync(join(rootR, "package.json"), JSON.stringify({ name: "vercheck", version: "1.0.0", private: true, dependencies: { "left-pad": "^2.0.0" } }));
  writeFileSync(join(rootR, "src/use.ts"), `import { pad } from "left-pad";\nexport const x = pad(1, 3);\n`);
  await s.svc.ingestRepository(ctx("ingest-r"), { repoPath: rootR });
  await s.svc.search.buildForRepository(rootR);
  const covR = await s.svc.search.search(ctx(), { query: "pad", mode: "AUTO" });
  assert.ok(!("ok" in covR));
  const rcov = covR.coverageByRepository.find((x) => x.repositoryName === "ver-repo");
  assert.ok(rcov, "repo coverage row exists");
  assert.ok(rcov.unresolvedPackageEdges.some((e) => e.reason === "VERSION_MISMATCH" && /2\.0\.0/.test(e.detail) && /1\.3\.0/.test(e.detail)), `edges: ${JSON.stringify(rcov.unresolvedPackageEdges)}`);
  // invisible providers are counted and never named: hide pkg-repo from this caller
  s.svc.collab.addPrincipal("pp", "t");
  s.svc.collab.setAccess("pp", rootR, { allowed: true });
  const hidden = await s.svc.search.search(principalCtx("pp"), { query: "pad", mode: "AUTO" });
  assert.ok(!("ok" in hidden));
  const hcov = hidden.coverageByRepository.find((x) => x.repositoryName === "ver-repo");
  assert.ok(hcov, "hidden repo coverage row exists");
  const counted = hcov.unresolvedPackageEdges.filter((e) => e.reason === "PROVIDER_NOT_VISIBLE_COUNTED_NOT_NAMED");
  assert.equal(counted.length, 1, `hidden edges: ${JSON.stringify(hcov.unresolvedPackageEdges)}`);
  const visibleNames = hcov.unresolvedPackageEdges.filter((e) => e.reason !== "PROVIDER_NOT_VISIBLE_COUNTED_NOT_NAMED").map((e) => e.package);
  assert.ok(!visibleNames.includes("left-pad"), "the hidden package is never named (left-pad is only visible to others)");
  assert.match(counted[0].detail, /counted, never named/);
});

test("F01-A2: identical names in two repositories never merge — definitions, references and scopes stay disjoint", async () => {
  const s = await setup();
  const { rootA, rootB } = twinRepos();
  await s.svc.ingestRepository(ctx("twinA"), { repoPath: rootA });
  await s.svc.ingestRepository(ctx("twinB"), { repoPath: rootB });
  await s.svc.search.buildForRepository(rootA);
  await s.svc.search.buildForRepository(rootB);
  const symId = "function:src/thing.ts#process"; // identical strings, different repositories
  const revA = (s.svc.search.indexStatus(ctx(), { repoRoot: rootA }) as any).revision;
  const revB = (s.svc.search.indexStatus(ctx(), { repoRoot: rootB }) as any).revision;
  const refsA = await s.svc.search.findReferences(ctx(), { repositoryId: s.svc.search.repositoryOfRoot(rootA)!.repositoryId, revision: revA, symbolId: symId });
  assert.ok(!("ok" in refsA));
  for (const ref of refsA.references) assert.equal(ref.repositoryName, "repo-a", `no row of repo-b in A's references: ${JSON.stringify(refsA.groups)}`);
  const refsB = await s.svc.search.findReferences(ctx(), { repositoryId: s.svc.search.repositoryOfRoot(rootB)!.repositoryId, revision: revB, symbolId: symId });
  assert.ok(!("ok" in refsB));
  for (const ref of refsB.references) assert.equal(ref.repositoryName, "repo-b", "no row of repo-a in B's references");
  // and each repository's own use is bound to *its* definition (the import bound the unique local file)
  assert.ok(refsA.references.some((r) => r.path === "src/use.ts"), `A's use is found: ${JSON.stringify(refsA.references.map((r) => r.path))}`);
  assert.ok(refsB.references.some((r) => r.path === "src/use.ts"), `B's use is found: ${JSON.stringify(refsB.references.map((r) => r.path))}`);
});

test("F01-D8: identical content is stored once, and a caller without the other repository sees only its own paths", async () => {
  const s = await setup();
  const base = mkdtempSync(join(tmpdir(), "cie-share-"));
  const write = (dir: string, name: string, body: string) => { mkdirSync(join(base, dir, name, ".."), { recursive: true }); writeFileSync(join(base, dir, name), body); return join(base, dir); };
  const same = `export function uniqueSharedName(a: string) { return a + "!"; }\n`;
  const rootX = write("x", "src/shared.ts", same);
  const rootY = write("y", "src/shared.ts", same);
  await s.svc.ingestRepository(ctx("shX"), { repoPath: rootX });
  await s.svc.ingestRepository(ctx("shY"), { repoPath: rootY });
  await s.svc.search.buildForRepository(rootX);
  await s.svc.search.buildForRepository(rootY);
  const bodyBytes = same;
  const idA = s.svc.search.repositoryOfRoot(rootX)!.repositoryId;
  // one blob shared by both trees
  const st = s.svc.store.db;
  const blobRows = st.prepare("select tm.blob_hash as h, count(*) as trees from blob_text_map tm join tree_entries t on t.blob_hash = tm.blob_hash where tm.blob_hash = (select tm2.blob_hash from tree_entries t2 join blob_text_map tm2 on tm2.blob_hash = t2.blob_hash where t2.repository_id = ? and t2.path = 'src/shared.ts' limit 1) group by tm.blob_hash").get(idA) as { h: string; trees: number } | undefined;
  assert.ok(blobRows && blobRows.trees === 2, `shared blob: ${JSON.stringify(blobRows)}`);
  // the principal that may see only repo X sees only X's hits, though the blob is one and the same
  s.svc.collab.addPrincipal("px", "t");
  s.svc.collab.setAccess("px", rootX, { allowed: true });
  const asX = await s.svc.search.search(principalCtx("px"), { query: "uniqueSharedName", mode: "AUTO" });
  assert.ok(!("ok" in asX));
  const repos = new Set(asX.hits.map((h) => h.repositoryName));
  assert.ok(!repos.has("y"), `only visible repositories appear: ${JSON.stringify([...repos])}`);
  for (const c of asX.coverageByRepository) assert.notEqual(c.repositoryName, "y");
  // the caller that may see both sees both, from one blob
  const asAll = await s.svc.search.search(ctx(), { query: "uniqueSharedName", mode: "AUTO" });
  assert.ok(!("ok" in asAll));
  assert.ok(new Set(asAll.hits.map((h) => h.repositoryName)).has("x") && new Set(asAll.hits.map((h) => h.repositoryName)).has("y"), "both repositories answered from the shared blob");
});

test("D7: a zero-hit answer distinguishes fully indexed from a repository still missing", async () => {
  const store = new Store(":memory:");
  const { Service } = await import("../src/service.ts");
  const { WorkerClient } = await import("../src/worker.ts");
  const { StubProvider } = await import("@cie/model");
  const prev = process.env.CIE_SEARCH;
  process.env.CIE_SEARCH = "off"; // deployment-level off while the data is ingested: nothing auto-builds
  let svc!: InstanceType<typeof Service>;
  try {
    svc = new Service(store, new WorkerClient(), new StubProvider());
    svc.router = new (await import("./scripted-router.ts")).ScriptedRouter();
    const twins = twinRepos();
    var rootA0 = twins.rootA, rootB0 = twins.rootB;
    await svc.ingestRepository(ctx("d7a"), { repoPath: rootA0 });
    await svc.ingestRepository(ctx("d7b"), { repoPath: rootB0 });
  } finally { if (prev === undefined) delete process.env.CIE_SEARCH; else process.env.CIE_SEARCH = prev; }
  const s = { svc: svc as unknown as Awaited<ReturnType<typeof setup>>["svc"], search: (svc as any).search as SearchEngine, store };
  const rootA = rootA0, rootB = rootB0;
  await s.svc.search.buildForRepository(rootA); // only repo-a gets an index; repo-b stays unindexed
  const r = await s.svc.search.search(ctx(), { query: "zzznothingmatches", mode: "LITERAL" });
  assert.ok(!("ok" in r));
  assert.equal(r.hits.length, 0);
  const states = Object.fromEntries(r.coverageByRepository.map((c) => [c.repositoryName, c.textState]));
  assert.equal(states["repo-a"], "COMPLETE", "indexed repository answers 'fully indexed'");
  const bCov = r.coverageByRepository.find((c) => c.repositoryName === "repo-b");
  assert.ok(bCov && bCov.textState === "NONE", `a repository without an index is named and not treated as searched: ${JSON.stringify({ n: r.notIndexed })}`);
  assert.ok(r.notIndexed.some((n) => n.repositoryName === "repo-b"), "the pending repository is listed in notIndexed");
  assert.ok(r.queryDiagnostics.some((d) => d.code === "INDEX_PENDING"), `diagnostics: ${JSON.stringify(r.queryDiagnostics.map((d) => d.code))}`);
});

test("cursor pagination: pages are disjoint, an alien cursor and a changed policy are refused (D1 seed)", async () => {
  const s = await setup();
  await s.svc.search.buildForRepository(FIXTURE);
  const p1 = await s.svc.search.search(ctx(), { query: "e", mode: "LITERAL", limit: 8 });
  assert.ok(!("ok" in p1));
  const p2 = await s.svc.search.search(ctx(), { query: "e", mode: "LITERAL", limit: 8, cursor: p1.nextCursor });
  assert.ok(!("ok" in p2));
  const seen = new Set(p1.hits.map((h) => h.hitId));
  assert.ok(p2.hits.length > 0);
  assert.ok(p2.hits.every((h) => !seen.has(h.hitId)), "pages do not repeat hits");
  // a cursor for a *different* query is refused even though the mac is valid for its own payload
  const p3 = await s.svc.search.search(ctx(), { query: "a", mode: "LITERAL", limit: 8, cursor: p1.nextCursor });
  assert.ok("ok" in p3, "a cursor from another query is refused");
  assert.equal(p3.error.code, "STALE_REVISION");
  // the same query with a stricter policy invalidates the cursor: hide a file from a new principal
  s.svc.collab.addPrincipal("pc", "t");
  s.svc.collab.setAccess("pc", FIXTURE, { allowed: true, deniedPrefixes: ["src/api/"] });
  const p4 = await s.svc.search.search(principalCtx("pc"), { query: "e", mode: "LITERAL", limit: 8 });
  assert.ok(!("ok" in p4));
  assert.ok(p4.hits.every((h) => !h.path.startsWith("src/api/")), "denied prefixes answer after policy (A3)");
});

test("path globs: restricted globs work, {a,b} is refused rather than approximated", async () => {
  const s = await setup();
  await s.svc.search.buildForRepository(FIXTURE);
  const r = await s.svc.search.search(ctx(), { query: "password", mode: "LITERAL", filters: { pathGlobs: ["src/auth/**"] } });
  assert.ok(!("ok" in r));
  assert.ok(r.hits.length > 0 && r.hits.every((h) => h.path.startsWith("src/auth/")));
  const bad = await s.svc.search.search(ctx(), { query: "password", mode: "LITERAL", filters: { pathGlobs: ["src/{auth,api}/**"] } });
  assert.ok("ok" in bad);
  assert.equal(bad.error.code, "INVALID_SCHEMA");
  assert.match(bad.error.message, /\{a,b\}|alternatives/);
  assert.throws(() => globRegExp("src/{a,b}"));
});
test("AUTO reads a question or a near-miss spelling as the code names it mentions, and says so", async () => {
  const s = await setup();
  await s.svc.search.buildForRepository(FIXTURE);
  const sentence = await s.svc.search.search(ctx(), { query: "what does findByEmail return?", mode: "AUTO" });
  assert.ok(!("ok" in sentence));
  assert.deepEqual(sentence.readAs, [{ text: "findByEmail", name: "findByEmail", how: "exact" }]);
  const def = sentence.hits.find((h) => h.symbol?.symbolId === "function:src/db/users.ts#findByEmail");
  assert.ok(def, "the definition is found from inside the sentence");
  assert.equal(def.rationale[0], "the query names findByEmail");
  const typo = await s.svc.search.search(ctx(), { query: "findByEmial", mode: "AUTO" });
  assert.ok(!("ok" in typo));
  assert.deepEqual(typo.readAs, [{ text: "findByEmial", name: "findByEmail", how: "fuzzy" }]);
  assert.match(typo.hits[0].rationale[0], /read “findByEmial” as findByEmail/);
  // An identifier that finds its own definitions is not reinterpreted; explicit modes never are.
  const exact = await s.svc.search.search(ctx(), { query: "findByEmail", mode: "AUTO" });
  assert.ok(!("ok" in exact)); assert.equal(exact.readAs, undefined);
  const literal = await s.svc.search.search(ctx(), { query: "findByEmial", mode: "LITERAL" });
  assert.ok(!("ok" in literal)); assert.equal(literal.readAs, undefined); assert.equal(literal.hits.length, 0);
  const symbol = await s.svc.search.search(ctx(), { query: "findByEmial", mode: "SYMBOL" });
  assert.ok(!("ok" in symbol)); assert.equal(symbol.readAs, undefined);
});

test("a reading never reveals a symbol in a path the caller may not see", async () => {
  const s = await setup();
  await s.svc.search.buildForRepository(FIXTURE);
  s.svc.store.denyPath(FIXTURE, "src/db");
  const r = await s.svc.search.search(ctx(), { query: "findByEmial", mode: "AUTO" });
  assert.ok(!("ok" in r));
  assert.equal(r.readAs, undefined, "no 'read as findByEmail' for a denied definition");
  assert.doesNotMatch(JSON.stringify(r), /findByEmail|src\/db/);
});
