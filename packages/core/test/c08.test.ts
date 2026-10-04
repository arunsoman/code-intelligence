import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Registry } from "../src/registry.ts";
import { copyFixture, ctx, setup } from "./helpers.ts";

const edit = (dir: string, rel: string, f: (s: string) => string) => writeFileSync(join(dir, rel), f(readFileSync(join(dir, rel), "utf8")));
async function reindex(svc: any, dir: string) { const r = await svc.ingestRepository(ctx(), { repoPath: dir }); assert.ok(r.ok, JSON.stringify(r.error)); return r.value.id as string; }
const ent = (svc: any, rev: string, re: RegExp) => svc.store.entities(rev).filter((e: any) => re.test(e.entityId)).map((e: any) => e.entityId) as string[];

test("rename continuity: a renamed function keeps its canonical identity, callers and untouched code keep theirs, and the lineage lists every name", async () => {
  const dir = copyFixture();
  const { svc, worker, revision: r1 } = await setup(undefined, dir);
  const reg = new Registry(svc.store);
  reg.registerRevision(r1, null);
  edit(dir, "src/auth/token.ts", (s) => s.replaceAll("signToken", "issueToken"));
  edit(dir, "src/auth/service.ts", (s) => s.replaceAll("signToken", "issueToken"));
  const r2 = await reindex(svc, dir);
  const out = reg.registerRevision(r2, r1);
  const rename = out.proposals.find((p) => p.kind === "RENAME" && p.oldIds[0].endsWith("#signToken"))!;
  assert.ok(rename, JSON.stringify(out.proposals.map((p) => [p.kind, p.oldIds, p.newIds])));
  assert.equal(rename.state, "SUPPORTED");
  assert.equal(rename.strength, "BODY_IDENTICAL");
  const oldId = "function:src/auth/token.ts#signToken", newId = "function:src/auth/token.ts#issueToken";
  assert.equal(reg.canonOf(r2, newId), reg.canonOf(r1, oldId));
  assert.deepEqual(reg.lineage(reg.canonOf(r2, newId)!, r2).map((x) => x.entityId), [oldId, newId]);
  for (const stay of ["function:src/auth/token.ts#verifyToken", "function:src/db/users.ts#getUser"]) assert.equal(reg.canonOf(r2, stay), reg.canonOf(r1, stay), stay);
  assert.ok(reg.history(reg.canonOf(r2, newId)!).some((h) => h.event === "RENAMED"));
  worker.close();
});

test("duplicate names: the same name in two files is two identities, and identical-bodied candidates after a deletion are proposals, never merged", async () => {
  const dir = copyFixture();
  const body = "(x: number) { return x * 2 + 1; }";
  writeFileSync(join(dir, "src/helper.ts"), `export function scale${body}\n`);
  const { svc, worker, revision: r1 } = await setup(undefined, dir);
  const reg = new Registry(svc.store);
  reg.registerRevision(r1, null);
  // The helper is deleted and the same-bodied function appears in two new files, with the same name.
  writeFileSync(join(dir, "src/helper.ts"), "export const unrelated = 1;\n");
  writeFileSync(join(dir, "src/a.ts"), `export function scale${body}\n`);
  writeFileSync(join(dir, "src/b.ts"), `export function scale${body}\n`);
  const r2 = await reindex(svc, dir);
  const out = reg.registerRevision(r2, r1);
  const a = "function:src/a.ts#scale", b = "function:src/b.ts#scale";
  assert.notEqual(reg.canonOf(r2, a), reg.canonOf(r2, b), "same name, different identities");
  assert.notEqual(reg.canonOf(r2, a), reg.canonOf(r1, "function:src/helper.ts#scale"));
  const ambiguous = out.proposals.filter((p) => p.kind === "RENAME" && p.oldIds[0].endsWith("helper.ts#scale"));
  assert.equal(ambiguous.length, 2);
  assert.ok(ambiguous.every((p) => p.state === "PROPOSED" && /2 new candidates/.test(p.evidence[0])), "ambiguity is kept as proposals");
  assert.ok(reg.duplicateNames(r2).some((d) => d.name === "scale" && d.canon.length === 2));
  // Names alone never link: a function with the same name but a different body is not a rename.
  writeFileSync(join(dir, "src/c.ts"), "export function onlyName() { return 1; }\n");
  const r3 = await reindex(svc, dir);
  reg.registerRevision(r3, r2);
  assert.equal(reg.proposals({ revision: r3 }).length, 0);
  worker.close();
});

