// A CONTAINER-class Runner (plan §11, 1.F): the same interface and refusals as LocalRunner, with the boundary supplied by Docker.
// What it enforces: no network (--network none), a read-only root filesystem, only the granted roots mounted (read roots read-only),
// a non-root user, no capabilities, no new privileges, and memory / cpu / pid limits. What it does NOT: it shares the host kernel (no VM),
// and the image tag is only as trustworthy as the registry. Both are returned with every result in `omissions`.
// Only the Docker CLI is executed on the host, as an argv list (no shell). The repository's commands run in the container.
import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { escapingSymlinks, NODE_FLAG_OK } from "./runner.ts";
import type { IsolationClass, RunRequest, RunResult, RunStatus, Runner } from "./types.ts";

const FORBIDDEN_ENV = /^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|LD_.*|DYLD_.*|BASH_ENV|ENV|PYTHON.*|RUBY.*|PERL.*|GIT_.*|SSH_.*|HOME|PATH|SHELL|IFS)$/;
const SECRETISH = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API[_-]?KEY|AUTH)/i;
const MAX_WALL_MS = 30 * 60_000, MAX_OUTPUT = 16 * 1024 * 1024;
export interface DockerRunnerOptions { image?: string; executable?: string; fence?: (token: number) => boolean; /** Defaults used when the request names no limit. */ defaults?: { memoryBytes?: number; cpus?: number; processes?: number } }

export function dockerAvailable(image = "node:24-alpine", executable = "/usr/bin/docker"): boolean {
  try { return spawnSync(executable, ["image", "inspect", image], { stdio: "ignore", timeout: 8000 }).status === 0; } catch { return false; }
}

export class DockerRunner implements Runner {
  readonly isolation: IsolationClass = "CONTAINER";
  readonly omissions: readonly string[];
  readonly image: string;
  private readonly exe: string; private readonly opts: DockerRunnerOptions;
  constructor(opts: DockerRunnerOptions = {}) {
    this.opts = opts; this.image = opts.image ?? "node:24-alpine"; this.exe = opts.executable ?? "/usr/bin/docker";
    this.omissions = [
      "the container shares the host kernel: there is no VM boundary",
      `the image ${this.image} is referenced by tag, not pinned by digest, unless a digest is configured`,
      "network is denied with --network none; there is no egress allowlist",
      "the CPU limit is a share (--cpus), not a CPU-time budget; the wall-clock limit is the hard stop",
    ];
  }

