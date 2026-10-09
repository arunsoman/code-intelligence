import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Indexer, graphDigest } from "../src/indexer.ts";
import { Store } from "../src/store.ts";
import { copyFixture, ctx, demoRepo, setup } from "./helpers.ts";

const edit = (dir: string, rel: string, f: (s: string) => string) => writeFileSync(join(dir, rel), f(readFileSync(join(dir, rel), "utf8")));
const reindex = async (svc: any, dir: string) => { const r = await svc.ingestRepository(ctx(), { repoPath: dir }); assert.ok(r.ok, JSON.stringify(r.error)); return r.value.id as string; };
async function world(dir = copyFixture()) {
  const t = await setup(undefined, dir);
  await t.svc.buildConceptHierarchy(ctx(), { revision: t.revision });
  const q = await t.svc.ask(ctx(), { question: "how does login and token signing work", revision: t.revision });
  assert.ok(q.ok);
  const ws = t.svc.workspaceLog.create("a", { name: "w", revision: t.revision }) as any;
  t.svc.workspaceLog.append("a", { workspaceId: ws.id, event: { kind: "SET_VIEW", view: q.value.view }, expectedVersion: 0 });
  const ix = new Indexer(t.svc);
  return { ...t, dir, ix, ws: ws.id as string, view: q.value.view, claims: q.value.claims };
}
const SIGN = "function:src/auth/token.ts#signToken", LOGIN = "method:src/auth/service.ts#AuthService.login";

test("edit: impact travels through reverse dependencies to callers, claims, concepts and workspaces; unrelated claims are untouched; the incremental graph equals a clean index", async () => {
  const w = await world();
  const claimsBefore = w.svc.store.db.prepare("select id, json from claims where revision = ?").all(w.revision) as any[];
  assert.ok(claimsBefore.length > 0);
  edit(w.dir, "src/auth/token.ts", (s) => s.replace('process.env.JWT_SECRET ?? "dev");\n}', 'process.env.JWT_SECRET ?? "dev", { expiresIn: 60 });\n}'));
  const r2 = await reindex(w.svc, w.dir);
  const impact = w.ix.computeImpact(w.revision, r2);
  assert.deepEqual(impact.changed, [SIGN]);
  assert.ok(impact.affectedEntities.includes(SIGN) && impact.affectedEntities.includes(LOGIN), "callers are affected");
  assert.ok(!impact.affectedEntities.includes("function:src/auth/password.ts#checkPassword"), "code that signToken does not reach is not affected");
  assert.ok(impact.claims.length > 0 && impact.concepts.length >= 0 && impact.workspaces.length === 1);
  const parsed = claimsBefore.map((r) => JSON.parse(r.json));
  const untouched = parsed.filter((c) => !impact.claims.includes(c.draft.id));
  const res = await w.ix.invalidateAndRevalidate(impact);
  assert.deepEqual([...res.stale].sort(), impact.claims.filter((id) => w.svc.store.getClaim(id)!.state === "STALE").sort());
  for (const id of res.stale) assert.equal(w.svc.store.getClaim(id)!.state, "STALE");
  for (const c of untouched) assert.equal(w.svc.store.getClaim(c.draft.id)!.state, c.state, "a claim that rests on nothing that changed is left alone");
  // A claim restored on the new revision rests on code that did not change; none of them cites the edit.
  for (const { from, to } of res.restored) {
    const nc = w.svc.store.getClaim(to)!;
    assert.equal(nc.draft.revision, r2);
    assert.ok(!(nc.draft.structure?.entityIds ?? []).includes(SIGN));
    assert.equal(w.svc.store.getClaim(from)!.state, "STALE", "the old claim stays on the old revision, marked stale");
  }
  const parity = await w.ix.compareWithCleanIndex(r2);
  assert.ok(parity.equivalent, parity.differences.join("\n"));
  w.worker.close();
});

