import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { extractArtifacts, validateArtifacts } from "../src/artifacts.ts";
import { setup } from "./helpers.ts";

const REPO = resolve(import.meta.dirname, "../../../fixtures/artifacts-repo");
const copy = () => { const d = mkdtempSync(join(tmpdir(), "cie-art-")); cpSync(REPO, d, { recursive: true }); return d; };
const by = (set: ReturnType<typeof extractArtifacts>, id: string) => set.artifacts.find((a) => a.id.endsWith(id) || a.name === id)!;

test("route-to-handler, migration, queue binding and feature-flag joins: each is resolved, ambiguous, absent or conflicting as the configuration says, with evidence, and never a claim about deployment", async () => {
  const { svc, worker, revision } = await setup(undefined, REPO);
  const set = extractArtifacts(svc.store, revision);
  assert.match(set.notice, /not evidence of what is deployed or enabled anywhere/);
  assert.ok(set.artifacts.every((a) => a.deployed === "UNKNOWN"));

  // ---- routes
  const route = (name: string) => set.artifacts.find((a) => a.kind === "route" && a.name === name)!;
  assert.deepEqual([route("POST /pay").status, route("POST /pay").joins], ["RESOLVED", ["function:src/handlers/a.ts#createPayment"]], "imported, so that file's function");
  assert.equal(route("GET /health").status, "INLINE");
  const amb = route("DELETE /accounts/:id");
  assert.equal(amb.status, "AMBIGUOUS", "two functions named removeAccount and neither is imported here");
  assert.deepEqual(amb.candidates, ["function:src/handlers/a.ts#removeAccount", "function:src/handlers/b.ts#removeAccount"]);
  assert.deepEqual(amb.joins, [], "an ambiguous join picks nothing");
  assert.equal(route("POST /refund").status, "ABSENT", "refundHandler is declared nowhere");
  const prof = route("PUT /profile");
  assert.equal(prof.status, "RESOLVED"); assert.match(prof.detail, /checks first: requireAuth/);

  // ---- migrations
  const table = (n: string) => set.artifacts.find((a) => a.kind === "table" && a.name === n)!;
  assert.equal(table("accounts").status, "RESOLVED"); assert.match(table("accounts").detail, /id, balance, held/, "the later migration's column is part of the schema");
  assert.equal(table("payments").status, "RESOLVED");
  assert.equal(table("ledger_entries").status, "ABSENT"); assert.match(table("ledger_entries").detail, /no migration creates it/);
  assert.equal(table("legacy_sessions").status, "DECLARED_ONLY"); assert.match(table("legacy_sessions").detail, /dropped in migrations\/002_hold\.sql/);

  // ---- queues
  const queue = (n: string) => set.artifacts.find((a) => a.kind === "queue" && a.name === n)!;
  assert.equal(queue("payment.capture.requested").status, "RESOLVED"); assert.match(queue("payment.capture.requested").detail, /1 publisher\(s\), 1 subscriber\(s\); declared in config\/queues\.json/);
  assert.equal(queue("audit.logged").status, "USED_ONLY"); assert.match(queue("audit.logged").detail, /not declared.*nothing in this repository subscribes/);
  assert.equal(queue("never.published").status, "USED_ONLY"); assert.match(queue("never.published").detail, /subscribed, but nothing in this repository publishes/);
  assert.equal(queue("refund.requested").status, "DECLARED_ONLY");

  // ---- flags
  const flag = (n: string) => set.artifacts.find((a) => a.kind === "flag" && a.name === n)!;
  assert.equal(flag("new-checkout").status, "CONFLICTING");
  assert.match(flag("new-checkout").detail, /config\/flags\.json says true; config\/flags\.prod\.json says false.*depends on the environment/);
  assert.equal(flag("beta-search").status, "ABSENT"); assert.match(flag("beta-search").detail, /what it is when unset is not known/);
  assert.equal(flag("dark-mode").status, "DECLARED_ONLY");

  // Every join cites bytes that can be opened, and the cited text is what was matched.
  for (const a of set.artifacts.filter((x) => x.evidenceIds.length)) for (const id of a.evidenceIds) {
    const ev = svc.store.evidence(revision, id)!;
    assert.ok(ev, `${a.id} cites stored evidence`);
    const r = svc.resolveEvidence(svc.store.revision(revision)!, ev);
    assert.equal(r.state, "CURRENT"); assert.ok(r.snippet.length > 0);
  }
  assert.match(svc.resolveEvidence(svc.store.revision(revision)!, svc.store.evidence(revision, amb.evidenceIds[0])!).snippet, /app\.delete\("\/accounts\/:id", removeAccount\)/);
  worker.close();
});

