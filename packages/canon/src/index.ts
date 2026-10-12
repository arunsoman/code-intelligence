// pf-canon-v1 (Prompt-to-feature §29): a narrow, cross-runtime identity protocol. It is NOT the `canonicalJson` in
// execution.ts (that one sorts with localeCompare, accepts floats and has no domain separation); existing F07 bindings
// keep their own identity and are never relabelled (§29.3: a protocol change creates new identities).
//
// Layers:
//   parseStrictJson  text/bytes -> Canon value; rejects what JSON.parse hides (duplicate keys, lone surrogates, -0,
//                    floats, exponents, unsafe integers, invalid UTF-8).
//   canonicalize     Canon value -> canonical bytes (sorted ASCII keys, lowercase \u00xx control escapes, no whitespace).
//   canonHash        domain-separated SHA-256 over a schema's explicit identity projection.
//   rawHash          SHA-256 of exact bytes (code files are never canonicalised).
//   contentRoot      canonical hash of a sorted tracked-entry manifest (§29.2).
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export const PROTOCOL = "pf-canon-v1";

export type Canon = null | boolean | string | number | Canon[] | { [k: string]: Canon } | CanonSet;

/** A schema-designated set: serialised sorted by canonical element bytes; duplicates are rejected, never merged. */
export class CanonSet { readonly items: readonly Canon[]; constructor(items: readonly Canon[]) { this.items = items; } }
export const asSet = (items: readonly Canon[]): CanonSet => new CanonSet(items);

export class CanonError extends Error {
  readonly code: "UNSUPPORTED_VALUE" | "UNSAFE_NUMBER" | "NEGATIVE_ZERO" | "BAD_STRING" | "BAD_KEY" | "DUPLICATE_KEY" | "DUPLICATE_SET_ELEMENT" | "BAD_UTF8" | "BAD_JSON" | "BAD_SCHEMA" | "BAD_DECIMAL" | "BAD_PATH" | "BAD_EXCLUSION";
  constructor(code: CanonError["code"], message: string) { super(message); this.name = "CanonError"; this.code = code; }
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_DEPTH = 128;

// ------------------------------------------------------------------------------------------------ strings

/** True when the string holds no unpaired UTF-16 surrogate. */
export function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const d = s.charCodeAt(i + 1); if (!(d >= 0xdc00 && d <= 0xdfff)) return false; i++; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function quote(s: string): string {
  if (!wellFormed(s)) throw new CanonError("BAD_STRING", "string contains an unpaired surrogate");
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c < 0x20) out += "\\u00" + (c < 16 ? "0" : "") + c.toString(16);
    else out += s[i];
  }
  return out + '"';
}

const isAscii = (s: string): boolean => { for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false; return true; };

// ------------------------------------------------------------------------------------------------ canonical bytes

/** The canonical serialisation of a validated value. Throws on anything outside the protocol's value space. */
export function canonicalize(value: Canon, depth = 0): string {
  if (depth > MAX_DEPTH) throw new CanonError("UNSUPPORTED_VALUE", "value is nested too deeply");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "string": return quote(value);
    case "number":
      if (Object.is(value, -0)) throw new CanonError("NEGATIVE_ZERO", "negative zero is not allowed");
      if (!Number.isSafeInteger(value)) throw new CanonError("UNSAFE_NUMBER", "only safe integers are allowed; use a canonical decimal string");
      return String(value);
    case "object": break;
    default: throw new CanonError("UNSUPPORTED_VALUE", `unsupported value of type ${typeof value}`);
  }
  if (value instanceof CanonSet) {
    const parts = value.items.map((e) => canonicalize(e, depth + 1));
    const sorted = [...parts].sort(compareBytes);
    for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) throw new CanonError("DUPLICATE_SET_ELEMENT", "a set holds the same canonical element twice");
    return "[" + sorted.join(",") + "]";
  }
  if (Array.isArray(value)) return "[" + value.map((e) => canonicalize(e, depth + 1)).join(",") + "]";
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new CanonError("UNSUPPORTED_VALUE", "only plain objects are allowed");
  const keys = Object.keys(value);
  for (const k of keys) {
    if (!isAscii(k) || k.length === 0) throw new CanonError("BAD_KEY", `object keys are non-empty ASCII schema field names: ${JSON.stringify(k)}`);
    if ((value as Record<string, unknown>)[k] === undefined) throw new CanonError("UNSUPPORTED_VALUE", `field ${k} is undefined; omit it instead`);
  }
  keys.sort();
  return "{" + keys.map((k) => quote(k) + ":" + canonicalize((value as Record<string, Canon>)[k], depth + 1)).join(",") + "}";
}

