import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OPS } from "../src/feature/api.ts";
import { DEFAULT_CONFIG, ConfigError, exactBindingEnabled, loadFeatureConfig, trackingFor } from "../src/feature/config.ts";
import { featureOps } from "../src/feature/routes.ts";
import { classifyTier } from "../src/feature/tiers.ts";
import { MIGRATIONS, rollback, currentVersion } from "../src/migrations.ts";
import { Store } from "../src/store.ts";
import { ctx } from "./helpers.ts";
import { createHash } from "node:crypto";

const tmp = () => mkdtempSync(join(tmpdir(), "pf-"));

test("PF-041 scaffold: every operation has a unique key, an owner task and a typed NOT_FOUND stub that names it", async () => {
  assert.equal(new Set(OPS.map((o) => o.key)).size, OPS.length);
  assert.ok(OPS.every((o) => /^C\d\d\/[A-Za-z]+$/.test(o.key) && /^[0-3]\.[A-Z]$|^[0-3]\.[A-Z]$/.test(o.owner)), "keys look like C28/op and owners like 1.E");
  const ops = featureOps();
  assert.equal(Object.keys(ops).length, OPS.length);
  const r = await ops["C02/submitFeature"].run(ctx(), {});
  assert.ok(!r.ok && r.error.code === "NOT_FOUND" && r.error.message.includes("1.C"));
  assert.equal(ops["C02/submitFeature"].mutating, true);
  assert.equal(ops["C10/discoverFeatureContext"].mutating, false);
});

test("a registered handler replaces its stub; an unknown handler or a colliding key is refused", async () => {
  const ok = featureOps({ "C02/resumeRequest": () => ({ ok: true, value: 1, metadata: { requestId: "r", completeness: "COMPLETE", warnings: [] } }) });
  assert.ok((await ok["C02/resumeRequest"].run(ctx(), {})).ok);
  assert.throws(() => featureOps({ "C99/nope": () => ({}) as any }), /unknown feature operation/);
  assert.throws(() => featureOps({}, { "C02/submitFeature": {} }), /collides/);
});

test("through the real gateway: every feature operation is reachable as a typed stub and none shadows an existing operation", async () => {
  const { createServer } = await import("node:http");
  const { buildHandler } = await import("../src/server.ts");
  const { setup } = await import("./helpers.ts");
  const { svc, worker } = await setup();
  const srv = createServer(buildHandler(svc));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(srv.address() as import("node:net").AddressInfo).port}`;
    const { featureHandlers } = await import("../src/feature/handlers.ts");
    const implemented = new Set(Object.keys(featureHandlers(svc)));
    for (const o of OPS.filter((x) => !implemented.has(x.key))) {
      const res = await fetch(`${base}/api/v1/components/${o.key}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "k" }, body: "{}" });
      assert.equal(res.status, 404, o.key);
      const body = await res.json() as any;
      assert.ok(body.error.message.includes(`task ${o.owner}`), `${o.key} answers with its owning task, not an older operation: ${body.error.message}`);
    }
  } finally { srv.close(); worker.close(); }
});

