import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ctx, setup } from "./helpers.ts";

const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=Sam", "-c", "user.email=s@x", ...a], { stdio: "pipe" });

test("new commits that leave the files' bytes as they were still update the history recorded for a re-indexed repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bug-")); mkdirSync(join(dir, "src"));
  const file = join(dir, "src/a.ts"), v1 = "export function a() { return 1; }\n";
  writeFileSync(file, v1); git(dir, "init", "-q"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "one");
  const { svc, worker, revision } = await setup(undefined, dir);
  const commits = (rev: string) => (svc.store.factsFor(rev, "file:src/a.ts").find((f) => f.predicate === "history")!.object as any).value.commits as number;
  assert.equal(commits(revision), 1);
  writeFileSync(file, "export function a() { return 2; }\n"); git(dir, "commit", "-qam", "two");
  writeFileSync(file, v1); git(dir, "commit", "-qam", "revert two");   // the bytes are the first commit's again
  const r = await svc.ingestRepository(ctx(), { repoPath: dir });
  assert.ok(r.ok);
  assert.equal(r.value.id, revision, "same bytes, so the same content-addressed revision (this is what makes the history stale)");
  assert.equal(commits(r.value.id), 3, "the file now has three commits in its history");
  worker.close();
});
