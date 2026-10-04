import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyVerdict } from "../src/claims.ts";
import { Store } from "../src/store.ts";
import { CHECKPOINT_BOUND_MS, WorkspaceLog, reduce, type WorkspaceEvent } from "../src/workspaces.ts";
import { ctx, demoRepo, setup } from "./helpers.ts";

const CHILD = new URL("./fixtures/ws-child.ts", import.meta.url).pathname;
const dbIn = () => join(mkdtempSync(join(tmpdir(), "cie-ws-")), "ws.db");
const cleanEnv = { ...process.env, NODE_OPTIONS: "" };

test("kill/restart: after a kill -9 every committed event is there, and resume restores the view, pins, notes and hypotheses", () => {
  const db = dbIn();
  const child = spawnSync(process.execPath, [CHILD, "material", db], { env: cleanEnv, encoding: "utf8" });
  assert.match(child.stdout, /committed/);
  assert.equal(child.signal, "SIGKILL", "the process really was killed");
  const store = new Store(db);
  const r = new WorkspaceLog(store).resume("ws:crash");
  assert.ok(r.ok);
  const w = r.workspace;
  assert.equal(w.version, 4);
  assert.equal(w.state.view?.id, "v");
  assert.deepEqual(w.state.pins, ["e1"]);
  assert.equal(w.state.notes.e1, "suspicious");
  assert.deepEqual(w.state.hypotheses.h1, { text: "double apply", state: "OPEN" });
  store.db.close();
});

test("five-second checkpoint bound: ephemeral events lose at most the flush window to a kill -9, and committed ones are never lost", async () => {
  const db = dbIn();
  const child = spawn(process.execPath, [CHILD, "ephemeral", db], { env: cleanEnv, stdio: ["ignore", "pipe", "inherit"] });
  let last = { i: 0, t: 0 };
  child.stdout.on("data", (d) => { for (const l of String(d).split("\n").filter(Boolean)) { try { last = JSON.parse(l); } catch { /* partial */ } } });
  await new Promise((r) => setTimeout(r, 3300));
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  const killedAt = Date.now();
  const store = new Store(db);
  const rows = store.db.prepare("select seq, kind, at from ws_events where ws = 'ws:busy' order by seq").all() as any[];
  assert.equal(rows[0].kind, "NOTE", "the material event committed before the kill survived");
  const lastDurable = Date.parse(rows.at(-1).at);
  const lost = killedAt - lastDurable;
  assert.ok(rows.length > 5, `only ${rows.length} events survived`);
  assert.ok(lost < CHECKPOINT_BOUND_MS, `lost ${lost}ms of work, bound is ${CHECKPOINT_BOUND_MS}ms`);
  assert.ok(last.i > rows.length - 1, "some ephemeral events were still buffered, so the test saw the flush window");
  assert.deepEqual(new WorkspaceLog(store).resume("ws:busy").ok, true);
  store.db.close();
});

test("missing source: a workspace whose repository is gone still restores everything that is not evidence, and says so", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const r = await svc.ask(ctx(), { question: "how do fraud checks work", revision });
  assert.ok(r.ok);
  const log = svc.workspaceLog;
  const c = log.create("a", { name: "gone", revision });
  assert.ok(c.ok);
  log.append("a", { workspaceId: c.id, event: { kind: "SET_VIEW", view: r.value.view }, expectedVersion: 0 });
  log.append("a", { workspaceId: c.id, event: { kind: "NOTE", entityId: "x", text: "keep me" }, expectedVersion: 1 });
  rmSync(repo, { recursive: true, force: true });
  const back = log.resume(c.id);
  assert.ok(back.ok);
  assert.equal(back.workspace.sourceAvailable, false);
  assert.equal(back.workspace.state.notes.x, "keep me");
  assert.equal(back.workspace.state.view?.id, r.value.view.id);
  assert.ok(back.workspace.anchors.unavailable.length > 0);
  assert.match(back.workspace.warnings.join(" "), /not available here/);
  worker.close();
});

