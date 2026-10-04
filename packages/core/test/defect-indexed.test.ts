import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { lostIncrement, incrementAfterAwait } from "../../../fixtures/defect-repo/async-race.ts";
import { detectIndexedDefects } from "../src/defect-indexed.ts";
import { computeDominators, identifyNaturalLoops, assessLoopTransformation, summarizeCallEffects, type EffectSummary } from "../src/defect-semantics.ts";
import { containerArguments } from "../src/defect-isolation.ts";
import { ctx, setup } from "./helpers.ts";

test("DP04: real TypeScript functions lose an increment across await; unchanged oracle passes the fixed implementation", async () => {
  for (const [fn, expected] of [[lostIncrement, 1], [incrementAfterAwait, 2]] as const) {
    let release!: () => void;
    const barrier = new Promise<void>((r) => { release = r; });
    const account = { balance: 0 };
    const pending = [fn(account, () => barrier), fn(account, () => barrier)];
    release(); await Promise.all(pending);
    assert.equal(account.balance, expected);
    assert.equal(account.balance === pending.length, fn === incrementAfterAwait, "one retained increment per completed operation");
  }
});

test("C05/C26: actual indexed code produces a cited async candidate and loop call candidates", async () => {
  const { svc, worker, revision } = await setup(undefined, resolve(import.meta.dirname, "../../../fixtures/defect-repo"));
  try {
    const findings = detectIndexedDefects(svc.store, revision).findings;
    const race = findings.find((f) => f.kind === "LOGICAL_RACE" && f.entityIds.some((id) => id.endsWith("#lostIncrement")));
    assert.ok(race, "worker must be rebuilt with semantic-event support");
    assert.ok(race.evidenceIds.every((id) => svc.store.evidence(revision, id)));
    assert.ok(!findings.some((f) => f.kind === "LOGICAL_RACE" && f.entityIds.some((id) => id.endsWith("#incrementAfterAwait"))));
    assert.ok(findings.some((f) => f.kind === "REPEATED_EXTERNAL_CALL"));
    const queued = svc.startDefectDetection(ctx("indexed-detection"), { revision });
    assert.ok(queued.ok);
    const done = await svc.jobs.settled(queued.value.id);
    assert.equal(done.state, "SUCCEEDED");
    assert.equal(svc.defects.list(revision, "finding").length, findings.length);
    const conflict = svc.startDefectDetection(ctx("indexed-detection"), { revision, budget: { maxFacts: 1 } });
    assert.ok(!conflict.ok && conflict.error.code === "VERSION_CONFLICT");
  } finally { worker.close(); }
});

test("DP08: natural loop and transformation gates reject getters, mutations, exceptions and empty-loop changes", () => {
  const graph = { entry: "entry", blocks: ["entry", "header", "body", "exit", "unreachable"], edges: [{ from: "entry", to: "header" }, { from: "header", to: "body" }, { from: "body", to: "header" }, { from: "header", to: "exit" }] };
  assert.deepEqual([...computeDominators(graph).get("body")!].sort(), ["body", "entry", "header"]);
  assert.deepEqual(identifyNaturalLoops(graph)[0].blocks, ["body", "header"]);
  const pure: EffectSummary = { reads: ["config"], writes: [], mayBlock: false, mayThrow: false, io: false, purity: "PURE", unresolvedCallees: [] };
  const safe = { reads: [{ path: "config", getter: false, volatile: false, concurrentMutation: false, aliasResolved: true }], writes: [], effects: pure, mayBeEmpty: false, evaluationMovesBeforeLoop: true, benchmarkAvailable: false };
  assert.equal(assessLoopTransformation(safe).safeCandidate, true);
  assert.match(assessLoopTransformation(safe).obligations.join(" "), /Benchmark/);
  for (const facts of [{ ...safe, mayBeEmpty: true }, { ...safe, writes: ["config"] }, { ...safe, effects: { ...pure, mayThrow: true } }, { ...safe, reads: [{ ...safe.reads[0], getter: true }] }]) assert.equal(assessLoopTransformation(facts).safeCandidate, false);
  const summaries = summarizeCallEffects(new Map([["a", pure], ["b", pure]]), [{ caller: "a", callee: "b" }, { caller: "b", callee: null }]);
  assert.equal(summaries.get("a")!.purity, "UNKNOWN");
});

test("DP14: native execution requires an assessed boundary, pinned image and constrained container arguments", () => {
  const profile = { id: "test", image: `test/image@sha256:${"a".repeat(64)}`, platform: "linux/amd64" as const, runtime: "runc", isolation: "CONTAINER" as const, permitsUntrustedNative: false, toolVersion: "1", license: "fixture", exclusions: [] };
  const request = { sourceDirectory: "/tmp/fixture", sourceHash: "a".repeat(64), argv: ["/usr/bin/test", "-f", "/source/x"], budget: { wallTimeMs: 1000, cpuTimeMs: 1000, memoryBytes: 67108864, processes: 16, readBytes: 1000000, outputBytes: 1000000, cost: "0" }, untrustedNative: true };
  assert.throws(() => containerArguments(profile, request, "cie-experiment-a"), /assessed boundary/);
  const args = containerArguments(profile, { ...request, untrustedNative: false }, "cie-experiment-a");
  for (const flag of ["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit", "--memory", "--cpus", "--pull=never"]) assert.ok(args.includes(flag));
  assert.throws(() => containerArguments({ ...profile, image: "test/image:latest" }, request, "cie-experiment-a"), /digest/);
});
