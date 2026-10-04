import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ctx, demoRepo, setup } from "./helpers.ts";

test("every extraction is an immutable version; the store reports what changed between versions", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const e1 = await svc.extractConcepts(ctx(), { revision });
  assert.ok(e1.ok);
  const s1 = svc.conceptStore(ctx(), {});
  assert.ok(s1.ok && s1.value.version === 1 && s1.value.versions.length === 1 && s1.value.diff === null);
  assert.equal(s1.value.cards.length, e1.value.cards.length);
  assert.ok(s1.value.cards.every((c) => s1.value.claims[c.claimId]), "each card carries its claim");

  // The repository changes: a new function that publishes to a new topic and throws a new error class.
  appendFileSync(join(repo, "src/refunds/refund-worker.ts"), '\nexport class RefundLimitError extends Error {}\nexport function auditRefund(a: number) { if (a > 5) throw new RefundLimitError("x"); queue.publish("refund.audited", { a }); }\n');
  const r2 = await svc.ingestRepository(ctx(), { repoPath: repo });
  assert.ok(r2.ok);
  const e2 = await svc.extractConcepts(ctx(), { revision: r2.value.id });
  assert.ok(e2.ok);
  const s2 = svc.conceptStore(ctx(), {});
  assert.ok(s2.ok && s2.value.version === 2 && s2.value.versions.map((v) => v.version).join() === "2,1");
  assert.equal(s2.value.diff!.against, 1);
  assert.ok(s2.value.diff!.added.some((t) => /RefundLimitError/.test(t)), JSON.stringify(s2.value.diff));
  // Version 1 is still readable exactly as it was.
  const old = svc.conceptStore(ctx(), { version: 1 });
  assert.ok(old.ok && old.value.cards.length === e1.value.cards.length && !old.value.cards.some((c) => /RefundLimitError/.test(c.title)));
  worker.close();
});

test("a refuted card stops influencing ranking; confirming one does not make it proof", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  await svc.extractConcepts(ctx(), { revision });
  const before = svc.store.concepts(revision);
  const card = before.find((c) => c.kind === "failure-mode" && c.title.includes("FraudRejectedError"))!;
  const claim = svc.store.getClaim(card.claimId)!;
  const r = svc.verdict(ctx(), { claimId: claim.draft.id, verdict: "REFUTE", explanation: "not a real failure mode", expectedVersion: claim.version });
  assert.ok(r.ok);
  assert.ok(!svc.store.concepts(revision).some((c) => c.id === card.id), "refuted card is excluded from retrieval");
  const store = svc.conceptStore(ctx(), {});
  assert.ok(store.ok && store.value.cards.some((c) => c.id === card.id), "but it is still visible in the store, marked refuted");
  assert.equal(store.value.claims[card.claimId].state, "REFUTED");
  worker.close();
});

test("stated confidence is compared with your verdicts and abstains until there are enough", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  await svc.extractConcepts(ctx(), { revision });
  const first = svc.conceptStore(ctx(), {});
  assert.ok(first.ok);
  for (const row of first.value.statedConfidence) { assert.equal(row.band, null); assert.match(row.note, /not calibrated yet/); }
  // Judge six "medium" cards: 4 confirmed, 2 refuted.
  const mediums = first.value.cards.filter((c) => c.statedConfidence === "medium");
  assert.ok(mediums.length >= 6, `need ≥6 medium cards, have ${mediums.length}`);
  mediums.slice(0, 6).forEach((c, i) => {
    const cl = svc.store.getClaim(c.claimId)!;
    assert.ok(svc.verdict(ctx(), { claimId: cl.draft.id, verdict: i < 4 ? "CONFIRM" : "REFUTE", explanation: "checked", expectedVersion: cl.version }).ok);
  });
  const after = svc.conceptStore(ctx(), {});
  assert.ok(after.ok);
  const med = after.value.statedConfidence.find((x) => x.level === "medium")!;
  assert.equal(med.confirmed, 4); assert.equal(med.refuted, 2);
  assert.ok(med.band && med.band.n === 6 && med.band.lower < 0.67 && med.band.upper > 0.67);
  assert.match(med.note, /4\/6/);
  assert.equal(after.value.statedConfidence.find((x) => x.level === "high")!.band, null, "other levels still abstain");
  worker.close();
});

