// C27 local adapters: real tools run on sources an operator has reviewed (trusted roots). They are the counterpart of the
// container adapters in defect-isolation.ts, for fixtures and for repositories the operator vouches for. Untrusted
// repositories are refused here and must go through a container boundary. Every result says what it is: a detector
// report, a bounded model-check, or a probabilistic stress observation; none of them says "safe".
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { AdapterCapability, RunStatus } from "@cie/schema";
import { hashCheckout } from "./defect-isolation.ts";

export interface SourceHarness { schemaId: "defect.source-harness.v1"; adapterId: string; checkoutRoot: string; checkoutHash: string; path: string; args: string[] }
export interface LocalBudget { wallMs: number; memoryBytes: number; outputBytes: number; processes: number }
export interface LocalRun {
  status: RunStatus; exitCode: number | null; stdout: string; stderr: string; sourceHash: string; buildHash: string;
  /** What the tool reported, extracted: races, panics, violation counts. Never an interpretation. */
  observations: Record<string, unknown>; evidenceLevel: "DETECTOR_REPORT" | "REPRODUCED" | "BOUNDED_EXHAUSTIVE" | "NONE";
  exclusions: string[]; seed: string | null; replay: string[];
}
export interface LocalAdapter {
  id: string; version: string; classes: AdapterCapability["classes"]; languageIds: string[]; platformIds: string[]; knownExclusions: string[];
  maximumBounds: Record<string, number>; supportsReplay: boolean; modelsWeakMemory: boolean;
  probe(): { available: boolean; reason?: string; toolVersion?: string };
  run(h: SourceHarness, budget: LocalBudget, signal?: AbortSignal): Promise<LocalRun>;
}

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const which = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).stdout.trim() || null;
const version = (cmd: string, args: string[]) => (spawnSync(cmd, args, { encoding: "utf8" }).stdout || spawnSync(cmd, args, { encoding: "utf8" }).stderr || "").split("\n")[0].trim();
const cleanEnv = (extra: Record<string, string> = {}) => ({ PATH: "/usr/bin:/bin:/usr/local/bin", HOME: tmpdir(), LANG: "C", ...extra });

/** Run a process with a wall-clock budget, a byte budget on output, and an address-space limit where the system offers one. */
function execute(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; budget: LocalBudget; signal?: AbortSignal }): Promise<{ code: number | null; stdout: string; stderr: string; stopped: RunStatus | null; truncated: boolean; limited: boolean }> {
  // Wall-clock and output are enforced here, and a V8 heap limit for Node. Address-space and process-count limits are not applied:
  // ThreadSanitizer and the Rust toolchain reserve very large virtual regions, and RLIMIT_NPROC counts every process of the user.
  const limited = false;
  const [bin, argv] = [cmd, args];
  return new Promise((resolveRun) => {
    const child = spawn(bin, argv, { cwd: opts.cwd, env: opts.env ?? cleanEnv(), stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "", stderr = "", bytes = 0, truncated = false, stopped: RunStatus | null = null;
    const stop = (s: RunStatus) => { stopped ??= s; child.kill("SIGKILL"); };
    const cap = (d: Buffer, which: "o" | "e") => { const room = Math.max(0, opts.budget.outputBytes - bytes); const t = d.subarray(0, room).toString("utf8"); bytes += d.length; if (which === "o") stdout += t; else stderr += t; if (bytes > opts.budget.outputBytes) { truncated = true; stop("BUDGET_STOPPED"); } };
    child.stdout.on("data", (d: Buffer) => cap(d, "o")); child.stderr.on("data", (d: Buffer) => cap(d, "e"));
    const timer = setTimeout(() => stop("BUDGET_STOPPED"), opts.budget.wallMs);
    const onAbort = () => stop("CANCELLED"); opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) stop("CANCELLED");
    child.on("error", () => { stopped ??= "INFRA_FAILED"; });
    child.on("close", (code) => { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); resolveRun({ code, stdout, stderr, stopped, truncated, limited }); });
  });
}

/** The harness file, resolved inside the checkout, with the checkout verified against the hash the operator reviewed. */
function resolveHarness(h: SourceHarness, trusted: boolean): { root: string; file: string; sourceHash: string } {
  if (!trusted) throw new Error("This checkout is not a reviewed, trusted source; run it through a container boundary instead");
  if (!isAbsolute(h.checkoutRoot)) throw new Error("The checkout must be an absolute path");
  const root = realpathSync(h.checkoutRoot);
  const sourceHash = hashCheckout(root, 256 * 1024 * 1024);
  if (sourceHash !== h.checkoutHash) throw new Error("The checkout changed since it was reviewed");
  const file = resolve(root, h.path);
  const rel = relative(root, file);
  if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(file)) throw new Error("The harness path is not inside the checkout");
  return { root, file, sourceHash };
}