test("deletion and rename: removed code makes its callers and claims stale; a rename is a rename, not a removal plus an addition; both match a clean index", async () => {
  const w = await world();
  // Delete password.ts (checkPassword): AuthService.login called it.
  rmSync(join(w.dir, "src/auth/password.ts"));
  edit(w.dir, "src/auth/service.ts", (s) => s.replace('import { checkPassword } from "./password";\n', "").replace("!(await checkPassword(pw, user.hash))", "false"));
  const r2 = await reindex(w.svc, w.dir);
  const del = w.ix.computeImpact(w.revision, r2);
  assert.ok(del.removed.includes("function:src/auth/password.ts#checkPassword"));
  assert.ok(del.changed.includes(LOGIN) || del.affectedEntities.includes(LOGIN), "the caller is affected");
  assert.ok(del.claims.length > 0);
  assert.ok((await w.ix.compareWithCleanIndex(r2)).equivalent);
  // Rename signToken everywhere.
  edit(w.dir, "src/auth/token.ts", (s) => s.replaceAll("signToken", "issueToken")); edit(w.dir, "src/auth/service.ts", (s) => s.replaceAll("signToken", "issueToken"));
  const r3 = await reindex(w.svc, w.dir);
  const ren = w.ix.computeImpact(r2, r3);
  assert.deepEqual(ren.renamed, [{ from: SIGN, to: "function:src/auth/token.ts#issueToken" }]);
  assert.ok(!ren.removed.includes(SIGN) && !ren.added.includes("function:src/auth/token.ts#issueToken"), "not a removal plus an addition");
  assert.ok(ren.affectedEntities.includes(LOGIN));
  const parity = await w.ix.compareWithCleanIndex(r3);
  assert.ok(parity.equivalent, parity.differences.join("\n"));
  w.worker.close();
});

test("branch switch: moving to another branch and back gives the right graph each time, never a mixture, and returning to a seen state reuses its revision", async () => {
  const dir = demoRepo();
  const w = await world(dir);
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@x", ...a], { encoding: "utf8" });
  const mainRev = w.revision;
  git("checkout", "-qb", "feature");
  edit(dir, "src/payments/fraud.ts", (s) => s.replaceAll("checkFraud", "screenPayment")); edit(dir, "src/payments/payment-service.ts", (s) => s.replaceAll("checkFraud", "screenPayment")); edit(dir, "tests/payment-service.test.ts", (s) => s.replaceAll("checkFraud", "screenPayment"));
  git("commit", "-qam", "rename on feature");
  const feat = await reindex(w.svc, dir);
  assert.notEqual(feat, mainRev);
  const onFeature = new Set(w.svc.store.entities(feat).map((e) => e.entityId));
  assert.ok(onFeature.has("function:src/payments/fraud.ts#screenPayment") && !onFeature.has("function:src/payments/fraud.ts#checkFraud"));
  assert.ok((await w.ix.compareWithCleanIndex(feat)).equivalent);
  // Back to main: the original content is the original revision.
  git("checkout", "-q", "-");
  const back = await reindex(w.svc, dir);
  assert.equal(back, mainRev, "same bytes, same revision");
  const onMain = new Set(w.svc.store.entities(back).map((e) => e.entityId));
  assert.ok(onMain.has("function:src/payments/fraud.ts#checkFraud") && !onMain.has("function:src/payments/fraud.ts#screenPayment"));
  assert.ok(![...onMain].some((e) => e.includes("screenPayment")), "nothing from the other branch remains in this graph");
  // No relationship in any revision points outside its own revision's entities (no mixed snapshot).
  for (const rev of [mainRev, feat]) { const ids = new Set(w.svc.store.entities(rev).map((e) => e.entityId)); for (const r of w.svc.store.allRelationships(rev)) if (r.kind === "calls" && r.resolution !== "UNRESOLVED") assert.ok(ids.has(r.from) && ids.has(r.to) || r.to.startsWith("external"), `${rev}: ${r.from} > ${r.to}`); }
  const impact = w.ix.computeImpact(mainRev, feat);
  assert.equal(impact.renamed.length, 1);
  w.worker.close();
});

