// F01 acceptance suite (§15.1, WP-11): tests named after the acceptance items they settle, doubling as
// negative controls (removing a guard breaks an assertion here). A1–A3, A5, A6 live in search.test.ts,
// search-nav.test.ts and search-server.test.ts; this file settles A4 (fenced publish) and bounded-search
// honesty (§7.2).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { WorkerClient } from "../src/worker.ts";
import { StubProvider } from "@cie/model";
import { Service } from "../src/service.ts";
import { SearchEngine } from "../src/search.ts";

const C = () => ctx("acc");
function ctx(id: string) {
  return { requestId: id, idempotencyKey: id, actor: { principalId: "t", tenantId: "t", sessionId: "t" }, deadlineMs: Date.now() + 30000, traceId: "x" };
}

test("F01-A4: a snapshot is fenced — an interrupted build publishes nothing, a superseded run publishes only the current revision, and a republish keeps the generation", async () => {
  const base = mkdtempSync(join(tmpdir(), "cie-fence-"));
  const root = join(base, "writable-repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), `export function theWall() { return 1; }\n`);
  const store = new Store(":memory:");
  const svc = new Service(store, new WorkerClient(), new StubProvider());
  const e: SearchEngine = svc.search;

  // Ingest with the auto-build disabled: the test drives every build itself.
  const ingest2 = async () => {
    const p = process.env.CIE_SEARCH;
    process.env.CIE_SEARCH = "off";
    try { return await svc.ingestRepository(C(), { repoPath: root }); } finally {
      if (p === undefined) delete process.env.CIE_SEARCH; else process.env.CIE_SEARCH = p;
    }
  };
  await ingest2();
  const repositoryId = e.repositoryOfRoot(root)!.repositoryId;
  const rev1 = svc.store.latestRevision(root)!.id; // the store's head; no publish row exists yet (the build is ours to run)
  await e.buildForRepository(root);
  assert.equal(e.generationOf(repositoryId, rev1), 1, "the first publish is generation 1");

  // reingest unchanged content: the identity stays stable across revisions
  await ingest2();
  const identity = e.repositoryOfRoot(root)!.repositoryId;
  assert.equal(identity, repositoryId, "a repository's identity is stable across revisions");
  // rev2 is the same content as rev1 → same revision id (content-addressed), so a publish row already exists
  assert.equal((e.indexStatus(C(), { repoRoot: root }) as any).revision, rev1);

  // rev2': a genuinely new revision whose build is parked inside the commit fence, during which rev3 lands.
  writeFileSync(join(root, "src/a.ts"), `export function theWall() { return 2; }\n`);
  writeFileSync(join(root, "src/b.ts"), `export const too = theWall() + 1;\n`);
  await ingest2(); // rev2'
  const rev2 = svc.store.latestRevision(root)!.id;
  assert.notEqual(rev2, rev1);

  let fenceEntered = false;
  const r2 = await e.buildForRepository(root, {
    beforeCommit: (_rid, rv) => {
      fenceEntered = true;
      writeFileSync(join(root, "src/a.ts"), `export function theWall() { return 3; }\n`);
      void rv;
      return svc.ingestRepository(C(), { repoPath: root }) as unknown as void; // rev3 arrives before the commit
    },
  });
  assert.ok(fenceEntered, "the fence hook ran");
  assert.equal(r2.state, "SUPERSEDED", `fenced off by the newer revision: ${JSON.stringify(r2)}`);
  assert.equal((store.db.prepare("select count(*) as n from repo_revision_state where revision = ?").get(r2.revision) as { n: number }).n, 0, "nothing was published for the superseded revision");
  const r3 = await e.buildForRepository(root); // the head that won the race is now published
  assert.equal(r3.state, "BUILT");
  assert.notEqual(r3.revision, rev2, "the published head is the revision that won the race, not rev2");
  assert.equal(e.generationOf(repositoryId, r3.revision), 2, `the generation advanced exactly once across publishable revisions: got ${e.generationOf(repositoryId, r3.revision)}`);

  // republishing the SAME revision must not advance the generation (idempotent fenced publish)
  const r3again = await e.buildForRepository(root);
  assert.equal(r3again.revision, r3.revision);
  assert.equal(r3again.state, "BUILT", "a same-content republish still answers");
  assert.equal(e.generationOf(repositoryId, r3.revision), 2, "a same-content republish keeps its previous generation");
});

test("F01-A4 (rows only from fenced outcomes): a built revision writes exactly one publish row", async () => {
  const base = mkdtempSync(join(tmpdir(), "cie-fence2-"));
  const root = join(base, "plain-repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), `export function plainOne() { return 1; }\n`);
  const svc = new Service(new Store(":memory:"), new WorkerClient(), new StubProvider());
  const svcIngest = async () => { const p = process.env.CIE_SEARCH; process.env.CIE_SEARCH = "off"; try { return await svc.ingestRepository(C(), { repoPath: root }); } finally { if (p === undefined) delete process.env.CIE_SEARCH; else process.env.CIE_SEARCH = p; } };
  await svcIngest();
  const e = svc.search;
  const r1 = await e.buildForRepository(root);
  assert.equal(r1.state, "BUILT");
  const rows = svc.store.db.prepare("select repository_id, revision, text_state from repo_revision_state where revision = ?").all(r1.revision) as any[];
  assert.equal(rows.length, 1, "exactly one publish row for the built revision");
  assert.equal(rows[0].text_state, "COMPLETE", "the publish row records a fully indexed state");
  assert.equal((svc.store.db.prepare("select count(*) as n from repo_revision_state").get() as { n: number }).n, 1, "no other publish rows exist");
});

test("F01-A4 (honesty): a build whose file vanished answers PARTIAL and names it in warnings, never silently", async () => {
  const base = mkdtempSync(join(tmpdir(), "cie-missing-"));
  const root = join(base, "vanishing-repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/vanish-me.ts"), `export function onceInFiles(n: number) { return n; }\n`);
  writeFileSync(join(root, "src/stay.ts"), `import { onceInFiles } from "./vanish-me";\nexport const q = onceInFiles(4);\n`);
  const svc = new Service(new Store(":memory:"), new WorkerClient(), new StubProvider());
  await svc.ingestRepository(C(), { repoPath: root });
  const e = svc.search;
  unlinkSync(join(root, "src/vanish-me.ts")); // vanishes between ingest and build — the race builds must disclose
  const r = await e.buildForRepository(root);
  assert.ok(r.files.total >= 2, `the inventory knows both files: ${JSON.stringify(r.files)}`);
  assert.equal(r.files.textIndexed, r.files.total - 1, `exactly one file failed to text-index (it vanished): ${JSON.stringify(r.files)}`);
  assert.ok(r.warnings.some((w) => /vanish-me\.ts/.test(w)), `the vanishing file is named in the build's warnings: ${JSON.stringify(r.warnings)}`);
  // a zero-hit query against the lost symbol still says which parts are indexed and how
  const full = await e.search(C(), { query: "onceInFiles", mode: "AUTO" });
  assert.ok(!("ok" in full));
  const coverage = full.coverageByRepository.find((c) => c.repositoryId === e.repositoryOfRoot(root)?.repositoryId);
  assert.ok(coverage, "the repository reports coverage");
  assert.equal(coverage!.textState, "PARTIAL", `a build that lost a file is not claimed complete: ${coverage!.textState}`);
});

test("§7.2 (bound honesty): a page-capped search answers more than the page and states the stop", async () => {
  const base = mkdtempSync(join(tmpdir(), "cie-bound-"));
  const root = join(base, "chatty-repo");
  const parts: string[] = [];
  for (let i = 0; i < 60; i++) parts.push(`export const filler${i} = ${i}; // needleword ${i}\n`);
  for (let i = 0; i < 40; i++) {
    mkdirSync(join(root, `src/gen${i}`), { recursive: true });
    writeFileSync(join(root, `src/gen${i}/blob.ts`), parts.join("") + parts.join(""));
  }
  writeFileSync(join(root, "src/small.ts"), `export const needlewordOnce = 1;\n`);
  const svc = new Service(new Store(":memory:"), new WorkerClient(), new StubProvider());
  await svc.ingestRepository(C(), { repoPath: root });
  const e = svc.search;
  await e.buildForRepository(root);
  const r = await e.search(C(), { query: "needleword", mode: "LITERAL", limit: 5 });
  assert.ok(!("ok" in r));
  assert.equal(r.hits.length, 5, "the page cap is honored");
  const matchedAtLeast = (r.totals as { matched: number | null; matchedAtLeast: number | null }).matchedAtLeast;
  assert.ok(matchedAtLeast === null ? r.totals.matched !== null && r.totals.matched > 5 : matchedAtLeast! > 5, `more exists than the page shows: ${JSON.stringify(r.totals)}`);
  const stoppedBy = r.coverageByRepository.some((c) => c.stoppedBy === "LIMIT") ||
    r.queryDiagnostics.some((d) => ["LIMIT", "BUDGET", "DEADLINE"].includes(d.code));
  assert.ok(stoppedBy, `the stop is stated once, in words a caller can trust: ${JSON.stringify({ cov: r.coverageByRepository.map((c) => c.stoppedBy), diag: r.queryDiagnostics.map((d) => d.code) })}`);
  // continuation through the cursor reaches different rows, not the same page again
  const next = await e.search(C(), { query: "needleword", mode: "LITERAL", limit: 5, cursor: r.nextCursor });
  assert.ok(!("ok" in next));
  if (next.nextCursor !== undefined) {
    const seen = new Set(r.hits.map((h) => h.hitId));
    for (const h of next.hits) assert.ok(!seen.has(h.hitId), "the continuation page repeats no hit of the prior page");
  }
});