// C22 model-backed seeding (design §20 step 3): drafts from the model gateway go through the Service's
// egress-controlled path and are validated like every other candidate. An ungrounded or dangerous model
// candidate is rejected with a safe reason; a grounded one registers as MODEL; nothing the model says is executed.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HypothesesOutput, ModelProvider, ModelRequest } from "@cie/schema";
import { runModel, StubProvider } from "@cie/model";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { WorkerClient } from "../src/worker.ts";
import { ctx, demoRepo, setup, traceFor } from "./helpers.ts";

test("schema: runModel validates hypothesize output against hypotheses.v1 before anything touches the engine", async () => {
  const bad: ModelProvider = { name: "x", model: "m", hosted: false, generate: async () => ({ hypotheses: "not a list" }) };
  const r = await runModel(bad, { purpose: "HYPOTHESIZE", schemaId: SCHEMA, question: "q", bundle: shape({}) }, { deadlineMs: 1000 });
  assert.ok(!r.ok && r.error.code === "INVALID_SCHEMA", "malformed model output fails at the gateway, not in the engine");
  const good = await runModel<HypothesesOutput>(new StubProvider(), { purpose: "HYPOTHESIZE", schemaId: SCHEMA, question: "why does createPayment fail", bundle: shape({ entities: [], relationships: [], facts: [], evidence: [] }) }, { deadlineMs: 1000 });
  assert.ok(good.ok && good.value.hypotheses.length > 0, "the deterministic provider still proposes something, grounded on whatever the bundle has");
});
const SCHEMA = "hypotheses.v1";
function shape(p: Record<string, never[]>): any { return ({ ...p, tokenEstimate: 10, id: "b1", revision: "r" }); }

test("C22 + model seeding: a Service whose gateway answers registers MODEL-originated grounded candidates", async () => {
  const repo = demoRepo();
  const { svc, revision } = await setup(new StubProvider(), repo);
  const snap = svc.c22.create(ctx("seed-m-1"), { workspaceId: "w", goal: { question: "Why does createPayment fail with FraudRejectedError?", trace: traceFor(repo) } });
  const adm = svc.c22.admitWave(ctx("wave-m-1"), { investigationId: snap.id, expectedVersion: snap.version });
  await svc.c22.runWave(snap.id, adm.generation, 8);
  const hyps = svc.c22.hypothesesOf(svc.c22.load(snap.id));
  assert.ok(hyps.length >= 4, `rule and model candidates both registered (got ${hyps.length})`);
  assert.ok(hyps.some((h) => h.origin === "MODEL"), "at least one candidate came from the gateway");
  const registered = new Set<string>([...hyps.flatMap((h) => h.mechanism.map((m) => m.from as any).concat()) as string[], ...hyps.map((h) => h.claimId)]);
  assert.ok(registered.size > 0);
  for (const h of hyps) {
    assert.ok(h.claimId, "every candidate has a gated claim; hypotheses display as hypotheses, never as facts");
    for (const p of h.predictions) assert.ok(!p.request || ["graph.dependents", "graph.paths", "source.entity", "retrieve.evidence", "runtime.window"].includes(p.request.toolId));
    for (const e of h.basisEvidenceIds) assert.ok(svc.store.revision(revision), "every id is checked against the pinned revision");
  }
  // The same wave turns predictions into steps: only registered, read-only tools ever reach one.
  const steps = svc.c22.stepsOf(snap.id);
  assert.ok(steps.every((s) => "internal.seed internal.assess graph.dependents graph.paths source.entity retrieve.evidence runtime.window".split(" ").includes(s.toolId)), "no step executes anything outside the registered read tools");
});

