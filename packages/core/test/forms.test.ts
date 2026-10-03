import assert from "node:assert/strict";
import { test } from "node:test";
import type { ViewNode } from "@cie/schema";
import { ctx, demoRepo, setup, traceFor } from "./helpers.ts";

const label = (n: ViewNode) => n.label;

test("failure question → CausalGraph listing every failure site with cited evidence; async-only ones are hypotheses", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const r = await svc.ask(ctx(), { question: "Show me everything that could cause a payment to fail", revision });
  assert.ok(r.ok);
  const { view, claims } = r.value;
  assert.equal(view.formId, "CausalGraph");
  assert.equal(view.meta?.kind, "failure");
  const sites = view.nodes.filter((n) => n.role === "failure-site");
  const names = sites.map(label);
  for (const want of ["DuplicateRequestError", "FraudRejectedError", "InsufficientFundsError", "CardDeclinedError", "GatewayTimeoutError", "CaptureFailedError"]) assert.ok(names.includes(want), `missing ${want}: ${names}`);
  assert.ok(sites.every((n) => n.evidenceIds.length > 0), "every failure site cites its throw");
  assert.ok(view.edges.every((e) => e.evidenceIds.length > 0), "every edge cites evidence");
  const capture = sites.find((n) => n.label === "CaptureFailedError")!;
  const fraud = sites.find((n) => n.label === "FraudRejectedError")!;
  assert.equal(capture.displayMode, "HYPOTHESIS", "crosses an async hand-off");
  assert.match(capture.notes!.join(" "), /async/i);
  assert.equal(fraud.displayMode, "INFERENCE");
  const cc = claims.find((c) => c.draft.id === capture.claimIds[0])!;
  assert.match(cc.counterArgument, /asynchronous boundary/);
  assert.equal(cc.gates.find((g) => g.gate === "CONSISTENCY")!.status, "PASS", "the path was re-verified against the graph");
  assert.equal(cc.gates.find((g) => g.gate === "ADVERSARIAL")!.status, "INSUFFICIENT");
  assert.match(view.caption, /only through an async hand-off/);
  assert.deepEqual(view.nodes.filter((n) => n.role === "operation").map(label), ["createPayment"], "only real operations that can fail; no error classes, no operations without a failure site");
  worker.close();
});

test("invariant question → every writer of the field, transactional or not, and the async path that reaches it", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const r = await svc.ask(ctx(), { question: "Why could this balance become incorrect?", revision });
  assert.ok(r.ok);
  const { view } = r.value;
  assert.equal(view.formId, "CausalGraph");
  assert.equal(view.meta?.field, "balance");
  const writers = view.nodes.filter((n) => n.role === "writer");
  assert.deepEqual(writers.map(label).sort(), ["adjustBalance", "commit", "reconcileBalances"]);
  const adjust = writers.find((n) => n.label === "adjustBalance")!;
  assert.match(adjust.notes!.join(" "), /outside a transaction/);
  assert.match(adjust.notes!.join(" "), /asynchronous hand-off/, "non-obvious async path to the writer");
  assert.equal(adjust.displayMode, "HYPOTHESIS");
  assert.ok(view.nodes.some((n) => n.label === "openDispute" && n.role === "path"), "the publisher that triggers the async path is shown");
  const asyncEdge = view.edges.find((e) => e.kind === "async-flow")!;
  assert.ok(asyncEdge && asyncEdge.label?.includes("refund.requested") && asyncEdge.evidenceIds.length === 2 && asyncEdge.claimId);
  assert.ok(view.nodes.some((n) => n.role === "state" && n.label === "balance"));
  assert.match(view.caption, /3 function\(s\)/);
  worker.close();
});

test("investigation: pasted trace → ranked suspects with factor breakdown; steering re-ranks; restore undoes it", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const r = await svc.investigate(ctx(), { trace: traceFor(repo), revision });
  assert.ok(r.ok);
  const v1 = r.value.view;
  assert.equal(v1.formId, "HypothesisGraph");
  const suspects = v1.nodes.filter((n) => n.role === "suspect").sort((a, b) => a.rank! - b.rank!);
  assert.equal(suspects[0].label, "checkFraud");
  assert.equal(suspects[0].hypothesisState, "SUPPORTED", "on the stack AND throws the trace's class");
  assert.ok(suspects.map(label).includes("charge") && suspects.map(label).includes("createPayment"));
  for (const s of suspects) {
    assert.equal(s.factors!.length, 6, "all six salience factors are reported");
    assert.ok(s.evidenceIds.length > 0 && s.notes!.length > 0);
  }
  assert.ok(suspects[0].factors!.find((f) => f.factor === "RUNTIME_HOTNESS")!.reason.includes("top frame"));
  assert.ok(v1.nodes.some((n) => n.role === "symptom" && n.label.startsWith("FraudRejectedError")));
  assert.ok(v1.gaps.some((g) => /outside this repository/.test(g)));
  // Steering turn 1: ignore.
  const ig = svc.steer(ctx(), { view: v1, action: "IGNORE", entityId: "function:src/payments/fraud.ts#checkFraud" });
  assert.ok(ig.ok);
  assert.equal(ig.value.view.version, v1.version + 1);
  assert.ok(!ig.value.view.nodes.some((n) => n.label === "checkFraud"));
  assert.deepEqual(ig.value.view.ignored, ["function:src/payments/fraud.ts#checkFraud"]);
  assert.ok(ig.value.view.nodes.filter((n) => n.role === "suspect").length >= 2, "others remain ranked");
  // Steering turn 2: why suspect Y?
  const why = svc.whySuspect(ctx(), { view: ig.value.view, target: "charge" });
  assert.ok(why.ok);
  assert.match(why.value.summary, /Ranked #\d/);
  assert.ok(why.value.evidence.length > 0);
  // restore
  const back = svc.steer(ctx(), { view: ig.value.view, action: "RESTORE", entityId: "function:src/payments/fraud.ts#checkFraud" });
  assert.ok(back.ok && back.value.view.nodes.some((n) => n.label === "checkFraud") && back.value.view.version === v1.version + 2);
  worker.close();
});

