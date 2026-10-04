import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { History } from "../src/history.ts";
import { ctx, demoRepo, setup } from "./helpers.ts";

const edit = (dir: string, rel: string, f: (s: string) => string) => writeFileSync(join(dir, rel), f(readFileSync(join(dir, rel), "utf8")));
const reindex = async (svc: any, dir: string) => { const r = await svc.ingestRepository(ctx(), { repoPath: dir }); assert.ok(r.ok); return r.value.id as string; };
const commit = (dir: string, msg: string) => execFileSync("git", ["-C", dir, "-c", "user.name=Sam", "-c", "user.email=s@x", "commit", "-qam", msg], { env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-05T09:00:00Z", GIT_COMMITTER_DATE: "2026-10-05T09:00:00Z" } });

test("comparing two revisions whose identities were registered separately reports the change, not a whole-repo replacement", { timeout: 120_000 }, async () => {
  const dir = demoRepo();
  const { svc, worker, revision: r0 } = await setup(undefined, dir);
  // One small commit: rename the local helper velocity -> riskScore, and make commit refuse to settle more than is held.
  edit(dir, "src/payments/fraud.ts", (s) => s.replaceAll("velocity", "riskScore"));
  edit(dir, "src/ledger/ledger.ts", (s) => s.replace("    account.balance -= amount;", "    if (account.balance < amount) throw new InsufficientFundsError(id);\n    account.balance -= amount;"));
  commit(dir, "Rename velocity to riskScore; commit refuses to settle more than is held");
  const r1 = await reindex(svc, dir);
  const total = svc.store.entities(r1).filter((e: any) => ["function", "method", "class"].includes(e.kind)).length;

  // Register the two revisions independently, as happens when the older revision predates a repo re-created on disk:
  // the canonical ids of the two sides are then unrelated, and pairing must still fall back to the exact entity id.
  svc.registry.registerRevision(r0, null);
  svc.registry.registerRevision(r1, null);
  const cs = new History(svc.store, svc.registry).compare(r0, r1);

  assert.ok(cs.textDiff.symbolsTouched <= 5, `expected the small change, got ${cs.textDiff.symbolsTouched} symbols touched (repo has ${total})`);
  assert.ok(cs.textDiff.filesChanged <= 2, `expected 1-2 files changed, got ${cs.textDiff.filesChanged}`);
  const unchanged = cs.entities.filter((e) => e.change === "UNCHANGED");
  assert.ok(unchanged.length >= total - 5, `unchanged symbols must still pair, got ${unchanged.length} of ${total}`);
  assert.equal(cs.entities.filter((e) => e.change === "ADDED").length + cs.entities.filter((e) => e.change === "REMOVED").length <= 2, true, "a rename is at most one added and one removed here");
  assert.ok(cs.blastRadius.length > 0, "the changed symbols still have a blast radius");
  assert.ok(cs.blastRadius.some((b) => /fraud|checkFraud|riskScore|commit/.test(b.entityId)), JSON.stringify(cs.blastRadius));
  worker.close();
});