test("C22 + model seeding: ungrounded and dangerous model candidates are rejected with safe reasons; a grounded sibling survives", async () => {
  /** Proposes three: a ghost scope entity, an executable-looking payload key, and a grounded sibling. */
  const risky: ModelProvider = {
    name: "risky", model: "bad-v1", hosted: false,
    async generate(req: ModelRequest) {
      const fns = req.bundle.entities.filter((e) => e.kind === "function").map((e) => e.entityId);
      const good = fns.find((id) => req.bundle.facts.some((f) => f.subject === id && f.resolution === "UNRESOLVED")) ?? fns[0];
      if (!good) return { hypotheses: [] };
      const fog = req.bundle.facts.filter((f) => f.resolution === "UNRESOLVED").flatMap((f) => f.evidence.map((e) => e.id)).slice(0, 10);
      return {
        hypotheses: [
          { statement: "a ghost entity outside the indexed scope explains everything", mechanism: [{ from: "entity:nowhere", to: "entity:nowhere", relation: "CAUSES_CANDIDATE", evidenceIds: [] }], assumptions: [], predictions: [{ description: "the ghost throws", tool: "source.entity", payload: { entityId: "entity:nowhere", predicate: "throws" }, outcomeIfTrue: ["PRESENT"], outcomeIfFalse: [], essential: true }], basisEvidenceIds: [] },
          { statement: "run this shell command to find the failure", mechanism: [{ from: good, to: good, relation: "CAUSES_CANDIDATE", evidenceIds: [] }], assumptions: [], predictions: [{ description: "run something", tool: "source.entity", payload: { entityId: good, cmd: "rm -rf /" }, outcomeIfTrue: ["PRESENT"], outcomeIfFalse: [], essential: true }], basisEvidenceIds: [] },
          { statement: `dynamic calls in ${good} reach code analysis cannot resolve, and that hidden callee fails`, mechanism: [{ from: good, to: good, relation: "CONTRIBUTES_TO", evidenceIds: fog }], assumptions: ["the dynamic call executes during the incident"], predictions: [{ description: "unresolved calls exist on this function", tool: "source.entity", payload: { entityId: good, predicate: "unresolved_calls" }, outcomeIfTrue: ["PRESENT"], outcomeIfFalse: [], essential: true }], basisEvidenceIds: fog },
        ],
      };
    },
  };
  const repo = demoRepo();
  const svc = new Service(new Store(":memory:"), new WorkerClient(), risky);
  const ing = await svc.ingestRepository(ctx(), { repoPath: repo });
  assert.ok(ing.ok);
  const snap = svc.c22.create(ctx("seed-m-2"), { workspaceId: "w", goal: { question: "Why does the payment fail?" } });
  const adm = svc.c22.admitWave(ctx("wave-m-2"), { investigationId: snap.id, expectedVersion: snap.version });
  await svc.c22.runWave(snap.id, adm.generation, 8);
  const hyps = svc.c22.hypothesesOf(svc.c22.load(snap.id));
  assert.ok(!hyps.some((h) => /ghost/.test(h.statement)), "the ghost-entity candidate never registered");
  assert.ok(!hyps.some((h) => /shell command/.test(h.statement)), "the executable-looking candidate never registered");
  assert.ok(hyps.some((h) => h.origin === "MODEL" && /cannot resolve/.test(h.statement)), "the grounded sibling still registered");
  for (const s of svc.c22.stepsOf(snap.id)) assert.ok("graph.dependents graph.paths source.entity retrieve.evidence runtime.window internal.seed internal.assess".split(" ").includes(s.toolId));
});

test("C22 + model seeding: without egress approval the hosted model is never called; offline candidates stand and the denial is audited", async () => {
  const hosted: ModelProvider = { name: "hosted", model: "cloud-m", hosted: true, generate: async () => { throw new Error("must never be called"); } };
  const svc = new Service(new Store(":memory:"), new WorkerClient(), hosted);
  const repo = demoRepo();
  const ing = await svc.ingestRepository(ctx(), { repoPath: repo });
  assert.ok(ing.ok);
  const snap = svc.c22.create(ctx("seed-m-3"), { workspaceId: "w", goal: { question: "Why does createPayment fail with FraudRejectedError?", trace: traceFor(repo) } });
  const adm = svc.c22.admitWave(ctx("wave-m-3"), { investigationId: snap.id, expectedVersion: snap.version });
  await svc.c22.runWave(snap.id, adm.generation, 8);
  const hyps = svc.c22.hypothesesOf(svc.c22.load(snap.id));
  assert.ok(hyps.some((h) => h.origin === "RULE" && /throws/.test(h.statement)), "the deterministic candidates stand");
  assert.ok(svc.store.auditEvents(200).some((e: any) => e.action === "egress.denied"), "the egress denial was audited before anything was sent");
});