// Task 1.F — the Runner: the only way generated code ever executes (spec §39.3, PF-020/032/038/068).
//
// Isolation class is LOCAL_PERMISSION_MODEL: Node's permission model (fs read/write roots, no child processes, no network,
// no workers) plus a scrubbed environment, a command allowlist, a wall-clock kill of the whole process group, an output cap and,
// where the host has them, an RLIMIT_CPU (prlimit) and a network namespace (unshare). It is not a container or a VM. What is NOT
// enforced is returned with every result in `omissions`; the runner never falls back to an unrecorded boundary, and it refuses
// (status REFUSED) rather than silently drop a guarantee the request asked for (network DENY on a command it cannot isolate).
//
// Audit finding that shaped this file (checked on Node 26): the permission model FOLLOWS a symlink that lives inside an allowed
// root and points outside it, so a symlink is a read escape. The runner therefore scans its roots before the run and refuses if
// any link leaves them, and (when it granted write access) scans again afterwards and fails the run if one appeared.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { IsolationClass, RunRequest, RunResult, RunStatus, Runner } from "./types.ts";

const MAX_WALL_MS = 30 * 60_000, MAX_OUTPUT = 16 * 1024 * 1024, MAX_SCAN = 100_000;
const FORBIDDEN_ENV = /^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|LD_.*|DYLD_.*|BASH_ENV|ENV|PYTHON.*|RUBY.*|PERL.*|GIT_.*|SSH_.*|HOME|PATH|SHELL|IFS)$/;
const SECRETISH = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API[_-]?KEY|AUTH)/i;
/** Node flags a caller may put before the script. Anything that widens a permission or loads code is refused. */
const NODE_FLAG_OK = [/^--test$/, /^--test-isolation=(none|process)$/, /^--test-name-pattern=.{1,200}$/, /^--no-warnings$/, /^--enable-source-map$/, /^--experimental-strip-types$/, /^--experimental-transform-types$/, /^--stack-trace-limit=\d{1,3}$/];

export interface RunnerOptions {
  /** Called with a request's fencing token before the run and again after it; false means the lease was lost (AT-24, AT-57). */
  fence?: (token: number) => boolean;
  /** Test hook: pretend a host facility is missing. */
  hostHas?: { unshare?: boolean; prlimit?: boolean };
}

let probed: { unshare: boolean; prlimit: boolean } | null = null;
function probeHost(): { unshare: boolean; prlimit: boolean } {
  if (probed) return probed;
  const ok = (cmd: string, args: string[]) => { try { return spawnSync(cmd, args, { timeout: 3000, stdio: "ignore" }).status === 0; } catch { return false; } };
  probed = { unshare: ok("unshare", ["-rn", "true"]), prlimit: ok("prlimit", ["--cpu=5", "--", "true"]) };
  return probed;
}
/** Node 25+ denies network under --permission and has the --allow-net grant flag; older Nodes do not deny it at all. */
const nodeBlocksNetwork = (): boolean => process.allowedNodeEnvironmentFlags.has("--allow-net");

/** Every symlink under `roots` whose real target is not inside one of them. Bounded; hitting the bound is itself reported. */
export function escapingSymlinks(roots: readonly string[]): string[] {
  const real = roots.map((r) => { try { return realpathSync(r); } catch { return r; } });
  const inside = (p: string) => real.some((r) => p === r || p.startsWith(r + sep));
  const out: string[] = []; let seen = 0;
  const walk = (dir: string): void => {
    let names: string[]; try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (++seen > MAX_SCAN) { if (out[out.length - 1] !== "(scan limit reached)") out.push("(scan limit reached)"); return; }
      const abs = join(dir, n); let st; try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) {
        let target: string; try { target = realpathSync(abs); } catch { out.push(`${abs} -> ${readlinkSafe(abs)} (dangling)`); continue; }
        if (!inside(target)) out.push(`${abs} -> ${target}`);
      } else if (st.isDirectory() && n !== "node_modules") walk(abs);
    }
  };
  for (const r of real) walk(r);
  return out;
}
/** Is `cmd` an executable on the scrubbed PATH (or an absolute executable)? Used so a missing tool reads as infrastructure, not as a failed test. */
function onPath(cmd: string): boolean {
  const dirs = isAbsolute(cmd) ? [""] : ["/usr/bin", "/bin"];
  return dirs.some((d) => { try { const p = d ? join(d, cmd) : cmd; accessSync(p, constants.X_OK); return true; } catch { return false; } });
}
const readlinkSafe = (p: string): string => { try { return readlinkSync(p); } catch { return "?"; } };