test("migration 33 creates the five record families, is reversible, and leaves older tables alone", () => {
  const store = new Store(":memory:"); const db = store.db; // the store creates the base tables and runs every migration
  const names = (db.prepare("select name from sqlite_master where type='table' and name like 'feature_%' order by name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(names, ["feature_candidates", "feature_decisions", "feature_events", "feature_evidence", "feature_records"]);
  assert.equal(currentVersion(db), Math.max(...MIGRATIONS.map((m) => m.version)));
  db.prepare("insert into feature_records(request_id,repository_id,state,version,schema_version,json,created_by,created_at,updated_at) values ('r','repo','RECEIVED',0,1,'{}','u','t','t')").run();
  db.prepare("insert into feature_events(request_id,sequence,event_id,type,actor,schema_version,json,at) values ('r',1,'e1','FeatureSubmitted','u',1,'{}','t')").run();
  assert.throws(() => db.prepare("insert into feature_events(request_id,sequence,event_id,type,actor,schema_version,json,at) values ('r',2,'e1','x','u',1,'{}','t')").run(), /UNIQUE/, "event ids are unique");
  assert.throws(() => db.prepare("insert into feature_events(request_id,sequence,event_id,type,actor,schema_version,json,at) values ('r',1,'e2','x','u',1,'{}','t')").run(), /UNIQUE|PRIMARY/, "sequence is unique per request");
  const undone = rollback(db, 32);
  assert.ok(undone.includes(33));
  assert.equal((db.prepare("select count(*) n from sqlite_master where name like 'feature_%'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("select count(*) n from sqlite_master where name = 'tasks'").get() as { n: number }).n, 1, "F07 task tables survive");
});

test("config defaults follow the confirmed assumptions; bad settings are rejected, not ignored", () => {
  assert.equal(DEFAULT_CONFIG.egress, "LOCAL_ONLY");
  assert.equal(trackingFor(DEFAULT_CONFIG, "CREATE_DRAFT_PR"), "MANDATORY");
  assert.equal(trackingFor(DEFAULT_CONFIG, "PLAN"), "OPTIONAL");
  assert.deepEqual(DEFAULT_CONFIG.supportedStacks, ["typescript-node-npm"]);
  assert.equal(DEFAULT_CONFIG.perfRepetitions, 10);
  const dir = tmp();
  try {
    assert.deepEqual(loadFeatureConfig(dir), DEFAULT_CONFIG);
    mkdirSync(join(dir, ".cie"));
    const w = (o: unknown) => writeFileSync(join(dir, ".cie", "feature.json"), JSON.stringify(o));
    w({ egress: "CLOUD_ALLOWED", runnerPool: 4 }); assert.equal(loadFeatureConfig(dir).egress, "CLOUD_ALLOWED");
    for (const bad of [{ egres: "x" }, { egress: "ANY" }, { runnerPool: 0 }, { runnerPool: 99 }, { authorityFile: "/etc/x" }, { authorityFile: "../x" }, { tracking: { PLAN: "NEVER" } }]) { w(bad); assert.throws(() => loadFeatureConfig(dir), ConfigError, JSON.stringify(bad)); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("T0.4 gate: exact binding is off without a parity attestation and on only for the current vectors with both runtimes passing", () => {
  const dir = tmp();
  try {
    const vec = join(dir, "v.json"), att = join(dir, "a.json");
    writeFileSync(vec, '{"vectors":[1,2]}');
    assert.equal(exactBindingEnabled(vec, att).enabled, false);
    const sum = () => createHash("sha256").update(Buffer.from('{"vectors":[1,2]}')).digest("hex");
    const good = { protocol: "pf-canon-v1", vectorsSha256: sum(), node: { passed: true, vectors: 2 }, rust: { passed: true, vectors: 2 } };
    writeFileSync(att, JSON.stringify(good)); assert.equal(exactBindingEnabled(vec, att).enabled, true);
    writeFileSync(att, JSON.stringify({ ...good, rust: { passed: false, vectors: 2 } })); assert.match(exactBindingEnabled(vec, att).reason, /rust FAIL/);
    writeFileSync(att, JSON.stringify({ ...good, rust: { passed: true, vectors: 1 } })); assert.equal(exactBindingEnabled(vec, att).enabled, false);
    writeFileSync(att, JSON.stringify(good)); writeFileSync(vec, '{"vectors":[1,2,3]}'); assert.match(exactBindingEnabled(vec, att).reason, /changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tier classifier: docs are T0, access/data/dependency/config are T2, everything else T1", () => {
  const t = (...p: ([string] | [string, "ADDED" | "MODIFIED" | "DELETED"])[]) => classifyTier(p.map(([path, kind]) => ({ path, kind: kind ?? "MODIFIED" }))).tier;
  assert.equal(t(), "T0");
  assert.equal(t(["README.md"], ["docs/guide.md", "ADDED"]), "T0");
  assert.equal(t(["src/ui/Button.tsx"]), "T1");
  assert.equal(t(["README.md"], ["src/ui/Button.tsx"]), "T1", "one executable file lifts the whole change out of T0");
  assert.equal(t(["src/auth/session.ts"]), "T2");
  assert.equal(t(["src/permissions.ts"]), "T2");
  assert.equal(t(["db/migrations/001.sql", "ADDED"]), "T2");
  assert.equal(t(["package.json"]), "T2");
  assert.equal(t(["package-lock.json"]), "T2");
  assert.equal(t([".github/workflows/ci.yml", "ADDED"]), "T2");
  assert.equal(t(["src/old.ts", "DELETED"]), "T2");
  assert.equal(t(["docs/old.md", "DELETED"]), "T0");
  assert.equal(t(["src/export/service.ts", "ADDED"], ["tests/export.test.ts", "ADDED"]), "T1");
});

test("T0.1 readiness register: one row per PF-001..080, a legal status each, nothing VALIDATED, every PRESENT row names a source file", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const reg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../docs/prompt-to-feature/readiness.json"), "utf8"));
  assert.deepEqual(reg.rows.map((r: any) => r.id), Array.from({ length: 80 }, (_, i) => `PF-${String(i + 1).padStart(3, "0")}`));
  for (const r of reg.rows) {
    assert.ok(reg.statusLegend.includes(r.status), r.id);
    assert.notEqual(r.status, "VALIDATED", `${r.id}: nothing is validated until a conformance run says so`);
    assert.ok(r.gap && r.actual && ["new", "extend", "reuse"].includes(r.classification), r.id);
    if (r.status === "AUDITED_PRESENT") { const f = r.actual.match(/(?:packages|apps|crates)\/[\w./-]+\.(?:ts|tsx|rs)/)?.[0]; assert.ok(f && existsSync(resolve(import.meta.dirname, "../../..", f)), `${r.id}: cited file exists`); }
  }
});
