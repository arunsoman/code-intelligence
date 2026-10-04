import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Collab } from "../src/collab.ts";
import { Security } from "../src/security.ts";
import { TenantHost } from "../src/tenants.ts";
import { ctx, demoRepo, setup } from "./helpers.ts";

async function world() {
  const repo = demoRepo();
  const t = await setup(undefined, repo);
  const { svc, revision } = t;
  const collab = new Collab(svc.store, svc.workspaceLog);
  const root = svc.store.revision(revision)!.repoRoot;
  for (const [p, tenant] of [["alice", "acme"], ["bob", "acme"], ["carol", "acme"], ["erin", "acme"], ["dave", "other"]]) collab.addPrincipal(p, tenant);
  collab.setAccess("alice", root, { allowed: true });
  collab.setAccess("bob", root, { allowed: true, deniedPrefixes: ["src/ledger"] });
  collab.setAccess("erin", root, { allowed: true });
  collab.setAccess("dave", root, { allowed: true }); // access to the code, but in another organisation
  // carol: no record at all.
  const q = await svc.ask(ctx(), { question: "how do payments and balances work", revision });
  assert.ok(q.ok);
  const ws = collab.create("alice", { name: "balance bug", revision }) as any;
  assert.ok(ws.ok);
  return { ...t, collab, root, ws: ws.id as string, view: q.value.view, claims: q.value.claims };
}
const ap = (c: Collab, who: string, ws: string, event: any, v: number, extra: object = {}) => c.applyOperation(who, { workspaceId: ws, event, expectedVersion: v, ...extra });

test("concurrent edits: a stale version is a conflict that says what changed, edits keep their author, rebase works only on disjoint things, and a resolution is explicit and logged", async () => {
  const w = await world();
  const { collab, ws } = w;
  assert.ok(collab.share("alice", { workspaceId: ws, principalId: "erin", role: "editor" }).ok);
  assert.ok(collab.share("alice", { workspaceId: ws, principalId: "bob", role: "viewer" }).ok);
  const a = ap(collab, "alice", ws, { kind: "PIN", entityId: "function:src/payments/fraud.ts#checkFraud", on: true }, 0);
  assert.ok(a.ok);
  // Erin started from version 0 as well.
  const e = ap(collab, "erin", ws, { kind: "NOTE", entityId: "function:src/payments/fraud.ts#checkFraud", text: "why 10k?" }, 0);
  assert.ok(!e.ok && e.error.code === "VERSION_CONFLICT" && e.error.currentVersion === 1);
  assert.deepEqual((e as any).since.map((x: any) => [x.kind, x.actor]), [["PIN", "alice"]]);
  // Different thing: she may rebase. The same thing: she may not.
  const rebased = ap(collab, "erin", ws, { kind: "NOTE", entityId: "function:src/payments/fraud.ts#checkFraud", text: "why 10k?" }, 0, { rebase: true });
  assert.ok(rebased.ok && rebased.rebased, "a note and a pin on the same element are different things");
  const clash = ap(collab, "erin", ws, { kind: "PIN", entityId: "function:src/payments/fraud.ts#checkFraud", on: false }, 0, { rebase: true });
  assert.ok(!clash.ok && /same thing/.test(clash.error.message));
  // The settled way: look at the current state, then say explicitly which change wins.
  const settled = ap(collab, "erin", ws, { kind: "PIN", entityId: "function:src/payments/fraud.ts#checkFraud", on: false }, 2, { resolves: [1] });
  assert.ok(settled.ok);
  // Everything is attributed.
  const actors = (w.svc.store.db.prepare("select seq, actor from ws_events where ws = ? order by seq").all(ws) as any[]).map((r) => `${r.seq}:${r.actor}`);
  assert.deepEqual(actors, ["1:alice", "2:erin", "3:erin"]);
  assert.deepEqual(collab.history(ws).map((h) => h.kind).filter((k) => k !== "SHARED"), ["CONFLICT", "CONFLICT", "CONFLICT_RESOLVED"]);
  // A viewer reads but does not write.
  const v = ap(collab, "bob", ws, { kind: "NOTE", entityId: "function:src/payments/fraud.ts#checkFraud", text: "x" }, 3);
  assert.ok(!v.ok && v.error.code === "FORBIDDEN");
  // Someone not on it cannot tell it exists.
  const out = ap(collab, "carol", ws, { kind: "SELECT", ids: [] }, 3);
  assert.ok(!out.ok && out.error.code === "NOT_FOUND");
  w.worker.close();
});

