import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entity } from "@cie/schema";
import type { Store } from "../src/store.ts";
import { OPEN } from "../src/access.ts";
import { resolveMentions } from "../src/mentions.ts";
import { toolByName, type ToolEnv } from "../src/chat-tools.ts";
import { reviewAnswer } from "../src/answer-validation.ts";
import type { RouterModel } from "../src/llm-router.ts";

const entity = (name: string, file: string, text = "", kind = "class"): Entity => ({
  entityId: `${kind}:${file}#${name}`, name, file, kind,
  spans: [{ sourceId: file, contentHash: createHash("sha256").update(text).digest("hex"), startByte: 0, endByteExclusive: Buffer.byteLength(text) }],
} as Entity);
const storeOf = (entities: Entity[]) => ({ entities: () => entities }) as unknown as Store;

test("scenario nouns do not seed unrelated User and Case symbols; explicit identifiers still resolve", () => {
  const store = storeOf([entity("User", "fixtures/shop.ts"), entity("Case", "test/routes.ts"), entity("Payment", "src/payment.ts")]);
  assert.deepEqual(resolveMentions(store, "r", "what is case where a user makes a payment and is not refunded", OPEN).resolved, []);
  for (const question of ["Explain User", "Explain `user`", "Explain class user"]) {
    assert.equal(resolveMentions(store, "r", question, OPEN).resolved[0]?.matches[0].name, "User");
  }
});

test("equal revision IDs in independent stores cannot share a mention index", () => {
  const first = storeOf([entity("AuthService", "src/first.ts")]);
  const second = storeOf([entity("PaymentService", "src/second.ts")]);
  assert.equal(resolveMentions(first, "shared-revision", "AuthService", OPEN).resolved.length, 1);
  assert.deepEqual(resolveMentions(second, "shared-revision", "AuthService", OPEN).resolved, []);
  assert.equal(resolveMentions(second, "shared-revision", "PaymentService", OPEN).resolved.length, 1);
});

test("source reads reject external and denied symlink targets even when indexed path is visible", async () => {
  const dir = mkdtempSync(join(tmpdir(), "source-boundary-")), root = join(dir, "repo");
  mkdirSync(root); mkdirSync(join(root, "denied"));
  const text = "EXTERNAL_OR_DENIED_MARKER";
  const e = entity("Visible", "visible.ts", text, "file");
  const env = { svc: { store: { entitiesById: () => [e], relationshipsFor: () => [], audit: () => {} } },
    rev: { id: "r", repoRoot: root }, ctx: { actor: { principalId: "t" } }, access: { ...OPEN, denied: (file: string) => file.startsWith("denied/") },
    seen: new Map(), results: [], warnings: [] } as unknown as ToolEnv;
  try {
    for (const target of [join(dir, "outside.ts"), join(root, "denied/hidden.ts")]) {
      writeFileSync(target, text); symlinkSync(target, join(root, "visible.ts"));
      const result = await toolByName.get("read_code")!.run!(env, { id: e.entityId });
      assert.doesNotMatch(result, /EXTERNAL_OR_DENIED_MARKER/);
      assert.match(result, /source text unavailable/);
      assert.equal(env.sourceReads?.size ?? 0, 0);
      unlinkSync(join(root, "visible.ts"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("changed source cannot be sliced with old symbol offsets or recorded as inspected", async () => {
  const root = mkdtempSync(join(tmpdir(), "source-offsets-"));
  const e = entity("Original", "source.ts", "function Original() {}", "function");
  const env = { svc: { store: { entitiesById: () => [e], relationshipsFor: () => [], audit: () => {} } },
    rev: { id: "r", repoRoot: root }, ctx: { actor: { principalId: "t" } }, access: OPEN, seen: new Map(), results: [], warnings: [] } as unknown as ToolEnv;
  try {
    writeFileSync(join(root, "source.ts"), "UNRELATED_INSERTION\nfunction Original() {}");
    const result = await toolByName.get("read_code")!.run!(env, { id: e.entityId });
    assert.match(result, /Reindex/); assert.doesNotMatch(result, /UNRELATED_INSERTION/);
    assert.equal(env.sourceReads?.size ?? 0, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const supported = { verifiedBy: ["obs-1"],  verdict: "SUPPORTED", relevance: true, coverage: true, evidence: true, certainty: true, consistency: true, requirements: [], gaps: [], nextAction: "continue" };
test("reviewer format retry recovers a valid assessment without another writer pass", async () => {
  let calls = 0;
  const model: RouterModel = { name: "format-retry", choose: async () => null, converse: async (messages) => {
    calls++;
    if (calls === 2) assert.match(messages[0].content, /nextAction.*must be one of/);
    return { content: "", toolCalls: [{ name: "review_answer", arguments: calls === 1 ? { ...supported, nextAction: "bogus" } : supported }] };
  } };
  const result = await reviewAnswer(model, "Explain AuthService", { text: "Draft", cites: [] }, [], Date.now() + 5000);
  assert.equal(result.verdict, "SUPPORTED"); assert.equal(calls, 2);
});

test("self-contradictory SUPPORTED approval is reconciled to repairable without retrying", async () => {
  let calls = 0;
  const model: RouterModel = { name: "inconsistent-review", choose: async () => null, converse: async () => {
    calls++; return { content: "", toolCalls: [{ name: "review_answer", arguments: { ...supported, coverage: false } }] };
  } };
  const result = await reviewAnswer(model, "Question", { text: "Draft", cites: [] }, [], Date.now() + 5000);
  assert.equal(result.verdict, "REPAIRABLE"); assert.equal(calls, 1);
  assert.match(result.gaps[0], /coverage/);
  assert.equal(result.reconciliation?.originalVerdict, "SUPPORTED");
});

test("persistently invalid reviewer shape is repairable after one format retry, not unresolved", async () => {
  let calls = 0;
  const model: RouterModel = { name: "invalid-review", choose: async () => null, converse: async () => {
    calls++; return { content: "", toolCalls: [{ name: "review_answer", arguments: { ...supported, injected: "x" } }] };
  } };
  const result = await reviewAnswer(model, "Question", { text: "Draft", cites: [] }, [], Date.now() + 5000);
  assert.equal(result.verdict, "REPAIRABLE"); assert.equal(calls, 2);
  assert.match(result.gaps[0], /Unexpected field "injected"/);
});
