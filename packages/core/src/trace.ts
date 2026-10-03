// Stack-trace ingestion for the "seeded exception" workflow. A pasted trace is user-supplied observation
// (class RUNTIME, labelled as pasted); frames are mapped onto code entities by file and line.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Entity, EvidenceRef } from "@cie/schema";
import type { RevisionRow, Store } from "./store.ts";

export interface Frame { fn?: string; file: string; line: number; col: number; raw: string }
export interface ParsedTrace { errorClass: string | null; message: string; frames: Frame[] }

// Error heading: "TypeError: x", "Uncaught (in promise) FooError: x", "Error [ERR_X]: x".
const HEAD = /^\s*(?:Uncaught\s+(?:\(in promise\)\s+)?)?(?:\w+:\s+)?((?:[A-Za-z_$][\w$]*)?(?:Error|Exception|Rejection))(?:\s*\[[^\]]*\])?\s*:?\s*(.*)$/;
// V8 / Node / Chrome:  "at fn (file:1:2)", "at async fn (file:1:2)", "at new Foo (file:1:2)", "at file:1:2".
const V8 = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
// Firefox / Safari:  "fn@file:1:2" or "@file:1:2".
const GECKO = /^\s*([^@\s][^@]*)?@(.+?):(\d+):(\d+)\s*$/;

