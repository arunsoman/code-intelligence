import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { StubProvider } from "@cie/model";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { WorkerClient } from "../src/worker.ts";
import { ctx } from "./helpers.ts";

const FIXTURE_PROFILES = resolve(import.meta.dirname, "../../../fixtures/profiles");

describe("F05 profiling", () => {
  let worker: WorkerClient;
  let svc: Service;

  it("ingests a folded-stack profile and returns diagnostics", async () => {
    worker = new WorkerClient();
    svc = new Service(new Store(":memory:"), worker, new StubProvider());
    const c = ctx();
    const r = await svc.profiling.ingestProfile(c, {
      source: { path: `${FIXTURE_PROFILES}/sample.folded`, serviceHint: "checkout-service" },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.format, "folded");
    assert.equal(r.value.sampleTypes[0].kind, "OTHER");
    assert.equal(r.value.droppedSamples, "NOT_REPORTED");
    assert.ok(r.value.diagnostics.some((d) => d.code === "DROPPED_SAMPLES_UNKNOWN"));
  });

  it("queries hotspots from a V8 cpuprofile", async () => {
    worker = new WorkerClient();
    svc = new Service(new Store(":memory:"), worker, new StubProvider());
    const c = ctx();
    const r = await svc.profiling.queryHotspots(c, {
      path: `${FIXTURE_PROFILES}/sample.cpuprofile.json`,
      ordinal: 0,
      order: "SELF",
      limit: 5,
      serviceHint: "checkout-service",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.value.rows.length > 0, "expected hotspot rows");
    assert.equal(r.value.basis, "MEASURED_PROFILE");
    assert.equal(r.value.grade, "WINDOW_OVERLAP");
    assert.equal(r.value.unit, "microseconds");
    const computeTax = r.value.rows.find((row) => row.name === "computeTax");
    assert.ok(computeTax, "expected computeTax hotspot");
    assert.equal(computeTax.file, "src/tax/rules.ts");
    assert.equal(computeTax.line, 89);
  });

  it("correlates a profile to a trace window", async () => {
    worker = new WorkerClient();
    svc = new Service(new Store(":memory:"), worker, new StubProvider());
    const c = ctx();
    const r = await svc.profiling.correlateProfile(c, {
      profileArtifactHash: "unused",
      path: `${FIXTURE_PROFILES}/sample.cpuprofile.json`,
      trace: {
        service: "checkout-service",
        fromNs: 0,
        toNs: 20_000_000_000,
        revision: "a19a978",
      },
      buildHint: { buildId: "build-1", revision: "a19a978" },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.links[0].grade, "WINDOW_OVERLAP");
    assert.equal(r.value.build.state, "MATCHED");
  });

  it("builds a flamegraph tree from a folded profile", async () => {
    worker = new WorkerClient();
    svc = new Service(new Store(":memory:"), worker, new StubProvider());
    const c = ctx();
    const r = await svc.profiling.buildFlamegraph(c, {
      path: `${FIXTURE_PROFILES}/sample.folded`,
      ordinal: 0,
      serviceHint: "checkout-service",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.value.tree.children.length > 0);
    assert.ok(r.value.nodeCount > 0);
  });

  it("compares two profiles and reports no material difference", async () => {
    worker = new WorkerClient();
    svc = new Service(new Store(":memory:"), worker, new StubProvider());
    const c = ctx();
    const r = await svc.profiling.compareProfiles(c, {
      baselinePath: `${FIXTURE_PROFILES}/sample.cpuprofile.json`,
      candidatePath: `${FIXTURE_PROFILES}/sample.cpuprofile.json`,
      baseline: { service: "checkout-service", sampleTypeKind: "CPU" },
      candidate: { service: "checkout-service", sampleTypeKind: "CPU" },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.verdict, "NO_MATERIAL_DIFFERENCE");
  });
});
