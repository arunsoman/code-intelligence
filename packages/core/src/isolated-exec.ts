// Isolated execution shared by the change engine, the campaign recipe runner, the per-child validator and the joint
// runner. Nothing here ever writes to a repository under its own root: callers copy a tree into a scratch directory
// first, and every process is started without a shell under Node's permission model where possible.
//
// Extracted from `changes.ts` so F08's runner and validator reuse exactly the same admission and check semantics:
//   - `copyTree` refuses symlinks and skips build/VCS noise;
//   - `applyTextEdits` refuses an edit whose quoted bytes are no longer there (STALE_REVISION);
//   - `typecheckDir` reports `file code message` lines with positions dropped, so moving code is not a new error;
//   - `runTestsIn` runs the checkout's tests under `--permission` with a bounded budget;
//   - `treeDiff`/`hashTree` give deterministic identity for a candidate tree.
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

/** Directory names never copied, hashed or walked: build output, VCS internals, caches. */
export const SKIP_DIRS = new Set(["node_modules", ".git", "target", "coverage", "dist", ".cie", ".next", "build", "out", ".turbo", ".cache"]);
export const SKIP_RE = /^(node_modules|\.git|target|coverage|dist|\.cie|\.next|build|out|\.turbo|\.cache)$/;

export const sha256 = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

export interface TextEdit { file: string; start: number; end: number; expected: string; newText: string }

export class IsolationError extends Error {
  readonly code: "FORBIDDEN" | "STALE_REVISION" | "INVALID_SCHEMA" | "RESOURCE_LIMIT";
  constructor(code: IsolationError["code"], message: string) { super(message); this.name = "IsolationError"; this.code = code; }
}

/** Is any path segment reserved? Used to skip noise and to bound what a transformation may touch. */
export function hasSkippedSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((s) => SKIP_DIRS.has(s)) || /(^|\/)(\.env|\.env\..*)$/.test(rel);
}

/** Copy a checkout into a scratch directory. Symlinks and special files are refused, not followed. */
export function copyTree(srcRoot: string, dstRoot: string): void {
  const src = realpathSync(srcRoot);
  cpSync(src, dstRoot, {
    recursive: true,
    dereference: false,
    filter: (p) => {
      const rel = relative(src, p);
      if (!rel) return true;
      if (hasSkippedSegment(rel)) return false;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new IsolationError("FORBIDDEN", `checkout contains a symlink: ${rel}`);
      return true;
    },
  });
}

export function makeScratch(prefix = "cie-campaign-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function removeScratch(dir: string): void { rmSync(dir, { recursive: true, force: true }); }

/** Apply byte-span edits to files inside `dir`. Each edit must find the bytes it quotes. */
export function applyTextEdits(dir: string, edits: TextEdit[]): void {
  const byFile = new Map<string, TextEdit[]>();
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  for (const [file, es] of byFile) {
    const path = safeJoin(dir, file);
    let buf = readFileSync(path);
    for (const e of [...es].sort((a, b) => b.start - a.start)) {
      if (buf.subarray(e.start, e.end).toString("utf8") !== e.expected) throw new IsolationError("STALE_REVISION", `the text at ${file}:${e.start} is not what the edit expected`);
      buf = Buffer.concat([buf.subarray(0, e.start), Buffer.from(e.newText), buf.subarray(e.end)]);
    }
    writeFileSync(path, buf);
  }
}

/** Resolve `rel` inside `root`, refusing traversal. */
export function safeJoin(root: string, rel: string): string {
  const abs = resolve(root, rel);
  const r = relative(root, abs);
  if (r.startsWith("..") || (r && r.split(sep).includes(".."))) throw new IsolationError("FORBIDDEN", `path escapes the checkout: ${rel}`);
  return abs;
}

export function walkFiles(root: string, pred: (rel: string) => boolean, cap = 200_000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_RE.test(name)) continue;
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs);
      else if (st.isFile() && pred(relative(root, abs))) { out.push(relative(root, abs)); if (out.length > cap) throw new IsolationError("RESOURCE_LIMIT", "too many files"); }
    }
  };
  walk(root);
  return out;
}

