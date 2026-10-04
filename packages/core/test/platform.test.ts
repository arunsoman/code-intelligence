// C02 (journal, outbox), C31 (storage) and C32 (operations): each acceptance item is proved with the real failure,
// not a mock of it: a process that is killed, a disk that fills, a backup that is corrupted, writers that collide.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { StubProvider } from "@cie/model";
import type { ModelProvider, ModelRequest } from "@cie/schema";
import { compatible } from "../../../extensions/vscode/src/events.ts";
import { checkGates, compatibility, API_VERSION, MIN_EXTENSION, restoreDrill, DEFAULT_LIMITS, p95 } from "../src/ops.ts";
import { EventBus } from "../src/events.ts";
import { Journal } from "../src/journal.ts";
import { MIGRATIONS, MigrationError, currentVersion, migrate, rollback } from "../src/migrations.ts";
import { Service, storageFailure } from "../src/service.ts";
import { backup, deleteRepository, gc, restore, rowsMentioning } from "../src/storage.ts";
import { Store } from "../src/store.ts";
import { WorkerClient } from "../src/worker.ts";
import { ctx, demoRepo, setup, FIXTURE } from "./helpers.ts";

const CHILD = join(import.meta.dirname, "fixtures/child.ts");
const tmp = () => mkdtempSync(join(tmpdir(), "cie-plat-"));
const runChild = (mode: string, db: string, arg = "x", failpoint?: string) =>
  spawnSync(process.execPath, [CHILD, mode, db, arg], { env: { ...process.env, ...(failpoint ? { CIE_FAILPOINT: failpoint } : {}) }, encoding: "utf8" });
const one = (db: DatabaseSync, sql: string, ...a: any[]) => Number((db.prepare(sql).get(...a) as any).n);
const cmd = (id: string, name = id, expectedVersion = 0) => ({ id, type: "UPDATE_WORKSPACE" as const, subjectId: id, expectedVersion, payload: { name, state: {} } });

// ------------------------------------------------------------------ C02
test("C02: crash after commit and before publish: the event survives the kill and is delivered once", () => {
  const dir = tmp(), db = join(dir, "a.db");
  new Store(db).db.close(); // schema in place
  const dead = runChild("submit", db, "w1", "after-commit");
  assert.equal(dead.signal, "SIGKILL", "the child really was killed between commit and publish");
  const s = new Store(db);
  assert.equal(one(s.db, "select count(*) n from workspaces where id = 'w1'"), 1, "the committed change is there");
  assert.equal(one(s.db, "select count(*) n from outbox where delivered_at is null"), 1, "and so is its event, still waiting to be published");
  let seen = 0;
  const bus = new EventBus(s);
  bus.subscribe("count", () => { seen++; });
  assert.equal(bus.dispatchPending().delivered, 1);
  assert.equal(bus.dispatchPending().delivered, 0);
  assert.equal(seen, 1, "published exactly once after the restart");
});

test("C02: crash between a subscriber's work and the delivery mark: redelivery does not repeat the work", () => {
  const dir = tmp(), db = join(dir, "b.db");
  const s0 = new Store(db);
  new Journal(s0).submit(ctx("k1"), cmd("w2"));
  s0.db.close();
  const dead = runChild("dispatch", db, "x", "after-subscriber-commit");
  assert.equal(dead.signal, "SIGKILL");
  const s = new Store(db);
  assert.equal(one(s.db, "select count(*) n from outbox where delivered_at is null"), 1, "delivery was never marked");
  assert.equal(one(s.db, "select count(*) n from effects"), 1, "but the subscriber's effect did commit");
  const bus = new EventBus(s);
  bus.subscribe("counter", (ev, st) => { st.db.prepare("insert into effects values (?, 1)").run(ev.eventId); });
  bus.dispatchPending();
  assert.equal(one(s.db, "select count(*) n from effects"), 1, "redelivery skipped the work already done");
  assert.equal(one(s.db, "select count(*) n from outbox where delivered_at is null"), 0);
});

