import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ClaimState } from "@cie/schema";
import { applyVerdict, gateClaim } from "../src/claims.ts";
import { ALARM_ROLE, TRANSITIONS, canTransition, claimHistory, evidenceChain, grantRole, replayAllAt, replayAt, validateAlarm } from "../src/claim-ledger.ts";
import { retrieveAround } from "../src/retrieval.ts";
import { setup } from "./helpers.ts";

const login = "method:src/auth/service.ts#AuthService.login", sign = "function:src/auth/token.ts#signToken", users = "function:src/db/users.ts#findByEmail";

async function mk(svc: any, revision: string, over: Record<string, unknown> = {}) {
  const bundle = retrieveAround(svc.store, revision, [login, sign, users]);
  const ev = bundle.relationships.find((r) => r.kind === "calls" && r.from === login && r.to === sign)!.evidence.map((e) => e.id);
  return gateClaim({ assertion: "login reaches signToken", claimClass: "structural-path", evidenceIds: ev, rationaleSummary: "t", structure: { kind: "path", entityIds: [login, sign] }, ...over } as any, bundle, { store: svc.store });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("lifecycle transition matrix: every pair is either allowed or rejected by the store, and RETIRED is terminal", async () => {
  const states = Object.keys(TRANSITIONS) as ClaimState[];
  const { svc, worker, revision } = await setup();
  const base = await mk(svc, revision);
  let n = 0;
  for (const from of states) for (const to of states) {
    const c = { ...base, draft: { ...base.draft, id: `m-${n++}` }, state: from, version: 1 };
    svc.store.db.prepare("delete from claims where id = ?").run(c.draft.id);
    svc.store.putClaim(c as any, "t", "transition");
    const expected = from === to || TRANSITIONS[from].includes(to);
    assert.equal(canTransition(from, to), expected);
    if (expected) svc.store.putClaim({ ...c, state: to, version: 2 } as any, "t", "transition");
    else assert.throws(() => svc.store.putClaim({ ...c, state: to, version: 2 } as any, "t", "transition"), /illegal claim transition/, `${from}->${to}`);
  }
  assert.deepEqual(TRANSITIONS.RETIRED, []);
  worker.close();
});

test("disputed claims are shown as hypotheses, are not labels, and are recorded in the ledger", async () => {
  const { svc, worker, revision } = await setup();
  const c = await mk(svc, revision);
  svc.store.putClaim(c);
  const r = applyVerdict(svc.store, { claimId: c.draft.id, verdict: "DISPUTE", explanation: "looks wrong", actorId: "alice", expectedVersion: 1 });
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.claim.displayMode, "HYPOTHESIS"); assert.notEqual(r.claim.state, "REFUTED"); }
  assert.deepEqual(svc.store.verdictCounts("structural-path"), { confirmed: 0, refuted: 0 });
  const h = claimHistory(svc.store, c.draft.id);
  assert.deepEqual(h.map((e) => e.event), ["gate", "verdict.dispute"]);
  assert.equal(h[1].actor, "alice");
  worker.close();
});

test("correction updates all dependent claims: a refutation stales descendants and the ledger records why", async () => {
  const { svc, worker, revision } = await setup();
  const a = await mk(svc, revision); svc.store.putClaim(a);
  const b = await mk(svc, revision, { assertion: "b", dependencyIds: [a.draft.id] }); svc.store.putClaim(b);
  const c = await mk(svc, revision, { assertion: "c", dependencyIds: [b.draft.id] }); svc.store.putClaim(c);
  const r = applyVerdict(svc.store, { claimId: a.draft.id, verdict: "REFUTE", explanation: "wrong", actorId: "bob", expectedVersion: 1 });
  assert.ok(r.ok);
  for (const id of [b.draft.id, c.draft.id]) {
    assert.equal(svc.store.getClaim(id)!.state, "STALE");
    const last = claimHistory(svc.store, id).at(-1)!;
    assert.equal(last.event, "stale.dependency");
    assert.equal(last.actor, "bob");
  }
  worker.close();
});

test("full evidence chain and historical replay: state at any past time is reconstructed from the ledger alone", async () => {
  const { svc, worker, revision } = await setup();
  const c = await mk(svc, revision);
  svc.store.putClaim(c);
  const t0 = new Date().toISOString();
  await sleep(5);
  applyVerdict(svc.store, { claimId: c.draft.id, verdict: "CONFIRM", explanation: "ok", actorId: "alice", expectedVersion: 1 });
  await sleep(5);
  const t1 = new Date().toISOString();
  await sleep(5);
  applyVerdict(svc.store, { claimId: c.draft.id, verdict: "REFUTE", explanation: "no", actorId: "bob", expectedVersion: 2 });
  assert.equal(replayAt(svc.store, c.draft.id, "1970-01-01T00:00:00Z"), null);
  assert.equal(replayAt(svc.store, c.draft.id, t0)!.state, c.state);
  assert.equal(replayAt(svc.store, c.draft.id, t1)!.state, "CONFIRMED");
  assert.equal(replayAt(svc.store, c.draft.id, new Date().toISOString())!.state, "REFUTED");
  assert.equal(replayAllAt(svc.store, t1)[c.draft.id].state, "CONFIRMED");
  const chain = evidenceChain(svc.store, c.draft.id)!;
  assert.ok(chain.evidence.length > 0 && chain.evidence.every((e: any) => !e.missing));
  assert.equal(chain.verdicts.length, 2);
  assert.deepEqual(chain.history.map((e) => e.to), [c.state, "CONFIRMED", "REFUTED"]);
  assert.deepEqual(chain.history.map((e) => e.seq), [1, 2, 3]);
  worker.close();
});

