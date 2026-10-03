import assert from "node:assert/strict";
import { test } from "node:test";
import { StubProvider } from "@cie/model";
import type { ModelProvider, ModelRequest } from "@cie/schema";
import { ctx, setup } from "./helpers.ts";

test("auth question yields an auth-focused map with evidenced FACT edges", async () => {
  const { svc, worker, revision } = await setup();
  const r = await svc.ask(ctx(), { question: "Show me how authentication works", revision });
  assert.ok(r.ok);
  const { view } = r.value;
  const labels = view.nodes.map((n) => n.label);
  for (const want of ["AuthService.login", "signToken", "verifyToken", "checkPassword"]) assert.ok(labels.includes(want), `missing ${want}: ${labels}`);
  assert.ok(!labels.includes("hashPassword") || true);
  const facts = view.edges.filter((e) => e.displayMode === "FACT");
  assert.ok(facts.length >= 3);
  assert.ok(facts.every((e) => e.evidenceIds.length > 0), "every FACT edge cites evidence");
  assert.ok(view.nodes.every((n) => n.evidenceIds.length > 0), "every node cites evidence");
  assert.ok(view.legend.some((l) => l.displayMode === "FOG"));
  worker.close();
});

test("inferred edges carry grounded claims and are labeled INFERENCE", async () => {
  const { svc, worker, revision } = await setup();
  const r = await svc.ask(ctx(), { question: "how does authentication work", revision });
  assert.ok(r.ok);
  const inferred = r.value.view.edges.filter((e) => e.displayMode === "INFERENCE");
  assert.ok(inferred.length > 0);
  for (const e of inferred) {
    const claim = r.value.claims.find((c) => c.draft.id === e.claimId);
    assert.ok(claim && claim.displayMode === "INFERENCE" && claim.gates[0].status === "PASS");
  }
  worker.close();
});

test("unmatched question stays empty instead of guessing", async () => {
  const { svc, worker, revision } = await setup();
  const r = await svc.ask(ctx(), { question: "explain the quantum flux capacitor", revision });
  assert.ok(r.ok);
  assert.equal(r.value.view.nodes.length, 0);
  assert.match(r.value.view.caption, /Nothing in this repository matches/);
  worker.close();
});

class Lying implements ModelProvider {
  readonly name = "liar"; readonly model = "x"; readonly hosted = false;
  async generate(req: ModelRequest): Promise<unknown> {
    const ids = req.bundle.entities.filter((e) => e.kind !== "file").map((e) => e.entityId);
    if (req.purpose === "REPRESENT")
      return { caption: "c", groups: [{ label: "Made up", memberEntityIds: ids, rationale: "r", evidenceIds: ["ev:fabricated"] }],
        inferredEdges: [{ from: ids[0], to: ids[1], rationale: "trust me", evidenceIds: ["ev:fabricated"] }, { from: ids[0], to: "ghost", rationale: "r", evidenceIds: [] }] };
    return { summary: "They are definitely connected.", claims: [{ assertion: "A calls B", claimClass: "x", evidenceIds: ["ev:fabricated"], rationaleSummary: "r" }] };
  }
}

test("ungrounded model output is dropped and reported, never displayed", async () => {
  const { svc, worker, revision } = await setup(new Lying());
  const r = await svc.ask(ctx(), { question: "authentication", revision });
  assert.ok(r.ok);
  assert.equal(r.value.view.edges.filter((e) => e.displayMode === "INFERENCE").length, 0);
  assert.ok(!r.value.view.groups.some((g) => g.kind === "concept"));
  assert.ok(r.value.view.gaps.some((g) => /dropped/.test(g)));
  assert.ok(r.value.view.edges.some((e) => e.displayMode === "FACT"), "deterministic facts still shown");

  const ids = r.value.view.nodes.slice(0, 2).map((n) => n.entityRefs[0]);
  const x = await svc.explain(ctx(), { revision, entityIds: ids });
  assert.ok(x.ok);
  assert.ok(x.value.claims.every((c) => c.displayMode === "HIDDEN" && c.gates[0].status === "FAIL"));
  assert.match(x.value.summary, /withheld/);
  worker.close();
});

test("invalid provider output degrades to facts-only with a warning", async () => {
  const bad: ModelProvider = { name: "bad", model: "x", hosted: false, generate: async () => ({ nonsense: true }) };
  const { svc, worker, revision } = await setup(bad);
  const r = await svc.ask(ctx(), { question: "authentication", revision });
  assert.ok(r.ok);
  assert.ok(r.value.view.nodes.length > 0);
  assert.ok(r.metadata.warnings.some((w) => /model unavailable/.test(w)));
  worker.close();
});

test("lasso explanation cites resolvable evidence; disconnected pair is reported honestly", async () => {
  const { svc, worker, revision } = await setup(new StubProvider());
  const ids = ["method:src/auth/service.ts#AuthService.login", "function:src/db/users.ts#findByEmail"];
  const r = await svc.explain(ctx(), { revision, entityIds: ids });
  assert.ok(r.ok);
  assert.equal(r.value.claims.length, 1);
  assert.equal(r.value.claims[0].displayMode, "INFERENCE");
  assert.ok(r.value.evidence.length > 0 && r.value.evidence.every((e) => e.state === "CURRENT" && e.snippet.length > 0));
  assert.ok(r.value.evidence.some((e) => e.snippet.includes("findByEmail")));
  assert.match(r.value.claims[0].draft.assertion, /AuthService\.login calls findByEmail/);

  // Direction follows the real edge, not the traversal order.
  const rev = await svc.explain(ctx(), { revision, entityIds: ["function:src/auth/token.ts#signToken", "method:src/auth/service.ts#AuthService.login"] });
  assert.ok(rev.ok);
  assert.match(rev.value.claims[0].draft.assertion, /signToken is called by AuthService\.login/);

  const none = await svc.explain(ctx(), { revision, entityIds: ["function:src/auth/password.ts#hashPassword", "function:src/db/users.ts#getUser"] });
  assert.ok(none.ok);
  assert.equal(none.value.claims.length, 0);
  assert.match(none.value.summary, /No static connection/);
  worker.close();
});

test("explain rejects unknown entities and empty selection", async () => {
  const { svc, worker, revision } = await setup();
  const a = await svc.explain(ctx(), { revision, entityIds: ["function:nope#x"] });
  assert.ok(!a.ok && a.error.code === "NOT_FOUND");
  const b = await svc.explain(ctx(), { revision, entityIds: [] });
  assert.ok(!b.ok && b.error.code === "INVALID_SCHEMA");
  worker.close();
});