test("denied recipient: sharing cannot give anyone source access, a partly-denied recipient sees a cut-down copy, and edits about code they cannot read are refused", async () => {
  const w = await world();
  const { collab, ws, view, root } = w;
  assert.ok(ap(collab, "alice", ws, { kind: "SET_VIEW", view }, 0).ok);
  assert.ok(ap(collab, "alice", ws, { kind: "PIN", entityId: "function:src/ledger/ledger.ts#adjustBalance", on: true }, 1).ok);
  assert.ok(ap(collab, "alice", ws, { kind: "NOTE", entityId: "function:src/ledger/ledger.ts#adjustBalance", text: "not transactional" }, 2).ok);
  // Carol has no access to the code: the share is refused and leaves nothing behind.
  const refused = collab.share("alice", { workspaceId: ws, principalId: "carol", role: "viewer" });
  assert.ok(!refused.ok && refused.error.code === "FORBIDDEN" && /sharing cannot give it to them/.test(refused.error.message));
  const peek = collab.read("carol", ws);
  assert.ok(!peek.ok && peek.error.code === "NOT_FOUND");
  assert.ok(collab.history(ws).some((h) => h.kind === "SHARE_REFUSED" && h.detail.principal === "carol"));
  // Bob can read most of it but not the ledger: he sees the investigation without it, and is told that something was left out.
  assert.ok(collab.share("alice", { workspaceId: ws, principalId: "bob", role: "editor" }).ok);
  const bob = collab.read("bob", ws) as any;
  assert.ok(bob.ok);
  assert.ok(bob.workspace.state.view.nodes.length > 0 && bob.workspace.state.view.nodes.every((n: any) => !n.file.startsWith("src/ledger")));
  assert.ok(bob.workspace.state.view.edges.every((e: any) => bob.workspace.state.view.nodes.some((n: any) => n.id === e.fromNodeId)));
  assert.deepEqual(bob.workspace.state.pins, []); assert.deepEqual(bob.workspace.state.notes, {});
  assert.ok(bob.withheld.items >= 3 && /do not have access/.test(bob.withheld.note));
  assert.ok(!JSON.stringify(bob).includes("adjustBalance") && !JSON.stringify(bob).includes("not transactional"), "nothing about the hidden code leaks, not even its name or the comment");
  const alice = collab.read("alice", ws) as any;
  assert.equal(alice.withheld.items, 0);
  assert.ok(JSON.stringify(alice).includes("adjustBalance"));
  // Bob cannot write about it either, so the log never holds what he could not see.
  const bad = ap(collab, "bob", ws, { kind: "NOTE", entityId: "function:src/ledger/ledger.ts#reserve", text: "hmm" }, 3);
  assert.ok(!bad.ok && bad.error.code === "FORBIDDEN");
  // Access ending ends reading.
  collab.setAccess("bob", root, { allowed: false });
  const gone = collab.read("bob", ws);
  assert.ok(!gone.ok && gone.error.code === "FORBIDDEN");
  // A sharer cannot grant more than they hold, and cannot make owners.
  collab.setAccess("bob", root, { allowed: true, deniedPrefixes: ["src/ledger"] });
  assert.ok(!collab.share("bob", { workspaceId: ws, principalId: "erin", role: "owner" as any }).ok);
  w.worker.close();
});

