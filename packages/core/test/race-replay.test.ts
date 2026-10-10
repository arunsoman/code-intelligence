import { test } from "node:test";
import assert from "node:assert/strict";
import { type ChartPlanRaceTimeline, RaceSpecSchema } from "@cie/schema";
import { compiledRace, raceFixture } from "./race-fixture.ts";
import { runRaceReplay } from "../src/twin-replay.ts";
import { simulate } from "../src/twin-kernel.ts";

test("replay is deterministic: same params and seed produce the identical run", () => {
  const a = runRaceReplay({ subject: "checkout", scenario: "timeout", arrivalRatePerSec: 80, durationSec: 30, timeoutMs: 14, faultProbability: 0.05, seed: "s1" });
  const b = runRaceReplay({ subject: "checkout", scenario: "timeout", arrivalRatePerSec: 80, durationSec: 30, timeoutMs: 14, faultProbability: 0.05, seed: "s1" });
  assert.equal(a.spec.runId, b.spec.runId);
  assert.deepEqual(JSON.parse(JSON.stringify(a.spec)), JSON.parse(JSON.stringify(b.spec)));
  const other = runRaceReplay({ subject: "checkout", scenario: "timeout", arrivalRatePerSec: 80, durationSec: 30, timeoutMs: 14, faultProbability: 0.05, seed: "s2" });
  assert.notEqual(a.spec.runId, other.spec.runId, "a different seed is a different run");
});

test("replay stays honest: model prediction class, inference display, and simulation gaps", () => {
  const { view, claims } = compiledRace();
  assert.equal(view.race?.resultClass, "MODEL_PREDICTION");
  assert.ok(RaceSpecSchema.safeParse(view.race).success, "the compiled race spec validates against the schema");
  assert.match(view.caption, /model run/);
  assert.ok(claims.length > 0);
  for (const c of claims) {
    assert.equal(c.displayMode, "INFERENCE", "a model run is never drawn as a fact");
    assert.equal(c.draft.modelRun?.provider, "twin-kernel");
    assert.match(c.draft.rationaleSummary, /Not a production measurement/);
  }
  assert.ok(view.gaps.some((g) => /not observed production timing/i.test(g)));
});

test("the timeout scenario actually shows timeouts and retries instead of narrating them", () => {
  const { view, claims } = compiledRace();
  assert.ok(view.race!.metrics.timedOut > 0, "the tuned fixture produces timeouts");
  assert.ok(view.race!.metrics.retried > 0);
  assert.ok(claims.some((c) => c.draft.assertion.includes("timing out")));
  const timedOut = view.race!.requests.filter((r) => r.outcome === "TIMEOUT");
  assert.ok(timedOut.length > 0);
  for (const r of timedOut) assert.ok(r.retries > 0, "a timed-out request exhausted its retries first");
});

test("collected spans are bounded and every span lands inside its window", () => {
  const { view } = compiledRace();
  assert.ok(view.race!.requests.length <= 60, "request sample is capped");
  for (const r of view.race!.requests) {
    assert.ok(r.spans.length <= 16, "per-request spans are capped");
    for (const s of r.spans) {
      assert.ok(s.endMs >= s.startMs, "simulated time never goes backwards inside a visit");
      assert.ok(s.waitMs >= 0);
    }
  }
});

test("the kernel collects nothing unless the replay opts in", () => {
  const spec = { schemaId: "workflow.twin.model.v1" as const, entryStationId: "a", stations: [{ id: "a", name: "a", resourceId: null, service: { kind: "FIXED", ms: 2 } as const, routing: [] }], resources: [], rng: "sha256-keyed/v1" as const, tieComparator: "sequence/v1" as const, faults: [] };
  const arrivals = [{ requestId: "r1", atMs: 0, operation: "op", attributes: {} }];
  const base = { seed: "k", maxEvents: 1000, maxSimTimeMs: 10_000 };
  assert.equal(simulate(spec, arrivals, base).spans, undefined);
  const withSpans = simulate(spec, arrivals, { ...base, collectSpans: { maxRequests: 5 } });
  assert.equal(withSpans.spans?.length, 1);
  assert.equal(withSpans.spans?.[0].event, "SERVICE");
});

test("baseline proposes a healthy run; the compiler never labels it a certificate", () => {
  const { view } = compiledRace({ scenario: "baseline", timeoutMs: undefined, faultProbability: undefined });
  assert.equal(view.race!.metrics.timedOut, 0);
  assert.ok(view.race!.claims.some((c) => c.kind === "baseline-healthy"));
  assert.ok(view.gaps.some((g) => /capacity certificate|not observed production timing|not a production measurement/i.test(g) || /certificate/i.test(g)));
});

test("the compiled view keeps replay params so the UI can re-run or diff the scenario", () => {
  const { view } = compiledRace();
  assert.equal(view.params?.chartId, "R1");
  assert.equal(view.params?.scenario, "timeout");
  assert.ok(typeof view.params?.runId === "string" && view.params.runId.startsWith("run:"));
  assert.equal((raceFixture() as ChartPlanRaceTimeline).subject, "checkout");
});