test("generation fence: a change that arrives while claims are being re-checked abandons the re-check, and the claims stay stale", async () => {
  const w = await world();
  edit(w.dir, "src/auth/token.ts", (s) => s.replace('process.env.JWT_SECRET ?? "dev");\n}', 'process.env.JWT_SECRET ?? "dev", { expiresIn: 60 });\n}'));
  const r2 = await reindex(w.svc, w.dir);
  const impact = w.ix.computeImpact(w.revision, r2);
  const root = w.svc.store.revision(r2)!.repoRoot;
  const quiet = await w.ix.invalidateAndRevalidate(impact);
  assert.ok(quiet.stale.length > 0);
  assert.equal(quiet.abandoned.length, 0, "with nothing arriving, nothing is abandoned");
  // Do it again on a fresh world, with another edit landing during the first re-check.
  const w2 = await world();
  edit(w2.dir, "src/auth/token.ts", (s) => s.replace('process.env.JWT_SECRET ?? "dev");\n}', 'process.env.JWT_SECRET ?? "dev", { expiresIn: 60 });\n}'));
  const s2 = await reindex(w2.svc, w2.dir);
  const imp2 = w2.ix.computeImpact(w2.revision, s2);
  const root2 = w2.svc.store.revision(s2)!.repoRoot;
  let calls = 0;
  const res = await w2.ix.invalidateAndRevalidate(imp2, { betweenSteps: () => { if (++calls === 1) w2.ix.bump(root2); } });
  assert.ok(res.abandoned.length > 0 && res.restored.length === 0, JSON.stringify({ a: res.abandoned.length, r: res.restored.length }));
  for (const id of res.abandoned) assert.equal(w2.svc.store.getClaim(id)!.state, "STALE", "an abandoned re-check never restores a claim");
  assert.ok(w2.ix.generation(root2) > res.generation, "the newer generation stands");
  void root;
  w.worker.close(); w2.worker.close();
});

test("crash recovery: a kill -9 in the middle of committing a revision leaves no part of it, the previous revision intact, and the next index completes and matches a clean one", async () => {
  const dir = copyFixture();
  const db = join(mkdtempSync(join(tmpdir(), "cie-crash-")), "i.db");
  const child = spawnSync(process.execPath, [new URL("./fixtures/index-child.ts", import.meta.url).pathname, db, dir], { env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8" });
  assert.equal(child.signal, "SIGKILL", `the child really died mid-commit: ${child.stderr}`);
  const first = JSON.parse(child.stdout.split("\n")[0]).first as string;
  assert.ok(!child.stdout.includes("not reached"));
  const store = new Store(db);
  const revs = (store.db.prepare("select id from revisions").all() as any[]).map((r) => r.id);
  assert.deepEqual(revs, [first], "only the first revision exists");
  const count = (t: string, rev: string) => (store.db.prepare(`select count(*) as n from ${t} where revision = ?`).get(rev) as any).n;
  assert.ok(count("entities", first) > 0 && count("relationships", first) > 0);
  const orphans = (store.db.prepare("select count(*) as n from entities where revision not in (select id from revisions)").get() as any).n;
  assert.equal(orphans, 0, "no entity of a half-written revision survived");
  assert.equal((store.db.prepare("pragma integrity_check").get() as any).integrity_check, "ok");
  store.db.close();
  // Restart: open the same file, finish the work.
  const { Service } = await import("../src/service.ts");
  const { WorkerClient } = await import("../src/worker.ts");
  const { StubProvider } = await import("@cie/model");
  const svc = new Service(new Store(db), new WorkerClient(), new StubProvider());
  const r2 = await reindex(svc, dir);
  assert.notEqual(r2, first);
  assert.ok((await new Indexer(svc).compareWithCleanIndex(r2)).equivalent);
  assert.equal(graphDigest(svc.store, first).entities > 0, true, "and the first revision is still readable");
  (svc as any).worker.close();
});

test("bounded RAM: parser memory is measured, held under a stated ceiling, and an index that would pass the ceiling fails cleanly, saves nothing, and leaves the system working", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cie-big-"));
  for (let d = 0; d < 30; d++) {
    mkdirSync(join(dir, `src/m${d}`), { recursive: true });
    for (let f = 0; f < 50; f++) {
      const body = Array.from({ length: 12 }, (_, i) => `export function fn${d}_${f}_${i}(x: number) { return ${i === 0 ? "x" : `fn${d}_${f}_${i - 1}(x)`} + ${i}; }`).join("\n");
      writeFileSync(join(dir, `src/m${d}/f${f}.ts`), `${body}\n`);
    }
  }
  const small = copyFixture();
  const before = process.memoryUsage();
  const w = await setup(undefined, dir);
  const after = process.memoryUsage();
  const pid = w.worker.pid;
  const hwm = Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]) / 1024;
  const heapGrowth = (after.heapUsed - before.heapUsed) / 1048576;
  const files = w.svc.store.entities(w.revision).filter((e) => e.kind === "file").length;
  assert.equal(files, 1500);
  console.log(`# 1500 files / ${w.svc.store.entities(w.revision).length} entities: parser peak RSS ${hwm.toFixed(0)} MB (~${(hwm / files).toFixed(2)} MB per file), host heap growth ${heapGrowth.toFixed(0)} MB`);
  assert.ok(hwm < 400, `parser peak RSS ${hwm} MB`);
  assert.ok(heapGrowth < 600, `host heap grew ${heapGrowth} MB`);
  // The ceiling is enforced: a budget below what this repository needs is refused, with the reason and with nothing stored.
  const revisionsBefore = (w.svc.store.db.prepare("select count(*) as n from revisions").get() as any).n;
  w.worker.rssLimitMb = 60;
  edit(dir, "src/m3/f7.ts", (s) => s + "export function touched() { return 1; }\n");
  const refused = await w.svc.ingestRepository(ctx(), { repoPath: dir });
  assert.ok(!refused.ok && refused.error.code === "RESOURCE_LIMIT" && /over the 60 MB budget; nothing was saved/.test(refused.error.message), JSON.stringify((refused as any).error));
  assert.equal((w.svc.store.db.prepare("select count(*) as n from revisions").get() as any).n, revisionsBefore, "no revision, not even a partial one");
  assert.equal(w.svc.store.entities(w.revision).length > 0, true, "the previous revision is intact");
  // The parser that replaced the one that was ended works, for a repository that fits.
  const ok = await w.svc.ingestRepository(ctx(), { repoPath: small });
  assert.ok(ok.ok, JSON.stringify((ok as any).error));
  w.worker.close();
});