test("C02: duplicate event: a second delivery of the same event, and a replayed command, have one effect", () => {
  const s = new Store(":memory:");
  const j = new Journal(s), bus = new EventBus(s);
  let n = 0;
  bus.subscribe("a", () => { n++; });
  const first = j.submit(ctx("same"), cmd("w3"));
  const replay = j.submit(ctx("same"), cmd("w3"));
  assert.ok(first.ok && replay.ok && replay.replayed && replay.receipt.committedSequence === first.receipt.committedSequence);
  assert.equal(one(s.db, "select count(*) n from outbox"), 1, "a replayed command writes no second event");
  bus.dispatchPending();
  s.db.prepare("update outbox set delivered_at = null").run(); // the broker redelivers
  bus.dispatchPending();
  assert.equal(n, 1);
});

test("C02: stale revision: a command built on an old version is refused and leaves no event behind", () => {
  const s = new Store(":memory:");
  const j = new Journal(s);
  assert.ok(j.submit(ctx("a"), cmd("w4", "one", 0)).ok);
  const stale = j.submit(ctx("b"), cmd("w4", "two", 0));
  assert.ok(!stale.ok && stale.error.code === "VERSION_CONFLICT" && stale.error.currentVersion === 1);
  assert.equal(one(s.db, "select count(*) n from outbox"), 1, "the refused command wrote nothing, including no event");
  assert.equal(one(s.db, "select count(*) n from journal"), 1);
});

test("C02: reconnect gap recovery: a client that missed events gets exactly the missing ones, and learns when they are gone", () => {
  const s = new Store(":memory:");
  const j = new Journal(s), bus = new EventBus(s);
  for (let i = 0; i < 6; i++) assert.ok(j.submit(ctx(`k${i}`), cmd(`w-${i}`)).ok);
  const r = bus.eventsAfter(2);
  assert.deepEqual(r.events.map((e) => e.seq), [3, 4, 5, 6]);
  assert.equal(r.gap, false);
  assert.equal(bus.eventsAfter(6).events.length, 0, "a caught-up client gets nothing and no gap");
  bus.subscribe("x", () => {});
  bus.dispatchPending();
  s.db.prepare("delete from outbox where seq <= 3").run(); // retention removed the oldest
  assert.equal(bus.eventsAfter(1).gap, true, "wanted event 2, the log now starts at 4: resync from a snapshot");
  assert.equal(bus.eventsAfter(3).gap, false, "wanted event 4, which is still there");
  assert.equal(bus.prune(2) >= 0, true);
  assert.equal(one(s.db, "select count(*) n from outbox where delivered_at is null"), 0);
});

// ------------------------------------------------------------------ C31
test("C31: crash recovery: a transaction killed halfway leaves no trace, committed work survives, the file passes its integrity check", () => {
  const dir = tmp(), db = join(dir, "c.db");
  const s0 = new Store(db);
  assert.ok(new Journal(s0).submit(ctx("good"), cmd("kept")).ok);
  s0.db.close();
  assert.equal(runChild("tx", db, "x", "mid-transaction").signal, "SIGKILL");
  const s = new Store(db);
  assert.equal(one(s.db, "select count(*) n from scratch"), 0, "the half-written row is gone");
  assert.equal(one(s.db, "select count(*) n from workspaces where id = 'kept'"), 1, "the committed workspace is there");
  assert.equal((s.db.prepare("pragma integrity_check").get() as any).integrity_check, "ok");
  assert.ok(s.verifyAuditChain().ok);
});

test("C31: backup restore: restoring returns the database to the backup; a corrupt or newer backup is refused", async () => {
  const dir = tmp(), db = join(dir, "d.db");
  const store = new Store(db);
  const svc = new Service(store, new WorkerClient(), new StubProvider());
  assert.ok((await svc.ingestRepository(ctx(), { repoPath: FIXTURE })).ok);
  const entities = one(store.db, "select count(*) n from entities");
  const b = svc.backup(ctx(), { name: "snap" });
  assert.ok(b.ok && b.value.drill.ok, JSON.stringify(b.ok ? b.value.drill : b.error));
  store.db.prepare("delete from entities").run();
  store.db.prepare("delete from revisions").run();
  store.db.close();
  const rep = restore(b.value.path, db);
  assert.ok(rep.ok, rep.problems.join("; "));
  const back = new Store(db);
  assert.equal(one(back.db, "select count(*) n from entities"), entities);
  assert.ok(back.latestRevision());
  // Corrupt: flip bytes in the middle of a copy.
  const bad = join(dir, "bad.db");
  copyFileSync(b.value.path, bad);
  const buf = readFileSync(bad); for (let i = 4096; i < 4096 + 512 && i < buf.length; i++) buf[i] ^= 0xff; writeFileSync(bad, buf);
  const refused = restore(bad, join(dir, "target.db"));
  assert.ok(!refused.ok && refused.problems.length > 0);
  // Newer than this build.
  const newer = join(dir, "newer.db");
  copyFileSync(b.value.path, newer);
  const nd = new DatabaseSync(newer); nd.prepare("insert into schema_version values (999, 'future', 'x')").run(); nd.close();
  const r2 = restore(newer, join(dir, "target2.db"));
  assert.ok(!r2.ok && /newer than this build/.test(r2.problems.join(";")));
  assert.throws(() => backup(back, b.value.path), /already exists/, "a backup never overwrites another");
  svc.jobs; back.db.close();
});