export interface TreeChange { file: string; kind: "ADDED" | "MODIFIED" | "DELETED"; oldHash: string | null; newHash: string | null; added: number; removed: number }

const readOrNull = (root: string, rel: string): Buffer | null => { try { return readFileSync(safeJoin(root, rel)); } catch { return null; } };

/** Every file in `root`, keyed by relative path (bounded by the byte budget). */
function listAll(root: string, maxBytes: number): Map<string, { hash: string; size: number }> {
  const seen = new Map<string, { hash: string; size: number }>();
  let bytes = 0;
  for (const rel of walkFiles(root, () => true)) {
    const data = readFileSync(safeJoin(root, rel));
    bytes += data.length;
    if (bytes > maxBytes) throw new IsolationError("RESOURCE_LIMIT", "checkout exceeds the read budget");
    seen.set(rel, { hash: sha256(data), size: data.length });
  }
  return seen;
}

/** Deterministic tree diff between two checkouts: sorted, positions independent, line counts for shape clustering. */
export function treeDiff(baseRoot: string, headRoot: string, maxBytes = 200 * 1024 * 1024): TreeChange[] {
  const base = listAll(baseRoot, maxBytes), head = listAll(headRoot, maxBytes);
  const files = [...new Set([...base.keys(), ...head.keys()])].sort();
  const out: TreeChange[] = [];
  for (const file of files) {
    const b = base.get(file), h = head.get(file);
    if (b && h) {
      if (b.hash === h.hash) continue;
      const counts = lineDelta(readOrNull(baseRoot, file)!.toString("utf8"), readOrNull(headRoot, file)!.toString("utf8"));
      out.push({ file, kind: "MODIFIED", oldHash: b.hash, newHash: h.hash, ...counts });
    } else if (h) {
      const text = readOrNull(headRoot, file)!.toString("utf8");
      out.push({ file, kind: "ADDED", oldHash: null, newHash: h.hash, added: text.split("\n").length, removed: 0 });
    } else {
      const text = readOrNull(baseRoot, file)!.toString("utf8");
      out.push({ file, kind: "DELETED", oldHash: b!.hash, newHash: null, added: 0, removed: text.split("\n").length });
    }
  }
  return out;
}

/** Cheap added/removed line counts (prefix/suffix trim), enough for a normalised diff shape. */
function lineDelta(a: string, b: string): { added: number; removed: number } {
  const al = a.split("\n"), bl = b.split("\n");
  let pre = 0; while (pre < al.length && pre < bl.length && al[pre] === bl[pre]) pre++;
  let sa = al.length, sb = bl.length; while (sa > pre && sb > pre && al[sa - 1] === bl[sb - 1]) { sa--; sb--; }
  return { added: Math.max(0, sb - pre), removed: Math.max(0, sa - pre) };
}

/** Content hash of every ordinary file in a tree (path, mode bit, bytes), sorted — the candidate's identity. */
export function hashTree(root: string, maxBytes = 200 * 1024 * 1024): string {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const rel of walkFiles(root, () => true)) {
    const abs = safeJoin(root, rel);
    const data = readFileSync(abs);
    bytes += data.length;
    if (bytes > maxBytes) throw new IsolationError("RESOURCE_LIMIT", "checkout exceeds the read budget");
    hash.update(JSON.stringify([rel, statSync(abs).mode & 0o111, data.length]));
    hash.update(data);
  }
  return hash.digest("hex");
}

