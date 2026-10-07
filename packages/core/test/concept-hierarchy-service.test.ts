// The service surface: buildConceptHierarchy as a job, the read-only view, the audit trail, and the
// version snapshots. Runs hermetically: revisions are stored via putBatch, the worker is never called.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelProvider, ModelRequest } from "@cie/schema";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { WorkerClient } from "../src/worker.ts";
import { ACCUMULATE, LEDGER, fakeWorkerPath, putRevision, setupService } from "./concept-hierarchy-helpers.ts";
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
    assert.ok(built.value.concepts.every((c) => c.namedBy === "FALLBACK"), "the offline stub's names are mechanical; they are never labelled as a model's");
    assert.ok(built.value.concepts.every((c) => c.label && c.label.includes(" in ")), "and they are still real, readable labels");
    assert.match(built.value.versions[0].provider, /^stub\//, "the version says the offline stub wrote them");
    const egress = store.auditEvents(50).filter((e) => String(e.action).startsWith("egress."));
    assert.deepEqual(egress, [], "a non-hosted model never writes egress events");
  } finally { worker.close(); }
});

// The case that produced "collect-and-return in CustomerService.editSubagents" everywhere: a hosted model is configured, but sending code
// structure to it is not approved for the repository, so the gateway quietly has the offline stand-in answer. Those names are
// mechanical and must say so, the version must say who wrote them, and approving the model later must get real names, not the cache.
test("a hosted model that is not approved: mechanical names are labelled so, the version names the real author, and approval upgrades them", async () => {
  const repo = makeServiceRepo();
  const worker = new WorkerClient(fakeWorkerPath());
  let hostedCalls = 0;
  const hosted: ModelProvider = {
    name: "cloud", model: "big", hosted: true,
    async generate(req: ModelRequest) {
      hostedCalls++;
      const q = JSON.parse(req.question) as { concepts?: { conceptId: string; kind: string }[]; packages?: { conceptId: string; path: string }[] };
      return { names: [...(q.concepts ?? []).map((c) => ({ conceptId: c.conceptId, name: `domain name for ${c.kind}` })), ...(q.packages ?? []).map((p) => ({ conceptId: p.conceptId, name: "Payments" }))] };
    },
  };
  const svc = new Service(new Store(":memory:"), worker, hosted);
  try {
    putRevision(svc.store, "rev-a", repo, files);

    const before = await svc.buildConceptHierarchy(testCtx(), { revision: "rev-a" });
    assert.ok(before.ok);
    assert.equal(hostedCalls, 0, "nothing was sent to the hosted model");
    assert.ok(before.value.concepts.every((c) => c.namedBy === "FALLBACK"), "the stand-in's names are not a model's");
    assert.ok(before.value.concepts.every((c) => c.label!.includes(" in ")), "they are the mechanical '<shape> in <function>'");
    assert.match(before.value.versions[0].provider, /^stub\//, "the version records the stand-in, not the model that was configured");
    assert.ok(before.value.stats!.warnings.some((w) => /not approved/.test(w)), "and says why, so the person can fix it: " + JSON.stringify(before.value.stats!.warnings));
    assert.equal(before.value.stats!.naming.named, 0);

    svc.store.setAllowHosted(svc.store.revision("rev-a")!.repoRoot, true);
    const after = await svc.buildConceptHierarchy(testCtx(), { revision: "rev-a" });
    assert.ok(after.ok);
    assert.ok(hostedCalls > 0, "now the model is asked");
    assert.ok(after.value.concepts.every((c) => c.namedBy === "MODEL" && c.label!.startsWith("domain name for ")), "the real names replace the mechanical ones; the old ones were not served from the cache");
    assert.equal(after.value.versions[0].provider, "cloud/big");

    const calls = hostedCalls;
    const again = await svc.buildConceptHierarchy(testCtx(), { revision: "rev-a" });
    assert.ok(again.ok);
    assert.equal(hostedCalls, calls, "a model's names are cached: the same shapes are not asked again");
    assert.ok(again.value.stats!.naming.cacheHits > 0);
  } finally { worker.close(); }
});