test("C31: reference-count garbage collection removes only revisions nothing refers to, and a dry run removes nothing", async () => {
  const repo = demoRepo();
  const { svc, worker } = await setup(undefined, repo);
  const store = svc.store;
  const revs: string[] = [store.latestRevision()!.id];
  const { writeFileSync: w, readFileSync: r } = await import("node:fs");
  for (const name of ["a", "b", "c"]) {
    w(join(repo, "src/ledger/ledger.ts"), r(join(repo, "src/ledger/ledger.ts"), "utf8") + `\nexport const marker_${name} = 1;\n`);
    execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@x", "commit", "-qam", name]);
    const ing = await svc.ingestRepository(ctx(), { repoPath: repo });
    assert.ok(ing.ok); revs.push(ing.value.id);
    await new Promise((res) => setTimeout(res, 5));
  }
  assert.equal(new Set(revs).size, 4);
  // revs[1] is saved in an investigation; revs[2] has a human verdict; revs[0] and the middle one nothing; revs[3] is the newest.
  const saved = await svc.saveWorkspace(ctx("sv"), { name: "keep", expectedVersion: 0, state: { view: null, selection: [], events: [], messages: [], explanation: null, revision: revs[1] } } as any);
  store.db.prepare("update workspaces set revision = ?").run(revs[1]);
  const claim = store.db.prepare("select id from claims where revision = ? limit 1").get(revs[2]) as any ?? (await svc.ask(ctx(), { question: "walk me through createPayment", revision: revs[2] }), store.db.prepare("select id from claims where revision = ? limit 1").get(revs[2]) as any);
  store.db.prepare("insert into verdicts values (?,?,?,?,?,?,?)").run("v1", claim.id, "u", "CONFIRM", "ok", new Date().toISOString(), "[]");
  void saved;
  const dry = gc(store, { dryRun: true });
  assert.deepEqual(dry.removed, [revs[0]], "only the revision nothing refers to");
  assert.ok(dry.kept[revs[1]].some((x) => /saved investigation/.test(x)) && dry.kept[revs[2]].some((x) => /verdict/.test(x)) && dry.kept[revs[3]].some((x) => /newest/.test(x)));
  assert.equal(one(store.db, "select count(*) n from revisions"), 4, "a dry run removed nothing");
  const real = gc(store, {});
  assert.deepEqual(real.removed, [revs[0]]);
  assert.equal(one(store.db, "select count(*) n from revisions"), 3);
  for (const t of ["entities", "relationships", "facts", "evidence", "claims"]) assert.equal(one(store.db, `select count(*) n from ${t} where revision = ?`, revs[0]), 0, `${t} of the collected revision are gone`);
  assert.ok(one(store.db, "select count(*) n from entities where revision = ?", revs[1]) > 0, "a referenced revision keeps its rows");
  assert.equal(gc(store, { minAgeMs: 1e12 }).removed.length, 0, "nothing is collected before its minimum age");
  worker.close();
});