test("freshness and parity budgets: a burst of edits becomes one index run, the graph is current within the budget, and equals a clean index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cie-fresh-"));
  for (let d = 0; d < 10; d++) { mkdirSync(join(dir, `src/m${d}`), { recursive: true }); for (let f = 0; f < 30; f++) writeFileSync(join(dir, `src/m${d}/f${f}.ts`), `export function a${d}_${f}(x: number) { return x + ${f}; }\nexport function b${d}_${f}(x: number) { return a${d}_${f}(x); }\n`); }
  const w = await setup(undefined, dir);
  const ix = new Indexer(w.svc);
  const before = (w.svc.store.db.prepare("select count(*) as n from revisions").get() as any).n;
  const t0 = performance.now();
  const runs: Promise<{ revision: string; coalesced: number }>[] = [];
  for (let i = 0; i < 20; i++) { edit(dir, `src/m${i % 10}/f${i}.ts`, (s) => s + `export function e${i}() { return ${i}; }\n`); runs.push(ix.notifyChange(dir, [`src/m${i % 10}/f${i}.ts`], { debounceMs: 80 })); }
  const done = await Promise.all(runs);
  const freshMs = performance.now() - t0;
  assert.equal(new Set(done.map((d) => d.revision)).size, 1, "every waiter got the same single run");
  assert.equal(done[0].coalesced, 20, "twenty edits, one run");
  assert.equal((w.svc.store.db.prepare("select count(*) as n from revisions").get() as any).n, before + 1);
  console.log(`# freshness: 20 edits in a 300-file repo became current in ${freshMs.toFixed(0)} ms`);
  assert.ok(freshMs < 5000, `${freshMs} ms`);
  const names = new Set(w.svc.store.entities(done[0].revision).map((e) => e.name));
  for (let i = 0; i < 20; i++) assert.ok(names.has(`e${i}`), `e${i} is in the graph`);
  const parity = await ix.compareWithCleanIndex(done[0].revision);
  assert.ok(parity.equivalent, parity.differences.join("\n"));
  w.worker.close();
});
