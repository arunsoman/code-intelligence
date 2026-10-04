// F10 WP-02: the twin persistence schema applies and rolls back cleanly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { MIGRATIONS, currentVersion, migrate, rollback } from "../src/migrations.ts";

const TWIN_TABLES = ["twins", "twin_versions", "workload_fixtures", "environment_specs", "model_artifacts", "calibration_runs", "validation_certificates", "twin_experiments", "twin_run_cells", "twin_reports", "schedule_explorations"];

test("F10 WP-02 twin schema applies and is reversible", () => {
  const store = new Store(":memory:");
  const db = store.db;
  assert.equal(currentVersion(db), Math.max(...MIGRATIONS.map((m) => m.version)));
  const names = () => new Set((db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((r) => r.name));
  for (const t of TWIN_TABLES) assert.ok(names().has(t), `missing ${t}`);
  const idx = new Set((db.prepare("select name from sqlite_master where type = 'index'").all() as { name: string }[]).map((r) => r.name));
  assert.ok(idx.has("twin_run_cells_plan"));
  db.prepare("insert into validation_certificates(certificate_id, twin_id, twin_version, model_id, scope_json, binding_hash, holdout_report_json, intervention_report_json, state, issued_at, issued_by) values(?,?,?,?,?,?,?,?,?,?,?)").run("c1", "t1", 1, "m1", "{}", "b", "{}", "{}", "VALID", "now", "rev");
  assert.equal((db.prepare("select count(*) n from validation_certificates").get() as { n: number }).n, 1);
  const undone = rollback(db, 30);
  assert.ok(undone.includes(31), `migration 31 was not rolled back: ${undone}`);
  for (const t of TWIN_TABLES) assert.ok(!names().has(t), `${t} still present`);
  assert.ok(migrate(db).includes(31));
  assert.equal(currentVersion(db), Math.max(...MIGRATIONS.map((m) => m.version)));
  db.close();
});
