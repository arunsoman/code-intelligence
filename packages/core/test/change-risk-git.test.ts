import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ctx, demoRepo, setup } from "./helpers.ts";

test("the change-risk map reads git history for the whole repository at once, not by starting git once per file", async () => {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = mkdtempSync(join(tmpdir(), "gitshim-")), log = join(bin, "calls.log");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> "${log}"\nexec "${realGit}" "$@"\n`); chmodSync(join(bin, "git"), 0o755);
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const files = svc.store.entities(revision).filter((e) => e.kind === "file").length;
  const before = process.env.PATH; process.env.PATH = `${bin}:${before}`;
  try {
    const r = await svc.ask(ctx(), { question: "Where is it risky to change things?", revision, form: "ChangeRisk" } as any);
    assert.ok(r.ok);
  } finally { process.env.PATH = before; }
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
  assert.ok(files >= 8, `the fixture has ${files} source files`);
  assert.ok(calls <= 4, `${calls} git processes were started for ${files} files; the cost grows with the number of files (25 s on a 1,700-file repository, with the event loop blocked throughout)`);
  worker.close();
});
