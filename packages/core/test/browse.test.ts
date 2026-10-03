import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ctx, setup } from "./helpers.ts";

test("browseDirectory lists visible subdirectories only, flags git repos, supports parent navigation", async () => {
  const { svc, worker } = await setup();
  const root = mkdtempSync(join(tmpdir(), "cie-browse-"));
  mkdirSync(join(root, "alpha/.git"), { recursive: true });
  mkdirSync(join(root, "beta"));
  mkdirSync(join(root, ".hidden"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "file.txt"), "secret");
  symlinkSync(join(root, "beta"), join(root, "link-to-beta"));
  const r = svc.browseDirectory(ctx(), { path: root });
  assert.ok(r.ok);
  assert.deepEqual(r.value.entries.map((e) => e.name), ["alpha", "beta", "link-to-beta"]);
  assert.equal(r.value.entries[0].isGitRepo, true);
  assert.equal(r.value.entries[1].isGitRepo, false);
  const up = svc.browseDirectory(ctx(), { path: r.value.entries[0].path });
  assert.ok(up.ok && up.value.parent === r.value.path);
  worker.close();
});

test("browseDirectory rejects relative, missing and file paths; defaults to home", async () => {
  const { svc, worker } = await setup();
  const rel = svc.browseDirectory(ctx(), { path: "relative" });
  assert.ok(!rel.ok && rel.error.code === "INVALID_SCHEMA");
  const missing = svc.browseDirectory(ctx(), { path: "/definitely/not/here" });
  assert.ok(!missing.ok && missing.error.code === "NOT_FOUND");
  const file = svc.browseDirectory(ctx(), { path: "/etc/hostname" });
  assert.ok(!file.ok);
  assert.ok(svc.browseDirectory(ctx(), {}).ok);
  const top = svc.browseDirectory(ctx(), { path: "/" });
  assert.ok(top.ok && top.value.parent === null);
  worker.close();
});
