import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
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
