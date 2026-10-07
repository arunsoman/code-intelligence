// Phase 6 — Framework runtime sandbox.
//
// For frameworks where static analysis is insufficient (NestJS module graph at runtime,
// Next.js build-time routes, provider scopes, dynamic controllers), run a lightweight,
// isolated bootstrap inside the existing LOCAL_PERMISSION_MODEL runner and emit RUNTIME
// evidence into the store.
//
// Current scope: NestJS.
//   - Generates a throwaway probe script that imports the repository's compiled/built code,
//     locates the root module, and bootstraps `Test.createTestingModule({ imports: [AppModule] }).compile()`.
//   - Uses `@nestjs/core` `DiscoveryService` / `MetadataScanner` / `ModulesContainer` to list
//     controllers, providers (including scoped), guards, interceptors, and routes.
//   - Emits `RUNTIME` evidence rows via the store: facts with `resolution: "RUNTIME"` and
//     `evidence.class: "RUNTIME"` so the trust/policy forms can weight them.
//
// The runner is the existing `feature/runner.ts` (Task 1.F): Node permission model, no network,
// read/write roots, wall-clock + CPU limits.  The probe is generated and executed; it never
// reads user secrets or writes outside the scratch directory.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, lstatSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallContext, EvidenceRef, Fact, ApiResult, ApiError } from "@cie/schema";
import type { RevisionRow } from "./store.ts";
import { LocalRunner, nodeTestCapabilities } from "./feature/runner.ts";
import { Registry } from "./registry.ts";
import type { Store } from "./store.ts";

export interface RuntimeSandboxOptions {
  store: Store;
  registry: Registry;
  revision: RevisionRow;
  framework?: "nestjs" | "nextjs" | "express";
  /** Maximum wall-clock ms for the probe run. */
  wallMs?: number;
}

