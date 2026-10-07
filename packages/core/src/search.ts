// F01 — Cross-repository search and precise navigation.
//
// In one paragraph: a repository registry, a content-addressed text index (one trigram FTS row per
// *blob*, shared across revisions and repositories), symbol definitions and references with an
// explicit resolution *basis* (the user-facing tier is derived from it, so a better future resolver
// upgrades results without a schema change), package identity across repositories, and the query
// paths built on them: text/regex/symbol search, resolveDefinition and findReferences. Everything is
// revision-bound and authorization-filtered *before* ranking and counting; what could not be
// determined is counted and disclosed, never silently omitted.
//
// Separate by design: `retrieveForQuestion` (retrieval.ts) answers conversation questions and is
// untouched; search never invents references and never routes a question to a view.
//
// Honesty rules this file keeps (each has a named test):
//  - "No results" is distinguishable from "not indexed", "language unsupported", "incomplete
//    extraction" and "stopped by a bound" (§8.3); zero hits say "fully indexed" only when true (D7).
//  - A rapid edit produces one current generation; a build whose revision was superseded while it
//    ran is dropped on commit and publishes nothing (F01-A4).
//  - A repository the caller cannot see contributes nothing — not to bodies, not to counts (A3).
//  - Identical names in different scopes or repositories never merge (A2).
//  - Ambiguity is listed as candidates; nothing is picked silently.
//  - Regex verification runs in the Rust worker on a linear-time engine; unsupported constructs are
//    rejected with the construct named (D2/D3; decision D1).
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ApiError, CallContext, CoverageByRepository, DefinitionLocation, Diagnostic, Entity, ReferenceHit, RepositoryIndexStatus,
  RepositorySelector, RepositoryView, SearchFilters, SearchHit, SearchIndexState, SearchModes, SkippedCounts,
  SearchResponse, SemanticIndexTier, SourceSpan, UnresolvedPackageEdge,
} from "@cie/schema";
import { OPEN } from "./access.ts";
import { resolveMentions } from "./mentions.ts";
import type { Store } from "./store.ts";
import type { WorkerClient } from "./worker.ts";

// ---- bounds (§13: defaults that hold before any measurement is recorded) ----
const MAX_TEXT_FILE_BYTES = 1 * 1024 * 1024; // 1 MiB per file; configurable via CIE_SEARCH_MAX_FILE_BYTES
export const MAX_HITS_PAGE = 200;
export const DEFAULT_HITS_PAGE = 50;
const CANDIDATE_BLOB_CAP = 4_000;            // candidate blobs examined per query before stoppedBy: BUDGET
const SHORT_QUERY_SCAN_CAP = 400;            // blobs scanned for a 1–2 character query
/** How many names one mentioned word may be read as (the resolver returns its best few). */
const MAX_READINGS = 3;
export const REEXPORT_DEPTH = 4;             // barrel-file expansion bound (§13), in hops
const IDENTIFIER_ROWS_PER_FILE = 8_000;      // per-file cap of the identifier scan
const OCCURRENCES_PER_BLOB = 200;            // occurrences of one query within one blob
const SNIPPET_CONTEXT_LINES = 2;
const MAX_QUERY_CHARS = 4_000;
const MAX_PATTERN_BYTES = 8 * 1024;

const GENERATED_GLOBS = /(^|\/)(generated|gens?|dist|build|out|target|vendor|third[_-]party)(\/|$)/i;
const GENERATED_SUFFIX = /\.(pb\.go|pb\.py|_pb2\.py|min\.js|min\.css)$/;
const GENERATED_HEADERS = [/@generated/, /DO NOT EDIT/i];
const LOCKFILES = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock)$/i;
const MANIFEST_FILES = new Set(["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "pom.xml"]);
const TEXT_LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "ts", tsx: "ts", js: "ts", mjs: "ts", cjs: "ts", jsx: "ts",
  rs: "rust", java: "java", go: "go", py: "python", nir: "nirdosha-v2",
};
const SYMBOL_KINDS = new Set(["function", "method", "class", "interface", "type", "enum", "test"]);
const TIER_RANK: Record<string, number> = { PRECISE: 0, RESOLVED: 1, HEURISTIC: 2, UNRESOLVED: 3 };
const MATCHKIND_RANK: Record<string, number> = { SYMBOL_EXACT: 0, SYMBOL_QUALIFIED: 1, TEXT_LITERAL: 2, TEXT_REGEX: 3, STRING_OR_DOC: 4 };
const REFKIND_RANK: Record<string, number> = { CALL: 0, IMPORT: 1, EXPORT: 2, READ: 3, TYPE: 3, STRING: 4, DOC: 4 };

// ---------------------------------------------------------------------------
// small types and pure helpers

export type ApiFail = { ok: false; error: ApiError; metadata: { requestId: string; completeness: "COMPLETE" | "PARTIAL"; warnings: string[] } };
export const failApi = (ctx: CallContext, code: ApiError["code"], message: string, retryable = false): ApiFail =>
  ({ ok: false, error: { code, message, retryable }, metadata: { requestId: ctx.requestId, completeness: "COMPLETE", warnings: [] } });

const snapshotWarnings = (pairs: { repositoryId: string; revision: string | null; }[], generations: (rid: string, rev: string | null) => number): string[] =>
  pairs.filter((p) => p.revision).map((p) => `${p.repositoryId}@${p.revision}@${generations(p.repositoryId, p.revision)}`);

export const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Language of a path from its extension. "" means unknown: searchable as text only (disclosed). */
export function languageOf(path: string): string {
  return TEXT_LANGUAGE_BY_EXT[(/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "").toLowerCase()] ?? "";
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|__mocks__)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.go$|^Test[A-Z]/.test(path);
}

function generatedReason(path: string, head: string): string | null {
  if (LOCKFILES.test(path.split("/").pop() ?? "")) return "lockfile";
  if (GENERATED_SUFFIX.test(path)) return "generated path";
  if (GENERATED_GLOBS.test("/" + path)) return "generated path";
  for (const h of GENERATED_HEADERS) if (h.test(head)) return "generated header";
  return null;
}

/** A restricted glob (`**`, `*`, `?`); `{a,b}` is refused with an error, never approximated. */
export function globRegExp(glob: string): RegExp {
  if (glob.includes("{") || glob.includes("}")) throw new Error("{a,b} alternatives are not supported in path globs; give the paths explicitly");
  const parts: string[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { parts.push(".*"); i++; }
    else if (c === "*") parts.push("[^/]*");
    else if (c === "?") parts.push("[^/]");
    else parts.push(c.replace(/[.+^$()|[\]\\]/g, "\\$&"));
  }
  return new RegExp(`^${parts.join("")}$`);
}

function matchGlobSet(list: string[] | undefined, path: string): boolean {
  if (!list?.length) return true;
  try { for (const g of list) if (globRegExp(g).test(path)) return true; } catch { return false; }
  return false;
}
function excludeGlobHit(list: string[] | undefined, path: string): boolean {
  if (!list?.length) return false;
  try { for (const g of list) if (globRegExp(g).test(path)) return true; } catch { return false; }
  return false;
}

/** Byte offset → {line, column} in UTF-16 code units, 1-based both — exactly where an editor puts a caret. */
export function byteToLineCol(text: string | Buffer, byteOffset: number): { line: number; column: number } {
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  let line = 1, column = 1, i = 0;
  const end = Math.max(0, Math.min(Math.floor(byteOffset), bytes.length));
  while (i < end) {
    const b = bytes[i];
    if (b === 0x0a) { line++; column = 1; i++; continue; }
    let unit = 1;
    if (b >= 0xf0) unit = 4; else if (b >= 0xe0) unit = 3; else if (b >= 0xc0) unit = 2;
    let cp = 0;
    if (unit === 1) cp = b;
    else if (i + unit <= bytes.length) {
      cp = b & (unit === 2 ? 0x1f : unit === 3 ? 0x0f : 0x07);
      for (let k = 1; k < unit; k++) cp = (cp << 6) | (bytes[i + k] & 0x3f);
    }
    column += cp >= 0x10000 ? 2 : 1;
    i += unit;
  }
  return { line, column };
}

/** {line, column in 1-based UTF-16 units} → the byte offset where that column's first byte sits (D4). */
export function lineColToByte(text: string | Buffer, line: number, column: number): number {
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  if (!Number.isFinite(line) || line < 1 || !Number.isFinite(column) || column < 1) return 0;
  const lineStarts: number[] = [0];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) lineStarts.push(i + 1);
  const li = Math.min(line - 1, lineStarts.length - 1);
  const lineStr = bytes.toString("utf8", lineStarts[li], li + 1 < lineStarts.length ? lineStarts[li + 1] : bytes.length);
  // consume exactly column-1 code units; a column that would start inside a surrogate pair clamps to the
  // pair's start — never to the middle of an encoded byte (D4).
  const target = column - 1;
  let u16 = 0, bytePos = 0;
  for (const ch of lineStr) {
    if (u16 >= target) break;
    const w = (ch.codePointAt(0) ?? 0) >= 0x10000 ? 2 : 1;
    if (u16 + w > target) break;
    bytePos += Buffer.byteLength(ch, "utf8");
    u16 += w;
  }
  return lineStarts[li] + bytePos;
}

function snippetLines(bodyStr: string, startByte: number, endByte: number): { lines: string[]; startLine: number } {
  const all = bodyStr.split("\n");
  const lineStarts: number[] = [];
  let acc = 0;
  for (const l of all) { lineStarts.push(acc); acc += Buffer.byteLength(l, "utf8") + 1; }
  let first = 0;
  for (let i = 0; i < lineStarts.length; i++) if (lineStarts[i] <= startByte) first = i;
  let last = first;
  for (let i = first; i < lineStarts.length; i++) if (lineStarts[i] < endByte) last = i;
  const from = Math.max(0, first - SNIPPET_CONTEXT_LINES);
  const to = Math.min(all.length - 1, last + SNIPPET_CONTEXT_LINES);
  return { lines: all.slice(from, to + 1), startLine: from + 1 };
}

/** Is this byte position inside a string literal or a comment (per-line heuristic)? */
export function inStringOrComment(bodyStr: string, byteAt: number): "string" | "comment" | null {
  const lineStart = bodyStr.lastIndexOf("\n", Math.max(0, byteAt - 1)) + 1;
  const lineEnd = bodyStr.indexOf("\n", byteAt);
  const line = bodyStr.slice(lineStart, lineEnd < 0 ? bodyStr.length : lineEnd);
  const at = Math.min(Math.max(0, byteAt - lineStart), line.length);
  const before = line.slice(0, at);
  const trimmed = before.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "comment";
  let quote: string | null = null;
  for (let i = 0; i < before.length; i++) {
    const c = before[i] ?? "";
    if (c === "\\") { i++; continue; }
    if (quote === null && (c === '"' || c === "'" || c === "`")) quote = c;
    else if (quote === c) quote = null;
    else if (quote === null && c === "/" && before[i + 1] === "/") break;
  }
  return quote ? "string" : null;
}

/** The identifier a call/import span names: the last word before the first "(", else the first run. */
function writtenAt(body: Buffer, startByte: number, endByte: number): string {
  const text = body.toString("utf8", startByte, Math.min(endByte, body.length, startByte + 400));
  const cut = text.indexOf("(");
  const head = cut >= 0 ? text.slice(0, cut).trimEnd() : text;
  const m = /([A-Za-z_$][\w$]*)\s*$/.exec(head) ?? /([A-Za-z_$][\w$]*)/.exec(text);
  return m?.[1] ?? text.trim().slice(0, 80);
}

const finalIdentifier = (expr: string): string => {
  const m = /([A-Za-z_$][\w$]*)\s*\(?[^()]*$/.exec(expr) ?? /([A-Za-z_$][\w$]*)$/.exec(expr);
  return m?.[1] ?? expr.trim();
};

/** Whole-string occurrences of `needle` (substring semantics, as the trigram index provides). */
function allOccurrences(body: string, needle: string, cap: number): { at: number; inCtx: "string" | "comment" | null }[] {
  const out: { at: number; inCtx: "string" | "comment" | null }[] = [];
  let from = 0;
  for (;;) {
    const at = body.indexOf(needle, from);
    if (at < 0) break;
    from = at + needle.length;
    out.push({ at, inCtx: inStringOrComment(body, at) });
    if (out.length >= cap) break;
  }
  return out;
}

/** Longest literal run usable for the trigram prefilter of a regex pattern. */
export function longestLiteralRun(pattern: string): string {
  let best = "", cur = "";
  for (const r of patternAtoms(pattern)) {
    if (r.kind === "literal") { cur += r.text; if (cur.length > best.length) best = cur; }
    else cur = "";
  }
  return best;
}
function patternAtoms(pattern: string): { kind: "literal" | "meta"; text: string }[] {
  const out: { kind: "literal" | "meta"; text: string }[] = [];
  let i = 0, lit = "";
  const flush = () => { if (lit) { out.push({ kind: "literal", text: lit }); lit = ""; } };
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "\\") {
      const nxt = pattern[i + 1] ?? "";
      // A backslash escapes the next char; an escaped *punctuation* char keeps its literal reading.
      if (nxt && ".^$*+?()[]{}|/\\".includes(nxt)) { lit += nxt; i += 2; continue; }
      flush(); i += 2; continue; // \d, \w, \s ...: meta, no literal content
    }
    if (".^$*+?()[]{}|".includes(c)) { flush(); i++; continue; }
    lit += c; i++;
  }
  flush();
  return out;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

const fileOfEntity = (id: string, entities: Entity[]): string => entities.find((e) => e.entityId === id)?.file ?? (id.startsWith("file:") ? id.slice(5) : "");
function fileOfEntityId(id: string): string | null {
  if (id.startsWith("file:")) return id.slice(5);
  return /^[a-z]+:([^#]+)/.exec(id)?.[1] ?? null;
}

const cleanSkips = (skipped: Record<string, number>): SkippedCounts =>
  ({ generated: 0, binary: 0, too_large: 0, unsupported_language: 0, denied: 0,
     ...Object.fromEntries(Object.entries(skipped).filter(([k, v]) => v > 0 && k !== "indexed")) });

/** Content-addressed blob identity: the sha256 of the file's *bytes* — not the rows digest (rev_files.digest hash parsed rows). */
const sha256Bytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A bare identifier: no whitespace and no regex metacharacter — auto-searchable as a symbol name. */
export function isBareIdentifier(q: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(q);
}

/** Ordering of resolution kinds inside resolveDefinition (best binding first). */
const resRank = (r: string): number => (r === "RESOLVED" ? 0 : r === "PARSED" ? 1 : r === "OBSERVED" ? 2 : 3);

/** The identifier under the caret (byte offset), as written; "" when nothing word-like is at that byte. */
function tokenAt(text: string, byteOffset: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (byteOffset > bytes.length) return "";
  let lo = Math.max(0, byteOffset - 1);
  while (lo > 0 && isWordByte(bytes[lo])) lo--;
  if (!isWordByte(bytes[lo])) lo++;
  let hi = lo;
  while (hi < bytes.length && isWordByte(bytes[hi])) hi++;
  return lo < hi ? bytes.toString("utf8", lo, hi) : "";
}
const isWordByte = (x: number) => (x >= 0x41 && x <= 0x5a) || (x >= 0x61 && x <= 0x7a) || (x >= 0x30 && x <= 0x39) || x === 0x5f || x === 0x24;

/** The last dot-segment of a name: AuthService.login → login; the exported surface of a qualified symbol. */
const defNameBase = (name: string): string => (name.includes(".") ? name.split(".").pop()! : name);

/** Do two paths sit in the same directory (Go resolves identifiers within one package directory)? */
const sameGoDir = (a: string, b: string): boolean => {
  const da = a.split("/").slice(0, -1).join("/"), db = b.split("/").slice(0, -1).join("/");
  return da === db;
};

/** Does the text just before this byte start an export statement whose name list ends here? Used only to badge "EXPORT" ref_kind. */
function isExportStatement(body: Buffer, identifierStart: number): boolean {
  const lineStart = Math.max(0, body.lastIndexOf(0x0a, Math.max(0, identifierStart - 1)) + 1);
  const before = body.toString("utf8", lineStart, identifierStart);
  return /^\s*export\b/.test(before);
}

/** Resolve a relative import specifier against known file paths (re-export chains). Returns the resolved path or null. */
export function resolveSpecifier(fromPath: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // bare specifiers go through package identity, not files
  const back = fromPath.split("/").slice(0, -1);
  const parts = (spec.startsWith("/") ? spec.slice(1) : spec).split("/");
  const stack = spec.startsWith("/") ? [] : [...back];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const base = stack.join("/");
  for (const ext of ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", "/index.ts", "/index.tsx", "/index.mts", "/index.js", "/index.mjs", "/index.cjs"]) {
    if (known.has(base + ext)) return base + ext;
  }
  return null;
}

/** The user-facing tier, computed at query time from the stored basis + resolution (§6.4). */
export function tierFromBasis(basis: string, resolution: string): "PRECISE" | "RESOLVED" | "HEURISTIC" | "UNRESOLVED" {
  if (resolution === "UNRESOLVED") return "UNRESOLVED";
  if (basis === "SCIP" || basis === "COMPILER") return "PRECISE";
  if ((basis === "IMPORT_GRAPH" || basis === "REEXPORT" || basis === "EXPORT") && (resolution === "RESOLVED" || resolution === "PARSED")) return "RESOLVED";
  return "HEURISTIC";
}
export function basisWord(basis: string, resolution: string): string {
  const tier = tierFromBasis(basis, resolution);
  if (basis === "SCIP" || basis === "COMPILER") return "precise (compiler-indexed)";
  if (basis === "IMPORT_GRAPH") return "resolved (unique import binding)";
  if (basis === "STRING_MATCH") return "heuristic (string or comment occurrence)";
  if (basis === "NAME_MATCH") return "heuristic (name match)";
  if (tier === "UNRESOLVED") return "unresolved";
  return tier.toLowerCase();
}
function unresolvedWhy(refKind: string, name: string): string {
  if (refKind === "CALL") return `a call to "${name}" could not be resolved statically (dynamic dispatch or reflection is not statically provable)`;
  if (refKind === "IMPORT") return `the module "${name}" could not be bound: it is not a file of this repository and no package edge resolves it`;
  return "the occurrence could not be resolved by static analysis";
}

const normPkg = (n: string) => n.trim().toLowerCase();

// ---------------------------------------------------------------------------
// manifest parsing (shared with the F04 inventory slice; only what linking needs)

const MANIFEST_WALK_SKIP = new Set(["node_modules", ".git", ".hg", "target", "dist", "build", "out", "vendor", "__pycache__", ".venv", "venv", ".next", "coverage"]);
const MANIFEST_WALK_FILES_CAP = 500;
/**
 * Manifest paths by a bounded directory walk. Package manifests are not parsed code, so they are not in
 * rev_files; the walk skips dependency and build directories and stops at its bound — an honest inventory,
 * and the bound is declared in the BuildResult warnings when it cuts a larger tree short.
 */
function manifestPaths(root: string, denied: (rel: string) => boolean): { paths: string[]; truncated: boolean } {
  const out: string[] = [];
  let truncated = false;
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 6 || truncated) return;
    let dirents: any[];
    try { dirents = readdirSync(dir, { withFileTypes: true }) as any[]; } catch { return; }
    for (const d of dirents) {
      if (out.length >= MANIFEST_WALK_FILES_CAP) { truncated = true; return; }
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (MANIFEST_WALK_SKIP.has(d.name) || denied(r)) continue;
        walk(join(dir, d.name), r, depth + 1);
      } else if (d.isFile() && MANIFEST_FILES.has(d.name)) {
        if (denied(r)) continue; // a denied manifest contributes no packages and no requires (A3)
        out.push(r);
      }
    }
  };
  walk(root, "", 0);
  return { paths: out, truncated };
}