test("investigation rejects text with nothing in this repo", async () => {
  const { svc, worker, revision } = await setup();
  const bad = await svc.investigate(ctx(), { trace: "TypeError: x\n    at foo (/elsewhere/a.js:1:1)", revision });
  assert.ok(!bad.ok && bad.error.code === "INSUFFICIENT_EVIDENCE");
  const empty = await svc.investigate(ctx(), { trace: "just words", revision });
  assert.ok(!empty.ok);
  worker.close();
});

test("salience: recency uses git history (recently changed ledger outranks untouched fraud check)", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const r = await svc.ask(ctx(), { question: "how do payments and balances work", revision });
  assert.ok(r.ok);
  const f = (name: string) => r.value.view.nodes.find((n) => n.label === name)?.factors?.find((x) => x.factor === "RECENCY");
  const ledger = f("adjustBalance"), fraud = f("checkFraud");
  if (ledger && fraud) {
    assert.ok(ledger.normalizedScore > fraud.normalizedScore);
    assert.match(ledger.reason, /Refund path: drop transaction for latency/);
    assert.ok(ledger.evidenceIds.length === 1);
  } else assert.fail("expected both nodes in view");
  worker.close();
});

test("suspects are only executable code, and on-stack frames outrank merely adjacent code", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const r = await svc.investigate(ctx(), { trace: traceFor(repo), revision });
  assert.ok(r.ok);
  const suspects = r.value.view.nodes.filter((n) => n.role === "suspect").sort((a, b) => a.rank! - b.rank!);
  assert.ok(suspects.every((n) => n.kind === "function" || n.kind === "method"), "no error classes as suspects");
  const names = suspects.map(label);
  assert.ok(names.indexOf("charge") < names.indexOf("reserve") || !names.includes("reserve"), "stack frames outrank adjacent code");
  assert.ok(names.indexOf("createPayment") < names.indexOf("velocity") || !names.includes("velocity"));
  worker.close();
});

import type { ModelProvider, ModelRequest } from "@cie/schema";
import { StubProvider } from "@cie/model";

class Clusterer implements ModelProvider {
  readonly name = "clusterer"; readonly model = "x"; readonly hosted = false; private inner = new StubProvider();
  private mode: "good" | "ungrounded";
  constructor(mode: "good" | "ungrounded") { this.mode = mode; }
  async generate(req: ModelRequest) {
    const out: any = await this.inner.generate(req);
    if (req.purpose === "REPRESENT") {
      const labels = out.groups.map((g: any) => g.label);
      out.groups.forEach((g: any, i: number) => { g.cluster = i < labels.length / 2 ? "Front" : "Back"; if (this.mode === "ungrounded") g.evidenceIds = ["ev:invented"]; });
    }
    return out;
  }
}

test("domains: a model-proposed intermediate abstraction nests concept groups, is grounded, and falls back when it is not", async () => {
  const good = await setup(new Clusterer("good"), demoRepo());
  const r = await good.svc.ask(ctx(), { question: "how do payments and balances work", revision: good.revision });
  assert.ok(r.ok);
  const v = r.value.view;
  const clusters = v.groups.filter((g) => g.kind === "cluster");
  assert.equal(clusters.length, 2);
  for (const c of clusters) assert.ok(c.evidenceIds.length > 0 && c.displayMode === "INFERENCE");
  const concept = v.groups.filter((g) => g.kind === "concept");
  assert.ok(concept.every((g) => clusters.some((c) => c.id === g.parentGroupId)), "every concept sits inside a domain");
  assert.ok(r.value.claims.some((c) => c.draft.claimClass === "domain-cluster" && c.gates.length === 5));
  assert.ok(v.system && v.system.files > 5 && v.system.symbols > 5);
  good.worker.close();

  const bad = await setup(new Clusterer("ungrounded"), demoRepo());
  const b = await bad.svc.ask(ctx(), { question: "how do payments and balances work", revision: bad.revision });
  assert.ok(b.ok);
  assert.equal(b.value.view.groups.filter((g) => g.kind === "cluster").length, 0, "ungrounded domains are dropped");
  assert.equal(b.value.view.groups.filter((g) => g.kind === "concept").length, 0, "their member groups are dropped first, so no domain can be built on them");
  assert.ok(b.value.view.gaps.some((g) => /concept group .* dropped/.test(g)));
  bad.worker.close();
});

test("level-0 system summary lists external dependencies with their import evidence", async () => {
  const { svc, worker, revision } = await setup();
  const r = await svc.ask(ctx(), { question: "Show me how authentication works", revision });
  assert.ok(r.ok);
  const sys = r.value.view.system!;
  assert.ok(sys.externals.some((e) => e.name === "jsonwebtoken") && sys.externals.some((e) => e.name === "bcrypt"));
  assert.ok(sys.externals.every((e) => e.evidenceIds.length > 0 && svc.store.evidence(revision, e.evidenceIds[0])));
  worker.close();
});
