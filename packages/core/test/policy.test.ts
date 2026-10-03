import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvidenceBundle } from "@cie/schema";
import { detectSecret, scrubBundle } from "../src/policy.ts";

const ev = (id: string) => ({ id, sourceId: "a.ts", location: { kind: "CodeLocation" }, class: "STATIC_PARSED" as const, observedAt: "", accessScopeId: "local", state: "CURRENT" as const });
const mk = (name: string): EvidenceBundle => ({
  id: "b", revision: "r", evidence: [ev("ev:1"), ev("ev:2")],
  entities: [
    { entityId: "function:a.ts#ok", kind: "function", name: "ok", file: "a.ts", spans: [] },
    { entityId: `function:a.ts#${name}`, kind: "function", name, file: "a.ts", spans: [] },
  ],
  relationships: [{ id: "r1", from: "function:a.ts#ok", to: `function:a.ts#${name}`, kind: "calls", evidence: [ev("ev:1")], resolution: "RESOLVED" }],
  facts: [{ id: "f1", subject: "function:a.ts#ok", predicate: "publishes", object: { kind: "ScalarValue", value: "topic-AKIAIOSFODNN7EXAMPLE" }, evidence: [ev("ev:2")], resolution: "PARSED" }],
  coverage: [], unresolved: [], tokenEstimate: 1,
});

test("secret canaries are detected", () => {
  for (const s of ["AKIAIOSFODNN7EXAMPLE", "ghp_" + "a".repeat(36), "xoxb-1234567890-abcdef", "sk-" + "a".repeat(30), "-----BEGIN RSA PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij", "a".repeat(40), "A".repeat(60)]) assert.ok(detectSecret(s), s);
  for (const s of ["AuthService.login", "src/auth/token.ts", "refund.requested", "InsufficientFundsError"]) assert.equal(detectSecret(s), null, s);
});

test("scrubbing removes secret-bearing entities, facts and their edges, and keeps the rest grounded", () => {
  const r = scrubBundle(mk("handler_" + "x".repeat(60)));
  assert.deepEqual(r.bundle.entities.map((e) => e.entityId), ["function:a.ts#ok"]);
  assert.equal(r.bundle.relationships.length, 0);
  assert.equal(r.bundle.facts.length, 0);
  assert.ok(r.removed.length >= 3);
  const payload = JSON.stringify(r.bundle);
  assert.ok(!payload.includes("AKIA") && !payload.includes("xxxxxxxx"));
  assert.equal(r.bundle.evidence.length, 0, "evidence only for what remains");
});

test("clean bundles pass through unchanged", () => {
  const b = mk("fine");
  b.facts = [];
  const r = scrubBundle(b);
  assert.equal(r.removed.length, 0);
  assert.equal(r.bundle.entities.length, 2);
});

test("long file paths are not mistaken for keys; git history never leaves the machine", () => {
  assert.equal(detectSecret("function:src/payments/capture-worker/handlers/refund-processing-service.ts#handleRefundRequest"), null);
  assert.equal(detectSecret("a".repeat(30) + "/" + "b".repeat(30) + "/" + "c".repeat(30)), null, "separated words, none long enough");
  const b = mk("fine");
  b.facts = [{ id: "h", subject: "file:a.ts", predicate: "history", object: { kind: "ScalarValue", value: { lastCommit: "a".repeat(40), lastAuthor: "Dana Example", lastSubject: "Fix payroll bug" } }, evidence: [ev("ev:1")], resolution: "OBSERVED" }];
  const r = scrubBundle(b);
  assert.equal(r.bundle.facts.length, 0);
  assert.equal(r.minimized, 1);
  assert.equal(r.removed.length, 0, "minimizing is not reported as a secret removal");
  assert.ok(!JSON.stringify(r.bundle).includes("Dana"));
});
