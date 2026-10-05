// The build check: every source file must load. (There is no compile step; Node strips the types.)
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = resolve("src");
let failed = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts")).sort()) {
  try { await import(pathToFileURL(join(dir, f)).href); console.log(`ok ${f}`); } catch (e) { failed++; console.error(`FAIL ${f}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