/** Byte order of the UTF-8 encoding (JS string comparison is UTF-16 code-unit order, which differs above U+FFFF). */
export function compareBytes(a: string, b: string): number { return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")); }

// ------------------------------------------------------------------------------------------------ schemas and hashing

export interface CanonSchema<T> {
  readonly name: string;
  readonly version: string;
  /** The explicit identity projection: only fields returned here influence identity (§29.1 step 2). */
  readonly project: (payload: T) => Canon;
}
export function defineSchema<T>(name: string, version: string, project: (payload: T) => Canon): CanonSchema<T> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new CanonError("BAD_SCHEMA", "schema names are 1-128 characters of [A-Za-z0-9._-]");
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(version)) throw new CanonError("BAD_SCHEMA", "schema versions are 1-32 characters of [A-Za-z0-9._-]");
  return { name, version, project };
}

const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

/** Digest over: protocol, NUL, schema, NUL, version, NUL, canonical payload. */
export function canonDigest(schemaName: string, schemaVersion: string, canonicalPayload: string): string {
  return sha(Buffer.concat([Buffer.from(PROTOCOL, "utf8"), Buffer.from([0]), Buffer.from(schemaName, "utf8"), Buffer.from([0]), Buffer.from(schemaVersion, "utf8"), Buffer.from([0]), Buffer.from(canonicalPayload, "utf8")]));
}

/** `pf-canon-v1/<schema>@<version>:<hex>` — the stored form, so an identity names its protocol and schema. */
export function canonHash<T>(schema: CanonSchema<T>, payload: T): string {
  return `${PROTOCOL}/${schema.name}@${schema.version}:${canonDigest(schema.name, schema.version, canonicalize(schema.project(payload)))}`;
}

export const rawHash = (bytes: string | Buffer): string => sha(bytes);

// ------------------------------------------------------------------------------------------------ decimals

/** Schema-boundary normalisation of a decimal input to the canonical decimal grammar (no plus, no exponent, `0` for zero). */
export function canonDecimal(input: string): string {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(input);
  if (!m) throw new CanonError("BAD_DECIMAL", `not a decimal: ${JSON.stringify(input)}`);
  const int = m[2].replace(/^0+(?=\d)/, "");
  const frac = (m[3] ?? "").replace(/0+$/, "");
  const zero = /^0*$/.test(int) && frac === "";
  return (zero || m[1] !== "-" ? "" : "-") + int + (frac ? "." + frac : "");
}
export function canonInteger(input: string): string {
  if (!/^[+-]?\d+$/.test(input)) throw new CanonError("BAD_DECIMAL", `not an integer: ${JSON.stringify(input)}`);
  return canonDecimal(input);
}

// ------------------------------------------------------------------------------------------------ strict JSON ingress