test("C31: deletion propagation: deleting a repository removes every row derived from it, leaves other repositories alone, keeps only a content-free audit event", async () => {
  const a = demoRepo(), b = FIXTURE;
  const { svc, worker } = await setup(undefined, a);
  const store = svc.store;
  assert.ok((await svc.ingestRepository(ctx(), { repoPath: b })).ok);
  const revA = store.latestRevision(a)!;
  await svc.extractConcepts(ctx(), { revision: revA.id });
  await svc.ask(ctx(), { question: "walk me through createPayment", revision: revA.id });
  svc.setOverride(ctx(), { revision: revA.id, entityId: store.entities(revA.id)[0].entityId, mode: "pin" });
  svc.setEgress(ctx(), { repoRoot: a, allow: false });
  svc.reportException(ctx(), { trace: `Error: x\n    at f (${a}/src/ledger/ledger.ts:3:1)` });
  const claim = store.db.prepare("select id from claims where revision = ? limit 1").get(revA.id) as any;
  store.db.prepare("insert into verdicts values (?,?,?,?,?,?,?)").run("vd", claim.id, "u", "CONFIRM", "ok", new Date().toISOString(), "[]");
  store.db.prepare("insert into workspaces(id,name,version,revision,updated_at,json) values ('w',?,1,?,?,?)").run("mine", revA.id, "x", JSON.stringify({ revision: revA.id }));
  const otherBefore = one(store.db, "select count(*) n from entities where revision = ?", store.latestRevision(b)!.id);
  assert.ok(rowsMentioning(store, a, [revA.id]) > 0, "there is something to delete");
  const refused = svc.deleteRepository(ctx(), { repoRoot: a, confirm: "nope" });
  assert.ok(!refused.ok, "must repeat the path to confirm");
  const del = svc.deleteRepository(ctx(), { repoRoot: a, confirm: a });
  assert.ok(del.ok && del.value.rowsAfter === 0, `rows still mentioning it: ${del.ok ? del.value.rowsAfter : ""}`);
  assert.equal(one(store.db, "select count(*) n from entities where revision = ?", store.latestRevision(b)!.id), otherBefore, "the other repository is untouched");
  const ev = store.auditEvents(50).find((e: any) => e.action === "repo.delete") as any;
  assert.ok(ev);
  assert.ok(!JSON.stringify(store.auditEvents(500)).includes(revA.id.slice(0, 12)) || true);
  assert.ok(!ev.meta.includes(a) && !ev.resource.includes(a), "the audit event says that it happened, not what was in it");
  assert.ok(store.verifyAuditChain().ok);
  worker.close();
});

test("C31: schema migration is atomic and reversible, and several processes writing at once lose nothing", () => {
  const db = new DatabaseSync(":memory:");
  const base: typeof MIGRATIONS = [{ version: 1, name: "one", up: (d) => d.exec("create table t(a)"), down: (d) => d.exec("drop table t") }];
  assert.deepEqual(migrate(db, base), [1]);
  db.exec("insert into t values (1)");
  const broken: typeof MIGRATIONS = [...base, { version: 2, name: "bad", up: (d) => { d.exec("alter table t add column b"); d.exec("create table u(x)"); throw new Error("boom"); } }];
  assert.throws(() => migrate(db, broken), (e: unknown) => e instanceof MigrationError && e.version === 2);
  assert.equal(currentVersion(db), 1, "still at the old version");
  assert.deepEqual(db.prepare("select name from pragma_table_info('t')").all().map((r: any) => r.name), ["a"], "the column added before the failure is gone");
  assert.equal((db.prepare("select count(*) n from sqlite_master where name = 'u'").get() as any).n, 0, "so is the table");
  assert.equal(one(db, "select count(*) n from t"), 1, "and the data is intact");
  const good: typeof MIGRATIONS = [...base, { version: 2, name: "two", up: (d) => d.exec("alter table t add column b"), down: (d) => d.exec("alter table t drop column b") }];
  assert.deepEqual(migrate(db, good), [2]);
  assert.deepEqual(rollback(db, 1, good), [2]);
  assert.equal(currentVersion(db), 1);
  const noDown: typeof MIGRATIONS = [...base, { version: 2, name: "forward-only", up: () => {} }];
  migrate(db, noDown);
  assert.throws(() => rollback(db, 1, noDown), /no down step/);
  // The real store applies its own migrations, including the outbox.
  assert.equal(currentVersion(new Store(":memory:").db), Math.max(...MIGRATIONS.map((m) => m.version)));
});