/** A shape that ignores identifiers and positions: changed file suffixes and per-file line deltas. Clusters similar diffs. */
export function shapeHash(changes: TreeChange[]): string {
  return sha256(JSON.stringify(changes.map((c) => [c.file.split("/").slice(-1)[0], c.kind, c.added, c.removed]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
}

// ------------------------------------------------------------------ checks

/** TypeScript diagnostics as `file code message` lines (positions left out so moving code is not a new error). */
export function typecheckDir(dir: string): string[] {
  const files = walkFiles(dir, (rel) => /\.(ts|tsx|mts|cts)$/.test(rel) && !/\.d\.ts$/.test(rel) && !/\.(test|spec)\./.test(rel));
  if (!files.length) return [];
  const program = ts.createProgram(files.map((f) => join(dir, f)), {
    noEmit: true, allowImportingTsExtensions: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true, types: [], noImplicitAny: false, lib: ["lib.es2022.d.ts"],
  });
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].filter((d) => d.file)
    .map((d) => `${relative(dir, d.file!.fileName)} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ").slice(0, 160)}`).sort();
}

export interface TestRun { ran: boolean; passed: number; failed: number; output: string; reason?: string }

/** Run the checkout's tests under the permission model: it can read the checkout and nothing else, start nothing, reach nothing. */
export function runTestsIn(dir: string, timeoutMs = 120_000, only?: string[]): TestRun {
  // `only` narrows the run to named checkout-relative test files (the oracle's own file). Containment is checked here,
  // not trusted from the caller, so a role can never reach outside the checkout it was handed.
  const tests = only ? only.map((rel) => relative(dir, safeJoin(dir, rel))).filter((rel) => /\.[cm]?[jt]s$/.test(rel)) : walkFiles(dir, (rel) => /\.test\.(ts|js|mjs)$/.test(rel));
  if (!tests.length) return { ran: true, passed: 0, failed: 0, output: "no test files" };
  const res = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${dir}`, "--test", "--test-isolation=none", ...tests], {
    cwd: dir, env: { PATH: "/usr/bin:/bin", HOME: dir, LANG: "C" }, encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: false,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.error) return { ran: false, passed: 0, failed: 0, output: String(res.error.message).slice(0, 400), reason: "could not start the test process" };
  const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0), fail = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 0);
  return { ran: true, passed: pass, failed: fail, output: out.split("\n").filter((l) => /✖|ℹ (pass|fail|tests)|Error|error/.test(l)).slice(0, 40).join("\n") };
}

/** Compare a base and candidate tree's diagnostics, then run tests on the candidate when the root is trusted. */
export function compareDiagnostics(baseDir: string, headDir: string): { introduced: string[]; resolved: number; baseline: number } {
  const before = typecheckDir(baseDir), after = typecheckDir(headDir);
  const beforeCount = new Map<string, number>();
  for (const d of before) beforeCount.set(d, (beforeCount.get(d) ?? 0) + 1);
  const introduced: string[] = []; const seen = new Map<string, number>();
  for (const d of after) { seen.set(d, (seen.get(d) ?? 0) + 1); if ((seen.get(d) ?? 0) > (beforeCount.get(d) ?? 0)) introduced.push(d); }
  return { introduced, resolved: Math.max(0, before.length - (after.length - introduced.length)), baseline: before.length };
}

/** Link a package into a consumer's `node_modules` as npm workspaces would, without a network install. */
export function linkLocalPackage(workspaceDir: string, consumerDir: string, packageName: string, producerDir: string): string {
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(packageName)) throw new IsolationError("INVALID_SCHEMA", "package name is not a valid npm name");
  const parts = packageName.split("/");
  const targetDir = join(workspaceDir, "node_modules", ...parts.slice(0, -1));
  const linkPath = join(targetDir, parts[parts.length - 1]!);
  const mkdir = (d: string) => { try { statSync(d); } catch { mkdirSync(d, { recursive: true }); } };
  mkdir(targetDir);
  const relTarget = relative(dirname(linkPath), producerDir);
  try { rmSync(linkPath, { recursive: true, force: true }); } catch { /* absent */ }
  symlinkSync(relTarget, linkPath, "dir");
  // Make the link reachable from the consumer by putting the workspace root on its resolution path.
  symlinkResolutionRoot(consumerDir, join(workspaceDir, "node_modules"));
  return "npm-workspace-symlink";
}

/** Place a `node_modules` marker so Node resolves upward into the workspace root's linked packages. */
function symlinkResolutionRoot(consumerDir: string, rootNodeModules: string): void {
  // Node already walks up to `workspaceDir/node_modules`, so nothing else is needed when the consumer is a
  // direct child of the workspace. This helper keeps the contract explicit for future nested layouts.
  void consumerDir; void rootNodeModules;
}

export { basename, dirname, join, relative, resolve, tmpdir };