/** Parse JSON into the Canon value space, rejecting what `JSON.parse` silently accepts. Bytes are validated as UTF-8. */
export function parseStrictJson(input: string | Uint8Array): Canon {
  let text: string;
  if (typeof input === "string") text = input;
  else { try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input); } catch { throw new CanonError("BAD_UTF8", "input is not valid UTF-8"); } }
  if (!wellFormed(text)) throw new CanonError("BAD_STRING", "input contains an unpaired surrogate");
  let i = 0;
  const fail = (msg: string): never => { throw new CanonError("BAD_JSON", `${msg} at offset ${i}`); };
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
  const value = (depth: number): Canon => {
    if (depth > MAX_DEPTH) fail("nested too deeply");
    ws();
    const c = text[i];
    if (c === "{") {
      i++; const o: { [k: string]: Canon } = Object.create(null); const seen = new Set<string>(); ws();
      if (text[i] === "}") { i++; return o; }
      for (;;) {
        ws(); if (text[i] !== '"') fail("expected a key");
        const k = str(); if (seen.has(k)) throw new CanonError("DUPLICATE_KEY", `duplicate key ${JSON.stringify(k)}`);
        seen.add(k); ws(); if (text[i++] !== ":") fail("expected ':'");
        o[k] = value(depth + 1); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return o; }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++; const a: Canon[] = []; ws();
      if (text[i] === "]") { i++; return a; }
      for (;;) { a.push(value(depth + 1)); ws(); if (text[i] === ",") { i++; continue; } if (text[i] === "]") { i++; return a; } fail("expected ',' or ']'"); }
    }
    if (c === '"') return str();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) return fail("unexpected token");
    if (m[2] || m[3]) throw new CanonError("UNSAFE_NUMBER", "floating-point and exponent numbers are not allowed; use a canonical decimal string");
    if (m[0] === "-0") throw new CanonError("NEGATIVE_ZERO", "negative zero is not allowed");
    const n = Number(m[0]);
    if (!Number.isSafeInteger(n) || Math.abs(n) > MAX_SAFE) throw new CanonError("UNSAFE_NUMBER", "integer outside the safe range");
    i += m[0].length; return n;
  };
  const str = (): string => {
    i++; let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const c = text[i++];
      if (c === '"') break;
      if (c.charCodeAt(0) < 0x20) fail("raw control character in string");
      if (c !== "\\") { out += c; continue; }
      const e = text[i++];
      switch (e) {
        case '"': out += '"'; break; case "\\": out += "\\"; break; case "/": out += "/"; break;
        case "b": out += "\b"; break; case "f": out += "\f"; break; case "n": out += "\n"; break; case "r": out += "\r"; break; case "t": out += "\t"; break;
        case "u": { const h = text.slice(i, i + 4); if (!/^[0-9a-fA-F]{4}$/.test(h)) fail("bad \\u escape"); out += String.fromCharCode(parseInt(h, 16)); i += 4; break; }
        default: fail("bad escape");
      }
    }
    if (!wellFormed(out)) throw new CanonError("BAD_STRING", "escape sequence produced an unpaired surrogate");
    return out;
  };
  const v = value(0); ws();
  if (i !== text.length) fail("trailing characters");
  return v;
}

// ------------------------------------------------------------------------------------------------ content root (§29.2)

export type EntryKind = "file" | "symlink" | "submodule";
export interface ManifestEntry {
  path: string;
  kind: EntryKind;
  /** Git-style mode: 100644, 100755, 120000 or 160000. */
  mode: string;
  /** Raw SHA-256 of the file bytes (file). */
  hash?: string;
  /** Link target (symlink). */
  target?: string;
  /** Pinned commit (submodule). */
  commit?: string;
}

/** Declared repository path policy. Collisions are checked under ASCII case folding unless the repository is declared case-sensitive.
 *  Known gap: non-ASCII case and Unicode-normalisation collisions (e.g. composed vs decomposed names) are not detected, because
 *  Node and Rust would have to agree on full Unicode folding; those paths stay distinct, as §29.1 step 4 requires. */
export interface PathPolicy { caseSensitive: boolean }
export const PORTABLE_POLICY: PathPolicy = { caseSensitive: false };

export function checkPath(p: string): void {
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\") || p.includes("\0") || /[\u0000-\u001f]/.test(p) || !wellFormed(p)) throw new CanonError("BAD_PATH", `unsafe path ${JSON.stringify(p)}`);
  for (const seg of p.split("/")) if (seg === "" || seg === "." || seg === "..") throw new CanonError("BAD_PATH", `unsafe path segment in ${JSON.stringify(p)}`);
}

