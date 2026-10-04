import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { ExperimentBudget, RunStatus } from "@cie/schema";
import { ExperimentBudgetSchema } from "@cie/schema";

export interface ContainerProfile {
  id: string; image: string; platform: "linux/amd64" | "linux/arm64"; runtime: string;
  /** Host operator's assessed isolation tier; ordinary containers are not a hostile-native-code boundary. */
  isolation: "CONTAINER" | "VM_BACKED";
  permitsUntrustedNative: boolean;
  toolVersion: string; license: string; exclusions: string[];
}
export interface IsolatedCommand {
  sourceDirectory: string; sourceHash: string; argv: string[]; budget: ExperimentBudget;
  untrustedNative: boolean; signal?: AbortSignal;
}
export interface IsolatedResult { status: RunStatus; exitCode: number | null; stdout: string; stderr: string; sourceHash: string; truncated: boolean; omissions: string[] }

/** Hash only ordinary files in the isolated checkout, refusing symlinks and bounding reads. */
export function hashCheckout(root: string, maxBytes: number): string {
  const real = realpathSync(root);
  if (!isAbsolute(root) || real !== root || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Checkout must be an absolute canonical directory with a byte budget");
  const hash = createHash("sha256"); let bytes = 0, files = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name), stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Checkout contains a symlink or special file");
      if (stat.isDirectory()) walk(path);
      else {
        bytes += stat.size; if (++files > 100000 || bytes > maxBytes) throw new Error("Checkout read budget exceeded");
        const data = readFileSync(path); if (data.length !== stat.size) throw new Error("Checkout changed during hashing");
        hash.update(JSON.stringify([relative(root, path), stat.mode & 0o111, data.length])); hash.update(data);
      }
    }
  };
  walk(real); return hash.digest("hex");
}
export function containerArguments(profile: ContainerProfile, request: IsolatedCommand, name: string): string[] {
  ExperimentBudgetSchema.parse(request.budget);
  if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(profile.image)) throw new Error("Container images must be pinned by digest");
  if (!/^[a-zA-Z0-9_.-]+$/.test(profile.runtime) || !/^cie-experiment-[a-f0-9-]+$/.test(name)) throw new Error("Invalid runtime or container identity");
  if (request.untrustedNative && (profile.isolation !== "VM_BACKED" || !profile.permitsUntrustedNative)) throw new Error("This profile does not provide an assessed boundary for untrusted native code");
  if (!request.argv.length || request.argv.some((s) => typeof s !== "string" || s.includes("\0")) || !request.argv[0].startsWith("/")) throw new Error("The registered command must use an absolute container executable");
  if (!isAbsolute(request.sourceDirectory) || /[,\n\r]/.test(request.sourceDirectory)) throw new Error("Invalid checkout mount");
  const b = request.budget;
  return ["run", "--name", name, "--pull=never", "--platform", profile.platform, "--runtime", profile.runtime,
    "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit", String(b.processes),
    "--memory", String(b.memoryBytes), "--memory-swap", String(b.memoryBytes), "--cpus", String(Math.max(0.01, Math.min(1, b.cpuTimeMs / b.wallTimeMs))),
    "--ulimit", `cpu=${Math.max(1, Math.ceil(b.cpuTimeMs / 1000))}`, "--ulimit", `fsize=${b.outputBytes}`, "--ulimit", "core=0",
    "--user=65534:65534", "--no-healthcheck", "--log-driver=none", "--init", "--workdir=/source",
    "--mount", `type=bind,src=${request.sourceDirectory},dst=/source,readonly`,
    "--tmpfs", `/tmp:rw,nosuid,nodev,size=${Math.min(b.memoryBytes, b.outputBytes)},mode=1777`,
    "--tmpfs", `/work:rw,nosuid,nodev,size=${b.memoryBytes},mode=1777`,
    "--env=HOME=/tmp", "--env=CARGO_TARGET_DIR=/work/target", "--entrypoint", request.argv[0], profile.image, ...request.argv.slice(1)];
}