  async run(req: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    const t0 = Date.now();
    const done = (status: RunStatus, p: Partial<RunResult> = {}): RunResult => ({ status, exitCode: null, stdout: "", stderr: "", truncated: false, isolation: this.isolation, omissions: [...this.omissions], usage: { wallMs: Date.now() - t0 }, ...p });
    const refuse = (reason: string) => done("REFUSED", { reason, stderr: reason });
    const caps = req.capabilities, lim = caps.limits;
    if (!Array.isArray(req.argv) || !req.argv.length || req.argv.some((a) => typeof a !== "string" || a.includes("\0"))) return refuse("argv must be a non-empty list of strings without NUL bytes");
    if (!(lim.wallMs > 0) || lim.wallMs > MAX_WALL_MS) return refuse(`wallMs must be between 1 and ${MAX_WALL_MS}`);
    if (!(lim.outputBytes > 0) || lim.outputBytes > MAX_OUTPUT) return refuse(`outputBytes must be between 1 and ${MAX_OUTPUT}`);
    if (!caps.commands.some((c) => c.length > 0 && c.length <= req.argv.length && c.every((x, i) => x === req.argv[i]))) return refuse(`command not on the allowlist: ${req.argv.slice(0, 2).join(" ")}`);
    if (caps.network !== "DENY") return refuse("a network allowlist cannot be enforced by this runner; use network DENY");
    if (req.argv[0]!.startsWith("-") || req.argv[0]!.includes("/") && !isAbsolute(req.argv[0]!)) return refuse("the command must be a program name or an absolute path");
    // Same flag rule as the local runner: a flag that loads code or widens a permission is refused even though the container would contain it.
    if (req.argv[0] === "node") { for (let i = 1; i < req.argv.length && req.argv[i]!.startsWith("-"); i++) if (!NODE_FLAG_OK.some((re) => re.test(req.argv[i]!))) return refuse(`node flag not allowed: ${req.argv[i]!.slice(0, 40)}`); }
    const real = (xs: string[], what: string): string[] | string => {
      const out: string[] = [];
      for (const r of xs) { if (!isAbsolute(r)) return `${what} root must be absolute: ${r}`; let rp: string; try { rp = realpathSync(r); } catch { return `${what} root does not exist: ${r}`; } if (rp.split(sep).filter(Boolean).length < 2) return `${what} root is too broad: ${rp}`; if (/[:,\0]/.test(rp)) return `${what} root has a character a mount cannot carry: ${rp}`; out.push(rp); }
      return out;
    };
    const rd = real(caps.readRoots, "read"), wr = real(caps.writeRoots, "write");
    if (typeof rd === "string") return refuse(rd); if (typeof wr === "string") return refuse(wr);
    let cwd: string; try { cwd = realpathSync(resolve(req.cwd)); } catch { return refuse(`cwd does not exist: ${req.cwd}`); }
    const all = [...rd, ...wr];
    if (!all.some((r) => cwd === r || cwd.startsWith(r + sep))) return refuse("cwd is outside every granted root");
    const env: string[] = [];
    for (const [k, v] of Object.entries(req.env ?? {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof v !== "string" || v.includes("\0")) return refuse(`bad environment entry ${k}`);
      if (FORBIDDEN_ENV.test(k)) return refuse(`environment variable ${k} may not be set`);
      if (SECRETISH.test(k) && !caps.secretRefs.includes(k)) return refuse(`environment variable ${k} looks like a secret and is not in the granted secret references`);
      env.push("--env", `${k}=${v}`);
    }
    const bad = escapingSymlinks(all); if (bad.length) return refuse(`symlink(s) leave the granted roots: ${bad.slice(0, 3).join("; ")}`);
    if (req.fencingToken !== undefined && this.opts.fence && !this.opts.fence(req.fencingToken)) return refuse("the lease for this work was lost before the run started");

    const name = `cie-run-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const mem = Math.max(64 * 1048576, lim.memoryBytes ?? this.opts.defaults?.memoryBytes ?? 1024 * 1048576), cpus = this.opts.defaults?.cpus ?? 1, pids = lim.processes ?? this.opts.defaults?.processes ?? 256;
    const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
    // A write root is mounted read-write; a read root that is not also a write root is read-only. Identical paths inside and outside keep argv portable.
    const mounts = [...new Set(rd.filter((r) => !wr.includes(r)))].flatMap((r) => ["-v", `${r}:${r}:ro`]).concat(wr.flatMap((w) => ["-v", `${w}:${w}:rw`]));
    const args = ["run", "--rm", "--name", name, "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", `${uid}:${gid}`, "--memory", `${mem}`, "--memory-swap", `${mem}`, "--cpus", String(cpus), "--pids-limit", String(pids), "--env", "HOME=/tmp", "--env", "LANG=C", ...env, ...mounts,
      "-w", cwd, "--entrypoint", req.argv[0]!, this.image, ...req.argv.slice(1)];

    return await new Promise<RunResult>((res) => {
      let out = "", err = "", bytes = 0, truncated = false, status: RunStatus | null = null, settled = false;
      const child = spawn(this.exe, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", DOCKER_HOST: process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock" } });
      const rm = () => { const r = spawn(this.exe, ["rm", "--force", name], { shell: false, stdio: "ignore", env: { PATH: "/usr/bin:/bin", DOCKER_HOST: process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock" } }); r.on("error", () => {}); r.unref(); };
      const stop = (s: RunStatus) => { if (!status) status = s; rm(); try { child.kill("SIGKILL"); } catch { /* gone */ } };
      const timer = setTimeout(() => stop("TIMEOUT"), lim.wallMs);
      const onAbort = () => stop("CANCELLED"); if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
      const take = (which: "o" | "e") => (b: Buffer) => {
        const room = lim.outputBytes - bytes; if (room <= 0) { truncated = true; stop("RESOURCE_LIMIT"); return; }
        const piece = b.length > room ? b.subarray(0, room) : b; bytes += piece.length; if (b.length > room) { truncated = true; stop("RESOURCE_LIMIT"); }
        if (which === "o") out += piece.toString("utf8"); else err += piece.toString("utf8");
      };
      child.stdout.on("data", take("o")); child.stderr.on("data", take("e"));
      const finish = (code: number | null, spawnErr?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); rm();
        const violations = wr.length ? escapingSymlinks(all) : [];
        // 125 is Docker itself failing (no daemon, missing image); 126/127 is the command not starting; 137 is a kill (memory limit or the wall stop).
        let s: RunStatus = status ?? (spawnErr || code === 125 ? "INFRA_ERROR" : code === 137 ? "RESOURCE_LIMIT" : code === 0 ? "PASSED" : "FAILED");
        let reason: string | undefined = spawnErr ? `could not start docker: ${spawnErr.message}` : code === 125 ? `docker could not run the container: ${err.trim().slice(0, 160)}` : s === "TIMEOUT" ? `exceeded ${lim.wallMs} ms` : s === "RESOURCE_LIMIT" ? (truncated ? `output exceeded ${lim.outputBytes} bytes` : "killed: memory limit or process limit reached") : undefined;
        if (violations.length) { if (s === "PASSED") s = "FAILED"; reason = `the run left a symlink that escapes the granted roots: ${violations[0]}`; }
        if (req.fencingToken !== undefined && this.opts.fence && !this.opts.fence(req.fencingToken) && s !== "CANCELLED") { s = "CANCELLED"; reason = "the lease was lost while the run was in progress; its result is discarded"; }
        res(done(s, { exitCode: code, stdout: out, stderr: err, truncated, reason, violations: violations.length ? violations : undefined }));
      };
      child.on("error", (e) => finish(null, e)); child.on("close", (code) => finish(code));
    });
  }
}