test("entity split and merge: a symbol divided in two, or two joined into one, is a proposal; confirming applies it and the history shows it", async () => {
  const dir = copyFixture();
  writeFileSync(join(dir, "src/steps.ts"), "export function a1() { return 1; }\nexport function a2() { return 2; }\nexport function a3() { return 3; }\nexport function a4() { return 4; }\n");
  writeFileSync(join(dir, "src/proc.ts"), 'import { a1, a2, a3, a4 } from "./steps";\nexport function processAll() { return a1() + a2() + a3() + a4(); }\nexport function main() { return processAll(); }\n');
  const { svc, worker, revision: r1 } = await setup(undefined, dir);
  const reg = new Registry(svc.store);
  reg.registerRevision(r1, null);
  const oldCanon = reg.canonOf(r1, "function:src/proc.ts#processAll")!;
  assert.ok(oldCanon);
  writeFileSync(join(dir, "src/proc.ts"), 'import { a1, a2, a3, a4 } from "./steps";\nexport function processFirst() { return a1() + a2(); }\nexport function processSecond() { return a3() + a4(); }\nexport function main() { return processFirst() + processSecond(); }\n');
  const r2 = await reindex(svc, dir);
  const split = reg.registerRevision(r2, r1).proposals.find((p) => p.kind === "SPLIT")!;
  assert.ok(split && split.state === "PROPOSED" && split.newIds.length === 2 && split.strength === "PARTITION");
  assert.deepEqual(split.newIds.map((i) => i.replace(/^.*#/, "")).sort(), ["processFirst", "processSecond"]);
  assert.equal(reg.entityIn(r2, oldCanon).length, 0, "nothing inherited the old identity before a person confirms");
  const ok = reg.applyIdentityVerdict("dana", { proposalId: split.id, verdict: "CONFIRM", expectedVersion: 1 });
  assert.ok(ok.ok && ok.proposal.state === "CONFIRMED");
  assert.ok(reg.history(oldCanon).some((h) => h.event === "SPLIT_INTO" && h.actor === "dana"));
  assert.notEqual(reg.canonOf(r2, split.newIds[0]), reg.canonOf(r2, split.newIds[1]));
  // And back: the two halves are joined into one function again.
  writeFileSync(join(dir, "src/proc.ts"), 'import { a1, a2, a3, a4 } from "./steps";\nexport function processEverything() { return a1() + a2() + a3() + a4(); }\nexport function main() { return processEverything(); }\n');
  const r3 = await reindex(svc, dir);
  const merge = reg.registerRevision(r3, r2).proposals.find((p) => p.kind === "MERGE")!;
  assert.ok(merge && merge.state === "PROPOSED" && merge.oldIds.length === 2 && merge.newIds[0].endsWith("#processEverything"));
  const c = reg.applyIdentityVerdict("dana", { proposalId: merge.id, verdict: "CONFIRM", expectedVersion: 1 });
  assert.ok(c.ok);
  assert.equal(reg.canonOf(r3, merge.newIds[0]), merge.canonBefore[0], "the merged symbol carries the first part's identity");
  assert.ok(reg.history(merge.canonBefore[1]).some((h) => h.event === "MERGED_INTO"));
  worker.close();
});

test("branch divergence: two lines of history keep their own identities; the same identity renamed differently on both is a conflict, not a silent pick", async () => {
  const base = copyFixture(), left = copyFixture(), right = copyFixture();
  const { svc, worker, revision: r0 } = await setup(undefined, base);
  const reg = new Registry(svc.store);
  reg.registerRevision(r0, null, "main");
  edit(left, "src/auth/token.ts", (s) => s.replaceAll("signToken", "issueToken")); edit(left, "src/auth/service.ts", (s) => s.replaceAll("signToken", "issueToken"));
  edit(right, "src/auth/token.ts", (s) => s.replaceAll("signToken", "mintToken")); edit(right, "src/auth/service.ts", (s) => s.replaceAll("signToken", "mintToken"));
  writeFileSync(join(right, "src/extra.ts"), "export function onlyOnRight() { return 7; }\n");
  const rl = await reindex(svc, left), rr = await reindex(svc, right);
  reg.registerRevision(rl, r0, "main");
  reg.registerRevision(rr, r0, "feature");
  const d = reg.diverge(rl, rr);
  assert.equal(d.base, r0);
  assert.equal(d.aBranch, "main"); assert.equal(d.bBranch, "feature");
  const canon = reg.canonOf(r0, "function:src/auth/token.ts#signToken")!;
  assert.deepEqual(d.conflicts.map((c) => [c.canonId, c.a.replace(/^.*#/, ""), c.b.replace(/^.*#/, "")]), [[canon, "issueToken", "mintToken"]]);
  const onlyRight = reg.canonOf(rr, "function:src/extra.ts#onlyOnRight")!;
  assert.ok(d.onlyB.includes(onlyRight) && !d.onlyA.includes(onlyRight));
  // Each branch's lineage is its own.
  assert.deepEqual(reg.lineage(canon, rl).map((x) => x.entityId.replace(/^.*#/, "")), ["signToken", "issueToken"]);
  assert.deepEqual(reg.lineage(canon, rr).map((x) => x.entityId.replace(/^.*#/, "")), ["signToken", "mintToken"]);
  assert.deepEqual(reg.ancestry(rl), [rl, r0]);
  worker.close();
});

test("dispute reversals: a person can dispute, confirm, and later reverse an identity decision; stale decisions are refused and nothing is forgotten", async () => {
  const dir = copyFixture();
  const { svc, worker, revision: r1 } = await setup(undefined, dir);
  const reg = new Registry(svc.store);
  reg.registerRevision(r1, null);
  edit(dir, "src/auth/token.ts", (s) => s.replaceAll("signToken", "issueToken")); edit(dir, "src/auth/service.ts", (s) => s.replaceAll("signToken", "issueToken"));
  const r2 = await reindex(svc, dir);
  const p = reg.registerRevision(r2, r1).proposals.find((x) => x.kind === "RENAME" && x.oldIds[0].endsWith("#signToken"))!;
  assert.equal(p.state, "SUPPORTED");
  const newId = p.newIds[0], canon = p.canonBefore[0];
  assert.equal(reg.canonOf(r2, newId), canon);
  // A stale version is refused.
  const stale = reg.applyIdentityVerdict("eve", { proposalId: p.id, verdict: "DISPUTE", expectedVersion: 7 });
  assert.ok(!stale.ok && stale.error.code === "VERSION_CONFLICT" && stale.error.currentVersion === 1);
  // Dispute first: flagged, identity unchanged until resolved.
  const d = reg.applyIdentityVerdict("eve", { proposalId: p.id, verdict: "DISPUTE", expectedVersion: 1 });
  assert.ok(d.ok && d.proposal.state === "DISPUTED" && d.proposal.version === 2);
  assert.equal(reg.canonOf(r2, newId), canon, "a dispute alone changes nothing");
  // The disputer is right: reverse. The new function gets an identity of its own.
  const rev = reg.applyIdentityVerdict("eve", { proposalId: p.id, verdict: "REFUTE", expectedVersion: 2 });
  assert.ok(rev.ok && rev.proposal.state === "REVERSED");
  assert.notEqual(reg.canonOf(r2, newId), canon);
  assert.deepEqual(reg.entityIn(r2, canon), [], "the old identity no longer names anything in the new revision");
  assert.deepEqual(reg.history(canon).map((h) => `${h.event}:${h.actor}`), ["RENAMED:system", "DISPUTED:eve", "REVERSED:eve"]);
  assert.ok(!reg.applyIdentityVerdict("eve", { proposalId: p.id, verdict: "REFUTE", expectedVersion: 3 }).ok, "a reversed proposal cannot be reversed again");
  // Changing their mind is a new decision, attributed.
  const again = reg.applyIdentityVerdict("dana", { proposalId: p.id, verdict: "CONFIRM", expectedVersion: 3 });
  assert.ok(again.ok);
  assert.equal(reg.canonOf(r2, newId), canon);
  assert.equal(reg.history(canon).at(-1)!.event + ":" + reg.history(canon).at(-1)!.actor, "CONFIRMED:dana");
  assert.ok(!reg.applyIdentityVerdict("x", { proposalId: "idp:none", verdict: "CONFIRM", expectedVersion: 1 }).ok);
  worker.close();
});

test("deleting a repository also removes its identities, lineage, workspaces, annotations and context events", async () => {
  const dir = copyFixture();
  const { svc, worker, revision: r1 } = await setup(undefined, dir);
  edit(dir, "src/auth/token.ts", (s) => s.replaceAll("signToken", "issueToken")); edit(dir, "src/auth/service.ts", (s) => s.replaceAll("signToken", "issueToken"));
  const r2 = await reindex(svc, dir);
  assert.ok(svc.registry.proposals().length > 0, "the service registered both revisions on ingest");
  const ask = await svc.ask(ctx(), { question: "how does login work", revision: r2 });
  assert.ok(ask.ok);
  const ws = svc.workspaceLog.create("a", { name: "mine", revision: r2 }) as any;
  svc.workspaceLog.append("a", { workspaceId: ws.id, event: { kind: "SET_VIEW", view: ask.value.view }, expectedVersion: 0 });
  const { Interactions } = await import("../src/interactions.ts");
  const ix = new Interactions(svc);
  const n = ask.value.view.nodes[0];
  await ix.resolve(ctx(), { id: "I-16", session: "s", view: ask.value.view, nodeId: n.id, note: "hello", scope: "team" });
  await ix.resolve(ctx(), { id: "I-10", session: "s", view: ask.value.view, nodeId: n.id, pin: true });
  svc.history.addThread("rita", { revision: r2, entityId: n.entityRefs[0], text: "t" });
  const root = svc.store.revision(r2)!.repoRoot;
  const count = (t: string) => (svc.store.db.prepare(`select count(*) as n from ${t}`).get() as any).n;
  for (const t of ["canon_nodes", "canon_lineage", "canon_proposals", "canon_history", "ws_meta", "ws_events", "annotations", "ctx_events", "claim_events", "review_threads", "review_thread_history"]) assert.ok(count(t) > 0, `${t} had rows to delete`);
  const del = svc.deleteRepository(ctx(), { repoRoot: root, confirm: root });
  assert.ok(del.ok && del.value.rowsAfter === 0);
  for (const t of ["canon_nodes", "canon_lineage", "canon_proposals", "canon_history", "ws_meta", "ws_events", "ws_checkpoints", "annotations", "ctx_events", "claim_events", "review_threads", "review_thread_history"]) assert.equal(count(t), 0, `${t} still has rows`);
  void r1;
  worker.close();
});
