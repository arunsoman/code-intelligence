// Incremental indexing must be invisible except for speed: after any sequence of edits, the revision built from the previous one plus the changed files
// is the revision a clean index would have built, row for row, evidence included (modulo the revision id inside evidence spans).
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { StubProvider } from "@cie/model";
import type { AnalysisBatch } from "@cie/schema";
import { Service } from "../src/service.ts";
import { DeltaBaseError, Store } from "../src/store.ts";
import { WorkerClient } from "../src/worker.ts";
import { ctx } from "./helpers.ts";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures");
const fresh = (fixture: string, sub = "") => { const d = mkdtempSync(join(tmpdir(), "cie-inc-")); cpSync(join(FIXTURES, fixture, sub), d, { recursive: true }); return d; };

const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as any)[k])])) : v;
/** Every stored row of a revision, with the revision id replaced and key order ignored. */
function snapshot(store: Store, rev: string) {
  const rows = (sql: string) => (store.db.prepare(sql).all(rev) as any[]).map((r) => JSON.stringify(canon(JSON.parse(String(r.json).split(rev).join("@REV@")))));
  return {
    entities: rows("select json from entities where revision = ? order by entity_id"),
    relationships: rows("select json from relationships where revision = ? order by id"),
    facts: rows("select json from facts where revision = ? order by id"),
    evidence: rows("select json from evidence where revision = ? order by id"),
    digests: store.revisionFiles(rev),
    // The order rows are read back in (layouts depend on it), not just which rows there are.
    order: { entities: store.entities(rev).map((e) => e.entityId), relationships: store.allRelationships(rev).map((r) => r.id), facts: store.allFacts(rev).map((f) => f.id), callsFor: store.entities(rev).slice(0, 40).map((e) => store.relationshipsFor(rev, e.entityId).map((r) => r.id)) },
  };
}
async function clean(repo: string) {
  const worker = new WorkerClient();
  try {
    const svc = new Service(new Store(":memory:"), worker, new StubProvider());
    const r = await svc.ingestRepository(ctx(), { repoPath: repo });
    assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
    return { snap: snapshot(svc.store, r.value.id), id: r.value.id };
  } finally { worker.close(); }
}
/** Rows must hold the real revision id, never the parser's stand-in (which would look equal once ids are normalised). */
function assertNoPlaceholder(store: Store, rev: string, what: string) {
  for (const t of ["entities", "relationships", "facts", "evidence"]) assert.equal((store.db.prepare(`select count(*) n from ${t} where revision = ? and json like '%@REV@%'`).get(rev) as { n: number }).n, 0, `${what}: ${t} hold the placeholder`);
}
function assertSame(a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>, what: string) {
  for (const k of ["entities", "relationships", "facts", "evidence"] as const) {
    const A = new Set(a[k]), B = new Set(b[k]);
    const onlyA = a[k].filter((x) => !B.has(x)).slice(0, 2), onlyB = b[k].filter((x) => !A.has(x)).slice(0, 2);
    assert.deepEqual({ onlyIncremental: onlyA, onlyClean: onlyB, count: a[k].length }, { onlyIncremental: [], onlyClean: [], count: b[k].length }, `${what}: ${k} differ`);
  }
  assert.deepEqual(a.digests, b.digests, `${what}: the per-file digests recorded differ`);
  assert.deepEqual(a.order, b.order, `${what}: rows are read back in a different order`);
}
const edit = (repo: string, file: string, f: (s: string) => string) => writeFileSync(join(repo, file), f(readFileSync(join(repo, file), "utf8")));

test("incremental indexing equals a clean index after every kind of edit: comment, new function and caller, rename, delete, move, revert", async () => {
  const repo = fresh("payments-repo", "src");
  const worker = new WorkerClient();
  const svc = new Service(new Store(":memory:"), worker, new StubProvider());
  const ingest = async () => { const r = await svc.ingestRepository(ctx(), { repoPath: repo }); assert.ok(r.ok, JSON.stringify(!r.ok && r.error)); return r.value; };
  const check = async (what: string, expect: { mode: string; maxChanged?: number }) => {
    const r = await ingest();
    assert.equal(r.delta?.mode, expect.mode, `${what}: mode`);
    if (expect.maxChanged !== undefined) assert.ok(r.delta!.changed <= expect.maxChanged, `${what}: ${r.delta!.changed} files changed, expected at most ${expect.maxChanged}`);
    const c = await clean(repo);
    assert.equal(r.id, c.id, `${what}: the same worktree is the same revision`);
    assertSame(snapshot(svc.store, r.id), c.snap, what);
    assertNoPlaceholder(svc.store, r.id, what);
    return r;
  };
  try {
    const first = await check("first index", { mode: "full" });
    assert.ok(Object.keys(svc.store.revisionFiles(first.id)).length > 10, "a full index records a digest per file");

    const same = await check("nothing changed", { mode: "unchanged" });
    assert.equal(same.id, first.id);

    edit(repo, "errors.ts", (s) => s + "\n// a comment\n");
    await check("comment appended", { mode: "delta", maxChanged: 1 });

    edit(repo, "payments/fraud.ts", (s) => s + "\nexport function newCheck(n: number): boolean { return n > 0; }\n");
    edit(repo, "payments/payment-service.ts", (s) => s.replace('import { checkFraud } from "./fraud";', 'import { checkFraud, newCheck } from "./fraud";').replace("  checkFraud(accountId, amount);", "  checkFraud(accountId, amount);\n  newCheck(amount);"));
    await check("new function and a call to it from another file", { mode: "delta", maxChanged: 3 });

    // Renaming an export changes what its importers resolve to: their rows change although their bytes did not.
    edit(repo, "payments/fraud.ts", (s) => s.split("checkFraud").join("screenPayment"));
    const renamed = await check("exported function renamed (importer untouched)", { mode: "delta" });
    assert.ok(renamed.delta!.changed >= 2, "the importer's rows changed too");

    rmSync(join(repo, "refunds"), { recursive: true });
    await check("directory deleted", { mode: "delta" });

    renameSync(join(repo, "payments/disputes.ts"), join(repo, "payments/disputes-handler.ts"));
    await check("file moved", { mode: "delta" });

    writeFileSync(join(repo, "extra.ts"), "export const answer = 42;\nexport function twice(n: number) { return n * 2; }\n");
    await check("file added", { mode: "delta", maxChanged: 1 });

    edit(repo, "errors.ts", (s) => s.replace("\n// a comment\n", ""));
    await check("a change undone (an earlier worktree state again, with other edits kept)", { mode: "delta" });
  } finally { worker.close(); }
});

