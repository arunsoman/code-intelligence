import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Security } from "../src/security.ts";
import { setup } from "./helpers.ts";

test("R-PII-LOG flags a password written through an alias of the logger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bug-")); mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/signup.ts"), `export function direct(user: { password: string }) {\n  console.log("created", user.password);\n}\nexport function aliased(user: { password: string }) {\n  const out = console;\n  out.log("created", user.password);\n}\n`);
  const { svc, worker, revision } = await setup(undefined, dir);
  const found = new Security(svc.store).analyze({ revision });
  const flagged = (fn: string) => found.some((f) => f.ruleId === "R-PII-LOG" && new RegExp(`\\b${fn}\\b`).test(f.summary));
  assert.ok(flagged("direct"), "the direct call is flagged (control)");
  assert.ok(flagged("aliased"), "the same write through `const out = console` is flagged too");
  worker.close();
});