/** Reduce the many ways a runtime names a source file to a bare path: schemes, hosts, query strings, bundler prefixes. */
export function normalizeFramePath(raw: string): string {
  let f = raw.trim();
  f = f.replace(/^webpack-internal:\/\/\/(?:\([^)]*\)\/)?/, "").replace(/^webpack:\/\/[^/]*\//, "");
  if (/^file:\/\//.test(f)) f = f.replace(/^file:\/\//, "").replace(/^\/([A-Za-z]:)/, "$1"); // file:///abs → /abs, file:///C:/x → C:/x
  f = f.replace(/^https?:\/\/[^/]+/, "").replace(/^\/@fs\//, "/");
  f = f.replace(/[?#].*$/, "");
  f = f.replace(/\\/g, "/").replace(/^\.\//, "");
  try { f = decodeURIComponent(f); } catch { /* keep as is */ }
  return f;
}

export function parseTrace(text: string): ParsedTrace {
  const lines = text.split(/\r?\n/);
  let errorClass: string | null = null, message = "";
  const frames: Frame[] = [];
  for (const line of lines) {
    const v = V8.exec(line);
    if (v) { frames.push({ fn: cleanFn(v[1]), file: normalizeFramePath(v[2]), line: +v[3], col: +v[4], raw: line.trim() }); continue; }
    const g = GECKO.exec(line);
    if (g && !/^\s*at\s/.test(line)) { frames.push({ fn: cleanFn(g[1]), file: normalizeFramePath(g[2]), line: +g[3], col: +g[4], raw: line.trim() }); continue; }
    if (!errorClass) { const h = HEAD.exec(line); if (h) { errorClass = h[1]; message = h[2].trim(); } }
  }
  return { errorClass, message, frames };
}

/** "async Foo.bar [as baz]" → "Foo.bar";  "new Foo" → "Foo";  "Object.<anonymous>" → undefined. */
function cleanFn(raw?: string): string | undefined {
  if (!raw) return undefined;
  let f = raw.trim().replace(/^async\s+/, "").replace(/^new\s+/, "").replace(/\s+\[as [^\]]+\]$/, "").replace(/\/<$/, "");
  if (!f || f.includes("<anonymous>") || f === "anonymous") return undefined;
  return f;
}

export function looksLikeTrace(text: string): boolean {
  return parseTrace(text).frames.length >= 1 && /\n/.test(text.trim());
}

export interface MappedFrame { frame: Frame; entityId?: string; file?: string; evidence: EvidenceRef }
export interface MappedTrace { parsed: ParsedTrace; frames: MappedFrame[]; unmatched: Frame[]; headEvidence: EvidenceRef | null }

const ev = (rev: string, key: string, file: string, locator: string): EvidenceRef => ({
  id: "ev:" + createHash("sha256").update(rev + key).digest("hex").slice(0, 16), sourceId: file,
  location: { kind: "RuntimeLocation", backendHandle: "pasted-trace", deploymentId: "seeded-exception", start: "", end: "", locator },
  class: "RUNTIME", observedAt: new Date().toISOString(), accessScopeId: "local", state: "CURRENT",
});

export function byteOffset(buf: Buffer, line: number, col: number): number {
  let off = 0, l = 1;
  while (l < line) { const nl = buf.indexOf(10, off); if (nl < 0) return buf.length; off = nl + 1; l++; }
  return Math.min(buf.length, off + Math.max(0, col - 1));
}

/** The innermost symbol of `rel` containing a 1-based line/column, or undefined (module level / unreadable). */
export function entityAt(store: Store, rev: RevisionRow, rel: string, line: number, col = 1): string | undefined {
  const path = resolve(rev.repoRoot, rel);
  if (relative(rev.repoRoot, path).startsWith("..")) return undefined;
  let buf: Buffer;
  try { buf = readFileSync(path); } catch { return undefined; }
  const off = byteOffset(buf, line, col);
  return store.entities(rev.id)
    .filter((e) => e.file === rel && e.kind !== "file" && e.kind !== "test" && e.spans[0] && e.spans[0].startByte <= off && off < e.spans[0].endByteExclusive)
    .sort((a, b) => (a.spans[0].endByteExclusive - a.spans[0].startByte) - (b.spans[0].endByteExclusive - b.spans[0].startByte))[0]?.entityId;
}

/** Pure: which entity each frame lands on (or null). No evidence is written; used for scoring and the inbox. */
export function locateFrames(store: Store, rev: RevisionRow, parsed: ParsedTrace, preloaded?: Entity[]): { frame: Frame; entityId: string | null; file: string | null }[] {
  const entities = preloaded ?? store.entities(rev.id);
  const files = entities.filter((e) => e.kind === "file").map((e) => e.file).sort((a, b) => b.length - a.length);
  const symbols = new Map<string, Entity[]>();
  for (const e of entities) if (e.kind !== "file" && e.kind !== "test") symbols.set(e.file, [...(symbols.get(e.file) ?? []), e]);
  const bufs = new Map<string, Buffer | null>();
  const read = (rel: string) => {
    if (!bufs.has(rel)) {
      const path = resolve(rev.repoRoot, rel);
      let b: Buffer | null = null;
      if (!relative(rev.repoRoot, path).startsWith("..")) { try { b = readFileSync(path); } catch { b = null; } }
      bufs.set(rel, b);
    }
    return bufs.get(rel)!;
  };
  return parsed.frames.map((frame) => {
    const rel = files.find((r) => frame.file === r || frame.file.endsWith("/" + r));
    if (!rel) return { frame, entityId: null, file: null };
    let entityId: string | null = null;
    const buf = read(rel);
    if (buf) {
      const off = byteOffset(buf, frame.line, frame.col);
      entityId = (symbols.get(rel) ?? []).filter((e) => e.spans[0] && e.spans[0].startByte <= off && off < e.spans[0].endByteExclusive)
        .sort((a, b) => (a.spans[0].endByteExclusive - a.spans[0].startByte) - (b.spans[0].endByteExclusive - b.spans[0].startByte))[0]?.entityId ?? null;
    }
    if (!entityId && frame.fn) {
      const simple = frame.fn.split(".").pop()!;
      const hit = (symbols.get(rel) ?? []).filter((x) => x.name === frame.fn || x.name.split(".").pop() === simple);
      if (hit.length === 1) entityId = hit[0].entityId;
    }
    return { frame, entityId, file: rel };
  });
}

export function fingerprint(parsed: ParsedTrace): string {
  const top = parsed.frames.slice(0, 3).map((f) => `${f.fn ?? "?"}@${f.file.split("/").slice(-2).join("/")}:${f.line}`).join("|");
  return createHash("sha256").update(`${parsed.errorClass ?? "?"}|${top}`).digest("hex").slice(0, 20);
}

export function mapTrace(store: Store, rev: RevisionRow, text: string): MappedTrace {
  const parsed = parseTrace(text);
  const entities = store.entities(rev.id);
  const files = new Map(entities.filter((e) => e.kind === "file").map((e) => [e.file, e]));
  const symbolsByFile = new Map<string, Entity[]>();
  for (const e of entities) if (e.kind !== "file" && e.kind !== "test") symbolsByFile.set(e.file, [...(symbolsByFile.get(e.file) ?? []), e]);
  const rels = [...files.keys()].sort((a, b) => b.length - a.length);
  const key = createHash("sha256").update(text).digest("hex").slice(0, 8);
  const frames: MappedFrame[] = [], unmatched: Frame[] = [];

  parsed.frames.forEach((fr, i) => {
    const norm = fr.file;
    const rel = rels.find((r) => norm === r || norm.endsWith("/" + r));
    if (!rel) { unmatched.push(fr); return; }
    let entityId: string | undefined;
    try {
      const path = resolve(rev.repoRoot, rel);
      if (!relative(rev.repoRoot, path).startsWith("..")) {
        const buf = readFileSync(path);
        const off = byteOffset(buf, fr.line, fr.col);
        const inner = (symbolsByFile.get(rel) ?? [])
          .filter((s) => s.spans[0] && s.spans[0].startByte <= off && off < s.spans[0].endByteExclusive)
          .sort((a, b) => (a.spans[0].endByteExclusive - a.spans[0].startByte) - (b.spans[0].endByteExclusive - b.spans[0].startByte))[0];
        entityId = inner?.entityId;
      }
    } catch { /* unreadable file: keep the file-level match */ }
    // Line mapping can miss (transpiled output, drifted lines). Fall back to the function name within the matched file.
    if (!entityId && fr.fn) {
      const simple = fr.fn.split(".").pop()!;
      const inFile = (symbolsByFile.get(rel) ?? []).filter((x) => x.name === fr.fn || x.name.split(".").pop() === simple);
      if (inFile.length === 1) entityId = inFile[0].entityId;
    }
    const e = ev(rev.id, `${key}:frame:${i}`, rel, fr.raw);
    store.putEvidence(rev.id, e);
    frames.push({ frame: fr, entityId, file: rel, evidence: e });
  });
  let headEvidence: EvidenceRef | null = null;
  if (parsed.errorClass) {
    headEvidence = ev(rev.id, `${key}:head`, frames[0]?.file ?? "", `${parsed.errorClass}: ${parsed.message}`);
    store.putEvidence(rev.id, headEvidence);
  }
  return { parsed, frames, unmatched, headEvidence };
}