test("an oversized extraction chunk is split instead of skipped", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  process.env.CIE_CHUNK_TOKEN_BUDGET = "400"; // far below any real chunk: forces repeated halving
  try {
    const e = await svc.extractConcepts(ctx(), { revision });
    assert.ok(e.ok);
    assert.ok(!e.metadata.warnings.some((w) => /BUDGET_EXCEEDED/.test(w)), e.metadata.warnings.join("; "));
    assert.ok(e.value.cards.length > 0);
  } finally { delete process.env.CIE_CHUNK_TOKEN_BUDGET; }
  worker.close();
});

// ------------------------------------------------------------------------------------------------ C11 acceptance
import { rmSync, writeFileSync } from "node:fs";
import { StubProvider } from "@cie/model";
import type { ModelProvider, ModelRequest } from "@cie/schema";
import { buildAtlas } from "../src/forms/atlas.ts";
import { gateClaim } from "../src/claims.ts";

const SEEDS: { kind: string; title: RegExp; why: string }[] = [
  { kind: "invariant", title: /balance/i, why: "balance is written outside a transaction in one place" },
  { kind: "workflow", title: /refund\.requested/, why: "an async refund workflow over the refund.requested topic" },
  { kind: "failure-mode", title: /FraudRejectedError/, why: "the fraud check throws this error class" },
  { kind: "capability", title: /payment/i, why: "payments is a capability of the repository" },
];

test("seeded business concepts: the known concepts are found, each cited and resolvable, and a concept that is not in the code is not invented", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const r = await svc.extractConcepts(ctx(), { revision });
  assert.ok(r.ok);
  const cards = r.value.cards;
  const found = SEEDS.filter((s) => cards.some((c) => c.kind === s.kind && s.title.test(c.title)));
  const recall = found.length / SEEDS.length;
  assert.ok(recall >= 0.75, `recall ${recall}: missing ${SEEDS.filter((s) => !found.includes(s)).map((s) => s.why)}`);
  console.log(`# seeded concepts: recall ${found.length}/${SEEDS.length} over ${cards.length} cards`);
  for (const c of cards) {
    assert.ok(c.evidenceIds.length > 0 && c.evidenceIds.every((id) => svc.store.evidence(revision, id)), `${c.title} cites stored evidence`);
    assert.ok(c.members.length > 0 && c.members.every((m) => svc.store.entitiesById(revision, [m]).length === 1), `${c.title} has real members`);
    assert.notEqual(svc.store.getClaim(c.claimId)!.displayMode, "FACT", "a concept is never fact");
  }
  assert.ok(!cards.some((c) => /kubernetes|autoscal|blockchain/i.test(c.title)));
  // A model that invents a concept with forged evidence has it dropped and reported.
  const liar: ModelProvider = { name: "liar", model: "x", hosted: false, async generate(req: ModelRequest) { const o: any = await new StubProvider().generate(req); if (req.schemaId === "concepts.v1") o.cards.push({ kind: "capability", title: "Kubernetes autoscaling", summary: "scales pods", memberEntityIds: [req.bundle.entities[0].entityId], evidenceIds: ["ev:forged"], statedConfidence: "high" }); return o; } };
  const t2 = await setup(liar, demoRepo());
  const r2 = await t2.svc.extractConcepts(ctx(), { revision: t2.revision });
  assert.ok(r2.ok && !r2.value.cards.some((c) => /kubernetes/i.test(c.title)) && r2.value.dropped.some((d) => /Kubernetes autoscaling: ungrounded/.test(d)));
  worker.close(); t2.worker.close();
});

