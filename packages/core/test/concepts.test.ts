import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { StubProvider } from "@cie/model";
import { MIGRATIONS } from "../src/migrations.ts";
import { conceptRequirement, answerConcepts, navigateHierarchy, productionEntities } from "../src/overview.ts";
import { retrieveForQuestion } from "../src/retrieval.ts";
import { ctx, demoRepo, setup } from "./helpers.ts";

test("removed concept-card generation refuses direct calls and jobs without calling the model", async (t) => {
  let calls = 0;
  const inner = new StubProvider();
  const { svc, worker, revision } = await setup({ name: "spy", model: "test", hosted: false, generate(req) { calls++; return inner.generate(req); } });
  t.after(() => { worker.close(); svc.store.db.close(); });
  const result = await svc.extractConcepts(ctx(), { revision });
  assert.ok(!result.ok && result.error.code === "NOT_IMPLEMENTED");
  assert.match(result.error.message, /Build concept hierarchy/);
  assert.ok(!svc.enqueueJob(ctx(), { kind: "concepts", revision }).ok);
  assert.equal(calls, 0);
  assert.throws(() => svc.store.replaceConcepts(revision, []), /removed/);
});

test("hierarchy concepts are mandatory and an existing older hierarchy is reported accurately", async (t) => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  t.after(() => { worker.close(); svc.store.db.close(); });
  assert.match(conceptRequirement(svc.store, revision)!, /required.*Build concept hierarchy/);
  let classified = 0;
  svc.router = { name: "spy", choose: async () => null, classify: async () => { classified++; return null; } };
  const missing = await svc.converse(ctx(), { text: "what is this project about?", revision });
  assert.ok(missing.ok && missing.value.kind === "message");
  assert.match(missing.value.message, /Build concept hierarchy/);
  assert.equal(classified, 0, "missing hierarchy stops the request before model classification");
  const blocked = await svc.ask(ctx(), { question: "what is this project about?", revision, overview: true, chartCode: "S27" });
  assert.ok(!blocked.ok && blocked.error.code === "INSUFFICIENT_EVIDENCE");
  const generated = await svc.buildConceptHierarchy(ctx(), { revision });
  assert.ok(generated.ok && generated.value.concepts.length > 0);
  assert.ok(answerConcepts(svc.store, revision).length > 0);
  assert.equal(conceptRequirement(svc.store, revision), undefined);
  assert.equal(navigateHierarchy(svc.store, revision, "what is this project about?").level, "repository");
  const detailed = navigateHierarchy(svc.store, revision, "what does charge call?");
  assert.equal(detailed.level, "function");
  assert.ok(detailed.seeds.some((id) => id.endsWith("#charge")));
  assert.ok(detailed.nodes.some((n) => n.kind === "module"), "function traversal retains parent context");
  const evidence = retrieveForQuestion(svc.store, revision, "what does charge call?", { forModel: true, scope: "subject", tokenBudget: 60000,
    resolveEvidence: (ev) => svc.resolveEvidence(svc.store.revision(revision)!, ev) }).bundle;
  const guidance = evidence.facts.filter((f) => f.predicate === "concept_guidance");
  assert.ok(guidance.length > 0);
  assert.ok(guidance.every((f) => ((f.object.value as { members: string[] }).members).every((id) => evidence.facts.some((source) => source.subject === id && source.predicate === "source_excerpt"))));
  // A new revision has no hierarchy yet. The original remains available to browse.
  svc.store.db.prepare("insert into revisions select ?,repo_root,git_head,created_at,analyzer_version,diagnostics,file_count from revisions where id=?").run("new-revision", revision);
  assert.match(conceptRequirement(svc.store, "new-revision")!, /already generated.*older indexed revision/);
  const summary = svc.conceptHierarchy(ctx(), { revision: "new-revision", summary: true });
  assert.ok(summary.ok && summary.value.revision === revision && summary.value.summary!.concepts === generated.value.concepts.length);
  const full = svc.conceptHierarchy(ctx(), { revision: "new-revision" });
  assert.ok(full.ok && full.value.revision === revision && full.value.concepts.length === generated.value.concepts.length);
});

test("card purge removes obsolete records while preserving the structural hierarchy", async (t) => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  t.after(() => { worker.close(); svc.store.db.close(); });
  await svc.buildConceptHierarchy(ctx(), { revision });
  const db = svc.store.db;
  const before = svc.store.semanticConceptCount(revision);
  assert.ok(before > 0);
  db.exec("create table concepts(id text); create table concept_versions(id text); insert into concepts values ('old-card'); insert into concept_versions values ('old-version')");
  db.prepare("insert into claims values (?,?,?,?,?,?)").run("old-claim", revision, 1, "CANDIDATE", "concept-card", "{}");
  MIGRATIONS.find((m) => m.name === "remove-model-concept-cards")!.up(db);
  assert.equal((db.prepare("select count(*) n from sqlite_master where name in ('concepts','concept_versions')").get() as { n: number }).n, 0);
  assert.equal((db.prepare("select count(*) n from claims where claim_class='concept-card'").get() as { n: number }).n, 0);
  assert.equal(svc.store.semanticConceptCount(revision), before);
});

test("repository wording does not resolve to functions named project or main", async (t) => {
  const repo = demoRepo();
  appendFileSync(join(repo, "src/payments/payment-service.ts"), '\nexport function project(value: number) { if (value > 0) return value; return 0; }\nexport function main(value: number) { return project(value); }\n');
  const { svc, worker, revision } = await setup(undefined, repo);
  t.after(() => { worker.close(); svc.store.db.close(); });
  assert.ok((await svc.buildConceptHierarchy(ctx(), { revision })).ok);
  for (const question of ["what is this project about?", "What is the main architecture / style of this project?"]) {
    assert.equal(navigateHierarchy(svc.store, revision, question).level, "repository");
  }
  const explicit = navigateHierarchy(svc.store, revision, "What does function project do?");
  assert.equal(explicit.level, "function");
  assert.ok(explicit.seeds.some((id) => id.endsWith("#project")));
  const original = svc.store.entities(revision).find((e) => e.entityId.endsWith("#project"))!;
  const entity = (kind: typeof original.kind, name: string, startByte: number, endByteExclusive: number) => ({ ...original, entityId: `${kind}:src/lib.rs#${name}`, kind, name, file: "src/lib.rs",
    spans: [{ ...original.spans[0]!, sourceId: "src/lib.rs", startByte, endByteExclusive }] });
  const production = entity("function", "run", 0, 15);
  const scope = entity("module", "tests", 20, 100);
  const helper = entity("function", "fixture", 40, 60);
  assert.deepEqual(productionEntities([production, scope, helper]).map((e) => e.name), ["run"], "nested test helpers are excluded even inside a production file");
});