export class LocalRunner implements Runner {
  readonly isolation: IsolationClass = "LOCAL_PERMISSION_MODEL";
  readonly omissions: readonly string[];
  private readonly opts: RunnerOptions;
  private readonly host: { unshare: boolean; prlimit: boolean };
  constructor(opts: RunnerOptions = {}) {
    this.opts = opts; const h = probeHost(); this.host = { unshare: opts.hostHas?.unshare ?? h.unshare, prlimit: opts.hostHas?.prlimit ?? h.prlimit };
    this.omissions = [
      "no container or VM boundary and no kernel isolation between the run and the host user",
      "no per-run memory or process-count limit: memory bounds the V8 heap of node commands only; process creation is denied (node) or limited per user (other commands), not per run",
      ...(this.host.prlimit ? [] : ["no CPU-time limit: prlimit is not available on this host (only the wall-clock limit applies)"]),
      "filesystem access outside the granted roots is blocked by Node's permission model and not by a mount namespace; symlinks are scanned before and after the run (node_modules is not scanned); node commands cannot create them under scoped permissions, other commands can",
    ];
  }

  async run(req: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    const t0 = Date.now(); const per: string[] = [];
    const done = (status: RunStatus, p: Partial<RunResult> = {}): RunResult => ({ status, exitCode: null, stdout: "", stderr: "", truncated: false, isolation: this.isolation, omissions: [...this.omissions, ...per], usage: { wallMs: Date.now() - t0 }, ...p });
    const refuse = (reason: string) => done("REFUSED", { reason, stderr: reason });

    const caps = req.capabilities, lim = caps.limits;
    if (!Array.isArray(req.argv) || !req.argv.length || req.argv.some((a) => typeof a !== "string" || a.includes("\0"))) return refuse("argv must be a non-empty list of strings without NUL bytes");
    if (!(lim.wallMs > 0) || lim.wallMs > MAX_WALL_MS) return refuse(`wallMs must be between 1 and ${MAX_WALL_MS}`);
    if (!(lim.outputBytes > 0) || lim.outputBytes > MAX_OUTPUT) return refuse(`outputBytes must be between 1 and ${MAX_OUTPUT}`);
    if (!caps.commands.some((c) => c.length > 0 && c.length <= req.argv.length && c.every((x, i) => x === req.argv[i]))) return refuse(`command not on the allowlist: ${req.argv.slice(0, 2).join(" ")}`);

    const roots = (xs: string[], what: string): string[] | string => {
      const out: string[] = [];
      for (const r of xs) {
        if (!isAbsolute(r)) return `${what} root must be absolute: ${r}`;
        let rp: string; try { rp = realpathSync(r); } catch { return `${what} root does not exist: ${r}`; }
        if (rp === "/" || rp.split(sep).filter(Boolean).length < 2) return `${what} root is too broad: ${rp}`;
        out.push(rp);
      }
      return out;
    };
    const rd = roots(caps.readRoots, "read"), wr = roots(caps.writeRoots, "write");
    if (typeof rd === "string") return refuse(rd);
    if (typeof wr === "string") return refuse(wr);
    let cwd: string; try { cwd = realpathSync(resolve(req.cwd)); } catch { return refuse(`cwd does not exist: ${req.cwd}`); }
    const all = [...rd, ...wr];
    if (!all.some((r) => cwd === r || cwd.startsWith(r + sep))) return refuse("cwd is outside every granted root");

    const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: wr[0] ?? cwd, LANG: "C" };
    for (const [k, v] of Object.entries(req.env ?? {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof v !== "string" || v.includes("\0")) return refuse(`bad environment entry ${k}`);
      if (FORBIDDEN_ENV.test(k)) return refuse(`environment variable ${k} may not be set`);
      if (SECRETISH.test(k) && !caps.secretRefs.includes(k)) return refuse(`environment variable ${k} looks like a secret and is not in the granted secret references`);
      env[k] = v;
    }

    const bad = escapingSymlinks(all);
    if (bad.length) return refuse(`symlink(s) leave the granted roots: ${bad.slice(0, 3).join("; ")}`);
    if (req.fencingToken !== undefined && this.opts.fence && !this.opts.fence(req.fencingToken)) return refuse("the lease for this work was lost before the run started");

    // ---- build the command line
    const isNode = req.argv[0] === "node" || req.argv[0] === process.execPath;
    let cmd = req.argv[0]!, args = req.argv.slice(1);
    const wrap: string[] = [];
    const netDeny = caps.network === "DENY";
    if (isNode) {
      cmd = process.execPath;
      let i = 0; for (; i < args.length && args[i]!.startsWith("-"); i++) if (!NODE_FLAG_OK.some((re) => re.test(args[i]!))) return refuse(`node flag not allowed: ${args[i]!.slice(0, 40)}`);
      const flags = ["--permission", ...rd.map((r) => `--allow-fs-read=${r}`), ...wr.map((r) => `--allow-fs-read=${r}`), ...wr.map((r) => `--allow-fs-write=${r}`)];
      if (lim.memoryBytes) flags.push(`--max-old-space-size=${Math.max(16, Math.floor(lim.memoryBytes / 1048576))}`);
      args = [...flags, ...args];
      if (caps.network !== "DENY") return refuse("a network allowlist cannot be enforced by this runner; use network DENY");
      if (!nodeBlocksNetwork()) { if (this.host.unshare) wrap.push("unshare", "-rn", "--"); else return refuse("this Node cannot deny network access and no network namespace is available"); }
    } else {
      if (!netDeny) return refuse("a network allowlist cannot be enforced by this runner; use network DENY");
      if (!this.host.unshare) return refuse(`network access cannot be denied for ${req.argv[0]} on this host (no network namespace); only node commands can run here`);
      if (!onPath(cmd)) return done("INFRA_ERROR", { reason: `could not start: ${cmd} was not found`, stderr: `${cmd}: not found` });
      wrap.push("unshare", "-rn", "--");
      per.push("filesystem roots are not enforced for non-node commands (no permission model); they run as the host user inside a network namespace");
    }
    if (lim.cpuMs && this.host.prlimit) wrap.push("prlimit", `--cpu=${Math.max(1, Math.ceil(lim.cpuMs / 1000))}`, "--");
    if (lim.processes && !isNode && this.host.prlimit) { wrap.push("prlimit", `--nproc=${lim.processes}`, "--"); per.push("process limit is the per-user count in the run's user namespace"); }
    const [file, ...pre] = wrap.length ? [wrap[0]!, ...wrap.slice(1), cmd] : [cmd];
    const argv = wrap.length ? [...pre, ...args] : args;

    // ---- run
    return await new Promise<RunResult>((res) => {
      let out = "", err = "", bytes = 0, truncated = false, status: RunStatus | null = null, settled = false;
      const child = spawn(file!, argv, { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const killGroup = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
      const stop = (s: RunStatus) => { if (!status) status = s; killGroup(); };
      const timer = setTimeout(() => stop("TIMEOUT"), lim.wallMs);
      const onAbort = () => stop("CANCELLED");
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
      const take = (which: "o" | "e") => (b: Buffer) => {
        const room = lim.outputBytes - bytes;
        if (room <= 0) { truncated = true; stop("RESOURCE_LIMIT"); return; }
        const piece = b.length > room ? b.subarray(0, room) : b;
        bytes += piece.length; if (b.length > room) { truncated = true; stop("RESOURCE_LIMIT"); }
        if (which === "o") out += piece.toString("utf8"); else err += piece.toString("utf8");
      };
      child.stdout.on("data", take("o")); child.stderr.on("data", take("e"));
      const finish = (code: number | null, sig: NodeJS.Signals | null, spawnErr?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); killGroup();
        const violations = wr.length ? escapingSymlinks(all) : [];
        let s: RunStatus = status ?? (spawnErr ? "INFRA_ERROR" : sig === "SIGXCPU" ? "RESOURCE_LIMIT" : code === 0 ? "PASSED" : "FAILED");
        let reason: string | undefined = spawnErr ? `could not start: ${spawnErr.message}` : s === "TIMEOUT" ? `exceeded ${lim.wallMs} ms` : s === "RESOURCE_LIMIT" ? (truncated ? `output exceeded ${lim.outputBytes} bytes` : "cpu limit reached") : undefined;
        if (violations.length) { if (s === "PASSED") s = "FAILED"; reason = `the run left a symlink that escapes the granted roots: ${violations[0]}`; }
        if (req.fencingToken !== undefined && this.opts.fence && !this.opts.fence(req.fencingToken) && s !== "CANCELLED") { s = "CANCELLED"; reason = "the lease was lost while the run was in progress; its result is discarded"; }
        res(done(s, { exitCode: code, stdout: out, stderr: err, truncated, reason, violations: violations.length ? violations : undefined }));
      };
      child.on("error", (e) => finish(null, null, e));
      child.on("close", (code, sig) => finish(code, sig));
    });
  }
}

/** Convenience: capabilities for running a checkout's node tests (read the checkout, write only a scratch dir, no network). */
export function nodeTestCapabilities(checkout: string, scratch: string, limits: Partial<RunRequest["capabilities"]["limits"]> = {}): RunRequest["capabilities"] {
  return { commands: [["node"]], readRoots: [checkout], writeRoots: [scratch], network: "DENY", secretRefs: [], limits: { wallMs: 120_000, outputBytes: 1_048_576, ...limits } };
}

// ------------------------------------------------------------------------------------------------ audit

export interface AuditCheck { name: string; enforced: boolean; detail: string }
export interface AuditReport { audited: boolean; isolation: IsolationClass; checks: AuditCheck[]; omissions: readonly string[] }

/**
 * Negative tests against a live runner: each probe tries something the boundary must stop. `audited` is true only when every
 * probe was stopped (and the sanity probe that proves the harness can write where it is allowed did succeed).
 */
export async function auditRunner(runner: Runner): Promise<AuditReport> {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } = await import("node:fs");
  const { createServer } = await import("node:net");
  const { tmpdir } = await import("node:os");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pf-audit-")));
  const root = join(base, "checkout"), scratch = join(base, "scratch"), outside = join(base, "outside");
  for (const d of [root, scratch, outside]) mkdirSync(d);
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
  const checks: AuditCheck[] = [];
  const caps = (extra: Partial<RunRequest["capabilities"]["limits"]> = {}) => ({ commands: [["node"]], readRoots: [root], writeRoots: [scratch], network: "DENY" as const, secretRefs: [], limits: { wallMs: 8000, outputBytes: 64 * 1024, ...extra } });
  const script = (name: string, body: string) => { writeFileSync(join(root, name), body); return name; };
  const run = (name: string, extra: Partial<RunRequest["capabilities"]["limits"]> = {}, env?: Record<string, string>) => runner.run({ capabilities: caps(extra), argv: ["node", join(root, name)], cwd: root, env });
  const record = (name: string, enforced: boolean, detail: string) => checks.push({ name, enforced, detail });
  const prev = process.env.CIE_AUDIT_SECRET; process.env.CIE_AUDIT_SECRET = "host-secret";
  const server = createServer((s) => { hit = true; s.destroy(); }); let hit = false;
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as import("node:net").AddressInfo).port;
    let r = await run(script("sanity.js", `require("fs").writeFileSync(${JSON.stringify(join(scratch, "ok.txt"))}, "x"); console.log("WROTE")`));
    record("harness can write inside the granted scratch root", r.status === "PASSED" && existsSync(join(scratch, "ok.txt")), r.status);
    r = await run(script("read.js", `try { console.log(require("fs").readFileSync(${JSON.stringify(join(outside, "secret.txt"))}, "utf8")) } catch (e) { console.log("DENIED " + e.code) }`));
    record("reading outside the granted roots is denied", /DENIED/.test(r.stdout) && !r.stdout.includes("TOP-SECRET"), r.stdout.trim().slice(0, 80));
    r = await run(script("write.js", `try { require("fs").writeFileSync(${JSON.stringify(join(outside, "w.txt"))}, "x"); console.log("WROTE") } catch (e) { console.log("DENIED " + e.code) }`));
    record("writing outside the granted roots is denied", /DENIED/.test(r.stdout) && !existsSync(join(outside, "w.txt")), r.stdout.trim().slice(0, 80));
    r = await run(script("env.js", `console.log("ENV=" + String(process.env.CIE_AUDIT_SECRET))`));
    record("host environment variables are not visible", r.stdout.includes("ENV=undefined"), r.stdout.trim().slice(0, 80));
    r = await run(script("net.js", `const s = require("net").connect(${port}, "127.0.0.1"); s.on("error", (e) => { console.log("DENIED " + e.code); process.exit(0) }); s.on("connect", () => { console.log("CONNECTED"); process.exit(0) }); setTimeout(() => process.exit(0), 3000)`));
    record("network connections are denied", /DENIED/.test(r.stdout) && !hit, r.stdout.trim().slice(0, 80));
    r = await run(script("child.js", `try { require("child_process").execSync("id"); console.log("SPAWNED") } catch (e) { console.log("DENIED " + e.code) }`));
    record("starting child processes is denied", /DENIED/.test(r.stdout), r.stdout.trim().slice(0, 80));
    r = await run(script("worker.js", `try { new (require("worker_threads").Worker)("1", { eval: true }); console.log("SPAWNED") } catch (e) { console.log("DENIED " + e.code) }`));
    record("starting worker threads is denied", /DENIED/.test(r.stdout), r.stdout.trim().slice(0, 80));
    r = await run(script("link.js", `try { require("fs").symlinkSync(${JSON.stringify(join(outside, "secret.txt"))}, ${JSON.stringify(join(scratch, "made"))}); console.log("MADE") } catch (e) { console.log("DENIED " + e.code) }`));
    record("a node run cannot create a symlink", /DENIED/.test(r.stdout) && !existsSync(join(scratch, "made")), r.stdout.trim().slice(0, 80));
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
    r = await run("sanity.js");
    record("a symlink that leaves the roots refuses the run", r.status === "REFUSED" && /symlink/.test(r.reason ?? ""), r.reason ?? r.status);
    rmSync(join(root, "escape.txt"));
    r = await run(script("loop.js", "setInterval(() => {}, 1000)"), { wallMs: 600 });
    record("a run that does not finish is killed at the wall limit", r.status === "TIMEOUT" && r.usage.wallMs < 5000, `${r.status} after ${r.usage.wallMs} ms`);
    r = await run(script("flood.js", `process.stdout.write("x".repeat(5_000_000))`), { outputBytes: 10_000 });
    record("runaway output is capped", r.status === "RESOURCE_LIMIT" && r.truncated && r.stdout.length <= 10_000, `${r.status}, ${r.stdout.length} bytes kept`);
    r = await run("sanity.js", {}, { NODE_OPTIONS: "--require /tmp/x.js" });
    record("environment injection (NODE_OPTIONS) is refused", r.status === "REFUSED", r.reason ?? r.status);
    r = await run("sanity.js", {}, { GITHUB_TOKEN: "t" });
    record("a secret-looking environment variable that was not granted is refused", r.status === "REFUSED", r.reason ?? r.status);
    r = await runner.run({ capabilities: caps(), argv: ["sh", "-c", "id"], cwd: root });
    record("a command outside the allowlist is refused", r.status === "REFUSED", r.reason ?? r.status);
    r = await runner.run({ capabilities: caps(), argv: ["node", "--require", "/tmp/x.js", join(root, "sanity.js")], cwd: root });
    record("a node flag that loads code is refused", r.status === "REFUSED", r.reason ?? r.status);
    r = await runner.run({ capabilities: caps(), argv: ["node", "--allow-fs-write=/", join(root, "sanity.js")], cwd: root });
    record("a node flag that widens a permission is refused", r.status === "REFUSED", r.reason ?? r.status);
  } finally {
    server.close(); if (prev === undefined) delete process.env.CIE_AUDIT_SECRET; else process.env.CIE_AUDIT_SECRET = prev;
    try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return { audited: checks.every((c) => c.enforced), isolation: runner.isolation, checks, omissions: runner.omissions };
}
