// The service surface: buildConceptHierarchy as a job, the read-only view, the audit trail, and the
// version snapshots. Runs hermetically: revisions are stored via putBatch, the worker is never called.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCUMULATE, LEDGER, putRevision, setupService } from "./concept-hierarchy-helpers.ts";
import { ctx as testCtx } from "./helpers.ts";

const files = { "src/ledger.ts": LEDGER, "src/total.ts": ACCUMULATE };

const makeServiceRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "cie-svc-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  return root;
};

test("a hierarchy build produces concepts, invariants, an architecture tree and an audit event", async () => {
  const repo = makeServiceRepo();
  const { svc, store, worker } = setupService(repo);
  try {
    putRevision(svc.store, "rev-a", repo, files);
    const ctx = testCtx();
    const built = await svc.buildConceptHierarchy(ctx, { revision: "rev-a" });
    assert.ok(built.ok, JSON.stringify(built));
    const view = built.value;
    assert.ok(view.concepts.length >= 2, "at least the debit and credit forms");
    assert.ok(view.concepts.every((c) => c.label && c.label.length <= 60), "every concept carries a bounded label");
    assert.ok(view.invariants.length >= 1);
    assert.ok(view.arch.some((n) => n.kind === "repo" && n.children.length >= 1));
    assert.ok(view.arch.some((n) => n.id === "arch:mod:src/ledger.ts"));
    assert.equal(view.version, 1);
    assert.equal(view.versions.length, 1);

    // the audit event, hash-chained like every other
    const events = store.auditEvents(20) as { action: string; resource: string; meta: string }[];
    const ev = events.find((e) => e.action === "concept-hierarchy.build");
    assert.ok(ev, "the build is audited");
    assert.equal(ev!.resource, "rev-a");
    const meta = JSON.parse(ev!.meta);
    assert.equal(meta.concepts, view.concepts.length);
    assert.ok(store.verifyAuditChain().ok);

    // the read-only view reads back the same thing
    const v2 = svc.conceptHierarchy(testCtx(), { revision: "rev-a" });
    assert.ok(v2.ok);
    assert.equal(v2.value.version, 1);
    assert.deepEqual(v2.value.concepts.map((c) => c.id).sort(), view.concepts.map((c) => c.id).sort());
    // an unbuilt revision of another repository reads as empty, not as an error
    const other = mkdtempSync(join(tmpdir(), "cie-svc-none-"));
    mkdirSync(join(other, "src"), { recursive: true });
    writeFileSync(join(other, "src/ledger.ts"), LEDGER);
    putRevision(svc.store, "rev-none", other, { "src/ledger.ts": LEDGER });
    const v3 = svc.conceptHierarchy(testCtx(), { revision: "rev-none" });
    assert.ok(v3.ok && v3.value.version === 0 && v3.value.concepts.length === 0);
  } finally { worker.close(); }
});

test("buildConceptHierarchy runs as a background job", async () => {
  const repo = makeServiceRepo();
  const { svc, worker } = setupService(repo);
  try {
    putRevision(svc.store, "rev-a", repo, files);
    const enq = svc.enqueueJob(testCtx(), { kind: "concept-hierarchy", revision: "rev-a" });
    assert.ok(enq.ok, JSON.stringify(enq));
    const settled = await svc.jobs.settled(enq.value.id);
    assert.equal(settled.state, "SUCCEEDED", JSON.stringify(settled));
    const view = svc.conceptHierarchy(testCtx(), { revision: "rev-a" });
    assert.ok(view.ok && view.value.version === 1);
    assert.ok(settled.result && (settled.result as { value: { concepts: unknown[] } }).value.concepts.length >= 2);
  } finally { worker.close(); }
});

test("naming goes through the gateway: the offline stub answers, and no egress events appear", async () => {
  const repo = makeServiceRepo();
  const { svc, store, worker } = setupService(repo);
  try {
    putRevision(svc.store, "rev-a", repo, files);
    const built = await svc.buildConceptHierarchy(testCtx(), { revision: "rev-a" });
    assert.ok(built.ok);
    assert.ok(built.value.concepts.every((c) => c.namedBy === "MODEL"), "the offline stub names deterministically");
    const egress = store.auditEvents(50).filter((e) => String(e.action).startsWith("egress."));
    assert.deepEqual(egress, [], "a non-hosted model never writes egress events");
  } finally { worker.close(); }
});
