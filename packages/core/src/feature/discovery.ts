// Task 1.C — repository discovery with an explicit coverage record per domain (spec §30.1, PF-004, PF-043; AT-01, AT-33).
// "Not found" is only ever said as NOT_FOUND_WITHIN_SEARCHED_SCOPE, with the roots, exclusions and tools that were searched,
// so an absence never reads as "this repository has no authorization layer". Denied paths are counted, never named.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { policyFor } from "../access.ts";
import { SKIP_RE } from "../isolated-exec.ts";
import { queryTerms } from "../retrieval.ts";
import type { Store } from "../store.ts";
import { canonHash, defineSchema, type Canon } from "./canon.ts";
import type { CoverageRecord, CoverageState, DiscoveryDomain, Id, RepositoryAssessment, Snapshot } from "./types.ts";

export interface DiscoveryBudget { files: number; tokens: number }
/** The repository-wide domains discovery covers; CAPABILITIES is recorded separately by the overlap search (task 2.I). */
export type RepoDomain = Exclude<DiscoveryDomain, "CAPABILITIES">;
export const DOMAINS: readonly RepoDomain[] = ["LANGUAGES", "BUILD", "TESTS", "STARTUP", "UI", "API_CONVENTIONS", "PERMISSIONS", "TENANCY", "DATA_ACCESS", "WORKERS", "MIGRATIONS", "INTEGRATIONS", "OBSERVABILITY"];
const MAX_READ_BYTES = 256 * 1024, MAX_ARTIFACTS = 20;
const TOOLS = ["file-walk", "package-manifest", "content-scan", "entity-index"];

export interface Walked { files: string[]; truncated: boolean; deniedCount: number }
export function walk(root: string, limit: number, denied: (rel: string) => boolean): Walked {
  const files: string[] = []; let truncated = false, deniedCount = 0;
  readdirSync(root); // an unreadable or missing root must fail the whole walk, not look like an empty repository
  const visit = (dir: string): void => {
    let names: string[]; try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (truncated) return;
      if (SKIP_RE.test(n)) continue;
      const abs = join(dir, n), rel = relative(root, abs);
      let st; try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (denied(rel)) { deniedCount++; continue; }
      if (st.isDirectory()) visit(abs);
      else if (st.isFile()) { if (files.length >= limit) { truncated = true; return; } files.push(rel); }
    }
  };
  visit(root);
  return { files, truncated, deniedCount };
}

export const SRC = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift)$/;
export const readText = (root: string, rel: string): string => { try { const b = readFileSync(join(root, rel)); return b.subarray(0, MAX_READ_BYTES).toString("utf8"); } catch { return ""; } };

export interface PackageInfo { present: boolean; scripts: Record<string, string>; deps: Set<string>; main?: string; bin?: string[]; invalid?: string }
export function readPackage(root: string): PackageInfo {
  const f = join(root, "package.json");
  if (!existsSync(f)) return { present: false, scripts: {}, deps: new Set() };
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, any>;
    const deps = new Set<string>([...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {}), ...Object.keys(j.peerDependencies ?? {})]);
    const bin = typeof j.bin === "string" ? [j.bin] : Object.values(j.bin ?? {}).filter((x): x is string => typeof x === "string");
    return { present: true, scripts: typeof j.scripts === "object" && j.scripts ? j.scripts : {}, deps, main: typeof j.main === "string" ? j.main : undefined, bin };
  } catch (e) { return { present: true, scripts: {}, deps: new Set(), invalid: (e as Error).message.slice(0, 80) }; }
}

