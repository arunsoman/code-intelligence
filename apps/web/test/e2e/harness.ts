// Shared by the browser tests: a real server on a free port with a temporary database, and the built web app.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../../../..");
export const REPO = join(ROOT, "fixtures/sample-repo");
const PORT = 4700 + Math.floor(Math.random() * 200);

export async function startServer(): Promise<{ proc: ChildProcess; url: string }> {
  const dist = join(ROOT, "apps/web/dist/index.html");
  const newest = Math.max(...execFileSync("find", [join(ROOT, "apps/web/src"), "-type", "f"], { encoding: "utf8" }).trim().split("\n").map((f) => statSync(f).mtimeMs));
  if (!existsSync(dist) || statSync(dist).mtimeMs < newest) execFileSync("npm", ["run", "web:build"], { cwd: ROOT, stdio: "ignore" });
  const proc = spawn(process.execPath, [join(ROOT, "packages/core/src/server.ts")], { env: { ...process.env, PORT: String(PORT), CIE_DB: join(mkdtempSync(join(tmpdir(), "cie-e2e-")), "e2e.db"), NODE_OPTIONS: "", CIE_OLLAMA_URL: "http://127.0.0.1:9", CIE_ROUTER_SCRIPT: join(ROOT, "apps/web/test/e2e/router-script.json") }, stdio: "ignore" });
  const url = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/healthz`)).ok) return { proc, url }; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
  proc.kill(); throw new Error("server did not start");
}

export const POINTER_GUARD = `window.__pointer = 0; for (const t of ["mousedown","mouseup","pointerdown","pointerup","click","dblclick","wheel","contextmenu"]) addEventListener(t, (e) => { if (e.detail > 0 || t !== "click") window.__pointer++; }, true);`;