/** The only host executable invoked is the configured Docker CLI; repository commands run in the selected boundary. */
export class ContainerRunner {
  readonly executable: string;
  constructor(executable = "/usr/bin/docker") { this.executable = executable; }
  async run(profile: ContainerProfile, request: IsolatedCommand): Promise<IsolatedResult> {
    const name = `cie-experiment-${randomUUID()}`, args = containerArguments(profile, request, name);
    const sourceHash = hashCheckout(request.sourceDirectory, request.budget.readBytes);
    if (sourceHash !== request.sourceHash) throw new Error("Source hash changed before dispatch");
    if (request.signal?.aborted) return { status: "CANCELLED", exitCode: null, stdout: "", stderr: "", sourceHash, truncated: false, omissions: [] };
    return new Promise((resolve) => {
      const child = spawn(this.executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", DOCKER_HOST: "unix:///var/run/docker.sock" } });
      let stdout = "", stderr = "", bytes = 0, truncated = false, stopped: RunStatus | null = null, cleanupStarted = false;
      const cleanup = () => {
        if (cleanupStarted) return; cleanupStarted = true;
        // Scope is a generated container identity owned exclusively by this attempt.
        const rm = spawn(this.executable, ["rm", "--force", name], { shell: false, stdio: "ignore", env: { PATH: "/usr/bin:/bin", DOCKER_HOST: "unix:///var/run/docker.sock" } });
        rm.on("error", () => {}); rm.unref();
      };
      const stop = (status: RunStatus) => { stopped ??= status; cleanup(); child.kill("SIGKILL"); };
      const capture = (data: Buffer, stream: "stdout" | "stderr") => {
        const remaining = Math.max(0, request.budget.outputBytes - bytes);
        const text = data.subarray(0, remaining).toString("utf8"); bytes += data.length;
        if (stream === "stdout") stdout += text; else stderr += text;
        if (bytes > request.budget.outputBytes) { truncated = true; stop("BUDGET_STOPPED"); }
      };
      child.stdout.on("data", (b: Buffer) => capture(b, "stdout")); child.stderr.on("data", (b: Buffer) => capture(b, "stderr"));
      const cancel = () => stop("CANCELLED"); request.signal?.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(() => stop("BUDGET_STOPPED"), request.budget.wallTimeMs);
      child.on("error", () => { stopped = "INFRA_FAILED"; });
      child.on("close", (code) => {
        clearTimeout(timeout); request.signal?.removeEventListener("abort", cancel); cleanup();
        const omissions = [...profile.exclusions];
        if (truncated) omissions.push("Captured output was truncated at the declared output-byte limit.");
        let status: RunStatus = stopped ?? (code === 0 ? "SUCCEEDED" : "INFRA_FAILED");
        try { if (hashCheckout(request.sourceDirectory, request.budget.readBytes) !== sourceHash) { status = "INCONCLUSIVE"; omissions.push("Host checkout changed during execution."); } } catch { status = "INCONCLUSIVE"; omissions.push("Post-run source verification failed."); }
        resolve({ status, exitCode: code, stdout, stderr, sourceHash, truncated, omissions });
      });
    });
  }
}

export interface SourceAdapter {
  id: string; version: string; profile: ContainerProfile;
  classes: string[]; exclusions: string[];
  command: (harness: string) => string[];
  interpret: (result: IsolatedResult) => IsolatedResult;
}
const harnessPath = (path: string) => {
  if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith("/") || path.split("/").includes("..") || path.startsWith("-")) throw new Error("Harness path must be inside the isolated source checkout");
  return path;
};
export function loomAdapter(profile: ContainerProfile): SourceAdapter {
  return { id: "rust.loom", version: profile.toolVersion, profile, classes: ["SCHEDULE_SEARCH", "REPLAY"],
    exclusions: ["Requires a reviewed harness using Loom primitives; bounded Rust model, not arbitrary whole-process testing."],
    command: (manifest) => ["/usr/local/cargo/bin/cargo", "test", "--offline", "--locked", "--manifest-path", `/source/${harnessPath(manifest)}`, "--", "--nocapture"],
    interpret: (result) => {
      if (result.status === "INFRA_FAILED" && result.exitCode === 101 && /test result: FAILED/.test(result.stdout)) return { ...result, status: "PROPERTY_FAILED" };
      return result;
    },
  };
}
export function threadSanitizerAdapter(profile: ContainerProfile): SourceAdapter {
  return { id: "native.thread-sanitizer", version: profile.toolVersion, profile, classes: ["RACE_INSTRUMENTATION"],
    exclusions: ["Only executed instrumented paths are covered; reports are detector evidence and do not establish exhaustive safety."],
    // The pinned image owns this adapter entry point. It compiles with the pinned instrumented toolchain and captures the report.
    command: (harness) => ["/opt/cie/tsan-run", `/source/${harnessPath(harness)}`],
    interpret: (result) => /WARNING: ThreadSanitizer: data race/.test(result.stderr) && !result.truncated && result.status !== "CANCELLED" && result.status !== "BUDGET_STOPPED" ? { ...result, status: "PROPERTY_FAILED" } : result,
  };
}
