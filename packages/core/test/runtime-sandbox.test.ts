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