const MODES: Record<EntryKind, string[]> = { file: ["100644", "100755"], symlink: ["120000"], submodule: ["160000"] };
const HEX64 = /^[0-9a-f]{64}$/;

/** Canonical identity of a candidate/base tree. Paths are never normalised; ambiguous or colliding names are rejected. */
export function contentRoot(entries: readonly ManifestEntry[], policy: PathPolicy = PORTABLE_POLICY): string {
  const sorted = [...entries].sort((a, b) => compareBytes(a.path, b.path));
  const seen = new Set<string>();
  const rows: Canon[] = sorted.map((e): Canon => {
    checkPath(e.path);
    const key = policy.caseSensitive ? e.path : e.path.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (seen.has(key)) throw new CanonError("BAD_PATH", `colliding path ${JSON.stringify(e.path)}`);
    seen.add(key);
    if (!MODES[e.kind]?.includes(e.mode)) throw new CanonError("BAD_SCHEMA", `mode ${e.mode} is not valid for a ${e.kind}`);
    if (e.kind === "file") { if (!e.hash || !HEX64.test(e.hash)) throw new CanonError("BAD_SCHEMA", `file ${e.path} needs a raw sha-256`); return { hash: e.hash, kind: "file", mode: e.mode, path: e.path }; }
    if (e.kind === "symlink") { if (typeof e.target !== "string") throw new CanonError("BAD_SCHEMA", `symlink ${e.path} needs a target`); return { kind: "symlink", mode: e.mode, path: e.path, target: e.target }; }
    if (!e.commit || !/^[0-9a-f]{40,64}$/.test(e.commit)) throw new CanonError("BAD_SCHEMA", `submodule ${e.path} needs a pinned commit`);
    return { commit: e.commit, kind: "submodule", mode: e.mode, path: e.path };
  });
  return `${PROTOCOL}/pf.contentRoot@1:${canonDigest("pf.contentRoot", "1", canonicalize(rows))}`;
}

/** Exclusions (build caches) are declared, and may never cover source or configuration that validation depends on. */
const NEVER_EXCLUDE = new Set(["src", "lib", "app", "apps", "packages", "crates", "test", "tests", "spec", "package.json", "tsconfig.json", "Cargo.toml", "Cargo.lock", "package-lock.json", "go.mod"]);
export function assertSafeExclusions(exclude: readonly string[]): void {
  for (const x of exclude) if (NEVER_EXCLUDE.has(x)) throw new CanonError("BAD_EXCLUSION", `${x} holds validation-relevant source or configuration and cannot be excluded`);
}

/** Walk a directory into manifest entries. Symlinks are recorded, never followed. `known` lets a caller reuse a hash it already has. */
export function entriesFromDirectory(root: string, opts: { exclude?: readonly string[]; known?: (rel: string, size: number, mtimeMs: number) => string | undefined } = {}): ManifestEntry[] {
  const exclude = new Set(opts.exclude ?? [".git"]); assertSafeExclusions([...exclude]);
  const out: ManifestEntry[] = [];
  const walk = (dir: string, rel: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (exclude.has(d.name)) continue;
      const abs = join(dir, d.name), r = rel ? `${rel}/${d.name}` : d.name, st = lstatSync(abs);
      if (st.isSymbolicLink()) out.push({ path: r, kind: "symlink", mode: "120000", target: readlinkSync(abs) });
      else if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) out.push({ path: r, kind: "file", mode: st.mode & 0o111 ? "100755" : "100644", hash: opts.known?.(r, st.size, st.mtimeMs) ?? rawHash(readFileSync(abs)) });
      else throw new CanonError("BAD_PATH", `special file ${r} cannot be part of a content root`);
    }
  };
  walk(root, ""); return out;
}