test("diagnostics name every ambiguity and absence, and say what is not known rather than filling it in", async () => {
  const { svc, worker, revision } = await setup(undefined, REPO);
  const codes = validateArtifacts(svc.store, revision).map((d) => d.code).sort();
  assert.deepEqual(codes, ["FLAG_DEFAULT_CONFLICT", "FLAG_UNDECLARED", "QUEUE_NO_PUBLISHER", "QUEUE_NO_SUBSCRIBER", "QUEUE_UNDECLARED", "QUEUE_UNDECLARED", "ROUTE_HANDLER_ABSENT", "ROUTE_HANDLER_AMBIGUOUS", "TABLE_WITHOUT_MIGRATION"]);
  const amb = validateArtifacts(svc.store, revision).find((d) => d.code === "ROUTE_HANDLER_AMBIGUOUS")!;
  assert.deepEqual(amb.relatedEntityIds.sort(), ["function:src/handlers/a.ts#removeAccount", "function:src/handlers/b.ts#removeAccount"]);
  worker.close();
});

test("absent configuration: with no migrations, queue file or flag file, uses are reported as unknown rather than assumed, and nothing is invented", async () => {
  const dir = copy();
  for (const p of ["migrations", "config"]) rmSync(join(dir, p), { recursive: true, force: true });
  const { svc, worker, revision } = await setup(undefined, dir);
  const set = extractArtifacts(svc.store, revision);
  const t = set.artifacts.filter((a) => a.kind === "table");
  assert.ok(t.length === 3 && t.every((a) => a.status === "ABSENT" && /this repository has no migrations at all/.test(a.detail)));
  assert.ok(set.artifacts.filter((a) => a.kind === "queue").every((a) => a.status === "USED_ONLY" || a.status === "ABSENT"));
  assert.ok(!set.artifacts.some((a) => a.kind === "queue" && a.name === "refund.requested"), "a queue only the deleted config declared does not exist any more");
  const flags = set.artifacts.filter((a) => a.kind === "flag");
  assert.deepEqual(flags.map((f) => [f.name, f.status]).sort(), [["beta-search", "ABSENT"], ["new-checkout", "ABSENT"]]);
  assert.ok(set.artifacts.filter((a) => a.kind === "route").length === 5, "routes are code, so they are still read");
  worker.close();
});

test("ambiguity resolves by evidence only: importing the intended function turns an ambiguous route into a resolved one; a corrupt config is reported and its contents are not used", async () => {
  const dir = copy();
  writeFileSync(join(dir, "src/routes.ts"), readFileSync(join(dir, "src/routes.ts"), "utf8").replace('import { requireAuth }', 'import { removeAccount } from "./handlers/b";\nimport { requireAuth }'));
  writeFileSync(join(dir, "config/flags.json"), "{ not json");
  const { svc, worker, revision } = await setup(undefined, dir);
  const set = extractArtifacts(svc.store, revision);
  const r = set.artifacts.find((a) => a.name === "DELETE /accounts/:id")!;
  assert.deepEqual([r.status, r.joins], ["RESOLVED", ["function:src/handlers/b.ts#removeAccount"]], "the import says which");
  assert.ok(set.diagnostics.some((d) => d.code === "FLAG_CONFIG_UNREADABLE" && /config\/flags\.json/.test(d.message)));
  const nc = set.artifacts.find((a) => a.kind === "flag" && a.name === "new-checkout")!;
  assert.equal(nc.status, "RESOLVED", "only the readable file is used: prod says false");
  assert.match(nc.detail, /default false/);
  assert.ok(!set.artifacts.some((a) => a.kind === "flag" && a.name === "dark-mode"), "a flag only the corrupt file declared is not invented");
  // An edit to a cited file makes its evidence stale, not silently current.
  writeFileSync(join(dir, "src/routes.ts"), readFileSync(join(dir, "src/routes.ts"), "utf8") + "\n// edited\n");
  const ev = svc.store.evidence(revision, r.evidenceIds[0])!;
  assert.equal(svc.resolveEvidence(svc.store.revision(revision)!, ev).state, "STALE");
  worker.close();
});