test("correction in a shared concept: a team confirmation or refutation is attributed and reaches everyone who can see the concept, and no one else", async () => {
  const w = await world();
  const { collab, svc, revision } = w;
  await svc.extractConcepts(ctx(), { revision });
  const alice = collab.conceptsFor("alice", revision), bob = collab.conceptsFor("bob", revision);
  assert.equal(alice.withheld, 0);
  assert.ok(bob.withheld > 0, "concepts resting on the ledger are not visible to Bob");
  const aliceIds = new Set(alice.concepts.map((c) => c.id));
  const bobIds = new Set(bob.concepts.map((c) => c.id));
  const hiddenFromBob = [...aliceIds].filter((id) => !bobIds.has(id));
  assert.equal(hiddenFromBob.length, bob.withheld);
  const shared = alice.concepts.find((c) => bobIds.has(c.id) && c.kind === "failure-mode")!;
  const claim = (id: string) => svc.store.getClaim(svc.store.concepts(revision, { includeRefuted: true }).find((c) => c.id === id)!.claimId)!;
  // Alice confirms: it is attributed, never fact, and Bob sees it.
  const c1 = collab.confirmSharedConcept("alice", { conceptId: shared.id, verdict: "CONFIRM", explanation: "seen in prod", expectedVersion: claim(shared.id).version }) as any;
  assert.ok(c1.ok && c1.state === "CONFIRMED" && c1.displayMode !== "FACT" && c1.attributedTo === "alice");
  const seen = collab.conceptsFor("bob", revision).concepts.find((c) => c.id === shared.id)!;
  assert.deepEqual([seen.state, seen.confirmedBy], ["CONFIRMED", ["alice"]]);
  // Bob corrects it: the correction is his, and Alice sees the concept as refuted with his name.
  const c2 = collab.confirmSharedConcept("bob", { conceptId: shared.id, verdict: "REFUTE", explanation: "that was fixed in v3", expectedVersion: claim(shared.id).version }) as any;
  assert.ok(c2.ok && c2.state === "REFUTED");
  const after = collab.conceptsFor("alice", revision).concepts.find((c) => c.id === shared.id)!;
  assert.deepEqual([after.state, after.refutedBy], ["REFUTED", ["bob"]]);
  assert.ok(!svc.store.concepts(revision).some((c) => c.id === shared.id), "and it stops influencing retrieval");
  // A stale version is refused.
  const stale = collab.confirmSharedConcept("alice", { conceptId: shared.id, verdict: "CONFIRM", explanation: "again", expectedVersion: 1 }) as any;
  assert.ok(!stale.ok && stale.error.code === "VERSION_CONFLICT");
  // Bob cannot act on, or learn about, a concept he cannot see.
  const secret = hiddenFromBob[0];
  const denied = collab.confirmSharedConcept("bob", { conceptId: secret, verdict: "CONFIRM", explanation: "x", expectedVersion: claim(secret).version }) as any;
  assert.ok(!denied.ok && denied.error.code === "NOT_FOUND");
  assert.equal(claim(secret).verdicts.length, 0, "nothing was recorded");
  // Alice's decision on the hidden one does not appear in Bob's view of anything.
  collab.confirmSharedConcept("alice", { conceptId: secret, verdict: "REFUTE", explanation: "wrong", expectedVersion: claim(secret).version });
  assert.ok(!JSON.stringify(collab.conceptsFor("bob", revision)).includes(secret));
  w.worker.close();
});

test("tenant boundary: another organisation cannot be shared with, cannot see a workspace exists, and has its own store where it does not", async () => {
  const w = await world();
  const { collab, ws } = w;
  const r = collab.share("alice", { workspaceId: ws, principalId: "dave", role: "viewer" });
  assert.ok(!r.ok && r.error.code === "FORBIDDEN" && /not in your organisation/.test(r.error.message));
  const peek = collab.read("dave", ws);
  assert.ok(!peek.ok && peek.error.code === "NOT_FOUND");
  assert.ok(!collab.handover("alice", { workspaceId: ws, principalId: "dave", expectedVersion: 0 }).ok);
  assert.ok(!ap(collab, "dave", ws, { kind: "SELECT", ids: [] }, 0).ok);
  // Even a mistaken grant row (a bug, a bad import) does not open it: the owner's organisation decides.
  w.svc.store.db.prepare("insert into collab_shares values (?,?,?,?,?,1)").run(ws, "dave", "editor", "alice", "x");
  const mistaken = collab.read("dave", ws);
  assert.ok(!mistaken.ok && mistaken.error.code === "NOT_FOUND");
  // Two organisations with their own stores: an id from one means nothing in the other.
  const host = new TenantHost(mkdtempSync(join(tmpdir(), "cie-collab-")));
  host.register("acme", { members: [], allowedRoots: [] }); host.register("other", { members: [], allowedRoots: [] });
  const sv = (t: string) => { const x = host.service({ ...ctx(), actor: { principalId: "u", tenantId: t, sessionId: "s" } }); assert.ok(x.ok); return x.value; };
  const a = sv("acme"), b = sv("other");
  const ca = new Collab(a.store, a.workspaceLog), cb = new Collab(b.store, b.workspaceLog);
  ca.addPrincipal("u", "acme"); cb.addPrincipal("u", "other");
  const mine = ca.create("u", { name: "mine", revision: null }) as any;
  assert.ok(mine.ok);
  const theirs = cb.read("u", mine.id);
  assert.ok(!theirs.ok && theirs.error.code === "NOT_FOUND");
  w.worker.close();
});

