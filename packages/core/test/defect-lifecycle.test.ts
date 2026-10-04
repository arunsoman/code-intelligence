// C26 lifecycle: resources opened without a close, found with their timelines, with ownership transfer and error paths understood,
// and every control (the closed, the owned, the finally-guarded) staying quiet. A stress run on real code is the matching false-positive check.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { detectIndexedDefects } from "../src/defect-indexed.ts";
import { detectLifecycle } from "../src/defect/lifecycle.ts";
import { ctx, setup } from "./helpers.ts";

const FIX = resolve(import.meta.dirname, "../../../fixtures/defect-repo");
const fn = (f: { entityIds: string[] }) => f.entityIds[0].replace(/^.*#/, "");

test("C26 lifecycle: each leak is found with a timeline; owned, closed, finally-guarded and removable resources are not; the error path is its own finding", async () => {
  const { svc, worker, revision } = await setup(undefined, FIX);
  const found = detectLifecycle(svc.store, svc.store.revision(revision)!);
  const names = found.map(fn).sort();
  assert.deepEqual(names, ["leakyQuery", "openTransaction", "readFirstLine", "readThenClose", "startPolling", "watch"], `found ${names}`);
  const controls = ["pollOnce", "startOwnedPolling", "readFirstLineSafely", "tidyQuery", "closedTransaction", "watchWithStop"];
  for (const c of controls) assert.ok(!names.includes(c), `${c} is a control and must stay quiet`);
  const of = (n: string) => found.find((f) => fn(f) === n)!;
  assert.equal(of("startPolling").kind, "RESOURCE_LEAK");
  assert.match(of("startPolling").witness!.detail, /A timer \(timer\) is opened and not closed in this function, and it is not handed to anyone else\. Timeline: opened \(line 8\)/);
  assert.match(of("readThenClose").witness!.detail, /closed on the normal path only.*opened \(line 36\) → closed \(line 39\)/s, "the error path is reported separately from the missing close");
  assert.equal(of("readThenClose").severity, "LOW");
  assert.equal(of("readFirstLine").severity, "MEDIUM");
  assert.match(of("openTransaction").witness!.detail, /transaction/);
  assert.match(of("leakyQuery").witness!.detail, /pooled connection \(conn\)/, "returning the result of a query is not handing over the connection");
  assert.match(of("watch").witness!.detail, /An event listener/);
  assert.ok(of("watch").coverageGaps.some((g) => /meant to last for the life of the process/.test(g)), "a permanent subscription looks like a leak, and the finding says so");
  for (const f of found) {
    assert.equal(f.evidenceLevel, "STATIC_CANDIDATE");
    assert.match(f.witness!.detail, /static candidate: no leak was observed/);
    assert.ok(f.coverageGaps.some((g) => /closed by a caller, a framework or at process exit/.test(g)));
    assert.ok(f.safetyObligations.length >= 2 && f.safetyObligations.every((o) => o.state === "PENDING"));
    const ev = svc.evidenceFor(ctx(), { revision, evidenceId: f.evidenceIds[0] });
    assert.ok(ev.ok && ev.value.state === "CURRENT" && ev.value.snippet.length > 0, "each finding cites the opening");
  }
  // The pipeline that C26.detect runs includes them, next to the lock, race and performance findings.
  const all = detectIndexedDefects(svc.store, revision).findings;
  assert.ok(all.some((f) => f.kind === "RESOURCE_LEAK") && all.some((f) => f.kind === "DEADLOCK_CANDIDATE") && all.some((f) => f.ruleId === "defect.n-plus-one") && all.some((f) => f.ruleId === "defect.await-read-write"));
  worker.close();
});