export interface StackReport { stack: string; supported: boolean; reason?: string; testCommand?: string }
/** Which build stacks the repository uses, and whether the slice can build and test them (plan S17). */
export function detectStacks(root: string, files: string[], pkg: PackageInfo, supported: readonly string[]): StackReport[] {
  const has = (re: RegExp) => files.some((f) => re.test(f));
  const out: StackReport[] = [];
  const tsLike = has(/\.(ts|tsx|js|mjs)$/) && (pkg.present || has(/\.test\.(ts|js|mjs)$/));
  if (tsLike) {
    const stack = "typescript-node-npm";
    const nodeTests = files.filter((f) => /\.test\.(ts|js|mjs)$/.test(f));
    const testCommand = pkg.scripts.test ? "npm test" : nodeTests.length ? "node --test (no package.json test script)" : undefined;
    out.push({ stack, supported: supported.includes(stack) && !!testCommand, testCommand, reason: !supported.includes(stack) ? "not enabled in the feature configuration" : !testCommand ? "no test script and no test files were found, so nothing can validate a change" : pkg.invalid ? `package.json is not valid JSON (${pkg.invalid}); tests run directly` : undefined });
  }
  const other: [string, RegExp, string][] = [
    ["rust-cargo", /(^|\/)Cargo\.toml$/, "Rust builds are outside slice 1"], ["go-modules", /(^|\/)go\.mod$/, "Go builds are outside slice 1"],
    ["java-maven", /(^|\/)pom\.xml$/, "Maven builds are outside slice 1"], ["java-gradle", /(^|\/)build\.gradle(\.kts)?$/, "Gradle builds are outside slice 1"],
    ["python", /(^|\/)(pyproject\.toml|setup\.py|requirements[^/]*\.txt)$/, "Python builds are outside slice 1"], ["dotnet", /\.(csproj|sln)$/, ".NET builds are outside slice 1"],
  ];
  for (const [stack, re, reason] of other) if (has(re) && !out.some((o) => o.stack === stack)) out.push({ stack, supported: supported.includes(stack), reason: supported.includes(stack) ? undefined : reason });
  if (!out.length) out.push({ stack: "unknown", supported: false, reason: "no recognised build manifest or test files were found" });
  return out;
}

type Finder = (ctx: { root: string; files: string[]; pkg: PackageInfo; sources: () => { rel: string; text: string }[] }) => { artifacts: string[]; unsupported?: string[] };
const hasDep = (pkg: PackageInfo, names: string[]) => names.filter((n) => pkg.deps.has(n));
const pathHits = (files: string[], re: RegExp) => files.filter((f) => re.test(f));
const contentHits = (srcs: { rel: string; text: string }[], re: RegExp) => srcs.filter((s) => re.test(s.text)).map((s) => s.rel);