export interface ManifestInfo {
  path: string;
  ecosystem: "npm" | "go" | "cargo" | "pypi" | "maven";
  name: string | null;
  version: string | null;
  requires: { name: string; version: string | null }[];
}

export function parseManifest(path: string, body: string): ManifestInfo | { path: string; failed: string } {
  try {
    const base = path.split("/").pop() ?? path;
    if (base === "package.json") {
      const j = JSON.parse(body);
      const requires: { name: string; version: string | null }[] = [];
      for (const key of ["dependencies", "peerDependencies"]) for (const [n, v] of Object.entries(j[key] ?? {})) requires.push({ name: n, version: String(v) });
      return { path, ecosystem: "npm", name: typeof j.name === "string" ? j.name : null, version: typeof j.version === "string" ? j.version : null, requires };
    }
    if (base === "go.mod") {
      const module = /^module\s+(\S+)/m.exec(body)?.[1] ?? null;
      const requires: { name: string; version: string | null }[] = [];
      const block = /require\s*\(([^)]*)\)/s.exec(body)?.[1] ?? body;
      for (const line of block.split("\n")) {
        const m = /^require\s+([A-Za-z0-9._/-]+)\s+(v\S+)/.exec(line.trim()) ?? /^\s*([A-Za-z0-9._/-]+)\s+(v\S+)/.exec(line);
        if (m) requires.push({ name: m[1], version: m[2] });
      }
      return { path, ecosystem: "go", name: module, version: null, requires };
    }
    if (base === "Cargo.toml") {
      const pkgName = /^\[package\][\s\S]*?\bname\s*=\s*"([^"]+)"/m.exec(body)?.[1] ?? null;
      const version = /^\[package\][\s\S]*?\bversion\s*=\s*"([^"]+)"/m.exec(body)?.[1] ?? null;
      const requires: { name: string; version: string | null }[] = [];
      const dep = /^\[dependencies\]([\s\S]*?)(?:\n\[|$)/m.exec(body)?.[1] ?? "";
      for (const line of dep.split("\n")) {
        const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line);
        if (m) requires.push({ name: m[1], version: m[2] || null });
      }
      return { path, ecosystem: "cargo", name: pkgName, version, requires };
    }
    if (base === "pyproject.toml") {
      const proj = /^\[project\]([\s\S]*?)(?:\n\[|$)/m.exec(body)?.[1] ?? "";
      const nm = /^\s*name\s*=\s*"([^"]+)"/m.exec(proj)?.[1] ?? null;
      const dm = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(proj)?.[1] ?? "";
      const requires: { name: string; version: string | null }[] = [];
      for (const raw of dm.matchAll(/"([^"]+)"/g)) {
        const depName = raw[1].split(/[<>=!~;(\s]/)[0].trim();
        if (depName) requires.push({ name: normPkg(depName).replace(/_/g, "-"), version: /[<>=!~]+\s*([\d.]+)/.exec(raw[1])?.[1] ?? null });
      }
      return { path, ecosystem: "pypi", name: nm ? normPkg(nm).replace(/_/g, "-") : null, version: null, requires };
    }
    if (base === "pom.xml") {
      const groupId = /<groupId>([^<]+)<\/groupId>/.exec(body)?.[1] ?? "";
      const artifactId = /<artifactId>([^<]+)<\/artifactId>/.exec(body)?.[1] ?? "";
      if (!artifactId) return { path, failed: "no artifactId in pom.xml" };
      const requires: { name: string; version: string | null }[] = [];
      for (const d of body.matchAll(/<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:[\s\S]*?<version>([^<]*)<\/version>)?[\s\S]*?<\/dependency>/g)) {
        requires.push({ name: `${d[1]}:${d[2]}`, version: d[3] ?? null });
      }
      return { path, ecosystem: "maven", name: `${groupId}:${artifactId}`, version: null, requires };
    }
    return { path, failed: "not a recognized manifest" };
  } catch (e) {
    return { path, failed: `unreadable manifest: ${(e as Error).message}` };
  }
}

/** The package a code-level import statement names, per ecosystem; null when it is not identifiable. */
export function importPackageName(module: string, path: string): { ecosystem: ManifestInfo["ecosystem"]; name: string } | null {
  const m = module.includes(":") ? module.slice(module.indexOf(":") + 1) : module;
  if (path.endsWith(".go")) return m ? { ecosystem: "go", name: m } : null;
  if (path.endsWith(".rs")) { const crate = m.split("::")[0]; return crate && /^[A-Za-z_][\w-]*$/.test(crate) ? { ecosystem: "cargo", name: crate } : null; }
  if (path.endsWith(".py")) { const base = m.split(".")[0]; return base ? { ecosystem: "pypi", name: normPkg(base).replace(/_/g, "-") } : null; }
  if (path.endsWith(".java")) return null; // Maven addressable only through the dependency manifest
  if (m.startsWith("@")) { const at = m.indexOf("/", 1); return at > 0 ? { ecosystem: "npm", name: m.slice(0, at) } : null; }
  if (/^[A-Za-z][\w./-]*$/.test(m)) return { ecosystem: "npm", name: m.split("/")[0] };
  return null;
}

/**
 * Does a required version range admit the provider's version? A deliberately small, stated subset
 * (caret/tilde/exact/comparators/x-ranges, `||`, space lists); anything the subset cannot judge
 * (tags, git refs, workspace links) returns UNKNOWN — a gap, never a mismatch claim.
 */
export function versionRangeMeets(range: string, version: string | null | undefined): "OK" | "MISMATCH" | "UNKNOWN" {
  if (!version) return "UNKNOWN";
  const clean = (v: string) => v.trim().replace(/^[v=\s]+/, "");
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
    return m ? [+m[1], +(m[2] ?? 0), +(m[3] ?? 0)] : null;
  };
  const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const v = parse(clean(version));
  if (!v) return "UNKNOWN";
  const one = (atom: string): boolean | undefined => {
    const t = atom.trim().replace(/^[v=\s]+/, "");
    if (!t || t === "*" || t === "latest") return true;
    if (/^(\d+)(\.(\d+|\*|x))?(\.(\d+|\*|x))?$/.test(t)) {
      const w = parse(t.replace(/[x*]/g, "0"))!;
      const written = t.split(".").length;
      if (t.includes("x") || t.includes("*")) {
        if (written === 1) return v[0] === w[0];
        if (written === 2) return v[0] === w[0] && (t.split(".")[1] === "x" || t.split(".")[1] === "*" || v[1] === w[1]);
        return JSON.stringify(v) === JSON.stringify(w);
      }
      const wParts = t.split(".").map((s) => parseInt(s, 10) || 0);
      for (let i = 0; i < written; i++) if (v[i] !== wParts[i]) return false;
      return true;
    }
    let m: RegExpExecArray | null;
    if ((m = /^\^(\d.*)$/.exec(t))) {
      const w = parse(m[1]);
      if (!w) return undefined;
      if (cmp(v, w) < 0) return false;
      if (w[0] === 0) return w[1] === 0 ? v[0] === 0 && v[1] === 0 : v[0] === 0 && v[1] === w[1]; // 0.x caret: same major, and for ^0.0.* same minor
      return v[0] === w[0];
    }
    if ((m = /^~(\d.*)$/.exec(t))) {
      const w = parse(m[1]);
      if (!w) return undefined;
      return v[0] === w[0] && (w[0] === 0 ? v[1] === w[1] : true);
    }
    if ((m = /^(>=|>|<=|<)\s*(\d.*)$/.exec(t))) {
      const w = parse(m[2]);
      if (!w) return undefined;
      if (m[1] === ">=") return cmp(v, w) >= 0;
      if (m[1] === ">") return cmp(v, w) > 0;
      if (m[1] === "<=") return cmp(v, w) <= 0 || JSON.stringify(v) === JSON.stringify(w);
      return cmp(v, w) < 0;
    }
    return undefined; // tags, git urls, workspace:, link:, pre-release ranges
  };
  // Alternatives ("||") are OR: any alternative certainly met → OK; if none is met and none is unknown → MISMATCH;
  // anything the subset cannot judge keeps UNKNOWN — a gap, never a false mismatch claim.
  let sawTrue = false, sawUnknown = false;
  for (const alt of range.split("||")) {
    const atoms = alt.trim() === "" ? [""] : alt.trim().split(/\s+/);
    let verdict: boolean | undefined = true;
    for (const a of atoms) {
      const r = one(a);
      if (r === undefined) { verdict = undefined; break; }
      if (!r) { verdict = false; break; }
    }
    if (verdict === true) return "OK";
    if (verdict === undefined) sawUnknown = true;
  }
  return sawUnknown ? "UNKNOWN" : "MISMATCH";
}

// ---------------------------------------------------------------------------

export interface SearchRequest {
  query: string;
  mode?: SearchModes | "AUTO";
  repositories?: RepositorySelector;
  revision?: { kind: "DEFAULT_BRANCH_HEAD" } | { kind: "REVISION"; revisionId: string } | { kind: "COMMIT"; repositoryId: string; commitHash: string };
  filters?: SearchFilters;
  cursor?: string;
  limit?: number;
  caseSensitive?: boolean;
}

export interface BuildOptions {
  /** Test hook on the fence boundary (F01-A4): called just before the commit step. */
  beforeCommit?: (repositoryId: string, revision: string) => Promise<void> | void;
}

export interface BuildResult {
  repositoryId: string; revision: string;
  state: "BUILT" | "UNCHANGED" | "SUPERSEDED" | "NOT_INDEXED" | "REVOKED";
  buildMs: number;
  files: { total: number; textIndexed: number; skipped: SkippedCounts };
  symbols: { defs: number; refs: number };
  packages: { provides: number; requires: number; exports: number };
  edges: number;
  generation: number;
  warnings: string[];
  /** Paths searched as text only (the worker has no grammar for that extension). */
  textOnly: string[];
}

const emptyBuild = (state: BuildResult["state"], revision = "", repoId = "", warnings: string[] = []): BuildResult =>
  ({ repositoryId: repoId, revision, state, buildMs: 0, files: { total: 0, textIndexed: 0, skipped: {} as SkippedCounts }, symbols: { defs: 0, refs: 0 }, packages: { provides: 0, requires: 0, exports: 0 }, edges: 0, generation: 0, warnings, textOnly: [] });

interface BlobRow { hash: string; path: string; size: number; language: string; isGenerated: boolean; skipReason: string | null; body: Buffer }

const maxTier = (a: SemanticIndexTier | undefined, b: SemanticIndexTier): SemanticIndexTier => {
  const rank = { NONE: 0, SYNTAX: 1, COMPILER: 2 } as const;
  return (rank[a ?? "NONE"] >= rank[b] ? (a ?? "NONE") : b) as SemanticIndexTier;
};

// ---------------------------------------------------------------------------

type PageStep =
  | { kind: "page"; hits: SearchHit[]; nextCursor?: string }
  | { kind: "stale"; message: string };

