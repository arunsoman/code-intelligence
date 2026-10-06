import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { setup } from "./helpers.ts";
import { runRuntimeSandbox } from "../src/runtime-sandbox.ts";

const NESTJS_REPO = resolve(import.meta.dirname, "../../../fixtures/nestjs-repo");

test("NestJS runtime sandbox emits runtime facts", async () => {
  const { svc, worker, revision } = await setup(undefined, NESTJS_REPO);
  try {
    const rev = svc.store.revision(revision)!;
    const r = await runRuntimeSandbox({ store: svc.store, registry: svc["registry"], revision: rev, wallMs: 60_000 });
    if (!r.ok) {
      assert.fail(`runtime sandbox failed: ${r.error.code} ${r.error.message}`);
    }
    const facts = svc.store.allFacts(revision);
    // Runtime facts should exist with RUNTIME resolution.
    assert.ok(facts.some((f) => f.resolution === "RUNTIME" && f.predicate === "framework_role" && (f.object as any).value.role === "provider"), "expected runtime provider fact");
    assert.ok(facts.some((f) => f.resolution === "RUNTIME" && f.predicate === "framework_role" && (f.object as any).value.role === "controller"), "expected runtime controller fact");
    assert.ok(r.value.diagnostics.some((d) => /runtime fact/i.test(d)), `diagnostics: ${r.value.diagnostics.join("; ")}`);
  } finally {
    worker.close();
  }
});

test("NestJS runtime introspection is scheduled as a job after indexing", async () => {
  const { svc, worker, revision } = await setup(undefined, NESTJS_REPO);
  try {
    // The job is enqueued asynchronously after ingestRepository returns.
    let job = svc.jobs.list(20).find((j) => j.kind === "runtime-introspect" && j.params.revision === revision);
    for (let i = 0; i < 50 && !job; i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = svc.jobs.list(20).find((j) => j.kind === "runtime-introspect" && j.params.revision === revision);
    }
    assert.ok(job, "runtime-introspect job should be scheduled");
    const done = await svc.jobs.settled(job.id);
    assert.equal(done.state, "SUCCEEDED", `runtime job failed: ${done.error?.message ?? done.message}`);
    const facts = svc.store.allFacts(revision);
    assert.ok(facts.some((f) => f.resolution === "RUNTIME" && f.predicate === "framework_role"), "expected runtime framework_role facts from scheduled job");
  } finally {
    worker.close();
  }
});