test("stale claims: a refuted claim and an edited source mark exactly what depended on them, and nothing is deleted", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const r = await svc.ask(ctx(), { question: "how do fraud checks and payments work", revision });
  assert.ok(r.ok);
  const claim = r.value.claims.find((c) => c.displayMode !== "HIDDEN")!;
  const log = svc.workspaceLog;
  const c = log.create("a", { name: "stale", revision }) as any;
  log.append("a", { workspaceId: c.id, event: { kind: "SET_VIEW", view: r.value.view }, expectedVersion: 0 });
  log.append("a", { workspaceId: c.id, event: { kind: "CLAIMS", ids: [claim.draft.id] }, expectedVersion: 1 });
  const fresh = log.resume(c.id) as any;
  assert.equal(fresh.workspace.claims[0].stale, false);
  assert.deepEqual(fresh.workspace.anchors.stale, []);
  applyVerdict(svc.store, { claimId: claim.draft.id, verdict: "REFUTE", explanation: "wrong", actorId: "bob", expectedVersion: claim.version });
  const after = log.resume(c.id) as any;
  assert.equal(after.workspace.claims[0].stale, true);
  assert.equal(after.workspace.claims[0].state, "REFUTED");
  // A changed source: annotate by evidence id; the workspace gets a STALE event, the others do not.
  const other = log.create("a", { name: "unrelated", revision }) as any;
  log.append("a", { workspaceId: other.id, event: { kind: "NOTE", entityId: "z", text: "n" }, expectedVersion: 0 });
  const evId = r.value.view.nodes.find((n) => n.evidenceIds.length)!.evidenceIds[0];
  const hit = log.annotateStaleness("system", { evidenceIds: [evId], reason: "file edited" });
  assert.deepEqual(hit.affected, [c.id]);
  const marked = log.resume(c.id) as any;
  assert.ok(marked.workspace.anchors.stale.includes(evId));
  assert.ok(marked.workspace.state.view, "the view is still there");
  worker.close();
});

test("undo/redo are attributed events: they step through material changes, a new change clears redo, and any past version replays", () => {
  const store = new Store(":memory:");
  const log = new WorkspaceLog(store);
  const { id } = log.create("a", { name: "u", revision: null }) as any;
  const ap = (event: WorkspaceEvent, v: number, actor = "a") => { const r = log.append(actor, { workspaceId: id, event, expectedVersion: v }); assert.ok(r.ok, JSON.stringify(r)); return (r as any).version as number; };
  let v = ap({ kind: "PIN", entityId: "p1", on: true }, 0);
  v = ap({ kind: "NOTE", entityId: "p1", text: "n1" }, v);
  v = ap({ kind: "SELECT", ids: ["p1"] }, v);
  v = ap({ kind: "UNDO" }, v, "bob");
  let s = (log.resume(id) as any).workspace.state;
  assert.equal(s.notes.p1, undefined, "undo removed the note, not the selection");
  assert.deepEqual(s.pins, ["p1"]);
  assert.deepEqual(s.selection, ["p1"], "selection is ambient and not on the undo stack");
  v = ap({ kind: "UNDO" }, v);
  assert.deepEqual((log.resume(id) as any).workspace.state.pins, []);
  v = ap({ kind: "REDO" }, v);
  assert.deepEqual((log.resume(id) as any).workspace.state.pins, ["p1"]);
  v = ap({ kind: "REDO" }, v);
  assert.equal((log.resume(id) as any).workspace.state.notes.p1, "n1");
  const nothing = log.append("a", { workspaceId: id, event: { kind: "REDO" }, expectedVersion: v });
  assert.ok(!nothing.ok && /nothing to redo/.test(nothing.error.message));
  v = ap({ kind: "UNDO" }, v);
  v = ap({ kind: "NOTE", entityId: "p2", text: "new" }, v); // a new change clears the redo stack
  const cant = log.append("a", { workspaceId: id, event: { kind: "REDO" }, expectedVersion: v });
  assert.ok(!cant.ok);
  // Replaying a past version gives that moment's state, whatever happened after.
  const at2 = (log.resume(id, 2) as any).workspace.state;
  assert.deepEqual(at2.pins, ["p1"]); assert.equal(at2.notes.p1, "n1");
  assert.equal(reduce("x", null, []).pins.length, 0);
  // The log records who undid.
  assert.equal((store.db.prepare("select actor from ws_events where ws = ? and kind = 'UNDO' order by seq").all(id) as any[])[0].actor, "bob");
  store.db.close();
});