const FINDERS: Record<RepoDomain, Finder> = {
  LANGUAGES: ({ files }) => { const c = new Map<string, number>(); for (const f of files) { const e = /\.([A-Za-z0-9]+)$/.exec(f)?.[1]?.toLowerCase(); if (e && SRC.test(f)) c.set(e, (c.get(e) ?? 0) + 1); } return { artifacts: [...c].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}: ${n} files`) }; },
  BUILD: ({ files, pkg }) => ({ artifacts: [...pathHits(files, /(^|\/)(tsconfig[^/]*\.json|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|Makefile|vite\.config\.[jt]s|webpack\.config\.[jt]s)$/), ...(pkg.scripts.build ? ["package.json#scripts.build"] : [])] }),
  TESTS: ({ files, pkg }) => ({ artifacts: [...(pkg.scripts.test ? ["package.json#scripts.test"] : []), ...hasDep(pkg, ["jest", "vitest", "mocha", "playwright", "@playwright/test", "cypress"]).map((d) => `dependency ${d}`), ...pathHits(files, /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|rs|py)$/).slice(0, 8)] }),
  STARTUP: ({ files, pkg }) => ({ artifacts: [...(pkg.main ? [`package.json#main ${pkg.main}`] : []), ...(pkg.bin ?? []).map((b) => `package.json#bin ${b}`), ...(pkg.scripts.start ? ["package.json#scripts.start"] : []), ...pathHits(files, /(^|\/)(server|main|index|app)\.[cm]?[jt]s$/).slice(0, 6)] }),
  UI: ({ files, pkg }) => ({ artifacts: [...hasDep(pkg, ["react", "vue", "svelte", "@angular/core", "solid-js", "preact"]).map((d) => `dependency ${d}`), ...pathHits(files, /\.(tsx|jsx|vue|svelte)$|(^|\/)index\.html$/).slice(0, 8)] }),
  API_CONVENTIONS: ({ files, pkg }) => ({ artifacts: [...hasDep(pkg, ["express", "fastify", "koa", "hono", "@nestjs/core", "next"]).map((d) => `dependency ${d}`), ...pathHits(files, /(^|\/)(routes?|controllers?|api|handlers?)\//).slice(0, 8)] }),
  PERMISSIONS: ({ files, sources }) => ({ artifacts: [...pathHits(files, /(^|\/)(auth|authz|authn|access|permissions?|rbac|acl|policy|policies)([./_-]|\/|$)/i).slice(0, 8), ...contentHits(sources(), /\b(authorize|requireRole|hasPermission|isAdmin|checkAccess|can\(|ability\.)/).slice(0, 8)] }),
  TENANCY: ({ files, sources }) => ({ artifacts: [...pathHits(files, /tenan(t|cy)/i).slice(0, 6), ...contentHits(sources(), /\b(tenantId|tenant_id|organizationId|orgId|workspaceId)\b/).slice(0, 8)] }),
  DATA_ACCESS: ({ files, pkg }) => ({ artifacts: [...hasDep(pkg, ["pg", "mysql", "mysql2", "sqlite3", "better-sqlite3", "prisma", "@prisma/client", "typeorm", "mongoose", "knex", "sequelize", "drizzle-orm"]).map((d) => `dependency ${d}`), ...pathHits(files, /(^|\/)(db|database|models?|repositor(y|ies)|dao|store)(\/|\.|$)|\.sql$/i).slice(0, 8)] }),
  WORKERS: ({ files, pkg }) => ({ artifacts: [...hasDep(pkg, ["bull", "bullmq", "agenda", "node-cron", "bee-queue", "amqplib", "kafkajs"]).map((d) => `dependency ${d}`), ...pathHits(files, /(^|\/)(jobs?|workers?|queues?|cron|scheduler|tasks?)(\/|\.|$)/i).slice(0, 8)] }),
  MIGRATIONS: ({ files }) => ({ artifacts: pathHits(files, /(^|\/)(migrations?|migrate)(\/|\.|$)|\.sql$/i).slice(0, MAX_ARTIFACTS) }),
  INTEGRATIONS: ({ pkg, sources }) => ({ artifacts: [...hasDep(pkg, ["stripe", "aws-sdk", "@aws-sdk/client-s3", "twilio", "@sendgrid/mail", "axios", "node-fetch", "got", "undici", "googleapis"]).map((d) => `dependency ${d}`), ...contentHits(sources(), /\bfetch\(\s*["'`]https?:\/\//).slice(0, 6)] }),
  OBSERVABILITY: ({ files, pkg }) => ({ artifacts: [...hasDep(pkg, ["pino", "winston", "bunyan", "prom-client", "@opentelemetry/api", "dd-trace", "@sentry/node"]).map((d) => `dependency ${d}`), ...pathHits(files, /(^|\/)(logger|logging|metrics|telemetry|tracing)([./_-]|\/|$)/i).slice(0, 6)] }),
};

const AssessmentIdentity = defineSchema<{ snapshot: Snapshot; coverage: CoverageRecord[]; stacks: string[] }>("pf.RepositoryAssessment", "1", (a) => ({
  commit: a.snapshot.commitHash, contentRoot: a.snapshot.contentRootHash,
  coverage: a.coverage.map((c): Canon => ({ domain: c.domain, state: c.state, found: c.found, artifacts: c.artifacts, unresolved: c.unresolved })),
  stacks: a.stacks,
}));

export interface DiscoveryInput { store: Store; repoRoot: string; snapshot: Snapshot; supportedStacks: readonly string[]; requestText: string; budget: DiscoveryBudget }

/**
 * Walk the repository within budget and produce one CoverageRecord per domain. A truncated walk makes every domain PARTIAL
 * (the unsearched remainder is listed), never COMPLETE. An unreadable root is FAILED for every domain, never "not found".
 */
export function discover(i: DiscoveryInput): RepositoryAssessment {
  const policy = policyFor(i.store, i.repoRoot);
  const exclusions = [...[".git", "node_modules", "dist", "build", "target", "coverage", ".cache"].map((root) => ({ root, reason: "build output, dependencies or VCS internals" })), { root: ".cie", reason: "tool state" }];
  let walked: Walked | null = null; let failure: string | null = null;
  try { walked = walk(i.repoRoot, Math.max(1, Math.min(i.budget.files, 200_000)), (rel) => policy.denied(rel)); } catch (e) { failure = (e as Error).message.slice(0, 120); }
  const root = i.repoRoot;
  if (!walked) {
    const coverage = DOMAINS.map((domain): CoverageRecord => ({ domain, state: "FAILED", searchedRoots: ["."], excluded: exclusions, tools: TOOLS, found: "NOT_FOUND_WITHIN_SEARCHED_SCOPE", artifacts: [], unsupported: [], unresolved: [`the repository could not be read: ${failure}`] }));
    return finish(i, coverage, [], [], []);
  }
  const files = walked.files, pkg = readPackage(root);
  // Source text is read lazily and once, bounded by the file budget (a fifth of it, at most) so a huge repository stays cheap.
  let cached: { rel: string; text: string }[] | null = null;
  const sources = () => cached ??= files.filter((f) => SRC.test(f)).slice(0, Math.max(50, Math.floor(i.budget.files / 5))).map((rel) => ({ rel, text: readText(root, rel) }));
  const stacks = detectStacks(root, files, pkg, i.supportedStacks);
  const supported = stacks.some((s) => s.supported);
  const coverage = DOMAINS.map((domain): CoverageRecord => {
    const hit = FINDERS[domain]({ root, files, pkg, sources });
    const artifacts = [...new Set(hit.artifacts)].slice(0, MAX_ARTIFACTS);
    const unresolved: string[] = [];
    let state: CoverageState = "COMPLETE_WITHIN_SCOPE";
    if (walked!.truncated) { state = "PARTIAL"; unresolved.push(`the walk stopped after ${files.length} files; the rest of the repository was not searched`); }
    if (walked!.deniedCount) unresolved.push(`${walked!.deniedCount} path(s) were left out by access policy`);
    if (!supported && (domain === "BUILD" || domain === "TESTS")) { state = "UNSUPPORTED"; unresolved.push("no supported build stack was detected, so this domain cannot be established"); }
    return { domain, state, searchedRoots: ["."], excluded: exclusions, tools: TOOLS, found: artifacts.length ? "FOUND" : "NOT_FOUND_WITHIN_SEARCHED_SCOPE", artifacts, unsupported: [], unresolved };
  });
  const conventions: string[] = [];
  if (pkg.present) conventions.push(`package manifest with ${Object.keys(pkg.scripts).length} script(s)`);
  if (files.some((f) => /\.test\.[cm]?[jt]s$/.test(f))) conventions.push("tests live beside source as *.test.* files");
  if (files.some((f) => /(^|\/)(tests?|__tests__)\//.test(f))) conventions.push("tests live under a tests/ directory");
  if (stacks.some((s) => s.testCommand)) conventions.push(`tests run with ${stacks.find((s) => s.testCommand)!.testCommand}`);
  const uncovered = coverage.filter((c) => c.state !== "COMPLETE_WITHIN_SCOPE").map((c) => `${c.domain}: ${c.state}`);
  const related = relatedEntities(i.store, i.snapshot, i.requestText, policy.denied);
  return finish(i, coverage, stacks, conventions, uncovered, related);
}

function relatedEntities(store: Store, snap: Snapshot, text: string, denied: (f: string) => boolean): { id: Id; name: string; file: string }[] {
  const rev = store.latestRevision(snap.repositoryId); if (!rev) return [];
  const terms = queryTerms(text); if (!terms.length) return [];
  const out: { id: Id; name: string; file: string; n: number }[] = [];
  for (const e of store.entities(rev.id)) {
    if (e.kind === "file" || denied(e.file)) continue;
    const lower = e.name.toLowerCase(); const n = terms.filter((t) => lower.includes(t)).length;
    if (n) out.push({ id: e.entityId, name: e.name, file: e.file, n });
  }
  return out.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 25).map(({ id, name, file }) => ({ id, name, file }));
}

function finish(i: DiscoveryInput, coverage: CoverageRecord[], stacks: StackReport[], conventions: string[], uncovered: string[], related: RepositoryAssessment["relatedEntities"] = []): RepositoryAssessment {
  const id = canonHash(AssessmentIdentity, { snapshot: i.snapshot, coverage, stacks: stacks.map((s) => `${s.stack}:${s.supported}`) });
  return {
    schemaVersion: 1, id, snapshot: i.snapshot, coverage, conventions,
    supportMatrix: stacks.map((s) => ({ stack: s.stack, supported: s.supported, reason: s.reason })), existingDefects: [], uncovered, relatedEntities: related,
  };
}
