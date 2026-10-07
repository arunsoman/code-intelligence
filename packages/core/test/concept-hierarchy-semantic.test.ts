// Composition rules: the forms the motif catalogue deliberately omits (debit/credit/transfer, leak
// candidates) must come out of compositions of generic motifs, never from a lexicon.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvidenceRef } from "@cie/schema";
import { buildAllPdgs } from "../src/concept-hierarchy/pdg.ts";
import { buildSemanticConcepts } from "../src/concept-hierarchy/semantic-concepts.ts";
import { Store } from "../src/store.ts";
import { LEDGER, RESOURCES, makeRepo, putRevision } from "./concept-hierarchy-helpers.ts";

const conceptsOf = (files: Record<string, string>) => {
  const repo = makeRepo(files);
  const store = new Store(":memory:");
  putRevision(store, "rev-a", repo, files);
  const { pdgs } = buildAllPdgs(store, "rev-a", repo);
  return buildSemanticConcepts(store, "rev-a", pdgs).concepts;
};

test("a guarded subtraction composes into a debit-form; a guarded addition into a credit-form", () => {
  // Two different variables, so the complementary-pair rule does not consume the forms.
  const files = {
    "src/sides.ts": `export function take(balance: number, x: number): number {
  if (x > 0) { balance = balance - x; }
  return balance;
}
export function give(pot: number, x: number): number {
  if (x > 0) { pot = pot + x; }
  return pot;
}
`,
  };
  const concepts = conceptsOf(files);
  const debit = concepts.find((c) => c.kind === "debit-form");
  const credit = concepts.find((c) => c.kind === "credit-form");
  assert.ok(debit && credit, JSON.stringify(concepts.map((c) => c.kind)));
  assert.equal(debit!.compositionRule, "guarded-write+op:sub");
  assert.equal(credit!.compositionRule, "guarded-write+op:add");
  assert.ok(debit!.members[0].endsWith("#take"));
  assert.ok(credit!.members[0].endsWith("#give"));
  assert.equal(debit!.source, "COMPOSITION");
  assert.equal(debit!.soundness.tier, "supported", "a shape claim is supported by structure alone");
});

test("a debit-form and a credit-form over the same variable in different functions compose into a transfer-form", () => {
  const concepts = conceptsOf({ "src/ledger.ts": LEDGER });
  const transfer = concepts.find((c) => c.kind === "transfer-form");
  assert.ok(transfer, JSON.stringify(concepts.map((c) => c.kind)));
  assert.equal(transfer!.compositionRule, "complementary-pair");
  assert.equal(transfer!.members.length, 2);
  assert.deepEqual(transfer!.members.map((m) => m.split("#")[1]).sort(), ["deposit", "withdraw"]);
  assert.equal(transfer!.canonicalMotifHash.length, 16);
});

test("the composed concept replaces the plain guarded-write concept for that function, not the other motifs", () => {
  const concepts = conceptsOf({ "src/ledger.ts": LEDGER });
  const plainGw = concepts.filter((c) => c.kind === "guarded-write");
  assert.deepEqual(plainGw, [], "guarded-write is consumed by the composed forms");
  assert.ok(concepts.some((c) => c.kind === "loop-accumulate" || c.kind === "collect-and-return" || c.kind === "early-exit-guard"), "other motifs still surface");
});

test("an acquire with no release anywhere in the graph is a speculative leak candidate", () => {
  const concepts = conceptsOf({ "src/r.ts": RESOURCES });
  const leak = concepts.find((c) => c.kind === "leak-candidate");
  assert.ok(leak, JSON.stringify(concepts.map((c) => c.kind)));
  assert.equal(leak!.compositionRule, "acquire-without-release");
  assert.equal(leak!.soundness.tier, "speculative");
  assert.ok(leak!.members[0].endsWith("#leaking"));
  assert.ok(!concepts.some((c) => c.kind === "leak-candidate" && c.members[0].endsWith("#withSession")), "the balanced function is not a leak");
});

test("identical shapes in different functions share a canonical hash but keep distinct ids", () => {
  const files = {
    "src/a.ts": `export function wa(b: number, x: number): number {\n  if (x > 0) { b = b - x; }\n  return b;\n}\n`,
    "src/b.ts": `export function wb(b: number, x: number): number {\n  if (x > 0) { b = b - x; }\n  return b;\n}\n`,
  };
  const concepts = conceptsOf(files);
  const debits = concepts.filter((c) => c.kind === "debit-form");
  assert.equal(debits.length, 2);
  assert.equal(debits[0].canonicalMotifHash, debits[1].canonicalMotifHash, "same shape, same canonical identity");
  assert.notEqual(debits[0].id, debits[1].id, "but anchored to different members");
});

test("concepts carry real store evidence when facts exist, and never fabricate evidence ids", () => {
  const files = { "src/ledger.ts": LEDGER };
  const repo = makeRepo(files);
  const store = new Store(":memory:");
  putRevision(store, "rev-a", repo, files);
  // A writes fact for withdraw, as the language adapter would record it: the json column embeds the
  // whole Fact (the parser stores the object with its evidence), the ev column the evidence ids.
  const evRef: EvidenceRef = { id: "ev:w1", sourceId: "src/ledger.ts", location: { kind: "CodeLocation", span: { sourceId: "src/ledger.ts", contentHash: "x", revision: "rev-a", startByte: 0, endByteExclusive: 10 } }, class: "STATIC_RESOLVED", observedAt: new Date().toISOString(), accessScopeId: "local", state: "CURRENT" };
  store.putEvidence("rev-a", evRef);
  const fact = { id: "fact:w1", subject: "function:src/ledger.ts#withdraw", predicate: "writes", object: { kind: "field", value: "balance" }, evidence: [evRef], resolution: "RESOLVED" };
  store.db.prepare("insert into facts(revision, id, subject, predicate, resolution, json, file, ev) values (?,?,?,?,?,?,?,?)").run("rev-a", fact.id, fact.subject, fact.predicate, fact.resolution, JSON.stringify(fact), "src/ledger.ts", JSON.stringify(["ev:w1"]));
  const { pdgs } = buildAllPdgs(store, "rev-a", repo);
  const { concepts } = buildSemanticConcepts(store, "rev-a", pdgs);
  const transfer = concepts.find((c) => c.kind === "transfer-form")!;
  assert.deepEqual(transfer.evidenceIds, ["ev:w1"], "evidence comes only from the store");
  assert.ok(concepts.every((c) => c.evidenceIds.every((e) => e === "ev:w1")), "no fabricated evidence anywhere");
});