export interface RuntimeSandboxResult {
  facts: Fact[];
  evidence: EvidenceRef[];
  diagnostics: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function sha16Sync(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** Locate a file by basename anywhere under the repository root. */
function findFile(root: string, names: string[]): string | null {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", ".next", "coverage"]);
  let found: string | null = null;
  const walk = (dir: string) => {
    if (found) return;
    for (const n of readdirSync(dir)) {
      if (found) return;
      if (SKIP.has(n)) continue;
      const abs = join(dir, n);
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (names.includes(n)) { found = abs; return; }
    }
  };
  walk(root);
  return found;
}

/** Build a Node probe script that bootstraps a NestJS TestingModule and introspects metadata. */
function buildNestJsProbe(rootModulePath: string, outPath: string, logPath: string, appModuleExport: string = "AppModule"): string {
  const src = `
const { Test } = require("@nestjs/testing");
const { DiscoveryService, MetadataScanner, DiscoveryModule } = require("@nestjs/core");
const mod = require(${JSON.stringify(rootModulePath)});
const AppModule = mod[${JSON.stringify(appModuleExport)}] || mod.default || mod;
const fs = require("node:fs");

async function main() {
  const moduleClass = AppModule;
  const builder = Test.createTestingModule({ imports: [DiscoveryModule, moduleClass] });
  // Override common runtime-only tokens so static fixtures can boot without real config sources.
  builder.overrideProvider("CONFIG").useValue({});
  const app = await builder.compile();
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const modules = discovery.getModules();
  const controllers = discovery.getControllers();
  const providers = discovery.getProviders();
  const out = { modules: [], controllers: [], providers: [], guards: [], interceptors: [], routes: [] };
  for (const m of modules) {
    out.modules.push({ name: m.metatype?.name || "?", id: m.id });
  }
  for (const c of controllers) {
    const meta = c.metatype || c.instance?.constructor;
    const paths = Reflect.getMetadata("path", meta) || "";
    const prefix = typeof paths === "string" ? paths : Array.isArray(paths) ? paths[0] : "";
    const methods = scanner.scanFromPrototype(c.instance, Object.getPrototypeOf(c.instance), (name) => name);
    const routes = [];
    for (const name of methods) {
      const methodMeta = Reflect.getMetadata("method", c.instance[name]);
      const pathMeta = Reflect.getMetadata("path", c.instance[name]);
      if (methodMeta !== undefined && pathMeta !== undefined) {
        routes.push({ method: methodMeta, path: prefix + (pathMeta || "") });
      }
    }
    out.controllers.push({ name: meta?.name || "?", prefix, routes });
  }
  for (const p of providers) {
    const meta = p.metatype || p.instance?.constructor;
    const scope = Reflect.getMetadata("scope:options", meta)?.scope || "DEFAULT";
    const token = p.token?.toString() || meta?.name || "?";
    out.providers.push({ token, name: meta?.name || "?", scope });
  }
  function implementsInterface(proto, name) {
    if (!proto) return false;
    const chain = [proto, ...Object.values(proto)];
    return chain.some(x => x && x.name === name);
  }
  for (const p of providers) {
    const meta = p.metatype || p.instance?.constructor;
    if (!meta) continue;
    if (implementsInterface(meta.prototype, "CanActivate")) out.guards.push({ token: p.token?.toString() || meta.name, name: meta.name });
    if (implementsInterface(meta.prototype, "NestInterceptor")) out.interceptors.push({ token: p.token?.toString() || meta.name, name: meta.name });
  }
  fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(out));
  await app.close();
}
main().catch((e) => { process.stderr.write(String(e.stack || e)); process.exit(1); });
`;
  writeFileSync(outPath, src, "utf8");
  return outPath;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function evidenceFor(rel: string, script: string, className: string): EvidenceRef {
  return {
    id: `ev:runtime:${className}:${rel}:${sha16Sync(rel + script)}`,
    sourceId: rel,
    class: className as any,
    observedAt: new Date().toISOString(),
    accessScopeId: "local",
    state: "CURRENT",
    location: { kind: "RuntimeProbe", script },
  };
}

function okResult<T>(ctx: CallContext, value: T): ApiResult<T> {
  return { ok: true, value, metadata: { requestId: ctx.requestId, completeness: "COMPLETE", warnings: [] } };
}
function failResult<T>(ctx: CallContext, error: ApiError): ApiResult<T> {
  return { ok: false, error, metadata: { requestId: ctx.requestId, completeness: "UNKNOWN", warnings: [] } };
}

export async function runRuntimeSandbox(opts: RuntimeSandboxOptions): Promise<ApiResult<RuntimeSandboxResult>> {
  const { store, registry, revision, framework = detectFramework(revision), wallMs = 120_000 } = opts;
  const repoRoot = revision.repoRoot;
  const diagnostics: string[] = [];

  if (framework !== "nestjs") {
    return failResult({} as CallContext, { code: "NOT_IMPLEMENTED", message: `runtime sandbox only supports NestJS currently; detected ${framework || "unknown"}`, retryable: false });
  }

  // Find the compiled or source root module.  Prefer a built dist/main.js; fall back to src/main.ts.
  const distMain = existsSync(join(repoRoot, "dist")) ? findFile(join(repoRoot, "dist"), ["main.js", "main.cjs"]) : null;
  const srcMain = findFile(repoRoot, ["main.ts"]);
  const mainPath = distMain || srcMain;
  if (!mainPath) {
    return failResult({} as CallContext, { code: "NOT_FOUND", message: "could not find NestJS main entry point (dist/main.js or src/main.ts) in the repository", retryable: false });
  }
  diagnostics.push(`using NestJS entry ${normalizePath(mainPath)}`);

  // Determine the root module import path.  In dist/main.js it is usually require("./app.module").
  // We do a best-effort parse of the entry file for the module import.
  let rootModulePath: string | null = null;
  try {
    const mainSrc = readFileSync(mainPath, "utf8");
    const m = /require\s*\(\s*["'](\.\/[^"'\s]+)["']\s*\)/.exec(mainSrc);
    if (m) {
      const rel = m[1]!;
      const base = mainPath.replace(/\/[^/]+$/, "");
      rootModulePath = resolve(base, rel);
    }
  } catch (e) {
    diagnostics.push(`could not parse entry module import: ${(e as Error).message}`);
  }
  if (!rootModulePath) {
    // Fallback: look for app.module.js/ts in the same directory as main.
    const base = mainPath.replace(/\/[^/]+$/, "");
    const candidates = ["app.module.js", "app.module.cjs", "app.module.ts"].map((n) => join(base, n));
    rootModulePath = candidates.find((p) => existsSync(p)) || null;
  }
  if (!rootModulePath) {
    return failResult({} as CallContext, { code: "NOT_FOUND", message: "could not determine NestJS root module import path", retryable: false });
  }
  diagnostics.push(`root module path ${normalizePath(rootModulePath)}`);

  // Prepare scratch directory inside the repo root so the probe's module resolution walks up to
  // the repository's own node_modules (and avoids /tmp-based resolution that would miss it).
  const scratch = join(repoRoot, ".cie", `runtime-sandbox-${revision.id}-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });

  // The probe will run in the repo root so relative module resolution matches the project's own
  // node_modules, and use a scratch log file for any output.
  const probe = join(scratch, "probe.js");
  const logPath = join(scratch, "probe.json");
  const appModuleExport = rootModulePath.includes("app.module") ? "AppModule" : "default";
  buildNestJsProbe(rootModulePath, probe, logPath, appModuleExport);

  // Run the probe under the existing sandboxed runner.
  const runner = new LocalRunner();
  const caps = nodeTestCapabilities(repoRoot, scratch, { wallMs, outputBytes: 2 * 1024 * 1024, memoryBytes: 512 * 1024 * 1024 });

  const run = await runner.run({ argv: ["node", "--preserve-symlinks", "--preserve-symlinks-main", probe], cwd: repoRoot, capabilities: { ...caps, commands: [["node", "--preserve-symlinks", "--preserve-symlinks-main"]] }, env: { NODE_ENV: "test" } });

  const facts: Fact[] = [];
  const evidence: EvidenceRef[] = [];

  if (run.status !== "PASSED") {
    rmSync(scratch, { recursive: true, force: true });
    diagnostics.push(`probe run ${run.status}: ${run.reason || run.stderr.slice(0, 200)}`);
    return failResult({} as CallContext, { code: "RUNTIME_PROBE_FAILED", message: diagnostics.join("; "), retryable: false });
  }

  let parsed: any;
  const logContent = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  try {
    parsed = logContent ? JSON.parse(logContent) : JSON.parse(run.stdout);
  } catch (e) {
    rmSync(scratch, { recursive: true, force: true });
    return failResult({} as CallContext, { code: "RUNTIME_PROBE_OUTPUT_INVALID", message: `probe output is not valid JSON: ${(e as Error).message}\nstdout: ${run.stdout.slice(0, 500)}\nlog: ${logContent.slice(0, 500)}`, retryable: false });
  }

  const revId = revision.id;
  const baseId = (kind: string, name: string) => `runtime:${revId}:${kind}:${name}`;
  const now = new Date().toISOString();
  const addFact = (kind: string, subject: string, predicate: string, value: any, sourceRel: string, className: string) => {
    const ev = evidenceFor(sourceRel, probe, className);
    evidence.push(ev);
    facts.push({
      id: baseId(kind, `${subject}:${predicate}`),
      subject,
      predicate,
      object: { kind: "ScalarValue", value },
      evidence: [ev],
      resolution: "RUNTIME" as Fact["resolution"],
      observedAt: now,
    } as unknown as Fact);
  };

  const sourceRel = normalizePath(mainPath).replace(normalizePath(repoRoot) + "/", "");
  const fileSubject = `file:${sourceRel}`;

  for (const m of parsed.modules || []) {
    addFact("module", fileSubject, "runtime_module", { name: m.name, id: m.id }, sourceRel, "RUNTIME_MODULE");
  }
  for (const c of parsed.controllers || []) {
    const controllerSubject = `runtime_controller:${c.name}`;
    addFact("controller", controllerSubject, "framework_role", { framework: "nestjs", role: "controller", name: c.name, prefix: c.prefix }, sourceRel, "RUNTIME_CONTROLLER");
    for (const r of c.routes || []) {
      addFact("route", controllerSubject, "route", { method: r.method, path: r.path, controller: c.name }, sourceRel, "RUNTIME_ROUTE");
    }
  }
  for (const p of parsed.providers || []) {
    addFact("provider", `runtime_provider:${p.token}`, "framework_role", { framework: "nestjs", role: "provider", name: p.name, scope: p.scope }, sourceRel, "RUNTIME_PROVIDER");
  }
  for (const g of parsed.guards || []) {
    addFact("guard", `runtime_guard:${g.token}`, "framework_role", { framework: "nestjs", role: "guard", name: g.name }, sourceRel, "RUNTIME_GUARD");
  }
  for (const i of parsed.interceptors || []) {
    addFact("interceptor", `runtime_interceptor:${i.token}`, "framework_role", { framework: "nestjs", role: "interceptor", name: i.name }, sourceRel, "RUNTIME_INTERCEPTOR");
  }

  // Persist runtime evidence and facts into the store, bound to the revision.
  for (const e of evidence) store.putEvidence(revId, e);
  store.replaceFactsBySource(revId, "runtime:", facts);

  rmSync(scratch, { recursive: true, force: true });
  diagnostics.push(`emitted ${facts.length} runtime fact(s) and ${evidence.length} evidence ref(s)`);
  return okResult({} as CallContext, { facts, evidence, diagnostics });
}

function detectFramework(revision: RevisionRow): "nestjs" | "nextjs" | "express" | undefined {
  const facts = (revision as any).facts || [];
  if (facts.some((f: any) => f.predicate === "framework_role" && f.object?.value?.framework === "nestjs")) return "nestjs";
  if (facts.some((f: any) => f.predicate === "framework_role" && f.object?.value?.framework === "nextjs")) return "nextjs";
  if (facts.some((f: any) => f.predicate === "framework_role" && f.object?.value?.framework === "express")) return "express";
  // Fallback: inspect revision diagnostics or repo path for framework hints.
  const repoRoot = revision.repoRoot;
  if (findFile(repoRoot, ["app.module.ts", "app.module.js", "app.module.cjs"])) return "nestjs";
  if (findFile(repoRoot, ["next.config.js", "next.config.ts"]) || findFile(repoRoot, ["app", "pages"])) return "nextjs";
  return undefined;
}
