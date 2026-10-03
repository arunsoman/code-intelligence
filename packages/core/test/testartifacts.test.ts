import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseIstanbul, parseJUnit, parseJestJson, parseLcov } from "../src/testartifacts.ts";
import { ctx, demoRepo, setup, traceFor } from "./helpers.ts";

test("lcov, Istanbul JSON, JUnit XML and Jest/Vitest JSON all parse", () => {
  const l = parseLcov("TN:\nSF:src/a.ts\nDA:1,2\nDA:2,0\nDA:2,1\nend_of_record\nSF:src/b.ts\nDA:5,0\nend_of_record\n");
  assert.deepEqual(l.get("src/a.ts"), { 1: 2, 2: 1 });
  assert.deepEqual(l.get("src/b.ts"), { 5: 0 });
  const i = parseIstanbul({ "/p/a.ts": { path: "/p/a.ts", statementMap: { 0: { start: { line: 3 }, end: { line: 3 } }, 1: { start: { line: 4 }, end: { line: 4 } } }, s: { 0: 5, 1: 0 } } });
  assert.deepEqual(i.get("/p/a.ts"), { 3: 5, 4: 0 });
  const j = parseJUnit(`<testsuite><testcase classname="s" name="a &amp; b" time="0.5"/><testcase name="bad"><failure message="boom &lt;x&gt;">trace</failure></testcase><testcase name="err"><error>kaput\nmore</error></testcase><testcase name="skip"><skipped/></testcase></testsuite>`);
  assert.deepEqual(j.map((t) => [t.name, t.status]), [["a & b", "passed"], ["bad", "failed"], ["err", "failed"], ["skip", "skipped"]]);
  assert.equal(j[1].message, "boom <x>"); assert.equal(j[2].message, "kaput"); assert.equal(j[0].durationMs, 500);
  const jest = parseJestJson({ testResults: [{ name: "/p/a.test.ts", assertionResults: [{ title: "works", status: "passed", ancestorTitles: ["suite"] }, { title: "breaks", status: "failed", failureMessages: ["Error: nope\n at x"] }, { title: "later", status: "pending" }] }] });
  assert.deepEqual(jest.map((t) => t.status), ["passed", "failed", "skipped"]);
  assert.equal(jest[1].message, "Error: nope");
});

test("coverage is attached to symbols and test results to tests; the summary and warnings reflect them", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const sum = svc.status(ctx(), {});
  assert.ok(sum.ok && sum.value.tests);
  const t = sum.value.tests!;
  assert.deepEqual(t.found.sort(), ["coverage/lcov.info", "test-results/junit.xml"]);
  assert.deepEqual(t.tests, { passed: 1, failed: 1, skipped: 1 });
  assert.ok(t.coverageLinePercent !== null && t.coverageLinePercent > 20 && t.coverageLinePercent < 90);
  assert.equal(t.failing[0].name, "flags large amounts");

  const fact = (id: string, pred: string) => svc.store.factsFor(revision, id).find((f) => f.predicate === pred);
  const adjust = (fact("function:src/ledger/ledger.ts#adjustBalance", "coverage")!.object as any).value;
  const commit = (fact("function:src/ledger/ledger.ts#commit", "coverage")!.object as any).value;
  assert.equal(adjust.percent, 0, "the refund-path writer has no coverage"); assert.equal(adjust.scope, "symbol");
  assert.equal(commit.percent, 100);
  const ev = svc.store.evidence(revision, fact("function:src/ledger/ledger.ts#adjustBalance", "coverage")!.evidence[0].id)!;
  assert.equal(ev.class, "TEST");
  assert.match(svc.resolveEvidence(svc.store.revision(revision)!, ev).snippet, /0\/\d+ executable lines of adjustBalance/);
  const failed = svc.store.entities(revision).find((e) => e.kind === "test" && e.name === "flags large amounts")!;
  const tr = (fact(failed.entityId, "test_result")!.object as any).value;
  assert.equal(tr.status, "failed"); assert.match(tr.message, /FraudRejectedError/);
  worker.close();
});

test("coverage and failing tests change what the gates and suspects say", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const asked = await svc.ask(ctx(), { question: "Why could this balance become incorrect?", revision });
  assert.ok(asked.ok);
  const adjust = asked.value.view.nodes.find((n) => n.label === "adjustBalance")!;
  const claim = asked.value.claims.find((c) => c.draft.id === adjust.claimIds[0])!;
  assert.match(claim.counterArgument, /only 0% covered|0% covered/);
  assert.ok(!/No test directly exercises adjustBalance/.test(claim.counterArgument), "coverage supersedes the weaker 'no direct test' wording");

  const inv = await svc.investigate(ctx(), { trace: traceFor(repo), revision });
  assert.ok(inv.ok);
  const fraud = inv.value.view.nodes.find((n) => n.label === "checkFraud")!;
  assert.ok(fraud.notes!.some((n) => /Failing test: “flags large amounts”/.test(n)));
  assert.ok(fraud.notes!.some((n) => /% of its lines are covered/.test(n)));
  assert.ok(fraud.evidenceIds.some((id) => svc.store.evidence(revision, id)?.class === "TEST"), "test evidence is cited");
  worker.close();
});

test("stale or malformed artifacts are reported, not trusted silently; absent artifacts change nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cie-art-"));
  mkdirSync(join(dir, "coverage"));
  writeFileSync(join(dir, "a.ts"), "export function a() {\n  return 1;\n}\n");
  writeFileSync(join(dir, "coverage/lcov.info"), "SF:a.ts\nDA:2,1\nend_of_record\n");
  writeFileSync(join(dir, "junit.xml"), "<<<not xml at all");
  const { svc, worker } = await setup(undefined, dir);
  const s = svc.status(ctx(), {});
  assert.ok(s.ok && s.value.tests && s.value.tests.found.includes("coverage/lcov.info") && s.value.tests.tests.passed === 0);
  const bare = await setup(undefined, mkdtempSync(join(tmpdir(), "cie-bare-")).replace(/$/, ""));
  assert.equal((bare.svc.status(ctx(), {}) as any).value.tests, null);
  worker.close(); bare.worker.close();
});
