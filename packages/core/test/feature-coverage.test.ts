import { test } from "node:test";
import assert from "node:assert/strict";
import { observeCoverage } from "../src/feature/coverage.ts";
import { DockerRunner, dockerAvailable } from "../src/feature/docker-runner.ts";
import { LocalRunner } from "../src/feature/runner.ts";
import { relatedTests } from "../src/feature/test-links.ts";
import { boot, createEdit } from "./feature-boot.ts";

const SRC = "export function mul(a: number, b: number): number { return a * b; }\nexport function neverCalled(): string { return 'x'; }\n";
const call = (body: string) => `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { mul } from "../src/extra.ts";\ntest("t", () => { ${body} });\n`;
const skip = dockerAvailable() ? false : "docker or the node:24-alpine image is not available on this machine";
const world = () => boot({ edits: () => [createEdit("src/extra.ts", SRC), createEdit("tests/calls.test.ts", call("assert.equal(mul(2, 3), 6);")), createEdit("tests/loadonly.test.ts", call("assert.ok(typeof mul === 'function');")), createEdit("tests/failing.test.ts", call("assert.equal(mul(2, 3), 7);"))] });

test("#94B observed coverage: a test that calls the changed file is an OBSERVED link; one that only loads it is not; a failing test is marked, never clean", { skip }, async () => {
  const w = await world();
  try {
    const runner = new DockerRunner(); const tests = ["tests/calls.test.ts", "tests/failing.test.ts", "tests/loadonly.test.ts"];
    const before = relatedTests({ fs: w.fs, store: w.svc.store }, w.fs.getRequest(w.rid)!, w.cand);
    assert.ok(before.associations.every((a) => a.basis !== "OBSERVED_COVERAGE")); assert.match(before.gaps[0]!, /runtime coverage was not observed/); assert.ok(before.coverage[0]!.unsupported.includes("observed (runtime) coverage"));
    const out = await observeCoverage({ fs: w.fs, store: w.svc.store, runner }, "arun", { candidateHash: w.cand.bindingHash, tests });
    const rec = out.value!;
    assert.equal(rec.candidateHash, w.cand.bindingHash); assert.equal(rec.contentHash, w.cand.binding.candidateContentHash); assert.match(rec.runId, /^covrun:/); assert.equal(rec.isolation, "CONTAINER"); assert.equal(rec.granularity, "function");
    const by = Object.fromEntries(rec.tests.map((t) => [t.testId, t]));
    assert.equal(by["tests/calls.test.ts"]!.status, "OBSERVED", JSON.stringify(by["tests/calls.test.ts"]));
    assert.deepEqual(by["tests/calls.test.ts"]!.files.map((f) => [f.file, f.functionsCalled > 0]), [["src/extra.ts", true]]);
    assert.ok(by["tests/calls.test.ts"]!.files[0]!.calledNames.includes("mul")); assert.ok(!by["tests/calls.test.ts"]!.files[0]!.calledNames.includes("neverCalled"));
    assert.equal(by["tests/failing.test.ts"]!.status, "TEST_FAILED");
    assert.equal(by["tests/loadonly.test.ts"]!.files[0]!.functionsCalled, 0); // loaded, nothing called
    const after = relatedTests({ fs: w.fs, store: w.svc.store }, w.fs.getRequest(w.rid)!, w.cand);
    const basis = Object.fromEntries(after.associations.map((a) => [a.testId, a.basis]));
    assert.equal(basis["tests/calls.test.ts"], "OBSERVED_COVERAGE"); assert.notEqual(basis["tests/loadonly.test.ts"], "OBSERVED_COVERAGE"); assert.notEqual(basis["tests/failing.test.ts"], "OBSERVED_COVERAGE");
    assert.ok(after.gaps.some((g) => /loadonly.test.ts loaded src\/extra.ts without calling/.test(g))); assert.ok(after.gaps.some((g) => /failing.test.ts: the test failed/.test(g)));
    assert.ok(after.gaps.some((g) => g.includes(`run ${rec.runId}`))); assert.deepEqual(after.coverage[0]!.tools, ["static-import-scan", "v8-function-coverage"]); assert.deepEqual(after.coverage[0]!.unsupported, ["line and branch coverage"]);
    // an observation bound to another content hash is ignored
    w.fs.putObservedCoverage({ ...rec, id: "cov:forged", runId: "covrun:forged", contentHash: "pf-canon-v1/other", observedAt: new Date(Date.now() + 1000).toISOString(), tests: [] });
    const stale = relatedTests({ fs: w.fs, store: w.svc.store }, w.fs.getRequest(w.rid)!, w.cand);
    assert.ok(stale.associations.every((a) => a.basis !== "OBSERVED_COVERAGE"), "a record for a different tree is never used");
  } finally { w.close(); }
});

test("#94B observation refuses a stranger, non-test paths, and reports a test it could not run as NOT_OBSERVED", async () => {
  const w = await world();
  try {
    const d = { fs: w.fs, store: w.svc.store, runner: new LocalRunner() };
    await assert.rejects(observeCoverage(d, "mallory", { candidateHash: w.cand.bindingHash }), /no such candidate/);
    await assert.rejects(observeCoverage(d, "arun", { candidateHash: w.cand.bindingHash, tests: ["src/extra.ts"] }), /not a test file/);
    await assert.rejects(observeCoverage(d, "arun", { candidateHash: w.cand.bindingHash, tests: ["../x.test.ts"] }), /not a test file|test file/);
    await assert.rejects(observeCoverage(d, "arun", { candidateHash: w.cand.bindingHash, wallMs: 5 }), /wallMs/);
    const missing = await observeCoverage(d, "arun", { candidateHash: w.cand.bindingHash, tests: ["tests/nope.test.ts"] });
    assert.equal(missing.value!.tests[0]!.status === "OBSERVED", false); assert.equal(missing.status, "PARTIAL");
  } finally { w.close(); }
});

test("#94B the local permission-model runner cannot observe coverage, says so, and no link is upgraded", async () => {
  const w = await world();
  try {
    const out = await observeCoverage({ fs: w.fs, store: w.svc.store, runner: new LocalRunner() }, "arun", { candidateHash: w.cand.bindingHash, tests: ["tests/calls.test.ts"] });
    assert.equal(out.status, "PARTIAL"); assert.equal(out.value!.tests[0]!.status, "NOT_OBSERVED"); assert.match(out.value!.tests[0]!.reason!, /inspector under --permission/);
    const after = relatedTests({ fs: w.fs, store: w.svc.store }, w.fs.getRequest(w.rid)!, w.cand);
    assert.ok(after.associations.every((a) => a.basis !== "OBSERVED_COVERAGE")); assert.ok(after.gaps.some((g) => /calls.test.ts: not observed/.test(g)));
  } finally { w.close(); }
});