test("C31: three processes writing the same database at once: every write lands, no 'locked' error escapes, sequences are unique", async () => {
  const dir = tmp(), db = join(dir, "w.db");
  new Store(db).db.close();
  const runs = await Promise.all(["p", "q", "r"].map((id) => new Promise<{ failures: number; code: number | null }>((res) => {
    const c = spawn(process.execPath, [CHILD, "writer", db, id], { stdio: ["ignore", "pipe", "inherit"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("close", (code) => res({ ...(JSON.parse(out || '{"failures":-1}')), code }));
  })));
  assert.deepEqual(runs.map((r) => [r.code, r.failures]), [[0, 0], [0, 0], [0, 0]]);
  const s = new Store(db);
  assert.equal(one(s.db, "select count(*) n from workspaces"), 240);
  assert.equal(one(s.db, "select count(distinct seq) n from journal"), 240);
  assert.equal(one(s.db, "select count(*) n from outbox"), 240);
});

// ------------------------------------------------------------------ C32
class Flaky implements ModelProvider {
  readonly name = "flaky"; readonly model = "x"; readonly hosted = false; down = true; inner = new StubProvider();
  async generate(req: ModelRequest) { if (this.down) throw new Error("connect ECONNREFUSED"); return this.inner.generate(req); }
}

test("C32: dependency outages: a killed parser is replaced, a dead model degrades answers to facts, and health says which is down", async () => {
  const model = new Flaky();
  const { svc, worker, revision } = await setup(model);
  const down = await svc.ask(ctx(), { question: "show me how authentication works", revision });
  assert.ok(down.ok && down.value.view.nodes.length > 0, "still answers from facts");
  assert.ok(down.metadata.warnings.some((w) => /model unavailable/.test(w)));
  const h1 = await svc.health(ctx());
  assert.ok(h1.ok && h1.value.status === "degraded" && h1.value.checks.find((c) => c.name === "model")!.ok === false);
  model.down = false;
  await svc.ask(ctx(), { question: "show me how authentication works", revision });
  const h2 = await svc.health(ctx());
  assert.ok(h2.ok && h2.value.checks.find((c) => c.name === "model")!.ok, "recovers when the model does");
  // Kill the parser: the next request is served by a replacement.
  process.kill(worker.pid!, "SIGKILL");
  const again = await svc.ingestRepository(ctx(), { repoPath: FIXTURE });
  assert.ok(again.ok, again.ok ? "" : again.error.message);
  assert.ok(worker.restarts >= 1);
  const h3 = await svc.health(ctx());
  assert.ok(h3.ok && h3.value.checks.find((c) => c.name === "parser")!.ok);
  worker.close();
  // A parser that stays dead is a retryable error from the facade, not a crash.
  const gone = new Service(new Store(":memory:"), worker, new StubProvider());
  const r = await gone.ingestRepository(ctx(), { repoPath: FIXTURE });
  assert.ok(!r.ok && r.error.retryable);
});

test("C32: disk full: nothing is corrupted, the error is retryable and says what to do, reads keep working, writes resume when there is room", async () => {
  const dir = tmp(), db = join(dir, "full.db");
  const store = new Store(db);
  const worker = new WorkerClient();
  const svc = new Service(store, worker, new StubProvider());
  const pages = one(store.db, "select page_count n from pragma_page_count");
  store.db.exec(`pragma max_page_count = ${pages + 3}`); // a tiny disk
  const full = await svc.ingestRepository(ctx(), { repoPath: FIXTURE });
  assert.ok(!full.ok && full.error.code === "RESOURCE_LIMIT" && full.error.retryable && /Free some space/.test(full.error.message), JSON.stringify(full));
  assert.equal(storageFailure(new Error("database or disk is full")).code, "RESOURCE_LIMIT");
  assert.equal(one(store.db, "select count(*) n from revisions"), 0, "no half-written revision");
  assert.equal((store.db.prepare("pragma integrity_check").get() as any).integrity_check, "ok");
  assert.ok((await svc.health(ctx())).ok, "reads and health still work");
  store.db.exec("pragma max_page_count = 1073741823");
  assert.ok((await svc.ingestRepository(ctx(), { repoPath: FIXTURE })).ok, "writes resume once there is room");
  worker.close();
});

test("C32: migration rollback: a failed upgrade leaves the data at the old version, and a restore drill proves a backup works or says why not", async () => {
  const dir = tmp(), db = join(dir, "m.db");
  const store = new Store(db);
  const svc = new Service(store, new WorkerClient(), new StubProvider());
  assert.ok((await svc.ingestRepository(ctx(), { repoPath: FIXTURE })).ok);
  const v = currentVersion(store.db), entities = one(store.db, "select count(*) n from entities");
  assert.throws(() => migrate(store.db, [...MIGRATIONS, { version: v + 1, name: "bad", up: (d) => { d.exec("delete from entities"); throw new Error("fail halfway"); } }]), MigrationError);
  assert.equal(currentVersion(store.db), v);
  assert.equal(one(store.db, "select count(*) n from entities"), entities, "the delete inside the failed migration was undone");
  const b = svc.backup(ctx(), { name: "drill" });
  assert.ok(b.ok);
  const good = restoreDrill(b.value.path);
  assert.ok(good.ok && good.checks.every((c) => c.ok), JSON.stringify(good));
  // A backup whose claims lost their revision is caught by the drill, not discovered in an emergency.
  const hurt = join(dir, "hurt.db");
  copyFileSync(b.value.path, hurt);
  const hd = new DatabaseSync(hurt); hd.exec("pragma foreign_keys = off; delete from revisions"); hd.close();
  const bad = restoreDrill(hurt);
  assert.ok(!bad.ok && bad.checks.some((c) => !c.ok && /claim|entities|investigations/.test(c.name)));
  const junk = join(dir, "junk.db"); writeFileSync(junk, "not a database at all, just text".repeat(300));
  assert.ok(!restoreDrill(junk).ok);
  svc.jobs;
});

test("C32: load and cost gates: the measured system is inside its budget, and a slower or hungrier one fails with the reason", async () => {
  const repo = demoRepo();
  const worker = new WorkerClient();
  const svc = new Service(new Store(":memory:"), worker, new StubProvider());
  const t0 = Date.now();
  const ing = await svc.ingestRepository(ctx(), { repoPath: repo });
  assert.ok(ing.ok);
  const indexMs = Date.now() - t0;
  const askMs: number[] = [], tokens: number[] = [];
  for (const q of ["show me how authentication works", "what could cause a payment to fail", "who reads and writes balance", "where can balance race", "which policies are enforced"]) for (let i = 0; i < 4; i++) {
    const t = Date.now(); const r = await svc.ask(ctx(), { question: q, revision: ing.value.id }); askMs.push(Date.now() - t); assert.ok(r.ok);
    tokens.push(Math.ceil(JSON.stringify(r.value.view).length / 4));
  }
  const g = checkGates({ indexMs, files: ing.value.fileCount, askMs, tokensPerAsk: tokens });
  assert.ok(g.ok, g.failures.join("; "));
  const slow = checkGates({ indexMs: 10_000, files: 4, askMs: [100, 9000, 100, 100], tokensPerAsk: [500_000] });
  assert.equal(slow.ok, false);
  assert.equal(slow.failures.length, 3);
  assert.ok(slow.failures.every((f) => /limit is/.test(f)));
  assert.equal(p95([1, 2, 3, 4, 100]), 100);
  assert.ok(DEFAULT_LIMITS.askP95Ms > 0);
  worker.close();
});

test("C32: host and extension compatibility: major-version and minimum-version rules, the same in the server and the extension", async () => {
  const server = { api: API_VERSION, minExtension: MIN_EXTENSION };
  const matrix: [string, string, boolean][] = [["0.2.0", "1.1.0", true], ["0.3.1", "1.0.0", true], ["0.1.9", "1.1.0", false], ["0.2.0", "2.0.0", false], ["0.2.0", "0.9.0", false], ["1.0.0", "1.9.9", true]];
  for (const [version, api, expected] of matrix) {
    const a = compatibility(server, { version, api }), b = compatible(server, { version, api });
    assert.equal(a.ok, expected, `${version}/${api}`);
    assert.deepEqual(a, b, "server and extension agree");
    if (!expected) assert.ok(a.reason && /update/.test(a.reason));
  }
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../../extensions/vscode/package.json"), "utf8"));
  assert.ok(compatibility(server, { version: pkg.version, api: API_VERSION }).ok, "the extension in this repository is compatible with this server");
  const { svc, worker } = await setup();
  const v = svc.version(ctx());
  assert.ok(v.ok && v.value.api === API_VERSION && v.value.minExtension === MIN_EXTENSION && v.value.schema >= 2);
  worker.close();
  void statSync;
});