test("concurrent workspace edits: a stale version is a conflict that says what changed; disjoint edits can rebase, same-target edits cannot", () => {
  const store = new Store(":memory:");
  const log = new WorkspaceLog(store);
  const { id } = log.create("a", { name: "c", revision: null }) as any;
  assert.ok(log.append("alice", { workspaceId: id, event: { kind: "PIN", entityId: "e1", on: true }, expectedVersion: 0 }).ok);
  // Bob also started from version 0.
  const bob = log.append("bob", { workspaceId: id, event: { kind: "NOTE", entityId: "e2", text: "mine" }, expectedVersion: 0 });
  assert.ok(!bob.ok && bob.error.code === "VERSION_CONFLICT" && bob.error.currentVersion === 1);
  assert.deepEqual((bob as any).since.map((x: any) => [x.kind, x.actor]), [["PIN", "alice"]]);
  // Disjoint target + rebase: applied after Alice's.
  const rebased = log.append("bob", { workspaceId: id, event: { kind: "NOTE", entityId: "e2", text: "mine" }, expectedVersion: 0, rebase: true });
  assert.ok(rebased.ok && rebased.rebased && rebased.version === 2);
  // Same target: refused even with rebase.
  const clash = log.append("carol", { workspaceId: id, event: { kind: "PIN", entityId: "e1", on: false }, expectedVersion: 0, rebase: true });
  assert.ok(!clash.ok && /same thing/.test(clash.error.message));
  // Undo never rebases silently over someone else's work.
  const undo = log.append("carol", { workspaceId: id, event: { kind: "UNDO" }, expectedVersion: 1, rebase: true });
  assert.ok(!undo.ok);
  const s = (log.resume(id) as any).workspace.state;
  assert.deepEqual(s.pins, ["e1"]); assert.equal(s.notes.e2, "mine");
  // Missing workspace and bad names.
  assert.ok(!log.append("a", { workspaceId: "ws:nope", event: { kind: "UNDO" }, expectedVersion: 0 }).ok);
  assert.ok(!log.create("a", { name: "  ", revision: null }).ok);
  store.db.close();
});

test("checkpoint and resurface: a checkpoint is a cache of the reduction, and resurfacing finds past work on the same code, newest and closest first, within access", () => {
  const store = new Store(":memory:");
  let allowedRev: string | null = "r-ok";
  const log = new WorkspaceLog(store, { allowed: (r) => r === null || r === allowedRev });
  const a = log.create("a", { name: "about e1", revision: "r-ok" }) as any;
  log.append("a", { workspaceId: a.id, event: { kind: "PIN", entityId: "e1", on: true }, expectedVersion: 0 });
  const b = log.create("a", { name: "about e1 and e2", revision: "r-ok" }) as any;
  log.append("a", { workspaceId: b.id, event: { kind: "PIN", entityId: "e1", on: true }, expectedVersion: 0 });
  log.append("a", { workspaceId: b.id, event: { kind: "PIN", entityId: "e2", on: true }, expectedVersion: 1 });
  const c = log.create("a", { name: "elsewhere", revision: "r-secret" }) as any;
  log.append("a", { workspaceId: c.id, event: { kind: "PIN", entityId: "e1", on: true }, expectedVersion: 0 });
  const cp = log.checkpoint(b.id) as any;
  assert.equal(cp.version, 2);
  assert.deepEqual(JSON.parse((store.db.prepare("select json from ws_checkpoints where ws = ?").get(b.id) as any).json).pins, ["e1", "e2"]);
  const found = log.resurface(["e1", "e2"]);
  assert.deepEqual(found.map((x) => x.name), ["about e1 and e2", "about e1"], "the closer overlap first; the other repository's workspace is not offered");
  assert.ok(!log.append("a", { workspaceId: c.id, event: { kind: "UNDO" }, expectedVersion: 1 }).ok, "and cannot be written to either");
  assert.deepEqual(log.resurface(["nothing"]), []);
  store.db.close();
});