test("handover with a source-access mismatch: the recipient gets what they may read and a count of what they may not; no access at all, a stale version or a non-owner stops it", async () => {
  const w = await world();
  const { collab, ws, view, svc, revision } = w;
  assert.ok(ap(collab, "alice", ws, { kind: "SET_VIEW", view }, 0).ok);
  assert.ok(ap(collab, "alice", ws, { kind: "HYPOTHESIS", id: "h1", text: "adjustBalance races with commit", state: "OPEN" }, 1).ok);
  assert.ok(ap(collab, "alice", ws, { kind: "NOTE", entityId: "function:src/ledger/ledger.ts#adjustBalance", text: "not transactional" }, 2).ok);
  new Security(svc.store).analyze({ revision });
  // No source access: refused, and nothing changed.
  const none = collab.handover("alice", { workspaceId: ws, principalId: "carol", expectedVersion: 3 });
  assert.ok(!none.ok && none.error.code === "FORBIDDEN" && /no access to the source/.test(none.error.message));
  assert.equal(w.svc.store.db.prepare("select role from collab_shares where ws = ? and principal = 'alice'").get(ws)!.role, "owner");
  // Someone who is not the owner cannot hand it over.
  assert.ok(collab.share("alice", { workspaceId: ws, principalId: "bob", role: "editor" }).ok);
  assert.ok(!collab.handover("bob", { workspaceId: ws, principalId: "erin", expectedVersion: 3 }).ok);
  // The investigation moved on since Alice looked.
  const stale = collab.handover("alice", { workspaceId: ws, principalId: "bob", expectedVersion: 2 });
  assert.ok(!stale.ok && stale.error.code === "VERSION_CONFLICT" && stale.error.currentVersion === 3);
  // Bob can read most of the code but not the ledger.
  const ok = collab.handover("alice", { workspaceId: ws, principalId: "bob", expectedVersion: 3 }) as any;
  assert.ok(ok.ok);
  assert.ok(ok.recipient.gaps.items >= 2 && /do not have access/.test(ok.recipient.gaps.note));
  assert.deepEqual(ok.recipient.openHypotheses, ["h1: adjustBalance races with commit"], "what the investigation believes is handed over");
  const text = JSON.stringify(ok);
  assert.ok(!/not transactional/.test(text) && !/src\/ledger/.test(text), "the gap is counted, the protected content is not shown");
  assert.ok(ok.recipient.unresolvedFindings.every((f: string) => !/adjustBalance|ledger/i.test(f)), "findings about code he cannot read are not handed over");
  // Roles swapped; the old owner can still edit; the move is on the record.
  const roles = Object.fromEntries((svc.store.db.prepare("select principal, role from collab_shares where ws = ?").all(ws) as any[]).map((r) => [r.principal, r.role]));
  assert.deepEqual([roles.alice, roles.bob], ["editor", "owner"]);
  assert.ok(ap(collab, "alice", ws, { kind: "SELECT", ids: [] }, 3).ok);
  assert.ok(!collab.unshare("alice", { workspaceId: ws, principalId: "bob" }).ok, "only the owner removes access");
  const hist = collab.history(ws).find((h) => h.kind === "HANDOVER")!;
  assert.deepEqual([hist.actor, hist.detail.to, hist.detail.atVersion], ["alice", "bob", 3]);
  w.worker.close();
});