// ---------------------------------------------------------------------------------------------------- ThreadSanitizer
export interface TsanReport { kind: string; size: number; thread: string; function: string | null; file: string | null; line: number | null }
export function parseTsan(stderr: string, scrub: (p: string) => string): { reports: { accesses: TsanReport[]; location: string | null }[]; summary: string | null } {
  const reports: { accesses: TsanReport[]; location: string | null }[] = [];
  for (const block of stderr.split(/={10,}\n/).filter((b) => /WARNING: ThreadSanitizer: data race/.test(b))) {
    const accesses: TsanReport[] = [];
    for (const m of block.matchAll(/^\s*((?:Previous )?(?:[Ww]rite|[Rr]ead|[Aa]tomic (?:write|read)))\s+of size (\d+) at 0x[0-9a-f]+ by (?:main )?thread (T\d+|main)?[^:]*:\s*\n\s*#0\s+(.+?)\s+(\S+\.(?:cc|cpp|cxx|c|h|hpp|rs)):(\d+)/gm)) {
      accesses.push({ kind: m[1].toLowerCase(), size: Number(m[2]), thread: m[3] ?? "main", function: m[4], file: scrub(m[5]), line: Number(m[6]) });
    }
    const loc = /Location is ([^\n]+)/.exec(block)?.[1] ?? null;
    reports.push({ accesses, location: loc ? scrub(loc) : null });
  }
  const summary = /SUMMARY: ThreadSanitizer: ([^\n]+)/.exec(stderr)?.[1] ?? null;
  return { reports, summary: summary ? scrub(summary) : null };
}
export const tsanAdapter: LocalAdapter = {
  id: "native.thread-sanitizer.local", version: "clang", classes: ["RACE_INSTRUMENTATION"], languageIds: ["c", "c++"], platformIds: [`${process.platform}-${process.arch}`],
  knownExclusions: ["Only the paths a run executes are covered: no report is not a proof of no race.", "Detects data races on memory; a logical race over atomic operations is invisible to it.", "Instrumented timing is not production timing."],
  maximumBounds: {}, supportsReplay: false, modelsWeakMemory: false,
  probe() {
    const clang = which("clang++");
    if (!clang) return { available: false, reason: "clang++ is not installed" };
    const dir = mkdtempSync(join(tmpdir(), "cie-tsan-probe-"));
    try {
      const src = join(dir, "p.cc"); writeFileSync(src, "int main(){return 0;}");
      const r = spawnSync(clang, ["-fsanitize=thread", src, "-o", join(dir, "p")], { encoding: "utf8" });
      return r.status === 0 ? { available: true, toolVersion: version(clang, ["--version"]) } : { available: false, reason: "this clang cannot build with -fsanitize=thread on this platform" };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  async run(h, budget, signal) {
    const { root, file, sourceHash } = resolveHarness(h, true);
    if (!/\.(cc|cpp|cxx)$/.test(file)) throw new Error("The ThreadSanitizer adapter builds a C++ file");
    const work = mkdtempSync(join(tmpdir(), "cie-tsan-"));
    try {
      const src = join(work, basename(file)); copyFileSync(file, src);
      const bin = join(work, "reproduction");
      const build = await execute("clang++", ["-fsanitize=thread", "-g", "-O1", "-std=c++17", "-pthread", src, "-o", bin], { cwd: work, budget: { ...budget, wallMs: Math.max(budget.wallMs, 60_000) }, signal });
      if (build.code !== 0) return { status: build.stopped ?? "INFRA_FAILED", exitCode: build.code, stdout: build.stdout, stderr: build.stderr, sourceHash, buildHash: sha(h.path), observations: { buildFailed: true }, evidenceLevel: "NONE", exclusions: ["The instrumented build failed; no run happened."], seed: null, replay: [] };
      const buildHash = sha(readFileSync(bin));
      const run = await execute(bin, [], { cwd: work, env: cleanEnv({ TSAN_OPTIONS: "exitcode=66 halt_on_error=0 report_signal_unsafe=0" }), budget, signal });
      const scrub = (p: string) => p.split(work + "/").join("").split(root + "/").join("");
      const parsed = parseTsan(run.stderr, scrub);
      const raced = parsed.reports.length > 0;
      const status: RunStatus = run.stopped ?? (raced ? "PROPERTY_FAILED" : run.code === 0 ? "SUCCEEDED" : "INFRA_FAILED");
      return {
        status, exitCode: run.code, stdout: run.stdout, stderr: scrub(run.stderr), sourceHash, buildHash, observations: { reports: parsed.reports, summary: parsed.summary, raceReports: parsed.reports.length },
        evidenceLevel: raced ? "DETECTOR_REPORT" : "NONE",
        exclusions: [...tsanAdapter.knownExclusions, "No address-space or CPU limit is enforced by the local runner; wall-clock and output limits are.", ...(raced ? [] : ["No race was reported in this execution; that is not evidence the program is race-free."])], seed: null, replay: [],
      };
    } finally { rmSync(work, { recursive: true, force: true }); }
  },
};

// ------------------------------------------------------------------------------------------------------------- Loom
export const loomAdapter: LocalAdapter = {
  id: "rust.loom.local", version: "0.7.2", classes: ["SCHEDULE_SEARCH", "REPLAY"], languageIds: ["rust"], platformIds: [`${process.platform}-${process.arch}`],
  knownExclusions: ["A bounded model of Loom primitives written by a reviewer; not arbitrary whole-process testing.", "Completing the search means no violation within the model's thread and preemption bounds, not in general.", "Weak-memory behaviour is limited to what Loom models."],
  maximumBounds: { maxThreads: 4, preemptionBound: 3 }, supportsReplay: true, modelsWeakMemory: true,
  probe() { const c = which("cargo"); return c ? { available: true, toolVersion: version(c, ["--version"]) } : { available: false, reason: "cargo is not installed" }; },
  async run(h, budget, signal) {
    const { root, file, sourceHash } = resolveHarness(h, true);
    if (basename(file) !== "Cargo.toml") throw new Error("The Loom adapter runs a reviewed crate; the harness path must be its Cargo.toml");
    const testName = h.args[0]; if (!testName || !/^[A-Za-z_][A-Za-z0-9_:]*$/.test(testName)) throw new Error("Name one test to run");
    const target = join(process.env.CIE_DEFECT_TARGET ?? join(tmpdir(), "cie-defect-target"), "loom");
    const args = ["test", "--offline", "--manifest-path", file, "--", testName, "--exact", "--nocapture"];
    const run = await execute("cargo", args, { cwd: root, env: cleanEnv({ CARGO_TARGET_DIR: target, CARGO_HOME: process.env.CARGO_HOME ?? join(process.env.HOME ?? tmpdir(), ".cargo"), RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.HOME ?? tmpdir(), ".rustup") }), budget: { ...budget, wallMs: Math.max(budget.wallMs, 120_000), memoryBytes: 1 << 60 }, signal });
    const out = run.stdout + run.stderr;
    const ok = /test result: ok\. 1 passed/.test(out), failed = /test result: FAILED\. 0 passed; 1 failed/.test(out) || /panicked at/.test(out);
    const compileFailed = /error(\[E\d+\])?:/.test(out) && !/test result/.test(out);
    const status: RunStatus = run.stopped ?? (ok ? "SUCCEEDED" : failed && !compileFailed ? "PROPERTY_FAILED" : "INFRA_FAILED");
    const message = /panicked at [^\n]*\n([^\n]*)/.exec(out)?.[1]?.trim() ?? null;
    return {
      status, exitCode: run.code, stdout: run.stdout, stderr: run.stderr, sourceHash, buildHash: sha(readFileSync(file) + sha(testName)),
      observations: { test: testName, violation: failed ? message : null, completedSearch: ok },
      evidenceLevel: failed && !compileFailed ? "REPRODUCED" : ok ? "BOUNDED_EXHAUSTIVE" : "NONE",
      exclusions: [...loomAdapter.knownExclusions, ...(ok ? ["The search completed inside the model's bounds."] : [])], seed: null,
      replay: [`cargo test --offline --manifest-path ${relative(root, file)} -- ${testName} --exact --nocapture`],
    };
  },
};

// ------------------------------------------------------------------------------------------------- Node stress, sandboxed
export const stressAdapter: LocalAdapter = {
  id: "node.async-stress.local", version: process.version, classes: ["STRESS"], languageIds: ["typescript", "javascript"], platformIds: [`${process.platform}-${process.arch}`],
  knownExclusions: ["Probabilistic: it tries schedules at random. Finding a violation reproduces it; finding none says nothing about the schedules not tried.", "Timer delays stand in for I/O latency; real database isolation and network ordering are not modelled."],
  maximumBounds: { runs: 100_000 }, supportsReplay: true, modelsWeakMemory: false,
  probe() { return { available: true, toolVersion: process.version }; },
  async run(h, budget, signal) {
    const { root, file, sourceHash } = resolveHarness(h, true);
    const [fn, runsArg, seedArg] = h.args; const runs = Number(runsArg), seed = Number(seedArg);
    if (!/^[A-Za-z_]\w*$/.test(fn ?? "") || !Number.isSafeInteger(runs) || runs < 1 || runs > stressAdapter.maximumBounds.runs || !Number.isSafeInteger(seed)) throw new Error("Stress arguments are a function name, a run count within bounds, and an integer seed");
    const harness = join(root, "stress/harness.mjs");
    if (!existsSync(harness)) throw new Error("The checkout has no stress harness");
    // The process may read the checkout and nothing else: no writing, no child processes, no network, no workers.
    const args = ["--permission", `--allow-fs-read=${root}`, `--max-old-space-size=${Math.max(64, Math.floor(budget.memoryBytes / 1048576))}`, harness, file, fn, String(runs), String(seed)];
    const run = await execute(process.execPath, args, { cwd: root, env: cleanEnv(), budget: { ...budget, memoryBytes: 1 << 60 }, signal });
    let obs: { runs?: number; violations?: number; firstBad?: unknown } = {};
    try { obs = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}"); } catch { /* not a result */ }
    const reported = typeof obs.violations === "number";
    const status: RunStatus = run.stopped ?? (!reported ? "INFRA_FAILED" : obs.violations! > 0 ? "PROPERTY_FAILED" : "SUCCEEDED");
    return {
      status, exitCode: run.code, stdout: run.stdout, stderr: run.stderr.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n?/g, ""), sourceHash, buildHash: sha(readFileSync(file)),
      observations: { runs: obs.runs ?? 0, violations: obs.violations ?? null, firstBad: obs.firstBad ?? [] },
      evidenceLevel: reported && obs.violations! > 0 ? "REPRODUCED" : "NONE",
      exclusions: [...stressAdapter.knownExclusions, ...(reported && obs.violations === 0 ? [`${obs.runs} random runs found no violation; that does not show the function is safe.`] : [])], seed: String(seed),
      replay: [`node --permission --allow-fs-read=<checkout> stress/harness.mjs ${relative(root, file)} ${fn} ${runs} ${seed}`],
    };
  },
};

// ------------------------------------------------------------------------------------------------ registry and reasons
export const LOCAL_ADAPTERS: LocalAdapter[] = [tsanAdapter, loomAdapter, stressAdapter];

export function capabilityOf(a: LocalAdapter): AdapterCapability {
  return {
    id: a.id, version: a.version, languageIds: a.languageIds, platformIds: a.platformIds, classes: a.classes, schemas: ["defect.source-harness.v1", "defect.oracle.v1", "defect.bounds.v1"], supportsReplay: a.supportsReplay, modelsWeakMemory: a.modelsWeakMemory,
    maximumBounds: { schemaId: "defect.bounds.v1", schemaVersion: 1, value: a.maximumBounds }, knownExclusions: a.knownExclusions,
  };
}

/** Adapters the design names that this machine cannot run, each with its actual reason. Absent is reported, never silently skipped. */
export function unavailableAdapters(): { id: string; languageIds: string[]; reason: string }[] {
  const have = (b: string) => !!which(b);
  return [
    { id: "jvm.lincheck", languageIds: ["java", "kotlin"], reason: have("java") ? "a JVM is installed, but no Lincheck test harness or its libraries are configured" : "no JVM is installed" },
    { id: "jvm.jcstress", languageIds: ["java"], reason: have("java") ? "a JVM is installed, but jcstress is not configured" : "no JVM is installed" },
    { id: "dotnet.coyote", languageIds: ["csharp"], reason: have("dotnet") ? "dotnet is installed, but Coyote is not configured" : "the .NET SDK is not installed" },
    { id: "native.helgrind", languageIds: ["c", "c++"], reason: have("valgrind") ? "valgrind is installed but the adapter is not configured" : "valgrind is not installed" },
    { id: "system.antithesis", languageIds: ["any"], reason: "an external service: it needs an account, an environment and a data-sharing and cost decision" },
    { id: "machine.qemu-replay", languageIds: ["any"], reason: have("qemu-system-x86_64") ? "qemu is installed but record/replay is not configured" : "qemu is not installed" },
  ];
}

export function trustedCheckoutHash(root: string): string { return hashCheckout(realpathSync(root), 256 * 1024 * 1024); }
export { statSync };