test("alarm without proof or required approvals is rejected; deterministic proof or two authorised confirmations qualify", async () => {
  const { svc, worker, revision } = await setup();
  const c = await mk(svc, revision);
  svc.store.putClaim(c);
  const classes = c.draft.evidenceIds.map((id) => svc.store.evidence(revision, id)!.class);
  const proofId = c.draft.evidenceIds.find((id) => ["STATIC_RESOLVED", "TEST", "RUNTIME"].includes(svc.store.evidence(revision, id)!.class));
  // No proof ids supplied, no confirmations: rejected.
  assert.equal(validateAlarm(svc.store, c).eligible, false);
  // A parsed-only fact (or any non-cited id) is not proof.
  assert.equal(validateAlarm(svc.store, c, ["ev:not-cited"]).eligible, false);
  if (proofId) assert.equal(validateAlarm(svc.store, c, [proofId]).basis, "DETERMINISTIC_PROOF");
  else assert.ok(classes.every((k) => k === "STATIC_PARSED"), `classes: ${classes}`);
  // Confirmations by unauthorised principals do not count.
  applyVerdict(svc.store, { claimId: c.draft.id, verdict: "CONFIRM", explanation: "ok", actorId: "mallory", expectedVersion: 1 });
  applyVerdict(svc.store, { claimId: c.draft.id, verdict: "CONFIRM", explanation: "ok", actorId: "eve", expectedVersion: 2 });
  assert.equal(validateAlarm(svc.store, svc.store.getClaim(c.draft.id)!).eligible, false);
  grantRole(svc.store, "mallory", ALARM_ROLE); grantRole(svc.store, "eve", ALARM_ROLE);
  assert.equal(validateAlarm(svc.store, svc.store.getClaim(c.draft.id)!).basis, "TWO_CONFIRMATIONS");
  // The same principal twice is one approval.
  const d = await mk(svc, revision, { assertion: "d" }); svc.store.putClaim(d);
  grantRole(svc.store, "carol", ALARM_ROLE);
  applyVerdict(svc.store, { claimId: d.draft.id, verdict: "CONFIRM", explanation: "ok", actorId: "carol", expectedVersion: 1 });
  applyVerdict(svc.store, { claimId: d.draft.id, verdict: "CONFIRM", explanation: "again", actorId: "carol", expectedVersion: 2 });
  assert.equal(validateAlarm(svc.store, svc.store.getClaim(d.draft.id)!).eligible, false);
  // A refutation withdraws eligibility, even with proof.
  applyVerdict(svc.store, { claimId: c.draft.id, verdict: "REFUTE", explanation: "no", actorId: "eve", expectedVersion: 3 });
  const refuted = svc.store.getClaim(c.draft.id)!;
  assert.equal(validateAlarm(svc.store, refuted, proofId ? [proofId] : []).eligible, false);
  worker.close();
});

test("fabricated spans: a claim citing evidence that does not exist is not grounded and is hidden", async () => {
  const { svc, worker, revision } = await setup();
  const c = await mk(svc, revision, { evidenceIds: ["ev:fabricated-span"], assertion: "fabricated" });
  const g = c.gates.find((x) => x.gate === "GROUNDING")!;
  assert.equal(g.status, "FAIL");
  assert.match(g.reasons.join(" "), /not in the retrieved bundle/);
  assert.equal(c.state, "DRAFTED");
  assert.equal(c.displayMode, "HIDDEN");
  worker.close();
});

test("contradictory graph edge: a claim whose hop has no static edge fails CONSISTENCY and is hidden", async () => {
  const { svc, worker, revision } = await setup();
  const c = await mk(svc, revision, { structure: { kind: "path", entityIds: [sign, users] }, assertion: "contradiction" });
  assert.equal(c.gates.find((x) => x.gate === "CONSISTENCY")!.status, "FAIL");
  assert.equal(c.displayMode, "HIDDEN");
  worker.close();
});

test("low-confidence claims are never styled as facts: no estimate, and a distinct dotted hypothesis style exists on canvas", async () => {
  const { svc, worker, revision } = await setup();
  const c = await mk(svc, revision);
  assert.equal(c.confidence.mode, "NOT_ESTIMATED");
  assert.notEqual(c.displayMode, "FACT");
  worker.close();
  const canvas = readFileSync(new URL("../../../apps/web/src/Canvas.tsx", import.meta.url), "utf8");
  assert.match(canvas, /node\[display = 'HYPOTHESIS'\]", style: \{ "border-style": "dotted"/);
  assert.match(canvas, /edge\[display = 'HYPOTHESIS'\]", style: \{ "line-style": "dotted"/);
});

test("re-deriving a claim never erases a human verdict: a refuted claim keeps its state and verdicts when the same claim is gated again", async () => {
  const { svc, worker, revision } = await setup();
  const c = await mk(svc, revision);
  svc.store.putClaim(c);
  applyVerdict(svc.store, { claimId: c.draft.id, verdict: "REFUTE", explanation: "no", actorId: "bob", expectedVersion: 1 });
  svc.store.putClaim(await mk(svc, revision)); // the same claim, derived again
  const after = svc.store.getClaim(c.draft.id)!;
  assert.equal(after.state, "REFUTED");
  assert.equal(after.verdicts.length, 1);
  worker.close();
});