export class SearchEngine {
  private store: Store;
  private getWorker: () => WorkerClient | null;
  private inflight = new Map<string, Promise<BuildResult>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: Store, getWorker: () => WorkerClient | null = () => null) {
    this.store = store;
    this.getWorker = getWorker;
  }

  private get db() { return this.store.db; }

  // ------------------------------------------------- flag and registry (§17, §6.1, D4/D5)

  searchEnabled(): boolean {
    if (/^(0|off|false)$/i.test(process.env.CIE_SEARCH ?? "")) return false;
    const r = this.db.prepare("select enabled from search_flags where id = 1").get() as { enabled: number } | undefined;
    return r ? !!r.enabled : true;
  }
  setSearchEnabled(enabled: boolean) {
    this.db.prepare("insert into search_flags values (1,?) on conflict(id) do update set enabled=excluded.enabled").run(enabled ? 1 : 0);
  }

  /**
   * A stable repository id (D4): from the git origin remote when there is one, so a re-clone or move
   * keeps identity; otherwise the absolute path is the locator fallback (stated in RepositoryView's
   * remoteUrl being null).
   */
  registerRepository(repoRoot: string, opts: { displayName?: string } = {}): string {
    const root = resolve(repoRoot);
    const registered = (this.db.prepare("select repository_id from repositories where root = ?").get(root) as any)?.repository_id;
    if (registered) return registered;
    let remoteUrl: string | null = null;
    try {
      if (existsSync(join(root, ".git", "config"))) remoteUrl = /\[remote "origin"\][\s\S]*?url = (\S+)/.exec(readFileSync(join(root, ".git", "config"), "utf8"))?.[1] ?? null;
    } catch { /* unreadable git config: path identity applies */ }
    const repositoryId = `repo:${remoteUrl ? sha16(`url:${remoteUrl}`) : sha16(`path:${root}`)}`;
    const displayName = opts.displayName ?? root.split(/[\\/]/).filter(Boolean).pop() ?? root;
    this.db.prepare("insert or ignore into repositories(repository_id, display_name, root, remote_url, authz_scope_id, state, added_at) values (?,?,?,?,?,?,?)")
      .run(repositoryId, displayName, existsSync(root) ? root : null, remoteUrl, "tenant", this.store.isRevoked(root) ? "REVOKED" : "ACTIVE", new Date().toISOString());
    return repositoryId;
  }

  repositoryOfRoot(repoRoot: string): { repositoryId: string; displayName: string; root: string } | null {
    const root = resolve(repoRoot);
    const r = this.db.prepare("select repository_id, display_name, root from repositories where root = ?").get(root) as any;
    if (r) return { repositoryId: r.repository_id, displayName: r.display_name, root };
    // an ingested revision whose build never ran still has an identity (path-derived), not a registered row
    const knownRoot = this.store.allRevisionRoots().find((r) => r.repoRoot === root);
    return knownRoot
      ? { repositoryId: `repo:${sha16(`path:${root}`)}`, displayName: root.split(/[\\/]/).filter(Boolean).pop() ?? root, root }
      : null;
  }

  repositoryIdForPath(root: string): string {
    const known = this.repositoryOfRoot(root);
    return known?.repositoryId ?? `repo:${sha16(`path:${resolve(root)}`)}`;
  }

  getRepository(repositoryId: string): RepositoryView | null {
    const r = this.db.prepare("select * from repositories where repository_id = ?").get(repositoryId) as any;
    if (!r) return null;
    const revoked = r.root ? this.store.isRevoked(r.root) : false;
    return {
      repositoryId: r.repository_id, displayName: r.display_name, root: r.root ?? null, remoteUrl: r.remote_url ?? null,
      state: revoked ? "REVOKED" : r.state, visibleToCaller: !revoked && r.state !== "REVOKED",
    };
  }

  displayNameOf(repositoryId: string): string {
    return (this.db.prepare("select display_name from repositories where repository_id = ?").get(repositoryId) as any)?.display_name ?? repositoryId;
  }

  rootOf(repositoryId: string): string | null {
    const r = (this.db.prepare("select root from repositories where repository_id = ?").get(repositoryId) as any)?.root;
    if (r) return r;
    const hit = this.store.allRevisionRoots().find((x) => `repo:${sha16(`path:${x.repoRoot}`)}` === repositoryId);
    return hit ? hit.repoRoot : null;
  }

  /**
   * The repositories a principal may search (§4.2 step 1): registered ACTIVE repositories, plus every
   * already-indexed root the product knows. When the principal is a known collaborator, only
   * repositories explicitly granted to them appear: no record means no access (collab.ts semantics).
   * A revoked repository is invisible for every principal.
   */
  visibleRepositories(principalId: string): { repositoryId: string; displayName: string; root: string }[] {
    const known = !!this.db.prepare("select 1 from collab_principals where principal = ?").get(principalId);
    const grants = known
      ? new Set((this.db.prepare("select repo_root from collab_access where principal = ? and allowed = 1").all(principalId) as { repo_root: string }[]).map((r) => r.repo_root))
      : null;
    const out = new Map<string, { repositoryId: string; displayName: string; root: string }>();
    for (const r of this.db.prepare("select repository_id, display_name, root from repositories where state = 'ACTIVE' order by added_at, repository_id").all() as any[]) {
      if (!r.root || this.store.isRevoked(r.root)) continue;
      if (grants && !grants.has(r.root)) continue;
      out.set(r.repository_id, { repositoryId: r.repository_id, displayName: r.display_name, root: r.root });
    }
    for (const x of this.store.allRevisionRoots()) {
      const root = resolve(x.repoRoot);
      if (this.store.isRevoked(root)) continue;
      if (grants && !grants.has(root)) continue;
      const id = this.repositoryOfRoot(root)?.repositoryId ?? this.repositoryIdForPath(root);
      if (!out.has(id)) out.set(id, { repositoryId: id, displayName: root.split(/[\\/]/).filter(Boolean).pop() ?? root, root });
    }
    return [...out.values()].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.repositoryId.localeCompare(b.repositoryId));
  }

  /** Whether this principal may see a path: repository policy + the person's own denied prefixes (§7.5). */
  pathAllowedFor(principalId: string, root: string | null, path: string): boolean {
    if (!path) return true;
    const norm = path.replace(/^\.?\//, "");
    let prefixes: string[] = root ? this.store.deniedPrefixes(root) : [];
    if (principalId && root) {
      const a = this.db.prepare("select allowed, denied from collab_access where principal = ? and repo_root = ?").get(principalId, root) as any;
      if (a) prefixes = [...prefixes, ...(JSON.parse(a.denied as string) as string[])];
    }
    return !prefixes.some((p) => norm === p || norm.startsWith(p.endsWith("/") ? p : p + "/"));
  }

  // ------------------------------------------------- build (§7.1; states §9.1)

  /** Coalescing wrapper (F01-A4): one run per repository at a time; a build superseded while it ran, or one
   *  that finished while a newer revision was indexed, is followed by a fresh build of the current head. */
  async buildForRepository(repoRoot: string, opts: BuildOptions = {}): Promise<BuildResult> {
    const key = resolve(repoRoot);
    const prior = this.inflight.get(key);
    if (prior) {
      const r = await prior;
      const latest = this.store.latestRevision(key)?.id ?? "";
      if (r.state === "BUILT" && (latest === r.revision || !r.revision)) return r;
      if (r.state === "REVOKED" || r.state === "NOT_INDEXED") return r;
      // SUPERSEDED, or the head moved on while we coalesced: fall through and build the newer revision.
    }
    // Builds are serialized behind a single queue: the fence compares against `latestRevision`, so two
    // overlapping builds of different heads could interleave at the hook and race the publish step.
    const p = this.queue.then(() => this.buildNow(key, opts).finally(() => { this.inflight.delete(key); }));
    this.queue = p.catch(() => {}); // a failed build must not poison the queue
    this.inflight.set(key, p);
    return p;
  }

  async buildNow(root: string, opts: BuildOptions = {}): Promise<BuildResult> {
    const t0 = performance.now();
    const rev = this.store.latestRevision(root);
    if (!rev) return emptyBuild("NOT_INDEXED");
    if (this.store.isRevoked(root)) {
      return emptyBuild("REVOKED", rev.id, this.repositoryOfRoot(root)?.repositoryId ?? "", ["access to this repository was withdrawn; it is not indexed until access is granted again"]);
    }
    const repositoryId = this.registerRepository(root);
    const repoPrefixes = this.store.deniedPrefixes(root);
    const denied = (file: string) => { const norm = file.replace(/^\.?\//, ""); return repoPrefixes.some((p) => norm === p || norm.startsWith(p.endsWith("/") ? p : p + "/")); };
    const skipped: Record<string, number> = { generated: 0, binary: 0, too_large: 0, unsupported_language: 0, denied: 0, indexed: 0 };
    const warnings: string[] = [];
    const textOnly: string[] = [];

    // ---- 1. inventory: the paths of the indexed revision, classified; bytes read once (§7.1.1) ----
    const rows = (this.db.prepare("select file as path from rev_files where revision = ? order by path").all(rev.id) as { path: string }[]).filter((r) => r.path !== "");
    const entities = this.store.entities(rev.id);
    const importsOf = new Map<string, Set<string>>();
    for (const r of this.store.allRelationships(rev.id)) {
      if (r.kind !== "imports" || r.resolution !== "RESOLVED") continue;
      const from = this.relationshipFile(rev.id, r.id) ?? fileOfEntity(r.from, entities);
      const to = fileOfEntity(r.to, entities);
      if (from && to) { const s = importsOf.get(from) ?? new Set<string>(); s.add(to); importsOf.set(from, s); }
    }
    const blobRows: BlobRow[] = [];
    let missingCount = 0;
    for (const r of rows) {
      if (denied(r.path)) { skipped.denied++; continue; }
      let body: Buffer | null = null;
      try { body = readFileSync(join(root, r.path)); } catch { body = null; }
      if (!body) { missingCount++; continue; } // counted in coverage; the count is named in warnings, the paths are not
      if (body.includes(0)) { skipped.binary++; continue; }
      if (body.length > MAX_TEXT_FILE_BYTES) { skipped.too_large++; continue; }
      if (generatedReason(r.path, body.toString("utf8", 0, Math.min(4096, body.length)))) { skipped.generated++; continue; }
      const language = languageOf(r.path);
      if (!language) { skipped.unsupported_language++; textOnly.push(r.path); continue; }
      blobRows.push({ hash: sha256Bytes(body), path: r.path, size: body.length, language, isGenerated: false, skipReason: null, body });
      skipped.indexed++;
    }

    // ---- 2. text index (per blob), trees, definitions, references, re-exports ----
    const defs = this.writeSymbolDefs(repositoryId, rev.id, entities, denied);
    const refs = this.writeSymbolRefs(repositoryId, rev.id, entities, blobRows, denied, importsOf);
    for (const b of blobRows) this.putBlob(b);
    const insTree = this.db.prepare("insert or ignore into tree_entries values (?,?,?,?)");
    for (const b of blobRows) insTree.run(repositoryId, rev.id, b.path, b.hash);

    // ---- 3. exports, package manifests, cross-repository edges (§7.1.5–6) ----
    this.markExports(repositoryId, rev.id);
    const packages = this.writePackages(root, repositoryId, rev.id, entities, denied);
    const edges = this.linkAllRepositories();

    // ---- 4. fence, then publish in one transaction (F01-A4) ----
    await opts.beforeCommit?.(repositoryId, rev.id);
    const committed = this.store.tx(() => {
      const latest = this.store.latestRevision(root);
      if ((latest?.id ?? "") !== rev.id) return null; // superseded while building: publish nothing
      // Publishing the same revision again re-publishes identical rows: it keeps its generation (idempotence,
      // §8.4). Only genuinely new content advances the counter.
      const prior = Number((this.db.prepare("select index_generation as g from repo_revision_state where repository_id = ? and revision = ?").get(repositoryId, rev.id) as any)?.g ?? 0);
      const gen = prior > 0 ? prior : Number((this.db.prepare("select max(index_generation) as g from repo_revision_state where repository_id = ?").get(repositoryId) as any)?.g ?? 0) + 1;
      this.db.prepare("delete from repo_revision_state where repository_id = ? and revision = ?").run(repositoryId, rev.id);
      const languageTiers = this.semanticTiers(repositoryId, rev.id);
      const anyTier = Object.values(languageTiers).reduce<SemanticIndexTier>((a, t) => maxTier(a, t), "NONE");
      this.db.prepare("insert into repo_revision_state values (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        repositoryId, rev.id, rev.gitHead, sha16(rev.id), gen, rev.analyzerVersion,
        missingCount > 0 ? "PARTIAL" : "COMPLETE", "COMPLETE", anyTier,
        rows.length, skipped.indexed, JSON.stringify(cleanSkips(skipped)), new Date().toISOString());
      this.pruneOldTrees(repositoryId, rev.id);
      return gen;
    });
    const buildMs = Math.round(performance.now() - t0);
    if (missingCount > 0) {
      const missing: string[] = [];
      for (const r of rows) {
        if (denied(r.path)) continue;
        try { if (existsSync(join(root, r.path))) continue; } catch { /* stat failure counts as missing */ }
        missing.push(r.path);
      }
      if (missing.length) warnings.push(`${missing.length} path(s) of this revision were not readable at build time and contribute no text-search rows in this generation: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? `, +${missing.length - 20} more` : ""}`);
      else warnings.push(`${missingCount} file(s) of this revision were not readable at build time; they contribute no text-search rows in this generation (their extracted symbols, if any, remain indexed)`);
    }
    if (committed === null) return { ...emptyBuild("SUPERSEDED", rev.id, repositoryId, ["the repository changed while the search index was being built; the older run was dropped and published nothing"]), buildMs };
    return {
      repositoryId, revision: rev.id, state: "BUILT", buildMs,
      files: { total: rows.length, textIndexed: skipped.indexed, skipped: cleanSkips(skipped) },
      symbols: { defs, refs }, packages, edges, generation: committed, warnings, textOnly: textOnly.slice(0, 50),
    };
  }

  private relationshipFile(revision: string, relId: string): string | null {
    const r = this.db.prepare("select file from relationships where revision = ? and id = ?").get(revision, relId) as { file: string } | null;
    return r?.file || null;
  }

  private factFile(revision: string, factId: string): string | null {
    const r = this.db.prepare("select file from facts where revision = ? and id = ?").get(revision, factId) as { file: string } | null;
    return r?.file || null;
  }

  private semanticTiers(repositoryId: string, revision: string): Record<string, SemanticIndexTier> {
    const defs = this.db.prepare("select path, basis from symbol_defs where repository_id = ? and revision = ?").all(repositoryId, revision) as { path: string; basis: string }[];
    const byLang = new Map<string, SemanticIndexTier>();
    for (const d of defs) {
      const l = languageOf(d.path);
      if (!l) continue;
      byLang.set(l, maxTier(byLang.get(l), d.basis === "COMPILER" || d.basis === "SCIP" ? "COMPILER" : "SYNTAX"));
    }
    return Object.fromEntries([...byLang].sort());
  }

  /** Blobs and their FTS row, idempotent by content hash: an unchanged file costs nothing (§6.2). */
  putBlob(b: BlobRow) {
    this.db.prepare("insert or ignore into blobs values (?,?,?,?,?,?)").run(b.hash, b.body.length, b.language, 0, b.isGenerated ? 1 : 0, b.skipReason);
    this.db.prepare("insert or ignore into blob_data values (?,?)").run(b.hash, b.body);
    const map = this.db.prepare("select rowid as rid from blob_text_map where blob_hash = ?").get(b.hash) as { rid: number } | undefined;
    if (!map) {
      const info = this.db.prepare("insert into blob_text(body) values (?)").run(b.body.toString("utf8"));
      this.db.prepare("insert into blob_text_map values (?,?)").run(b.hash, Number(info.lastInsertRowid));
    }
  }

  blobBody(blobHash: string): string | null {
    // node:sqlite hands BLOBs back as Uint8Array; `Uint8Array.toString()` yields byte-number CSV, so wrap it.
    const r = this.db.prepare("select body from blob_data where blob_hash = ?").get(blobHash) as { body: Uint8Array } | undefined;
    return r ? Buffer.from(r.body).toString("utf8") : null;
  }

  fileBody(repositoryId: string, revision: string, path: string): string | null {
    const t = this.db.prepare("select blob_hash from tree_entries where repository_id = ? and revision = ? and path = ?").get(repositoryId, revision, path) as { blob_hash: string } | undefined;
    return t ? this.blobBody(t.blob_hash) : null;
  }

  /** Keep tree rows for the current revision only; blobs nothing references go with their text rows (§6.3, D5). */
  private pruneOldTrees(repositoryId: string, revision: string) {
    this.db.prepare("delete from tree_entries where repository_id = ? and revision <> ?").run(repositoryId, revision);
    for (const d of this.db.prepare("select blob_hash as h from blobs b where not exists (select 1 from tree_entries t where t.blob_hash = b.blob_hash)").all() as { h: string }[]) {
      const map = this.db.prepare("select rowid as rid from blob_text_map where blob_hash = ?").get(d.h) as { rid: number } | undefined;
      if (map) this.db.prepare("delete from blob_text where rowid = ?").run(map.rid);
      this.db.prepare("delete from blob_text_map where blob_hash = ?").run(d.h);
      this.db.prepare("delete from blob_data where blob_hash = ?").run(d.h);
      this.db.prepare("delete from blobs where blob_hash = ?").run(d.h);
    }
  }

  // ------------------------------------------------- definitions (F01-A2: identity includes file and scope)

  private writeSymbolDefs(repositoryId: string, revision: string, entities: Entity[], denied: (file: string) => boolean): number {
    this.db.prepare("delete from symbol_defs where repository_id = ? and revision = ?").run(repositoryId, revision);
    const ins = this.db.prepare("insert or ignore into symbol_defs values (?,?,?,?,?,?,?,?,?,?,?,?)");
    let defs = 0;
    for (const e of entities) {
      if (!SYMBOL_KINDS.has(e.kind) || denied(e.file)) continue;
      const span = e.spans[0];
      ins.run(repositoryId, revision, e.entityId, null, e.name, e.name, e.kind, e.file, span?.startByte ?? 0, span?.endByteExclusive ?? (span?.startByte ?? 0), 0, "SYNTAX");
      defs++;
    }
    try {
      const canon = this.db.prepare("select entity_id, canon_id from canon_nodes where revision = ?").all(revision) as { entity_id: string; canon_id: string }[];
      const up = this.db.prepare("update symbol_defs set canonical_id = ? where repository_id = ? and revision = ? and symbol_id = ?");
      for (const c of canon) up.run(c.canon_id, repositoryId, revision, c.entity_id);
    } catch { /* the identity registry is optional for search; per-revision ids always work */ }
    return defs;
  }

  // ------------------------------------------------- references ------------------------------------------------

  /**
   * References, one row per occurrence (§6.2): the worker's resolved call/import edges (basis
   * IMPORT_GRAPH), the worker's unresolved call/import facts (the counted gaps), then the identifier
   * scan (NAME_MATCH/STRING_MATCH) and TS/JS re-export statements.
   */
  private writeSymbolRefs(repositoryId: string, revision: string, entities: Entity[], blobRows: BlobRow[], denied: (file: string) => boolean, importsOf: Map<string, Set<string>>): number {
    void importsOf;
    this.db.prepare("delete from symbol_refs where repository_id = ? and revision = ?").run(repositoryId, revision);
    const bodyByPath = new Map(blobRows.map((b) => [b.path, b.body] as [string, Buffer]));
    const nameOf = new Map(entities.map((e) => [e.entityId, e.name as string] as [string, string]));
    const fileOf = new Map(entities.map((e) => [e.entityId, e.file as string] as [string, string]));
    const ins = this.db.prepare("insert or ignore into symbol_refs values (?,?,?,?,?,?,?,?,?,?,?,?)");
    let refs = 0;
    const put = (refId: string, target: string | null, name: string, path: string, start: number, end: number, kind: string, resolution: string, basis: string, candidates: string[] | null) => {
      ins.run(repositoryId, revision, refId, target, name, path, start, end, kind, resolution, basis, candidates && candidates.length > 1 ? JSON.stringify(candidates.slice(0, 8)) : null);
      refs++;
    };

    // ---- resolved calls and imports: one row per recorded occurrence span ----
    const relOwner = new Map<string, string>();
    for (const r of this.db.prepare("select id, from_id, file from relationships where revision = ?").all(revision) as { id: string; from_id: string; file: string | null }[]) {
      relOwner.set(r.id, r.file || fileOfEntity(r.from_id, entities) || "");
    }
    const seenSpan = new Set<string>();
    for (const r of this.store.allRelationships(revision)) {
      if (r.kind !== "calls" && r.kind !== "imports") continue;
      const file = relOwner.get(r.id) ?? fileOfEntity(r.from, entities) ?? "";
      const targetFile = fileOfEntityId(r.to);
      if (denied(file) || (targetFile ? denied(targetFile) : false)) continue;
      for (const ev of r.evidence) {
        const span = (ev.location as any)?.span as SourceSpan | undefined;
        if (!span) continue;
        const key = `${r.id}|${file}|${span.startByte}`;
        if (seenSpan.has(key)) continue;
        seenSpan.add(key);
        const body = bodyByPath.get(file);
        const written = body ? writtenAt(body, span.startByte, span.endByteExclusive) : "";
        put(`ref:rel:${r.id}:${span.startByte}`, r.to, written || nameOf.get(r.to) || r.to, file, span.startByte, span.endByteExclusive, r.kind === "imports" ? "IMPORT" : "CALL", "RESOLVED", "IMPORT_GRAPH", null);
      }
    }

    // ---- unresolved calls and imports from the worker's facts: the counted gaps ----
    for (const f of this.store.factsByPredicate(revision, "calls")) {
      if (f.resolution !== "UNRESOLVED") continue;
      const path = this.factFile(revision, f.id) ?? fileOf.get(f.subject) ?? "";
      if (!path || denied(path)) continue;
      const expr = String((f.object as any)?.callee ?? (f.object as any)?.value ?? "") || "<unknown callee>";
      const span = (f.evidence[0]?.location as any)?.span as SourceSpan | undefined;
      put(`ref:${f.id}`, null, expr, path, span?.startByte ?? 0, span?.endByteExclusive ?? (span?.startByte ?? 0), "CALL", "UNRESOLVED", "", null);
    }
    for (const f of this.store.factsByPredicate(revision, "imports")) {
      if (f.resolution !== "UNRESOLVED") continue;
      const path = this.factFile(revision, f.id) ?? fileOf.get(f.subject) ?? "";
      if (!path || denied(path)) continue;
      const module = String((f.object as any)?.reason ?? (f.object as any)?.value ?? "");
      const span = (f.evidence[0]?.location as any)?.span as SourceSpan | undefined;
      put(`ref:${f.id}`, null, (module.split(" ").pop() ?? module) || "<module>", path, span?.startByte ?? 0, span?.endByteExclusive ?? (span?.startByte ?? 0), "IMPORT", "UNRESOLVED", "", null);
    }

    // ---- the identifier scan, then re-export statements ----
    refs += this.scanIdentifierUses(repositoryId, revision, entities, blobRows, denied, importsOf);
    refs += this.writeReexports(repositoryId, revision, blobRows, denied);
    return refs;
  }

  /** One occurrence row inside a string or comment (not a use; never shown as a reference by default). */
  private stringRow(
    put: (refId: string, target: string | null, name: string, path: string, start: number, end: number, kind: string, resolution: string, basis: string, cands: string[] | null) => void,
    path: string, body: Buffer, start: number, end: number, kind: "STRING" | "DOC", namesById: Map<string, string[]>,
  ) {
    const word = body.toString("utf8", start, end);
    if (word.length < 3 || !namesById.has(word)) return;
    put(`ref:${kind.toLowerCase()}:${path}:${start}`, null, word, path, start, end, kind, "PARSED", "STRING_MATCH", null);
  }

  /**
   * One byte-level pass per indexed file: a code token matching a symbol name is READ/CALL (or
   * EXPORT for export statements), NAME_MATCH by default and IMPORT_GRAPH only when the file imports
   * the unique defining file (or the symbol is local to the file); a token inside a string/comment is
   * STRING/DOC. The scanner covers the union of string/comment syntaxes of the supported languages
   * and is explicitly a heuristic classifier — the tier it gets says so.
   */
  private scanIdentifierUses(repositoryId: string, revision: string, entities: Entity[], blobRows: BlobRow[], denied: (file: string) => boolean, importsOf: Map<string, Set<string>>): number {
    const namesById = new Map<string, string[]>();
    for (const e of entities) {
      if (!SYMBOL_KINDS.has(e.kind) || denied(e.file)) continue;
      const add = (n: string, id: string) => { const l = namesById.get(n) ?? []; l.push(id); namesById.set(n, l); };
      add(e.name, e.entityId);
      const last = e.name.includes(".") ? e.name.split(".").pop()! : e.name;
      if (last !== e.name) add(last, e.entityId);
    }
    const defFileOf = new Map(entities.map((e) => [e.entityId, e.file] as [string, string]));
    const ins = this.db.prepare("insert or ignore into symbol_refs values (?,?,?,?,?,?,?,?,?,?,?,?)");
    const isWord = (x: number) => (x >= 0x41 && x <= 0x5a) || (x >= 0x61 && x <= 0x7a) || (x >= 0x30 && x <= 0x39) || x === 0x5f || x === 0x24;
    let refs = 0;
    const putRow = (refId: string, target: string | null, name: string, path: string, start: number, end: number, kind: string, resolution: string, basis: string, cands: string[] | null) => {
      ins.run(repositoryId, revision, refId, target, name, path, start, end, kind, resolution, basis, cands && cands.length > 1 ? JSON.stringify(cands.slice(0, 8)) : null);
      refs++;
    };
    for (const b of blobRows) {
      if (b.skipReason) continue;
      const body = b.body;
      if (!body.length) continue;
      const isRust = b.language === "rust";
      let count = 0, i = 0, stringChar = -1, inLine = false, inBlock = false, pyDoc = false;
      while (i < body.length) {
        if (count >= IDENTIFIER_ROWS_PER_FILE) break;
        const b1 = body[i];
        if (inLine) {
          if (b1 === 0x0a) { inLine = false; i++; continue; }
          if (isWord(b1)) {
            const start = i; let j = i;
            while (j < body.length && isWord(body[j])) j++;
            this.stringRow(putRow, b.path, body, start, j, "DOC", namesById);
            count++; i = j;
            continue;
          }
          i++; continue;
        }
        if (inBlock) {
          if (b1 === 0x2a && body[i + 1] === 0x2f) { inBlock = false; i += 2; continue; }
          if (isWord(b1)) {
            const start = i; let j = i;
            while (j < body.length && isWord(body[j])) j++;
            this.stringRow(putRow, b.path, body, start, j, "DOC", namesById);
            count++; i = j;
            continue;
          }
          i++; continue;
        }
        if (stringChar !== -1) {
          if (b1 === 0x5c) { i += 2; continue; }
          if (pyDoc && b1 === 0x22 && body[i + 1] === 0x22 && body[i + 2] === 0x22) { pyDoc = false; stringChar = -1; i += 3; continue; }
          if (b1 === stringChar) { stringChar = -1; i++; continue; }
          if ((stringChar === 0x22 || stringChar === 0x27) && b1 === 0x0a) { stringChar = -1; i++; continue; } // unterminated single-line string ends at the line end
          if (isWord(b1)) {
            const start = i; let j = i;
            while (j < body.length && isWord(body[j])) j++;
            this.stringRow(putRow, b.path, body, start, j, "STRING", namesById);
            count++; i = j;
            continue;
          }
          i++; continue;
        }
        // outside strings/comments: openers or a token
        if (b1 === 0x2f && body[i + 1] === 0x2f) { inLine = true; i += 2; continue; }
        if (b1 === 0x2f && body[i + 1] === 0x2a) { inBlock = true; i += 2; continue; }
        if (b1 === 0x23) { inLine = true; i++; continue; }
        if (b1 === 0x22 || b1 === 0x27 || b1 === 0x60) {
          if (b1 === 0x22 && body[i + 1] === 0x22 && body[i + 2] === 0x22) { pyDoc = true; stringChar = 0x22; i += 3; continue; }
          if (b1 === 0x27 && isRust && !(body[i + 2] === 0x27)) { i += 2; continue; } // Rust 'a lifetime, not a char literal
          stringChar = b1; i++; continue;
        }
        if (isWord(b1)) {
          const start = i;
          let j = i;
          while (j < body.length && isWord(body[j])) j++;
          const word = body.toString("utf8", start, j);
          i = j;
          const targets = namesById.get(word);
          if (!targets || word.length < 3) continue;
          const isExport = isExportStatement(body, start);
          const kind = isExport ? "EXPORT" : body[j] === 0x28 ? "CALL" : "READ";
          let basis = "NAME_MATCH", resolution = "PARSED";
          let target: string | null = null, candidates: string[] | null = null;
          if (targets.length === 1) {
            const defineFile = defFileOf.get(targets[0]);
            const bound = defineFile != null && defineFile !== ""
              ? (importsOf.get(b.path)?.has(defineFile) || defineFile === b.path || (b.language === "go" && sameGoDir(defineFile, b.path)))
              : false;
            target = targets[0];
            if (bound || isExport) { basis = "IMPORT_GRAPH"; resolution = "RESOLVED"; }
          } else candidates = targets;
          ins.run(repositoryId, revision, `ref:id:${b.path}:${start}`, target, word, b.path, start, j, kind, resolution, basis, candidates && candidates.length > 1 ? JSON.stringify(candidates.slice(0, 8)) : null);
          refs++; count++;
          continue;
        }
        i++;
      }
    }
    return refs;
  }

  /** `export { a, b } from "."` and `export * from "."`; resolvable specifiers bind the target file. */
  private writeReexports(repositoryId: string, revision: string, blobRows: BlobRow[], denied: (file: string) => boolean): number {
    let n = 0;
    const ins = this.db.prepare("insert or ignore into symbol_refs values (?,?,?,?,?,?,?,?,?,?,?,?)");
    const known = new Set(blobRows.map((b) => b.path));
    for (const b of blobRows) {
      if (b.language !== "ts") continue;
      const text = b.body.toString("utf8");
      for (const m of text.matchAll(/export\s*(\*|\{([^}]*)\})\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?from\s*["']([^"']+)["']/g)) {
        const spec = m[3];
        const resolved = resolveSpecifier(b.path, spec, known);
        if (!resolved || denied(resolved)) continue;
        const startByte = Buffer.byteLength(text.slice(0, m.index));
        const endByte = startByte + Buffer.byteLength(m[0]);
        const names = m[1] === "*" ? ["*"] : (m[2]?.split(",").map((s) => s.trim()).map((s) => s.replace(/\s+as\s+[\w$]*$/, "")).filter(Boolean) ?? []);
        for (const nm of names.length ? names : ["*"]) {
          ins.run(repositoryId, revision, `ref:reexp:${b.path}:${startByte}:${nm}`, `file:${resolved}`, nm, b.path, startByte, endByte, "REEXPORT", "RESOLVED", "IMPORT_GRAPH", JSON.stringify([resolved]));
          n++;
        }
      }
    }
    return n;
  }

  /** `exported` for a symbol = statically used from another file of the same revision. */
  private markExports(repositoryId: string, revision: string): number {
    const rows = this.db.prepare(`
      select distinct sr.target_symbol as target
      from symbol_refs sr
      where sr.repository_id = ? and sr.revision = ? and sr.target_symbol is not null
        and sr.path <> (select d.path from symbol_defs d where d.repository_id = sr.repository_id and d.revision = sr.revision and d.symbol_id = sr.target_symbol)`)
      .all(repositoryId, revision) as { target: string }[];
    const st = this.db.prepare("update symbol_defs set exported = 1 where repository_id = ? and revision = ? and symbol_id = ?");
    for (const r of rows) st.run(repositoryId, revision, r.target);
    return rows.length;
  }

  // ------------------------------------------------- packages and cross-repository edges -------------------------

  // Manifests are not parsed code (languageOf("") gives them the unsupported-language bucket and they are
  // never in the text index), so they are discovered by a bounded directory walk (§7.1.5). A denied manifest
  // path contributes nothing (A3); a walk cut short by its bound is disclosed through the build warnings.
  private writePackages(root: string, repositoryId: string, revision: string, entities: Entity[], denied: (file: string) => boolean): { provides: number; requires: number; exports: number } {
    this.db.prepare("delete from package_provides where repository_id = ? and revision = ?").run(repositoryId, revision);
    this.db.prepare("delete from package_requires where repository_id = ? and revision = ?").run(repositoryId, revision);
    this.db.prepare("delete from package_exports where repository_id = ? and revision = ?").run(repositoryId, revision);
    const providesIns = this.db.prepare("insert or ignore into package_provides values (?,?,?,?,?,?)");
    const requiresIns = this.db.prepare("insert or ignore into package_requires values (?,?,?,?,?,?)");
    const exportsIns = this.db.prepare("insert or ignore into package_exports values (?,?,?,?,?,?)");
    let provides = 0, requires = 0, exports = 0;

    for (const p of manifestPaths(root, denied).paths) {
      const base = p.split("/").pop() ?? "";
      if (!MANIFEST_FILES.has(base)) continue;
      try {
        const parsed = parseManifest(p, readFileSync(join(root, p), "utf8"));
        if (!("failed" in parsed)) {
          if (parsed.name) { providesIns.run(repositoryId, revision, parsed.ecosystem, normPkg(parsed.name), parsed.version, p); provides++; }
          for (const r of parsed.requires) { requiresIns.run(repositoryId, revision, parsed.ecosystem, normPkg(r.name), r.version, `manifest:${p}`); requires++; }
        }
      } catch { /* unreadable manifest bytes: no rows; the manifest stays a requires gap */ }
    }

    for (const f of this.store.factsByPredicate(revision, "imports_external")) {
      const path = this.factFile(revision, f.id) ?? fileOfEntity(f.subject, entities);
      if (!path || denied(path)) continue;
      const value = String((f.object as any)?.value ?? "").replace(/["']/g, "");
      const parsed = importPackageName(value, path) ?? importPackageName(String((f.object as any)?.reason ?? ""), path);
      if (!parsed) continue;
      requiresIns.run(repositoryId, revision, parsed.ecosystem, normPkg(parsed.name), null, `import:${parsed.name}`);
      requires++;
    }

    const pkgs = this.db.prepare("select ecosystem, package_name from package_provides where repository_id = ? and revision = ?").all(repositoryId, revision) as { ecosystem: string; package_name: string }[];
    if (!pkgs.length) return { provides, requires, exports: 0 };
    const exported = this.db.prepare("select symbol_id, name from symbol_defs where repository_id = ? and revision = ? and exported = 1 and name = qualified and name not like '%.%'").all(repositoryId, revision) as { symbol_id: string; name: string }[];
    for (const e of exported) {
      for (const p of pkgs) {
        exportsIns.run(repositoryId, revision, p.ecosystem, p.package_name, e.name, e.symbol_id);
        exports++;
      }
    }
    return { provides, requires, exports };
  }

  /** Recompute all edges: a cheap requires × provides join among ACTIVE repositories (§7.1 step 6). */
  private linkAllRepositories(): number {
    this.db.prepare("delete from cross_repo_edges").run();
    const providers = this.db.prepare("select p.repository_id, p.revision, p.ecosystem, p.package_name, p.version from package_provides p join repositories r on r.repository_id = p.repository_id where r.state = 'ACTIVE'").all() as any[];
    const byPkg = new Map<string, any[]>();
    for (const p of providers) { const k = `${p.ecosystem}|${normPkg(p.package_name)}`; byPkg.set(k, [...(byPkg.get(k) ?? []), p]); }
    const consumers = this.db.prepare("select r.repository_id, r.revision, r.ecosystem, r.package_name, r.version from package_requires r join repositories r2 on r2.repository_id = r.repository_id where r2.state = 'ACTIVE'").all() as any[];
    const ins = this.db.prepare("insert or ignore into cross_repo_edges values (?,?,?,?,?,?,?,?,?,?)");
    let n = 0;
    for (const req of consumers) {
      const candidates = (byPkg.get(`${req.ecosystem}|${normPkg(req.package_name)}`) ?? []).filter((p) => p.repository_id !== req.repository_id);
      if (!candidates.length) continue; // no visible provider: surfaced in coverage, not as an edge
      for (const p of candidates) {
        const verdict = req.version && p.version ? versionRangeMeets(String(req.version), p.version) : "UNKNOWN";
        ins.run(req.repository_id, req.revision, p.repository_id, p.revision, req.ecosystem, normPkg(req.package_name), "IMPORTS",
          `ev:pkg:${sha16(`${req.repository_id}|${req.revision}|${p.repository_id}|${req.package_name}`)}`,
          candidates.length > 1 ? 1 : 0,
          verdict === "MISMATCH" ? JSON.stringify({ required: req.version, provided: p.version }) : null);
        n++;
      }
    }
    return n;
  }

  // ------------------------------------------------- coverage (§7.7) ----------------------------

  coverageFor(principalId: string, pairs: { repositoryId: string; revision: string | null; name?: string }[], stoppedBy: CoverageByRepository["stoppedBy"], gapsByRepo: Map<string, UnresolvedPackageEdge[]>): CoverageByRepository[] {
    const out: CoverageByRepository[] = [];
    for (const p of pairs) {
      const st = p.revision
        ? this.db.prepare("select * from repo_revision_state where repository_id = ? and revision = ?").get(p.repositoryId, p.revision) as any
        : null;
      const skipped: Record<string, number> = st ? JSON.parse(st.skipped_json) : {};
      out.push({
        repositoryId: p.repositoryId, repositoryName: p.name ?? this.displayNameOf(p.repositoryId), revision: p.revision ?? "",
        indexGeneration: st?.index_generation ?? 0,
        textState: (st?.text_state ?? "NONE") as SearchIndexState,
        symbolState: (st?.symbol_state ?? "NONE") as SearchIndexState,
        semanticTierByLanguage: p.revision ? this.semanticTiers(p.repositoryId, p.revision) : {},
        files: { total: st?.files_total ?? 0, indexed: st?.files_indexed ?? 0, skipped: cleanSkips(skipped) },
        unresolvedPackageEdges: gapsByRepo.get(p.repositoryId) ?? [],
        stoppedBy,
      });
    }
    return out;
  }

  /** Unresolved package dependencies of one revision, judged against the caller's visible set (F01-A5). */
  private unresolvedPackageEdgesFor(principalId: string, repositoryId: string, revision: string): { edges: UnresolvedPackageEdge[]; invisible: number } {
    const visible = new Set(this.visibleRepositories(principalId).map((r) => r.repositoryId));
    const requires = this.db.prepare("select ecosystem, package_name, version, source from package_requires where repository_id = ? and revision = ?").all(repositoryId, revision) as { ecosystem: string; package_name: string; version: string | null; source: string }[];
    const codeImports = new Set(requires.filter((r) => r.source.startsWith("import:")).map((r) => r.package_name));
    const out: UnresolvedPackageEdge[] = [];
    let invisible = 0;
    for (const r of requires) {
      const providers = (this.db.prepare("select repository_id, version from package_provides where ecosystem = ? and package_name = ?").all(r.ecosystem, r.package_name) as { repository_id: string; version: string | null }[])
        .filter((p) => p.repository_id !== repositoryId);
      const visibleProviders = providers.filter((p) => visible.has(p.repository_id));
      if (visibleProviders.length === 1) {
        const v = visibleProviders[0];
        if (r.version && v.version && versionRangeMeets(String(r.version), v.version) === "MISMATCH") {
          out.push({ package: r.package_name, ecosystem: r.ecosystem, reason: "VERSION_MISMATCH", detail: `a visible provider is indexed at ${v.version}; the required range was ${r.version}` });
        }
        continue;
      }
      if (visibleProviders.length > 1) { out.push({ package: r.package_name, ecosystem: r.ecosystem, reason: "AMBIGUOUS", detail: "more than one visible repository provides this package; cross-repository reference resolution is not attempted" }); continue; }
      if (providers.length) { invisible++; continue; } // providers exist, but the caller may not see them: counted, never named (A3)
      out.push({
        package: r.package_name, ecosystem: r.ecosystem, reason: "PROVIDER_NOT_INDEXED",
        detail: codeImports.has(r.package_name) ? "imported in code, and no visible, indexed repository provides it" : "declared in a manifest, and no visible, indexed repository provides it",
      });
    }
    return { edges: out, invisible };
  }

  // ------------------------------------------------- search (§7.2, §7.4, §7.5) -------------------

  private disabled(): ApiFail {
    return failApi({ requestId: "disabled", idempotencyKey: "disabled", actor: { principalId: "disabled", tenantId: "disabled", sessionId: "disabled" }, deadlineMs: Number.MAX_SAFE_INTEGER, traceId: "disabled" }, "INVALID_SCHEMA", "search is disabled for this deployment (CIE_SEARCH=off or the search flag is off)", false);
  }

  async search(ctx: CallContext, req: SearchRequest): Promise<SearchResponse | ApiFail> {
    if (!this.searchEnabled()) return this.disabled();
    const q = typeof req.query === "string" ? req.query : "";
    if (q.length < 1 || q.length > MAX_QUERY_CHARS) return failApi(ctx, "INVALID_SCHEMA", `the query must be 1–${MAX_QUERY_CHARS} characters`);
    const mode: SearchModes | "AUTO" = (req.mode as SearchModes | "AUTO" | undefined) ?? "AUTO";
    if (!["LITERAL", "REGEX", "SYMBOL", "AUTO"].includes(mode)) return failApi(ctx, "INVALID_SCHEMA", "mode must be LITERAL, REGEX, SYMBOL or AUTO");

    const scope = this.resolveScope(ctx, req.repositories);
    if ("failure" in scope) return scope.failure;
    const selected = this.selectRevisions(ctx, scope, req.revision);
    if ("failure" in selected) return selected.failure;
    const built = selected.pairs.filter((p): p is typeof p & { revision: string } => !!p.revision && this.isBuilt(p.repositoryId, p.revision));
    const unbuilt = selected.pairs.filter((p) => !built.some((b) => b.repositoryId === p.repositoryId));

    const limit = Math.max(1, Math.min(Math.floor(req.limit ?? DEFAULT_HITS_PAGE), MAX_HITS_PAGE));
    const diagnostics: Diagnostic[] = [];
    let stopped: CoverageByRepository["stoppedBy"] = "NONE";
    try { for (const g of [...(req.filters?.pathGlobs ?? []), ...(req.filters?.excludePathGlobs ?? [])]) globRegExp(g); }
    catch (e) { return failApi(ctx, "INVALID_SCHEMA", (e as Error).message); }
    if (this.outOfTime(ctx)) return failApi(ctx, "DEADLINE_EXCEEDED", "the deadline expired before the search could start", true);

    let hits: SearchHit[] = [];
    let matched = 0, atLeast = false;

    if (mode === "SYMBOL" || (mode === "AUTO" && isBareIdentifier(q))) {
      const r = this.symbolDefHits(ctx.actor.principalId, built, q, req.filters, limit);
      matched += r.matched; atLeast ||= r.atLeast;
      hits.push(...r.hits);
    }
    if (mode === "LITERAL" || mode === "AUTO") {
      if (mode === "LITERAL" && !q.trim()) return failApi(ctx, "INVALID_SCHEMA", "an empty query matches every position; give something to look for");
      const t = this.textHits(ctx, built, q, { ...req.filters, caseInsensitive: mode === "LITERAL" ? !req.caseSensitive : true }, limit, diagnostics);
      matched += t.matched; atLeast ||= t.atLeast; if (t.stopped !== "NONE") stopped = t.stopped;
      hits.push(...t.hits);
    }
    // AUTO reads a question or a near-miss spelling as the code names it mentions ("what does MiFliter call" → MiFilter), using
    // the same resolver as the chat. Only when the query was not already an identifier that found its own definitions.
    const readAs: NonNullable<SearchResponse["readAs"]> = [];
    if (mode === "AUTO" && !(isBareIdentifier(q) && hits.some((h) => h.symbol))) {
      const named = this.namedDefHits(ctx.actor.principalId, built, q, req.filters, limit);
      matched += named.matched; atLeast ||= named.atLeast;
      hits.push(...named.hits); readAs.push(...named.readAs);
    }
    if (mode === "REGEX") {
      const verdict = await this.regexHits(ctx, built, q, { ...req.filters, caseInsensitive: !req.caseSensitive }, limit, diagnostics);
      if ("failure" in verdict) return verdict.failure;
      matched += verdict.matched; atLeast ||= verdict.atLeast; if (verdict.stopped !== "NONE") stopped = verdict.stopped;
      hits.push(...verdict.hits);
    }

    const ordered = this.rankHits(this.mergeAndLabel(hits));
    const cursorBase = { v: "1", q: sha16(`${q}|${mode}`), snap: selected.snapshotHash, authz: selected.policyHash };
    const page = this.paginate(cursorBase, ordered, limit, req.cursor);
    if (page.kind === "stale") {
      // §8.3: a refused cursor names the CURRENT snapshot set, so the caller can re-run without guessing
      const f = failApi(ctx, "STALE_REVISION", page.message, true);
      f.metadata.warnings.push(`current snapshot: ${snapshotWarnings(selected.pairs, (rid, rv) => this.generationOf(rid, rv ?? "")).join(", ")}`);
      return f;
    }

    // coverage and gaps: only repositories the caller may see were searched (F01-A3); counts after filtering
    const gapsByRepo = new Map<string, UnresolvedPackageEdge[]>();
    for (const p of selected.pairs) {
      const r = this.unresolvedPackageEdgesFor(ctx.actor.principalId, p.repositoryId, p.revision ?? "");
      const list = [...r.edges];
      if (r.invisible > 0) list.push({ package: "", ecosystem: "", reason: "PROVIDER_NOT_VISIBLE_COUNTED_NOT_NAMED", detail: `${r.invisible} of this repository's package dependencies reach repositories you cannot see; they are counted, never named` });
      gapsByRepo.set(p.repositoryId, list);
    }
    const coverage = this.coverageFor(ctx.actor.principalId, selected.pairs, stopped, gapsByRepo);
    if (unbuilt.length) diagnostics.push({ code: "INDEX_PENDING", message: `${unbuilt.length} repository(ies) in scope have no search index yet; build them with C07/enqueueIndex. The indexed ones were searched.`, relatedEntityIds: [], retryable: true });
    if (stopped === "DEADLINE") diagnostics.push({ code: "DEADLINE_PARTIAL", message: "the search stopped at its deadline; the hits shown were verified before it stopped", relatedEntityIds: [], retryable: false });
    if (stopped === "BUDGET") diagnostics.push({ code: "CANDIDATE_CAP", message: "the candidate file budget was reached; narrow the query or the scope for a complete answer", relatedEntityIds: [], retryable: true });
    if (page.nextCursor) diagnostics.push({ code: "PAGE_LIMIT", message: `the page size (${limit}) truncated the result; the next cursor continues it`, relatedEntityIds: [], retryable: false });

    return {
      mode,
      hits: page.hits,
      nextCursor: page.nextCursor,
      coverageByRepository: coverage,
      notIndexed: [
        ...selected.pairs.filter((p) => !p.revision)
          .map((p) => ({ repositoryId: p.repositoryId, repositoryName: scope.names?.get(p.repositoryId) ?? this.displayNameOf(p.repositoryId), reason: "no indexed revision of this repository yet; build it with C07/enqueueIndex" })),
        ...selected.pairs.filter((p) => p.revision && !this.isBuilt(p.repositoryId, p.revision))
          .map((p) => ({ repositoryId: p.repositoryId, repositoryName: scope.names?.get(p.repositoryId) ?? this.displayNameOf(p.repositoryId), reason: "its stored revision is not search-indexed yet; build it with C07/enqueueIndex" })),
        ...(scope.notIndexed ?? []),
      ],
      totals: { shown: page.hits.length, matched: atLeast ? null : matched, matchedAtLeast: atLeast ? matched : null },
      queryDiagnostics: diagnostics,
      ...(readAs.length ? { readAs } : {}),
    };
  }

  private mergeAndLabel(hits: SearchHit[]): SearchHit[] {
    const byKey = new Map<string, SearchHit>();
    for (const h of hits) {
      const key = `${h.repositoryId}|${h.path}|${h.span.startByte}`;
      const prior = byKey.get(key);
      if (!prior) { byKey.set(key, h); continue; }
      // same position from two paths: one hit, strongest tier, the union of match kinds and reasons (§7.4)
      const kinds = [...new Set([...prior.matchKinds, ...h.matchKinds])];
      const tier = TIER_RANK[h.tier] <= TIER_RANK[prior.tier] ? h.tier : prior.tier;
      const keep = TIER_RANK[h.tier] < TIER_RANK[prior.tier] ? h : prior;
      byKey.set(key, { ...keep, matchKinds: kinds, tier, rationale: [...new Set([...prior.rationale, ...h.rationale])] });
    }
    // an identifier-scan row whose span sits inside a resolved call/import row is the same occurrence:
    // the resolved row represents it (the weaker reading is never what the user is shown first).
    const resolved = [...byKey.values()].filter((h) => h.matchKinds.some((k) => k.startsWith("SYMBOL")));
    for (const r of resolved) {
      for (const other of [...byKey.values()]) {
        if (other === r || other.repositoryId !== r.repositoryId || other.path !== r.path) continue;
        if (other.span.startByte < r.span.startByte || other.span.endByteExclusive > r.span.endByteExclusive) continue;
        byKey.delete(`${other.repositoryId}|${other.path}|${other.span.startByte}`);
        byKey.set(`${r.repositoryId}|${r.path}|${r.span.startByte}`, r);
      }
    }
    return [...byKey.values()];
  }

  private rankHits(hits: SearchHit[]): SearchHit[] {
    const rank = (h: SearchHit) => Math.min(...h.matchKinds.map((k) => MATCHKIND_RANK[k] ?? 9)) * 2 + TIER_RANK[h.tier];
    const testPenalty = (h: SearchHit) => (isTestPath(h.path) ? 1 : 0);
    const crossPenalty = (h: SearchHit) => (h.viaPackage ? 1 : 0);
    return hits.sort((a, b) =>
      rank(a) - rank(b)
      || testPenalty(a) - testPenalty(b)
      || crossPenalty(a) - crossPenalty(b)
      || a.repositoryId.localeCompare(b.repositoryId)
      || a.path.localeCompare(b.path)
      || a.span.startByte - b.span.startByte
      || a.hitId.localeCompare(b.hitId));
  }

  private textHits(ctx: CallContext, pairs: { repositoryId: string; revision: string }[], q: string, filters: SearchFilters & { caseInsensitive?: boolean }, limit: number, diagnostics: Diagnostic[]): { hits: SearchHit[]; matched: number; atLeast: boolean; stopped: CoverageByRepository["stoppedBy"] } {
    const ci = filters.caseInsensitive ?? false;
    const visible = new Map(this.visibleRepositories(ctx.actor.principalId).map((r) => [r.repositoryId, r.root] as [string, string]));
    let candidates: { hash: string }[];
    let stopped: CoverageByRepository["stoppedBy"] = "NONE";
    let matched = 0, atLeast = false;
    if (q.length <= 2) {
      const scan = this.scanCandidates(pairs, SHORT_QUERY_SCAN_CAP);
      candidates = scan.candidates;
      stopped = scan.truncated ? "BUDGET" : "NONE";
      // the disclosure exists whenever the scan path answers — truncation only tightens stoppedBy
      diagnostics.push({ code: "SHORT_QUERY_SCAN_LIMITED", message: `a 1–2 character query cannot use the text index, so a scan of ${scan.examined} file(s) answered. ${scan.truncated ? `The scan stopped at the ${SHORT_QUERY_SCAN_CAP}-file bound — the answer may be partial.` : "Every candidate was scanned, so the answer is complete."} Longer queries are answered from the index.`, relatedEntityIds: [], retryable: false });
    } else {
      candidates = this.trigramCandidates(ci ? q.toLocaleLowerCase() : q).slice(0, CANDIDATE_BLOB_CAP);
      if (candidates.length === 0) return { hits: [], matched: 0, atLeast: false, stopped: "NONE" };
      if (candidates.length >= CANDIDATE_BLOB_CAP) stopped = "BUDGET";
    }
    const candSet = new Set(candidates.map((c) => c.hash));
    const hits: SearchHit[] = [];
    for (const repo of pairs) {
      if (stopped === "DEADLINE") break;
      if (hits.length >= limit && matched > hits.length) { if (stopped === "NONE") stopped = "LIMIT"; }
      const wanted = ci ? q.toLowerCase() : q;
      for (const t of this.db.prepare("select path, blob_hash from tree_entries where repository_id = ? and revision = ? order by path").all(repo.repositoryId, repo.revision) as { path: string; blob_hash: string }[]) {
        if (Date.now() > ctx.deadlineMs) { stopped = "DEADLINE"; break; }
        if (!candSet.has(t.blob_hash) && q.length > 2) continue;
        const bRow = this.db.prepare("select is_generated from blobs where blob_hash = ?").get(t.blob_hash) as { is_generated: number } | undefined;
        if (!(filters.includeGenerated ?? false) && bRow?.is_generated) continue;
        if (!(filters.includeTests ?? false) && isTestPath(t.path)) continue;
        if (!matchGlobSet(filters.pathGlobs, t.path) || excludeGlobHit(filters.excludePathGlobs, t.path)) continue;
        if (filters.languages?.length && !filters.languages.includes(languageOf(t.path))) continue;
        const root = visible.get(repo.repositoryId);
        if (!root || !this.pathAllowedFor(ctx.actor.principalId, root, t.path)) continue; // policy before anything is named (A3)
        const body = this.blobBody(t.blob_hash);
        if (body === null) continue;
        const hay = ci ? body.toLowerCase() : body;
        const positions = allOccurrences(hay, wanted, OCCURRENCES_PER_BLOB);
        if (!positions.length) continue;
        matched += positions.length;
        if (positions.length >= OCCURRENCES_PER_BLOB) atLeast = true; // per-blob cap: there were more
        for (const p of positions.slice(0, 50)) {
          const kinds: SearchHit["matchKinds"] = p.inCtx ? ["TEXT_LITERAL", "STRING_OR_DOC"] : ["TEXT_LITERAL"];
          hits.push(this.textHit({ repositoryId: repo.repositoryId, revision: repo.revision }, t.path, t.blob_hash, body, p.at, p.at + q.length, kinds, [ci ? "literal text (case-insensitive)" : "literal text"], q));
        }
      }
      if (hits.length >= limit * 3) { if (stopped === "NONE") stopped = "LIMIT"; atLeast = true; break; }
    }
    return { hits, matched, atLeast, stopped };
  }

  private async regexHits(ctx: CallContext, pairs: { repositoryId: string; revision: string }[], pattern: string, filters: SearchFilters & { caseInsensitive?: boolean }, limit: number, diagnostics: Diagnostic[]): Promise<{ hits: SearchHit[]; matched: number; atLeast: boolean; stopped: CoverageByRepository["stoppedBy"] } | { failure: ApiFail }> {
    const empty = { hits: [] as SearchHit[], matched: 0, atLeast: false, stopped: "NONE" as const };
    if (pattern.length > MAX_PATTERN_BYTES) return { failure: failApi(ctx, "BUDGET_EXCEEDED", `the pattern is longer than the ${MAX_PATTERN_BYTES}-byte limit`) };
    const ci = filters.caseInsensitive ?? false;
    let candidates = this.trigramCandidates(longestLiteralRun(pattern)).slice(0, CANDIDATE_BLOB_CAP);
    if (!candidates.length) {
      if (!pairs.length) return empty; // nothing indexed in scope: coverage says so, no regex error
      if (pairs.length !== 1) return { failure: failApi(ctx, "BUDGET_EXCEEDED", "this pattern has no literal run of 3+ characters, so the text index cannot prefilter it. Restrict the search to a single repository, or use a pattern with a literal run.") };
      diagnostics.push({ code: "REGEX_UNINDEXABLE", message: "this pattern has no trigram prefilter; a bounded scan answers it", relatedEntityIds: [], retryable: false });
      candidates = this.scanCandidates(pairs, SHORT_QUERY_SCAN_CAP).candidates;
    }
    const worker = this.getWorker();
    if (!worker) {
      diagnostics.push({ code: "REGEX_UNAVAILABLE", message: "regex verification needs the Rust parser binary (`cargo build --release`); no regex hits rather than an unsafe engine", relatedEntityIds: [], retryable: true });
      return empty;
    }
    const fileLists = new Map<string, string[]>();
    const blobByRepoPath = new Map<string, string>();
    const repoByRoot = new Map<string, string>();
    const candSet = new Set(candidates.map((c) => c.hash));
    for (const repo of pairs) {
      const root = this.rootOf(repo.repositoryId);
      if (!root || !this.visibleRepositories(ctx.actor.principalId).some((v) => v.repositoryId === repo.repositoryId)) continue;
      for (const t of this.db.prepare("select path, blob_hash from tree_entries where repository_id = ? and revision = ?").all(repo.repositoryId, repo.revision) as { path: string; blob_hash: string }[]) {
        if (!candSet.has(t.blob_hash)) continue;
        if (!(filters.includeGenerated ?? false) && !!((this.db.prepare("select is_generated from blobs where blob_hash = ?").get(t.blob_hash) as any)?.is_generated)) continue;
        if (!(filters.includeTests ?? false) && isTestPath(t.path)) continue;
        if (!matchGlobSet(filters.pathGlobs, t.path) || excludeGlobHit(filters.excludePathGlobs, t.path)) continue;
        if (filters.languages?.length && !filters.languages.includes(languageOf(t.path))) continue;
        if (!this.pathAllowedFor(ctx.actor.principalId, root, t.path)) continue;
        const list = fileLists.get(root) ?? []; list.push(t.path); fileLists.set(root, list);
        blobByRepoPath.set(`${root}|${t.path}`, t.blob_hash);
        repoByRoot.set(root, repo.repositoryId);
      }
    }
    const hits: SearchHit[] = [];
    let matched = 0, atLeast = false;
    let stopped: CoverageByRepository["stoppedBy"] = "NONE";
    try {
      for (const [root, files] of [...fileLists].sort(([a], [b]) => a.localeCompare(b))) {
        if (Date.now() > ctx.deadlineMs) { stopped = "DEADLINE"; break; }
        const repoId = repoByRoot.get(root)!;
        const pair = pairs.find((p) => p.repositoryId === repoId)!;
        const r = await worker.regexFind(root, files, pattern, {
          caseSensitive: !ci,
          deadlineMs: Math.max(200, Math.min(ctx.deadlineMs - Date.now() - 300, 5_000)),
          maxMatchesPerFile: OCCURRENCES_PER_BLOB,
          maxTotalMatches: Math.max(200, limit * 3),
        });
        matched += r.matches.length;
        atLeast ||= r.truncated;
        if (r.truncated && stopped === "NONE") stopped = "BUDGET";
        for (const m of r.matches) {
          const blobHash = blobByRepoPath.get(`${root}|${m.path}`);
          const body = blobHash ? this.blobBody(blobHash) : null;
          if (!body) continue;
          const inCtx = inStringOrComment(body, m.startByte);
          hits.push(this.textHit({ repositoryId: repoId, revision: pair.revision }, m.path, blobHash!, body, m.startByte, m.endByte, inCtx ? ["TEXT_REGEX", "STRING_OR_DOC"] : ["TEXT_REGEX"], ["regex match (verified by the linear-time engine)"], pattern));
        }
      }
    } catch (e) {
      const api = (e as { api?: ApiError }).api;
      if (api?.code === "INVALID_SCHEMA" && /backreference|look/i.test(api.message)) {
        return { failure: failApi(ctx, "INVALID_SCHEMA", `${api.message} Suggestion: match the surrounding characters literally instead, or use a simpler alternation.`) };
      }
      if (api?.code === "DEADLINE_EXCEEDED") return { ...empty, stopped: "DEADLINE" as const };
      if (api) return { failure: failApi(ctx, api.code, api.message, api.retryable) };
      throw e;
    }
    return { hits, matched, atLeast, stopped };
  }

  private scanCandidates(pairs: { repositoryId: string; revision: string }[], cap: number): { candidates: { hash: string }[]; truncated: boolean; examined: number } {
    const out: { hash: string }[] = [];
    let truncated = false, examined = 0;
    outer: for (const repo of pairs.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId))) {
      for (const r of this.db.prepare("select blob_hash as hash from tree_entries where repository_id = ? and revision = ? order by path").all(repo.repositoryId, repo.revision) as { hash: string }[]) {
        if (out.length >= cap) { truncated = true; break outer; }
        out.push(r); examined++;
      }
    }
    return { candidates: out, truncated, examined };
  }

  /** Candidate blobs through the trigram FTS index. */
  private trigramCandidates(phrase: string): { hash: string }[] {
    if (phrase.length < 3) return [];
    return this.db.prepare("select tm.blob_hash as hash from blob_text_map tm join blob_text b on b.rowid = tm.rowid where blob_text match ? order by tm.rowid").all(`"${phrase.replace(/"/g, '""')}"`) as { hash: string }[];
  }

  private textHit(repo: { repositoryId: string; revision: string }, path: string, blobHash: string, bodyStr: string, startByte: number, endByte: number, matchKinds: SearchHit["matchKinds"], rationale: string[], matched: string): SearchHit {
    const from = byteToLineCol(bodyStr, startByte);
    const to = byteToLineCol(bodyStr, endByte);
    const snip = snippetLines(bodyStr, startByte, endByte);
    const inCtx = inStringOrComment(bodyStr, startByte);
    const evId = `ev:search:${sha16(`${repo.repositoryId}|${repo.revision}|${path}|${startByte}|${endByte}|${matched}`)}`;
    this.store.putEvidence(repo.revision, {
      id: evId, sourceId: `file:${path}`,
      location: { kind: "CodeLocation", span: { sourceId: `file:${path}`, contentHash: blobHash, revision: repo.revision, startByte, endByteExclusive: endByte } },
      class: "STATIC_PARSED", observedAt: new Date().toISOString(), accessScopeId: "tenant", state: "CURRENT",
    });
    return {
      hitId: `hit:${evId.slice(11)}`,
      repositoryId: repo.repositoryId, repositoryName: this.displayNameOf(repo.repositoryId), revision: repo.revision, path,
      span: { sourceId: `file:${path}`, contentHash: blobHash, revision: repo.revision, startByte, endByteExclusive: endByte },
      display: { line: from.line, column: from.column, endLine: to.line, endColumn: to.column, snippet: snip.lines, snippetStartLine: snip.startLine },
      matchKinds, tier: inCtx ? "HEURISTIC" : "PRECISE",
      inString: inCtx !== null,
      rationale: [...rationale, ...(inCtx ? [`the match is inside a ${inCtx}; a text occurrence, not necessarily a use`] : [])],
      evidenceIds: [evId],
    };
  }

  private symbolDefHits(principalId: string, pairs: { repositoryId: string; revision: string }[], q: string, filters: SearchFilters | undefined, limit: number): { hits: SearchHit[]; matched: number; atLeast: boolean } {
    const hits: SearchHit[] = [];
    let matched = 0, atLeast = false;
    const kindSet = filters?.symbolKinds?.length ? new Set(filters.symbolKinds) : null;
    for (const p of pairs) {
      const rootOf = this.rootOf(p.repositoryId);
      const rows = (this.db.prepare("select * from symbol_defs where repository_id = ? and revision = ? and (name like ? escape '\\' or name like ? escape '\\') limit 5000").all(p.repositoryId, p.revision, `%${likeEscape(q)}%`, `${likeEscape(q)}%`) as any[])
        .map((d) => ({ ...d, score: this.defNameScore(d.name as string, q) }))
        .filter((d) => d.score <= 3)
        .sort((a, b) => a.score - b.score || (a.name as string).localeCompare(b.name as string));
      for (const d of rows) {
        matched++;
        if (kindSet && !kindSet.has(String(d.kind))) continue;
        if (isTestPath(String(d.path)) && !(filters?.includeTests ?? false)) continue;
        if (!matchGlobSet(filters?.pathGlobs, String(d.path)) || excludeGlobHit(filters?.excludePathGlobs, String(d.path))) continue;
        // authorization before anything about the path is named (A3): a denied definition is not a hit and not a count
        if (!rootOf || !this.pathAllowedFor(principalId, rootOf, String(d.path))) continue;
        if (hits.length >= limit) { atLeast = true; continue; }
        const body = this.fileBody(p.repositoryId, p.revision, String(d.path));
        const col = body ? byteToLineCol(body, Number(d.start_byte)) : { line: 1, column: 1 };
        const snip = body ? snippetLines(body, Number(d.start_byte), Number(d.end_byte)) : { lines: [], startLine: 1 };
        hits.push({
          hitId: `hit:def:${sha16(`${p.repositoryId}|${d.symbol_id}`)}`,
          repositoryId: p.repositoryId, repositoryName: this.displayNameOf(p.repositoryId), revision: p.revision, path: String(d.path),
          span: { sourceId: `file:${d.path}`, contentHash: "", revision: p.revision, startByte: Number(d.start_byte), endByteExclusive: Number(d.end_byte) },
          display: { line: col.line, column: col.column, endLine: col.line, endColumn: col.column, snippet: snip.lines.slice(0, 3), snippetStartLine: snip.startLine },
          matchKinds: [Number((d as { score: number }).score) === 0 ? "SYMBOL_EXACT" : "SYMBOL_QUALIFIED"],
          tier: d.basis === "COMPILER" || d.basis === "SCIP" ? "PRECISE" : "RESOLVED",
          symbol: { symbolId: String(d.symbol_id), name: String(d.name), kind: String(d.kind) },
          inString: false,
          rationale: [Number((d as { score: number }).score) === 0 ? "exact symbol name" : "name matches a component of the qualified symbol", "definition indexed from syntax"],
          evidenceIds: [],
        });
      }
    }
    return { hits, matched, atLeast };
  }

  /**
   * Definitions of the code names a query mentions (mentions.ts), each matched by its exact name. The resolver sees every
   * name in the revision; what reaches the caller is only what symbolDefHits authorizes, and a reading is reported only
   * when it produced such a hit.
   */
  private namedDefHits(principalId: string, pairs: { repositoryId: string; revision: string }[], q: string, filters: SearchFilters | undefined, limit: number): { hits: SearchHit[]; matched: number; atLeast: boolean; readAs: NonNullable<SearchResponse["readAs"]> } {
    const hits: SearchHit[] = [], readAs: NonNullable<SearchResponse["readAs"]> = [];
    let matched = 0, atLeast = false;
    for (const p of pairs) {
      for (const m of resolveMentions(this.store, p.revision, q, OPEN).resolved) {
        const names = [...new Set(m.matches.filter((x) => x.kind !== "file").map((x) => x.name))].filter((n) => n !== q).slice(0, MAX_READINGS);
        for (const name of names) {
          const r = this.symbolDefHits(principalId, [p], name, filters, limit);
          const exact = r.hits.filter((h) => h.symbol?.name === name);
          if (!exact.length) continue;
          matched += exact.length; atLeast ||= r.atLeast;
          const why = m.how === "fuzzy" ? `read “${m.text}” as ${name}, the closest name in the index (one or two letters apart)` : `the query names ${name}`;
          hits.push(...exact.map((h) => ({ ...h, rationale: [why, ...h.rationale] })));
          if (!readAs.some((x) => x.text === m.text && x.name === name)) readAs.push({ text: m.text, name, how: m.how });
        }
      }
    }
    return { hits, matched, atLeast, readAs };
  }

  /** 0 exact · 1 terminal component equals the query · 2 boundary match · 3 query occurs inside the name */
  private defNameScore(name: string, q: string): number {
    if (name === q) return 0;
    const base = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
    if (base === q) return 1;
    if (name.endsWith(q) || base.startsWith(q) || base.endsWith(q)) return 2;
    if (name.includes(q)) return 3;
    return 4;
  }

  // ------------------------------------------------- cursors (§7.6) ------------------------------------

  private cursorKey(): Buffer {
    const r = this.db.prepare("select key from cursor_keys where id = 'search'").get() as { key: string } | undefined;
    if (r) return Buffer.from(r.key, "utf8");
    const key = createHmac("sha256", randomUUID()).update(randomUUID()).digest("hex");
    this.db.prepare("insert or ignore into cursor_keys values ('search',?)").run(key);
    return Buffer.from(key, "utf8");
  }

  private encodeCursor(payload: Record<string, string>): string {
    const json = JSON.stringify(payload);
    return `${Buffer.from(json).toString("base64url")}.${createHmac("sha256", this.cursorKey()).update(json).digest("base64url")}`;
  }

  private decodeCursor(cursor: string): { stale?: string; payload?: Record<string, string> } {
    try {
      const at = cursor.lastIndexOf(".");
      if (at < 0) return { stale: "the cursor is malformed" };
      const json = Buffer.from(cursor.slice(0, at), "base64url").toString("utf8");
      const mac = cursor.slice(at + 1);
      const want = createHmac("sha256", this.cursorKey()).update(json).digest("base64url");
      const a = Buffer.from(mac), b = Buffer.from(want);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return { stale: "the cursor does not belong to this server" };
      return { payload: JSON.parse(json) as Record<string, string> };
    } catch { return { stale: "the cursor is malformed" }; }
  }

  private paginate(base: Record<string, string>, ordered: SearchHit[], limit: number, cursor?: string): PageStep {
    let off = 0;
    if (cursor) {
      const d = this.decodeCursor(cursor);
      if (d.stale || !d.payload) return { kind: "stale", message: d.stale ?? "the cursor is malformed" };
      for (const [k, v] of Object.entries(base)) if (d.payload[k] !== v) return { kind: "stale", message: "the query, the snapshot set or the access policy changed since this cursor was issued; run the search again" };
      off = Number(d.payload.off ?? 0);
      if (!Number.isInteger(off) || off < 0 || off >= Math.min(ordered.length, 1_000_000)) return { kind: "stale", message: "the cursor position is not readable any more; run the search again" };
    }
    const hits = ordered.slice(off, off + limit);
    const next = off + limit < ordered.length ? this.encodeCursor({ ...base, off: String(off + limit) }) : undefined;
    return { kind: "page", hits, nextCursor: next };
  }

  // ------------------------------------------------- definitions and references (§7.3) -------------------

  resolveDefinition(ctx: CallContext, req: { repositoryId: string; revision: string; path: string; position: { line: number; column: number } }): { locations: DefinitionLocation[]; tier: "PRECISE" | "RESOLVED" | "HEURISTIC" | "UNRESOLVED"; ambiguous: boolean; basis: string; gaps: string[] } | ApiFail {
    const root = this.rootOf(req.repositoryId);
    if (!root || this.store.isRevoked(root)) return failApi(ctx, "NOT_FOUND", "no such repository");
    if (!this.pathAllowedFor(ctx.actor.principalId, root, req.path)) return failApi(ctx, "NOT_FOUND", "no such location");
    if (!this.isBuilt(req.repositoryId, req.revision)) return failApi(ctx, "NOT_FOUND", "this revision has no search index yet; build it (C07/enqueueIndex)", true);
    const body = this.fileBody(req.repositoryId, req.revision, req.path);
    if (body === null) return failApi(ctx, "NOT_FOUND", `the file is not text-indexed at this revision: ${req.path}`, true);
    const offset = lineColToByte(body, req.position.line, req.position.column);
    if (offset > Buffer.byteLength(body) || req.position.line < 1) {
      return failApi(ctx, "INVALID_SCHEMA", `the position is outside ${req.path} at this revision (${Buffer.byteLength(body)} bytes; D4)`);
    }
    const refRows = (this.db.prepare("select * from symbol_refs where repository_id = ? and revision = ? and path = ? and start_byte <= ? and end_byte > ?").all(req.repositoryId, req.revision, req.path, offset, offset) as any[])
      .sort((a, b) => (resRank(a.resolution) - resRank(b.resolution)) || (a.end_byte - a.start_byte) - (b.end_byte - b.start_byte) || (b.start_byte - a.start_byte));
    if (refRows.length) {
      const best = refRows[0];
      if (best.resolution === "UNRESOLVED" && !best.target_symbol && !best.candidates_json) {
        return { locations: [], tier: "UNRESOLVED", ambiguous: false, basis: best.basis, gaps: [unresolvedWhy(best.ref_kind, best.target_name)] };
      }
      const candidates: string[] = [];
      if (best.target_symbol) candidates.push(best.target_symbol);
      if (best.candidates_json) for (const c of JSON.parse(best.candidates_json) as string[]) if (!candidates.includes(c)) candidates.push(c);
      if (candidates.length > 1) {
        const locs = this.locationsOf(candidates);
        return {
          locations: locs, tier: tierFromBasis(best.basis, best.resolution), ambiguous: true, basis: best.basis,
          gaps: locs.length
            ? [`"${best.target_name}" matches ${candidates.length} definitions at this position; all are listed, none is picked silently`]
            : ["the binding is ambiguous and no candidate resolves within the visible repositories"],
        };
      }
      if (candidates.length === 1) {
        const loc = this.locateTarget(candidates[0]);
        return { locations: loc ? [loc] : [], tier: tierFromBasis(best.basis, best.resolution), ambiguous: false, basis: best.basis, gaps: loc ? [] : ["the bound target is not defined in the visible repositories"] };
      }
      return { locations: [], tier: "UNRESOLVED", ambiguous: false, basis: best.basis, gaps: [unresolvedWhy(best.ref_kind, best.target_name)] };
    }
    // the definition itself?
    const def = this.db.prepare("select * from symbol_defs where repository_id = ? and revision = ? and path = ? and start_byte <= ? and end_byte > ? order by start_byte desc limit 1").get(req.repositoryId, req.revision, req.path, offset, offset) as any;
    if (def) return { locations: [this.locationForDef(def)!], tier: tierFromBasis(def.basis, "RESOLVED"), ambiguous: false, basis: def.basis, gaps: [] };
    // still: the name under the caret gets heuristic *candidates* — never a silent pick
    const word = tokenAt(body, offset);
    if (word) {
      const defs = (this.db.prepare("select * from symbol_defs where repository_id = ? and revision = ? and (name = ? or name = ?) limit 24").all(req.repositoryId, req.revision, word, `${word}`) as any[]);
      const matches = defs.filter((d) => d.name === word || d.name.endsWith(`.${word}`));
      if (matches.length) {
        return {
          locations: matches.map((d) => this.locationForDef(d)!),
          tier: "HEURISTIC", ambiguous: matches.length > 1, basis: "NAME_MATCH",
          gaps: matches.length > 1
            ? [`"${word}" matches ${matches.length} definitions here; the occurrence is not statically bound, so all are listed`]
            : [`"${word}" is not bound at this position; this is a name match, not a resolution (a compiler index would make it precise)`],
        };
      }
    }
    return { locations: [], tier: "UNRESOLVED", ambiguous: false, basis: "", gaps: ["nothing stored resolves this position: no occurrence, no definition, and no name match"] };
  }

  /** The definition of `target` (a symbol id); cross-repository targets are `file:`-style entity ids. */
  private locateTarget(target: string, preferRevision?: string): DefinitionLocation | null {
    const def = preferRevision
      ? this.db.prepare("select * from symbol_defs where symbol_id = ? and revision = ? order by repository_id limit 1").get(target, preferRevision) as any
      : null;
    const row = def ?? (this.db.prepare("select * from symbol_defs where symbol_id = ? order by revision desc limit 1").get(target) as any);
    return row ? this.locationForDef(row) : null;
  }
  private locationsOf(targets: string[]): DefinitionLocation[] {
    const out: DefinitionLocation[] = [];
    for (const t of targets) { const loc = this.locateTarget(t); if (loc) out.push(loc); }
    return out.sort((a, b) => a.repositoryName.localeCompare(b.repositoryName) || a.path.localeCompare(b.path) || a.display.line - b.display.line);
  }

  private locationForDef(def: any): DefinitionLocation | null {
    const body = this.fileBody(def.repository_id, def.revision, def.path);
    const col = byteToLineCol(body ?? "", def.start_byte);
    return {
      repositoryId: def.repository_id, repositoryName: this.displayNameOf(def.repository_id), revision: def.revision,
      symbolId: def.symbol_id, name: def.name, qualified: def.qualified, kind: def.kind, path: def.path,
      span: { sourceId: `file:${def.path}`, contentHash: "", revision: def.revision, startByte: def.start_byte, endByteExclusive: def.end_byte },
      display: { line: col.line, column: col.column, snippet: (body ?? "").split("\n")[col.line - 1] ?? "" },
      tier: tierFromBasis(def.basis, "RESOLVED"), basis: def.basis,
    };
  }

  /**
   * findReferences (§7.3): direct occurrence rows, the worker's resolved call edges, re-export chains
   * to depth 4, and cross-repository references where a unique provider resolves the exported name.
   * Heuristic rows are off by default and offered as a separate group (D6).
   */
  findReferences(ctx: CallContext, req: { repositoryId: string; revision: string; symbolId: string; scope?: RepositorySelector; include?: { heuristic?: boolean; tests?: boolean; generated?: boolean }; cursor?: string; limit?: number }): { references: ReferenceHit[]; nextCursor?: string; groups: { repositoryId: string; repositoryName: string; revision: string; viaPackage?: string; count: number }[]; coverageByRepository: CoverageByRepository[]; unresolvedCallSites: { repositoryId: string; count: number; sampleHitIds: string[] }[]; reExportTruncated: boolean; gaps: string[] } | ApiFail {
    const root = this.rootOf(req.repositoryId);
    if (!root || this.store.isRevoked(root)) return failApi(ctx, "NOT_FOUND", "no such repository");
    const def = this.db.prepare("select * from symbol_defs where repository_id = ? and revision = ? and symbol_id = ?").get(req.repositoryId, req.revision, req.symbolId) as any;
    if (!def) return failApi(ctx, "NOT_FOUND", "that symbol is not defined at this repository and revision (not indexed, or a stale id)");
    const scope = this.resolveScope(ctx, req.scope ?? { kind: "ALL_VISIBLE" });
    if ("failure" in scope) return scope.failure;
    const include = { heuristic: !!req.include?.heuristic, tests: req.include?.tests ?? true, generated: !!req.include?.generated };
    const pathOk = (repositoryId: string, revision: string, path: string): boolean => {
      if (!scope.repositoryIds.includes(repositoryId) || !revision) return false;
      const ro = this.rootOf(repositoryId);
      if (!ro) return false;
      if (!include.generated && !!((this.db.prepare("select b.is_generated as g from tree_entries t join blobs b on b.blob_hash = t.blob_hash where t.repository_id = ? and t.revision = ? and t.path = ?").get(repositoryId, revision, path) as any)?.g)) return false;
      if (isTestPath(path) && !include.tests) return false;
      return this.pathAllowedFor(ctx.actor.principalId, ro, path);
    };

    const all: ReferenceHit[] = [];
    const gaps: string[] = [];

    // ---- direct occurrence rows bound to this symbol ----
    for (const d of this.db.prepare("select * from symbol_refs where repository_id = ? and revision = ? and target_symbol = ?").all(req.repositoryId, req.revision, req.symbolId) as any[]) {
      if (d.ref_kind === "STRING" || d.ref_kind === "DOC") continue; // never merged into the reference list (§7.3.4)
      if (!include.heuristic && (d.basis === "NAME_MATCH" || d.basis === "STRING_MATCH")) continue;
      if (!pathOk(d.repository_id, d.revision, d.path)) continue;
      if (d.ref_kind === "REEXPORT") continue; // handled by the chain walk below
      if (d.resolution === "UNRESOLVED") continue; // rows are counted as gaps, not passed off as references
      const cands: string[] = d.candidates_json ? JSON.parse(d.candidates_json) : [];
      if (cands.length > 1 && !include.heuristic) continue; // ambiguous binding: disclosed only on request
      all.push(this.refHit(d.repository_id, d.revision, d.path, d.start_byte, d.end_byte, d.ref_kind, d.resolution, d.basis, req.symbolId, def.name, d.target_name, cands, d.ref_id, null, null));
    }

    // ---- the worker's resolved call edges to this symbol (source of truth for calls) ----
    const entities = this.store.entities(req.revision);
    for (const r of this.store.allRelationships(req.revision)) {
      if (r.kind !== "calls" || r.to !== req.symbolId) continue;
      const file = this.relationshipFile(req.revision, r.id) ?? fileOfEntity(r.from, entities);
      for (const ev of r.evidence) {
        const span = (ev.location as any)?.span as SourceSpan | undefined;
        if (!span || !file || !pathOk(req.repositoryId, req.revision, file)) continue;
        if (file === def.path && span.startByte === def.start_byte) continue; // the definition is not its own caller
        const body = this.fileBody(req.repositoryId, req.revision, file);
        const written = body ? writtenAt(Buffer.from(body, "utf8"), span.startByte, span.endByteExclusive) : def.name;
        all.push(this.refHit(req.repositoryId, req.revision, file, span.startByte, span.endByteExclusive, "CALL", "RESOLVED", "IMPORT_GRAPH", req.symbolId, def.name, written, [], `rel:${r.id}:${span.startByte}`, null, null));
      }
    }

    // ---- re-export chains (F01-D5)? only TS/JS re-export statements are stored today ----
    let truncated = false;
    if (this.db.prepare("select 1 from symbol_refs where repository_id = ? and revision = ? and ref_kind = 'REEXPORT' and target_symbol = ?").get(req.repositoryId, req.revision, `file:${def.path}`) || (def.exported && this.db.prepare("select 1 from symbol_refs where repository_id = ? and revision = ? and ref_kind = 'REEXPORT' and target_name = ?").get(req.repositoryId, req.revision, defNameBase(def.name)))) {
      const chain = this.reexportChain(req.repositoryId, req.revision, def.path, def.name);
      truncated = chain.depthCapped;
      gaps.push(...chain.gaps);
      for (const hop of chain.rows) {
        if (!pathOk(hop.repository_id, hop.revision, hop.path)) continue;
        all.push(this.refHitForReexport(hop, req.symbolId, def.name));
        for (const u of this.db.prepare("select * from symbol_refs where repository_id = ? and revision = ? and path = ? and target_symbol is not null and target_name = ? and ref_kind in ('CALL','READ')").all(hop.repository_id, hop.revision, hop.path, hop.exportedName) as any[]) {
          if (!include.heuristic && u.basis !== "IMPORT_GRAPH") continue;
          if (!pathOk(u.repository_id, u.revision, u.path)) continue;
          all.push(this.refHit(u.repository_id, u.revision, u.path, u.start_byte, u.end_byte, u.ref_kind, u.resolution, u.basis, req.symbolId, def.name, u.target_name, [], u.ref_id, hop.exportedName, `via re-export in ${hop.path}`));
        }
      }
    }

    // ---- cross-repository references through package identity (F01-A5) ----
    // A consumer becomes a *reference* only when every gate holds: the consumer is visible, it requires the
    // package, the provider is unique, and the provider exports exactly that name. Anything weaker — an
    // ambiguous provider, or a consumer whose binding could not be bound or cannot be seen — is a counted
    // gap with the row ids for a drill-down, never merged into the reference list (§7.3.5).
    const gapSitesByRepo = new Map<string, { refId: string; resolved?: boolean }[]>();
    const addGap = (repositoryId: string, refId: string, resolved?: boolean) => {
      const list = gapSitesByRepo.get(repositoryId) ?? []; list.push({ refId, resolved }); gapSitesByRepo.set(repositoryId, list);
    };
    const exportedNames = new Set<string>([
      ...(this.db.prepare("select exported_name from package_exports where repository_id = ? and revision = ? and symbol_id = ?").all(req.repositoryId, req.revision, req.symbolId) as { exported_name: string }[]).map((x) => x.exported_name),
      defNameBase(def.name),
    ]);
    if (def.name.includes(".")) exportedNames.delete(def.name); // a qualified name is not itself an export surface
    exportedNames.delete(",");

    // Consumers bound to the provider by a manifest edge:
    for (const edge of this.db.prepare("select * from cross_repo_edges where to_repository = ? and to_revision = ?").all(req.repositoryId, req.revision) as any[]) {
      if (!scope.repositoryIds.includes(edge.from_repository)) continue; // an invisible consumer contributes nothing (A3)
      if (!this.isBuilt(edge.from_repository, edge.from_revision)) continue;
      // the consumer must actually require the package (manifest or code import) for the binding to be justified
      const requiresIt = this.db.prepare("select 1 as x from package_requires where repository_id = ? and revision = ? and ecosystem = ? and package_name = ? limit 1").get(edge.from_repository, edge.from_revision, edge.via_ecosystem, edge.via_package);
      if (!requiresIt) continue;
      const unresolved = this.db.prepare("select * from symbol_refs where repository_id = ? and revision = ? and ref_kind = 'CALL'").all(edge.from_repository, edge.from_revision) as any[];
      for (const u of unresolved) {
        if (u.resolution === "RESOLVED") continue; // already bound inside the consumer; not a gap, not re-bound across the edge
        const id = finalIdentifier(u.target_name);
        if (!exportedNames.has(id)) continue;
        if (!this.pathAllowedFor(ctx.actor.principalId, this.rootOf(edge.from_repository), u.path)) continue;
        const uniquelyExports = !edge.ambiguous && !!this.db.prepare("select 1 as ok from package_exports where repository_id = ? and revision = ? and ecosystem = ? and package_name = ? and exported_name = ? and symbol_id = ?").get(edge.to_repository, edge.to_revision, edge.via_ecosystem, edge.via_package, id, req.symbolId);
        if (uniquelyExports) {
          all.push(this.refHit(edge.from_repository, edge.from_revision, u.path, u.start_byte, u.end_byte, "CALL", "RESOLVED", "IMPORT_GRAPH", req.symbolId, def.name, u.target_name, [], u.ref_id, edge.via_package, `via package ${edge.via_package} (${edge.via_ecosystem})`));
        } else {
          addGap(edge.from_repository, `hit:${sha16(u.ref_id)}`, false);
        }
      }
      if (edge.version_mismatch) gaps.push(`the provider of ${String(edge.via_package)} is indexed at a version outside a required range (${String(edge.version_mismatch)}); a cross-repository hit may be of a different version than the consumer required`);
    }
    // Consumers whose *unresolved* call sites match the exported name but have no visible edge at all
    // (the provider exists but is not visible to this caller, or is not indexed): counted, not named (A3).
    for (const p of scope.repositoryIds) {
      if (p === req.repositoryId) continue;
      const head = this.latestBuiltRevision(p);
      if (!head) continue;
      const root = this.rootOf(p);
      for (const u of this.db.prepare("select * from symbol_refs where repository_id = ? and revision = ? and ref_kind = 'CALL' and resolution = 'UNRESOLVED'").all(p, head) as any[]) {
        if (gapSitesByRepo.get(p)?.some((g) => g.refId === `hit:${sha16(u.ref_id)}`)) continue; // already counted through the edge branch
        const id = finalIdentifier(u.target_name);
        if (!exportedNames.has(id)) continue;
        if (!root || !this.pathAllowedFor(ctx.actor.principalId, root, u.path)) continue;
        addGap(p, `hit:${sha16(u.ref_id)}`, false);
      }
    }
    const unresolvedCallSites = [...gapSitesByRepo].map(([repositoryId, list]) => ({ repositoryId, count: list.length, sampleHitIds: list.slice(0, 3).map((g) => g.refId) }));

    // ---- merge (same span, strongest basis wins) and order (§7.4) ----
    const byKey = new Map<string, ReferenceHit>();
    for (const r of all) {
      const key = `${r.repositoryId}|${r.revision}|${r.path}|${r.span.startByte}|${r.refKind}`;
      const prior = byKey.get(key);
      if (!prior || TIER_RANK[r.tier] < TIER_RANK[prior.tier]) byKey.set(key, r);
    }
    const ordered = [...byKey.values()].sort((a, b) => {
      const home = (x: ReferenceHit) => (x.repositoryId === req.repositoryId ? 0 : x.viaPackage ? 1 : 2);
      if (home(a) !== home(b)) return home(a) - home(b);
      if (a.tier !== b.tier) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
      if (REFKIND_RANK[a.refKind] !== REFKIND_RANK[b.refKind]) return REFKIND_RANK[a.refKind] - REFKIND_RANK[b.refKind];
      return a.repositoryId.localeCompare(b.repositoryId) || a.path.localeCompare(b.path) || a.span.startByte - b.span.startByte || a.hitId.localeCompare(b.hitId);
    });

    const limit = Math.max(1, Math.min(Math.floor(req.limit ?? DEFAULT_HITS_PAGE), MAX_HITS_PAGE));
    // The cursor is bound to the revisions that actually contribute rows, so a rebuild that drops a
    // reference invalidates open pages (D1); the access policy is bound over the whole scope.
    const contribRevIds = [...new Set(ordered.map((r) => `${r.repositoryId}@${r.revision}`))].sort();
    const cursorBase = { v: "1", q: sha16(`${req.symbolId}|${req.revision}`), snap: sha16(JSON.stringify(contribRevIds)), authz: this.policyHashOf(ctx, scope.repositoryIds) };
    const page = this.paginate(cursorBase, ordered as unknown as SearchHit[], limit, req.cursor);
    if (page.kind === "stale") {
      const f = failApi(ctx, "STALE_REVISION", page.message, true);
      // §8.3: the refusal names the CURRENT snapshot set so the caller can re-run without guessing
      f.metadata.warnings.push(`current snapshot: ${snapshotWarnings([...new Set(ordered.map((r) => ({ repositoryId: r.repositoryId, revision: r.revision })))], (rid, rv) => this.generationOf(rid, rv ?? "")).join(", ")}`);
      return f;
    }
    const references = page.hits as unknown as ReferenceHit[];

    const groupOf = new Map<string, { repositoryId: string; repositoryName: string; revision: string; viaPackage?: string; count: number }>();
    for (const r of references) {
      const g = groupOf.get(r.repositoryId) ?? { repositoryId: r.repositoryId, repositoryName: this.displayNameOf(r.repositoryId), revision: r.revision, viaPackage: r.viaPackage, count: 0 };
      g.viaPackage = r.viaPackage; g.count++; groupOf.set(r.repositoryId, g);
    }
    const coveragePairs = contribRevIds.map((x) => { const i = x.lastIndexOf("@"); return { repositoryId: x.slice(0, i), revision: x.slice(i + 1) }; });
    return {
      references,
      nextCursor: page.nextCursor,
      groups: [...groupOf.values()],
      coverageByRepository: this.coverageFor(ctx.actor.principalId, coveragePairs, "NONE", new Map()),
      unresolvedCallSites,
      reExportTruncated: truncated,
      gaps,
    };
  }

  private reexportChain(repositoryId: string, revision: string, defPath: string, defName: string): { rows: { repository_id: string; revision: string; path: string; start_byte: number; end_byte: number; ref_id: string; exportedName: string }[]; depthCapped: boolean; gaps: string[] } {
    const rows: { repository_id: string; revision: string; path: string; start_byte: number; end_byte: number; ref_id: string; exportedName: string }[] = [];
    const gaps: string[] = [];
    let frontier: { file: string; name: string; depth: number }[] = [{ file: defPath, name: defNameBase(defName), depth: 0 }];
    const seenFiles = new Set<string>([defPath]);
    let depthCapped = false;
    while (frontier.length) {
      const next: { file: string; name: string; depth: number }[] = [];
      for (const node of frontier) {
        for (const rx of this.db.prepare("select * from symbol_refs where repository_id = ? and revision = ? and ref_kind = 'REEXPORT' and target_symbol = ? and (target_name = ? or target_name = '*')").all(repositoryId, revision, `file:${node.file}`, node.name) as any[]) {
          const spec = rx.candidates_json ? JSON.parse(rx.candidates_json)[0] : "";
          if (!spec || seenFiles.has(rx.path)) continue;
          seenFiles.add(rx.path);
          const exported = rx.target_name === "*" ? node.name : rx.target_name;
          rows.push({ repository_id: rx.repository_id, revision: rx.revision, path: rx.path, start_byte: rx.start_byte, end_byte: rx.end_byte, ref_id: rx.ref_id, exportedName: exported });
          if (node.depth + 1 >= REEXPORT_DEPTH) { depthCapped = true; continue; }
          next.push({ file: rx.path, name: exported, depth: node.depth + 1 });
        }
      }
      if (depthCapped) gaps.push(`re-export chains were checked up to depth ${REEXPORT_DEPTH}; deeper barrel files were cut (F01-D5)`);
      frontier = next;
    }
    return { rows, depthCapped, gaps: [...new Set(gaps)] };
  }

  private refHitForReexport(hop: { repository_id: string; revision: string; path: string; start_byte: number; end_byte: number; ref_id: string; exportedName: string }, symbolId: string, defName: string): ReferenceHit {
    const hit = this.refHit(hop.repository_id, hop.revision, hop.path, hop.start_byte, hop.end_byte, "IMPORT", "RESOLVED", "IMPORT_GRAPH", symbolId, defName, "", [], hop.ref_id, null, null);
    hit.rationale = ["re-export of the symbol's surface"];
    return hit;
  }

  private refHit(repositoryId: string, revision: string, path: string, startByte: number, endByte: number, refKind: string, resolution: string, basis: string, symbolId: string, name: string, written: string, candidates: string[], refId: string, viaPackage: string | null, viaReason: string | null): ReferenceHit {
    const body = this.fileBody(repositoryId, revision, path) ?? "";
    const from = byteToLineCol(body, startByte);
    const to = byteToLineCol(body, Math.max(startByte, endByte - 1));
    const snip = snippetLines(body, startByte, endByte);
    const evId = `ev:ref:${sha16(`${repositoryId}|${revision}|${path}|${startByte}|${endByte}|${refKind}`)}`;
    const blobHash = (this.db.prepare("select blob_hash from tree_entries where repository_id = ? and revision = ? and path = ?").get(repositoryId, revision, path) as { blob_hash: string } | undefined)?.blob_hash ?? "";
    this.store.putEvidence(revision, {
      id: evId, sourceId: `file:${path}`,
      location: { kind: "CodeLocation", span: { sourceId: `file:${path}`, contentHash: blobHash, revision, startByte, endByteExclusive: endByte } },
      class: "STATIC_PARSED", observedAt: new Date().toISOString(), accessScopeId: "tenant", state: "CURRENT",
    });
    const tier = tierFromBasis(basis, resolution);
    const reference: ReferenceHit = {
      hitId: `hit:${sha16(refId)}`,
      repositoryId, repositoryName: this.displayNameOf(repositoryId), revision, path,
      span: { sourceId: `file:${path}`, contentHash: blobHash, revision, startByte, endByteExclusive: endByte },
      display: { line: from.line, column: from.column, endLine: to.line, endColumn: to.column, snippet: snip.lines, snippetStartLine: snip.startLine },
      matchKinds: refKind === "CALL" || refKind === "IMPORT" || refKind === "EXPORT" ? ["SYMBOL_EXACT"] : ["TEXT_LITERAL"],
      tier, inString: false,
      symbol: { symbolId, name, kind: refKind.toLowerCase() },
      rationale: [basisWord(basis, resolution), ...(viaReason ? [viaReason!] : []), ...(tier === "HEURISTIC" ? ["this is a name match, not a compiler resolution"] : [])],
      evidenceIds: [evId],
      refKind, basis,
    };
    if (candidates && candidates.length > 1) reference.candidates = candidates.map((c) => ({ symbolId: c, name: written, path }));
    if (viaPackage) reference.viaPackage = viaPackage;
    return reference;
  }

  // ------------------------------------------------- scope helpers --------------------------------------

  private outOfTime(ctx: CallContext): boolean { return ctx.deadlineMs < Date.now(); }

  private resolveScope(ctx: CallContext, selector: RepositorySelector | undefined): { repositoryIds: string[]; names: Map<string, string>; notIndexed: { repositoryId: string; repositoryName: string; reason: string }[] } | { failure: ApiFail } {
    const visible = this.visibleRepositories(ctx.actor.principalId);
    const byId = new Map(visible.map((v) => [v.repositoryId, v] as [string, typeof v]));
    const names = new Map(byId ? [...byId.values()].map((v) => [v.repositoryId, v.displayName] as [string, string]) : []);
    const noRepo = failApi(ctx, "NOT_FOUND", "no visible repository matches the requested scope");
    if (!selector || selector.kind === "ALL_VISIBLE") return { repositoryIds: visible.map((v) => v.repositoryId), names, notIndexed: [] };
    if (selector.kind === "IDS") {
      const wanted = Array.isArray(selector.repositoryIds) ? selector.repositoryIds.filter((s) => typeof s === "string") : [];
      if (!wanted.length) return { failure: failApi(ctx, "INVALID_SCHEMA", "the IDS selector needs at least one repository id") };
      const okIds = wanted.filter((id) => byId.has(id));
      if (!okIds.length) return { failure: noRepo }; // nothing the caller could see — indistinguishable from "does not exist"
      const rest = wanted.length - okIds.length;
      return { repositoryIds: okIds, names, notIndexed: rest ? [{ repositoryId: "", repositoryName: "", reason: `${rest} of the requested repositories resolve to nothing this caller may know about; they are counted, never named` }] : [] };
    }
    if (selector.kind === "DEPENDENTS_OF") {
      if (!byId.has(selector.repositoryId)) return { failure: noRepo };
      const graph = new Map<string, Set<string>>();
      for (const e of this.db.prepare("select from_repository, to_repository from cross_repo_edges").all() as any[]) {
        const s = graph.get(e.to_repository) ?? new Set<string>(); s.add(e.from_repository); graph.set(e.to_repository, s);
      }
      const direct = new Set<string>(); const queue = [selector.repositoryId];
      while (queue.length) {
        const cur = queue.pop()!;
        for (const d of graph.get(cur) ?? []) if (!direct.has(d)) { direct.add(d); if (selector.transitive) queue.push(d); }
      }
      const ids = [...new Set([selector.repositoryId, ...direct])].filter((id) => byId.has(id));
      return { repositoryIds: ids, names, notIndexed: [] };
    }
    return { failure: failApi(ctx, "INVALID_SCHEMA", "unknown repository selector") };
  }

  private selectRevisions(ctx: CallContext, scope: { repositoryIds: string[]; names?: Map<string, string> }, selector: SearchRequest["revision"]): { pairs: { repositoryId: string; revision: string | null; name?: string }[]; policyHash: string; snapshotHash: string } | { failure: ApiFail } {
    const pairs: { repositoryId: string; revision: string | null; name?: string }[] = [];
    const latestOf = (rid: string): string | null => {
      const root = this.rootOf(rid);
      if (root === null) return null;
      return this.store.latestRevision(root)?.id ?? null;
    };
    for (const rid of scope.repositoryIds) {
      pairs.push({ repositoryId: rid, revision: latestOf(rid), name: scope.names?.get(rid) });
    }
    if (selector?.kind === "REVISION") {
      const r = this.store.revision(selector.revisionId);
      const repo = r ? this.repositoryOfRoot(r.repoRoot) : null;
      if (!r || !repo) return { failure: failApi(ctx, "NOT_FOUND", "that revision is not indexed (or is no longer visible); the search cannot answer from a different revision", true) };
      return { pairs: [{ repositoryId: repo.repositoryId, revision: r.id, name: scope.names?.get(repo.repositoryId) ?? repo.displayName }], policyHash: this.policyHashOf(ctx, [repo.repositoryId]), snapshotHash: this.snapshotHashOf([{ repositoryId: repo.repositoryId, revision: r.id }]) };
    }
    if (selector?.kind === "COMMIT") {
      const root = this.rootOf(selector.repositoryId);
      const hit = root ? this.store.revisionsOf(root).find((r) => r.gitHead === selector.commitHash) : null;
      if (!hit) return { failure: failApi(ctx, "NOT_FOUND", "no indexed revision of that repository has that commit as its head; index the branch first", true) };
      return { pairs: [{ repositoryId: selector.repositoryId, revision: hit.id, name: scope.names?.get(selector.repositoryId) }], policyHash: this.policyHashOf(ctx, [selector.repositoryId]), snapshotHash: this.snapshotHashOf([{ repositoryId: selector.repositoryId, revision: hit.id }]) };
    }
    if (ctx.expectedRevision) {
      const er = this.store.revision(ctx.expectedRevision);
      if (!er) return { failure: failApi(ctx, "STALE_REVISION", "the revision the caller expected is not indexed any more; re-index and try again", true) };
      const repo = this.repositoryOfRoot(er.repoRoot) ?? { repositoryId: this.repositoryIdForPath(er.repoRoot), displayName: "", root: er.repoRoot };
      const pairsPinned = scope.repositoryIds.includes(repo.repositoryId)
        ? pairs.map((p) => (p.repositoryId === repo.repositoryId ? { ...p, revision: er.id } : p))
        : [...pairs, { repositoryId: repo.repositoryId, revision: er.id, name: repo.displayName }];
      return { pairs: pairsPinned, policyHash: this.policyHashOf(ctx, pairsPinned.map((p) => p.repositoryId)), snapshotHash: this.snapshotHashOf(pairsPinned) };
    }
    return { pairs, policyHash: this.policyHashOf(ctx, scope.repositoryIds), snapshotHash: this.snapshotHashOf(pairs) };
  }

  private policyHashOf(ctx: CallContext, repositoryIds: string[]): string {
    const parts: string[] = [];
    for (const rid of repositoryIds) {
      const root = this.rootOf(rid) ?? "";
      const person = this.db.prepare("select allowed, denied from collab_access where principal = ? and repo_root = ?").get(ctx.actor.principalId, root) as { denied: string } | undefined;
      parts.push(sha16(JSON.stringify([this.store.deniedPrefixes(root), person?.denied ?? "", rid])));
    }
    return sha16(JSON.stringify(parts));
  }
  private snapshotHashOf(pairs: { repositoryId: string; revision: string | null }[]): string {
    return sha16(JSON.stringify(pairs.map((p) => `${p.repositoryId}@${p.revision ?? ""}@${this.generationOf(p.repositoryId, p.revision ?? "")}`)));
  }

  generationOf(repositoryId: string, revision: string): number {
    return Number((this.db.prepare("select index_generation from repo_revision_state where repository_id = ? and revision = ?").get(repositoryId, revision) as any)?.index_generation ?? 0);
  }

  isBuilt(repositoryId: string, revision: string): boolean {
    return !!this.db.prepare("select 1 from repo_revision_state where repository_id = ? and revision = ?").get(repositoryId, revision);
  }

  /** The newest revision of a repository that has a published search index (query-time "head"). */
  latestBuiltRevision(repositoryId: string): string | null {
    const r = this.db.prepare("select revision from repo_revision_state where repository_id = ? order by index_generation desc limit 1").get(repositoryId) as { revision: string } | undefined;
    return r?.revision ?? null;
  }

  // ------------------------------------------------- listings for the gateway ----------------------------

  listRepositories(ctx: CallContext, includeCoverage = false): RepositoryView[] {
    const out: RepositoryView[] = [];
    for (const v of this.visibleRepositories(ctx.actor.principalId)) {
      const latest = this.store.latestRevision(v.root);
      const st = latest ? (this.db.prepare("select * from repo_revision_state where repository_id = ? and revision = ?").get(v.repositoryId, latest.id) as any) : null;
      const built = !!st;
      const view: RepositoryView = {
        repositoryId: v.repositoryId, displayName: v.displayName, root: v.root,
        remoteUrl: (this.db.prepare("select remote_url from repositories where repository_id = ?").get(v.repositoryId) as any)?.remote_url ?? null,
        state: "ACTIVE", visibleToCaller: true,
        revision: latest ? {
          id: latest.id, gitHead: latest.gitHead,
          textState: (built ? st.text_state : "NONE") as SearchIndexState, symbolState: (built ? st.symbol_state : "NONE") as SearchIndexState,
          indexedAt: latest.createdAt,
          files: { total: latest.fileCount, indexed: built ? Number(st.files_indexed) : 0 },
        } : undefined,
      };
      if (includeCoverage) {
        const r = latest ? this.unresolvedPackageEdgesFor(ctx.actor.principalId, v.repositoryId, latest.id) : { edges: [], invisible: 0 };
        view.unresolvedPackageEdges = r.edges.length + r.invisible;
      }
      out.push(view);
    }
    return out;
  }

  indexStatus(ctx: CallContext, req: { repositoryId?: string; repoRoot?: string; revision?: string }): RepositoryIndexStatus | ApiFail {
    if (!req || typeof req !== "object") return failApi(ctx, "INVALID_SCHEMA", "a repositoryId or repoRoot is required");
    const repoId = req.repositoryId ?? this.repositoryOfRoot(String(req.repoRoot ?? ""))?.repositoryId
      ?? (req.repoRoot && this.store.latestRevision(String(req.repoRoot)) ? this.repositoryIdForPath(String(req.repoRoot)) : "");
    if (!repoId) return failApi(ctx, "INVALID_SCHEMA", "a repositoryId or repoRoot is required");
    const root = this.rootOf(repoId);
    if (!root || this.store.isRevoked(root)) return failApi(ctx, "NOT_FOUND", "no such repository");
    const revision = req.revision ?? this.store.latestRevision(root)?.id;
    if (!revision) return failApi(ctx, "NOT_FOUND", "this repository is not indexed at all", true);
    const st = this.db.prepare("select * from repo_revision_state where repository_id = ? and revision = ?").get(repoId, revision) as any;
    if (!st) return failApi(ctx, "NOT_FOUND", "this revision has no search index yet; build it with C07/enqueueIndex", true);
    return {
      repositoryId: repoId, revision, commitHash: st.commit_hash, contentRootHash: st.content_root_hash,
      indexGeneration: st.index_generation, analyzerVersion: st.analyzer_version,
      textState: st.text_state, symbolState: st.symbol_state, semanticTier: st.semantic_tier,
      filesTotal: st.files_total, filesIndexed: st.files_indexed,
      skipped: cleanSkips(JSON.parse(st.skipped_json)), indexedAt: st.indexed_at,
    };
  }

  /**
   * Purge everything a repository's search index holds (called when a source is revoked or deleted,
   * §11): tree rows, revision states, symbols, packages and edges leave transactionally; blobs whose
   * content another repository still references are kept (they are content, not that repository).
   */
  purgeRepository(repositoryId: string) {
    this.store.tx(() => {
      for (const t of this.db.prepare("select blob_hash as h from tree_entries where repository_id = ?").all(repositoryId) as { h: string }[]) {
        if ((this.db.prepare("select count(*) as n from tree_entries where blob_hash = ? and repository_id <> ?").get(t.h, repositoryId) as { n: number }).n > 0) continue;
        const map = this.db.prepare("select rowid as rid from blob_text_map where blob_hash = ?").get(t.h) as { rid: number } | undefined;
        if (map) this.db.prepare("delete from blob_text where rowid = ?").run(map.rid);
        this.db.prepare("delete from blob_text_map where blob_hash = ?").run(t.h);
        this.db.prepare("delete from blob_data where blob_hash = ?").run(t.h);
        this.db.prepare("delete from blobs where blob_hash = ?").run(t.h);
      }
      for (const t of ["tree_entries", "repo_revision_state", "symbol_defs", "symbol_refs", "package_provides", "package_requires", "package_exports"] as const) {
        this.db.prepare(`delete from ${t} where repository_id = ?`).run(repositoryId);
      }
      this.db.prepare("delete from cross_repo_edges where from_repository = ? or to_repository = ?").run(repositoryId, repositoryId);
      // the registry row leaves too: a revoked repository is not a listed name anymore (a re-granted
      // source re-registers on its next build)
      this.db.prepare("delete from repositories where repository_id = ?").run(repositoryId);
    });
  }
}