test("incorrect merges: one concept seen in parts is united, not overwritten; the merge is flagged, and refuting it hides it and stales what rested on it", async () => {
  process.env.CIE_CHUNK_TOKEN_BUDGET = "400";
  const seen: string[][] = [];
  // Every chunk reports a card called "Money handling" with only the entities of that chunk, and a confidence that varies.
  const parts: ModelProvider = { name: "parts", model: "x", hosted: false, async generate(req: ModelRequest) {
    if (req.schemaId !== "concepts.v1") return new StubProvider().generate(req);
    const ents = req.bundle.entities.filter((e) => e.kind !== "file");
    seen.push(ents.map((e) => e.entityId));
    const ev = req.bundle.evidence.slice(0, 2).map((e) => e.id);
    return { cards: ents.length && ev.length ? [{ kind: "domain-concept", title: "Money handling", summary: "moves money", memberEntityIds: ents.map((e) => e.entityId), evidenceIds: ev, statedConfidence: seen.length % 2 ? "high" : "low" }] : [] };
  } };
  const { svc, worker, revision } = await setup(parts, demoRepo());
  let r: Awaited<ReturnType<typeof svc.extractConcepts>>;
  try { r = await svc.extractConcepts(ctx(), { revision }); } finally { delete process.env.CIE_CHUNK_TOKEN_BUDGET; }
  assert.ok(r.ok);
  assert.ok(seen.length >= 2, `${seen.length} chunk(s): the test needs the repository split`);
  const card = r.value.cards.find((c) => c.title === "Money handling")!;
  assert.equal(r.value.cards.filter((c) => c.title === "Money handling").length, 1, "one concept, one card");
  const all = new Set(seen.flat());
  assert.deepEqual([...card.members].sort(), [...all].sort(), "no chunk's members were lost to the last writer");
  assert.match(card.source, /merged from \d+ partial extractions/);
  assert.equal(card.statedConfidence, "low", "the merged card is as unsure as its least sure part");
  const claim = svc.store.getClaim(card.claimId)!;
  assert.equal(claim.draft.evidenceIds.length, card.evidenceIds.length, "its claim cites everything the card does");
  // Something is derived from the merged card; a person decides it was a wrong merge.
  const child = gateClaim({ assertion: "money handling is centralised", claimClass: "derived", evidenceIds: card.evidenceIds, rationaleSummary: "t", dependencyIds: [claim.draft.id] }, { id: "b", revision, evidence: card.evidenceIds.map((id) => svc.store.evidence(revision, id)!), entities: [], relationships: [], facts: [], coverage: [], unresolved: [], tokenEstimate: 0 });
  svc.store.putClaim(child);
  const v = svc.verdict(ctx(), { claimId: claim.draft.id, verdict: "REFUTE", explanation: "these are different things", expectedVersion: claim.version });
  assert.ok(v.ok);
  assert.ok(!svc.store.concepts(revision).some((c) => c.id === card.id), "the refuted merge no longer influences retrieval");
  assert.equal(svc.store.getClaim(child.draft.id)!.state, "STALE");
  worker.close();
});

test("correction propagation: a refuted concept disappears from the atlas view and its dependents are stale; a confirmed one stays an inference", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  await svc.extractConcepts(ctx(), { revision });
  const rev = svc.store.revision(revision)!;
  const before = buildAtlas(svc.store, rev, "show the implicit concepts");
  const names = (b: any) => b.view.nodes.map((n: any) => n.label);
  const cards = svc.store.concepts(revision);
  const target = cards.find((c) => c.kind === "failure-mode")!;
  const other = cards.find((c) => c.kind === "workflow")!;
  const tclaim = svc.store.getClaim(target.claimId)!;
  const dep = gateClaim({ assertion: "depends on the failure mode", claimClass: "derived", evidenceIds: target.evidenceIds, rationaleSummary: "t", dependencyIds: [tclaim.draft.id] }, { id: "b", revision, evidence: target.evidenceIds.map((id) => svc.store.evidence(revision, id)!), entities: [], relationships: [], facts: [], coverage: [], unresolved: [], tokenEstimate: 0 });
  svc.store.putClaim(dep);
  assert.ok(svc.verdict(ctx(), { claimId: tclaim.draft.id, verdict: "REFUTE", explanation: "no", expectedVersion: tclaim.version }).ok);
  const oc = svc.store.getClaim(other.claimId)!;
  assert.ok(svc.verdict(ctx(), { claimId: oc.draft.id, verdict: "CONFIRM", explanation: "yes", expectedVersion: oc.version }).ok);
  const after = buildAtlas(svc.store, rev, "show the implicit concepts");
  assert.ok(names(before).some((n: string) => n.includes(target.title)) || before.view.nodes.length > 0);
  assert.ok(!names(after).some((n: string) => n.includes(target.title)), "the refuted concept is gone from the atlas");
  assert.equal(svc.store.getClaim(dep.draft.id)!.state, "STALE");
  const confirmed = svc.store.getClaim(other.claimId)!;
  assert.equal(confirmed.state, "CONFIRMED");
  assert.notEqual(confirmed.displayMode, "FACT", "a confirmation is a judgment, not proof");
  worker.close();
});

