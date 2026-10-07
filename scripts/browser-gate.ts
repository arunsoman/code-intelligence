// Live-browser gate for prompt-to-feature (#94C, decision D004).
//   node scripts/browser-gate.ts            seeds a throwaway database, starts the real server, runs the Playwright specs in tools/browser-gate
//                                           inside the PINNED image (never the host's browser) and writes docs/prompt-to-feature/browser/report.json
// What the report records: the image reference (digest), Playwright and Chromium versions, the three viewports, every spec result per viewport,
// axe findings per spec, and the sha256 of every trace archive. The traces themselves stay under .cie/browser-gate/<run>/ (not committed).
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seed } from "../tools/browser-gate/seed.ts";

const ROOT = resolve(import.meta.dirname, ".."), GATE = join(ROOT, "tools/browser-gate");
export const IMAGE = "mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27"; // v1.63.0-noble, linux/amd64 + arm64 index
const PORT = 4900 + Math.floor(Math.random() * 90);

const have = (() => { try { execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }); return true; } catch { return false; } })();
if (!have) { console.error(`the pinned image is not on this machine: docker pull ${IMAGE}`); process.exit(3); }

// the web build the server will serve
const dist = join(ROOT, "apps/web/dist/index.html"), newest = Math.max(...execFileSync("find", [join(ROOT, "apps/web/src"), "-type", "f"], { encoding: "utf8" }).trim().split("\n").map((f) => statSync(f).mtimeMs));
if (!existsSync(dist) || statSync(dist).mtimeMs < newest) execFileSync("npm", ["run", "web:build"], { cwd: ROOT, stdio: "ignore" });

const run = new Date().toISOString().replace(/[:.]/g, "-"), out = join(ROOT, ".cie/browser-gate", run); mkdirSync(out, { recursive: true });
const db = join(mkdtempSync(join(tmpdir(), "pf-bg-")), "gate.db"), s = await seed(db);
const server = spawn(process.execPath, [join(ROOT, "packages/core/src/server.ts")], { env: { ...process.env, PORT: String(PORT), CIE_DB: db, CIE_PROVIDER: "stub" }, stdio: "ignore" });
const url = `http://127.0.0.1:${PORT}`;
try {
  let up = false; for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${url}/healthz`)).ok; } catch { /* not up */ } if (!up) await new Promise((r) => setTimeout(r, 100)); }
  if (!up) throw new Error("server did not start");
  const uid = process.getuid!(), gid = process.getgid!();
  let exit = 0;
  try {
    execFileSync("docker", ["run", "--rm", "--init", "--ipc=host", "--network=host", "--user", `${uid}:${gid}`, "-e", "HOME=/tmp", "-e", `GATE_URL=${url}`, "-e", `GATE_REPO=${s.repo}`, "-e", `GATE_MINE=${s.mine}`, "-e", `GATE_THEIRS=${s.theirs}`, "-e", `GATE_CANDIDATE=${s.candidateHash}`, "-e", "GATE_OUT=/out",
      "-v", `${GATE}:/gate:ro`, "-v", `${out}:/out:rw`, "-w", "/gate", IMAGE, "npx", "playwright", "test"], { stdio: "inherit" });
  } catch (e) { exit = (e as { status?: number }).status ?? 1; }

  // ---- report
  const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
  const specs: { title: string; project: string; status: string; durationMs: number; browser?: string; axe?: unknown; error?: string }[] = [];
  const walk = (suite: any) => { for (const sp of suite.specs ?? []) for (const t of sp.tests ?? []) for (const r of t.results ?? []) specs.push({ title: sp.title, project: t.projectName, status: r.status, durationMs: r.duration, browser: r.annotations?.find((a: any) => a.type === "browser")?.description ?? t.annotations?.find((a: any) => a.type === "browser")?.description, axe: (() => { const all = (t.annotations ?? []).filter((x: any) => x.type === "axe").map((x: any) => JSON.parse(x.description)); return all.length ? all : undefined; })(), error: r.error?.message?.slice(0, 300) }); for (const c of suite.suites ?? []) walk(c); };
  for (const su of results.suites ?? []) walk(su);
  const traces: { file: string; sha256: string }[] = [];
  const find = (dir: string) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) find(p); else if (n.endsWith(".zip")) traces.push({ file: p.slice(out.length + 1), sha256: createHash("sha256").update(readFileSync(p)).digest("hex") }); } };
  find(out);
  const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
  const inspect = JSON.parse(execFileSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" }))[0];
  const report = {
    schema: "pf-browser-gate/1", ranAt: new Date().toISOString(), decision: "D004",
    image: { reference: IMAGE, id: inspect.Id, created: inspect.Created, playwrightPackage: "@playwright/test 1.63.0", axePackage: "@axe-core/playwright 4.13.0", lockfileSha256: sha(join(GATE, "package-lock.json")) },
    browser: [...new Set(specs.map((x) => x.browser).filter(Boolean))],
    viewports: ["1366x768", "1920x1080", "1280x720"], server: { url, database: "throwaway, seeded by tools/browser-gate/seed.ts", provider: "stub (the gate checks the web workflow, not generation)", principal: "local-user" },
    sandbox: "chromium runs with --no-sandbox inside an unprivileged container (--user, no extra capabilities); the container is the boundary",
    results: specs, passed: specs.filter((x) => x.status === "passed").length, failed: specs.filter((x) => x.status !== "passed").length, traces,
    notCovered: ["requests created through the UI from a prompt (needs a model run; covered by #94A, not here)", "validation evidence rendered live (the seeded request has none, so Validate and Deliver are checked in their review-only state)", "mobile viewports", "screen-reader behaviour: axe finds machine-detectable issues only"],
    verdict: exit === 0 && specs.length > 0 && specs.every((x) => x.status === "passed") ? "PASS" : "FAIL",
  };
  mkdirSync(join(ROOT, "docs/prompt-to-feature/browser"), { recursive: true }); writeFileSync(join(ROOT, "docs/prompt-to-feature/browser/report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`browser gate: ${report.verdict} (${report.passed} passed, ${report.failed} failed, ${specs.length} runs) -> docs/prompt-to-feature/browser/report.json; traces in ${out}`);
  process.exitCode = report.verdict === "PASS" ? 0 : 1;
} finally { server.kill(); }
