import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConceptHierarchyView, EntityCode } from "@cie/schema";
import { buildHandler } from "../src/server.ts";
import { copyFixture, setup } from "./helpers.ts";

// The discovery toggle in the web app builds the hierarchy through C07/enqueue and reads it through C11/conceptHierarchy.
// This is that exact path over HTTP, and the check that the two ways of discovering concepts keep separate stores.
test("concept hierarchy over the gateway: build as a job, read it back, and leave the concept cards alone", async () => {
  const { svc, worker } = await setup();
  const srv = createServer(buildHandler(svc));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (comp: string, op: string, body: unknown, key?: string) =>
    fetch(`${base}/api/v1/components/${comp}/${op}`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() as any }));
  try {
    // Nothing built yet: an empty view, not an error, so the dialog can say "nothing built yet".
    const none = await post("C11", "conceptHierarchy", {});
    assert.equal(none.status, 200);
    assert.equal((none.body.value as ConceptHierarchyView).version, 0);
    assert.deepEqual(none.body.value.concepts, []);

    // It is a read: no idempotency key is needed, and it is not in the mutating set.
    assert.equal((await post("C11", "conceptHierarchy", { revision: "rev:does-not-exist" })).status, 404);

    // Build it the way the button does.
    const queued = await post("C07", "enqueue", { kind: "concept-hierarchy" }, "hier-1");
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    assert.equal(queued.body.value.kind, "concept-hierarchy");
    const job = await svc.jobs.settled(queued.body.value.id);
    assert.equal(job.state, "SUCCEEDED", job.message);
    const built = job.result!.value as ConceptHierarchyView;
    assert.ok(built.concepts.length > 0, "the sample repository has guarded writes and loops to find");

    // The saved version reads back with the same content the job reported.
    const read = await post("C11", "conceptHierarchy", {});
    assert.equal(read.status, 200);
    const view = read.body.value as ConceptHierarchyView;
    assert.equal(view.version, 1);
    assert.equal(view.versions[0].version, 1);
    assert.match(view.versions[0].provider, /^stub\//, "the version records who built it; it must not read \"unknown\", or the dialog cannot say whether a model was involved");
    assert.equal(view.concepts.length, built.concepts.length);
    assert.ok(view.arch.length > 0, "the architecture tree is saved with it");
    assert.ok(view.concepts.every((c) => c.evidenceIds.every((id) => typeof id === "string")), "evidence ids are carried, never invented");
    assert.ok(view.concepts.every((c) => ["verified", "supported", "speculative"].includes(c.soundness.tier)), "every concept says how sure it is");

    // A header only needs the size: the summary read carries no arrays, and agrees with the full read.
    const sum = (await post("C11", "conceptHierarchy", { summary: true })).body.value as ConceptHierarchyView;
    assert.deepEqual([sum.version, sum.summary?.concepts, sum.concepts.length, sum.arch.length, sum.links.length], [1, view.concepts.length, 0, 0, 0]);

    // An older version can be asked for by number; an unknown one is a 404, not an empty page.
    assert.equal((await post("C11", "conceptHierarchy", { version: 1 })).status, 200);
    assert.equal((await post("C11", "conceptHierarchy", { version: 99 })).status, 404);

    // The other way of discovering concepts is untouched: no card version appeared.
    const cards = await post("C11", "conceptStore", {});
    assert.equal(cards.status, 200);
    assert.equal(cards.body.value.versions.length, 0, "building the hierarchy writes no concept-card version");
    assert.deepEqual((await post("C11", "listConcepts", {})).body.value, []);
  } finally { srv.close(); worker.close(); }
});

// The leaf of the concept tree is "a piece of code". It is read through its own operation, which must be bounded and must not
// show what the caller may not see.
test("reading a code element for the tree: current, stale after an edit, unknown, bad input, and withheld by access policy", async () => {
  const dir = copyFixture();
  const { svc, worker, revision } = await setup(undefined, dir);
  const srv = createServer(buildHandler(svc));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (op: string, body: unknown) => fetch(`${base}/api/v1/components/C11/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
  try {
    const fn = svc.store.entities(revision).find((e) => e.kind === "function" && e.spans.length > 0)!;
    assert.ok(fn, "the fixture has a function with a span");

    const ok = await post("conceptCode", { revision, entityId: fn.entityId });
    assert.equal(ok.status, 200);
    const code = ok.body.value as EntityCode;
    assert.equal(code.state, "CURRENT");
    assert.equal(code.file, fn.file);
    assert.ok(code.text.includes(fn.name), "the text is the function's own source");
    assert.ok(code.startLine >= 1 && code.endLine >= code.startLine);
    assert.equal(code.truncated, false);

    assert.equal((await post("conceptCode", { revision, entityId: "function:no/such.ts#nothing" })).status, 404, "an unknown element is not found, not empty");
    assert.equal((await post("conceptCode", { revision })).status, 400);
    assert.equal((await post("conceptCode", { revision, entityId: "x".repeat(601) })).status, 400);
    assert.equal((await post("conceptCode", { revision: "rev:none", entityId: fn.entityId })).status, 404);

    // The file changes after indexing: the answer says so rather than showing moved lines as current.
    const path = join(dir, fn.file);
    writeFileSync(path, "// a new first line\n" + readFileSync(path, "utf8"));
    const stale = (await post("conceptCode", { revision, entityId: fn.entityId })).body.value as EntityCode;
    assert.equal(stale.state, "STALE");

    // A path the caller may not see is withheld: no text, and the path itself is not named.
    svc.store.denyPath(svc.store.revision(revision)!.repoRoot, fn.file);
    const hidden = (await post("conceptCode", { revision, entityId: fn.entityId })).body.value as EntityCode;
    assert.equal(hidden.state, "WITHHELD");
    assert.equal(hidden.text, "");
    assert.equal(hidden.file, "(not shown)");
  } finally { srv.close(); worker.close(); }
});