test("regeneration after changed cited code: unchanged regions are carried over, a changed region is re-extracted against the new code, and a card whose code is gone is dropped", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const e1 = await svc.extractConcepts(ctx(), { revision });
  assert.ok(e1.ok);
  const fraudCard = e1.value.cards.find((c) => c.members.some((m) => /checkFraud/.test(m)))!;
  assert.ok(fraudCard);
  // Change the body of a function a card cites (not just add code beside it).
  const f = join(repo, "src/payments/fraud.ts");
  const src = readFileSync(f, "utf8");
  writeFileSync(f, src.replace(/checkFraud\(([^)]*)\)\s*\{/, (m) => `${m}\n  void 0; // changed`));
  const r2 = await svc.ingestRepository(ctx(), { repoPath: repo });
  assert.ok(r2.ok);
  const e2 = await svc.extractConcepts(ctx(), { revision: r2.value.id });
  assert.ok(e2.ok);
  assert.ok(e2.metadata.warnings.some((w) => /Incremental: \d+ concept card\(s\) carried over/.test(w)), e2.metadata.warnings.join("|"));
  const after = e2.value.cards;
  const carried = after.filter((c) => /carried over/.test(c.source));
  assert.ok(carried.length > 0, "regions whose code did not change were carried over");
  assert.ok(carried.every((c) => !c.members.some((m) => /checkFraud/.test(m))), "no carried-over card contains the changed function");
  const redone = after.find((c) => c.members.some((m) => /checkFraud/.test(m)))!;
  assert.ok(redone && !/carried over/.test(redone.source), "the changed region was extracted again, from the new code");
  for (const c of after) assert.ok(c.evidenceIds.every((id) => svc.store.evidence(r2.value.id, id)), `${c.title}: every cited span exists in the new revision`);
  assert.ok(after.every((c) => c.revision === r2.value.id), "cards name the revision they were checked against");
  assert.ok(after.every((c) => svc.store.getClaim(c.claimId)!.gates.find((g) => g.gate === "GROUNDING")!.status === "PASS"), "every claim was re-gated against the new revision");
  const s = svc.conceptStore(ctx(), {});
  assert.ok(s.ok && s.value.version === 2 && s.value.diff!.against === 1);
  // Code removed altogether: the cards that rested only on it do not survive, and none points at a missing entity.
  rmSync(join(repo, "src/refunds"), { recursive: true, force: true });
  const r3 = await svc.ingestRepository(ctx(), { repoPath: repo });
  assert.ok(r3.ok);
  const e3 = await svc.extractConcepts(ctx(), { revision: r3.value.id });
  assert.ok(e3.ok);
  const live = new Set(svc.store.entities(r3.value.id).map((e) => e.entityId));
  assert.ok(e3.value.cards.every((c) => c.members.every((m) => live.has(m))), "no card names code that is gone");
  assert.ok(!e3.value.cards.some((c) => /refund\.requested/.test(c.title) && c.members.every((m) => /refund/.test(m))), "the refund workflow is not claimed after its code was deleted");
  worker.close();
});
