// R-DEBUG-LEFTOVER and R-TODO-SCAN: two hygiene rules added to C25's analyze(), same shape as R-PII-LOG (a plain
// regex scan per Fn.src, one Finding per hit). Uses fixtures/security-repo/src/debug-and-todo.ts and
// tests/hygiene.test.ts, added alongside the other C25 fixtures. This file is new and separate from c25.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Security } from "../src/security.ts";
import { setup } from "./helpers.ts";

const REPO = resolve(import.meta.dirname, "../../../fixtures/security-repo");
async function world() { const t = await setup(undefined, REPO); return { ...t, sec: new Security(t.svc.store) }; }
const subjects = (fs: { ruleId: string; summary: string }[], rule: string) => fs.filter((f) => f.ruleId === rule).map((f) => f.summary);

test("R-DEBUG-LEFTOVER flags a live console.log and a bare debugger statement, each with its own finding", async () => {
  const { sec, revision, worker } = await world();
  const fs = sec.analyze({ revision });
  const hits = subjects(fs, "R-DEBUG-LEFTOVER");
  assert.ok(hits.some((s) => /loudCompute/.test(s) && /console\.log/.test(s)), hits.join("|"));
  assert.ok(hits.some((s) => /stoppedShort/.test(s) && /debugger/.test(s)), hits.join("|"));
  const f = fs.find((x) => x.ruleId === "R-DEBUG-LEFTOVER")!;
  assert.equal(f.severity, "low");
  assert.ok(f.evidenceIds.length > 0);
  worker.close();
});

test("R-DEBUG-LEFTOVER ignores a commented-out console.log", async () => {
  const { sec, revision, worker } = await world();
  const fs = sec.analyze({ revision });
  const hits = subjects(fs, "R-DEBUG-LEFTOVER");
  assert.ok(!hits.some((s) => /quietCompute/.test(s)), "a commented-out console.log is not live code");
  worker.close();
});

test("R-TODO-SCAN flags a TODO in a line comment and a HACK in a block comment", async () => {
  const { sec, revision, worker } = await world();
  const fs = sec.analyze({ revision });
  const hits = subjects(fs, "R-TODO-SCAN");
  assert.ok(hits.some((s) => /pendingWork/.test(s) && /TODO/.test(s)), hits.join("|"));
  assert.ok(hits.some((s) => /knownIssue/.test(s) && /HACK/.test(s)), hits.join("|"));
  worker.close();
});

test("a clean function triggers neither rule", async () => {
  const { sec, revision, worker } = await world();
  const fs = sec.analyze({ revision });
  const hits = [...subjects(fs, "R-DEBUG-LEFTOVER"), ...subjects(fs, "R-TODO-SCAN")];
  assert.ok(!hits.some((s) => /\bclean\b/.test(s)));
  worker.close();
});

test("a test file (tests/hygiene.test.ts) is skipped by both rules even though it has both markers", async () => {
  const { sec, revision, worker } = await world();
  const fs = sec.analyze({ revision });
  const hits = [...subjects(fs, "R-DEBUG-LEFTOVER"), ...subjects(fs, "R-TODO-SCAN")];
  assert.ok(!hits.some((s) => /skip me/.test(s)));
  worker.close();
});

test("every new finding carries evidence, a counter-argument and stays a CANDIDATE, like the existing rules", async () => {
  const { sec, revision, worker, svc } = await world();
  const fs = sec.analyze({ revision }).filter((f) => f.ruleId === "R-DEBUG-LEFTOVER" || f.ruleId === "R-TODO-SCAN");
  assert.ok(fs.length > 0);
  for (const f of fs) {
    assert.ok(f.evidenceIds.length > 0 && f.evidenceIds.every((id) => svc.store.evidence(revision, id)), `${f.id} cites stored evidence`);
    assert.ok(f.counterArgument.length > 0 && f.assumptions.length > 0);
    assert.equal(f.state, "CANDIDATE");
  }
  worker.close();
});