test("incremental indexing is exact for Java, Go and Python too (package scope, receivers and typed calls resolve across files)", async () => {
  const repo = fresh("polyglot");
  const worker = new WorkerClient();
  const svc = new Service(new Store(":memory:"), worker, new StubProvider());
  const ingest = async () => { const r = await svc.ingestRepository(ctx(), { repoPath: repo }); assert.ok(r.ok, JSON.stringify(!r.ok && r.error)); return r.value; };
  try {
    await ingest();
    const files = (ext: string) => (svc.store.db.prepare("select file from entities where kind = 'file' and file like ? order by file").all(`%.${ext}`) as { file: string }[]).map((r) => r.file);
    for (const [ext, add] of [["java", "\n// edited\n"], ["go", "\n// edited\n"], ["py", "\n# edited\n"]] as const) {
      const target = files(ext)[0]; assert.ok(target, `a ${ext} file`);
      edit(repo, target, (s) => s + add);
      const r = await ingest();
      assert.equal(r.delta?.mode, "delta", ext);
      const c = await clean(repo);
      assert.equal(r.id, c.id);
      assertSame(snapshot(svc.store, r.id), c.snap, `${ext} edit`);
    }
  } finally { worker.close(); }
});

test("a base that cannot be built on is never trusted: old revisions without digests, and a refused delta, index in full and still match", async () => {
  const repo = fresh("payments-repo", "src");
  const worker = new WorkerClient();
  const svc = new Service(new Store(":memory:"), worker, new StubProvider());
  try {
    const a = await svc.ingestRepository(ctx(), { repoPath: repo }); assert.ok(a.ok);
    // A revision stored before digests existed: forget them, as an older database would.
    svc.store.db.prepare("delete from rev_files").run();
    edit(repo, "errors.ts", (s) => s + "\n// x\n");
    const b = await svc.ingestRepository(ctx(), { repoPath: repo }); assert.ok(b.ok);
    assert.equal(b.value.delta?.mode, "full", "no digests: everything is read again");
    assert.ok(Object.keys(svc.store.revisionFiles(b.value.id)).length > 0, "and this revision records them, so the next edit is incremental");
    edit(repo, "errors.ts", (s) => s + "\n// y\n");
    const c = await svc.ingestRepository(ctx(), { repoPath: repo }); assert.ok(c.ok && c.value.delta?.mode === "delta");
    assertSame(snapshot(svc.store, c.value.id), (await clean(repo)).snap, "after the fallback");
  } finally { worker.close(); }
});

test("a delta that does not add up is rolled back whole: no revision, no rows", async () => {
  const repo = fresh("payments-repo", "src");
  const worker = new WorkerClient();
  const store = new Store(":memory:");
  const svc = new Service(store, worker, new StubProvider());
  try {
    const a = await svc.ingestRepository(ctx(), { repoPath: repo }); assert.ok(a.ok);
    edit(repo, "errors.ts", (s) => s + "\n// z\n");
    const base = { revision: a.value.id, analyzerVersion: a.value.analyzerVersion, digests: store.revisionFiles(a.value.id) };
    const batch: AnalysisBatch = await worker.index(repo, 60_000, undefined, base);
    assert.equal(batch.mode, "delta");
    // The parser claims a file the delta does not contain.
    const lying = { ...batch, manifest: { ...batch.manifest, "ghost.ts": "0".repeat(64) } };
    assert.throws(() => store.putDelta(lying), DeltaBaseError);
    const n = (t: string) => (store.db.prepare(`select count(*) n from ${t} where revision = ?`).get(batch.revision) as { n: number }).n;
    assert.deepEqual(["revisions", "entities", "relationships", "facts", "evidence", "rev_files"].map((t) => t === "revisions" ? (store.db.prepare("select count(*) n from revisions where id = ?").get(batch.revision) as { n: number }).n : n(t)), [0, 0, 0, 0, 0, 0]);
    assert.throws(() => store.putDelta({ ...batch, baseRevision: "wt-nonexistent" }), DeltaBaseError);
    assert.throws(() => store.putDelta({ ...batch, repoRoot: "/somewhere/else" }), DeltaBaseError, "a base from another repository is refused");
    // The honest delta still applies afterwards.
    assert.ok(store.putDelta(batch).id === batch.revision);
  } finally { worker.close(); }
});
